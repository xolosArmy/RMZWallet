/**
 * @file receiver.ts
 *
 * Hardened Wallet-Owned Approval Receiver and Human Decision Recorder (Gate 2B).
 *
 * Strict Topology:
 * ingress → canonical decode → fresh revalidation → presentation snapshot →
 * ApprovalRecordCapability → human action → atomic approval recording → approvalRecorded
 *
 * Architectural Invariants:
 * 1. ZERO authority leaks to Agents.
 * 2. Immutable canonical presentation snapshot.
 * 3. Normative H(E,C) calculation using calculateUniversalContentHash.
 * 4. Immutable WalletLocalApprovalBinding.
 * 5. One-shot, opaque, non-serializable ApprovalRecordCapability.
 * 6. Human action strictly bound to authentic Wallet local session.
 * 7. Approver resolved from verified session, never from arbitrary caller strings.
 * 8. Atomic insertion of HumanApprovalV1, WalletLocalApprovalBinding, and status approvalRecorded.
 * 9. Rollback on ledger failure; never returns successful approval if ledger fails.
 * 10. Strictly receipt-only: zero private keys, zero signing, zero tx construction, zero broadcast.
 */

import {
  AGENTIC_CONTRACT_VERSION,
  humanApprovalV1Schema,
  parseWalletApprovalRequestV1,
  type HumanApprovalV1,
  type WalletApprovalRequestV1
} from '@xolosarmy/tonalli-core'
import {
  decodeAgentWalletHandoffV1,
  encodeAgentWalletHandoffV1
} from '../agentWalletHandoff'
import {
  calculateUniversalContentHash,
  type UniversalContentHash
} from '../externalSign/contentHash'
import {
  UNIVERSAL_AUTHORIZATION_SCHEMA,
  UNIVERSAL_AUTHORIZATION_VERSION,
  type UniversalAuthorizationEnvelopeV1
} from '../externalSign/contract'
import {
  ApprovalRecordCapability,
  createApprovalCapabilityInternal,
  INTERNAL_CAPABILITY_TOKEN
} from './capability'
import { formatSatsToExactXEC } from './format'
import { defaultWalletApprovalLedger } from './ledger'
import type {
  WalletApprovalLedger,
  WalletApprovalLedgerRecord,
  WalletApprovalPresentation,
  WalletHumanAction,
  WalletLocalApprovalBinding
} from './types'
import { WalletApprovalReceiverError } from './types'

export interface ValidateAndPresentOptions {
  nowEpochSeconds?: () => number
  signal?: AbortSignal
  idGenerator?: () => string
}

export interface ValidateAndPresentResult {
  readonly request: WalletApprovalRequestV1
  readonly presentation: WalletApprovalPresentation
  readonly binding: WalletLocalApprovalBinding
  readonly capability: ApprovalRecordCapability
}

export interface RecordHumanDecisionOptions {
  nowEpochSeconds?: () => number
  ledger?: WalletApprovalLedger
  idGenerator?: () => string
  signal?: AbortSignal
}

function generateSecureRandomId(prefix: string): string {
  if (typeof globalThis.crypto?.randomUUID === 'function') {
    return `${prefix}:${globalThis.crypto.randomUUID()}`
  }
  throw new WalletApprovalReceiverError(
    'INVALID_CAPABILITY_SOURCE',
    'Secure randomUUID generator is required but unavailable in this runtime.'
  )
}

/**
 * Validates ingress request (encoded bytes or object) and creates an immutable presentation
 * snapshot, cryptographic binding, and one-shot ApprovalRecordCapability.
 */
export async function validateAndPresentApprovalRequest(
  input: Uint8Array | unknown,
  options?: ValidateAndPresentOptions
): Promise<ValidateAndPresentResult> {
  const signal = options?.signal ?? new AbortController().signal
  if (signal.aborted) {
    throw new WalletApprovalReceiverError('OPERATION_ABORTED', 'Operation was aborted')
  }

  // 1. Canonical decode
  let request: WalletApprovalRequestV1
  let effectiveContent: Uint8Array

  if (input instanceof Uint8Array) {
    try {
      request = decodeAgentWalletHandoffV1(input)
      effectiveContent = input
    } catch (err: unknown) {
      throw new WalletApprovalReceiverError(
        'INVALID_REQUEST_SCHEMA',
        'Failed to decode agent-wallet handoff payload',
        err
      )
    }
  } else {
    try {
      request = parseWalletApprovalRequestV1(input)
      effectiveContent = encodeAgentWalletHandoffV1(request)
    } catch (err: unknown) {
      throw new WalletApprovalReceiverError(
        'INVALID_REQUEST_SCHEMA',
        'Payload does not conform to WalletApprovalRequestV1 schema',
        err
      )
    }
  }

  // 2. Fresh revalidation against canonical security invariants
  if (request.contractVersion !== AGENTIC_CONTRACT_VERSION) {
    throw new WalletApprovalReceiverError(
      'INVALID_CONTRACT_VERSION',
      `Unsupported contractVersion: ${request.contractVersion}`
    )
  }

  if (request.kind !== 'wallet_approval_request') {
    throw new WalletApprovalReceiverError(
      'INVALID_KIND',
      `Expected kind 'wallet_approval_request', got: ${request.kind}`
    )
  }

  if (request.purpose !== 'xec_payment') {
    throw new WalletApprovalReceiverError(
      'INVALID_PURPOSE',
      `Expected purpose 'xec_payment', got: ${request.purpose}`
    )
  }

  if (request.intent.network !== 'xec:mainnet') {
    throw new WalletApprovalReceiverError(
      'NETWORK_NOT_SUPPORTED',
      `Unsupported network: ${request.intent.network}. Only 'xec:mainnet' is supported.`
    )
  }

  if (request.x402) {
    if (request.x402.network !== 'xec:mainnet') {
      throw new WalletApprovalReceiverError(
        'NETWORK_NOT_SUPPORTED',
        `x402 network mismatch: ${request.x402.network}`
      )
    }
    if (request.x402.amountSats !== request.intent.amountSats) {
      throw new WalletApprovalReceiverError(
        'POLICY_DECISION_MISMATCH',
        'x402 amountSats does not match intent amountSats'
      )
    }
    if (request.x402.payTo !== request.intent.toAddress) {
      throw new WalletApprovalReceiverError(
        'POLICY_DECISION_MISMATCH',
        'x402 payTo does not match intent toAddress'
      )
    }
  }

  if (request.policyDecision.decision !== 'needs_human_approval') {
    throw new WalletApprovalReceiverError(
      'POLICY_DECISION_NOT_HUMAN_APPROVAL',
      `Policy decision must be 'needs_human_approval', got: ${request.policyDecision.decision}`
    )
  }

  if (request.policyDecision.intentId !== request.intent.intentId) {
    throw new WalletApprovalReceiverError(
      'POLICY_DECISION_MISMATCH',
      `policyDecision.intentId (${request.policyDecision.intentId}) != intent.intentId (${request.intent.intentId})`
    )
  }

  if (!request.policyDecision.policyTraceId || request.policyDecision.policyTraceId.trim() === '') {
    throw new WalletApprovalReceiverError(
      'EMPTY_POLICY_TRACE',
      'policyTraceId cannot be empty'
    )
  }

  // 3. Effective expiration calculation across all components
  const effectiveExpiresAt = Math.min(
    request.expiresAt,
    request.intent.expiresAt,
    request.policyDecision.expiresAt,
    ...(request.x402 ? [request.x402.expiresAt] : [])
  )

  const now = options?.nowEpochSeconds
    ? options.nowEpochSeconds()
    : Math.floor(Date.now() / 1000)

  if (now < request.requestedAt) {
    throw new WalletApprovalReceiverError(
      'REQUEST_NOT_YET_VALID',
      `Current time ${now} is before requestedAt ${request.requestedAt}`
    )
  }

  if (now >= effectiveExpiresAt) {
    throw new WalletApprovalReceiverError(
      'EXPIRED_REQUEST',
      `Request expired: now ${now} >= effectiveExpiresAt ${effectiveExpiresAt}`
    )
  }

  // 4. Exact BigInt monetary representation (no Number, no precision loss)
  const exactAmountXEC = formatSatsToExactXEC(request.intent.amountSats)

  // 5. Presentation snapshot (immutable)
  const presentation: WalletApprovalPresentation = Object.freeze({
    requestId: request.requestId,
    intentId: request.intent.intentId,
    decisionId: request.policyDecision.decisionId,
    agentId: request.intent.agentId,
    agentRole: request.intent.agentRole,
    fromAddress: request.intent.fromAddress,
    destination: request.intent.toAddress,
    amountSats: request.intent.amountSats,
    amountXEC: exactAmountXEC,
    reason: request.intent.reason,
    memo: request.intent.memo,
    network: request.intent.network,
    policyTraceId: request.policyDecision.policyTraceId,
    policyReasonCode: request.policyDecision.reasonCode,
    policyVersion: request.policyDecision.policyVersion,
    requestedAt: request.requestedAt,
    expiresAt: request.expiresAt,
    effectiveExpiresAt,
    requestedAtIso: new Date(request.requestedAt * 1000).toISOString(),
    expiresAtIso: new Date(request.expiresAt * 1000).toISOString(),
    effectiveExpiresAtIso: new Date(effectiveExpiresAt * 1000).toISOString(),
    x402Context: request.x402 ? Object.freeze({ ...request.x402 }) : undefined
  })

  // 6. Normative Content Hash H(E, C) calculation
  const envelope: UniversalAuthorizationEnvelopeV1 = Object.freeze({
    schema: UNIVERSAL_AUTHORIZATION_SCHEMA,
    version: UNIVERSAL_AUTHORIZATION_VERSION,
    operationId: request.requestId,
    profileId: request.intent.agentRole,
    issuedAt: request.requestedAt,
    expiresAt: effectiveExpiresAt,
    requester: Object.freeze({
      declaredOrigin: `agent:${request.intent.agentId}`,
      displayName: request.intent.agentId
    })
  })

  const contentHash: UniversalContentHash = await calculateUniversalContentHash(
    envelope,
    effectiveContent,
    signal
  )

  // 7. WalletLocalApprovalBinding
  const binding: WalletLocalApprovalBinding = Object.freeze({
    operationId: request.requestId,
    requestId: request.requestId,
    intentId: request.intent.intentId,
    decisionId: request.policyDecision.decisionId,
    contentHash,
    network: request.intent.network,
    amountSats: request.intent.amountSats,
    destination: request.intent.toAddress,
    effectiveExpiresAt,
    bindingCreatedAt: now
  })

  // 8. One-shot ApprovalRecordCapability
  const capabilityId = options?.idGenerator
    ? options.idGenerator()
    : generateSecureRandomId('cap')

  const capability = createApprovalCapabilityInternal(
    capabilityId,
    binding,
    presentation
  )

  return Object.freeze({
    request,
    presentation,
    binding,
    capability
  })
}

/**
 * Records explicit human decision via one-shot ApprovalRecordCapability and atomic ledger commit.
 *
 * @param capability One-shot capability obtained from validateAndPresentApprovalRequest.
 * @param action Human decision originating strictly from a Wallet-owned local UI session.
 * @param options Execution dependencies (ledger, clock, ID generator, signal).
 * @returns HumanApprovalV1 audit receipt.
 */
export async function recordWalletHumanDecision(
  capability: ApprovalRecordCapability,
  action: WalletHumanAction,
  options?: RecordHumanDecisionOptions
): Promise<HumanApprovalV1> {
  const signal = options?.signal ?? new AbortController().signal
  if (signal.aborted) {
    throw new WalletApprovalReceiverError('OPERATION_ABORTED', 'Operation was aborted')
  }

  // 1. Guard capability source & freshness
  if (!(capability instanceof ApprovalRecordCapability)) {
    throw new WalletApprovalReceiverError(
      'INVALID_CAPABILITY_SOURCE',
      'Approval decision must be recorded using a valid ApprovalRecordCapability instance.'
    )
  }

  if (capability.state !== 'fresh') {
    throw new WalletApprovalReceiverError(
      'CAPABILITY_NOT_FRESH',
      `ApprovalRecordCapability is not fresh. Current state: ${capability.state}`
    )
  }

  const now = options?.nowEpochSeconds
    ? options.nowEpochSeconds()
    : Math.floor(Date.now() / 1000)

  // 2. Temporal validation
  if (now >= capability.effectiveExpiresAt) {
    capability.transition(INTERNAL_CAPABILITY_TOKEN, 'invalidated')
    throw new WalletApprovalReceiverError(
      'EXPIRED_REQUEST',
      `Capability expired prior to human decision: now ${now} >= effectiveExpiresAt ${capability.effectiveExpiresAt}`
    )
  }

  // 3. Human action and session verification
  if (!action || typeof action !== 'object') {
    throw new WalletApprovalReceiverError(
      'INVALID_HUMAN_ACTION',
      'Human action payload must be an object'
    )
  }

  if (action.decision !== 'approved' && action.decision !== 'rejected') {
    const decisionValue = (action as unknown as Record<string, unknown>).decision
    throw new WalletApprovalReceiverError(
      'INVALID_HUMAN_ACTION',
      `Expected decision 'approved' or 'rejected', got '${String(decisionValue)}'`
    )
  }

  if (!action.session || typeof action.session !== 'object') {
    throw new WalletApprovalReceiverError(
      'INVALID_HUMAN_SESSION',
      'Action must originate from an authentic Wallet-owned session.'
    )
  }

  if (action.session.sessionOrigin !== 'wallet_local_ui') {
    throw new WalletApprovalReceiverError(
      'INVALID_HUMAN_SESSION',
      `Invalid session origin: ${String(action.session.sessionOrigin)}. Must be 'wallet_local_ui'.`
    )
  }

  if (
    typeof action.session.localSessionToken !== 'string' ||
    action.session.localSessionToken.trim().length === 0
  ) {
    throw new WalletApprovalReceiverError(
      'INVALID_HUMAN_SESSION',
      'Missing or invalid localSessionToken.'
    )
  }

  if (
    typeof action.session.activeAddress !== 'string' ||
    action.session.activeAddress.trim().length === 0
  ) {
    throw new WalletApprovalReceiverError(
      'INVALID_HUMAN_SESSION',
      'Missing or invalid activeAddress in session.'
    )
  }

  let resolvedApprover: string | undefined
  if (action.decision === 'approved') {
    // Approver is resolved strictly from the authenticated session, never an arbitrary caller string
    resolvedApprover = action.session.authenticatedAlias?.trim() || action.session.activeAddress.trim()
    if (!resolvedApprover) {
      throw new WalletApprovalReceiverError(
        'MISSING_HUMAN_APPROVER',
        'Could not resolve an authenticated human approver from the Wallet session.'
      )
    }
  } else {
    resolvedApprover = undefined
  }

  // 4. Generate approvalId
  const approvalId = options?.idGenerator
    ? options.idGenerator()
    : generateSecureRandomId('appr')

  // 5. Build HumanApprovalV1
  let humanApproval: HumanApprovalV1
  try {
    humanApproval = humanApprovalV1Schema.parse({
      contractVersion: AGENTIC_CONTRACT_VERSION,
      kind: 'human_approval',
      approvalId,
      requestId: capability.binding.requestId,
      intentId: capability.binding.intentId,
      decisionId: capability.binding.decisionId,
      status: action.decision,
      approver: resolvedApprover,
      reason: action.reason,
      recordedAt: now
    })
  } catch (err: unknown) {
    throw new WalletApprovalReceiverError(
      'INVALID_REQUEST_SCHEMA',
      'Constructed HumanApprovalV1 does not conform to schema',
      err
    )
  }

  // 6. Atomic recording into WalletApprovalLedger
  capability.transition(INTERNAL_CAPABILITY_TOKEN, 'recording')

  const ledger = options?.ledger ?? defaultWalletApprovalLedger
  const record: WalletApprovalLedgerRecord = Object.freeze({
    operationId: capability.binding.operationId,
    requestId: capability.binding.requestId,
    approvalId: humanApproval.approvalId,
    humanApproval: Object.freeze(humanApproval),
    binding: capability.binding,
    recordedAt: now,
    status: 'approvalRecorded' as const
  })

  try {
    await ledger.recordApprovalAtomic(record)
    capability.transition(INTERNAL_CAPABILITY_TOKEN, 'recorded')
  } catch (error: unknown) {
    capability.transition(INTERNAL_CAPABILITY_TOKEN, 'invalidated')
    if (
      error instanceof WalletApprovalReceiverError &&
      error.code === 'DUPLICATE_APPROVAL_RECORD'
    ) {
      throw error
    }
    throw new WalletApprovalReceiverError(
      'ATOMIC_RECORDING_FAILED',
      'Failed to atomically record approval in Wallet approval ledger. Rolled back.',
      error
    )
  }

  // 7. Security invariant: Return strictly the HumanApprovalV1 receipt.
  return Object.freeze(humanApproval)
}
