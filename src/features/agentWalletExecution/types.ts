/**
 * @file types.ts
 *
 * CANONICAL WALLET-OWNED PREPARED TRANSACTION EXECUTION TYPES (Gate C2)
 *
 * Governed by: Canonical Roadmap Operating Instruction v1.1
 * Scope: Plain mainnet XEC payment preparation and offline signing within Wallet boundary.
 *
 * Invariants:
 * - Plain XEC mainnet payment only ("xec:mainnet").
 * - Zero transaction broadcast.
 * - Raw signed transaction material is persisted write-only under an opaque executionId.
 * - C2 exposes no raw-transaction retrieval API; trusted retrieval belongs to Gate C3.
 * - External callers receive only an opaque SignedExecutionHandle.
 * - Public status queries omit signed transaction bytes.
 * - Private keys, seeds, mnemonics, and WIF never appear in any type or interface here.
 */

import type { HumanApprovalV1 } from '@xolosarmy/tonalli-core'
import type { WalletApprovalLedgerRecord } from '../agentWalletApprovalReceiver/types'

export type ExecutionNetwork = 'xec:mainnet'

export interface ExecutionUtxoInput {
  readonly txid: string
  readonly outIdx: number
  readonly sats: bigint
  readonly lockingScriptHex: string
}

export interface ExecutionTxOutput {
  readonly index: number
  readonly destination: string
  readonly scriptHex: string
  readonly sats: bigint
  readonly isChange: boolean
}

/**
 * Immutable audit plan for transaction execution.
 * Frozen deeply before final human execution review begins.
 */
export interface WalletPreparedExecutionPlan {
  readonly network: ExecutionNetwork
  readonly fromAddress: string
  readonly destination: string
  readonly paymentAmountSats: bigint
  readonly changeAmountSats: bigint
  readonly changeAddress: string
  readonly feeSats: bigint
  readonly feeRateSatsPerByte: number
  readonly inputs: readonly ExecutionUtxoInput[]
  readonly outputs: readonly ExecutionTxOutput[]
  readonly totalInputSats: bigint
  readonly transactionVersion: number
  readonly locktime: number
  readonly planHash: string
  readonly approvalId: string
  readonly requestId: string
  readonly intentId: string
}

/**
 * Human-readable execution review snapshot presented before signing.
 * Fee is strictly separated from the payment amount.
 */
export interface WalletExecutionReviewSnapshot {
  readonly recipient: string
  readonly amountXEC: string
  readonly amountSats: string
  readonly feeXEC: string
  readonly feeSats: string
  readonly totalDebitXEC: string
  readonly totalDebitSats: string
  readonly fundingAddress: string
  readonly network: ExecutionNetwork
  readonly approvalId: string
  readonly requestId: string
  readonly intentId: string
  readonly planHash: string
}

/**
 * Strict fee security policy enforcing deterministic, bounded fees.
 */
export interface WalletFeePolicy {
  readonly minFeeRateSatsPerByte: number
  readonly maxFeeRateSatsPerByte: number
  readonly maxAbsoluteFeeSats: bigint
  readonly targetFeeRateSatsPerByte: number
}

export type WalletExecutionState =
  | 'APPROVED'
  | 'EXECUTION_RESERVED'
  | 'PREPARED'
  | 'SIGNING'
  | 'SIGNED'
  | 'SIGNING_UNCERTAIN'
  | 'REJECTED'
  | 'EXPIRED'
  | 'FAILED'

/**
 * Public execution status visible to external/agent callers.
 * Raw signed transaction hex and private internal details are strictly omitted.
 */
export interface PublicExecutionStatus {
  readonly executionId: string
  readonly approvalId: string
  readonly requestId: string
  readonly intentId: string
  readonly decisionId: string
  readonly fromAddress: string
  readonly destination: string
  readonly amountSats: bigint
  readonly network: ExecutionNetwork
  readonly status: WalletExecutionState
  readonly planHash?: string
  readonly uncertainReason?: string
  readonly reservedAt: number
  readonly preparedAt?: number
  readonly signingAt?: number
  readonly signedAt?: number
  readonly failedAt?: number
}

/**
 * Internal durable execution record maintained in WalletExecutionLedger.
 * Production public ledger state omits raw signed transaction bytes.
 * C2 does not expose a retrieval API for raw signed transactions.
 */
export interface InternalWalletExecutionRecord {
  readonly executionId: string
  readonly approvalId: string
  readonly requestId: string
  readonly intentId: string
  readonly decisionId: string
  readonly fromAddress: string
  readonly destination: string
  readonly amountSats: bigint
  readonly network: ExecutionNetwork
  readonly plan?: WalletPreparedExecutionPlan
  readonly planHash?: string
  readonly state: WalletExecutionState
  readonly uncertainReason?: string
  readonly reservedAt: number
  readonly preparedAt?: number
  readonly signingAt?: number
  readonly signedAt?: number
  readonly failedAt?: number
  readonly reservedOutpoints?: readonly string[]
  readonly reviewOwnerId?: string
  readonly reviewLeaseExpiresAt?: number
  readonly reviewLeaseGeneration?: number
}

/**
 * Opaque execution handle returned to callers upon successful offline signing.
 * Strictly does NOT expose raw signed transaction bytes or private keys.
 */
export interface SignedExecutionHandle {
  readonly executionId: string
  readonly approvalId: string
  readonly requestId: string
  readonly status: 'SIGNED'
  readonly planHash: string
  readonly signedAt: number
}

/**
 * Review-only execution session provided to Agent-facing caller.
 * Strictly does NOT provide a signing or confirmation method.
 */
export interface WalletExecutionReviewSession {
  readonly executionId: string
  readonly plan: Readonly<WalletPreparedExecutionPlan>
  readonly review: Readonly<WalletExecutionReviewSnapshot>
  rejectExecution(reason?: string): Promise<void>
  dismiss(): Promise<void>
}

/**
 * Read-only UTXO provider port. Read access is permitted; broadcast is NOT.
 */
export interface WalletUtxoProvider {
  getSpendableUtxos(address: string): Promise<readonly ExecutionUtxoInput[]>
}

/**
 * Wallet-owned signing provider port.
 * Signs TxBuilder within Wallet boundary without exposing raw private keys.
 */
export interface WalletSignatoryProvider {
  getSignatory(address: string): Promise<any> | any
}

/**
 * Session verifier enforcing that the active custodian session matches the approved fromAddress.
 */
export interface WalletSessionVerifier {
  verifyActiveSession(): Promise<{ authenticated: boolean; activeAddress?: string; error?: string }>
}

/**
 * Public execution ledger port for tracking execution state across lifecycle transitions.
 * Strictly does NOT expose raw signed transaction bytes or private keys.
 */
export interface ExecutionReviewLease {
  readonly ownerId: string
  readonly leaseExpiresAt: number
  readonly generation: number
}

export interface WalletExecutionLedger {
  reserveExecutionAtomic(entry: {
    executionId: string
    approvalId: string
    requestId: string
    intentId: string
    decisionId: string
    fromAddress: string
    destination: string
    amountSats: bigint
    network: ExecutionNetwork
    reservedAt: number
  }): Promise<void>

  whenReady(): Promise<void>

  runWithSigningLock<T>(executionId: string, operation: () => Promise<T>): Promise<T>

  runWithReviewLock<T>(executionId: string, operation: () => Promise<T>): Promise<T>

  setPlanPrepared(
    executionId: string,
    plan: WalletPreparedExecutionPlan,
    preparedAt: number,
    reviewLease: ExecutionReviewLease
  ): Promise<void>

  renewReviewLease(params: {
    readonly executionId: string
    readonly ownerId: string
    readonly generation: number
    readonly now: number
    readonly leaseTtlSeconds: number
  }): Promise<ExecutionReviewLease>

  transitionToSigningIfValid(params: {
    readonly executionId: string
    readonly plan: WalletPreparedExecutionPlan
    readonly effectiveExpiresAt: number
    readonly now: () => number
  }): Promise<void>

  transitionToSigned(executionId: string, signedAt: number): Promise<void>

  markSigningUncertain(
    executionId: string,
    reason: string,
    timestamp: number
  ): Promise<void>

  markFailed(executionId: string, reason: string, timestamp: number): Promise<void>

  markRejected(executionId: string, reason: string, timestamp: number): Promise<void>

  markExpired(executionId: string, reason: string, timestamp: number): Promise<void>

  get(executionId: string): Promise<PublicExecutionStatus | undefined>

  getByApprovalId(approvalId: string): Promise<PublicExecutionStatus | undefined>

  getByRequestId(requestId: string): Promise<PublicExecutionStatus | undefined>

  has(approvalId: string): Promise<boolean>
}

/**
 * Engine configuration for Wallet-owned prepared transaction construction and signing.
 */
export interface AgentWalletExecutionEngineConfig {
  readonly approvalLedger: {
    get(requestId: string): Promise<WalletApprovalLedgerRecord | undefined>
    getByApprovalId?(approvalId: string): Promise<WalletApprovalLedgerRecord | undefined>
  }
  readonly executionLedger?: WalletExecutionLedger
  readonly sessionVerifier: WalletSessionVerifier
  readonly utxoProvider: WalletUtxoProvider
  readonly signatoryProvider: WalletSignatoryProvider
  readonly feePolicy?: Partial<WalletFeePolicy>
  /**
   * Public execution-ledger persistence only. NEVER used for raw signed transactions.
   * Settlement persistence is Wallet-private and is not part of this Agent-facing config.
   */
  readonly storage?: Storage
  readonly lockCoordinator?: {
    requestExclusive<T>(lockName: string, operation: () => Promise<T>): Promise<T>
    tryExclusive<T>(
      lockName: string,
      operation: () => Promise<T>
    ): Promise<{ acquired: false } | { acquired: true; result: T }>
  }
  readonly clock?: () => number
  readonly idGenerator?: () => string
}

/**
 * Trusted Wallet-only composition options. NEVER part of Agent-facing config.
 * Must not be exported from the public agentWalletExecution barrel.
 */
export interface WalletExecutionTrustedOptions {
  readonly privateSettlementStorage?: Storage
  readonly reviewLeaseTtlSeconds?: number
  readonly reviewHeartbeatMs?: number
}

/**
 * Canonical Agent Wallet Execution Engine (Public / Agent-facing API).
 * Strictly contains NO signing, confirm, execute, or local controller creation methods.
 * Possession of this interface alone cannot invoke signing.
 */
export interface AgentWalletExecutionEngine {
  prepareExecution(receipt: HumanApprovalV1): Promise<WalletExecutionReviewSession>
  getExecutionStatus(executionId: string): Promise<PublicExecutionStatus | undefined>
}
