/**
 * @file types.ts
 *
 * Types and Error definitions for the Wallet-owned approval receiver (Gate 2B).
 *
 * Hardened Topology:
 * ingress → canonical decode → fresh revalidation → presentation snapshot →
 * ApprovalRecordCapability → human action → atomic approval recording → approvalRecorded
 */

import type { HumanApprovalV1, X402ApprovalContextV1 } from '@xolosarmy/tonalli-core'
import type { UniversalContentHash } from '../externalSign/contentHash'

export type WalletApprovalReceiverErrorCode =
  | 'INVALID_REQUEST_SCHEMA'
  | 'INVALID_CONTRACT_VERSION'
  | 'INVALID_KIND'
  | 'INVALID_PURPOSE'
  | 'NETWORK_NOT_SUPPORTED'
  | 'POLICY_DECISION_MISMATCH'
  | 'POLICY_DECISION_NOT_HUMAN_APPROVAL'
  | 'EMPTY_POLICY_TRACE'
  | 'EXPIRED_REQUEST'
  | 'REQUEST_NOT_YET_VALID'
  | 'INVALID_HUMAN_ACTION'
  | 'MISSING_HUMAN_APPROVER'
  | 'INVALID_HUMAN_SESSION'
  | 'CAPABILITY_NOT_FRESH'
  | 'CAPABILITY_INVALIDATED'
  | 'INVALID_CAPABILITY_SOURCE'
  | 'ATOMIC_RECORDING_FAILED'
  | 'DUPLICATE_APPROVAL_RECORD'
  | 'OPERATION_ABORTED'

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

/**
 * Proof of human interaction originating from a genuine Wallet-owned surface.
 * Rejects programmatic spoofing or arbitrary strings in approver.
 */
export interface WalletHumanSessionAssertion {
  readonly sessionOrigin: 'wallet_local_ui'
  readonly localSessionToken: string
  readonly activeAddress: string
  readonly authenticatedAlias?: string
}

export interface WalletHumanAction {
  readonly decision: 'approved' | 'rejected'
  readonly session: WalletHumanSessionAssertion
  readonly reason?: string
}

/**
 * Immutable canonical presentation snapshot presented to the human approver.
 */
export interface WalletApprovalPresentation {
  readonly requestId: string
  readonly intentId: string
  readonly decisionId: string
  readonly agentId: string
  readonly agentRole: string
  readonly fromAddress: string
  readonly destination: string
  readonly amountSats: string
  readonly amountXEC: string
  readonly reason: string
  readonly memo?: string
  readonly network: 'xec:mainnet'
  readonly policyTraceId: string
  readonly policyReasonCode: string
  readonly policyVersion: string
  readonly requestedAt: number
  readonly expiresAt: number
  readonly effectiveExpiresAt: number
  readonly requestedAtIso: string
  readonly expiresAtIso: string
  readonly effectiveExpiresAtIso: string
  readonly x402Context?: X402ApprovalContextV1
}

/**
 * Normative Wallet-local cryptographic and domain binding for the approval request.
 */
export interface WalletLocalApprovalBinding {
  readonly operationId: string // = requestId
  readonly requestId: string
  readonly intentId: string
  readonly decisionId: string
  readonly contentHash: UniversalContentHash
  readonly network: 'xec:mainnet'
  readonly amountSats: string
  readonly destination: string
  readonly effectiveExpiresAt: number
  readonly bindingCreatedAt: number
}

export type ApprovalCapabilityState = 'fresh' | 'recording' | 'recorded' | 'invalidated'

/**
 * Complete record committed atomically to the Wallet-local approval ledger.
 */
export interface WalletApprovalLedgerRecord {
  readonly operationId: string
  readonly requestId: string
  readonly approvalId: string
  readonly humanApproval: HumanApprovalV1
  readonly binding: WalletLocalApprovalBinding
  readonly recordedAt: number
  readonly status: 'approvalRecorded'
}

/**
 * In-memory Wallet-local ledger port for atomic approval recording.
 */
export interface WalletApprovalLedger {
  recordApprovalAtomic(record: WalletApprovalLedgerRecord): Promise<void>
  has(requestId: string): Promise<boolean>
  get(requestId: string): Promise<WalletApprovalLedgerRecord | undefined>
}
