/**
 * @file types.ts
 *
 * Public type definitions for the hardened Wallet Approval Receiver (Gate 2B).
 *
 * Architecture:
 * - Built once via trusted Wallet bootstrap: createAgentWalletApprovalReceiver(deps).
 * - UI only interacts with opaque handles and immutable presentations.
 * - Human session verification is internal and Wallet-owned (enforcing activeAddress === fromAddress).
 * - Atomic ledger records both approvals and rejections with 3-way uniqueness.
 *
 * Mandatory Lifecycle:
 * idle -> receiving -> validating -> preparing -> reviewReady -> approvalRequested ->
 * revalidating -> approvalRecording -> approvalRecorded -> STOP
 */

import type { HumanApprovalV1 } from '@xolosarmy/tonalli-core'
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
 * Immutable presentation snapshot formatted specifically for Wallet human review UI.
 * Covers the entire request and policy domain to prevent TOCTOU substitution.
 */
export interface WalletApprovalPresentation {
  readonly requestId: string
  readonly purpose: string
  readonly decision: 'needs_human_approval'
  readonly signingStatus: 'not authorized'
  readonly broadcastStatus: 'not attempted'
  readonly intentId: string
  readonly decisionId: string
  readonly amountSats: string
  readonly amountXEC: string
  readonly fromAddress: string
  readonly destination: string
  readonly network: 'xec:mainnet' | 'xec:regtest'
  readonly agentId: string
  readonly agentRole: string
  readonly reason: string
  readonly memo?: string
  readonly policyTraceId: string
  readonly policyReasonCode: string
  readonly policyVersion: string
  readonly policyReason: string
  readonly requestedAt: number
  readonly requestedAtIso: string
  readonly effectiveExpiresAt: number
  readonly effectiveExpiresAtIso: string
  readonly presentationHash: string
}

/**
 * Public review state returned to Wallet UI after successful preparation.
 * Exposes strictly an opaque handle and the immutable presentation snapshot.
 */
export interface WalletApprovalReviewState {
  readonly handle: string
  readonly presentation: WalletApprovalPresentation
}

/**
 * Result of resolving the active authenticated custodian session in RMZWallet.
 */
export interface WalletHumanSessionVerificationResult {
  readonly authenticated: boolean
  readonly activeAddress?: string
  readonly approverId?: string
  readonly error?: string
}

/**
 * Interface for verifying Wallet-owned authenticated human sessions.
 * Implemented by Wallet bootstrap and injected once into the receiver factory.
 * Resolves active session from internal wallet state; caller cannot supply arbitrary tokens.
 */
export interface WalletHumanSessionVerifier {
  verifyActiveSession(): Promise<WalletHumanSessionVerificationResult>
}

/**
 * Immutable atomic record for the Wallet-local approval ledger.
 * Preserves operation, request, intent, decision IDs, content hash, capability ID,
 * effective expiry, network, amount, destination, presentation hash, and HumanApprovalV1.
 */
export interface WalletApprovalLedgerRecord {
  readonly operationId: string
  readonly requestId: string
  readonly approvalId: string
  readonly intentId: string
  readonly decisionId: string
  readonly contentHash: UniversalContentHash
  readonly capabilityId: string
  readonly effectiveExpiresAt: number
  readonly network: string
  readonly amountSats: string
  readonly fromAddress: string
  readonly destination: string
  readonly presentationHash: string
  readonly humanApproval: HumanApprovalV1
  readonly recordedAt: number
  readonly status: 'approved' | 'rejected'
}

/**
 * Interface for the Wallet-local approval ledger.
 * Production environments MUST inject a durable, transactional implementation.
 * In-memory implementation is strictly permitted in unit/integration tests.
 */
export interface WalletApprovalLedger {
  recordApprovalAtomic(record: WalletApprovalLedgerRecord): Promise<void>
  has(requestId: string): Promise<boolean>
  get(requestId: string): Promise<WalletApprovalLedgerRecord | undefined>
}

/**
 * Dependencies injected once during trusted Wallet bootstrap.
 */
export interface AgentWalletApprovalReceiverDependencies {
  readonly ledger: WalletApprovalLedger
  readonly sessionVerifier: WalletHumanSessionVerifier
  readonly clock?: () => number
  readonly idGenerator?: () => string
  readonly declaredOrigin?: string
}

/**
 * Hardened Wallet-owned receiver instance used by UI and transport adapters.
 * Note: prepareRequest is NOT on this production interface; handoffs arrive as binary.
 */
export interface AgentWalletApprovalReceiver {
  prepareHandoff(rawHandoffBytes: Uint8Array): Promise<WalletApprovalReviewState>
  approveHandle(handle: string, options?: { reason?: string }): Promise<HumanApprovalV1>
  rejectHandle(handle: string, options?: { reason?: string }): Promise<HumanApprovalV1>
  getPresentation(handle: string): WalletApprovalPresentation | undefined
  dismissHandle(handle: string): void
}

/**
 * Extended interface for testing purposes that exposes prepareRequest.
 */
export interface AgentWalletApprovalReceiverForTest extends AgentWalletApprovalReceiver {
  prepareRequest(requestInput: unknown): Promise<WalletApprovalReviewState>
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
  | 'SESSION_ADDRESS_MISMATCH'
  | 'MISSING_HUMAN_APPROVER'
  | 'TOCTOU_VALIDATION_FAILED'
  | 'CAPABILITY_NOT_FRESH'
  | 'CAPABILITY_EXPIRED'
  | 'MISSING_LEDGER_DEPENDENCY'
  | 'MISSING_SESSION_VERIFIER'
  | 'MISSING_ID_GENERATOR'
  | 'DUPLICATE_APPROVAL_RECORD'
  | 'ATOMIC_RECORDING_FAILED'
  | 'OPERATION_ABORTED'
  | 'INVALID_HUMAN_ACTION'
  | 'INVALID_INPUT'
  | 'INVALID_DECLARED_ORIGIN'
  | 'INVALID_HUMAN_APPROVAL_SCHEMA'

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
