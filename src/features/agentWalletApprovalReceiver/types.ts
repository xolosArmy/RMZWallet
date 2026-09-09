/**
 * @file types.ts
 *
 * Public and internal type definitions for the hardened Wallet Approval Receiver (Gate 2B).
 *
 * Mandatory Lifecycle:
 * idle -> receiving -> validating -> preparing -> reviewReady -> approvalRequested ->
 * revalidating -> approvalRecording -> approvalRecorded -> STOP
 */

import type { HumanApprovalV1 } from '@xolosarmy/tonalli-core'
import type { UniversalAuthorizationEnvelopeV1 } from '../externalSign/contract'
import type { UniversalContentHash } from '../externalSign/contentHash'

export type ApprovalReceiverLifecycleState =
  | 'idle'
  | 'receiving'
  | 'validating'
  | 'preparing'
  | 'reviewReady'
  | 'approvalRequested'
  | 'revalidating'
  | 'approvalRecording'
  | 'approvalRecorded'
  | 'STOP'

/**
 * Immutable projection formatted specifically for Wallet human review UI.
 */
export interface WalletApprovalPresentation {
  readonly requestId: string
  readonly intentId: string
  readonly decisionId: string
  readonly agentId: string
  readonly agentRole: string
  readonly amountSats: string
  readonly amountXEC: string
  readonly fromAddress: string
  readonly destination: string
  readonly reason: string
  readonly memo?: string
  readonly network: 'xec:mainnet'
  readonly policyTraceId: string
  readonly policyReasonCode: string
  readonly policyVersion: string
  readonly requestedAtIso: string
  readonly effectiveExpiresAtIso: string
  readonly effectiveExpiresAt: number
}

/**
 * Public result returned to Wallet UI after successful preparation.
 * Note: Only an opaque handle and the immutable presentation are exposed.
 * Internal bytes, envelopes, bindings and capabilities are strictly guarded.
 */
export interface WalletApprovalReviewState {
  readonly handle: string
  readonly presentation: WalletApprovalPresentation
}

/**
 * Result of verifying an authentic, Wallet-owned human session.
 */
export interface WalletHumanSessionVerificationResult {
  readonly authenticated: boolean
  readonly activeAddress: string
  readonly authenticatedAlias?: string
  readonly sessionToken: string
}

/**
 * Interface for verifying Wallet-owned authenticated human sessions.
 * Caller cannot pass arbitrary strings; session must be verified against
 * authentic Wallet runtime state.
 */
export interface WalletHumanSessionVerifier {
  verifySession(sessionToken: string): Promise<WalletHumanSessionVerificationResult>
}

/**
 * Human action submitted from Wallet UI referencing an opaque review handle.
 */
export interface WalletHumanAction {
  readonly decision: 'approved' | 'rejected'
  readonly sessionToken: string
  readonly reason?: string
}

/**
 * Internal binding maintained exclusively inside the receiver module.
 * Never returned to callers, agents, or public UI.
 */
export interface InternalApprovalBinding {
  readonly operationId: string
  readonly requestId: string
  readonly intentId: string
  readonly decisionId: string
  readonly contentHash: UniversalContentHash
  readonly envelope: UniversalAuthorizationEnvelopeV1
  readonly canonicalBytes: Uint8Array
  readonly network: 'xec:mainnet'
  readonly amountSats: string
  readonly destination: string
  readonly effectiveExpiresAt: number
  readonly presentationSnapshot: WalletApprovalPresentation
}

/**
 * Immutable atomic record for Wallet local approval ledger.
 */
export interface WalletApprovalLedgerRecord {
  readonly operationId: string
  readonly requestId: string
  readonly approvalId: string
  readonly capabilityId: string
  readonly humanApproval: HumanApprovalV1
  readonly contentHash: string
  readonly recordedAt: number
  readonly status: 'approvalRecorded'
}

/**
 * Interface for the Wallet-local approval ledger.
 * Production environments MUST inject a durable, transactional implementation.
 */
export interface WalletApprovalLedger {
  recordApprovalAtomic(record: WalletApprovalLedgerRecord): Promise<void>
  has(requestId: string): Promise<boolean>
  get(requestId: string): Promise<WalletApprovalLedgerRecord | undefined>
}

export type WalletApprovalReceiverErrorCode =
  | 'INVALID_REQUEST_SCHEMA'
  | 'INVALID_CONTRACT_VERSION'
  | 'INVALID_KIND'
  | 'INVALID_PURPOSE'
  | 'POLICY_NOT_NEEDS_HUMAN_APPROVAL'
  | 'INTENT_ID_MISMATCH'
  | 'EMPTY_POLICY_TRACE'
  | 'UNSUPPORTED_NETWORK'
  | 'EXPIRED_REQUEST'
  | 'REQUEST_NOT_YET_VALID'
  | 'INVALID_ENVELOPE'
  | 'INVALID_CONTENT_HASH'
  | 'UNKNOWN_REVIEW_HANDLE'
  | 'INVALID_LIFECYCLE_STATE'
  | 'INVALID_HUMAN_SESSION'
  | 'MISSING_HUMAN_APPROVER'
  | 'TOCTOU_VALIDATION_FAILED'
  | 'CAPABILITY_NOT_FRESH'
  | 'CAPABILITY_EXPIRED'
  | 'MISSING_LEDGER_DEPENDENCY'
  | 'MISSING_SESSION_VERIFIER'
  | 'DUPLICATE_APPROVAL_RECORD'
  | 'ATOMIC_RECORDING_FAILED'
  | 'OPERATION_ABORTED'
  | 'INVALID_HUMAN_ACTION'

export class WalletApprovalReceiverError extends Error {
  readonly code: WalletApprovalReceiverErrorCode
  readonly details?: unknown

  constructor(
    code: WalletApprovalReceiverErrorCode,
    message: string,
    details?: unknown
  ) {
    super(`[WalletApprovalReceiver] ${code}: ${message}`)
    this.name = 'WalletApprovalReceiverError'
    this.code = code
    this.details = details
  }
}

export interface PrepareApprovalReviewOptions {
  readonly nowEpochSeconds?: () => number
  readonly signal?: AbortSignal
}

export interface RecordHumanDecisionOptions {
  readonly ledger: WalletApprovalLedger
  readonly sessionVerifier: WalletHumanSessionVerifier
  readonly nowEpochSeconds?: () => number
  readonly idGenerator?: () => string
  readonly signal?: AbortSignal
}
