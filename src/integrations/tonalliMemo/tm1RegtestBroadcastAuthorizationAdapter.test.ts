import { afterEach, describe, expect, test, vi } from 'vitest'
import type {
  ApprovalConsumption,
  ApprovalConsumptionLedger
} from '../../features/externalSign/approval'
import { calculateUniversalContentHash } from '../../features/externalSign/contentHash'
import type { UniversalAuthorizationEnvelopeV1 } from '../../features/externalSign/contract'
import {
  UniversalAuthorizationCore,
  type UniversalAuthorizationGrant,
  type UniversalAuthorizationState
} from '../../features/externalSign/core'
import type {
  UniversalOperationLease,
  UniversalOperationLock
} from '../../features/externalSign/lock'
import type { UniversalReviewAuthorizationAdapter } from '../../features/externalSign/adapters'
import {
  TM1_REGTEST_FIXTURE_LOCKING_SCRIPT_HEX,
  signTm1Draft02RegtestCandidate
} from './tm1Draft02RegtestP2pkhSigner'
import type { Tm1Draft02FreshUtxo } from './tm1Draft02Candidate'
import {
  Tm1PublicationError,
  Tm1RegtestPublicationOrchestratorImpl,
  type Tm1PublicationRequest,
  type Tm1RegtestPublicationDependencies,
  type Tm1SignedReview
} from './tm1RegtestPublicationOrchestrator'
import { Tm1RegtestAuthorizationAdapter } from './tm1RegtestAuthorizationAdapter'
import {
  TM1_REGTEST_BROADCAST_AUTHORIZATION_PAYLOAD_DOMAIN,
  TM1_REGTEST_BROADCAST_AUTHORIZATION_PROFILE_ID,
  Tm1RegtestBroadcastAuthorizationAdapter,
  Tm1RegtestBroadcastAuthorizationAdapterError,
  encodeTm1RegtestBroadcastAuthorizationPayload,
  type Tm1RegtestBroadcastAuthorizationCorePort,
  type Tm1RegtestBroadcastAuthorizationDecisionProvider,
  type Tm1RegtestBroadcastAuthorizationProviderDecision
} from './tm1RegtestBroadcastAuthorizationAdapter'

const NOW = 1_900_000_000_000
const PREPARED_ID = 'prepared-1'
const SIGNED_ID = 'signed-1'
const TXID = '22'.repeat(32)
const ARTIFACT_HASH = '33'.repeat(32)
const BINDING_HASH = '44'.repeat(32)
const SIGNING_AUTHORIZATION_ID = 'signing-authorization-1'
const VECTOR_TXID = '22'.repeat(32)
const VECTOR_ARTIFACT_HASH = '11'.repeat(32)

type Mutable<T> = { -readonly [Key in keyof T]: T[Key] }

type Deferred<T> = Readonly<{
  promise: Promise<T>
  resolve: (value: T) => void
  reject: (reason: unknown) => void
}>

function deferred<T>(): Deferred<T> {
  let resolveValue: (value: T) => void = () => undefined
  let rejectValue: (reason: unknown) => void = () => undefined
  const promise = new Promise<T>((resolve, reject) => {
    resolveValue = resolve
    rejectValue = reject
  })
  void promise.catch(() => undefined)
  return Object.freeze({ promise, resolve: resolveValue, reject: rejectValue })
}

class TestLease implements UniversalOperationLease {
  readonly ownerOperationId: string
  private owned = true
  releaseCalls = 0

  constructor(operationId: string) {
    this.ownerOperationId = operationId
  }

  isOwned(): boolean {
    return this.owned
  }

  release(): void {
    this.releaseCalls += 1
    this.owned = false
  }
}

class TestLock implements UniversalOperationLock {
  acquireCalls = 0
  readonly leases = new Map<string, TestLease>()

  async acquire(operationId: string, signal: AbortSignal): Promise<UniversalOperationLease> {
    this.acquireCalls += 1
    if (signal.aborted) throw signal.reason
    const lease = new TestLease(operationId)
    this.leases.set(operationId, lease)
    return lease
  }
}

class TestLedger implements ApprovalConsumptionLedger {
  readonly records: ApprovalConsumption[] = []
  readonly consumedCapabilityIds = new Set<string>()
  onConsume: ((consumption: ApprovalConsumption, signal: AbortSignal) => void | Promise<void>) | null = null

  async consume(consumption: ApprovalConsumption, signal: AbortSignal): Promise<void> {
    if (signal.aborted) throw signal.reason
    if (this.consumedCapabilityIds.has(consumption.capabilityId)) {
      throw new Error('APPROVAL_ALREADY_CONSUMED')
    }
    this.records.push(consumption)
    this.consumedCapabilityIds.add(consumption.capabilityId)
    await this.onConsume?.(consumption, signal)
  }
}

function signedReview(
  signedId = SIGNED_ID,
  txid = TXID,
  signedArtifactHash = ARTIFACT_HASH,
  signingAuthorizationId = SIGNING_AUTHORIZATION_ID
): Tm1SignedReview {
  const rawTransactionBytes = new Uint8Array([1, 2, 3, 4])
  return {
    preparedId: PREPARED_ID,
    signedId,
    txid,
    signedArtifactHash,
    signedArtifact: {
      format: 'tonalli.tm1-draft02.regtest-signed-transaction.v1',
      artifactVersion: 1,
      environment: 'deterministic-regtest-fixture',
      sighashPolicy: 'ALL_BIP143',
      fixturePublicKeyHex:
        '0279be667ef9dcbbac55a06295ce870b07029bfcdb2dce28d959f2815b16f81798',
      fixtureLockingScriptHex:
        '76a914751e76e8199196d454941c45d1b3a323f1433bd688ac',
      inputCount: 1,
      feeSats: 1_000n,
      txid,
      rawTransactionHex: '01020304',
      rawTransactionBytes
    },
    feeSats: 1_000n,
    orderedOutputs: [{
      index: 0,
      role: 'tm1_op_return',
      sats: 0n,
      scriptHex: '6a00'
    }],
    bindingHash: BINDING_HASH,
    signingAuthorizationId
  }
}

type HarnessOptions = Readonly<{
  provider?: Tm1RegtestBroadcastAuthorizationDecisionProvider['requestDecision']
  ttlMs?: number
  now?: () => number
  operationId?: () => string
  ledger?: TestLedger
  core?: Tm1RegtestBroadcastAuthorizationCorePort
}>

function createHarness(options: HarnessOptions = {}) {
  const lock = new TestLock()
  const ledger = options.ledger ?? new TestLedger()
  let sequence = 0
  const now = options.now ?? (() => NOW)
  const core = options.core ?? new UniversalAuthorizationCore({
    enabled: true,
    lock,
    approvalLedger: ledger,
    now,
    createCapabilityId: operationId => `${operationId}:authorization-capability`
  })
  const requestDecision = vi.fn(options.provider ?? (async () => Object.freeze({
    status: 'approved' as const
  })))
  const adapter = new Tm1RegtestBroadcastAuthorizationAdapter({
    core,
    decisionProvider: { requestDecision },
    now,
    ttlMs: options.ttlMs ?? 10_000,
    createOperationId: options.operationId ?? (() => `tm1-broadcast-authorization-${++sequence}`),
    requester: {
      declaredOrigin: 'https://tm1-regtest.invalid',
      displayName: 'TM1 regtest broadcast authorization'
    }
  })
  return Object.freeze({ adapter, core, ledger, lock, requestDecision })
}

async function waitUntil(assertion: () => void): Promise<void> {
  await vi.waitFor(assertion, { timeout: 1_000, interval: 1 })
}

async function expectAdapterCode(
  promise: Promise<unknown>,
  code: Tm1RegtestBroadcastAuthorizationAdapterError['code']
): Promise<void> {
  await expect(promise).rejects.toMatchObject({
    name: 'Tm1RegtestBroadcastAuthorizationAdapterError',
    code
  })
}

function abortAwarePending(signal: AbortSignal): Promise<never> {
  if (signal.aborted) return Promise.reject(signal.reason)
  return new Promise((_resolve, reject) => {
    signal.addEventListener('abort', () => reject(signal.reason), { once: true })
  })
}

type FakeCoreOptions = Readonly<{
  startError?: unknown
  readyError?: unknown
  authorizeError?: unknown
  grant?: (expected: UniversalAuthorizationGrant) => unknown
  onAuthorize?: () => void
}>

function fakeCore(options: FakeCoreOptions = {}): Tm1RegtestBroadcastAuthorizationCorePort {
  return {
    startAuthorization(
      envelopeValue: unknown,
      adapter: UniversalReviewAuthorizationAdapter,
      startOptions = {}
    ) {
      if (options.startError !== undefined) throw options.startError
      const envelope = envelopeValue as UniversalAuthorizationEnvelopeV1
      const controller = new AbortController()
      let state: UniversalAuthorizationState = 'preparing'
      const externalAbort = () => {
        state = 'aborted'
        controller.abort(startOptions.signal?.reason)
      }
      startOptions.signal?.addEventListener('abort', externalAbort, { once: true })
      const ready = (async () => {
        if (options.readyError !== undefined) throw options.readyError
        const review = await adapter.prepareReview(envelope, controller.signal)
        const contentHash = await calculateUniversalContentHash(
          envelope,
          review.effectiveContent,
          controller.signal
        )
        state = 'reviewReady'
        return Object.freeze({ operationId: envelope.operationId, review, contentHash })
      })()
      void ready.catch(() => undefined)
      return Object.freeze({
        operationId: envelope.operationId,
        ready,
        async authorize() {
          options.onAuthorize?.()
          if (options.authorizeError !== undefined) throw options.authorizeError
          const prepared = await ready
          state = 'revalidating'
          await adapter.revalidateReview(envelope, prepared.review, controller.signal)
          state = 'authorized'
          const expected = Object.freeze({
            authorizationId: `${envelope.operationId}:fake-capability`,
            operationId: envelope.operationId,
            contentHash: prepared.contentHash,
            expiresAt: envelope.expiresAt
          })
          return options.grant?.(expected) ?? expected
        },
        reject() {
          state = 'rejected'
          controller.abort()
        },
        abort() {
          state = 'aborted'
          controller.abort()
        },
        cleanup() {
          state = 'aborted'
          controller.abort()
        },
        signal: controller.signal,
        state: () => state,
        history: () => Object.freeze([state])
      }) as unknown as ReturnType<Tm1RegtestBroadcastAuthorizationCorePort['startAuthorization']>
    }
  }
}

afterEach(() => {
  vi.restoreAllMocks()
  vi.useRealTimers()
})

describe('TM1 regtest authorization adapter', () => {
  test('returns an approved decision bound to the original signed review', async () => {
    const harness = createHarness()

    const result = await harness.adapter.requestBroadcastAuthorization(signedReview())

    expect(result).toEqual({
      status: 'approved',
      authorizationId: 'tm1-broadcast-authorization-1:authorization-capability',
      signedId: SIGNED_ID,
      txid: TXID,
      signedArtifactHash: ARTIFACT_HASH
    })
    expect(Object.isFrozen(result)).toBe(true)
    expect(harness.ledger.records).toHaveLength(1)
    expect(TM1_REGTEST_BROADCAST_AUTHORIZATION_PROFILE_ID).toBe(
      'tonalli.tm1-regtest.broadcast-authorization.v1'
    )
  })

  test('maps provider rejection through handle.reject()', async () => {
    const harness = createHarness({
      provider: async () => ({ status: 'rejected', reason: 'operator declined' })
    })

    await expect(harness.adapter.requestBroadcastAuthorization(signedReview())).resolves.toEqual({
      status: 'rejected',
      reason: 'operator declined'
    })
    expect(harness.ledger.records).toHaveLength(0)
  })

  test('maps rejection to expired when the core clock crosses expiry before reject terminalizes', async () => {
    let now = NOW
    const harness = createHarness({
      ttlMs: 100,
      now: () => now,
      provider: async () => {
        now = NOW + 100
        return { status: 'rejected', reason: 'too late' }
      }
    })

    await expect(harness.adapter.requestBroadcastAuthorization(signedReview())).resolves.toEqual({
      status: 'expired',
      reason: 'TM1 broadcast authorization expired'
    })
    expect(harness.ledger.records).toHaveLength(0)
  })

  test('gives external abort precedence over simultaneous rejection and expiry', async () => {
    let now = NOW
    const controller = new AbortController()
    const harness = createHarness({
      ttlMs: 100,
      now: () => now,
      provider: async () => {
        now = NOW + 100
        controller.abort()
        return { status: 'rejected' }
      }
    })

    await expect(harness.adapter.requestBroadcastAuthorization(
      signedReview(),
      controller.signal
    )).rejects.toMatchObject({ name: 'AbortError' })
    expect(harness.ledger.records).toHaveLength(0)
  })

  test('maps expiry-after-consume to expired and never exposes an approved grant', async () => {
    const ledger = new TestLedger()
    let consumed = false
    let postConsumeClockReads = 0
    ledger.onConsume = () => { consumed = true }
    const now = () => {
      if (!consumed) return NOW
      postConsumeClockReads += 1
      return postConsumeClockReads === 1 ? NOW : NOW + 100
    }
    const harness = createHarness({ ledger, now, ttlMs: 100 })

    await expect(harness.adapter.requestBroadcastAuthorization(signedReview())).resolves.toEqual({
      status: 'expired',
      reason: 'TM1 broadcast authorization expired'
    })
    expect(ledger.records).toHaveLength(1)
    expect(ledger.records[0]?.capabilityId).toBe(
      'tm1-broadcast-authorization-1:authorization-capability'
    )
  })

  test('maps core expiry while the decision provider is pending', async () => {
    vi.useFakeTimers()
    vi.setSystemTime(NOW)
    const providerStarted = deferred<void>()
    const providerSignal: { value: AbortSignal | null } = { value: null }
    const harness = createHarness({
      ttlMs: 100,
      now: Date.now,
      provider: async (_request, signal) => {
        providerSignal.value = signal
        providerStarted.resolve()
        return abortAwarePending(signal)
      }
    })
    const result = harness.adapter.requestBroadcastAuthorization(signedReview())
    await providerStarted.promise

    await vi.advanceTimersByTimeAsync(100)

    await expect(result).resolves.toEqual({
      status: 'expired',
      reason: 'TM1 broadcast authorization expired'
    })
    expect(providerSignal.value?.aborted).toBe(true)
    expect((harness.core as UniversalAuthorizationCore).activeOperationId).toBeNull()
    expect(harness.lock.leases.get('tm1-broadcast-authorization-1')?.releaseCalls).toBe(1)
    expect(harness.ledger.records).toHaveLength(0)
    expect(vi.getTimerCount()).toBe(0)
  })

  test('provider never settles and core expiry releases guards for immediate retry', async () => {
    vi.useFakeTimers()
    vi.setSystemTime(NOW)
    let calls = 0
    const providerStarted = deferred<void>()
    const harness = createHarness({
      ttlMs: 100,
      now: Date.now,
      provider: () => {
        calls += 1
        if (calls === 1) {
          providerStarted.resolve()
          return new Promise<Tm1RegtestBroadcastAuthorizationProviderDecision>(() => undefined)
        }
        return Promise.resolve({ status: 'approved' })
      }
    })
    const first = harness.adapter.requestBroadcastAuthorization(signedReview())
    await providerStarted.promise

    await vi.advanceTimersByTimeAsync(100)

    await expect(first).resolves.toEqual({
      status: 'expired',
      reason: 'TM1 broadcast authorization expired'
    })
    expect((harness.core as UniversalAuthorizationCore).activeOperationId).toBeNull()
    expect(harness.lock.leases.get('tm1-broadcast-authorization-1')?.releaseCalls).toBe(1)
    await expect(harness.adapter.requestBroadcastAuthorization(signedReview())).resolves.toMatchObject({
      status: 'approved'
    })
    expect(harness.lock.acquireCalls).toBe(2)
    expect(vi.getTimerCount()).toBe(0)
  })

  test('provider never settles and external abort releases guards for immediate retry', async () => {
    let calls = 0
    const providerStarted = deferred<void>()
    const harness = createHarness({
      provider: () => {
        calls += 1
        if (calls === 1) {
          providerStarted.resolve()
          return new Promise<Tm1RegtestBroadcastAuthorizationProviderDecision>(() => undefined)
        }
        return Promise.resolve({ status: 'approved' })
      }
    })
    const controller = new AbortController()
    const first = harness.adapter.requestBroadcastAuthorization(
      signedReview(),
      controller.signal
    )
    await providerStarted.promise

    controller.abort()

    await expect(first).rejects.toMatchObject({ name: 'AbortError' })
    expect((harness.core as UniversalAuthorizationCore).activeOperationId).toBeNull()
    expect(harness.lock.leases.get('tm1-broadcast-authorization-1')?.releaseCalls).toBe(1)
    await expect(harness.adapter.requestBroadcastAuthorization(signedReview())).resolves.toMatchObject({
      status: 'approved'
    })
    expect(harness.lock.acquireCalls).toBe(2)
  })

  test('observes a provider rejection that arrives after external abort wins', async () => {
    let calls = 0
    let rejectLate: (reason?: unknown) => void = () => undefined
    const providerStarted = deferred<void>()
    const lateProvider = new Promise<Tm1RegtestBroadcastAuthorizationProviderDecision>((_resolve, reject) => {
      rejectLate = reject
    })
    const harness = createHarness({
      provider: () => {
        calls += 1
        if (calls === 1) {
          providerStarted.resolve()
          return lateProvider
        }
        return Promise.resolve({ status: 'approved' })
      }
    })
    const controller = new AbortController()
    const first = harness.adapter.requestBroadcastAuthorization(
      signedReview(),
      controller.signal
    )
    await providerStarted.promise

    controller.abort()
    await expect(first).rejects.toMatchObject({ name: 'AbortError' })

    rejectLate(new Error('late provider rejection'))
    await Promise.resolve()
    await Promise.resolve()

    expect((harness.core as UniversalAuthorizationCore).activeOperationId).toBeNull()
    expect(harness.ledger.records).toHaveLength(0)
    await expect(harness.adapter.requestBroadcastAuthorization(signedReview())).resolves.toMatchObject({
      status: 'approved'
    })
  })

  test('ignores a provider approval that arrives after expiry wins', async () => {
    vi.useFakeTimers()
    vi.setSystemTime(NOW)
    let calls = 0
    const providerStarted = deferred<void>()
    const lateDecision = deferred<Tm1RegtestBroadcastAuthorizationProviderDecision>()
    const harness = createHarness({
      ttlMs: 100,
      now: Date.now,
      provider: () => {
        calls += 1
        if (calls === 1) {
          providerStarted.resolve()
          return lateDecision.promise
        }
        return Promise.resolve({ status: 'approved' })
      }
    })
    const first = harness.adapter.requestBroadcastAuthorization(signedReview())
    await providerStarted.promise

    await vi.advanceTimersByTimeAsync(100)
    const firstResult = await first

    lateDecision.resolve({ status: 'approved' })
    await Promise.resolve()
    await Promise.resolve()

    expect(firstResult).toEqual({
      status: 'expired',
      reason: 'TM1 broadcast authorization expired'
    })
    expect(harness.ledger.records).toHaveLength(0)
    expect((harness.core as UniversalAuthorizationCore).activeOperationId).toBeNull()
    await expect(harness.adapter.requestBroadcastAuthorization(signedReview())).resolves.toMatchObject({
      status: 'approved'
    })
    expect(vi.getTimerCount()).toBe(0)
  })

  test('provider cancellation race preserves nominal approval', async () => {
    const harness = createHarness({ provider: async () => ({ status: 'approved' }) })

    await expect(harness.adapter.requestBroadcastAuthorization(signedReview())).resolves.toMatchObject({
      status: 'approved',
      signedId: SIGNED_ID,
      txid: TXID,
      signedArtifactHash: ARTIFACT_HASH
    })
    expect(harness.ledger.records).toHaveLength(1)
  })

  test('provider cancellation race preserves provider failure mapping', async () => {
    const providerStarted = deferred<void>()
    const providerFailure = deferred<Tm1RegtestBroadcastAuthorizationProviderDecision>()
    const harness = createHarness({
      provider: () => {
        providerStarted.resolve()
        return providerFailure.promise
      }
    })
    const result = harness.adapter.requestBroadcastAuthorization(signedReview())
    await providerStarted.promise

    providerFailure.reject(new Error('provider failed before cancellation'))

    await expectAdapterCode(result, 'AUTHORIZATION_PROVIDER_FAILED')
    expect(harness.ledger.records).toHaveLength(0)
  })

  test('rejects an already-aborted external signal before core callbacks', async () => {
    const startAuthorization = vi.fn()
    const harness = createHarness({ core: { startAuthorization } })
    const controller = new AbortController()
    controller.abort()

    await expect(harness.adapter.requestBroadcastAuthorization(
      signedReview(),
      controller.signal
    )).rejects.toMatchObject({ name: 'AbortError' })
    expect(startAuthorization).not.toHaveBeenCalled()
  })

  test('normalizes external abort while the provider is pending', async () => {
    const providerStarted = deferred<void>()
    const harness = createHarness({
      provider: async (_request, signal) => {
        providerStarted.resolve()
        return abortAwarePending(signal)
      }
    })
    const controller = new AbortController()
    const result = harness.adapter.requestBroadcastAuthorization(signedReview(), controller.signal)
    await providerStarted.promise

    controller.abort()

    await expect(result).rejects.toMatchObject({ name: 'AbortError' })
    expect(harness.ledger.records).toHaveLength(0)
  })

  test('does not authorize if abort wins after provider approval', async () => {
    const controller = new AbortController()
    const onAuthorize = vi.fn()
    const harness = createHarness({
      core: fakeCore({ onAuthorize }),
      provider: async () => new Promise(resolve => {
        resolve({ status: 'approved' })
        controller.abort()
      })
    })

    await expect(harness.adapter.requestBroadcastAuthorization(
      signedReview(),
      controller.signal
    )).rejects.toMatchObject({ name: 'AbortError' })
    expect(onAuthorize).not.toHaveBeenCalled()
  })

  test.each(['', '   '])('rejects invalid signedId %j', async signedId => {
    const harness = createHarness()
    await expectAdapterCode(
      harness.adapter.requestBroadcastAuthorization(signedReview(signedId)),
      'INVALID_AUTHORIZATION_REQUEST'
    )
    expect(harness.requestDecision).not.toHaveBeenCalled()
  })

  test.each([
    '11'.repeat(31),
    '11'.repeat(33),
    'AA'.repeat(32),
    `g${'1'.repeat(63)}`,
    `0x${'11'.repeat(32)}`
  ])('rejects non-canonical signedArtifactHash %j', async signedArtifactHash => {
    const harness = createHarness()
    await expectAdapterCode(
      harness.adapter.requestBroadcastAuthorization(
        signedReview(SIGNED_ID, TXID, signedArtifactHash)
      ),
      'INVALID_AUTHORIZATION_REQUEST'
    )
  })

  test.each([
    '11'.repeat(31),
    '11'.repeat(33),
    'AA'.repeat(32),
    `g${'1'.repeat(63)}`,
    `0x${'11'.repeat(32)}`
  ])('rejects non-canonical txid %j', async txid => {
    const harness = createHarness()
    await expectAdapterCode(
      harness.adapter.requestBroadcastAuthorization(signedReview(SIGNED_ID, txid)),
      'INVALID_AUTHORIZATION_REQUEST'
    )
  })

  test.each([
    ['signingAuthorizationId', ''],
    ['signingAuthorizationId', '   '],
    ['preparedId', '']
  ] as const)('rejects empty %s signed review data', async (field, value) => {
    const review = signedReview()
    ;(review as unknown as Record<string, unknown>)[field] = value
    const harness = createHarness()

    await expectAdapterCode(
      harness.adapter.requestBroadcastAuthorization(review),
      'INVALID_AUTHORIZATION_REQUEST'
    )
  })

  test('encodes the exact uint32-BE signedId + txid + signedArtifactHash payload vector', () => {
    const encoded = encodeTm1RegtestBroadcastAuthorizationPayload({
      signedId: SIGNED_ID,
      txid: VECTOR_TXID,
      signedArtifactHash: VECTOR_ARTIFACT_HASH
    })

    expect(TM1_REGTEST_BROADCAST_AUTHORIZATION_PAYLOAD_DOMAIN).toBe(
      'tonalli.tm1-regtest/broadcast-authorization/v1'
    )
    expect(Buffer.from(encoded).toString('hex')).toBe(
      '0000002e746f6e616c6c692e746d312d726567746573742f62726f6164636173' +
      '742d617574686f72697a6174696f6e2f7631000000087369676e65642d31' +
      '2222222222222222222222222222222222222222222222222222222222222222' +
      '1111111111111111111111111111111111111111111111111111111111111111'
    )
  })

  test('keeps UniversalContentHash distinct from the TM1 signedArtifactHash', async () => {
    const harness = createHarness()
    await harness.adapter.requestBroadcastAuthorization(signedReview())
    const providerRequest = harness.requestDecision.mock.calls[0]?.[0]

    expect(providerRequest?.contentHash).toMatch(/^sha256:[0-9a-f]{64}$/)
    expect(providerRequest?.contentHash).not.toBe(ARTIFACT_HASH)
    expect(providerRequest?.contentHash).not.toBe(TXID)
  })

  test('binds signedId, txid, and signedArtifactHash independently in UniversalContentHash', async () => {
    const nominal = createHarness({ operationId: () => 'fixed-operation' })
    const changedSignedId = createHarness({ operationId: () => 'fixed-operation' })
    const changedTxid = createHarness({ operationId: () => 'fixed-operation' })
    const changedArtifactHash = createHarness({ operationId: () => 'fixed-operation' })

    await nominal.adapter.requestBroadcastAuthorization(signedReview())
    await changedSignedId.adapter.requestBroadcastAuthorization(signedReview('signed-2'))
    await changedTxid.adapter.requestBroadcastAuthorization(signedReview(
      SIGNED_ID,
      '55'.repeat(32)
    ))
    await changedArtifactHash.adapter.requestBroadcastAuthorization(signedReview(
      SIGNED_ID,
      TXID,
      '66'.repeat(32)
    ))

    const hashes = [nominal, changedSignedId, changedTxid, changedArtifactHash]
      .map(harness => harness.requestDecision.mock.calls[0]?.[0].contentHash)
    expect(new Set(hashes).size).toBe(4)
  })

  test('same txid with altered raw bytes requires a different bound artifact hash', async () => {
    const first = createHarness({ operationId: () => 'fixed-operation' })
    const second = createHarness({ operationId: () => 'fixed-operation' })
    const altered = signedReview(SIGNED_ID, TXID, '77'.repeat(32))
    altered.signedArtifact.rawTransactionBytes[0] = 9
    ;(altered.signedArtifact as Mutable<typeof altered.signedArtifact>).rawTransactionHex =
      '09020304'

    await first.adapter.requestBroadcastAuthorization(signedReview())
    await second.adapter.requestBroadcastAuthorization(altered)

    expect(first.requestDecision.mock.calls[0]?.[0].txid).toBe(TXID)
    expect(second.requestDecision.mock.calls[0]?.[0].txid).toBe(TXID)
    expect(first.requestDecision.mock.calls[0]?.[0].contentHash)
      .not.toBe(second.requestDecision.mock.calls[0]?.[0].contentHash)
  })

  test('rejects a cached grant with another operationId', async () => {
    const harness = createHarness({
      core: fakeCore({ grant: expected => ({ ...expected, operationId: 'stale-operation' }) })
    })
    await expectAdapterCode(
      harness.adapter.requestBroadcastAuthorization(signedReview()),
      'INVALID_AUTHORIZATION_GRANT'
    )
  })

  test('rejects a grant with another UniversalContentHash', async () => {
    const harness = createHarness({
      core: fakeCore({ grant: expected => ({
        ...expected,
        contentHash: `sha256:${'ff'.repeat(32)}`
      }) })
    })
    await expectAdapterCode(
      harness.adapter.requestBroadcastAuthorization(signedReview()),
      'INVALID_AUTHORIZATION_GRANT'
    )
  })

  test.each(['missing', 'accessor', 'proxy'] as const)(
    'rejects a %s grant without executing untrusted accessors',
    async shape => {
      const getter = vi.fn(() => 'stolen')
      const harness = createHarness({
        core: fakeCore({
          grant: expected => {
            if (shape === 'missing') return { ...expected, authorizationId: undefined }
            if (shape === 'accessor') {
              const value = { ...expected }
              Object.defineProperty(value, 'authorizationId', { get: getter })
              return value
            }
            return new Proxy({ ...expected }, {
              getOwnPropertyDescriptor() {
                throw new Error('hostile proxy')
              }
            })
          }
        })
      })

      await expectAdapterCode(
        harness.adapter.requestBroadcastAuthorization(signedReview()),
        'INVALID_AUTHORIZATION_GRANT'
      )
      expect(getter).not.toHaveBeenCalled()
    }
  )

  test('normalizes a core start failure', async () => {
    const harness = createHarness({ core: fakeCore({ startError: new Error('core start') }) })
    await expectAdapterCode(
      harness.adapter.requestBroadcastAuthorization(signedReview()),
      'AUTHORIZATION_CORE_FAILED'
    )
  })

  test('normalizes a rejected core ready promise', async () => {
    const harness = createHarness({ core: fakeCore({ readyError: new Error('ready failed') }) })
    await expectAdapterCode(
      harness.adapter.requestBroadcastAuthorization(signedReview()),
      'AUTHORIZATION_CORE_FAILED'
    )
  })

  test('normalizes a rejected authorize promise', async () => {
    const harness = createHarness({
      core: fakeCore({ authorizeError: new Error('authorize failed') })
    })
    await expectAdapterCode(
      harness.adapter.requestBroadcastAuthorization(signedReview()),
      'AUTHORIZATION_CORE_FAILED'
    )
  })

  test('rejects concurrent and provider-triggered reentrant requests before reading them', async () => {
    const release = deferred<Tm1RegtestBroadcastAuthorizationProviderDecision>()
    const adapterRef: { value: Tm1RegtestBroadcastAuthorizationAdapter | null } = { value: null }
    const provider = vi.fn(async () => {
      const hostile = new Proxy({}, {
        getOwnPropertyDescriptor() {
          throw new Error('must not inspect reentrant input')
        }
      }) as Tm1SignedReview
      const reentrantAdapter = adapterRef.value
      if (!reentrantAdapter) throw new Error('expected adapter')
      await expectAdapterCode(
        reentrantAdapter.requestBroadcastAuthorization(hostile),
        'AUTHORIZATION_ALREADY_ACTIVE'
      )
      return release.promise
    })
    const harness = createHarness({ provider })
    const adapter = harness.adapter
    adapterRef.value = adapter
    const first = adapter.requestBroadcastAuthorization(signedReview())
    await waitUntil(() => expect(provider).toHaveBeenCalledTimes(1))

    await expectAdapterCode(
      adapter.requestBroadcastAuthorization(signedReview()),
      'AUTHORIZATION_ALREADY_ACTIVE'
    )
    release.resolve({ status: 'approved' })
    await expect(first).resolves.toMatchObject({ status: 'approved' })
  })

  test('allows retry after rejection', async () => {
    let calls = 0
    const harness = createHarness({
      provider: async () => ++calls === 1
        ? { status: 'rejected' }
        : { status: 'approved' }
    })

    await expect(harness.adapter.requestBroadcastAuthorization(signedReview())).resolves.toEqual({
      status: 'rejected'
    })
    await expect(harness.adapter.requestBroadcastAuthorization(signedReview())).resolves.toMatchObject({
      status: 'approved'
    })
  })

  test('allows retry after expiry', async () => {
    vi.useFakeTimers()
    vi.setSystemTime(NOW)
    let calls = 0
    const providerStarted = deferred<void>()
    const harness = createHarness({
      ttlMs: 100,
      now: Date.now,
      provider: async (_request, signal) => {
        calls += 1
        if (calls === 1) {
          providerStarted.resolve()
          return abortAwarePending(signal)
        }
        return { status: 'approved' }
      }
    })
    const first = harness.adapter.requestBroadcastAuthorization(signedReview())
    await providerStarted.promise

    await vi.advanceTimersByTimeAsync(100)

    await expect(first).resolves.toMatchObject({
      status: 'expired'
    })
    expect((harness.core as UniversalAuthorizationCore).activeOperationId).toBeNull()
    expect(harness.lock.leases.get('tm1-broadcast-authorization-1')?.releaseCalls).toBe(1)
    await expect(harness.adapter.requestBroadcastAuthorization(signedReview())).resolves.toMatchObject({
      status: 'approved'
    })
    expect(harness.lock.acquireCalls).toBe(2)
    expect(vi.getTimerCount()).toBe(0)
  })

  test('allows retry after external abort', async () => {
    let calls = 0
    const harness = createHarness({
      provider: async (_request, signal) => {
        calls += 1
        return calls === 1 ? abortAwarePending(signal) : { status: 'approved' }
      }
    })
    const controller = new AbortController()
    const first = harness.adapter.requestBroadcastAuthorization(signedReview(), controller.signal)
    await waitUntil(() => expect(harness.requestDecision).toHaveBeenCalledTimes(1))
    controller.abort()

    await expect(first).rejects.toMatchObject({ name: 'AbortError' })
    await expect(harness.adapter.requestBroadcastAuthorization(signedReview())).resolves.toMatchObject({
      status: 'approved'
    })
  })

  test('isolates caller request mutation while the decision is pending', async () => {
    const decision = deferred<Tm1RegtestBroadcastAuthorizationProviderDecision>()
    const harness = createHarness({ provider: async () => decision.promise })
    const request = signedReview()
    const result = harness.adapter.requestBroadcastAuthorization(request)
    await waitUntil(() => expect(harness.requestDecision).toHaveBeenCalledTimes(1))
    const mutable = request as Mutable<Tm1SignedReview>
    mutable.signedId = 'mutated'
    mutable.txid = '99'.repeat(32)
    mutable.signedArtifactHash = '88'.repeat(32)
    mutable.signingAuthorizationId = 'mutated-signing-authorization'
    request.signedArtifact.rawTransactionBytes[0] = 255
    ;(request.orderedOutputs[0] as Mutable<(typeof request.orderedOutputs)[number]>).sats = 1n
    decision.resolve({ status: 'approved' })

    await expect(result).resolves.toMatchObject({
      status: 'approved',
      signedId: SIGNED_ID,
      txid: TXID,
      signedArtifactHash: ARTIFACT_HASH
    })
    const providerRequest = harness.requestDecision.mock.calls[0]?.[0]
    expect(providerRequest?.txid).toBe(TXID)
    expect(providerRequest?.review.orderedOutputs[0]?.sats).toBe(0n)
    expect(providerRequest?.review.signedArtifact.rawTransactionByteLength).toBe(4)
  })

  test('passes a deeply isolated decision snapshot to the provider', async () => {
    const harness = createHarness({
      provider: async request => {
        expect(Object.isFrozen(request)).toBe(true)
        expect(Object.isFrozen(request.review)).toBe(true)
        expect(Object.isFrozen(request.review.signedArtifact)).toBe(true)
        expect(Object.isFrozen(request.review.orderedOutputs)).toBe(true)
        expect(Object.isFrozen(request.review.orderedOutputs[0])).toBe(true)
        return { status: 'approved' }
      }
    })

    await expect(harness.adapter.requestBroadcastAuthorization(signedReview())).resolves.toMatchObject({
      status: 'approved',
      signedId: SIGNED_ID
    })
  })

  test('returns a new frozen decision isolated from a mutable grant', async () => {
    const rawGrant: { value: Record<string, unknown> | null } = { value: null }
    const harness = createHarness({
      core: fakeCore({
        grant: expected => {
          rawGrant.value = { ...expected }
          return rawGrant.value
        }
      })
    })

    const result = await harness.adapter.requestBroadcastAuthorization(signedReview())
    const mutableGrant = rawGrant.value
    if (!mutableGrant) throw new Error('expected raw grant')
    mutableGrant.authorizationId = 'mutated-after-return'

    expect(result).toMatchObject({
      status: 'approved',
      authorizationId: 'tm1-broadcast-authorization-1:fake-capability'
    })
    expect(Object.isFrozen(result)).toBe(true)
  })

  test('rejects a broadcast grant that reuses the signing authorizationId', async () => {
    const harness = createHarness({
      core: fakeCore({
        grant: expected => ({ ...expected, authorizationId: SIGNING_AUTHORIZATION_ID })
      })
    })

    await expectAdapterCode(
      harness.adapter.requestBroadcastAuthorization(signedReview()),
      'INVALID_AUTHORIZATION_GRANT'
    )
  })

  test('returns a broadcast authorizationId distinct from the signing authorizationId', async () => {
    const result = await createHarness().adapter.requestBroadcastAuthorization(signedReview())

    expect(result).toMatchObject({ status: 'approved' })
    if (result.status !== 'approved') throw new Error('expected approval')
    expect(result.authorizationId).not.toBe(SIGNING_AUTHORIZATION_ID)
  })

  test('keeps signingAuthorizationId out of effective-content binding', async () => {
    const first = createHarness({ operationId: () => 'fixed-operation' })
    const second = createHarness({ operationId: () => 'fixed-operation' })

    await first.adapter.requestBroadcastAuthorization(signedReview())
    await second.adapter.requestBroadcastAuthorization(signedReview(
      SIGNED_ID,
      TXID,
      ARTIFACT_HASH,
      'another-signing-authorization'
    ))

    expect(first.requestDecision.mock.calls[0]?.[0].contentHash)
      .toBe(second.requestDecision.mock.calls[0]?.[0].contentHash)
  })

  test('keeps a consumed capability burned when late abort wins', async () => {
    const controller = new AbortController()
    const ledger = new TestLedger()
    ledger.onConsume = () => controller.abort()
    const harness = createHarness({ ledger, operationId: () => 'fixed-operation' })

    await expect(harness.adapter.requestBroadcastAuthorization(
      signedReview(),
      controller.signal
    )).rejects.toMatchObject({ name: 'AbortError' })
    expect(ledger.records.map(record => record.capabilityId)).toEqual([
      'fixed-operation:authorization-capability'
    ])

    await expectAdapterCode(
      harness.adapter.requestBroadcastAuthorization(signedReview()),
      'AUTHORIZATION_CORE_FAILED'
    )
    expect(ledger.records).toHaveLength(1)
  })

  test('decision provider receives review material and no authority-bearing dependencies', async () => {
    const harness = createHarness()
    await harness.adapter.requestBroadcastAuthorization(signedReview())
    const providerRequest = harness.requestDecision.mock.calls[0]?.[0]

    expect(Object.keys(providerRequest ?? {}).sort()).toEqual([
      'contentHash',
      'expiresAt',
      'operationId',
      'review',
      'signedArtifactHash',
      'signedId',
      'txid'
    ])
    expect(providerRequest).not.toHaveProperty('signingAuthorizationId')
    expect(providerRequest?.review).not.toHaveProperty('signingAuthorizationId')
    expect(JSON.stringify(providerRequest, (_key, value) =>
      typeof value === 'bigint' ? value.toString() : value
    )).not.toContain(SIGNING_AUTHORIZATION_ID)
    expect(JSON.stringify(providerRequest, (_key, value) =>
      typeof value === 'bigint' ? value.toString() : value
    )).not.toMatch(/signer|wallet|private|wif|chronik|deliveryTransport|broadcastTx/i)
  })

  test('does not inspect hidden UTXO, Chronik, signer, or transport request properties', async () => {
    const request = signedReview()
    const forbiddenGetter = vi.fn(() => { throw new Error('forbidden read') })
    Object.defineProperty(request, 'utxos', { get: forbiddenGetter })
    Object.defineProperty(request, 'chronik', { get: forbiddenGetter })
    Object.defineProperty(request, 'signer', { get: forbiddenGetter })
    Object.defineProperty(request, 'deliveryTransport', { get: forbiddenGetter })
    const harness = createHarness()

    await expect(harness.adapter.requestBroadcastAuthorization(request)).resolves.toMatchObject({
      status: 'approved'
    })
    expect(forbiddenGetter).not.toHaveBeenCalled()
  })

  test('rejects signed-artifact txid, fee, or byte/hex metadata drift', async () => {
    const txidDrift = signedReview()
    ;(txidDrift.signedArtifact as Mutable<typeof txidDrift.signedArtifact>).txid =
      '55'.repeat(32)
    const feeDrift = signedReview()
    ;(feeDrift.signedArtifact as Mutable<typeof feeDrift.signedArtifact>).feeSats = 999n
    const byteDrift = signedReview()
    byteDrift.signedArtifact.rawTransactionBytes[0] = 9
    const harness = createHarness()

    await expectAdapterCode(
      harness.adapter.requestBroadcastAuthorization(txidDrift),
      'INVALID_AUTHORIZATION_REQUEST'
    )
    await expectAdapterCode(
      harness.adapter.requestBroadcastAuthorization(feeDrift),
      'INVALID_AUTHORIZATION_REQUEST'
    )
    await expectAdapterCode(
      harness.adapter.requestBroadcastAuthorization(byteDrift),
      'INVALID_AUTHORIZATION_REQUEST'
    )
  })

  test('keeps bindingHash informative and out of the broadcast canonical payload', async () => {
    const first = createHarness({ operationId: () => 'fixed-operation' })
    const second = createHarness({ operationId: () => 'fixed-operation' })
    const changedBinding = signedReview()
    ;(changedBinding as Mutable<Tm1SignedReview>).bindingHash = 'aa'.repeat(32)

    await first.adapter.requestBroadcastAuthorization(signedReview())
    await second.adapter.requestBroadcastAuthorization(changedBinding)

    expect(first.requestDecision.mock.calls[0]?.[0].contentHash)
      .toBe(second.requestDecision.mock.calls[0]?.[0].contentHash)
  })

  test('rejects malformed provider decisions', async () => {
    const harness = createHarness({ provider: async () => ({ status: 'expired' } as never) })
    await expectAdapterCode(
      harness.adapter.requestBroadcastAuthorization(signedReview()),
      'INVALID_AUTHORIZATION_DECISION'
    )
  })

  test('normalizes provider exceptions without granting authorization', async () => {
    const harness = createHarness({ provider: async () => { throw new Error('provider failed') } })
    await expectAdapterCode(
      harness.adapter.requestBroadcastAuthorization(signedReview()),
      'AUTHORIZATION_PROVIDER_FAILED'
    )
    expect(harness.ledger.records).toHaveLength(0)
  })
})

function fixtureUtxos(): readonly Tm1Draft02FreshUtxo[] {
  return Object.freeze([
    Object.freeze({
      txid: 'aa'.repeat(32),
      outIdx: 0,
      sats: 20_000n,
      lockingScriptHex: TM1_REGTEST_FIXTURE_LOCKING_SCRIPT_HEX,
      token: null
    }),
    Object.freeze({
      txid: 'bb'.repeat(32),
      outIdx: 1,
      sats: 10_000n,
      lockingScriptHex: TM1_REGTEST_FIXTURE_LOCKING_SCRIPT_HEX,
      token: null
    })
  ])
}

const PUBLICATION_REQUEST: Tm1PublicationRequest = Object.freeze({
  message: 'TM1 separate broadcast authorization integration',
  activeLockingScriptHex: TM1_REGTEST_FIXTURE_LOCKING_SCRIPT_HEX,
  maxFeeSats: 10_000n
})

type IntegrationOptions = Readonly<{
  broadcastProvider?: Tm1RegtestBroadcastAuthorizationDecisionProvider['requestDecision']
  broadcastTtlMs?: number
  now?: () => number
  ledger?: TestLedger
  failSecondAudit?: boolean
}>

function integrationHarness(options: IntegrationOptions = {}) {
  const events: string[] = []
  const states: string[] = []
  const lock = new TestLock()
  const ledger = options.ledger ?? new TestLedger()
  const now = options.now ?? (() => NOW)
  const core = new UniversalAuthorizationCore({
    enabled: true,
    lock,
    approvalLedger: ledger,
    now,
    createCapabilityId: operationId => `${operationId}:integration-capability`
  })
  let signingOperationIds = 0
  let broadcastOperationIds = 0
  let publicationIds = 0
  const signingRequestDecision = vi.fn(async () => {
    events.push('signing-approval')
    return Object.freeze({ status: 'approved' as const })
  })
  const broadcastRequestDecision = vi.fn(options.broadcastProvider ?? (async () => {
    events.push('broadcast-approval')
    return Object.freeze({ status: 'approved' as const })
  }))
  const signingAuthorization = new Tm1RegtestAuthorizationAdapter({
    core,
    decisionProvider: { requestDecision: signingRequestDecision },
    now,
    ttlMs: 10_000,
    createOperationId: () => `integration-signing-${++signingOperationIds}`,
    requester: {
      declaredOrigin: 'https://tm1-regtest.invalid',
      displayName: 'TM1 signing integration'
    }
  })
  const broadcastAuthorization = new Tm1RegtestBroadcastAuthorizationAdapter({
    core,
    decisionProvider: {
      async requestDecision(request, signal) {
        if (options.broadcastProvider) events.push('broadcast-approval')
        return broadcastRequestDecision(request, signal)
      }
    },
    now,
    ttlMs: options.broadcastTtlMs ?? 10_000,
    createOperationId: () => `integration-broadcast-${++broadcastOperationIds}`,
    requester: {
      declaredOrigin: 'https://tm1-regtest.invalid',
      displayName: 'TM1 broadcast integration'
    }
  })
  const calls = {
    attest: 0,
    utxos: 0,
    signer: 0,
    audit: 0,
    broadcast: 0
  }
  const dependencies: Tm1RegtestPublicationDependencies = {
    networkAttestation: {
      async attest(signal) {
        calls.attest += 1
        events.push(`attest-${calls.attest}`)
        if (signal?.aborted) throw signal.reason
        return Object.freeze({
          environment: 'deterministic-regtest-fixture' as const,
          chainIdentity: 'tm1-regtest-chain'
        })
      }
    },
    utxoProvider: {
      async readUtxos(signal) {
        calls.utxos += 1
        events.push(`utxos-${calls.utxos}`)
        if (signal?.aborted) throw signal.reason
        return fixtureUtxos()
      }
    },
    signingAuthorization,
    signer: {
      async sign(review, signal) {
        calls.signer += 1
        events.push('sign')
        return signTm1Draft02RegtestCandidate({ candidate: review.candidate, signal })
      }
    },
    signedArtifactAudit: {
      async auditSignedArtifact({ signedArtifact, signal }) {
        calls.audit += 1
        events.push(`audit-${calls.audit}`)
        if (signal?.aborted) throw signal.reason
        if (options.failSecondAudit && calls.audit === 2) {
          throw new Error('post-approval re-audit failed')
        }
        return Object.freeze({
          ...signedArtifact,
          rawTransactionBytes: new Uint8Array(signedArtifact.rawTransactionBytes)
        })
      }
    },
    broadcastAuthorization,
    deliveryTransport: {
      async broadcast(signedArtifact) {
        calls.broadcast += 1
        events.push('broadcast')
        return Object.freeze({
          txid: signedArtifact.txid,
          disposition: 'accepted' as const
        })
      }
    },
    confirmationObserver: {
      async confirm({ submissionId, txid }) {
        return Object.freeze({ submissionId, txid, confirmations: 1 })
      }
    },
    clock: {
      createId(prefix) {
        publicationIds += 1
        return `${prefix}-${publicationIds}`
      }
    }
  }
  const orchestrator = new Tm1RegtestPublicationOrchestratorImpl(dependencies)
  orchestrator.subscribe(state => { states.push(state.status) })
  return Object.freeze({
    orchestrator,
    calls,
    events,
    states,
    ledger,
    lock,
    core,
    signingRequestDecision,
    broadcastRequestDecision
  })
}

async function integrationPrepareAndSign(
  harness: ReturnType<typeof integrationHarness>
): Promise<Tm1SignedReview> {
  const review = await harness.orchestrator.prepare(PUBLICATION_REQUEST)
  return harness.orchestrator.authorizeAndSign(review.preparedId)
}

describe('TM1 broadcast adapter integration with the unchanged 6-B orchestrator', () => {
  test('cannot request broadcast authorization before signedReviewReady', async () => {
    const harness = integrationHarness()

    await expect(harness.orchestrator.approveAndBroadcast('missing')).rejects.toMatchObject({
      code: 'INVALID_STATE'
    })
    expect(harness.broadcastRequestDecision).not.toHaveBeenCalled()
    expect(harness.calls.broadcast).toBe(0)
  })

  test('keeps two approvals separate and re-audits only after broadcast approval', async () => {
    const approval = deferred<Tm1RegtestBroadcastAuthorizationProviderDecision>()
    const providerStarted = deferred<void>()
    const harness = integrationHarness({
      broadcastProvider: async request => {
        expect(harness.orchestrator.getState().status).toBe('approvingBroadcast')
        expect(request.signedId).toMatch(/^signed-/)
        providerStarted.resolve()
        return approval.promise
      }
    })
    const signed = await integrationPrepareAndSign(harness)

    expect(harness.broadcastRequestDecision).not.toHaveBeenCalled()
    expect(harness.signingRequestDecision).toHaveBeenCalledTimes(1)
    expect(harness.calls.signer).toBe(1)
    expect(harness.calls.audit).toBe(1)
    expect(harness.states).toContain('signedReviewReady')

    const result = harness.orchestrator.approveAndBroadcast(signed.signedId)
    await providerStarted.promise
    expect(harness.calls.broadcast).toBe(0)
    expect(harness.calls.audit).toBe(1)
    expect(harness.calls.signer).toBe(1)
    expect(harness.signingRequestDecision).toHaveBeenCalledTimes(1)

    approval.resolve({ status: 'approved' })
    await expect(result).resolves.toMatchObject({ txid: signed.txid })

    expect(harness.calls).toEqual({ attest: 2, utxos: 2, signer: 1, audit: 2, broadcast: 1 })
    expect(harness.events).toEqual([
      'attest-1',
      'utxos-1',
      'signing-approval',
      'attest-2',
      'utxos-2',
      'sign',
      'audit-1',
      'broadcast-approval',
      'audit-2',
      'broadcast'
    ])
    expect(harness.ledger.records).toHaveLength(2)
    expect(harness.ledger.records[0]?.capabilityId)
      .not.toBe(harness.ledger.records[1]?.capabilityId)
  })

  test('provider rejection prevents signed-artifact re-audit and broadcast', async () => {
    const harness = integrationHarness({
      broadcastProvider: async () => ({ status: 'rejected', reason: 'operator declined' })
    })
    const signed = await integrationPrepareAndSign(harness)

    await expect(harness.orchestrator.approveAndBroadcast(signed.signedId)).rejects.toMatchObject({
      code: 'BROADCAST_REJECTED'
    })
    expect(harness.calls.audit).toBe(1)
    expect(harness.calls.broadcast).toBe(0)
  })

  test('never-settling provider expiry terminates authorization and blocks broadcast', async () => {
    vi.useFakeTimers()
    vi.setSystemTime(NOW)
    const providerStarted = deferred<void>()
    const harness = integrationHarness({
      broadcastTtlMs: 100,
      now: Date.now,
      broadcastProvider: () => {
        providerStarted.resolve()
        return new Promise<Tm1RegtestBroadcastAuthorizationProviderDecision>(() => undefined)
      }
    })
    const signed = await integrationPrepareAndSign(harness)
    const result = harness.orchestrator.approveAndBroadcast(signed.signedId)
    const resultExpectation = expect(result).rejects.toMatchObject({
      code: 'BROADCAST_AUTHORIZATION_EXPIRED'
    })
    await providerStarted.promise

    await vi.advanceTimersByTimeAsync(100)

    await resultExpectation
    expect(harness.calls.broadcast).toBe(0)
    expect(harness.calls.audit).toBe(1)
    expect(harness.core.activeOperationId).toBeNull()
    expect(harness.lock.leases.get('integration-broadcast-1')?.releaseCalls).toBe(1)
    expect(vi.getTimerCount()).toBe(0)
  })

  test('never-settling provider external abort terminates authorization and blocks broadcast', async () => {
    const providerStarted = deferred<void>()
    const harness = integrationHarness({
      broadcastProvider: () => {
        providerStarted.resolve()
        return new Promise<Tm1RegtestBroadcastAuthorizationProviderDecision>(() => undefined)
      }
    })
    const signed = await integrationPrepareAndSign(harness)
    const controller = new AbortController()
    const result = harness.orchestrator.approveAndBroadcast(signed.signedId, controller.signal)
    await providerStarted.promise

    controller.abort()

    await expect(result).rejects.toSatisfy(error =>
      error instanceof Tm1PublicationError && error.code === 'ABORTED'
    )
    expect(harness.calls.broadcast).toBe(0)
    expect(harness.calls.audit).toBe(1)
    expect(harness.core.activeOperationId).toBeNull()
  })

  test('stale signedId is rejected before consulting broadcast authorization', async () => {
    const harness = integrationHarness()
    const signed = await integrationPrepareAndSign(harness)

    await expect(
      harness.orchestrator.approveAndBroadcast(`${signed.signedId}-stale`)
    ).rejects.toMatchObject({ code: 'STALE_SIGNED_REVIEW' })
    expect(harness.broadcastRequestDecision).not.toHaveBeenCalled()
    expect(harness.calls.broadcast).toBe(0)
  })

  test('post-approval re-audit failure leaves the broadcast grant burned', async () => {
    const harness = integrationHarness({ failSecondAudit: true })
    const signed = await integrationPrepareAndSign(harness)

    await expect(harness.orchestrator.approveAndBroadcast(signed.signedId)).rejects.toMatchObject({
      code: 'SIGNED_ARTIFACT_INVALID'
    })
    expect(harness.ledger.records).toHaveLength(2)
    expect(harness.ledger.records[1]?.capabilityId).toBe(
      'integration-broadcast-1:integration-capability'
    )
    expect(harness.ledger.consumedCapabilityIds).toContain(
      'integration-broadcast-1:integration-capability'
    )
    expect(harness.calls.audit).toBe(2)
    expect(harness.calls.broadcast).toBe(0)
  })
})
