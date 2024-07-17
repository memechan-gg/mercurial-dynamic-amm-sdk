import { BN } from '@coral-xyz/anchor';
import {
  PublicKey,
  Connection,
  Cluster,
  Transaction,
  TransactionInstruction,
  AccountInfo,
  ParsedAccountData,
  SYSVAR_CLOCK_PUBKEY,
  SYSVAR_RENT_PUBKEY,
  SystemProgram,
  ComputeBudgetProgram,
} from '@solana/web3.js';
import { TokenInfo } from '@solana/spl-token-registry';
import {
  AccountLayout,
  ASSOCIATED_TOKEN_PROGRAM_ID,
  MintLayout,
  NATIVE_MINT,
  TOKEN_PROGRAM_ID,
} from '@solana/spl-token';
import VaultImpl, { calculateWithdrawableAmount, getVaultPdas } from '@mercurial-finance/vault-sdk';
import invariant from 'invariant';
import {
  AccountType,
  AccountsInfo,
  AmmImplementation,
  AmmProgram,
  DepositQuote,
  LockEscrow,
  LockEscrowAccount,
  PoolInformation,
  PoolState,
  VaultProgram,
  WithdrawQuote,
} from './types';
import { ERROR, SEEDS, UNLOCK_AMOUNT_BUFFER, FEE_OWNER, METAPLEX_PROGRAM } from './constants';
import { SwapCurve, TradeDirection } from './curve';
import { ConstantProductSwap } from './curve/constant-product';
import {
  calculateMaxSwapOutAmount,
  calculateSwapQuote,
  computeActualDepositAmount,
  calculatePoolInfo,
  getMaxAmountWithSlippage,
  getMinAmountWithSlippage,
  getOrCreateATAInstruction,
  unwrapSOLInstruction,
  wrapSOLInstruction,
  getDepegAccounts,
  createProgram,
  getAssociatedTokenAccount,
  deserializeAccount,
  chunkedGetMultipleAccountInfos,
  generateCurveType,
  derivePoolAddress,
  chunkedFetchMultiplePoolAccount,
  deriveMintMetadata,
  deriveLockEscrowPda,
  calculateUnclaimedLockEscrowFee,
} from './utils';
import { bs58 } from '@coral-xyz/anchor/dist/cjs/utils/bytes';

export {
  SEEDS,
  FEE_OWNER,
  METAPLEX_PROGRAM,
  calculateUnclaimedLockEscrowFee,
  createProgram,
  deriveLockEscrowPda,
  deriveMintMetadata,
  getAssociatedTokenAccount,
};
export { LockEscrowAccount };

type Opt = {
  cluster: Cluster;
};

const getPoolState = async (poolMint: PublicKey, program: AmmProgram) => {
  const poolState = (await program.account.pool.fetchNullable(poolMint)) as any as PoolState;
  invariant(poolState, `Pool ${poolMint.toBase58()} not found`);

  const account = await program.provider.connection.getTokenSupply(poolState.lpMint);
  invariant(account.value.amount, ERROR.INVALID_ACCOUNT);

  return { ...poolState, lpSupply: new BN(account.value.amount) };
};

type DecoderType = { [x: string]: (accountData: Buffer) => BN };
const decodeAccountTypeMapper = (type: AccountType): ((accountData: Buffer) => BN) => {
  const decoder: DecoderType = {
    [AccountType.VAULT_A_RESERVE]: (accountData) => new BN(AccountLayout.decode(accountData).amount.toString()),
    [AccountType.VAULT_B_RESERVE]: (accountData) => new BN(AccountLayout.decode(accountData).amount.toString()),
    [AccountType.VAULT_A_LP]: (accountData) => new BN(MintLayout.decode(accountData).supply.toString()),
    [AccountType.VAULT_B_LP]: (accountData) => new BN(MintLayout.decode(accountData).supply.toString()),
    [AccountType.POOL_VAULT_A_LP]: (accountData) => new BN(AccountLayout.decode(accountData).amount.toString()),
    [AccountType.POOL_VAULT_B_LP]: (accountData) => new BN(AccountLayout.decode(accountData).amount.toString()),
    [AccountType.POOL_LP_MINT]: (accountData) => new BN(MintLayout.decode(accountData).supply.toString()),
    [AccountType.SYSVAR_CLOCK]: (accountData) => new BN(accountData.readBigInt64LE(32).toString()),
  };

  return decoder[type as unknown as string];
};

type AccountTypeInfo = { type: AccountType; account: AccountInfo<Buffer> };
type AccountsType = { type: AccountType; pubkey: PublicKey };
const getAccountsBuffer = async (
  connection: Connection,
  accountsToFetch: Array<AccountsType>,
): Promise<Map<string, AccountTypeInfo>> => {
  const accounts = await chunkedGetMultipleAccountInfos(
    connection,
    accountsToFetch.map((account) => account.pubkey),
  );

  return accountsToFetch.reduce((accMap, account, index) => {
    const accountInfo = accounts[index];
    accMap.set(account.pubkey.toBase58(), {
      type: account.type,
      account: accountInfo!,
    });

    return accMap;
  }, new Map<string, AccountTypeInfo>());
};

const deserializeAccountsBuffer = (accountInfoMap: Map<string, AccountTypeInfo>): Map<string, BN> => {
  return Array.from(accountInfoMap).reduce((accValue, [publicKey, { type, account }]) => {
    const decodedAccountInfo = decodeAccountTypeMapper(type);

    accValue.set(publicKey, decodedAccountInfo(account!.data));

    return accValue;
  }, new Map());
};

export default class AmmImpl implements AmmImplementation {
  private opt: Opt = {
    cluster: 'mainnet-beta',
  };

  private constructor(
    public address: PublicKey,
    private program: AmmProgram,
    private vaultProgram: VaultProgram,
    private tokenInfos: Array<TokenInfo>,
    public poolState: PoolState & { lpSupply: BN },
    public poolInfo: PoolInformation,
    public vaultA: VaultImpl,
    public vaultB: VaultImpl,
    private accountsInfo: AccountsInfo,
    private swapCurve: SwapCurve,
    private depegAccounts: Map<String, AccountInfo<Buffer>>,
    opt: Opt,
  ) {
    this.opt = {
      ...this.opt,
      ...opt,
    };
  }

  public static async createPermissionlessPool(
    connection: Connection,
    payer: PublicKey,
    tokenInfoA: TokenInfo,
    tokenInfoB: TokenInfo,
    tokenAAmount: BN,
    tokenBAmount: BN,
    isStable: boolean,
    tradeFeeBps: BN,
    opt?: {
      programId?: string;
      skipAta?: boolean;
    },
  ): Promise<Transaction> {
    const { vaultProgram, ammProgram } = createProgram(connection, opt?.programId);

    const tokenAMint = new PublicKey(tokenInfoA.address);
    const tokenBMint = new PublicKey(tokenInfoB.address);
    const [
      { vaultPda: aVault, tokenVaultPda: aTokenVault, lpMintPda: aLpMintPda },
      { vaultPda: bVault, tokenVaultPda: bTokenVault, lpMintPda: bLpMintPda },
    ] = [getVaultPdas(tokenAMint, vaultProgram.programId), getVaultPdas(tokenBMint, vaultProgram.programId)];
    const [aVaultAccount, bVaultAccount] = await Promise.all([
      vaultProgram.account.vault.fetchNullable(aVault),
      vaultProgram.account.vault.fetchNullable(bVault),
    ]);

    let aVaultLpMint = aLpMintPda;
    let bVaultLpMint = bLpMintPda;
    let preInstructions: Array<TransactionInstruction> = [];
    const setComputeUnitLimitIx = ComputeBudgetProgram.setComputeUnitLimit({
      units: 1_400_000,
    });
    preInstructions.push(setComputeUnitLimitIx);

    if (!aVaultAccount) {
      const createVaultAIx = await VaultImpl.createPermissionlessVaultInstruction(connection, payer, tokenInfoA);
      createVaultAIx && preInstructions.push(createVaultAIx);
    } else {
      aVaultLpMint = aVaultAccount.lpMint; // Old vault doesn't have lp mint pda
    }
    if (!bVaultAccount) {
      const createVaultBIx = await VaultImpl.createPermissionlessVaultInstruction(connection, payer, tokenInfoB);
      createVaultBIx && preInstructions.push(createVaultBIx);
    } else {
      bVaultLpMint = bVaultAccount.lpMint; // Old vault doesn't have lp mint pda
    }

    const poolPubkey = derivePoolAddress(connection, tokenInfoA, tokenInfoB, isStable, tradeFeeBps, {
      programId: opt?.programId,
    });

    const [[aVaultLp], [bVaultLp]] = [
      PublicKey.findProgramAddressSync([aVault.toBuffer(), poolPubkey.toBuffer()], ammProgram.programId),
      PublicKey.findProgramAddressSync([bVault.toBuffer(), poolPubkey.toBuffer()], ammProgram.programId),
    ];

    const [[payerTokenA, createPayerTokenAIx], [payerTokenB, createPayerTokenBIx]] = await Promise.all([
      getOrCreateATAInstruction(tokenAMint, payer, connection),
      getOrCreateATAInstruction(tokenBMint, payer, connection),
    ]);

    if (!opt?.skipAta) {
      createPayerTokenAIx && preInstructions.push(createPayerTokenAIx);
    }
    createPayerTokenBIx && preInstructions.push(createPayerTokenBIx);

    const [[adminTokenAFee], [adminTokenBFee]] = [
      PublicKey.findProgramAddressSync(
        [Buffer.from(SEEDS.FEE), tokenAMint.toBuffer(), poolPubkey.toBuffer()],
        ammProgram.programId,
      ),
      PublicKey.findProgramAddressSync(
        [Buffer.from(SEEDS.FEE), tokenBMint.toBuffer(), poolPubkey.toBuffer()],
        ammProgram.programId,
      ),
    ];

    const [lpMint] = PublicKey.findProgramAddressSync(
      [Buffer.from(SEEDS.LP_MINT), poolPubkey.toBuffer()],
      ammProgram.programId,
    );

    const payerPoolLp = await getAssociatedTokenAccount(lpMint, payer);

    if (tokenInfoA.address === NATIVE_MINT.toBase58()) {
      preInstructions = preInstructions.concat(wrapSOLInstruction(payer, payerTokenA, BigInt(tokenAAmount.toString())));
    }

    if (tokenInfoB.address === NATIVE_MINT.toBase58()) {
      preInstructions = preInstructions.concat(wrapSOLInstruction(payer, payerTokenB, BigInt(tokenBAmount.toString())));
    }

    const [mintMetadata, _mintMetadataBump] = deriveMintMetadata(lpMint);

    const createPermissionlessPoolTx = await ammProgram.methods
      .initializePermissionlessPoolWithFeeTier({ constantProduct: {} }, tradeFeeBps, tokenAAmount, tokenBAmount)
      .accounts({
        pool: poolPubkey,
        tokenAMint,
        tokenBMint,
        aVault,
        bVault,
        aVaultLpMint,
        bVaultLpMint,
        aVaultLp,
        bVaultLp,
        lpMint,
        payerTokenA,
        payerTokenB,
        adminTokenAFee,
        adminTokenBFee,
        payerPoolLp,
        aTokenVault,
        bTokenVault,
        mintMetadata,
        metadataProgram: METAPLEX_PROGRAM,
        feeOwner: FEE_OWNER,
        payer,
        rent: SYSVAR_RENT_PUBKEY,
        vaultProgram: vaultProgram.programId,
        tokenProgram: TOKEN_PROGRAM_ID,
        systemProgram: SystemProgram.programId,
        associatedTokenProgram: ASSOCIATED_TOKEN_PROGRAM_ID,
      })
      .preInstructions(preInstructions)
      .transaction();

    return new Transaction({
      feePayer: payer,
      ...(await ammProgram.provider.connection.getLatestBlockhash(ammProgram.provider.connection.commitment)),
    }).add(createPermissionlessPoolTx);
  }

  public static async getLockedLpAmountByUser(
    connection: Connection,
    userPubKey: PublicKey,
    opt?: {
      programId?: string;
      cluster?: Cluster;
    },
  ) {
    const { ammProgram } = createProgram(connection, opt?.programId);

    const lockEscrows = await ammProgram.account.lockEscrow.all([
      {
        memcmp: {
          bytes: bs58.encode(userPubKey.toBuffer()),
          offset: 8 + 32,
        },
      },
    ]);

    return lockEscrows.reduce((accMap, { account }) => {
      return accMap.set(account.pool.toBase58(), account);
    }, new Map<string, LockEscrowAccount>());
  }

  public static async fetchMultipleUserBalance(
    connection: Connection,
    lpMintList: Array<PublicKey>,
    owner: PublicKey,
  ): Promise<Array<BN>> {
    const ataAccounts = await Promise.all(lpMintList.map((lpMint) => getAssociatedTokenAccount(lpMint, owner)));

    const accountsInfo = await chunkedGetMultipleAccountInfos(connection, ataAccounts);

    return accountsInfo.map((accountInfo) => {
      if (!accountInfo) return new BN(0);

      const accountBalance = deserializeAccount(accountInfo);
      if (!accountBalance) throw new Error('Failed to parse user account for LP token.');

      return new BN(accountBalance.amount.toString());
    });
  }

  public static async create(
    connection: Connection,
    pool: PublicKey,
    tokenInfoA: TokenInfo,
    tokenInfoB: TokenInfo,
    opt?: {
      programId?: string;
      vaultSeedBaseKey?: PublicKey;
      cluster?: Cluster;
    },
  ): Promise<AmmImpl> {
    const cluster = opt?.cluster ?? 'mainnet-beta';
    const { provider, vaultProgram, ammProgram } = createProgram(connection, opt?.programId);

    const poolState = await getPoolState(pool, ammProgram);

    invariant(tokenInfoA.address === poolState.tokenAMint.toBase58(), `TokenInfoA provided is incorrect`);
    invariant(tokenInfoB.address === poolState.tokenBMint.toBase58(), `TokenInfoB provided is incorrect`);
    invariant(tokenInfoA, `TokenInfo ${poolState.tokenAMint.toBase58()} A not found`);
    invariant(tokenInfoB, `TokenInfo ${poolState.tokenBMint.toBase58()} A not found`);

    const [vaultA, vaultB] = await Promise.all([
      VaultImpl.create(provider.connection, tokenInfoA, { cluster, seedBaseKey: opt?.vaultSeedBaseKey }),
      VaultImpl.create(provider.connection, tokenInfoB, { cluster, seedBaseKey: opt?.vaultSeedBaseKey }),
    ]);

    const accountsBufferMap = await getAccountsBuffer(connection, [
      { pubkey: vaultA.vaultState.tokenVault, type: AccountType.VAULT_A_RESERVE },
      { pubkey: vaultB.vaultState.tokenVault, type: AccountType.VAULT_B_RESERVE },
      { pubkey: vaultA.vaultState.lpMint, type: AccountType.VAULT_A_LP },
      { pubkey: vaultB.vaultState.lpMint, type: AccountType.VAULT_B_LP },
      { pubkey: poolState.aVaultLp, type: AccountType.POOL_VAULT_A_LP },
      { pubkey: poolState.bVaultLp, type: AccountType.POOL_VAULT_B_LP },
      { pubkey: poolState.lpMint, type: AccountType.POOL_LP_MINT },
      { pubkey: SYSVAR_CLOCK_PUBKEY, type: AccountType.SYSVAR_CLOCK },
    ]);
    const accountsInfoMap = deserializeAccountsBuffer(accountsBufferMap);

    const currentTime = accountsInfoMap.get(SYSVAR_CLOCK_PUBKEY.toBase58()) as BN;
    const poolVaultALp = accountsInfoMap.get(poolState.aVaultLp.toBase58()) as BN;
    const poolVaultBLp = accountsInfoMap.get(poolState.bVaultLp.toBase58()) as BN;
    const vaultALpSupply = accountsInfoMap.get(vaultA.vaultState.lpMint.toBase58()) as BN;
    const vaultBLpSupply = accountsInfoMap.get(vaultB.vaultState.lpMint.toBase58()) as BN;
    const vaultAReserve = accountsInfoMap.get(vaultA.vaultState.tokenVault.toBase58()) as BN;
    const vaultBReserve = accountsInfoMap.get(vaultB.vaultState.tokenVault.toBase58()) as BN;
    const poolLpSupply = accountsInfoMap.get(poolState.lpMint.toBase58()) as BN;

    invariant(
      !!currentTime &&
        !!vaultALpSupply &&
        !!vaultBLpSupply &&
        !!vaultAReserve &&
        !!vaultBReserve &&
        !!poolVaultALp &&
        !!poolVaultBLp &&
        !!poolLpSupply,
      'Account Info not found',
    );

    const accountsInfo = {
      currentTime,
      poolVaultALp,
      poolVaultBLp,
      vaultALpSupply,
      vaultBLpSupply,
      vaultAReserve,
      vaultBReserve,
      poolLpSupply,
    };

    const depegAccounts = await getDepegAccounts(ammProgram.provider.connection, [poolState]);

    let swapCurve = new ConstantProductSwap();

    const poolInfo = calculatePoolInfo(
      currentTime,
      poolVaultALp,
      poolVaultBLp,
      vaultALpSupply,
      vaultBLpSupply,
      poolLpSupply,
      swapCurve,
      vaultA.vaultState,
      vaultB.vaultState,
    );

    return new AmmImpl(
      pool,
      ammProgram,
      vaultProgram,
      [tokenInfoA, tokenInfoB],
      poolState,
      poolInfo,
      vaultA,
      vaultB,
      accountsInfo,
      swapCurve,
      depegAccounts,
      {
        cluster,
      },
    );
  }

  get tokenA(): TokenInfo {
    return this.tokenInfos[0];
  }

  get tokenB(): TokenInfo {
    return this.tokenInfos[1];
  }

  get decimals(): number {
    return Math.max(this.tokenA.decimals, this.tokenB.decimals);
  }

  get isStablePool(): boolean {
    return 'stable' in this.poolState.curveType;
  }

  get isLST(): boolean {
    if (!this.isStablePool || !this.swapCurve.depeg?.depegType) return false;

    return !Object.keys(this.swapCurve.depeg.depegType).includes('none');
  }

  get feeBps(): BN {
    return this.poolState.fees.tradeFeeNumerator.mul(new BN(10000)).div(this.poolState.fees.tradeFeeDenominator);
  }

  get depegToken(): TokenInfo | null {
    if (!this.isStablePool) return null;
    const { tokenMultiplier } = this.poolState.curveType['stable'] as any;
    const tokenABalance = this.poolInfo.tokenAAmount.mul(tokenMultiplier.tokenAMultiplier);
    const tokenBBalance = this.poolInfo.tokenBAmount.mul(tokenMultiplier.tokenBMultiplier);
    const totalTokenBalance = tokenABalance.add(tokenBBalance);

    if (totalTokenBalance.isZero()) return null;

    const isTokenADepeg = this.poolInfo.tokenAAmount
      .mul(new BN(2))
      .div(totalTokenBalance)
      .mul(new BN(100))
      .gt(new BN(95));
    const isTokenBDepeg = this.poolInfo.tokenBAmount
      .mul(new BN(2))
      .div(totalTokenBalance)
      .mul(new BN(100))
      .gt(new BN(95));

    if (isTokenADepeg) return this.tokenA;
    if (isTokenBDepeg) return this.tokenB;
    return null;
  }

  private async getLockedAtaAmount(): Promise<BN> {
    try {
      const poolLpAta = await getAssociatedTokenAccount(this.poolState.lpMint, this.address);
      const info = await this.program.provider.connection.getTokenAccountBalance(poolLpAta);
      return new BN(info.value.amount);
    } catch (e) {
      return new BN(0);
    }
  }

  public async getLockedLpAmount(): Promise<BN> {
    return (await this.getLockedAtaAmount()).add(this.poolState.totalLockedLp);
  }

  /**
   * It updates the state of the pool
   */
  public async updateState() {
    const [poolState] = await Promise.all([
      getPoolState(this.address, this.program),
      this.vaultA.refreshVaultState(),
      this.vaultB.refreshVaultState(),
    ]);
    this.poolState = poolState;

    const accountsBufferMap = await getAccountsBuffer(this.program.provider.connection, [
      { pubkey: this.vaultA.vaultState.tokenVault, type: AccountType.VAULT_A_RESERVE },
      { pubkey: this.vaultB.vaultState.tokenVault, type: AccountType.VAULT_B_RESERVE },
      { pubkey: this.vaultA.vaultState.lpMint, type: AccountType.VAULT_A_LP },
      { pubkey: this.vaultB.vaultState.lpMint, type: AccountType.VAULT_B_LP },
      { pubkey: poolState.aVaultLp, type: AccountType.POOL_VAULT_A_LP },
      { pubkey: poolState.bVaultLp, type: AccountType.POOL_VAULT_B_LP },
      { pubkey: poolState.lpMint, type: AccountType.POOL_LP_MINT },
      { pubkey: SYSVAR_CLOCK_PUBKEY, type: AccountType.SYSVAR_CLOCK },
    ]);
    const accountsInfoMap = deserializeAccountsBuffer(accountsBufferMap);

    const currentTime = accountsInfoMap.get(SYSVAR_CLOCK_PUBKEY.toBase58()) as BN;
    const poolVaultALp = accountsInfoMap.get(poolState.aVaultLp.toBase58()) as BN;
    const poolVaultBLp = accountsInfoMap.get(poolState.bVaultLp.toBase58()) as BN;
    const vaultALpSupply = accountsInfoMap.get(this.vaultA.vaultState.lpMint.toBase58()) as BN;
    const vaultBLpSupply = accountsInfoMap.get(this.vaultB.vaultState.lpMint.toBase58()) as BN;
    const vaultAReserve = accountsInfoMap.get(this.vaultA.vaultState.tokenVault.toBase58()) as BN;
    const vaultBReserve = accountsInfoMap.get(this.vaultB.vaultState.tokenVault.toBase58()) as BN;
    const poolLpSupply = accountsInfoMap.get(poolState.lpMint.toBase58()) as BN;

    invariant(
      !!currentTime &&
        !!vaultALpSupply &&
        !!vaultBLpSupply &&
        !!vaultAReserve &&
        !!vaultBReserve &&
        !!poolVaultALp &&
        !!poolVaultBLp &&
        !!poolLpSupply,
      'Account Info not found',
    );

    this.accountsInfo = {
      currentTime,
      poolVaultALp,
      poolVaultBLp,
      vaultALpSupply,
      vaultBLpSupply,
      vaultAReserve,
      vaultBReserve,
      poolLpSupply,
    };

    this.depegAccounts = await getDepegAccounts(this.program.provider.connection, [poolState]);

    this.swapCurve = new ConstantProductSwap();

    this.poolInfo = calculatePoolInfo(
      currentTime,
      poolVaultALp,
      poolVaultBLp,
      vaultALpSupply,
      vaultBLpSupply,
      poolLpSupply,
      this.swapCurve,
      this.vaultA.vaultState,
      this.vaultB.vaultState,
    );
  }

  /**
   * It returns the pool token mint.
   * @returns The poolState.lpMint
   */
  public getPoolTokenMint() {
    return this.poolState.lpMint;
  }

  /**
   * It gets the total supply of the LP token
   * @returns The total supply of the LP token.
   */
  public async getLpSupply() {
    const account = await this.program.provider.connection.getTokenSupply(this.poolState.lpMint);
    invariant(account.value.amount, ERROR.INVALID_ACCOUNT);

    return new BN(account.value.amount);
  }

  /**
   * Get the user's balance by looking up the account associated with the user's public key
   * @param {PublicKey} owner - PublicKey - The public key of the user you want to get the balance of
   * @returns The amount of tokens the user has.
   */
  public async getUserBalance(owner: PublicKey) {
    const account = await getAssociatedTokenAccount(this.poolState.lpMint, owner);
    if (!account) return new BN(0);

    const parsedAccountInfo = await this.program.provider.connection.getParsedAccountInfo(account);
    if (!parsedAccountInfo.value) return new BN(0);

    const accountInfoData = (parsedAccountInfo.value!.data as ParsedAccountData).parsed;

    return new BN(accountInfoData.info.tokenAmount.amount);
  }

  /**
   * `getSwapQuote` returns the amount of `outToken` that you will receive if you swap
   * `inAmountLamport` of `inToken` into the pool
   * @param {PublicKey} inTokenMint - The mint you want to swap from.
   * @param {BN} inAmountLamport - The amount of lamports you want to swap.
   * @param {number} [slippage] - The maximum amount of slippage you're willing to accept. (Max to 2 decimal place)
   * @returns The amount of the destination token that will be received after the swap.
   */
  public getSwapQuote(inTokenMint: PublicKey, inAmountLamport: BN, slippage: number) {
    const { amountOut, fee, priceImpact } = calculateSwapQuote(inTokenMint, inAmountLamport, {
      currentTime: this.accountsInfo.currentTime.toNumber(),
      poolState: this.poolState,
      depegAccounts: this.depegAccounts,
      poolVaultALp: this.accountsInfo.poolVaultALp,
      poolVaultBLp: this.accountsInfo.poolVaultBLp,
      vaultA: this.vaultA.vaultState,
      vaultB: this.vaultB.vaultState,
      vaultALpSupply: this.accountsInfo.vaultALpSupply,
      vaultBLpSupply: this.accountsInfo.vaultBLpSupply,
      vaultAReserve: this.accountsInfo.vaultAReserve,
      vaultBReserve: this.accountsInfo.vaultBReserve,
    });

    return {
      swapInAmount: inAmountLamport,
      swapOutAmount: amountOut,
      minSwapOutAmount: getMinAmountWithSlippage(amountOut, slippage),
      fee,
      priceImpact,
    };
  }

  /**
   * Get maximum in amount (source amount) for swap
   * !!! NOTE it is just estimation
   * @param tokenMint
   */
  public getMaxSwapInAmount(tokenMint: PublicKey) {
    // Get maximum in amount by swapping maximum withdrawable amount of tokenMint in the pool
    invariant(
      tokenMint.equals(this.poolState.tokenAMint) || tokenMint.equals(this.poolState.tokenBMint),
      ERROR.INVALID_MINT,
    );

    const [outTokenMint, swapSourceAmount, swapDestAmount, tradeDirection] = tokenMint.equals(this.poolState.tokenAMint)
      ? [this.poolState.tokenBMint, this.poolInfo.tokenAAmount, this.poolInfo.tokenBAmount, TradeDirection.AToB]
      : [this.poolState.tokenAMint, this.poolInfo.tokenBAmount, this.poolInfo.tokenAAmount, TradeDirection.BToA];
    let maxOutAmount = this.getMaxSwapOutAmount(outTokenMint);
    // Impossible to deplete the pool, therefore if maxOutAmount is equals to tokenAmount in pool, subtract it by 1
    if (maxOutAmount.eq(swapDestAmount)) {
      maxOutAmount = maxOutAmount.sub(new BN(1)); // Left 1 token in pool
    }
    let maxInAmount = this.swapCurve!.computeInAmount(maxOutAmount, swapSourceAmount, swapDestAmount, tradeDirection);
    const adminFee = this.calculateAdminTradingFee(maxInAmount);
    const tradeFee = this.calculateTradingFee(maxInAmount);
    maxInAmount = maxInAmount.sub(adminFee);
    maxInAmount = maxInAmount.sub(tradeFee);
    return maxInAmount;
  }

  /**
   * `getMaxSwapOutAmount` returns the maximum amount of tokens that can be swapped out of the pool
   * @param {PublicKey} tokenMint - The mint of the token you want to swap out.
   * @returns The maximum amount of tokens that can be swapped out of the pool.
   */
  public getMaxSwapOutAmount(tokenMint: PublicKey) {
    return calculateMaxSwapOutAmount(
      tokenMint,
      this.poolState.tokenAMint,
      this.poolState.tokenBMint,
      this.poolInfo.tokenAAmount,
      this.poolInfo.tokenBAmount,
      this.accountsInfo.vaultAReserve,
      this.accountsInfo.vaultBReserve,
    );
  }

  /**
   * `swap` is a function that takes in a `PublicKey` of the owner, a `PublicKey` of the input token
   * mint, an `BN` of the input amount of lamports, and an `BN` of the output amount of lamports. It
   * returns a `Promise<Transaction>` of the swap transaction
   * @param {PublicKey} owner - The public key of the user who is swapping
   * @param {PublicKey} inTokenMint - The mint of the token you're swapping from.
   * @param {BN} inAmountLamport - The amount of the input token you want to swap.
   * @param {BN} outAmountLamport - The minimum amount of the output token you want to receive.
   * @param {PublicKey} [referrerToken] - The referrer fee token account. The mint of the token account must matches inTokenMint. 20% of admin trade fee.
   * @returns A transaction object
   */
  public async swap(
    owner: PublicKey,
    inTokenMint: PublicKey,
    inAmountLamport: BN,
    outAmountLamport: BN,
    referrerToken?: PublicKey,
  ): Promise<Transaction> {
    const [sourceToken, destinationToken] =
      this.tokenA.address === inTokenMint.toBase58()
        ? [this.poolState.tokenAMint, this.poolState.tokenBMint]
        : [this.poolState.tokenBMint, this.poolState.tokenAMint];

    const adminTokenFee =
      this.tokenA.address === inTokenMint.toBase58() ? this.poolState.adminTokenAFee : this.poolState.adminTokenBFee;

    let preInstructions: Array<TransactionInstruction> = [];
    const [[userSourceToken, createUserSourceIx], [userDestinationToken, createUserDestinationIx]] =
      await this.createATAPreInstructions(owner, [sourceToken, destinationToken]);

    createUserSourceIx && preInstructions.push(createUserSourceIx);
    createUserDestinationIx && preInstructions.push(createUserDestinationIx);

    if (sourceToken.equals(NATIVE_MINT)) {
      preInstructions = preInstructions.concat(
        wrapSOLInstruction(owner, userSourceToken, BigInt(inAmountLamport.toString())),
      );
    }

    const postInstructions: Array<TransactionInstruction> = [];
    if (NATIVE_MINT.equals(destinationToken)) {
      const unwrapSOLIx = await unwrapSOLInstruction(owner);
      unwrapSOLIx && postInstructions.push(unwrapSOLIx);
    }

    const remainingAccounts = this.swapCurve.getRemainingAccounts();
    if (referrerToken) {
      remainingAccounts.push({
        isSigner: false,
        isWritable: true,
        pubkey: referrerToken,
      });
    }

    const swapTx = await this.program.methods
      .swap(inAmountLamport, outAmountLamport)
      .accounts({
        aTokenVault: this.vaultA.vaultState.tokenVault,
        bTokenVault: this.vaultB.vaultState.tokenVault,
        aVault: this.poolState.aVault,
        bVault: this.poolState.bVault,
        aVaultLp: this.poolState.aVaultLp,
        bVaultLp: this.poolState.bVaultLp,
        aVaultLpMint: this.vaultA.vaultState.lpMint,
        bVaultLpMint: this.vaultB.vaultState.lpMint,
        userSourceToken,
        userDestinationToken,
        user: owner,
        adminTokenFee,
        pool: this.address,
        tokenProgram: TOKEN_PROGRAM_ID,
        vaultProgram: this.vaultProgram.programId,
      })
      .remainingAccounts(remainingAccounts)
      .preInstructions(preInstructions)
      .postInstructions(postInstructions)
      .transaction();

    return new Transaction({
      feePayer: owner,
      ...(await this.program.provider.connection.getLatestBlockhash(this.program.provider.connection.commitment)),
    }).add(swapTx);
  }

  /**
   * `getDepositQuote` is a function that takes in a tokenAInAmount, tokenBInAmount, balance, and
   * slippage, and returns a poolTokenAmountOut, tokenAInAmount, and tokenBInAmount. `tokenAInAmount` or `tokenBAmount`
   * can be zero for balance deposit quote.
   * @param {BN} tokenAInAmount - The amount of token A to be deposit,
   * @param {BN} tokenBInAmount - The amount of token B to be deposit,
   * @param {boolean} [balance] - return false if the deposit is imbalance
   * @param {number} [slippage] - The amount of slippage you're willing to accept. (Max to 2 decimal place)
   * @returns The return value is a tuple of the poolTokenAmountOut, tokenAInAmount, and
   * tokenBInAmount.
   */
  public getDepositQuote(tokenAInAmount: BN, tokenBInAmount: BN, balance: boolean, slippage: number): DepositQuote {
    invariant(
      !(
        !this.isStablePool &&
        !tokenAInAmount.isZero() &&
        !tokenBInAmount.isZero() &&
        !this.accountsInfo.poolLpSupply.isZero()
      ),
      'Constant product only supports balanced deposit',
    );
    invariant(
      !(!tokenAInAmount.isZero() && !tokenBInAmount.isZero() && balance),
      'Deposit balance is not possible when both token in amount is non-zero',
    );

    if (this.accountsInfo.poolLpSupply.isZero()) {
      const poolTokenAmountOut = this.swapCurve.computeD(tokenAInAmount, tokenBInAmount);
      return {
        poolTokenAmountOut,
        minPoolTokenAmountOut: poolTokenAmountOut,
        tokenAInAmount: tokenAInAmount,
        tokenBInAmount: tokenBInAmount,
      };
    }

    const vaultAWithdrawableAmount = calculateWithdrawableAmount(
      this.accountsInfo.currentTime.toNumber(),
      this.vaultA.vaultState,
    );
    const vaultBWithdrawableAmount = calculateWithdrawableAmount(
      this.accountsInfo.currentTime.toNumber(),
      this.vaultB.vaultState,
    );

    if (tokenAInAmount.isZero() && balance) {
      const poolTokenAmountOut = this.getShareByAmount(
        tokenBInAmount,
        this.poolInfo.tokenBAmount,
        this.accountsInfo.poolLpSupply,
      );
      const bufferedPoolTokenAmountOut = getMinAmountWithSlippage(poolTokenAmountOut, UNLOCK_AMOUNT_BUFFER);

      // Calculate for stable pool balance deposit but used `addImbalanceLiquidity`
      if (this.isStablePool) {
        return {
          poolTokenAmountOut: bufferedPoolTokenAmountOut,
          minPoolTokenAmountOut: getMinAmountWithSlippage(bufferedPoolTokenAmountOut, slippage),
          tokenAInAmount: tokenBInAmount.mul(this.poolInfo.tokenAAmount).div(this.poolInfo.tokenBAmount),
          tokenBInAmount,
        };
      }

      // Constant product pool balance deposit
      const [actualTokenAInAmount, actualTokenBInAmount] = this.computeActualInAmount(
        poolTokenAmountOut,
        this.accountsInfo.poolLpSupply,
        this.accountsInfo.poolVaultALp,
        this.accountsInfo.poolVaultBLp,
        this.accountsInfo.vaultALpSupply,
        this.accountsInfo.vaultBLpSupply,
        vaultAWithdrawableAmount,
        vaultBWithdrawableAmount,
      );

      return {
        poolTokenAmountOut: bufferedPoolTokenAmountOut,
        minPoolTokenAmountOut: getMinAmountWithSlippage(bufferedPoolTokenAmountOut, slippage),
        tokenAInAmount: getMaxAmountWithSlippage(actualTokenAInAmount, slippage),
        tokenBInAmount: getMaxAmountWithSlippage(actualTokenBInAmount, slippage),
      };
    }

    if (tokenBInAmount.isZero() && balance) {
      const poolTokenAmountOut = this.getShareByAmount(
        tokenAInAmount,
        this.poolInfo.tokenAAmount,
        this.accountsInfo.poolLpSupply,
      );
      const bufferedPoolTokenAmountOut = getMinAmountWithSlippage(poolTokenAmountOut, UNLOCK_AMOUNT_BUFFER);

      // Calculate for stable pool balance deposit but used `addImbalanceLiquidity`
      if (this.isStablePool) {
        return {
          poolTokenAmountOut: bufferedPoolTokenAmountOut,
          minPoolTokenAmountOut: getMinAmountWithSlippage(bufferedPoolTokenAmountOut, slippage),
          tokenAInAmount,
          tokenBInAmount: tokenAInAmount.mul(this.poolInfo.tokenBAmount).div(this.poolInfo.tokenAAmount),
        };
      }

      // Constant product pool
      const [actualTokenAInAmount, actualTokenBInAmount] = this.computeActualInAmount(
        poolTokenAmountOut,
        this.accountsInfo.poolLpSupply,
        this.accountsInfo.poolVaultALp,
        this.accountsInfo.poolVaultBLp,
        this.accountsInfo.vaultALpSupply,
        this.accountsInfo.vaultBLpSupply,
        vaultAWithdrawableAmount,
        vaultBWithdrawableAmount,
      );

      return {
        poolTokenAmountOut: bufferedPoolTokenAmountOut,
        minPoolTokenAmountOut: getMinAmountWithSlippage(bufferedPoolTokenAmountOut, slippage),
        tokenAInAmount: getMaxAmountWithSlippage(actualTokenAInAmount, slippage),
        tokenBInAmount: getMaxAmountWithSlippage(actualTokenBInAmount, slippage),
      };
    }

    // Imbalance deposit
    const actualDepositAAmount = computeActualDepositAmount(
      tokenAInAmount,
      this.poolInfo.tokenAAmount,
      this.accountsInfo.poolVaultALp,
      this.accountsInfo.vaultALpSupply,
      vaultAWithdrawableAmount,
    );

    const actualDepositBAmount = computeActualDepositAmount(
      tokenBInAmount,
      this.poolInfo.tokenBAmount,
      this.accountsInfo.poolVaultBLp,
      this.accountsInfo.vaultBLpSupply,
      vaultBWithdrawableAmount,
    );

    const poolTokenAmountOut = this.swapCurve.computeImbalanceDeposit(
      actualDepositAAmount,
      actualDepositBAmount,
      this.poolInfo.tokenAAmount,
      this.poolInfo.tokenBAmount,
      this.accountsInfo.poolLpSupply,
      this.poolState.fees,
    );

    return {
      poolTokenAmountOut,
      minPoolTokenAmountOut: getMinAmountWithSlippage(poolTokenAmountOut, slippage),
      tokenAInAmount,
      tokenBInAmount,
    };
  }

  /**
   * `deposit` creates a transaction that deposits `tokenAInAmount` and `tokenBInAmount` into the pool,
   * and mints `poolTokenAmount` of the pool's liquidity token
   * @param {PublicKey} owner - PublicKey - The public key of the user who is depositing liquidity
   * @param {BN} tokenAInAmount - The amount of token A you want to deposit
   * @param {BN} tokenBInAmount - The amount of token B you want to deposit
   * @param {BN} poolTokenAmount - The amount of pool tokens you want to mint.
   * @returns A transaction object
   */
  public async deposit(
    owner: PublicKey,
    tokenAInAmount: BN,
    tokenBInAmount: BN,
    poolTokenAmount: BN,
  ): Promise<Transaction> {
    const { tokenAMint, tokenBMint, lpMint, lpSupply } = this.poolState;

    const [[userAToken, createTokenAIx], [userBToken, createTokenBIx], [userPoolLp, createLpMintIx]] =
      await this.createATAPreInstructions(owner, [tokenAMint, tokenBMint, lpMint]);

    let preInstructions: Array<TransactionInstruction> = [];
    createTokenAIx && preInstructions.push(createTokenAIx);
    createTokenBIx && preInstructions.push(createTokenBIx);
    createLpMintIx && preInstructions.push(createLpMintIx);

    if (NATIVE_MINT.equals(new PublicKey(this.tokenA.address))) {
      preInstructions = preInstructions.concat(
        wrapSOLInstruction(owner, userAToken, BigInt(tokenAInAmount.toString())),
      );
    }
    if (NATIVE_MINT.equals(new PublicKey(this.tokenB.address))) {
      preInstructions = preInstructions.concat(
        wrapSOLInstruction(owner, userBToken, BigInt(tokenBInAmount.toString())),
      );
    }

    const postInstructions: Array<TransactionInstruction> = [];
    if ([this.tokenA.address, this.tokenB.address].includes(NATIVE_MINT.toBase58())) {
      const closeWrappedSOLIx = await unwrapSOLInstruction(owner);
      closeWrappedSOLIx && postInstructions.push(closeWrappedSOLIx);
    }

    const programMethod = () => {
      if (lpSupply.isZero()) return this.program.methods.bootstrapLiquidity(tokenAInAmount, tokenBInAmount);
      if (this.isStablePool)
        return this.program.methods.addImbalanceLiquidity(poolTokenAmount, tokenAInAmount, tokenBInAmount);

      return this.program.methods.addBalanceLiquidity(poolTokenAmount, tokenAInAmount, tokenBInAmount);
    };

    const depositTx = await programMethod()
      .accounts({
        aTokenVault: this.vaultA.vaultState.tokenVault,
        bTokenVault: this.vaultB.vaultState.tokenVault,
        aVault: this.poolState.aVault,
        bVault: this.poolState.bVault,
        pool: this.address,
        user: owner,
        userAToken,
        userBToken,
        aVaultLp: this.poolState.aVaultLp,
        bVaultLp: this.poolState.bVaultLp,
        aVaultLpMint: this.vaultA.vaultState.lpMint,
        bVaultLpMint: this.vaultB.vaultState.lpMint,
        lpMint: this.poolState.lpMint,
        tokenProgram: TOKEN_PROGRAM_ID,
        vaultProgram: this.vaultProgram.programId,
        userPoolLp,
      })
      .remainingAccounts(this.swapCurve.getRemainingAccounts())
      .preInstructions(preInstructions)
      .postInstructions(postInstructions)
      .transaction();

    return new Transaction({
      feePayer: owner,
      ...(await this.program.provider.connection.getLatestBlockhash(this.program.provider.connection.commitment)),
    }).add(depositTx);
  }

  /**
   * `getWithdrawQuote` is a function that takes in a withdraw amount and returns the amount of tokens
   * that will be withdrawn from the pool
   * @param {BN} withdrawTokenAmount - The amount of tokens you want to withdraw from the pool.
   * @param {PublicKey} [tokenMint] - The token you want to withdraw. If you want balanced withdraw, leave this blank.
   * @param {number} [slippage] - The amount of slippage you're willing to accept. (Max to 2 decimal place)
   * @returns The return value is a tuple of the poolTokenAmountIn, tokenAOutAmount, and
   * tokenBOutAmount.
   */
  public getWithdrawQuote(withdrawTokenAmount: BN, slippage: number, tokenMint?: PublicKey): WithdrawQuote {
    const vaultAWithdrawableAmount = calculateWithdrawableAmount(
      this.accountsInfo.currentTime.toNumber(),
      this.vaultA.vaultState,
    );
    const vaultBWithdrawableAmount = calculateWithdrawableAmount(
      this.accountsInfo.currentTime.toNumber(),
      this.vaultB.vaultState,
    );

    // balance withdraw
    if (!tokenMint) {
      const vaultALpBurn = this.getShareByAmount(
        withdrawTokenAmount,
        this.accountsInfo.poolLpSupply,
        this.accountsInfo.poolVaultALp,
      );
      const vaultBLpBurn = this.getShareByAmount(
        withdrawTokenAmount,
        this.accountsInfo.poolLpSupply,
        this.accountsInfo.poolVaultBLp,
      );

      const tokenAOutAmount = this.getAmountByShare(
        vaultALpBurn,
        vaultAWithdrawableAmount,
        this.accountsInfo.vaultALpSupply,
      );
      const tokenBOutAmount = this.getAmountByShare(
        vaultBLpBurn,
        vaultBWithdrawableAmount,
        this.accountsInfo.vaultBLpSupply,
      );

      return {
        poolTokenAmountIn: withdrawTokenAmount,
        tokenAOutAmount,
        tokenBOutAmount,
        minTokenAOutAmount: getMinAmountWithSlippage(tokenAOutAmount, slippage),
        minTokenBOutAmount: getMinAmountWithSlippage(tokenBOutAmount, slippage),
      };
    }

    // Imbalance withdraw
    const isWithdrawingTokenA = tokenMint.equals(new PublicKey(this.tokenA.address));
    const isWithdrawingTokenB = tokenMint.equals(new PublicKey(this.tokenB.address));
    invariant(isWithdrawingTokenA || isWithdrawingTokenB, ERROR.INVALID_MINT);

    const tradeDirection = tokenMint.equals(this.poolState.tokenAMint) ? TradeDirection.BToA : TradeDirection.AToB;

    const outAmount = this.swapCurve.computeWithdrawOne(
      withdrawTokenAmount,
      this.accountsInfo.poolLpSupply,
      this.poolInfo.tokenAAmount,
      this.poolInfo.tokenBAmount,
      this.poolState.fees,
      tradeDirection,
    );

    const [vaultLpSupply, vaultTotalAmount] =
      tradeDirection == TradeDirection.AToB
        ? [this.accountsInfo.vaultBLpSupply, vaultBWithdrawableAmount]
        : [this.accountsInfo.vaultALpSupply, vaultAWithdrawableAmount];

    const vaultLpToBurn = outAmount.mul(vaultLpSupply).div(vaultTotalAmount);
    // "Actual" out amount (precision loss)
    const realOutAmount = vaultLpToBurn.mul(vaultTotalAmount).div(vaultLpSupply);
    const minRealOutAmount = getMinAmountWithSlippage(realOutAmount, slippage);

    return {
      poolTokenAmountIn: withdrawTokenAmount,
      tokenAOutAmount: isWithdrawingTokenA ? realOutAmount : new BN(0),
      tokenBOutAmount: isWithdrawingTokenB ? realOutAmount : new BN(0),
      minTokenAOutAmount: isWithdrawingTokenA ? minRealOutAmount : new BN(0),
      minTokenBOutAmount: isWithdrawingTokenB ? minRealOutAmount : new BN(0),
    };
  }

  /**
   * `withdraw` is a function that takes in the owner's public key, the amount of tokens to withdraw,
   * and the amount of tokens to withdraw from each pool, and returns a transaction that withdraws the
   * specified amount of tokens from the pool
   * @param {PublicKey} owner - PublicKey - The public key of the user who is withdrawing liquidity
   * @param {BN} lpTokenAmount - The amount of LP tokens to withdraw.
   * @param {BN} tokenAOutAmount - The amount of token A you want to withdraw.
   * @param {BN} tokenBOutAmount - The amount of token B you want to withdraw,
   * @returns A transaction object
   */
  public async withdraw(
    owner: PublicKey,
    lpTokenAmount: BN,
    tokenAOutAmount: BN,
    tokenBOutAmount: BN,
  ): Promise<Transaction> {
    const preInstructions: Array<TransactionInstruction> = [];
    const [[userAToken, createUserAIx], [userBToken, createUserBIx], [userPoolLp, createLpTokenIx]] = await Promise.all(
      [this.poolState.tokenAMint, this.poolState.tokenBMint, this.poolState.lpMint].map((key) =>
        getOrCreateATAInstruction(key, owner, this.program.provider.connection),
      ),
    );

    createUserAIx && preInstructions.push(createUserAIx);
    createUserBIx && preInstructions.push(createUserBIx);
    createLpTokenIx && preInstructions.push(createLpTokenIx);

    const postInstructions: Array<TransactionInstruction> = [];
    if ([this.tokenA.address, this.tokenB.address].includes(NATIVE_MINT.toBase58())) {
      const closeWrappedSOLIx = await unwrapSOLInstruction(owner);
      closeWrappedSOLIx && postInstructions.push(closeWrappedSOLIx);
    }

    const programMethod =
      this.isStablePool && (tokenAOutAmount.isZero() || tokenBOutAmount.isZero())
        ? this.program.methods.removeLiquiditySingleSide(lpTokenAmount, new BN(0)).accounts({
            aTokenVault: this.vaultA.vaultState.tokenVault,
            aVault: this.poolState.aVault,
            aVaultLp: this.poolState.aVaultLp,
            aVaultLpMint: this.vaultA.vaultState.lpMint,
            bTokenVault: this.vaultB.vaultState.tokenVault,
            bVault: this.poolState.bVault,
            bVaultLp: this.poolState.bVaultLp,
            bVaultLpMint: this.vaultB.vaultState.lpMint,
            lpMint: this.poolState.lpMint,
            pool: this.address,
            userDestinationToken: tokenBOutAmount.isZero() ? userAToken : userBToken,
            userPoolLp,
            user: owner,
            tokenProgram: TOKEN_PROGRAM_ID,
            vaultProgram: this.vaultProgram.programId,
          })
        : this.program.methods.removeBalanceLiquidity(lpTokenAmount, tokenAOutAmount, tokenBOutAmount).accounts({
            pool: this.address,
            lpMint: this.poolState.lpMint,
            aVault: this.poolState.aVault,
            aTokenVault: this.vaultA.vaultState.tokenVault,
            aVaultLp: this.poolState.aVaultLp,
            aVaultLpMint: this.vaultA.vaultState.lpMint,
            bVault: this.poolState.bVault,
            bTokenVault: this.vaultB.vaultState.tokenVault,
            bVaultLp: this.poolState.bVaultLp,
            bVaultLpMint: this.vaultB.vaultState.lpMint,
            userAToken,
            userBToken,
            user: owner,
            userPoolLp,
            tokenProgram: TOKEN_PROGRAM_ID,
            vaultProgram: this.vaultProgram.programId,
          });

    const withdrawTx = await programMethod
      .remainingAccounts(this.swapCurve.getRemainingAccounts())
      .preInstructions(preInstructions)
      .postInstructions(postInstructions)
      .transaction();

    return new Transaction({
      feePayer: owner,
      ...(await this.program.provider.connection.getLatestBlockhash(this.program.provider.connection.commitment)),
    }).add(withdrawTx);
  }

  public async getUserLockEscrow(owner: PublicKey): Promise<LockEscrow | null> {
    const [lockEscrow, _lockEscrowBump] = deriveLockEscrowPda(this.address, owner, this.program.programId);
    const lockEscrowAccount: LockEscrowAccount | null = await this.program.account.lockEscrow.fetchNullable(lockEscrow);
    if (!lockEscrowAccount) return null;
    const unClaimedFee = calculateUnclaimedLockEscrowFee(
      lockEscrowAccount.totalLockedAmount,
      lockEscrowAccount.lpPerToken,
      lockEscrowAccount.unclaimedFeePending,
      this.poolInfo.virtualPriceRaw,
    );

    const { tokenAOutAmount, tokenBOutAmount } = this.getWithdrawQuote(unClaimedFee, 0);
    return {
      address: lockEscrow,
      amount: lockEscrowAccount.totalLockedAmount || new BN(0),
      fee: {
        claimed: {
          tokenA: lockEscrowAccount.aFee || new BN(0),
          tokenB: lockEscrowAccount.bFee || new BN(0),
        },
        unClaimed: {
          lp: unClaimedFee,
          tokenA: tokenAOutAmount || new BN(0),
          tokenB: tokenBOutAmount || new BN(0),
        },
      },
    };
  }

  public static async lockLiquidityNewlyCreatedPool(
    connection: Connection,
    poolAddress: PublicKey,
    owner: PublicKey,
    amount: BN,
    tokenInfoA: TokenInfo,
    tokenInfoB: TokenInfo,
    opt?: {
      cluster?: Cluster;
      programId?: string;
    },
  ): Promise<Transaction> {
    const { vaultProgram, ammProgram } = createProgram(connection, opt?.programId);

    const [lpMint] = PublicKey.findProgramAddressSync(
      [Buffer.from(SEEDS.LP_MINT), poolAddress.toBuffer()],
      ammProgram.programId,
    );

    const [lockEscrowPK] = deriveLockEscrowPda(poolAddress, owner, ammProgram.programId);
    const preInstructions: TransactionInstruction[] = [];
    const createLockEscrowIx = await ammProgram.methods.createLockEscrow().accounts({
      pool: poolAddress,
      lockEscrow: lockEscrowPK,
      owner,
      lpMint,
      payer: owner,
      systemProgram: SystemProgram.programId,
    });
    preInstructions.push(await createLockEscrowIx.instruction());
    const [escrowAta, createEscrowAtaIx] = await getOrCreateATAInstruction(lpMint, lockEscrowPK, connection, owner);
    const userLpAta = await getAssociatedTokenAccount(lpMint, owner);

    createEscrowAtaIx && preInstructions.push(createEscrowAtaIx);

    const tokenAMint = new PublicKey(tokenInfoA.address);
    const tokenBMint = new PublicKey(tokenInfoB.address);
    const [{ vaultPda: aVault, lpMintPda: aLpMintPda }, { vaultPda: bVault, lpMintPda: bLpMintPda }] = [
      getVaultPdas(tokenAMint, vaultProgram.programId),
      getVaultPdas(tokenBMint, vaultProgram.programId),
    ];

    const aVaultAccount = await vaultProgram.account.vault.fetchNullable(aVault);
    const aVaultLpMint = aVaultAccount?.lpMint || aLpMintPda;

    const bVaultAccount = await vaultProgram.account.vault.fetchNullable(bVault);
    const bVaultLpMint = bVaultAccount?.lpMint || bLpMintPda;

    const [[aVaultLp], [bVaultLp]] = [
      PublicKey.findProgramAddressSync([aVault.toBuffer(), poolAddress.toBuffer()], ammProgram.programId),
      PublicKey.findProgramAddressSync([bVault.toBuffer(), poolAddress.toBuffer()], ammProgram.programId),
    ];

    const lockTx = await ammProgram.methods
      .lock(amount)
      .accounts({
        pool: poolAddress,
        lockEscrow: lockEscrowPK,
        owner,
        lpMint,
        sourceTokens: userLpAta,
        escrowVault: escrowAta,
        tokenProgram: TOKEN_PROGRAM_ID,
        aVault,
        bVault,
        aVaultLp,
        bVaultLp,
        aVaultLpMint,
        bVaultLpMint,
      })
      .preInstructions(preInstructions)
      .transaction();

    return new Transaction({
      feePayer: owner,
      ...(await connection.getLatestBlockhash(connection.commitment)),
    }).add(lockTx);
  }

  public async lockLiquidity(owner: PublicKey, amount: BN): Promise<Transaction> {
    const [lockEscrowPK] = deriveLockEscrowPda(this.address, owner, this.program.programId);

    const preInstructions: TransactionInstruction[] = [];

    const lockEscrow = await this.getUserLockEscrow(owner);
    if (!lockEscrow) {
      const createLockEscrowIx = await this.program.methods.createLockEscrow().accounts({
        pool: this.address,
        lockEscrow: lockEscrowPK,
        owner,
        lpMint: this.poolState.lpMint,
        payer: owner,
        systemProgram: SystemProgram.programId,
      });
      preInstructions.push(await createLockEscrowIx.instruction());
    }

    const [[userAta, createUserAtaIx], [escrowAta, createEscrowAtaIx]] = await Promise.all([
      getOrCreateATAInstruction(this.poolState.lpMint, owner, this.program.provider.connection, owner),
      getOrCreateATAInstruction(this.poolState.lpMint, lockEscrowPK, this.program.provider.connection, owner),
    ]);

    createUserAtaIx && preInstructions.push(createUserAtaIx);
    createEscrowAtaIx && preInstructions.push(createEscrowAtaIx);

    const lockTx = await this.program.methods
      .lock(amount)
      .accounts({
        pool: this.address,
        lockEscrow: lockEscrowPK,
        owner,
        lpMint: this.poolState.lpMint,
        sourceTokens: userAta,
        escrowVault: escrowAta,
        tokenProgram: TOKEN_PROGRAM_ID,
        aVault: this.poolState.aVault,
        bVault: this.poolState.bVault,
        aVaultLp: this.poolState.aVaultLp,
        bVaultLp: this.poolState.bVaultLp,
        aVaultLpMint: this.vaultA.vaultState.lpMint,
        bVaultLpMint: this.vaultB.vaultState.lpMint,
      })
      .preInstructions(preInstructions)
      .transaction();

    return new Transaction({
      feePayer: owner,
      ...(await this.program.provider.connection.getLatestBlockhash(this.program.provider.connection.commitment)),
    }).add(lockTx);
  }

  public async claimLockFee(owner: PublicKey, maxAmount: BN): Promise<Transaction> {
    const [lockEscrowPK] = deriveLockEscrowPda(this.address, owner, this.program.programId);

    const preInstructions: TransactionInstruction[] = [];
    const [
      [userAta, createUserAtaIx],
      [escrowAta, createEscrowAtaIx],
      [tokenAAta, createTokenAAtaIx],
      [tokenBAta, createTokenBAtaIx],
    ] = await Promise.all([
      getOrCreateATAInstruction(this.poolState.lpMint, owner, this.program.provider.connection),
      getOrCreateATAInstruction(this.poolState.lpMint, lockEscrowPK, this.program.provider.connection),
      getOrCreateATAInstruction(this.poolState.tokenAMint, owner, this.program.provider.connection),
      getOrCreateATAInstruction(this.poolState.tokenBMint, owner, this.program.provider.connection),
    ]);
    createUserAtaIx && preInstructions.push(createUserAtaIx);
    createEscrowAtaIx && preInstructions.push(createEscrowAtaIx);
    createTokenAAtaIx && preInstructions.push(createTokenAAtaIx);
    createTokenBAtaIx && preInstructions.push(createTokenBAtaIx);

    const postInstructions: Array<TransactionInstruction> = [];
    if ([this.poolState.tokenAMint.toBase58(), this.poolState.tokenBMint.toBase58()].includes(NATIVE_MINT.toBase58())) {
      const closeWrappedSOLIx = await unwrapSOLInstruction(owner);
      closeWrappedSOLIx && postInstructions.push(closeWrappedSOLIx);
    }

    const tx = await this.program.methods
      .claimFee(maxAmount)
      .accounts({
        pool: this.address,
        lockEscrow: lockEscrowPK,
        owner,
        lpMint: this.poolState.lpMint,
        sourceTokens: userAta,
        escrowVault: escrowAta,
        tokenProgram: TOKEN_PROGRAM_ID,
        aVault: this.poolState.aVault,
        bVault: this.poolState.bVault,
        aVaultLp: this.poolState.aVaultLp,
        bVaultLp: this.poolState.bVaultLp,
        aVaultLpMint: this.vaultA.vaultState.lpMint,
        bVaultLpMint: this.vaultB.vaultState.lpMint,
        vaultProgram: this.vaultProgram.programId,
        aTokenVault: this.vaultA.vaultState.tokenVault,
        bTokenVault: this.vaultB.vaultState.tokenVault,
        userAToken: tokenAAta,
        userBToken: tokenBAta,
      })
      .preInstructions(preInstructions)
      .postInstructions(postInstructions)
      .transaction();
    return new Transaction({
      feePayer: owner,
      ...(await this.program.provider.connection.getLatestBlockhash(this.program.provider.connection.commitment)),
    }).add(tx);
  }

  private async createATAPreInstructions(owner: PublicKey, mintList: Array<PublicKey>) {
    return Promise.all(
      mintList.map((mint) => {
        return getOrCreateATAInstruction(mint, owner, this.program.provider.connection);
      }),
    );
  }

  private calculateAdminTradingFee(amount: BN): BN {
    const { ownerTradeFeeDenominator, ownerTradeFeeNumerator } = this.poolState.fees;
    return amount.mul(ownerTradeFeeNumerator).div(ownerTradeFeeDenominator);
  }

  private calculateTradingFee(amount: BN): BN {
    const { tradeFeeDenominator, tradeFeeNumerator } = this.poolState.fees;
    return amount.mul(tradeFeeNumerator).div(tradeFeeDenominator);
  }

  private computeActualInAmount(
    poolTokenAmount: BN,
    poolLpSupply: BN,
    poolVaultALp: BN,
    poolVaultBLp: BN,
    vaultALpSupply: BN,
    vaultBLpSupply: BN,
    vaultAWithdrawableAmount: BN,
    vaultBWithdrawableAmount: BN,
  ): [BN, BN] {
    const aVaultLpMinted = this.getShareByAmount(poolTokenAmount, poolLpSupply, poolVaultALp, true);
    const bVaultLpMinted = this.getShareByAmount(poolTokenAmount, poolLpSupply, poolVaultBLp, true);

    const actualTokenAInAmount = this.getAmountByShare(aVaultLpMinted, vaultAWithdrawableAmount, vaultALpSupply, true);
    const actualTokenBInAmount = this.getAmountByShare(bVaultLpMinted, vaultBWithdrawableAmount, vaultBLpSupply, true);

    return [actualTokenAInAmount, actualTokenBInAmount];
  }

  private getShareByAmount(amount: BN, tokenAmount: BN, lpSupply: BN, roundUp?: boolean): BN {
    if (tokenAmount.isZero()) return new BN(0);

    return roundUp ? amount.mul(lpSupply).divRound(tokenAmount) : amount.mul(lpSupply).div(tokenAmount);
  }

  private getAmountByShare(amount: BN, tokenAmount: BN, lpSupply: BN, roundUp?: boolean): BN {
    if (lpSupply.isZero()) return new BN(0);

    return roundUp ? amount.mul(tokenAmount).divRound(lpSupply) : amount.mul(tokenAmount).div(lpSupply);
  }
}
