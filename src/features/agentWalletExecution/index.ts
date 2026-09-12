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
 * - Raw signed transaction bytes are retained inside Wallet execution ledger and NEVER returned externally.
 * - Callers receive only an opaque SignedExecutionHandle.
 * - Zero broadcast or network mutation functions are present.
 */

export { createAgentWalletExecutionEngine } from './engine'
export { InMemoryWalletExecutionLedger } from './ledger'
export { WalletExecutionError } from './errors'
export type { WalletExecutionErrorCode } from './errors'
export {
  DEFAULT_FEE_POLICY,
  estimateP2pkhTransactionSize,
  assertFeePolicy,
  validateOutputInvariants
} from './plan'

export type {
  ExecutionNetwork,
  ExecutionUtxoInput,
  ExecutionTxOutput,
  WalletPreparedExecutionPlan,
  WalletExecutionReviewSnapshot,
  WalletFeePolicy,
  WalletExecutionState,
  WalletExecutionRecord,
  SignedExecutionHandle,
  WalletExecutionSession,
  WalletUtxoProvider,
  WalletSignatoryProvider,
  WalletSessionVerifier,
  WalletExecutionLedger,
  AgentWalletExecutionEngineConfig,
  AgentWalletExecutionEngine
} from './types'
