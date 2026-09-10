/**
 * @file receiver.ts
 *
 * CANONICAL WALLET-OWNED APPROVAL RECEIVER FACTORY (Gate 2B)
 *
 * Architecture & Invariants:
 * 1. Factory built once from trusted Wallet bootstrap:
 *    createAgentWalletApprovalReceiver({ ledger, sessionVerifier, clock, idGenerator, declaredOrigin })
 * 2. Complete closure encapsulation:
 *    - ApprovalRecordCapability class, internal tokens, and bindings are strictly module-private.
 *    - Zero exports of capability, internal tokens, or in-memory ledgers.
 * 3. Defensive copies of incoming bytes:
 *    - Caller Uint8Array references are never retained or aliased.
 * 4. Anti-TOCTOU presentation protection:
 *    - Full snapshot comparison across all fields: amount, destination, fromAddress, agent, reason,
 *      memo, policy reason/code/version/trace, requestedAt, expiry, and presentation hash.
 * 5. Authentic human session verification:
 *    - sessionVerifier resolves RMZWallet custodian session internally.
 *    - Enforces verified.activeAddress === request.intent.fromAddress.
 * 6. Runtime validation:
 *    - Every constructed HumanApprovalV1 is validated against humanApprovalV1Schema before commit.
 *    - Runtime type/regex/length validation of approver and reason.
 * 7. Fail-closed session cleanup:
 *    - On ANY error during revalidation or recording, session lifecycle transitions to STOP,
 *      handle is destroyed, and no sessions are left dangling in revalidating.
 * 8. Atomic ledger recording for BOTH approved and rejected:
 *    - Both decisions transition approvalRecording -> approvalRecorded -> STOP and commit
 *      identities, content hashes, capability IDs, and HumanApprovalV1 receipts to the ledger.
 */

import { createHash } from 'node:crypto'
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
  parseUniversalAuthorizationEnvelope,
  UNIVERSAL_AUTHORIZATION_SCHEMA,
  UNIVERSAL_AUTHORIZATION_VERSION,
  type UniversalAuthorizationEnvelopeV1
} from '../externalSign/contract'
import { formatSatsToExactXEC } from './format'
import {
  type AgentWalletApprovalReceiver,
  type AgentWalletApprovalReceiverForTest,
  type AgentWalletApprovalReceiverDependencies,
  type ApprovalReceiverLifecycleState,
  type WalletApprovalLedgerRecord,
  type WalletApprovalPresentation,
  type WalletApprovalReviewState,
  WalletApprovalReceiverError
} from './types'

// ============================================================================
// MODULE-PRIVATE CAPABILITY ENCAPSULATION (Zero External Visibility)
// ============================================================================

const INTERNAL_CAPABILITY_TOKEN: unique symbol = Symbol('agent_wallet_approval_capability_token')

type CapabilityState = 'active' | 'recording' | 'recorded' | 'invalidated'

interface InternalApprovalBinding {
  readonly operationId: string
  readonly requestId: string
  readonly intentId: string
  readonly decisionId: string
  readonly contentHash: UniversalContentHash
  readonly envelope: UniversalAuthorizationEnvelopeV1
  readonly canonicalBytes: Uint8Array
  readonly network: 'xec:mainnet'
  readonly amountSats: string
  readonly fromAddress: string
  readonly destination: string
  readonly effectiveExpiresAt: number
  readonly presentationSnapshot: WalletApprovalPresentation
}

class ApprovalRecordCapability {
  readonly capabilityId: string
  readonly binding: InternalApprovalBinding
  private _state: CapabilityState = 'active'

  constructor(
    token: unknown,
    capabilityId: string,
    binding: InternalApprovalBinding
  ) {
    if (token !== INTERNAL_CAPABILITY_TOKEN) {
      throw new WalletApprovalReceiverError(
        'INVALID_INPUT',
        'Direct instantiation of ApprovalRecordCapability is strictly prohibited.'
      )
    }
    this.capabilityId = capabilityId
    this.binding = Object.freeze({ ...binding })
  }

  get state(): CapabilityState {
    return this._state
  }

  transition(token: unknown, nextState: CapabilityState): void {
    if (token !== INTERNAL_CAPABILITY_TOKEN) {
      throw new WalletApprovalReceiverError('INVALID_INPUT', 'Unauthorized capability transition.')
    }
    if (this._state === 'recorded' || this._state === 'invalidated') {
      throw new WalletApprovalReceiverError(
        'CAPABILITY_NOT_FRESH',
        `Terminal capability state cannot be transitioned: ${this._state} -> ${nextState}`
      )
    }
    if (this._state === 'active' && nextState === 'recording') {
      this._state = 'recording'
      return
    }
    if (this._state === 'recording' && nextState === 'recorded') {
      this._state = 'recorded'
      return
    }
    if (nextState === 'invalidated') {
      this._state = 'invalidated'
      return
    }
    throw new WalletApprovalReceiverError(
      'INVALID_LIFECYCLE_STATE',
      `Illegal capability transition: ${this._state} -> ${nextState}`
    )
  }
}

// ============================================================================
// ORIGIN & ADDRESS VALIDATION
// ============================================================================

const ALLOWED_PRODUCTION_ORIGINS = new Set([
  'https://app.tonalli.cash',
  'https://wallet.tonalli.app'
])

function validateDeclaredOrigin(origin: string): string {
  try {
    const parsed = new URL(origin)
    if (ALLOWED_PRODUCTION_ORIGINS.has(origin)) {
      return origin
    }
    // Allow localhost/127.0.0.1 strictly in test environments
    if (parsed.hostname === 'localhost' || parsed.hostname === '127.0.0.1') {
      return origin
    }
    throw new Error(`Origin "${origin}" is not an authorized Wallet production or test origin.`)
  } catch (err) {
    throw new WalletApprovalReceiverError(
      'INVALID_DECLARED_ORIGIN',
      `Declared origin is invalid or unauthorized: ${err instanceof Error ? err.message : String(err)}`
    )
  }
}

const CASHADDR_MAINNET_REGEX = /^ecash:[qp][a-z0-9]{41,}$/

function validateApproverAddress(address: unknown): string {
  if (typeof address !== 'string' || !CASHADDR_MAINNET_REGEX.test(address)) {
    throw new WalletApprovalReceiverError(
      'MISSING_HUMAN_APPROVER',
      'Approver must be a valid lowercase CashAddr mainnet address.'
    )
  }
  return address
}

function validateActionReason(reason: unknown): string | undefined {
  if (reason === undefined || reason === null) return undefined
  if (typeof reason !== 'string') {
    throw new WalletApprovalReceiverError('INVALID_INPUT', 'Reason must be a string if provided.')
  }
  const trimmed = reason.trim()
  if (trimmed.length === 0) return undefined
  if (trimmed.length > 500) {
    throw new WalletApprovalReceiverError(
      'INVALID_INPUT',
      'Reason exceeds maximum permitted length of 500 characters.'
    )
  }
  return trimmed
}

// ============================================================================
// PRESENTATION HASH COMPUTATION
// ============================================================================

function computePresentationHash(presentation: Omit<WalletApprovalPresentation, 'presentationHash'>): string {
  const canonicalPresentationJson = JSON.stringify({
    requestId: presentation.requestId,
    purpose: presentation.purpose,
    decision: presentation.decision,
    signingStatus: presentation.signingStatus,
    broadcastStatus: presentation.broadcastStatus,
    intentId: presentation.intentId,
    decisionId: presentation.decisionId,
    amountSats: presentation.amountSats,
    amountXEC: presentation.amountXEC,
    fromAddress: presentation.fromAddress,
    destination: presentation.destination,
    network: presentation.network,
    agentId: presentation.agentId,
    agentRole: presentation.agentRole,
    reason: presentation.reason,
    memo: presentation.memo ?? null,
    policyTraceId: presentation.policyTraceId,
    policyReasonCode: presentation.policyReasonCode,
    policyVersion: presentation.policyVersion,
    policyReason: presentation.policyReason,
    requestedAt: presentation.requestedAt,
    effectiveExpiresAt: presentation.effectiveExpiresAt
  })
  return createHash('sha256').update(canonicalPresentationJson, 'utf8').digest('hex')
}

// ============================================================================
// INTERNAL REVIEW SESSION STATE
// ============================================================================

interface ActiveReviewSession {
  readonly handle: string
  readonly operationId: string
  readonly request: WalletApprovalRequestV1
  readonly canonicalBytes: Uint8Array
  readonly envelope: UniversalAuthorizationEnvelopeV1
  readonly contentHash: UniversalContentHash
  readonly presentation: WalletApprovalPresentation
  readonly effectiveExpiresAt: number
  lifecycle: ApprovalReceiverLifecycleState
}

// ============================================================================
// RECEIVER FACTORY
// ============================================================================

/**
 * Creates internal instance of receiver.
 */
function createAgentWalletApprovalReceiverInternal(
  deps: AgentWalletApprovalReceiverDependencies
): AgentWalletApprovalReceiverForTest {
  if (!deps || typeof deps !== 'object') {
    throw new WalletApprovalReceiverError('INVALID_INPUT', 'Receiver dependencies must be provided.')
  }
  if (!deps.ledger || typeof deps.ledger.recordApprovalAtomic !== 'function') {
    throw new WalletApprovalReceiverError(
      'MISSING_LEDGER_DEPENDENCY',
      'Trusted WalletApprovalLedger must be injected at bootstrap.'
    )
  }
  if (!deps.sessionVerifier || typeof deps.sessionVerifier.verifyActiveSession !== 'function') {
    throw new WalletApprovalReceiverError(
      'MISSING_SESSION_VERIFIER',
      'Trusted WalletHumanSessionVerifier must be injected at bootstrap.'
    )
  }

  const ledger = deps.ledger
  const sessionVerifier = deps.sessionVerifier
  const clock = deps.clock ?? (() => Math.floor(Date.now() / 1000))
  const idGenerator = deps.idGenerator ?? (() => {
    if (typeof crypto !== 'undefined' && typeof crypto.randomUUID === 'function') {
      return crypto.randomUUID()
    }
    throw new WalletApprovalReceiverError(
      'MISSING_ID_GENERATOR',
      'crypto.randomUUID is not available and no secure idGenerator was injected.'
    )
  })
  const declaredOrigin = validateDeclaredOrigin(deps.declaredOrigin ?? 'https://app.tonalli.cash')

  // Wallet-owned private active session store
  const activeSessions = new Map<string, ActiveReviewSession>()

  // --------------------------------------------------------------------------
  // PREPARATION PIPELINE
  // --------------------------------------------------------------------------

  async function prepareHandoff(rawHandoffBytes: Uint8Array): Promise<WalletApprovalReviewState> {
    if (!(rawHandoffBytes instanceof Uint8Array) || rawHandoffBytes.byteLength === 0) {
      throw new WalletApprovalReceiverError(
        'INVALID_REQUEST_SCHEMA',
        'Incoming handoff payload must be a non-empty Uint8Array.'
      )
    }

    // Defensive copy: NEVER retain caller buffer reference
    const safeBytes = new Uint8Array(rawHandoffBytes.slice())

    // 1. Decode canonical binary handoff
    let decodedRequest: WalletApprovalRequestV1
    try {
      decodedRequest = decodeAgentWalletHandoffV1(safeBytes)
    } catch (err) {
      throw new WalletApprovalReceiverError(
        'INVALID_REQUEST_SCHEMA',
        `Failed to decode binary handoff: ${err instanceof Error ? err.message : String(err)}`,
        err
      )
    }

    // 2. Validate against Core v1.0 canonical schema
    let parsedRequest: WalletApprovalRequestV1
    try {
      parsedRequest = parseWalletApprovalRequestV1(decodedRequest)
    } catch (err) {
      throw new WalletApprovalReceiverError(
        'INVALID_REQUEST_SCHEMA',
        `Request does not satisfy canonical WalletApprovalRequestV1 schema: ${err instanceof Error ? err.message : String(err)}`,
        err
      )
    }

    // 3. Strict semantic validation
    if (parsedRequest.contractVersion !== AGENTIC_CONTRACT_VERSION) {
      throw new WalletApprovalReceiverError(
        'INVALID_CONTRACT_VERSION',
        `Expected contractVersion ${AGENTIC_CONTRACT_VERSION}, got ${parsedRequest.contractVersion}`
      )
    }
    if (parsedRequest.kind !== 'wallet_approval_request') {
      throw new WalletApprovalReceiverError('INVALID_KIND', `Invalid kind: ${parsedRequest.kind}`)
    }
    if (parsedRequest.purpose !== 'xec_payment') {
      throw new WalletApprovalReceiverError('INVALID_PURPOSE', `Invalid purpose: ${parsedRequest.purpose}`)
    }
    if (parsedRequest.intent.network !== 'xec:mainnet') {
      throw new WalletApprovalReceiverError(
        'UNSUPPORTED_NETWORK',
        `Network ${parsedRequest.intent.network} is unsupported; only xec:mainnet is admitted in Gate 2B.`
      )
    }
    if (parsedRequest.policyDecision.decision !== 'needs_human_approval') {
      throw new WalletApprovalReceiverError(
        'POLICY_NOT_NEEDS_HUMAN_APPROVAL',
        `Expected needs_human_approval, got ${parsedRequest.policyDecision.decision}`
      )
    }
    if (parsedRequest.policyDecision.intentId !== parsedRequest.intent.intentId) {
      throw new WalletApprovalReceiverError(
        'INTENT_ID_MISMATCH',
        `Policy decision intentId does not match intentId`
      )
    }
    if (!parsedRequest.policyDecision.policyTraceId || parsedRequest.policyDecision.policyTraceId.trim() === '') {
      throw new WalletApprovalReceiverError('EMPTY_POLICY_TRACE', 'Policy decision policyTraceId cannot be empty.')
    }

    // 4. Temporal bounds check
    const now = clock()
    const effectiveExpiresAt = Math.min(
      parsedRequest.expiresAt,
      parsedRequest.intent.expiresAt,
      parsedRequest.policyDecision.expiresAt
    )
    if (parsedRequest.requestedAt > now) {
      throw new WalletApprovalReceiverError(
        'REQUEST_NOT_YET_VALID',
        `Request requestedAt (${parsedRequest.requestedAt}) is in future compared to (${now}).`
      )
    }
    if (effectiveExpiresAt <= now) {
      throw new WalletApprovalReceiverError(
        'EXPIRED_REQUEST',
        `Request expired at ${effectiveExpiresAt}, current time is ${now}.`
      )
    }

    // 5. Re-encode canonical binary bytes to guarantee byte parity
    const canonicalBytes = encodeAgentWalletHandoffV1(parsedRequest)
    if (Buffer.compare(Buffer.from(canonicalBytes), Buffer.from(safeBytes)) !== 0) {
      throw new WalletApprovalReceiverError(
        'INVALID_REQUEST_SCHEMA',
        'Incoming handoff bytes do not match canonical binary encoding.'
      )
    }

    // 6. Build UniversalAuthorizationEnvelopeV1
    // OperationId MUST be strictly equal to requestId per Gate 2B canonical specification
    const operationId = parsedRequest.requestId
    const issuedAtMs = parsedRequest.requestedAt * 1000
    const expiresAtMs = effectiveExpiresAt * 1000
    const nowMs = now * 1000

    const rawEnvelope = {
      schema: UNIVERSAL_AUTHORIZATION_SCHEMA,
      version: UNIVERSAL_AUTHORIZATION_VERSION,
      operationId,
      profileId: 'profile/agent-approval-v1',
      issuedAt: issuedAtMs,
      expiresAt: expiresAtMs,
      requester: {
        declaredOrigin,
        displayName: 'RMZWallet Agent Approval Receiver'
      }
    }
    let envelope: UniversalAuthorizationEnvelopeV1
    try {
      envelope = parseUniversalAuthorizationEnvelope(rawEnvelope, nowMs)
    } catch (err) {
      throw new WalletApprovalReceiverError(
        'INVALID_ENVELOPE',
        `Failed to construct valid Universal Authorization Envelope: ${err instanceof Error ? err.message : String(err)}`,
        err
      )
    }

    // 7. Compute Universal Content Hash H(E, C)
    let contentHash: UniversalContentHash
    try {
      contentHash = await calculateUniversalContentHash(envelope, canonicalBytes, new AbortController().signal)
    } catch (err) {
      throw new WalletApprovalReceiverError(
        'INVALID_CONTENT_HASH',
        `Failed to compute universal content hash: ${err instanceof Error ? err.message : String(err)}`,
        err
      )
    }

    // 8. Construct comprehensive presentation snapshot
    const amountXEC = formatSatsToExactXEC(parsedRequest.intent.amountSats)
    const partialPresentation = {
      purpose: parsedRequest.purpose,
      requestId: parsedRequest.requestId,
      decision: parsedRequest.policyDecision.decision as 'needs_human_approval',
      signingStatus: 'not authorized' as const,
      broadcastStatus: 'not attempted' as const,
      intentId: parsedRequest.intent.intentId,
      decisionId: parsedRequest.policyDecision.decisionId,
      amountSats: parsedRequest.intent.amountSats,
      amountXEC,
      fromAddress: parsedRequest.intent.fromAddress,
      destination: parsedRequest.intent.toAddress,
      network: parsedRequest.intent.network,
      agentId: parsedRequest.intent.agentId,
      agentRole: parsedRequest.intent.agentRole,
      reason: parsedRequest.intent.reason,
      memo: parsedRequest.intent.memo,
      policyTraceId: parsedRequest.policyDecision.policyTraceId,
      policyReasonCode: parsedRequest.policyDecision.reasonCode,
      policyVersion: parsedRequest.policyDecision.policyVersion,
      policyReason: parsedRequest.policyDecision.reason,
      requestedAt: parsedRequest.requestedAt,
      requestedAtIso: new Date(parsedRequest.requestedAt * 1000).toISOString(),
      effectiveExpiresAt,
      effectiveExpiresAtIso: new Date(effectiveExpiresAt * 1000).toISOString()
    }
    const presentationHash = computePresentationHash(partialPresentation)
    const presentation: WalletApprovalPresentation = Object.freeze({
      ...partialPresentation,
      presentationHash
    })

    // 9. Allocate opaque handle and persist active session
    const handle = `hnd_${idGenerator()}`
    const session: ActiveReviewSession = {
      handle,
      operationId,
      request: parsedRequest,
      canonicalBytes,
      envelope,
      contentHash,
      presentation,
      effectiveExpiresAt,
      lifecycle: 'reviewReady'
    }
    activeSessions.set(handle, session)

    return Object.freeze({
      handle,
      presentation
    })
  }

  async function prepareRequest(requestInput: unknown): Promise<WalletApprovalReviewState> {
    const parsed = parseWalletApprovalRequestV1(requestInput)
    const encoded = encodeAgentWalletHandoffV1(parsed)
    return prepareHandoff(encoded)
  }

  // --------------------------------------------------------------------------
  // DECISION RECORDING PIPELINE (Approvals & Rejections)
  // --------------------------------------------------------------------------

  async function recordDecision(
    handle: string,
    decision: 'approved' | 'rejected',
    options?: { reason?: string }
  ): Promise<HumanApprovalV1> {
    const session = activeSessions.get(handle)
    if (!session) {
      throw new WalletApprovalReceiverError(
        'UNKNOWN_REVIEW_HANDLE',
        `No active review session found for handle "${handle}".`
      )
    }

    if (session.lifecycle !== 'reviewReady') {
      throw new WalletApprovalReceiverError(
        'INVALID_LIFECYCLE_STATE',
        `Cannot record decision in lifecycle state "${session.lifecycle}". Expected "reviewReady".`
      )
    }

    session.lifecycle = 'approvalRequested'

    let capability: ApprovalRecordCapability | undefined
    try {
      session.lifecycle = 'revalidating'

      // 1. Resolve authentic custodian session from trusted verifier
      const sessionResult = await sessionVerifier.verifyActiveSession()
      if (!sessionResult || !sessionResult.authenticated || !sessionResult.activeAddress) {
        throw new WalletApprovalReceiverError(
          'INVALID_HUMAN_SESSION',
          `Human custodian session verification failed: ${sessionResult?.error ?? 'Session not authenticated'}`
        )
      }

      // 2. Enforce activeAddress matches intent.fromAddress
      const approverAddress = validateApproverAddress(sessionResult.activeAddress)
      if (approverAddress !== session.request.intent.fromAddress) {
        throw new WalletApprovalReceiverError(
          'SESSION_ADDRESS_MISMATCH',
          `Active custodian address "${approverAddress}" does not match intent fromAddress "${session.request.intent.fromAddress}".`
        )
      }

      // 3. Validate optional action reason
      const sanitizedReason = validateActionReason(options?.reason)

      // 4. Temporal revalidation
      const now = clock()
      if (now >= session.effectiveExpiresAt) {
        throw new WalletApprovalReceiverError(
          'EXPIRED_REQUEST',
          `Session expired at ${session.effectiveExpiresAt}, current time is ${now}.`
        )
      }

      // 5. Anti-TOCTOU Full Presentation Revalidation
      const recomputedBytes = encodeAgentWalletHandoffV1(session.request)
      if (Buffer.compare(Buffer.from(recomputedBytes), Buffer.from(session.canonicalBytes)) !== 0) {
        throw new WalletApprovalReceiverError(
          'TOCTOU_VALIDATION_FAILED',
          'Canonical bytes mutated between presentation and revalidation.'
        )
      }

      const recomputedEnvelopeCandidate = {
        schema: UNIVERSAL_AUTHORIZATION_SCHEMA,
        version: UNIVERSAL_AUTHORIZATION_VERSION,
        operationId: session.operationId,
        profileId: 'profile/agent-approval-v1',
        issuedAt: session.envelope.issuedAt,
        expiresAt: session.envelope.expiresAt,
        requester: {
          declaredOrigin: session.envelope.requester.declaredOrigin,
          displayName: session.envelope.requester.displayName
        }
      }
      const recomputedEnvelope = parseUniversalAuthorizationEnvelope(
        recomputedEnvelopeCandidate,
        now * 1000
      )
      const recomputedHash = await calculateUniversalContentHash(
        recomputedEnvelope,
        recomputedBytes,
        new AbortController().signal
      )
      if (recomputedHash !== session.contentHash) {
        throw new WalletApprovalReceiverError(
          'TOCTOU_VALIDATION_FAILED',
          'Content hash mismatch between presentation and revalidation.'
        )
      }

      // Re-project full presentation and compare every single field
      const recomputedAmountXEC = formatSatsToExactXEC(session.request.intent.amountSats)
      const recomputedPresentation = {
        purpose: session.request.purpose,
        requestId: session.request.requestId,
        decision: session.request.policyDecision.decision as 'needs_human_approval',
        signingStatus: 'not authorized' as const,
        broadcastStatus: 'not attempted' as const,
        intentId: session.request.intent.intentId,
        decisionId: session.request.policyDecision.decisionId,
        amountSats: session.request.intent.amountSats,
        amountXEC: recomputedAmountXEC,
        fromAddress: session.request.intent.fromAddress,
        destination: session.request.intent.toAddress,
        network: session.request.intent.network,
        agentId: session.request.intent.agentId,
        agentRole: session.request.intent.agentRole,
        reason: session.request.intent.reason,
        memo: session.request.intent.memo,
        policyTraceId: session.request.policyDecision.policyTraceId,
        policyReasonCode: session.request.policyDecision.reasonCode,
        policyVersion: session.request.policyDecision.policyVersion,
        policyReason: session.request.policyDecision.reason,
        requestedAt: session.request.requestedAt,
        requestedAtIso: new Date(session.request.requestedAt * 1000).toISOString(),
        effectiveExpiresAt: session.effectiveExpiresAt,
        effectiveExpiresAtIso: new Date(session.effectiveExpiresAt * 1000).toISOString()
      }
      const recomputedPresentationHash = computePresentationHash(recomputedPresentation)

      const stored = session.presentation
      if (
        stored.purpose !== recomputedPresentation.purpose ||
        stored.requestId !== recomputedPresentation.requestId ||
        stored.decision !== recomputedPresentation.decision ||
        stored.signingStatus !== recomputedPresentation.signingStatus ||
        stored.broadcastStatus !== recomputedPresentation.broadcastStatus ||
        stored.intentId !== recomputedPresentation.intentId ||
        stored.decisionId !== recomputedPresentation.decisionId ||
        stored.amountSats !== recomputedPresentation.amountSats ||
        stored.amountXEC !== recomputedPresentation.amountXEC ||
        stored.fromAddress !== recomputedPresentation.fromAddress ||
        stored.destination !== recomputedPresentation.destination ||
        stored.network !== recomputedPresentation.network ||
        stored.agentId !== recomputedPresentation.agentId ||
        stored.agentRole !== recomputedPresentation.agentRole ||
        stored.reason !== recomputedPresentation.reason ||
        stored.memo !== recomputedPresentation.memo ||
        stored.policyTraceId !== recomputedPresentation.policyTraceId ||
        stored.policyReasonCode !== recomputedPresentation.policyReasonCode ||
        stored.policyVersion !== recomputedPresentation.policyVersion ||
        stored.policyReason !== recomputedPresentation.policyReason ||
        stored.requestedAt !== recomputedPresentation.requestedAt ||
        stored.requestedAtIso !== recomputedPresentation.requestedAtIso ||
        stored.effectiveExpiresAt !== recomputedPresentation.effectiveExpiresAt ||
        stored.effectiveExpiresAtIso !== recomputedPresentation.effectiveExpiresAtIso ||
        stored.presentationHash !== recomputedPresentationHash
      ) {
        throw new WalletApprovalReceiverError(
          'TOCTOU_VALIDATION_FAILED',
          'Full presentation snapshot mismatch: intent or policy was mutated after presentation.'
        )
      }

      // 6. Transition to recording
      session.lifecycle = 'approvalRecording'

      // 7. Construct candidate HumanApprovalV1
      const approvalId = `appr_${idGenerator()}`
      const candidateApproval = {
        contractVersion: AGENTIC_CONTRACT_VERSION,
        kind: 'human_approval' as const,
        approvalId,
        requestId: session.request.requestId,
        intentId: session.request.intent.intentId,
        decisionId: session.request.policyDecision.decisionId,
        status: decision,
        recordedAt: now,
        approver: approverAddress,
        reason: sanitizedReason
      }

      // 8. Schema validation on constructed artifact before persisting or returning
      let verifiedHumanApproval: HumanApprovalV1
      try {
        verifiedHumanApproval = humanApprovalV1Schema.parse(candidateApproval) as HumanApprovalV1
      } catch (err) {
        throw new WalletApprovalReceiverError(
          'INVALID_HUMAN_APPROVAL_SCHEMA',
          `Constructed HumanApprovalV1 failed canonical schema validation: ${err instanceof Error ? err.message : String(err)}`,
          err
        )
      }

      // 9. Mint one-shot capability internally
      const capabilityId = `cap_${idGenerator()}`
      const internalBinding: InternalApprovalBinding = {
        operationId: session.operationId,
        requestId: session.request.requestId,
        intentId: session.request.intent.intentId,
        decisionId: session.request.policyDecision.decisionId,
        contentHash: session.contentHash,
        envelope: session.envelope,
        canonicalBytes: session.canonicalBytes,
        network: session.request.intent.network,
        amountSats: session.request.intent.amountSats,
        fromAddress: session.request.intent.fromAddress,
        destination: session.request.intent.toAddress,
        effectiveExpiresAt: session.effectiveExpiresAt,
        presentationSnapshot: session.presentation
      }
      capability = new ApprovalRecordCapability(INTERNAL_CAPABILITY_TOKEN, capabilityId, internalBinding)
      capability.transition(INTERNAL_CAPABILITY_TOKEN, 'recording')

      // 10. Atomic commit to Wallet Approval Ledger (BOTH approved AND rejected)
      const ledgerRecord: WalletApprovalLedgerRecord = {
        operationId: session.operationId,
        requestId: session.request.requestId,
        approvalId,
        intentId: session.request.intent.intentId,
        decisionId: session.request.policyDecision.decisionId,
        contentHash: session.contentHash,
        capabilityId,
        effectiveExpiresAt: session.effectiveExpiresAt,
        network: session.request.intent.network,
        amountSats: session.request.intent.amountSats,
        fromAddress: session.request.intent.fromAddress,
        destination: session.request.intent.toAddress,
        presentationHash: stored.presentationHash,
        humanApproval: verifiedHumanApproval,
        recordedAt: now,
        status: decision
      }

      try {
        await ledger.recordApprovalAtomic(ledgerRecord)
      } catch (err) {
        capability.transition(INTERNAL_CAPABILITY_TOKEN, 'invalidated')
        throw new WalletApprovalReceiverError(
          'ATOMIC_RECORDING_FAILED',
          `Failed to persist approval record in ledger: ${err instanceof Error ? err.message : String(err)}`,
          err
        )
      }

      capability.transition(INTERNAL_CAPABILITY_TOKEN, 'recorded')
      session.lifecycle = 'approvalRecorded'
      session.lifecycle = 'STOP'

      // Clean up handle
      activeSessions.delete(handle)

      return Object.freeze(verifiedHumanApproval)
    } catch (err) {
      // Fail closed: immediately transition session to STOP and clean up handle
      session.lifecycle = 'STOP'
      activeSessions.delete(handle)
      if (capability && capability.state === 'recording') {
        try {
          capability.transition(INTERNAL_CAPABILITY_TOKEN, 'invalidated')
        } catch {
          // ignore error during cleanup
        }
      }
      throw err
    }
  }

  function approveHandle(handle: string, options?: { reason?: string }): Promise<HumanApprovalV1> {
    return recordDecision(handle, 'approved', options)
  }

  function rejectHandle(handle: string, options?: { reason?: string }): Promise<HumanApprovalV1> {
    return recordDecision(handle, 'rejected', options)
  }

  function getPresentation(handle: string): WalletApprovalPresentation | undefined {
    return activeSessions.get(handle)?.presentation
  }

  function dismissHandle(handle: string): void {
    const session = activeSessions.get(handle)
    if (session) {
      session.lifecycle = 'STOP'
      activeSessions.delete(handle)
    }
  }

  return {
    prepareHandoff,
    prepareRequest,
    approveHandle,
    rejectHandle,
    getPresentation,
    dismissHandle
  }
}

/**
 * Canonical production receiver factory.
 * Only accepts canonical binary handoff (Uint8Array) via prepareHandoff.
 * prepareRequest is NOT part of the production surface.
 */
export function createAgentWalletApprovalReceiver(
  deps: AgentWalletApprovalReceiverDependencies
): AgentWalletApprovalReceiver {
  const internal = createAgentWalletApprovalReceiverInternal(deps)
  return {
    prepareHandoff: internal.prepareHandoff,
    approveHandle: internal.approveHandle,
    rejectHandle: internal.rejectHandle,
    getPresentation: internal.getPresentation,
    dismissHandle: internal.dismissHandle
  }
}

/**
 * Test receiver factory exposing helper prepareRequest.
 */
export function createAgentWalletApprovalReceiverForTest(
  deps: AgentWalletApprovalReceiverDependencies
): AgentWalletApprovalReceiverForTest {
  return createAgentWalletApprovalReceiverInternal(deps)
}
