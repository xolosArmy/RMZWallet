import { sha256d, toHex } from 'ecash-lib'
import type {
  UniversalReviewAuthorizationAdapter,
  UniversalReviewField,
  UniversalReviewSnapshot
} from '../../features/externalSign/adapters'
import type { UniversalContentHash } from '../../features/externalSign/contentHash'
import {
  UNIVERSAL_AUTHORIZATION_SCHEMA,
  UNIVERSAL_AUTHORIZATION_VERSION,
  type UniversalAuthorizationEnvelopeV1
} from '../../features/externalSign/contract'
import type {
  UniversalAuthorizationCore,
  UniversalAuthorizationGrant,
  UniversalAuthorizationState
} from '../../features/externalSign/core'
import {
  TM1_DRAFT_02_CANDIDATE_ENVIRONMENT
} from './tm1Draft02Candidate'
import type {
  Tm1PublicationAuthorizationDecision,
  Tm1PublicationInput,
  Tm1PublicationOutput,
  Tm1SigningAuthorizationPort,
  Tm1SigningAuthorizationRequest
} from './tm1RegtestPublicationOrchestrator'

export const TM1_REGTEST_SIGNING_AUTHORIZATION_PROFILE_ID =
  'tonalli.tm1-regtest.signing-authorization.v1'

export const TM1_REGTEST_SIGNING_AUTHORIZATION_PAYLOAD_DOMAIN =
  'tonalli.tm1-regtest/signing-authorization/v1'

const EXPIRED_REASON = 'TM1 signing authorization expired'
const UINT32_MAX = 0xffffffff

export type Tm1RegtestAuthorizationProviderDecision = Readonly<
  | { status: 'approved' }
  | { status: 'rejected'; reason?: string }
>

export type Tm1RegtestAuthorizationReviewSnapshot = Readonly<{
  preparedId: string
  bindingHash: string
  message: string
  network: Readonly<{
    environment: typeof TM1_DRAFT_02_CANDIDATE_ENVIRONMENT
    chainIdentity: string
  }>
  effectiveContent: Uint8Array
  orderedInputs: readonly Tm1PublicationInput[]
  orderedOutputs: readonly Tm1PublicationOutput[]
  feeSats: bigint
}>

export type Tm1RegtestAuthorizationDecisionRequest = Readonly<{
  operationId: string
  preparedId: string
  bindingHash: string
  review: Tm1RegtestAuthorizationReviewSnapshot
  expiresAt: number
  contentHash: UniversalContentHash
}>

export interface Tm1RegtestAuthorizationDecisionProvider {
  requestDecision(
    request: Tm1RegtestAuthorizationDecisionRequest,
    signal: AbortSignal
  ): Promise<Tm1RegtestAuthorizationProviderDecision>
}

export type Tm1RegtestAuthorizationRequester = Readonly<{
  declaredOrigin: string
  displayName: string
}>

export type Tm1RegtestAuthorizationCorePort = Pick<
  UniversalAuthorizationCore,
  'startAuthorization'
>

export type Tm1RegtestAuthorizationAdapterDependencies = Readonly<{
  core: Tm1RegtestAuthorizationCorePort
  decisionProvider: Tm1RegtestAuthorizationDecisionProvider
  now: () => number
  ttlMs: number
  createOperationId: () => string
  requester: Tm1RegtestAuthorizationRequester
}>

export type Tm1RegtestAuthorizationAdapterErrorCode =
  | 'AUTHORIZATION_ALREADY_ACTIVE'
  | 'INVALID_AUTHORIZATION_CONFIGURATION'
  | 'INVALID_AUTHORIZATION_REQUEST'
  | 'INVALID_AUTHORIZATION_DECISION'
  | 'INVALID_AUTHORIZATION_GRANT'
  | 'AUTHORIZATION_CORE_FAILED'
  | 'AUTHORIZATION_PROVIDER_FAILED'

export class Tm1RegtestAuthorizationAdapterError extends Error {
  readonly code: Tm1RegtestAuthorizationAdapterErrorCode

  constructor(code: Tm1RegtestAuthorizationAdapterErrorCode) {
    super(code)
    this.name = 'Tm1RegtestAuthorizationAdapterError'
    this.code = code
  }
}

type SnapshottedDependencies = Readonly<{
  startAuthorization: UniversalAuthorizationCore['startAuthorization']
  requestDecision: Tm1RegtestAuthorizationDecisionProvider['requestDecision']
  now: () => number
  ttlMs: number
  createOperationId: () => string
  requester: Tm1RegtestAuthorizationRequester
}>

type SafeAuthorizationHandle = Readonly<{
  operationId: string
  ready: Promise<unknown>
  authorize: () => Promise<unknown>
  reject: () => void
  cleanup: () => void
  signal: AbortSignal
  state: () => UniversalAuthorizationState
}>

type RequestSnapshot = Readonly<{
  preparedId: string
  bindingHash: string
  review: Tm1RegtestAuthorizationReviewSnapshot
}>

type ProviderDecisionWaitResult = Readonly<
  | { status: 'decision'; value: unknown }
  | { status: 'cancelled' }
>

const PROVIDER_CANCELLED = Object.freeze({ status: 'cancelled' as const })

export class Tm1RegtestAuthorizationAdapter
implements Tm1SigningAuthorizationPort {
  private readonly dependencies: SnapshottedDependencies
  private active = false

  constructor(dependencies: Tm1RegtestAuthorizationAdapterDependencies) {
    try {
      if (
        typeof dependencies.now !== 'function' ||
        typeof dependencies.createOperationId !== 'function' ||
        !Number.isSafeInteger(dependencies.ttlMs) ||
        dependencies.ttlMs <= 0
      ) {
        throw new Tm1RegtestAuthorizationAdapterError('INVALID_AUTHORIZATION_CONFIGURATION')
      }
      const core = dependencies.core
      const decisionProvider = dependencies.decisionProvider
      if (
        !core ||
        typeof core.startAuthorization !== 'function' ||
        !decisionProvider ||
        typeof decisionProvider.requestDecision !== 'function'
      ) {
        throw new Tm1RegtestAuthorizationAdapterError('INVALID_AUTHORIZATION_CONFIGURATION')
      }
      const requester = Object.freeze({
        declaredOrigin: requireNonEmptyString(
          dependencies.requester.declaredOrigin,
          'INVALID_AUTHORIZATION_CONFIGURATION'
        ),
        displayName: requireNonEmptyString(
          dependencies.requester.displayName,
          'INVALID_AUTHORIZATION_CONFIGURATION'
        )
      })
      this.dependencies = Object.freeze({
        startAuthorization: core.startAuthorization.bind(core),
        requestDecision: decisionProvider.requestDecision.bind(decisionProvider),
        now: dependencies.now,
        ttlMs: dependencies.ttlMs,
        createOperationId: dependencies.createOperationId,
        requester
      })
    } catch (error) {
      if (error instanceof Tm1RegtestAuthorizationAdapterError) throw error
      throw new Tm1RegtestAuthorizationAdapterError('INVALID_AUTHORIZATION_CONFIGURATION')
    }
  }

  async requestSigningAuthorization(
    request: Tm1SigningAuthorizationRequest,
    signal?: AbortSignal
  ): Promise<Tm1PublicationAuthorizationDecision> {
    if (this.active) {
      throw new Tm1RegtestAuthorizationAdapterError('AUTHORIZATION_ALREADY_ACTIVE')
    }
    this.active = true
    let handle: SafeAuthorizationHandle | null = null

    try {
      assertExternalNotAborted(signal)
      const snapshot = snapshotSigningRequest(request)
      assertExternalNotAborted(signal)

      const issuedAt = this.readNow(signal)
      const expiresAt = issuedAt + this.dependencies.ttlMs
      if (!Number.isSafeInteger(expiresAt) || expiresAt <= issuedAt) {
        throw new Tm1RegtestAuthorizationAdapterError('INVALID_AUTHORIZATION_CONFIGURATION')
      }
      const operationId = this.createOperationId(signal)
      const universalReview = buildUniversalReview(snapshot)
      const envelope: UniversalAuthorizationEnvelopeV1 = Object.freeze({
        schema: UNIVERSAL_AUTHORIZATION_SCHEMA,
        version: UNIVERSAL_AUTHORIZATION_VERSION,
        operationId,
        profileId: TM1_REGTEST_SIGNING_AUTHORIZATION_PROFILE_ID,
        issuedAt,
        expiresAt,
        requester: this.dependencies.requester
      })
      const universalAdapter = createUniversalReviewAdapter(universalReview)

      let rawHandle: unknown
      try {
        rawHandle = this.dependencies.startAuthorization(
          envelope,
          universalAdapter,
          { signal }
        )
        assertExternalNotAborted(signal)
        handle = snapshotAuthorizationHandle(rawHandle, operationId)
      } catch {
        assertExternalNotAborted(signal)
        throw new Tm1RegtestAuthorizationAdapterError('AUTHORIZATION_CORE_FAILED')
      }

      let rawPrepared: unknown
      try {
        rawPrepared = await handle.ready
      } catch {
        const terminal = classifyTerminal(handle, signal)
        if (terminal) return terminal
        throw new Tm1RegtestAuthorizationAdapterError('AUTHORIZATION_CORE_FAILED')
      }
      const terminalAfterReady = classifyTerminal(handle, signal)
      if (terminalAfterReady) return terminalAfterReady
      const prepared = snapshotPreparedAuthorization(
        rawPrepared,
        operationId,
        universalReview
      )

      const providerRequest = freezeProviderRequest({
        operationId,
        preparedId: snapshot.preparedId,
        bindingHash: snapshot.bindingHash,
        review: snapshot.review,
        expiresAt,
        contentHash: prepared.contentHash
      })
      let providerResult: ProviderDecisionWaitResult
      try {
        providerResult = await awaitProviderDecisionOrCancellation(
          this.dependencies.requestDecision,
          providerRequest,
          handle.signal
        )
      } catch {
        const terminal = classifyTerminal(handle, signal)
        if (terminal) return terminal
        throw new Tm1RegtestAuthorizationAdapterError('AUTHORIZATION_PROVIDER_FAILED')
      }
      if (providerResult.status === 'cancelled') {
        const terminal = classifyTerminal(handle, signal)
        if (terminal) return terminal
        throw new Tm1RegtestAuthorizationAdapterError('AUTHORIZATION_CORE_FAILED')
      }
      const rawDecision = providerResult.value
      const terminalAfterDecision = classifyTerminal(handle, signal)
      if (terminalAfterDecision) return terminalAfterDecision
      const decision = snapshotProviderDecision(rawDecision)

      if (decision.status === 'rejected') {
        try {
          handle.reject()
        } catch {
          throw new Tm1RegtestAuthorizationAdapterError('AUTHORIZATION_CORE_FAILED')
        }
        const terminalAfterReject = classifyTerminal(handle, signal)
        if (terminalAfterReject) return terminalAfterReject
        assertExternalNotAborted(signal)
        if (safeHandleState(handle) !== 'rejected') {
          throw new Tm1RegtestAuthorizationAdapterError('AUTHORIZATION_CORE_FAILED')
        }
        return decision.reason === undefined
          ? Object.freeze({ status: 'rejected' })
          : Object.freeze({ status: 'rejected', reason: decision.reason })
      }

      const terminalBeforeAuthorize = classifyTerminal(handle, signal)
      if (terminalBeforeAuthorize) return terminalBeforeAuthorize
      let rawGrant: unknown
      try {
        rawGrant = await handle.authorize()
      } catch {
        const terminal = classifyTerminal(handle, signal)
        if (terminal) return terminal
        throw new Tm1RegtestAuthorizationAdapterError('AUTHORIZATION_CORE_FAILED')
      }
      assertExternalNotAborted(signal)
      if (safeHandleState(handle) !== 'authorized') {
        throw new Tm1RegtestAuthorizationAdapterError('INVALID_AUTHORIZATION_GRANT')
      }
      const grant = snapshotGrant(rawGrant, {
        operationId,
        contentHash: prepared.contentHash,
        expiresAt
      })
      if (this.readNow(signal) >= grant.expiresAt) {
        return Object.freeze({ status: 'expired', reason: EXPIRED_REASON })
      }
      assertExternalNotAborted(signal)

      return Object.freeze({
        status: 'approved',
        authorizationId: grant.authorizationId,
        preparedId: snapshot.preparedId,
        bindingHash: snapshot.bindingHash
      })
    } finally {
      cleanupHandle(handle)
      this.active = false
    }
  }

  private readNow(signal?: AbortSignal): number {
    let value: unknown
    try {
      value = this.dependencies.now()
    } catch {
      throw new Tm1RegtestAuthorizationAdapterError('INVALID_AUTHORIZATION_CONFIGURATION')
    }
    assertExternalNotAborted(signal)
    if (!Number.isSafeInteger(value)) {
      throw new Tm1RegtestAuthorizationAdapterError('INVALID_AUTHORIZATION_CONFIGURATION')
    }
    return value as number
  }

  private createOperationId(signal?: AbortSignal): string {
    let value: unknown
    try {
      value = this.dependencies.createOperationId()
    } catch {
      throw new Tm1RegtestAuthorizationAdapterError('INVALID_AUTHORIZATION_CONFIGURATION')
    }
    assertExternalNotAborted(signal)
    return requireNonEmptyString(value, 'INVALID_AUTHORIZATION_CONFIGURATION')
  }
}

function awaitProviderDecisionOrCancellation(
  requestDecision: Tm1RegtestAuthorizationDecisionProvider['requestDecision'],
  request: Tm1RegtestAuthorizationDecisionRequest,
  signal: AbortSignal
): Promise<ProviderDecisionWaitResult> {
  if (signal.aborted) return Promise.resolve(PROVIDER_CANCELLED)

  let providerPromise: Promise<unknown>
  try {
    providerPromise = Promise.resolve(requestDecision(request, signal))
  } catch (error) {
    return Promise.reject(error)
  }

  // The provider may reject after cancellation wins. Keep the original
  // promise observed independently of the race so that rejection stays safe.
  void providerPromise.catch(() => undefined)

  return new Promise((resolve, reject) => {
    let settled = false
    const finish = (continuation: () => void) => {
      if (settled) return
      settled = true
      signal.removeEventListener('abort', onAbort)
      continuation()
    }
    const onAbort = () => finish(() => resolve(PROVIDER_CANCELLED))

    signal.addEventListener('abort', onAbort, { once: true })
    if (signal.aborted) {
      onAbort()
      return
    }
    providerPromise.then(
      value => finish(() => resolve(Object.freeze({ status: 'decision', value }))),
      error => finish(() => reject(error))
    )
  })
}

export function encodeTm1RegtestSigningAuthorizationPayload(input: Readonly<{
  preparedId: string
  bindingHash: string
}>): Uint8Array {
  const preparedId = requireNonEmptyString(input.preparedId, 'INVALID_AUTHORIZATION_REQUEST')
  const bindingHash = requireCanonicalHash(input.bindingHash, 'INVALID_AUTHORIZATION_REQUEST')
  const domainBytes = new TextEncoder().encode(TM1_REGTEST_SIGNING_AUTHORIZATION_PAYLOAD_DOMAIN)
  const preparedIdBytes = new TextEncoder().encode(preparedId)
  const bindingBytes = hexToBytes(bindingHash)
  const payload = new Uint8Array(
    4 + domainBytes.length + 4 + preparedIdBytes.length + bindingBytes.length
  )
  let offset = 0
  offset = writeLengthPrefixed(payload, offset, domainBytes)
  offset = writeLengthPrefixed(payload, offset, preparedIdBytes)
  payload.set(bindingBytes, offset)
  return payload
}

function snapshotSigningRequest(value: unknown): RequestSnapshot {
  try {
    const preparedId = requireNonEmptyString(
      readOwnData(value, 'preparedId'),
      'INVALID_AUTHORIZATION_REQUEST'
    )
    const bindingHash = requireCanonicalHash(
      readOwnData(value, 'bindingHash'),
      'INVALID_AUTHORIZATION_REQUEST'
    )
    const review = readOwnData(value, 'review')
    const nestedPreparedId = requireNonEmptyString(
      readOwnData(review, 'preparedId'),
      'INVALID_AUTHORIZATION_REQUEST'
    )
    const nestedBindingHash = requireCanonicalHash(
      readOwnData(review, 'bindingHash'),
      'INVALID_AUTHORIZATION_REQUEST'
    )
    if (nestedPreparedId !== preparedId || nestedBindingHash !== bindingHash) {
      throw new Tm1RegtestAuthorizationAdapterError('INVALID_AUTHORIZATION_REQUEST')
    }
    const message = requireString(
      readOwnData(review, 'message'),
      'INVALID_AUTHORIZATION_REQUEST'
    )
    const networkValue = readOwnData(review, 'network')
    const environment = readOwnData(networkValue, 'environment')
    const chainIdentity = requireNonEmptyString(
      readOwnData(networkValue, 'chainIdentity'),
      'INVALID_AUTHORIZATION_REQUEST'
    )
    if (environment !== TM1_DRAFT_02_CANDIDATE_ENVIRONMENT) {
      throw new Tm1RegtestAuthorizationAdapterError('INVALID_AUTHORIZATION_REQUEST')
    }
    const effectiveContent = cloneBytes(
      readOwnData(review, 'effectiveContent'),
      'INVALID_AUTHORIZATION_REQUEST'
    )
    if (effectiveContent.length === 0) {
      throw new Tm1RegtestAuthorizationAdapterError('INVALID_AUTHORIZATION_REQUEST')
    }
    if (toHex(sha256d(effectiveContent)) !== bindingHash) {
      throw new Tm1RegtestAuthorizationAdapterError('INVALID_AUTHORIZATION_REQUEST')
    }
    const orderedInputs = snapshotInputs(readOwnData(review, 'orderedInputs'))
    const orderedOutputs = snapshotOutputs(readOwnData(review, 'orderedOutputs'))
    const feeSats = readOwnData(review, 'feeSats')
    if (typeof feeSats !== 'bigint' || feeSats < 0n) {
      throw new Tm1RegtestAuthorizationAdapterError('INVALID_AUTHORIZATION_REQUEST')
    }
    return Object.freeze({
      preparedId,
      bindingHash,
      review: Object.freeze({
        preparedId,
        bindingHash,
        message,
        network: Object.freeze({ environment, chainIdentity }),
        effectiveContent,
        orderedInputs,
        orderedOutputs,
        feeSats
      })
    })
  } catch (error) {
    if (error instanceof Tm1RegtestAuthorizationAdapterError) throw error
    throw new Tm1RegtestAuthorizationAdapterError('INVALID_AUTHORIZATION_REQUEST')
  }
}

function snapshotInputs(value: unknown): readonly Tm1PublicationInput[] {
  const items = snapshotArray(value, 'INVALID_AUTHORIZATION_REQUEST')
  if (items.length === 0) {
    throw new Tm1RegtestAuthorizationAdapterError('INVALID_AUTHORIZATION_REQUEST')
  }
  return Object.freeze(items.map((item, position) => {
    const index = readOwnData(item, 'index')
    const role = readOwnData(item, 'role')
    const txid = readOwnData(item, 'txid')
    const outIdx = readOwnData(item, 'outIdx')
    const sats = readOwnData(item, 'sats')
    const lockingScriptHex = readOwnData(item, 'lockingScriptHex')
    if (
      index !== position ||
      (role !== 'author' && role !== 'funding') ||
      typeof txid !== 'string' ||
      !/^[0-9a-f]{64}$/.test(txid) ||
      typeof outIdx !== 'number' ||
      !Number.isSafeInteger(outIdx) ||
      outIdx < 0 ||
      outIdx > UINT32_MAX ||
      typeof sats !== 'bigint' ||
      sats <= 0n ||
      typeof lockingScriptHex !== 'string' ||
      !isCanonicalHex(lockingScriptHex)
    ) {
      throw new Tm1RegtestAuthorizationAdapterError('INVALID_AUTHORIZATION_REQUEST')
    }
    return Object.freeze({ index, role, txid, outIdx, sats, lockingScriptHex })
  }))
}

function snapshotOutputs(value: unknown): readonly Tm1PublicationOutput[] {
  const items = snapshotArray(value, 'INVALID_AUTHORIZATION_REQUEST')
  if (items.length === 0) {
    throw new Tm1RegtestAuthorizationAdapterError('INVALID_AUTHORIZATION_REQUEST')
  }
  return Object.freeze(items.map((item, position) => {
    const index = readOwnData(item, 'index')
    const role = readOwnData(item, 'role')
    const sats = readOwnData(item, 'sats')
    const scriptHex = readOwnData(item, 'scriptHex')
    if (
      index !== position ||
      (role !== 'tm1_op_return' && role !== 'change') ||
      typeof sats !== 'bigint' ||
      sats < 0n ||
      typeof scriptHex !== 'string' ||
      !isCanonicalHex(scriptHex)
    ) {
      throw new Tm1RegtestAuthorizationAdapterError('INVALID_AUTHORIZATION_REQUEST')
    }
    return Object.freeze({ index, role, sats, scriptHex })
  }))
}

function buildUniversalReview(snapshot: RequestSnapshot): UniversalReviewSnapshot {
  const fields: readonly UniversalReviewField[] = Object.freeze([
    Object.freeze({ label: 'Profile', value: TM1_REGTEST_SIGNING_AUTHORIZATION_PROFILE_ID }),
    Object.freeze({ label: 'Intent', value: 'Authorize TM1 regtest signing; no signing or broadcast' }),
    Object.freeze({ label: 'Prepared ID', value: snapshot.preparedId }),
    Object.freeze({ label: 'Binding hash', value: snapshot.bindingHash }),
    Object.freeze({ label: 'Environment', value: snapshot.review.network.environment }),
    Object.freeze({ label: 'Chain identity', value: snapshot.review.network.chainIdentity }),
    Object.freeze({ label: 'Message', value: snapshot.review.message }),
    Object.freeze({ label: 'Inputs', value: snapshot.review.orderedInputs.length.toString() }),
    Object.freeze({ label: 'Outputs', value: snapshot.review.orderedOutputs.length.toString() }),
    Object.freeze({ label: 'Fee sats', value: snapshot.review.feeSats.toString() })
  ])
  return Object.freeze({
    fields,
    effectiveContent: encodeTm1RegtestSigningAuthorizationPayload(snapshot)
  })
}

function createUniversalReviewAdapter(
  expected: UniversalReviewSnapshot
): UniversalReviewAuthorizationAdapter {
  return Object.freeze({
    profileId: TM1_REGTEST_SIGNING_AUTHORIZATION_PROFILE_ID,
    async prepareReview(
      _envelope: UniversalAuthorizationEnvelopeV1,
      signal: AbortSignal
    ) {
      assertInternalNotAborted(signal)
      return cloneUniversalReview(expected)
    },
    async revalidateReview(
      _envelope: UniversalAuthorizationEnvelopeV1,
      _approvedReview: UniversalReviewSnapshot,
      signal: AbortSignal
    ) {
      assertInternalNotAborted(signal)
      return cloneUniversalReview(expected)
    }
  })
}

function cloneUniversalReview(review: UniversalReviewSnapshot): UniversalReviewSnapshot {
  return Object.freeze({
    fields: Object.freeze(review.fields.map(field => Object.freeze({
      label: field.label,
      value: field.value
    }))),
    effectiveContent: new Uint8Array(review.effectiveContent)
  })
}

function snapshotAuthorizationHandle(
  value: unknown,
  expectedOperationId: string
): SafeAuthorizationHandle {
  try {
    const operationId = requireNonEmptyString(
      readOwnData(value, 'operationId'),
      'AUTHORIZATION_CORE_FAILED'
    )
    const ready = readOwnData(value, 'ready')
    const authorize = readOwnData(value, 'authorize')
    const reject = readOwnData(value, 'reject')
    const cleanup = readOwnData(value, 'cleanup')
    const signal = readOwnData(value, 'signal')
    const state = readOwnData(value, 'state')
    if (
      operationId !== expectedOperationId ||
      typeof authorize !== 'function' ||
      typeof reject !== 'function' ||
      typeof cleanup !== 'function' ||
      typeof state !== 'function' ||
      !(signal instanceof AbortSignal)
    ) {
      throw new Tm1RegtestAuthorizationAdapterError('AUTHORIZATION_CORE_FAILED')
    }
    return Object.freeze({
      operationId,
      ready: Promise.resolve(ready),
      authorize: () => Promise.resolve(authorize()),
      reject: () => { reject() },
      cleanup: () => { cleanup() },
      signal,
      state: () => state() as UniversalAuthorizationState
    })
  } catch (error) {
    if (error instanceof Tm1RegtestAuthorizationAdapterError) throw error
    throw new Tm1RegtestAuthorizationAdapterError('AUTHORIZATION_CORE_FAILED')
  }
}

function snapshotPreparedAuthorization(
  value: unknown,
  expectedOperationId: string,
  expectedReview: UniversalReviewSnapshot
): Readonly<{ contentHash: UniversalContentHash }> {
  try {
    const operationId = requireNonEmptyString(
      readOwnData(value, 'operationId'),
      'AUTHORIZATION_CORE_FAILED'
    )
    const contentHash = requireUniversalContentHash(
      readOwnData(value, 'contentHash'),
      'AUTHORIZATION_CORE_FAILED'
    )
    const reviewValue = readOwnData(value, 'review')
    const fields = snapshotUniversalFields(readOwnData(reviewValue, 'fields'))
    const effectiveContent = cloneBytes(
      readOwnData(reviewValue, 'effectiveContent'),
      'AUTHORIZATION_CORE_FAILED'
    )
    if (
      operationId !== expectedOperationId ||
      !fieldsEqual(fields, expectedReview.fields) ||
      !bytesEqual(effectiveContent, expectedReview.effectiveContent)
    ) {
      throw new Tm1RegtestAuthorizationAdapterError('AUTHORIZATION_CORE_FAILED')
    }
    return Object.freeze({ contentHash })
  } catch (error) {
    if (error instanceof Tm1RegtestAuthorizationAdapterError) throw error
    throw new Tm1RegtestAuthorizationAdapterError('AUTHORIZATION_CORE_FAILED')
  }
}

function snapshotUniversalFields(value: unknown): readonly UniversalReviewField[] {
  return Object.freeze(snapshotArray(value, 'AUTHORIZATION_CORE_FAILED').map(item => Object.freeze({
    label: requireString(readOwnData(item, 'label'), 'AUTHORIZATION_CORE_FAILED'),
    value: requireString(readOwnData(item, 'value'), 'AUTHORIZATION_CORE_FAILED')
  })))
}

function freezeProviderRequest(
  value: Tm1RegtestAuthorizationDecisionRequest
): Tm1RegtestAuthorizationDecisionRequest {
  return Object.freeze({
    operationId: value.operationId,
    preparedId: value.preparedId,
    bindingHash: value.bindingHash,
    review: cloneAuthorizationReview(value.review),
    expiresAt: value.expiresAt,
    contentHash: value.contentHash
  })
}

function cloneAuthorizationReview(
  review: Tm1RegtestAuthorizationReviewSnapshot
): Tm1RegtestAuthorizationReviewSnapshot {
  return Object.freeze({
    preparedId: review.preparedId,
    bindingHash: review.bindingHash,
    message: review.message,
    network: Object.freeze({ ...review.network }),
    effectiveContent: new Uint8Array(review.effectiveContent),
    orderedInputs: Object.freeze(review.orderedInputs.map(input => Object.freeze({ ...input }))),
    orderedOutputs: Object.freeze(review.orderedOutputs.map(output => Object.freeze({ ...output }))),
    feeSats: review.feeSats
  })
}

function snapshotProviderDecision(value: unknown): Tm1RegtestAuthorizationProviderDecision {
  try {
    const status = readOwnData(value, 'status')
    if (status === 'approved') return Object.freeze({ status })
    if (status === 'rejected') {
      const reason = readOptionalString(value, 'reason', 'INVALID_AUTHORIZATION_DECISION')
      return reason === undefined
        ? Object.freeze({ status })
        : Object.freeze({ status, reason })
    }
    throw new Tm1RegtestAuthorizationAdapterError('INVALID_AUTHORIZATION_DECISION')
  } catch (error) {
    if (error instanceof Tm1RegtestAuthorizationAdapterError) throw error
    throw new Tm1RegtestAuthorizationAdapterError('INVALID_AUTHORIZATION_DECISION')
  }
}

function snapshotGrant(
  value: unknown,
  expected: Readonly<{
    operationId: string
    contentHash: UniversalContentHash
    expiresAt: number
  }>
): UniversalAuthorizationGrant {
  try {
    const authorizationId = requireNonEmptyString(
      readOwnData(value, 'authorizationId'),
      'INVALID_AUTHORIZATION_GRANT'
    )
    const operationId = requireNonEmptyString(
      readOwnData(value, 'operationId'),
      'INVALID_AUTHORIZATION_GRANT'
    )
    const contentHash = requireUniversalContentHash(
      readOwnData(value, 'contentHash'),
      'INVALID_AUTHORIZATION_GRANT'
    )
    const expiresAt = readOwnData(value, 'expiresAt')
    if (
      operationId !== expected.operationId ||
      contentHash !== expected.contentHash ||
      expiresAt !== expected.expiresAt ||
      !Number.isSafeInteger(expiresAt)
    ) {
      throw new Tm1RegtestAuthorizationAdapterError('INVALID_AUTHORIZATION_GRANT')
    }
    return Object.freeze({ authorizationId, operationId, contentHash, expiresAt })
  } catch (error) {
    if (error instanceof Tm1RegtestAuthorizationAdapterError) throw error
    throw new Tm1RegtestAuthorizationAdapterError('INVALID_AUTHORIZATION_GRANT')
  }
}

function classifyTerminal(
  handle: SafeAuthorizationHandle,
  externalSignal?: AbortSignal
): Extract<Tm1PublicationAuthorizationDecision, { status: 'expired' }> | null {
  assertExternalNotAborted(externalSignal)
  const state = safeHandleState(handle)
  if (state === 'expired') {
    return Object.freeze({ status: 'expired', reason: EXPIRED_REASON })
  }
  if (state === 'aborted') throw createAbortError()
  if (state === 'failed') {
    throw new Tm1RegtestAuthorizationAdapterError('AUTHORIZATION_CORE_FAILED')
  }
  return null
}

function safeHandleState(handle: SafeAuthorizationHandle): UniversalAuthorizationState | undefined {
  try {
    const state = handle.state()
    return typeof state === 'string' ? state : undefined
  } catch {
    return undefined
  }
}

function cleanupHandle(handle: SafeAuthorizationHandle | null): void {
  if (!handle) return
  const state = safeHandleState(handle)
  if (
    state === 'authorized' ||
    state === 'completed' ||
    state === 'rejected' ||
    state === 'expired' ||
    state === 'aborted' ||
    state === 'failed'
  ) return
  try {
    handle.cleanup()
  } catch {
    // The adapter guard is still released; the core owns any remaining lease.
  }
}

function assertExternalNotAborted(signal?: AbortSignal): void {
  if (signal?.aborted) throw createAbortError()
}

function assertInternalNotAborted(signal: AbortSignal): void {
  if (signal.aborted) throw createAbortError()
}

function createAbortError(): Error {
  if (typeof DOMException !== 'undefined') return new DOMException('ABORTED', 'AbortError')
  const error = new Error('ABORTED')
  error.name = 'AbortError'
  return error
}

function readOwnData(value: unknown, key: PropertyKey): unknown {
  if (value === null || (typeof value !== 'object' && typeof value !== 'function')) {
    throw new Error('Invalid external object')
  }
  const descriptor = Object.getOwnPropertyDescriptor(value, key)
  if (descriptor === undefined || !('value' in descriptor)) {
    throw new Error(`Missing data property: ${String(key)}`)
  }
  return descriptor.value
}

function readOptionalString(
  value: unknown,
  key: PropertyKey,
  code: Tm1RegtestAuthorizationAdapterErrorCode
): string | undefined {
  if (value === null || (typeof value !== 'object' && typeof value !== 'function')) {
    throw new Tm1RegtestAuthorizationAdapterError(code)
  }
  const descriptor = Object.getOwnPropertyDescriptor(value, key)
  if (descriptor === undefined) return undefined
  if (!('value' in descriptor) || (descriptor.value !== undefined && typeof descriptor.value !== 'string')) {
    throw new Tm1RegtestAuthorizationAdapterError(code)
  }
  return descriptor.value
}

function snapshotArray(
  value: unknown,
  code: Tm1RegtestAuthorizationAdapterErrorCode
): unknown[] {
  if (!Array.isArray(value)) throw new Tm1RegtestAuthorizationAdapterError(code)
  const length = readOwnData(value, 'length')
  if (typeof length !== 'number' || !Number.isSafeInteger(length) || length < 0) {
    throw new Tm1RegtestAuthorizationAdapterError(code)
  }
  const snapshot = new Array<unknown>(length)
  for (let index = 0; index < length; index += 1) {
    snapshot[index] = readOwnData(value, String(index))
  }
  return snapshot
}

function cloneBytes(
  value: unknown,
  code: Tm1RegtestAuthorizationAdapterErrorCode
): Uint8Array {
  if (!(value instanceof Uint8Array)) throw new Tm1RegtestAuthorizationAdapterError(code)
  return new Uint8Array(value)
}

function requireString(
  value: unknown,
  code: Tm1RegtestAuthorizationAdapterErrorCode
): string {
  if (typeof value !== 'string') throw new Tm1RegtestAuthorizationAdapterError(code)
  return value
}

function requireNonEmptyString(
  value: unknown,
  code: Tm1RegtestAuthorizationAdapterErrorCode
): string {
  if (typeof value !== 'string' || value.trim().length === 0) {
    throw new Tm1RegtestAuthorizationAdapterError(code)
  }
  return value
}

function requireCanonicalHash(
  value: unknown,
  code: Tm1RegtestAuthorizationAdapterErrorCode
): string {
  if (typeof value !== 'string' || !/^[0-9a-f]{64}$/.test(value)) {
    throw new Tm1RegtestAuthorizationAdapterError(code)
  }
  return value
}

function requireUniversalContentHash(
  value: unknown,
  code: Tm1RegtestAuthorizationAdapterErrorCode
): UniversalContentHash {
  if (typeof value !== 'string' || !/^sha256:[0-9a-f]{64}$/.test(value)) {
    throw new Tm1RegtestAuthorizationAdapterError(code)
  }
  return value as UniversalContentHash
}

function isCanonicalHex(value: string): boolean {
  return value.length > 0 && value.length % 2 === 0 && /^[0-9a-f]+$/.test(value)
}

function fieldsEqual(
  left: readonly UniversalReviewField[],
  right: readonly UniversalReviewField[]
): boolean {
  if (left.length !== right.length) return false
  for (let index = 0; index < left.length; index += 1) {
    if (left[index].label !== right[index].label || left[index].value !== right[index].value) {
      return false
    }
  }
  return true
}

function bytesEqual(left: Uint8Array, right: Uint8Array): boolean {
  if (left.length !== right.length) return false
  let difference = 0
  for (let index = 0; index < left.length; index += 1) {
    difference |= left[index] ^ right[index]
  }
  return difference === 0
}

function writeLengthPrefixed(target: Uint8Array, offset: number, bytes: Uint8Array): number {
  if (bytes.length > UINT32_MAX) {
    throw new Tm1RegtestAuthorizationAdapterError('INVALID_AUTHORIZATION_REQUEST')
  }
  new DataView(target.buffer, target.byteOffset, target.byteLength).setUint32(
    offset,
    bytes.length,
    false
  )
  target.set(bytes, offset + 4)
  return offset + 4 + bytes.length
}

function hexToBytes(hex: string): Uint8Array {
  const bytes = new Uint8Array(hex.length / 2)
  for (let index = 0; index < bytes.length; index += 1) {
    bytes[index] = Number.parseInt(hex.slice(index * 2, index * 2 + 2), 16)
  }
  return bytes
}
