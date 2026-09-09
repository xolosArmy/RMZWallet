/**
 * @file types.ts
 *
 * Types and Error definitions for the Wallet-owned approval receiver (Gate 2B).
 */

import type { X402ApprovalContextV1 } from '@xolosarmy/tonalli-core'

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

export interface HumanDecisionInput {
  decision: 'approved' | 'rejected'
  approver?: string
  reason?: string
}

export interface WalletApprovalPresentation {
  requestId: string
  intentId: string
  decisionId: string
  agentId: string
  agentRole: string
  fromAddress: string
  destination: string
  amountSats: string
  amountXEC: string
  reason: string
  memo?: string
  network: 'xec:mainnet'
  policyTraceId: string
  policyReasonCode: string
  policyVersion: string
  requestedAt: number
  expiresAt: number
  requestedAtIso: string
  expiresAtIso: string
  x402Context?: X402ApprovalContextV1
}
