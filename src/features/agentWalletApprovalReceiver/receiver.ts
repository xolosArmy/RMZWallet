/**
 * @file receiver.ts
 *
 * WALLET-OWNED APPROVAL RECEIVER & HUMAN DECISION RECORDER (Gate 2B)
 *
 * Authority Boundary:
 * - RMZWallet receives either raw canonical handoff bytes (Uint8Array) or WalletApprovalRequestV1.
 * - Wallet revalidates the entire envelope against tonalli-core schemas, temporal bounds,
 *   network constraints, and policy trace integrity.
 * - Wallet presents the audit details to the human approver via a Wallet-owned surface.
 * - Wallet collects explicit human action ('approved' or 'rejected').
 * - Wallet constructs and issues the canonical HumanApprovalV1 artifact.
 * - Wallet returns ONLY HumanApprovalV1 to the caller.
 * - Zero transaction construction, zero key access, zero signing, and zero broadcast occur during this gate.
 *
 * Network Domain Status:
 * BLOCKED_BY_CORE_NETWORK_DOMAIN
 * In tonalli-core v1.0, agentIntentV1Schema and x402ApprovalContextV1Schema constrain `network`
 * exclusively to `z.literal("xec:mainnet")`. All testing is executed under schema-only simulation
 * with zero signing and zero broadcast.
 */

import {
  AGENTIC_CONTRACT_VERSION,
  humanApprovalV1Schema,
  parseWalletApprovalRequestV1,
  type HumanApprovalV1,
  type WalletApprovalRequestV1
} from '@xolosarmy/tonalli-core'
import { decodeAgentWalletHandoffV1 } from '../agentWalletHandoff'
import {
  WalletApprovalReceiverError,
  type HumanDecisionInput,
  type WalletApprovalPresentation
} from './types'

export interface ValidateOptions {
  nowEpochSeconds?: () => number
}

export interface RecordOptions {
  nowEpochSeconds?: () => number
  idGenerator?: () => string
}

/**
 * Validates an inbound approval request and formats it for human presentation in RMZWallet.
 */
export function validateAndPresentApprovalRequest(
  input: WalletApprovalRequestV1 | Uint8Array,
  options?: ValidateOptions
): { request: WalletApprovalRequestV1; presentation: WalletApprovalPresentation } {
  let rawRequest: unknown = input

  if (input instanceof Uint8Array) {
    try {
      rawRequest = decodeAgentWalletHandoffV1(input)
    } catch (err) {
      throw new WalletApprovalReceiverError(
        'INVALID_REQUEST_SCHEMA',
        'Failed to decode agent wallet handoff byte payload',
        err
      )
    }
  }

  let request: WalletApprovalRequestV1
  try {
    request = parseWalletApprovalRequestV1(rawRequest)
  } catch (err) {
    throw new WalletApprovalReceiverError(
      'INVALID_REQUEST_SCHEMA',
      'Payload does not satisfy canonical WalletApprovalRequestV1 schema',
      err
    )
  }

  if (request.contractVersion !== AGENTIC_CONTRACT_VERSION) {
    throw new WalletApprovalReceiverError(
      'INVALID_CONTRACT_VERSION',
      `Expected contractVersion ${AGENTIC_CONTRACT_VERSION}, got ${request.contractVersion}`
    )
  }

  if (request.kind !== 'wallet_approval_request') {
    throw new WalletApprovalReceiverError(
      'INVALID_KIND',
      `Expected kind wallet_approval_request, got ${request.kind}`
    )
  }

  if (request.purpose !== 'xec_payment') {
    throw new WalletApprovalReceiverError(
      'INVALID_PURPOSE',
      `Expected purpose xec_payment, got ${request.purpose}`
    )
  }

  if (request.intent.network !== 'xec:mainnet') {
    throw new WalletApprovalReceiverError(
      'NETWORK_NOT_SUPPORTED',
      `Network ${request.intent.network} is not supported by tonalli-core v1.0`
    )
  }

  if (request.policyDecision.decision !== 'needs_human_approval') {
    throw new WalletApprovalReceiverError(
      'POLICY_DECISION_NOT_HUMAN_APPROVAL',
      `Approval receiver requires decision needs_human_approval, got ${request.policyDecision.decision}`
    )
  }

  if (request.policyDecision.intentId !== request.intent.intentId) {
    throw new WalletApprovalReceiverError(
      'POLICY_DECISION_MISMATCH',
      `Policy decision intentId (${request.policyDecision.intentId}) does not match intent (${request.intent.intentId})`
    )
  }

  if (!request.policyDecision.policyTraceId || request.policyDecision.policyTraceId.trim() === '') {
    throw new WalletApprovalReceiverError(
      'EMPTY_POLICY_TRACE',
      'Policy trace ID cannot be empty or blank'
    )
  }

  const getNow = options?.nowEpochSeconds ?? (() => Math.floor(Date.now() / 1000))
  const now = getNow()

  if (request.requestedAt > now + 60) {
    throw new WalletApprovalReceiverError(
      'REQUEST_NOT_YET_VALID',
      `Request requestedAt (${request.requestedAt}) is in the future compared to current time (${now})`
    )
  }

  if (request.expiresAt <= now) {
    throw new WalletApprovalReceiverError(
      'EXPIRED_REQUEST',
      `Approval request expired at ${request.expiresAt}, current time is ${now}`
    )
  }

  if (request.intent.expiresAt <= now) {
    throw new WalletApprovalReceiverError(
      'EXPIRED_REQUEST',
      `Intent expired at ${request.intent.expiresAt}, current time is ${now}`
    )
  }

  if (request.policyDecision.expiresAt <= now) {
    throw new WalletApprovalReceiverError(
      'EXPIRED_REQUEST',
      `Policy decision expired at ${request.policyDecision.expiresAt}, current time is ${now}`
    )
  }

  const satsBig = BigInt(request.intent.amountSats)
  const xecValue = (Number(satsBig) / 100).toFixed(2)

  const presentation: WalletApprovalPresentation = {
    requestId: request.requestId,
    intentId: request.intent.intentId,
    decisionId: request.policyDecision.decisionId,
    agentId: request.intent.agentId,
    agentRole: request.intent.agentRole,
    fromAddress: request.intent.fromAddress,
    destination: request.intent.toAddress,
    amountSats: request.intent.amountSats,
    amountXEC: `${xecValue} XEC`,
    reason: request.intent.reason,
    memo: request.intent.memo,
    network: request.intent.network,
    policyTraceId: request.policyDecision.policyTraceId,
    policyReasonCode: request.policyDecision.reasonCode,
    policyVersion: request.policyDecision.policyVersion,
    requestedAt: request.requestedAt,
    expiresAt: request.expiresAt,
    requestedAtIso: new Date(request.requestedAt * 1000).toISOString(),
    expiresAtIso: new Date(request.expiresAt * 1000).toISOString(),
    x402Context: request.x402
      ? {
          x402Version: request.x402.x402Version,
          scheme: request.x402.scheme,
          network: request.x402.network,
          invoiceHash: request.x402.invoiceHash,
          resourceHash: request.x402.resourceHash,
          amountSats: request.x402.amountSats,
          payTo: request.x402.payTo,
          nonce: request.x402.nonce,
          issuedAt: request.x402.issuedAt,
          expiresAt: request.x402.expiresAt
        }
      : undefined
  }

  return { request, presentation }
}

/**
 * Records explicit human decision collected via a Wallet-owned user surface
 * and creates a canonical HumanApprovalV1 artifact.
 */
export function recordWalletHumanDecision(
  request: WalletApprovalRequestV1,
  action: HumanDecisionInput,
  options?: RecordOptions
): HumanApprovalV1 {
  if (!action || typeof action !== 'object') {
    throw new WalletApprovalReceiverError(
      'INVALID_HUMAN_ACTION',
      'Explicit human decision object is required'
    )
  }

  if (action.decision !== 'approved' && action.decision !== 'rejected') {
    const decisionValue = (action as unknown as Record<string, unknown>).decision
    throw new WalletApprovalReceiverError(
      'INVALID_HUMAN_ACTION',
      `Expected decision 'approved' or 'rejected', got '${String(decisionValue)}'`
    )
  }

  if (action.decision === 'approved') {
    if (!action.approver || action.approver.trim() === '') {
      throw new WalletApprovalReceiverError(
        'MISSING_HUMAN_APPROVER',
        'Approved decision requires a valid human approver identity'
      )
    }
  }

  const getNow = options?.nowEpochSeconds ?? (() => Math.floor(Date.now() / 1000))
  const recordedAt = getNow()

  if (recordedAt >= request.expiresAt) {
    throw new WalletApprovalReceiverError(
      'EXPIRED_REQUEST',
      `Cannot record human decision: request expired at ${request.expiresAt}, current time is ${recordedAt}`
    )
  }

  const generateId =
    options?.idGenerator ??
    (() => {
      if (typeof crypto !== 'undefined' && crypto.randomUUID) {
        return `human-approval-${crypto.randomUUID()}`
      }
      return `human-approval-${Date.now()}-${Math.floor(Math.random() * 1e9)}`
    })

  const approvalPayload = {
    contractVersion: AGENTIC_CONTRACT_VERSION,
    kind: 'human_approval' as const,
    approvalId: generateId(),
    requestId: request.requestId,
    intentId: request.intent.intentId,
    decisionId: request.policyDecision.decisionId,
    status: action.decision,
    approver: action.decision === 'approved' ? action.approver : undefined,
    reason: action.reason,
    recordedAt
  }

  return humanApprovalV1Schema.parse(approvalPayload)
}
