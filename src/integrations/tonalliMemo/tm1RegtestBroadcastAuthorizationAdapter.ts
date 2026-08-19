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
import type {
  Tm1BroadcastAuthorizationDecision,
  Tm1PublicationOutput,
  Tm1BroadcastAuthorizationPort,
  Tm1SignedReview
} from './tm1RegtestPublicationOrchestrator'

export const TM1_REGTEST_BROADCAST_AUTHORIZATION_PROFILE_ID =
  'tonalli.tm1-regtest.broadcast-authorization.v1'

export const TM1_REGTEST_BROADCAST_AUTHORIZATION_PAYLOAD_DOMAIN =
  'tonalli.tm1-regtest/broadcast-authorization/v1'

const EXPIRED_REASON = 'TM1 broadcast authorization expired'
const UINT32_MAX = 0xffffffff

export type Tm1RegtestBroadcastAuthorizationProviderDecision = Readonly<
  | { status: 'approved' }
  | { status: 'rejected'; reason?: string }
>

export type Tm1RegtestBroadcastAuthorizationReviewSnapshot = Readonly<{
  preparedId: string
  signedId: string
  txid: string
  signedArtifactHash: string
  bindingHash: string
  orderedOutputs: readonly Tm1PublicationOutput[]
  feeSats: bigint
  signedArtifact: Readonly<{
    format: string
    artifactVersion: number
    environment: string
    sighashPolicy: string
    fixturePublicKeyHex: string
    fixtureLockingScriptHex: string
    inputCount: number
    feeSats: bigint
    txid: string
    rawTransactionByteLength: number
  }>
}>

export type Tm1RegtestBroadcastAuthorizationDecisionRequest = Readonly<{
  operationId: string
  signedId: string
  txid: string
  signedArtifactHash: string
  review: Tm1RegtestBroadcastAuthorizationReviewSnapshot
  expiresAt: number
  contentHash: UniversalContentHash
}>

export interface Tm1RegtestBroadcastAuthorizationDecisionProvider {
  requestDecision(
    request: Tm1RegtestBroadcastAuthorizationDecisionRequest,
    signal: AbortSignal
  ): Promise<Tm1RegtestBroadcastAuthorizationProviderDecision>
}

export type Tm1RegtestBroadcastAuthorizationRequester = Readonly<{
  declaredOrigin: string
  displayName: string
}>

export type Tm1RegtestBroadcastAuthorizationCorePort = Pick<
  UniversalAuthorizationCore,
  'startAuthorization'
>

export type Tm1RegtestBroadcastAuthorizationAdapterDependencies = Readonly<{
  core: Tm1RegtestBroadcastAuthorizationCorePort
  decisionProvider: Tm1RegtestBroadcastAuthorizationDecisionProvider
  now: () => number
  ttlMs: number
  createOperationId: () => string
  requester: Tm1RegtestBroadcastAuthorizationRequester
}>

export type Tm1RegtestBroadcastAuthorizationAdapterErrorCode =
  | 'AUTHORIZATION_ALREADY_ACTIVE'
  | 'INVALID_AUTHORIZATION_CONFIGURATION'
  | 'INVALID_AUTHORIZATION_REQUEST'
  | 'INVALID_AUTHORIZATION_DECISION'
  | 'INVALID_AUTHORIZATION_GRANT'
  | 'AUTHORIZATION_CORE_FAILED'
  | 'AUTHORIZATION_PROVIDER_FAILED'

export class Tm1RegtestBroadcastAuthorizationAdapterError extends Error {
  readonly code: Tm1RegtestBroadcastAuthorizationAdapterErrorCode

  constructor(code: Tm1RegtestBroadcastAuthorizationAdapterErrorCode) {
    super(code)
    this.name = 'Tm1RegtestBroadcastAuthorizationAdapterError'
    this.code = code
  }
}

type SnapshottedDependencies = Readonly<{
  startAuthorization: UniversalAuthorizationCore['startAuthorization']
  requestDecision: Tm1RegtestBroadcastAuthorizationDecisionProvider['requestDecision']
  now: () => number
  ttlMs: number
  createOperationId: () => string
  requester: Tm1RegtestBroadcastAuthorizationRequester
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
  signedId: string
  txid: string
  signedArtifactHash: string
  signingAuthorizationId: string
  review: Tm1RegtestBroadcastAuthorizationReviewSnapshot
}>

type ProviderDecisionWaitResult = Readonly<
  | { status: 'decision'; value: unknown }
  | { status: 'cancelled' }
>

const PROVIDER_CANCELLED = Object.freeze({ status: 'cancelled' as const })

export class Tm1RegtestBroadcastAuthorizationAdapter
implements Tm1BroadcastAuthorizationPort {
  private readonly dependencies: SnapshottedDependencies
  private active = false

  constructor(dependencies: Tm1RegtestBroadcastAuthorizationAdapterDependencies) {
    try {
      if (
        typeof dependencies.now !== 'function' ||
        typeof dependencies.createOperationId !== 'function' ||
        !Number.isSafeInteger(dependencies.ttlMs) ||
        dependencies.ttlMs <= 0
      ) {
        throw new Tm1RegtestBroadcastAuthorizationAdapterError('INVALID_AUTHORIZATION_CONFIGURATION')
      }
      const core = dependencies.core
      const decisionProvider = dependencies.decisionProvider
      if (
        !core ||
        typeof core.startAuthorization !== 'function' ||
        !decisionProvider ||
        typeof decisionProvider.requestDecision !== 'function'
      ) {
        throw new Tm1RegtestBroadcastAuthorizationAdapterError('INVALID_AUTHORIZATION_CONFIGURATION')
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
      if (error instanceof Tm1RegtestBroadcastAuthorizationAdapterError) throw error
      throw new Tm1RegtestBroadcastAuthorizationAdapterError('INVALID_AUTHORIZATION_CONFIGURATION')
    }
  }

  async requestBroadcastAuthorization(
    request: Tm1SignedReview,
    signal?: AbortSignal
  ): Promise<Tm1BroadcastAuthorizationDecision> {
    if (this.active) {
      throw new Tm1RegtestBroadcastAuthorizationAdapterError('AUTHORIZATION_ALREADY_ACTIVE')
    }
    this.active = true
    let handle: SafeAuthorizationHandle | null = null

    try {
      assertExternalNotAborted(signal)
      const snapshot = snapshotSignedReview(request)
      assertExternalNotAborted(signal)

      const issuedAt = this.readNow(signal)
      const expiresAt = issuedAt + this.dependencies.ttlMs
      if (!Number.isSafeInteger(expiresAt) || expiresAt <= issuedAt) {
        throw new Tm1RegtestBroadcastAuthorizationAdapterError('INVALID_AUTHORIZATION_CONFIGURATION')
      }
      const operationId = this.createOperationId(signal)
      const universalReview = buildUniversalReview(snapshot)
      const envelope: UniversalAuthorizationEnvelopeV1 = Object.freeze({
        schema: UNIVERSAL_AUTHORIZATION_SCHEMA,
        version: UNIVERSAL_AUTHORIZATION_VERSION,
        operationId,
        profileId: TM1_REGTEST_BROADCAST_AUTHORIZATION_PROFILE_ID,
        issuedAt,
        expiresAt,
        requester: this.dependencies.requester
      })
      const universalAdapter = createUniversalReviewAdapter(snapshot)

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
        throw new Tm1RegtestBroadcastAuthorizationAdapterError('AUTHORIZATION_CORE_FAILED')
      }

      let rawPrepared: unknown
      try {
        rawPrepared = await handle.ready
      } catch {
        const terminal = classifyTerminal(handle, signal)
        if (terminal) return terminal
        throw new Tm1RegtestBroadcastAuthorizationAdapterError('AUTHORIZATION_CORE_FAILED')
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
        signedId: snapshot.signedId,
        txid: snapshot.txid,
        signedArtifactHash: snapshot.signedArtifactHash,
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
        throw new Tm1RegtestBroadcastAuthorizationAdapterError('AUTHORIZATION_PROVIDER_FAILED')
      }
      if (providerResult.status === 'cancelled') {
        const terminal = classifyTerminal(handle, signal)
        if (terminal) return terminal
        throw new Tm1RegtestBroadcastAuthorizationAdapterError('AUTHORIZATION_CORE_FAILED')
      }
      const rawDecision = providerResult.value
      const terminalAfterDecision = classifyTerminal(handle, signal)
      if (terminalAfterDecision) return terminalAfterDecision
      const decision = snapshotProviderDecision(rawDecision)

      if (decision.status === 'rejected') {
        try {
          handle.reject()
        } catch {
          throw new Tm1RegtestBroadcastAuthorizationAdapterError('AUTHORIZATION_CORE_FAILED')
        }
        const terminalAfterReject = classifyTerminal(handle, signal)
        if (terminalAfterReject) return terminalAfterReject
        assertExternalNotAborted(signal)
        if (safeHandleState(handle) !== 'rejected') {
          throw new Tm1RegtestBroadcastAuthorizationAdapterError('AUTHORIZATION_CORE_FAILED')
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
        throw new Tm1RegtestBroadcastAuthorizationAdapterError('AUTHORIZATION_CORE_FAILED')
      }
      assertExternalNotAborted(signal)
      if (safeHandleState(handle) !== 'authorized') {
        throw new Tm1RegtestBroadcastAuthorizationAdapterError('INVALID_AUTHORIZATION_GRANT')
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
      if (grant.authorizationId === snapshot.signingAuthorizationId) {
        throw new Tm1RegtestBroadcastAuthorizationAdapterError('INVALID_AUTHORIZATION_GRANT')
      }

      return Object.freeze({
        status: 'approved',
        authorizationId: grant.authorizationId,
        signedId: snapshot.signedId,
        txid: snapshot.txid,
        signedArtifactHash: snapshot.signedArtifactHash
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
      throw new Tm1RegtestBroadcastAuthorizationAdapterError('INVALID_AUTHORIZATION_CONFIGURATION')
    }
    assertExternalNotAborted(signal)
    if (!Number.isSafeInteger(value)) {
      throw new Tm1RegtestBroadcastAuthorizationAdapterError('INVALID_AUTHORIZATION_CONFIGURATION')
    }
    return value as number
  }

  private createOperationId(signal?: AbortSignal): string {
    let value: unknown
    try {
      value = this.dependencies.createOperationId()
    } catch {
      throw new Tm1RegtestBroadcastAuthorizationAdapterError('INVALID_AUTHORIZATION_CONFIGURATION')
    }
    assertExternalNotAborted(signal)
    return requireNonEmptyString(value, 'INVALID_AUTHORIZATION_CONFIGURATION')
  }
}

function awaitProviderDecisionOrCancellation(
  requestDecision: Tm1RegtestBroadcastAuthorizationDecisionProvider['requestDecision'],
  request: Tm1RegtestBroadcastAuthorizationDecisionRequest,
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

export function encodeTm1RegtestBroadcastAuthorizationPayload(input: Readonly<{
  signedId: string
  txid: string
  signedArtifactHash: string
}>): Uint8Array {
  const signedId = requireNonEmptyString(input.signedId, 'INVALID_AUTHORIZATION_REQUEST')
  const txid = requireCanonicalHash(input.txid, 'INVALID_AUTHORIZATION_REQUEST')
  const signedArtifactHash = requireCanonicalHash(
    input.signedArtifactHash,
    'INVALID_AUTHORIZATION_REQUEST'
  )
  const domainBytes = new TextEncoder().encode(TM1_REGTEST_BROADCAST_AUTHORIZATION_PAYLOAD_DOMAIN)
  const signedIdBytes = new TextEncoder().encode(signedId)
  const txidBytes = hexToBytes(txid)
  const signedArtifactHashBytes = hexToBytes(signedArtifactHash)
  const payload = new Uint8Array(
    4 + domainBytes.length + 4 + signedIdBytes.length +
    txidBytes.length + signedArtifactHashBytes.length
  )
  let offset = 0
  offset = writeLengthPrefixed(payload, offset, domainBytes)
  offset = writeLengthPrefixed(payload, offset, signedIdBytes)
  payload.set(txidBytes, offset)
  payload.set(signedArtifactHashBytes, offset + txidBytes.length)
  return payload
}

function snapshotSignedReview(value: unknown): RequestSnapshot {
  try {
    const preparedId = requireNonEmptyString(
      readOwnData(value, 'preparedId'),
      'INVALID_AUTHORIZATION_REQUEST'
    )
    const signedId = requireNonEmptyString(
      readOwnData(value, 'signedId'),
      'INVALID_AUTHORIZATION_REQUEST'
    )
    const txid = requireCanonicalHash(
      readOwnData(value, 'txid'),
      'INVALID_AUTHORIZATION_REQUEST'
    )
    const signedArtifactHash = requireCanonicalHash(
      readOwnData(value, 'signedArtifactHash'),
      'INVALID_AUTHORIZATION_REQUEST'
    )
    const bindingHash = requireCanonicalHash(
      readOwnData(value, 'bindingHash'),
      'INVALID_AUTHORIZATION_REQUEST'
    )
    const signingAuthorizationId = requireNonEmptyString(
      readOwnData(value, 'signingAuthorizationId'),
      'INVALID_AUTHORIZATION_REQUEST'
    )
    const orderedOutputs = snapshotOutputs(readOwnData(value, 'orderedOutputs'))
    const feeSats = readOwnData(value, 'feeSats')
    if (typeof feeSats !== 'bigint' || feeSats < 0n) {
      throw new Tm1RegtestBroadcastAuthorizationAdapterError('INVALID_AUTHORIZATION_REQUEST')
    }
    const signedArtifact = snapshotSignedArtifact(
      readOwnData(value, 'signedArtifact'),
      txid,
      feeSats
    )
    return Object.freeze({
      signedId,
      txid,
      signedArtifactHash,
      signingAuthorizationId,
      review: Object.freeze({
        preparedId,
        signedId,
        txid,
        signedArtifactHash,
        bindingHash,
        orderedOutputs,
        feeSats,
        signedArtifact
      })
    })
  } catch (error) {
    if (error instanceof Tm1RegtestBroadcastAuthorizationAdapterError) throw error
    throw new Tm1RegtestBroadcastAuthorizationAdapterError('INVALID_AUTHORIZATION_REQUEST')
  }
}

function snapshotOutputs(value: unknown): readonly Tm1PublicationOutput[] {
  const items = snapshotArray(value, 'INVALID_AUTHORIZATION_REQUEST')
  if (items.length === 0) {
    throw new Tm1RegtestBroadcastAuthorizationAdapterError('INVALID_AUTHORIZATION_REQUEST')
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
      throw new Tm1RegtestBroadcastAuthorizationAdapterError('INVALID_AUTHORIZATION_REQUEST')
    }
    return Object.freeze({ index, role, sats, scriptHex })
  }))
}

function snapshotSignedArtifact(
  value: unknown,
  expectedTxid: string,
  expectedFeeSats: bigint
): Tm1RegtestBroadcastAuthorizationReviewSnapshot['signedArtifact'] {
  const format = requireNonEmptyString(
    readOwnData(value, 'format'),
    'INVALID_AUTHORIZATION_REQUEST'
  )
  const artifactVersion = requireNonNegativeSafeInteger(
    readOwnData(value, 'artifactVersion')
  )
  const environment = requireNonEmptyString(
    readOwnData(value, 'environment'),
    'INVALID_AUTHORIZATION_REQUEST'
  )
  const sighashPolicy = requireNonEmptyString(
    readOwnData(value, 'sighashPolicy'),
    'INVALID_AUTHORIZATION_REQUEST'
  )
  const fixturePublicKeyHex = requireCanonicalNonEmptyHex(
    readOwnData(value, 'fixturePublicKeyHex')
  )
  const fixtureLockingScriptHex = requireCanonicalNonEmptyHex(
    readOwnData(value, 'fixtureLockingScriptHex')
  )
  const inputCount = requireNonNegativeSafeInteger(readOwnData(value, 'inputCount'))
  const feeSats = readOwnData(value, 'feeSats')
  const txid = requireCanonicalHash(
    readOwnData(value, 'txid'),
    'INVALID_AUTHORIZATION_REQUEST'
  )
  const rawTransactionHex = requireCanonicalNonEmptyHex(
    readOwnData(value, 'rawTransactionHex')
  )
  const rawTransactionBytes = cloneBytes(
    readOwnData(value, 'rawTransactionBytes'),
    'INVALID_AUTHORIZATION_REQUEST'
  )
  if (
    inputCount === 0 ||
    typeof feeSats !== 'bigint' ||
    feeSats < 0n ||
    feeSats !== expectedFeeSats ||
    txid !== expectedTxid ||
    rawTransactionBytes.length === 0 ||
    !bytesEqual(rawTransactionBytes, hexToBytes(rawTransactionHex))
  ) {
    throw new Tm1RegtestBroadcastAuthorizationAdapterError('INVALID_AUTHORIZATION_REQUEST')
  }
  return Object.freeze({
    format,
    artifactVersion,
    environment,
    sighashPolicy,
    fixturePublicKeyHex,
    fixtureLockingScriptHex,
    inputCount,
    feeSats,
    txid,
    rawTransactionByteLength: rawTransactionBytes.length
  })
}

function buildUniversalReview(snapshot: RequestSnapshot): UniversalReviewSnapshot {
  const fields: readonly UniversalReviewField[] = Object.freeze([
    Object.freeze({ label: 'Profile', value: TM1_REGTEST_BROADCAST_AUTHORIZATION_PROFILE_ID }),
    Object.freeze({
      label: 'Intent',
      value: 'Authorizes broadcast of this exact signed artifact. This authorization adapter does not itself sign, audit, or transmit it. The publication orchestrator re-audits the signed artifact before dispatch.'
    }),
    Object.freeze({ label: 'Signed ID', value: snapshot.signedId }),
    Object.freeze({ label: 'Transaction ID', value: snapshot.txid }),
    Object.freeze({ label: 'Signed artifact hash', value: snapshot.signedArtifactHash }),
    Object.freeze({ label: 'Prepared ID', value: snapshot.review.preparedId }),
    Object.freeze({ label: 'Binding hash', value: snapshot.review.bindingHash }),
    Object.freeze({ label: 'Outputs', value: snapshot.review.orderedOutputs.length.toString() }),
    Object.freeze({ label: 'Fee sats', value: snapshot.review.feeSats.toString() }),
    Object.freeze({ label: 'Artifact format', value: snapshot.review.signedArtifact.format }),
    Object.freeze({ label: 'Artifact version', value: snapshot.review.signedArtifact.artifactVersion.toString() }),
    Object.freeze({ label: 'Environment', value: snapshot.review.signedArtifact.environment }),
    Object.freeze({ label: 'Sighash policy', value: snapshot.review.signedArtifact.sighashPolicy }),
    Object.freeze({ label: 'Inputs', value: snapshot.review.signedArtifact.inputCount.toString() }),
    Object.freeze({ label: 'Raw transaction bytes', value: snapshot.review.signedArtifact.rawTransactionByteLength.toString() })
  ])
  return Object.freeze({
    fields,
    effectiveContent: encodeTm1RegtestBroadcastAuthorizationPayload(snapshot)
  })
}

function createUniversalReviewAdapter(
  snapshot: RequestSnapshot
): UniversalReviewAuthorizationAdapter {
  return Object.freeze({
    profileId: TM1_REGTEST_BROADCAST_AUTHORIZATION_PROFILE_ID,
    async prepareReview(
      _envelope: UniversalAuthorizationEnvelopeV1,
      signal: AbortSignal
    ) {
      assertInternalNotAborted(signal)
      return buildUniversalReview(snapshot)
    },
    async revalidateReview(
      _envelope: UniversalAuthorizationEnvelopeV1,
      _approvedReview: UniversalReviewSnapshot,
      signal: AbortSignal
    ) {
      assertInternalNotAborted(signal)
      return buildUniversalReview(snapshot)
    }
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
      throw new Tm1RegtestBroadcastAuthorizationAdapterError('AUTHORIZATION_CORE_FAILED')
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
    if (error instanceof Tm1RegtestBroadcastAuthorizationAdapterError) throw error
    throw new Tm1RegtestBroadcastAuthorizationAdapterError('AUTHORIZATION_CORE_FAILED')
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
      throw new Tm1RegtestBroadcastAuthorizationAdapterError('AUTHORIZATION_CORE_FAILED')
    }
    return Object.freeze({ contentHash })
  } catch (error) {
    if (error instanceof Tm1RegtestBroadcastAuthorizationAdapterError) throw error
    throw new Tm1RegtestBroadcastAuthorizationAdapterError('AUTHORIZATION_CORE_FAILED')
  }
}

function snapshotUniversalFields(value: unknown): readonly UniversalReviewField[] {
  return Object.freeze(snapshotArray(value, 'AUTHORIZATION_CORE_FAILED').map(item => Object.freeze({
    label: requireString(readOwnData(item, 'label'), 'AUTHORIZATION_CORE_FAILED'),
    value: requireString(readOwnData(item, 'value'), 'AUTHORIZATION_CORE_FAILED')
  })))
}

function freezeProviderRequest(
  value: Tm1RegtestBroadcastAuthorizationDecisionRequest
): Tm1RegtestBroadcastAuthorizationDecisionRequest {
  return Object.freeze({
    operationId: value.operationId,
    signedId: value.signedId,
    txid: value.txid,
    signedArtifactHash: value.signedArtifactHash,
    review: cloneAuthorizationReview(value.review),
    expiresAt: value.expiresAt,
    contentHash: value.contentHash
  })
}

function cloneAuthorizationReview(
  review: Tm1RegtestBroadcastAuthorizationReviewSnapshot
): Tm1RegtestBroadcastAuthorizationReviewSnapshot {
  return Object.freeze({
    preparedId: review.preparedId,
    signedId: review.signedId,
    txid: review.txid,
    signedArtifactHash: review.signedArtifactHash,
    bindingHash: review.bindingHash,
    orderedOutputs: Object.freeze(review.orderedOutputs.map(output => Object.freeze({ ...output }))),
    feeSats: review.feeSats,
    signedArtifact: Object.freeze({ ...review.signedArtifact })
  })
}

function snapshotProviderDecision(value: unknown): Tm1RegtestBroadcastAuthorizationProviderDecision {
  try {
    const status = readOwnData(value, 'status')
    if (status === 'approved') return Object.freeze({ status })
    if (status === 'rejected') {
      const reason = readOptionalString(value, 'reason', 'INVALID_AUTHORIZATION_DECISION')
      return reason === undefined
        ? Object.freeze({ status })
        : Object.freeze({ status, reason })
    }
    throw new Tm1RegtestBroadcastAuthorizationAdapterError('INVALID_AUTHORIZATION_DECISION')
  } catch (error) {
    if (error instanceof Tm1RegtestBroadcastAuthorizationAdapterError) throw error
    throw new Tm1RegtestBroadcastAuthorizationAdapterError('INVALID_AUTHORIZATION_DECISION')
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
      throw new Tm1RegtestBroadcastAuthorizationAdapterError('INVALID_AUTHORIZATION_GRANT')
    }
    return Object.freeze({ authorizationId, operationId, contentHash, expiresAt })
  } catch (error) {
    if (error instanceof Tm1RegtestBroadcastAuthorizationAdapterError) throw error
    throw new Tm1RegtestBroadcastAuthorizationAdapterError('INVALID_AUTHORIZATION_GRANT')
  }
}

function classifyTerminal(
  handle: SafeAuthorizationHandle,
  externalSignal?: AbortSignal
): Extract<Tm1BroadcastAuthorizationDecision, { status: 'expired' }> | null {
  assertExternalNotAborted(externalSignal)
  const state = safeHandleState(handle)
  if (state === 'expired') {
    return Object.freeze({ status: 'expired', reason: EXPIRED_REASON })
  }
  if (state === 'aborted') throw createAbortError()
  if (state === 'failed') {
    throw new Tm1RegtestBroadcastAuthorizationAdapterError('AUTHORIZATION_CORE_FAILED')
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
  code: Tm1RegtestBroadcastAuthorizationAdapterErrorCode
): string | undefined {
  if (value === null || (typeof value !== 'object' && typeof value !== 'function')) {
    throw new Tm1RegtestBroadcastAuthorizationAdapterError(code)
  }
  const descriptor = Object.getOwnPropertyDescriptor(value, key)
  if (descriptor === undefined) return undefined
  if (!('value' in descriptor) || (descriptor.value !== undefined && typeof descriptor.value !== 'string')) {
    throw new Tm1RegtestBroadcastAuthorizationAdapterError(code)
  }
  return descriptor.value
}

function snapshotArray(
  value: unknown,
  code: Tm1RegtestBroadcastAuthorizationAdapterErrorCode
): unknown[] {
  if (!Array.isArray(value)) throw new Tm1RegtestBroadcastAuthorizationAdapterError(code)
  const length = readOwnData(value, 'length')
  if (typeof length !== 'number' || !Number.isSafeInteger(length) || length < 0) {
    throw new Tm1RegtestBroadcastAuthorizationAdapterError(code)
  }
  const snapshot = new Array<unknown>(length)
  for (let index = 0; index < length; index += 1) {
    snapshot[index] = readOwnData(value, String(index))
  }
  return snapshot
}

function cloneBytes(
  value: unknown,
  code: Tm1RegtestBroadcastAuthorizationAdapterErrorCode
): Uint8Array {
  if (!(value instanceof Uint8Array)) throw new Tm1RegtestBroadcastAuthorizationAdapterError(code)
  return new Uint8Array(value)
}

function requireString(
  value: unknown,
  code: Tm1RegtestBroadcastAuthorizationAdapterErrorCode
): string {
  if (typeof value !== 'string') throw new Tm1RegtestBroadcastAuthorizationAdapterError(code)
  return value
}

function requireNonEmptyString(
  value: unknown,
  code: Tm1RegtestBroadcastAuthorizationAdapterErrorCode
): string {
  if (typeof value !== 'string' || value.trim().length === 0) {
    throw new Tm1RegtestBroadcastAuthorizationAdapterError(code)
  }
  return value
}

function requireCanonicalHash(
  value: unknown,
  code: Tm1RegtestBroadcastAuthorizationAdapterErrorCode
): string {
  if (typeof value !== 'string' || !/^[0-9a-f]{64}$/.test(value)) {
    throw new Tm1RegtestBroadcastAuthorizationAdapterError(code)
  }
  return value
}

function requireCanonicalNonEmptyHex(value: unknown): string {
  if (typeof value !== 'string' || !isCanonicalHex(value)) {
    throw new Tm1RegtestBroadcastAuthorizationAdapterError('INVALID_AUTHORIZATION_REQUEST')
  }
  return value
}

function requireNonNegativeSafeInteger(value: unknown): number {
  if (typeof value !== 'number' || !Number.isSafeInteger(value) || value < 0) {
    throw new Tm1RegtestBroadcastAuthorizationAdapterError('INVALID_AUTHORIZATION_REQUEST')
  }
  return value
}

function requireUniversalContentHash(
  value: unknown,
  code: Tm1RegtestBroadcastAuthorizationAdapterErrorCode
): UniversalContentHash {
  if (typeof value !== 'string' || !/^sha256:[0-9a-f]{64}$/.test(value)) {
    throw new Tm1RegtestBroadcastAuthorizationAdapterError(code)
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
    throw new Tm1RegtestBroadcastAuthorizationAdapterError('INVALID_AUTHORIZATION_REQUEST')
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
