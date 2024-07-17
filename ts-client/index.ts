import AmmImpl from './src/amm';
import DynamicAmmError from './src/amm/error';
import { ConstantProductSwap } from './src/amm/curve';
import {
  PROGRAM_ID,
  MAINNET_POOL,
  DEVNET_POOL,
  CURVE_TYPE_ACCOUNTS,
  CONSTANT_PRODUCT_ALLOWED_TRADE_FEE_BPS,
  STABLE_SWAP_ALLOWED_TRADE_FEE_BPS,
} from './src/amm/constants';
import {
  getOnchainTime,
  calculateMaxSwapOutAmount,
  calculateSwapQuote,
  calculatePoolInfo,
  getDepegAccounts,
  checkPoolExists,
  getTokensMintFromPoolAddress,
  derivePoolAddress,
} from './src/amm/utils';
import { Amm, IDL as AmmIdl } from './src/amm/idl';
import { VaultIdl } from '@mercurial-finance/vault-sdk';
import { Vault } from '@mercurial-finance/vault-sdk/src/vault/idl';

export default AmmImpl;
export {
  // Classes
  ConstantProductSwap,
  DynamicAmmError,
  // Utils
  getDepegAccounts,
  getOnchainTime,
  calculateMaxSwapOutAmount,
  calculateSwapQuote,
  calculatePoolInfo,
  checkPoolExists,
  getTokensMintFromPoolAddress,
  derivePoolAddress,
  // Constant
  PROGRAM_ID,
  MAINNET_POOL,
  DEVNET_POOL,
  CURVE_TYPE_ACCOUNTS,
  CONSTANT_PRODUCT_ALLOWED_TRADE_FEE_BPS,
  STABLE_SWAP_ALLOWED_TRADE_FEE_BPS,
  // IDL
  AmmIdl,
  VaultIdl,
};

export type {
  AmmImplementation,
  DepositQuote,
  WithdrawQuote,
  SwapQuote,
  PoolState,
  LockEscrow,
  PoolInformation,
  ParsedClockState,
  ConstantProductCurve,
  StableSwapCurve,
  SwapQuoteParam,
} from './src/amm/types';
export type { VaultState } from '@mercurial-finance/vault-sdk';
export type { Amm, Vault };

// export { SEEDS, FEE_OWNER, METAPLEX_PROGRAM } from './src/amm';
// export {
//   calculateUnclaimedLockEscrowFee,
//   createProgram,
//   deriveLockEscrowPda,
//   deriveMintMetadata,
//   getAssociatedTokenAccount,
// } from './src/amm';
// export { LockEscrowAccount } from './src/amm';
