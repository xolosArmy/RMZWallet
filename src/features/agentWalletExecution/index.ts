/**
 * @file index.ts
 *
 * CANONICAL WALLET-OWNED PREPARED TRANSACTION CONSTRUCTION & SIGNING (Gate C2)
 *
 * Governed by: Canonical Roadmap Operating Instruction v1.1
 * Scope: Plain mainnet XEC payment preparation and offline signing within Wallet boundary.
 *
 * Boundary Rules:
 * - Module-private execution capability and tokens are NOT exported.
 * - Private keys, seeds, mnemonics, and WIF are NEVER exported or handled here.
 * - Raw signed transaction bytes are retained inside private Wallet settlement storage and NEVER returned externally.
 * - External callers receive only an opaque SignedExecutionHandle or PublicExecutionStatus.
 * - Public Agent-facing engine contains ZERO confirmation, signing, or execution methods.
 * - Zero broadcast or network mutation functions are present.
 */

export {
  createWalletExecutionComposition,
  createAgentWalletExecutionEngine
} from './engine'

export {
  DurableTransactionalExecutionLedger,
  DurableStorageWalletExecutionLedger,
  WebLocksExecutionCoordinator,
  DEFAULT_EXECUTION_LEDGER_STORAGE_KEY,
  VALID_EXECUTION_STATE_TRANSITIONS
} from './ledger'
export type { ExecutionLockCoordinator, DurableTransactionalExecutionLedgerOptions } from './ledger'

export { WalletExecutionError } from './errors'
export type { WalletExecutionErrorCode } from './errors'

export {
  DEFAULT_FEE_POLICY,
  estimateP2pkhTransactionSize,
  assertFeePolicy,
  validateOutputInvariants,
  computeCanonicalPlanHash,
  computePlanHashSync,
  canonicalJsonStringify
} from './plan'

export type {
  ExecutionNetwork,
  ExecutionUtxoInput,
  ExecutionTxOutput,
  WalletPreparedExecutionPlan,
  WalletExecutionReviewSnapshot,
  WalletFeePolicy,
  WalletExecutionState,
  PublicExecutionStatus,
  SignedExecutionHandle,
  WalletExecutionReviewSession,
  WalletUtxoProvider,
  WalletSignatoryProvider,
  WalletSessionVerifier,
  WalletExecutionLedger,
  AgentWalletExecutionEngineConfig,
  AgentWalletExecutionEngine,
  WalletExecutionComposition,
  WalletExecutionUIHost
} from './types'
