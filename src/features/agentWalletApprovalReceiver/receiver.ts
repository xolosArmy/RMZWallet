/**
 * @file receiver.ts
 *
 * Canonical Hardened Wallet Approval Receiver (Gate 2B).
 *
 * Mandatory Lifecycle:
 * idle -> receiving -> validating -> preparing -> reviewReady -> approvalRequested ->
 * revalidating -> approvalRecording -> approvalRecorded -> STOP
 *
 * SECURITY INVARIANTS:
 * - ApprovalRecordCapability is STRICTLY internal and one-shot.
 * - Preparation returns ONLY an opaque handle and an immutable presentation.
 * - Anti-TOCTOU: Full reconstruction and equality check of E, C, H(E,C), and projection before recording.
 * - Human session verification via Wallet-owned WalletHumanSessionVerifier (no arbitrary caller identity).
 * - Universal Authorization Envelope E is strictly validated via parseUniversalAuthorizationEnvelope.
 * - Content hash H(E,C) computed via calculateUniversalContentHash over canonical wire bytes C.
 * - Atomic ledger recording with rollback on failure; fail closed if ledger is omitted.
 * - Return value is strictly HumanApprovalV1 as a read-only audit receipt, never an execution capability.
 */

import {
  AGENTIC_CONTRACT_VERSION,
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
  parseUniversalAuthorizationEnvelope,
  UNIVERSAL_AUTHORIZATION_SCHEMA,
  UNIVERSAL_AUTHORIZATION_VERSION,
  type UniversalAuthorizationEnvelopeV1
} from '../externalSign/contract'
import {
  createApprovalCapabilityInternal,
  INTERNAL_CAPABILITY_TOKEN
} from './capability'
import { formatSatsToExactXEC } from './format'
import {
  WalletApprovalReceiverError,
  type ApprovalReceiverLifecycleState,
  type InternalApprovalBinding,
  type PrepareApprovalReviewOptions,
  type RecordHumanDecisionOptions,
  type WalletApprovalLedgerRecord,
  type WalletApprovalPresentation,
  type WalletApprovalReviewState,
  type WalletHumanAction
} from './types'

/**
 * Valid Wallet-owned origin for Universal Authorization Envelope.
 * Complies with normalizedDeclaredOrigin (https: protocol).
 */
export const WALLET_DECLARED_ORIGIN = 'https://wallet.tonalli.app'
export const WALLET_DISPLAY_NAME = 'RMZWallet Agent Approval Receiver'
export const WALLET_PROFILE_ID = 'profile/agent-approval-v1'

interface ActiveReviewSession {
  handle: string
  state: ApprovalReceiverLifecycleState
  request: WalletApprovalRequestV1
  canonicalBytes: Uint8Array
  envelope: UniversalAuthorizationEnvelopeV1
  contentHash: UniversalContentHash
  presentation: WalletApprovalPresentation
  effectiveExpiresAt: number
  nowEpochSeconds: () => number
}

// Module-local active sessions. Not exported.
const activeReviewSessions = new Map<string, ActiveReviewSession>()

function defaultIdGenerator(): string {
  if (typeof crypto !== 'undefined' && typeof crypto.randomUUID === 'function') {
    return crypto.randomUUID()
  }
  throw new WalletApprovalReceiverError(
    'INVALID_HUMAN_ACTION',
    'Crypto randomUUID is unavailable; a cryptographically secure idGenerator must be provided.'
  )
}

/**
 * Formats an immutable presentation snapshot for Wallet UI display.
 */
function createPresentationSnapshot(
  request: WalletApprovalRequestV1,
  effectiveExpiresAt: number
): WalletApprovalPresentation {
  return Object.freeze({
    requestId: request.requestId,
    intentId: request.intent.intentId,
    decisionId: request.policyDecision.decisionId,
    agentId: request.intent.agentId,
    agentRole: request.intent.agentRole,
    amountSats: request.intent.amountSats,
    amountXEC: formatSatsToExactXEC(request.intent.amountSats),
    fromAddress: request.intent.fromAddress,
    destination: request.intent.toAddress,
    reason: request.intent.reason,
    memo: request.intent.memo,
    network: request.intent.network,
    policyTraceId: request.policyDecision.policyTraceId,
    policyReasonCode: request.policyDecision.reasonCode,
    policyVersion: request.policyDecision.policyVersion,
    requestedAtIso: new Date(request.requestedAt * 1000).toISOString(),
    effectiveExpiresAtIso: new Date(effectiveExpiresAt * 1000).toISOString(),
    effectiveExpiresAt
  })
}

/**
 * Builds and validates a Universal Authorization Envelope E for externalSign compatibility.
 * Timestamps in externalSign are converted from epoch-seconds to milliseconds.
 */
function buildCanonicalEnvelope(
  operationId: string,
  requestedAtEpochSec: number,
  effectiveExpiresAtEpochSec: number,
  nowEpochSec: number
): UniversalAuthorizationEnvelopeV1 {
  const issuedAtMs = requestedAtEpochSec * 1000
  const expiresAtMs = effectiveExpiresAtEpochSec * 1000
  const nowMs = nowEpochSec * 1000

  const rawEnvelope = {
    schema: UNIVERSAL_AUTHORIZATION_SCHEMA,
    version: UNIVERSAL_AUTHORIZATION_VERSION,
    operationId,
    profileId: WALLET_PROFILE_ID,
    issuedAt: issuedAtMs,
    expiresAt: expiresAtMs,
    requester: {
      declaredOrigin: WALLET_DECLARED_ORIGIN,
      displayName: WALLET_DISPLAY_NAME
    }
  }

  try {
    return parseUniversalAuthorizationEnvelope(rawEnvelope, nowMs)
  } catch (err: unknown) {
    throw new WalletApprovalReceiverError(
      'INVALID_ENVELOPE',
      'Failed to construct valid Universal Authorization Envelope E',
      err
    )
  }
}

/**
 * Validates request schema and core security boundaries.
 */
function validateRequestBoundaries(
  request: WalletApprovalRequestV1,
  now: number
): number {
  if (request.contractVersion !== AGENTIC_CONTRACT_VERSION) {
    throw new WalletApprovalReceiverError(
      'INVALID_CONTRACT_VERSION',
      `Unsupported contract version: "${request.contractVersion}"`
    )
  }
  if (request.kind !== 'wallet_approval_request') {
    throw new WalletApprovalReceiverError('INVALID_KIND', `Invalid kind: "${request.kind}"`)
  }
  if (request.purpose !== 'xec_payment') {
    throw new WalletApprovalReceiverError('INVALID_PURPOSE', `Unsupported purpose: "${request.purpose}"`)
  }
  if (request.policyDecision.decision !== 'needs_human_approval') {
    throw new WalletApprovalReceiverError(
      'POLICY_NOT_NEEDS_HUMAN_APPROVAL',
      `Policy decision must be needs_human_approval, got "${request.policyDecision.decision}"`
    )
  }
  if (request.policyDecision.intentId !== request.intent.intentId) {
    throw new WalletApprovalReceiverError(
      'INTENT_ID_MISMATCH',
      'Policy decision intentId does not match request intentId'
    )
  }
  if (!request.policyDecision.policyTraceId || request.policyDecision.policyTraceId.trim() === '') {
    throw new WalletApprovalReceiverError('EMPTY_POLICY_TRACE', 'Policy trace ID cannot be empty')
  }
  if (request.intent.network !== 'xec:mainnet') {
    throw new WalletApprovalReceiverError(
      'UNSUPPORTED_NETWORK',
      `Only xec:mainnet is supported in v1.0, got "${request.intent.network}"`
    )
  }

  // Calculate effective expiration across all bounded components
  const expirationCandidates = [
    request.expiresAt,
    request.intent.expiresAt,
    request.policyDecision.expiresAt
  ]
  if (request.x402) {
    expirationCandidates.push(request.x402.expiresAt)
  }
  const effectiveExpiresAt = Math.min(...expirationCandidates)

  if (effectiveExpiresAt <= now) {
    throw new WalletApprovalReceiverError(
      'EXPIRED_REQUEST',
      `Request is expired (effectiveExpiresAt: ${effectiveExpiresAt}, now: ${now})`
    )
  }

  if (request.requestedAt > now + 300) {
    throw new WalletApprovalReceiverError(
      'REQUEST_NOT_YET_VALID',
      `Request timestamp is too far in future (requestedAt: ${request.requestedAt}, now: ${now})`
    )
  }

  return effectiveExpiresAt
}

/**
 * Prepares an incoming agent approval request for human review in Wallet UI.
 *
 * Mandatory Lifecycle Phase:
 * idle -> receiving -> validating -> preparing -> reviewReady
 *
 * Returns ONLY an opaque review handle and an immutable presentation.
 * All internal bytes, envelopes, bindings, and capabilities remain strictly encapsulated.
 */
export async function prepareApprovalReview(
  input: Uint8Array | WalletApprovalRequestV1,
  options?: PrepareApprovalReviewOptions
): Promise<WalletApprovalReviewState> {
  const signal = options?.signal ?? new AbortController().signal
  if (signal.aborted) {
    throw new WalletApprovalReceiverError('OPERATION_ABORTED', 'Operation was aborted')
  }

  // 1. Lifecycle: idle -> receiving
  let canonicalBytes: Uint8Array
  let rawRequest: unknown

  if (input instanceof Uint8Array) {
    canonicalBytes = input
    try {
      rawRequest = decodeAgentWalletHandoffV1(canonicalBytes)
    } catch (err: unknown) {
      throw new WalletApprovalReceiverError(
        'INVALID_REQUEST_SCHEMA',
        'Failed to decode canonical agent wallet handoff bytes',
        err
      )
    }
  } else {
    rawRequest = input
    try {
      canonicalBytes = encodeAgentWalletHandoffV1(rawRequest as WalletApprovalRequestV1)
    } catch (err: unknown) {
      throw new WalletApprovalReceiverError(
        'INVALID_REQUEST_SCHEMA',
        'Failed to encode request into canonical handoff bytes',
        err
      )
    }
  }

  // 2. Lifecycle: receiving -> validating
  let request: WalletApprovalRequestV1
  try {
    request = parseWalletApprovalRequestV1(rawRequest)
  } catch (err: unknown) {
    throw new WalletApprovalReceiverError(
      'INVALID_REQUEST_SCHEMA',
      'Wallet approval request schema validation failed',
      err
    )
  }

  const now = options?.nowEpochSeconds ? options.nowEpochSeconds() : Math.floor(Date.now() / 1000)
  const effectiveExpiresAt = validateRequestBoundaries(request, now)

  // 3. Lifecycle: validating -> preparing
  const presentation = createPresentationSnapshot(request, effectiveExpiresAt)
  const envelope = buildCanonicalEnvelope(request.requestId, request.requestedAt, effectiveExpiresAt, now)

  let contentHash: UniversalContentHash
  try {
    contentHash = await calculateUniversalContentHash(envelope, canonicalBytes, signal)
  } catch (err: unknown) {
    throw new WalletApprovalReceiverError(
      'INVALID_CONTENT_HASH',
      'Failed to compute normative H(E,C) content hash',
      err
    )
  }

  // Generate opaque review handle
  const handle = defaultIdGenerator()

  // 4. Lifecycle: preparing -> reviewReady
  const session: ActiveReviewSession = {
    handle,
    state: 'reviewReady',
    request,
    canonicalBytes,
    envelope,
    contentHash,
    presentation,
    effectiveExpiresAt,
    nowEpochSeconds: options?.nowEpochSeconds ?? (() => Math.floor(Date.now() / 1000))
  }

  activeReviewSessions.set(handle, session)

  return Object.freeze({
    handle,
    presentation
  })
}

/**
 * Records a human decision (approved or rejected) initiated from the Wallet UI.
 *
 * Mandatory Lifecycle Phase:
 * reviewReady -> approvalRequested -> revalidating -> approvalRecording -> approvalRecorded -> STOP
 *
 * Enforces:
 * 1. Wallet-owned authentic human session verification (no spoofed identities).
 * 2. Complete anti-TOCTOU reconstruction & byte-exact equality (E' = E, C' = C, H' = H, projection' = projection).
 * 3. Minting of internal one-shot capability only during atomic recording.
 * 4. Atomic ledger recording with rollback on failure.
 * 5. Returns exclusively a read-only HumanApprovalV1 audit receipt.
 */
export async function recordWalletHumanDecision(
  handle: string,
  action: WalletHumanAction,
  options: RecordHumanDecisionOptions
): Promise<HumanApprovalV1> {
  const signal = options.signal ?? new AbortController().signal
  if (signal.aborted) {
    throw new WalletApprovalReceiverError('OPERATION_ABORTED', 'Operation was aborted')
  }

  if (!options.ledger) {
    throw new WalletApprovalReceiverError(
      'MISSING_LEDGER_DEPENDENCY',
      'Explicit WalletApprovalLedger injection is required. Global fallback is prohibited.'
    )
  }

  if (!options.sessionVerifier) {
    throw new WalletApprovalReceiverError(
      'MISSING_SESSION_VERIFIER',
      'Explicit WalletHumanSessionVerifier injection is required.'
    )
  }

  const session = activeReviewSessions.get(handle)
  if (!session) {
    throw new WalletApprovalReceiverError(
      'UNKNOWN_REVIEW_HANDLE',
      `Review session handle "${handle}" is unknown or expired.`
    )
  }

  if (session.state !== 'reviewReady') {
    throw new WalletApprovalReceiverError(
      'INVALID_LIFECYCLE_STATE',
      `Cannot record decision from state "${session.state}". Must be "reviewReady".`
    )
  }

  // 1. Lifecycle: reviewReady -> approvalRequested
  session.state = 'approvalRequested'

  // 2. Lifecycle: approvalRequested -> revalidating
  session.state = 'revalidating'

  if (!action || typeof action !== 'object') {
    throw new WalletApprovalReceiverError('INVALID_HUMAN_ACTION', 'Action must be an object')
  }

  if (action.decision !== 'approved' && action.decision !== 'rejected') {
    throw new WalletApprovalReceiverError(
      'INVALID_HUMAN_ACTION',
      `Invalid decision: "${String((action as { decision?: unknown }).decision)}". Must be "approved" or "rejected".`
    )
  }

  if (!action.sessionToken || typeof action.sessionToken !== 'string' || action.sessionToken.trim() === '') {
    throw new WalletApprovalReceiverError(
      'INVALID_HUMAN_SESSION',
      'A valid, non-empty sessionToken is required.'
    )
  }

  // Verify authentic Wallet-owned human session
  let sessionVerification
  try {
    sessionVerification = await options.sessionVerifier.verifySession(action.sessionToken)
  } catch (err: unknown) {
    throw new WalletApprovalReceiverError(
      'INVALID_HUMAN_SESSION',
      'Failed during session verification execution',
      err
    )
  }

  if (!sessionVerification.authenticated || !sessionVerification.activeAddress) {
    throw new WalletApprovalReceiverError(
      'INVALID_HUMAN_SESSION',
      'Human session verification failed or activeAddress is missing.'
    )
  }

  const approver = sessionVerification.authenticatedAlias ?? sessionVerification.activeAddress
  if (!approver || approver.trim() === '') {
    throw new WalletApprovalReceiverError(
      'MISSING_HUMAN_APPROVER',
      'Unable to resolve authenticated approver identity from session.'
    )
  }

  const now = options.nowEpochSeconds ? options.nowEpochSeconds() : session.nowEpochSeconds()

  // Fresh temporal validity check
  if (now >= session.effectiveExpiresAt) {
    session.state = 'STOP'
    activeReviewSessions.delete(handle)
    throw new WalletApprovalReceiverError(
      'EXPIRED_REQUEST',
      `Approval request expired before recording (effectiveExpiresAt: ${session.effectiveExpiresAt}, now: ${now})`
    )
  }

  // 3. Anti-TOCTOU Deep Revalidation:
  // Reconstruct E', C', H' and projection from the stored canonical bytes and request
  let reconstructedRequest: WalletApprovalRequestV1
  try {
    const rawReconstructed = decodeAgentWalletHandoffV1(session.canonicalBytes)
    reconstructedRequest = parseWalletApprovalRequestV1(rawReconstructed)
  } catch (err: unknown) {
    throw new WalletApprovalReceiverError(
      'TOCTOU_VALIDATION_FAILED',
      'Anti-TOCTOU failure: unable to re-decode canonical bytes',
      err
    )
  }

  // Check C' = C
  const reencodedBytes = encodeAgentWalletHandoffV1(reconstructedRequest)
  if (
    reencodedBytes.length !== session.canonicalBytes.length ||
    !reencodedBytes.every((byte, idx) => byte === session.canonicalBytes[idx])
  ) {
    throw new WalletApprovalReceiverError(
      'TOCTOU_VALIDATION_FAILED',
      'Anti-TOCTOU failure: canonical byte stream mutated during review'
    )
  }

  // Check Projection identity
  const reconstructedEffectiveExpiresAt = validateRequestBoundaries(reconstructedRequest, now)
  const reconstructedPresentation = createPresentationSnapshot(
    reconstructedRequest,
    reconstructedEffectiveExpiresAt
  )

  if (
    reconstructedPresentation.amountSats !== session.presentation.amountSats ||
    reconstructedPresentation.destination !== session.presentation.destination ||
    reconstructedPresentation.network !== session.presentation.network ||
    reconstructedPresentation.policyTraceId !== session.presentation.policyTraceId ||
    reconstructedPresentation.intentId !== session.presentation.intentId ||
    reconstructedPresentation.requestId !== session.presentation.requestId
  ) {
    throw new WalletApprovalReceiverError(
      'TOCTOU_VALIDATION_FAILED',
      'Anti-TOCTOU failure: presentation projection parameters mutated during review'
    )
  }

  // Check E' = E
  const reconstructedEnvelope = buildCanonicalEnvelope(
    reconstructedRequest.requestId,
    reconstructedRequest.requestedAt,
    reconstructedEffectiveExpiresAt,
    now
  )

  if (
    reconstructedEnvelope.operationId !== session.envelope.operationId ||
    reconstructedEnvelope.expiresAt !== session.envelope.expiresAt ||
    reconstructedEnvelope.issuedAt !== session.envelope.issuedAt ||
    reconstructedEnvelope.requester.declaredOrigin !== session.envelope.requester.declaredOrigin ||
    reconstructedEnvelope.requester.displayName !== session.envelope.requester.displayName
  ) {
    throw new WalletApprovalReceiverError(
      'TOCTOU_VALIDATION_FAILED',
      'Anti-TOCTOU failure: Universal Authorization Envelope E mutated during review'
    )
  }

  // Check H' = H
  const reconstructedHash = await calculateUniversalContentHash(
    reconstructedEnvelope,
    session.canonicalBytes,
    signal
  )

  if (reconstructedHash !== session.contentHash) {
    throw new WalletApprovalReceiverError(
      'TOCTOU_VALIDATION_FAILED',
      `Anti-TOCTOU failure: H(E,C) hash mismatch. Expected ${session.contentHash}, computed ${reconstructedHash}`
    )
  }

  const idGenerator = options.idGenerator ?? defaultIdGenerator

  // Handle REJECTED decision
  if (action.decision === 'rejected') {
    session.state = 'STOP'
    activeReviewSessions.delete(handle)
    const rejectionApprovalId = idGenerator()

    return Object.freeze({
      contractVersion: AGENTIC_CONTRACT_VERSION,
      kind: 'human_approval',
      approvalId: rejectionApprovalId,
      requestId: session.request.requestId,
      intentId: session.request.intent.intentId,
      decisionId: session.request.policyDecision.decisionId,
      approver,
      status: 'rejected',
      reason: action.reason ?? 'Rejected by human custodian in Wallet UI',
      recordedAt: now
    })
  }

  // 4. Lifecycle: revalidating -> approvalRecording
  session.state = 'approvalRecording'

  const internalBinding: InternalApprovalBinding = {
    operationId: session.request.requestId,
    requestId: session.request.requestId,
    intentId: session.request.intent.intentId,
    decisionId: session.request.policyDecision.decisionId,
    contentHash: session.contentHash,
    envelope: session.envelope,
    canonicalBytes: session.canonicalBytes,
    network: session.request.intent.network,
    amountSats: session.request.intent.amountSats,
    destination: session.request.intent.toAddress,
    effectiveExpiresAt: session.effectiveExpiresAt,
    presentationSnapshot: session.presentation
  }

  const capabilityId = idGenerator()
  const capability = createApprovalCapabilityInternal(capabilityId, internalBinding)

  // Transition capability to recording
  capability.transition(INTERNAL_CAPABILITY_TOKEN, 'recording')

  const approvalId = idGenerator()
  const humanApproval: HumanApprovalV1 = Object.freeze({
    contractVersion: AGENTIC_CONTRACT_VERSION,
    kind: 'human_approval',
    approvalId,
    requestId: session.request.requestId,
    intentId: session.request.intent.intentId,
    decisionId: session.request.policyDecision.decisionId,
    approver,
    status: 'approved',
    reason: action.reason,
    recordedAt: now
  })

  const ledgerRecord: WalletApprovalLedgerRecord = Object.freeze({
    operationId: session.request.requestId,
    requestId: session.request.requestId,
    approvalId,
    capabilityId,
    humanApproval,
    contentHash: session.contentHash,
    recordedAt: now,
    status: 'approvalRecorded'
  })

  // 5. Atomic ledger insertion with rollback on failure
  try {
    await options.ledger.recordApprovalAtomic(ledgerRecord)
  } catch (err: unknown) {
    // Rollback: invalidate capability and stop session
    capability.transition(INTERNAL_CAPABILITY_TOKEN, 'invalidated')
    session.state = 'STOP'
    activeReviewSessions.delete(handle)

    if (err instanceof WalletApprovalReceiverError) {
      throw err
    }
    throw new WalletApprovalReceiverError(
      'ATOMIC_RECORDING_FAILED',
      'Failed during atomic ledger insertion; approval rolled back.',
      err
    )
  }

  // 6. Lifecycle: approvalRecording -> approvalRecorded -> STOP
  capability.transition(INTERNAL_CAPABILITY_TOKEN, 'recorded')
  session.state = 'approvalRecorded'
  session.state = 'STOP'
  activeReviewSessions.delete(handle)

  // Return strictly read-only audit receipt
  return humanApproval
}

/**
 * Clear all in-flight review sessions. Strictly for testing environments.
 */
export function _clearActiveReviewSessionsForTesting(): void {
  activeReviewSessions.clear()
}
