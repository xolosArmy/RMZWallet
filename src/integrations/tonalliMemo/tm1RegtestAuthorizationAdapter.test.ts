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
  type Tm1SigningAuthorizationRequest
} from './tm1RegtestPublicationOrchestrator'
import {
  TM1_REGTEST_SIGNING_AUTHORIZATION_PAYLOAD_DOMAIN,
  TM1_REGTEST_SIGNING_AUTHORIZATION_PROFILE_ID,
  Tm1RegtestAuthorizationAdapter,
  Tm1RegtestAuthorizationAdapterError,
  encodeTm1RegtestSigningAuthorizationPayload,
  type Tm1RegtestAuthorizationCorePort,
  type Tm1RegtestAuthorizationDecisionProvider,
  type Tm1RegtestAuthorizationProviderDecision
} from './tm1RegtestAuthorizationAdapter'

const NOW = 1_900_000_000_000
const BINDING_HASH = '8de472e2399610baaa7f84840547cd409434e31f5d3bd71e4d947f283874f9c0'
const VECTOR_BINDING_HASH = '11'.repeat(32)
const PREPARED_ID = 'prepared-1'
const SCRIPT = `76a914${'22'.repeat(20)}88ac`

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

  constructor(operationId: string) {
    this.ownerOperationId = operationId
  }

  isOwned(): boolean {
    return this.owned
  }

  release(): void {
    this.owned = false
  }
}

class TestLock implements UniversalOperationLock {
  acquireCalls = 0

  async acquire(operationId: string, signal: AbortSignal): Promise<UniversalOperationLease> {
    this.acquireCalls += 1
    if (signal.aborted) throw signal.reason
    return new TestLease(operationId)
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

function signingRequest(
  preparedId = PREPARED_ID,
  bindingHash = BINDING_HASH
): Tm1SigningAuthorizationRequest {
  return {
    preparedId,
    bindingHash,
    review: {
      preparedId,
      bindingHash,
      message: 'Authorize this TM1 publication',
      network: {
        environment: 'deterministic-regtest-fixture',
        chainIdentity: 'tm1-regtest-chain'
      },
      candidate: {} as Tm1SigningAuthorizationRequest['review']['candidate'],
      effectiveContent: new Uint8Array([1, 2, 3, 4]),
      orderedInputs: [{
        index: 0,
        role: 'author',
        txid: 'aa'.repeat(32),
        outIdx: 0,
        sats: 20_000n,
        lockingScriptHex: SCRIPT
      }],
      orderedOutputs: [{
        index: 0,
        role: 'tm1_op_return',
        sats: 0n,
        scriptHex: '6a00'
      }],
      feeSats: 1_000n
    }
  }
}

type HarnessOptions = Readonly<{
  provider?: Tm1RegtestAuthorizationDecisionProvider['requestDecision']
  ttlMs?: number
  now?: () => number
  operationId?: () => string
  ledger?: TestLedger
  core?: Tm1RegtestAuthorizationCorePort
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
  const adapter = new Tm1RegtestAuthorizationAdapter({
    core,
    decisionProvider: { requestDecision },
    now,
    ttlMs: options.ttlMs ?? 10_000,
    createOperationId: options.operationId ?? (() => `tm1-authorization-${++sequence}`),
    requester: {
      declaredOrigin: 'https://tm1-regtest.invalid',
      displayName: 'TM1 regtest authorization'
    }
  })
  return Object.freeze({ adapter, core, ledger, lock, requestDecision })
}

async function waitUntil(assertion: () => void): Promise<void> {
  await vi.waitFor(assertion, { timeout: 1_000, interval: 1 })
}

async function expectAdapterCode(
  promise: Promise<unknown>,
  code: Tm1RegtestAuthorizationAdapterError['code']
): Promise<void> {
  await expect(promise).rejects.toMatchObject({
    name: 'Tm1RegtestAuthorizationAdapterError',
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

function fakeCore(options: FakeCoreOptions = {}): Tm1RegtestAuthorizationCorePort {
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
      }) as unknown as ReturnType<Tm1RegtestAuthorizationCorePort['startAuthorization']>
    }
  }
}

afterEach(() => {
  vi.restoreAllMocks()
  vi.useRealTimers()
})

describe('TM1 regtest authorization adapter', () => {
  test('returns an approved decision bound to the original prepared review', async () => {
    const harness = createHarness()

    const result = await harness.adapter.requestSigningAuthorization(signingRequest())

    expect(result).toEqual({
      status: 'approved',
      authorizationId: 'tm1-authorization-1:authorization-capability',
      preparedId: PREPARED_ID,
      bindingHash: BINDING_HASH
    })
    expect(Object.isFrozen(result)).toBe(true)
    expect(harness.ledger.records).toHaveLength(1)
    expect(TM1_REGTEST_SIGNING_AUTHORIZATION_PROFILE_ID).toBe(
      'tonalli.tm1-regtest.signing-authorization.v1'
    )
  })

  test('maps provider rejection through handle.reject()', async () => {
    const harness = createHarness({
      provider: async () => ({ status: 'rejected', reason: 'operator declined' })
    })

    await expect(harness.adapter.requestSigningAuthorization(signingRequest())).resolves.toEqual({
      status: 'rejected',
      reason: 'operator declined'
    })
    expect(harness.ledger.records).toHaveLength(0)
  })

  test('maps core expiry while the decision provider is pending', async () => {
    const harness = createHarness({
      ttlMs: 10,
      now: Date.now,
      provider: async (_request, signal) => abortAwarePending(signal)
    })

    await expect(harness.adapter.requestSigningAuthorization(signingRequest())).resolves.toEqual({
      status: 'expired',
      reason: 'TM1 signing authorization expired'
    })
    expect(harness.ledger.records).toHaveLength(0)
  })

  test('rejects an already-aborted external signal before core callbacks', async () => {
    const startAuthorization = vi.fn()
    const harness = createHarness({ core: { startAuthorization } })
    const controller = new AbortController()
    controller.abort()

    await expect(harness.adapter.requestSigningAuthorization(
      signingRequest(),
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
    const result = harness.adapter.requestSigningAuthorization(signingRequest(), controller.signal)
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

    await expect(harness.adapter.requestSigningAuthorization(
      signingRequest(),
      controller.signal
    )).rejects.toMatchObject({ name: 'AbortError' })
    expect(onAuthorize).not.toHaveBeenCalled()
  })

  test.each(['', '   '])('rejects invalid preparedId %j', async preparedId => {
    const harness = createHarness()
    await expectAdapterCode(
      harness.adapter.requestSigningAuthorization(signingRequest(preparedId)),
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
  ])('rejects non-canonical bindingHash %j', async bindingHash => {
    const harness = createHarness()
    await expectAdapterCode(
      harness.adapter.requestSigningAuthorization(signingRequest(PREPARED_ID, bindingHash)),
      'INVALID_AUTHORIZATION_REQUEST'
    )
  })

  test('encodes the exact uint32-BE preparedId + bindingHash payload vector', () => {
    const encoded = encodeTm1RegtestSigningAuthorizationPayload({
      preparedId: PREPARED_ID,
      bindingHash: VECTOR_BINDING_HASH
    })

    expect(TM1_REGTEST_SIGNING_AUTHORIZATION_PAYLOAD_DOMAIN).toBe(
      'tonalli.tm1-regtest/signing-authorization/v1'
    )
    expect(Buffer.from(encoded).toString('hex')).toBe(
      '0000002c746f6e616c6c692e746d312d726567746573742f7369676e696e672d' +
      '617574686f72697a6174696f6e2f76310000000a70726570617265642d31' +
      '1111111111111111111111111111111111111111111111111111111111111111'
    )
  })

  test('keeps UniversalContentHash distinct from the TM1 bindingHash', async () => {
    const harness = createHarness()
    await harness.adapter.requestSigningAuthorization(signingRequest())
    const providerRequest = harness.requestDecision.mock.calls[0]?.[0]

    expect(providerRequest?.contentHash).toMatch(/^sha256:[0-9a-f]{64}$/)
    expect(providerRequest?.contentHash).not.toBe(BINDING_HASH)
  })

  test('rejects a cached grant with another operationId', async () => {
    const harness = createHarness({
      core: fakeCore({ grant: expected => ({ ...expected, operationId: 'stale-operation' }) })
    })
    await expectAdapterCode(
      harness.adapter.requestSigningAuthorization(signingRequest()),
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
      harness.adapter.requestSigningAuthorization(signingRequest()),
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
        harness.adapter.requestSigningAuthorization(signingRequest()),
        'INVALID_AUTHORIZATION_GRANT'
      )
      expect(getter).not.toHaveBeenCalled()
    }
  )

  test('normalizes a core start failure', async () => {
    const harness = createHarness({ core: fakeCore({ startError: new Error('core start') }) })
    await expectAdapterCode(
      harness.adapter.requestSigningAuthorization(signingRequest()),
      'AUTHORIZATION_CORE_FAILED'
    )
  })

  test('normalizes a rejected core ready promise', async () => {
    const harness = createHarness({ core: fakeCore({ readyError: new Error('ready failed') }) })
    await expectAdapterCode(
      harness.adapter.requestSigningAuthorization(signingRequest()),
      'AUTHORIZATION_CORE_FAILED'
    )
  })

  test('normalizes a rejected authorize promise', async () => {
    const harness = createHarness({
      core: fakeCore({ authorizeError: new Error('authorize failed') })
    })
    await expectAdapterCode(
      harness.adapter.requestSigningAuthorization(signingRequest()),
      'AUTHORIZATION_CORE_FAILED'
    )
  })

  test('rejects concurrent and provider-triggered reentrant requests before reading them', async () => {
    const release = deferred<Tm1RegtestAuthorizationProviderDecision>()
    const adapterRef: { value: Tm1RegtestAuthorizationAdapter | null } = { value: null }
    const provider = vi.fn(async () => {
      const hostile = new Proxy({}, {
        getOwnPropertyDescriptor() {
          throw new Error('must not inspect reentrant input')
        }
      }) as Tm1SigningAuthorizationRequest
      const reentrantAdapter = adapterRef.value
      if (!reentrantAdapter) throw new Error('expected adapter')
      await expectAdapterCode(
        reentrantAdapter.requestSigningAuthorization(hostile),
        'AUTHORIZATION_ALREADY_ACTIVE'
      )
      return release.promise
    })
    const harness = createHarness({ provider })
    const adapter = harness.adapter
    adapterRef.value = adapter
    const first = adapter.requestSigningAuthorization(signingRequest())
    await waitUntil(() => expect(provider).toHaveBeenCalledTimes(1))

    await expectAdapterCode(
      adapter.requestSigningAuthorization(signingRequest()),
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

    await expect(harness.adapter.requestSigningAuthorization(signingRequest())).resolves.toEqual({
      status: 'rejected'
    })
    await expect(harness.adapter.requestSigningAuthorization(signingRequest())).resolves.toMatchObject({
      status: 'approved'
    })
  })

  test('allows retry after expiry', async () => {
    let calls = 0
    const harness = createHarness({
      ttlMs: 10,
      now: Date.now,
      provider: async (_request, signal) => {
        calls += 1
        return calls === 1 ? abortAwarePending(signal) : { status: 'approved' }
      }
    })

    await expect(harness.adapter.requestSigningAuthorization(signingRequest())).resolves.toMatchObject({
      status: 'expired'
    })
    await expect(harness.adapter.requestSigningAuthorization(signingRequest())).resolves.toMatchObject({
      status: 'approved'
    })
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
    const first = harness.adapter.requestSigningAuthorization(signingRequest(), controller.signal)
    await waitUntil(() => expect(harness.requestDecision).toHaveBeenCalledTimes(1))
    controller.abort()

    await expect(first).rejects.toMatchObject({ name: 'AbortError' })
    await expect(harness.adapter.requestSigningAuthorization(signingRequest())).resolves.toMatchObject({
      status: 'approved'
    })
  })

  test('isolates caller request mutation while the decision is pending', async () => {
    const decision = deferred<Tm1RegtestAuthorizationProviderDecision>()
    const harness = createHarness({ provider: async () => decision.promise })
    const request = signingRequest()
    const result = harness.adapter.requestSigningAuthorization(request)
    await waitUntil(() => expect(harness.requestDecision).toHaveBeenCalledTimes(1))
    const mutable = request as Mutable<Tm1SigningAuthorizationRequest>
    mutable.preparedId = 'mutated'
    request.review.effectiveContent[0] = 255
    ;(request.review.orderedInputs[0] as Mutable<(typeof request.review.orderedInputs)[number]>).sats = 1n
    decision.resolve({ status: 'approved' })

    await expect(result).resolves.toMatchObject({
      status: 'approved',
      preparedId: PREPARED_ID,
      bindingHash: BINDING_HASH
    })
    const providerRequest = harness.requestDecision.mock.calls[0]?.[0]
    expect(providerRequest?.review.effectiveContent[0]).toBe(1)
    expect(providerRequest?.review.orderedInputs[0]?.sats).toBe(20_000n)
  })

  test('passes a deeply isolated decision snapshot to the provider', async () => {
    const harness = createHarness({
      provider: async request => {
        expect(Object.isFrozen(request)).toBe(true)
        expect(Object.isFrozen(request.review)).toBe(true)
        expect(Object.isFrozen(request.review.network)).toBe(true)
        expect(Object.isFrozen(request.review.orderedInputs)).toBe(true)
        request.review.effectiveContent[0] = 99
        return { status: 'approved' }
      }
    })

    await expect(harness.adapter.requestSigningAuthorization(signingRequest())).resolves.toMatchObject({
      status: 'approved',
      preparedId: PREPARED_ID
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

    const result = await harness.adapter.requestSigningAuthorization(signingRequest())
    const mutableGrant = rawGrant.value
    if (!mutableGrant) throw new Error('expected raw grant')
    mutableGrant.authorizationId = 'mutated-after-return'

    expect(result).toMatchObject({
      status: 'approved',
      authorizationId: 'tm1-authorization-1:fake-capability'
    })
    expect(Object.isFrozen(result)).toBe(true)
  })

  test('keeps a consumed capability burned when late abort wins', async () => {
    const controller = new AbortController()
    const ledger = new TestLedger()
    ledger.onConsume = () => controller.abort()
    const harness = createHarness({ ledger, operationId: () => 'fixed-operation' })

    await expect(harness.adapter.requestSigningAuthorization(
      signingRequest(),
      controller.signal
    )).rejects.toMatchObject({ name: 'AbortError' })
    expect(ledger.records.map(record => record.capabilityId)).toEqual([
      'fixed-operation:authorization-capability'
    ])

    await expectAdapterCode(
      harness.adapter.requestSigningAuthorization(signingRequest()),
      'AUTHORIZATION_CORE_FAILED'
    )
    expect(ledger.records).toHaveLength(1)
  })

  test('decision provider receives review material and no authority-bearing dependencies', async () => {
    const harness = createHarness()
    await harness.adapter.requestSigningAuthorization(signingRequest())
    const providerRequest = harness.requestDecision.mock.calls[0]?.[0]

    expect(Object.keys(providerRequest ?? {}).sort()).toEqual([
      'bindingHash',
      'contentHash',
      'expiresAt',
      'operationId',
      'preparedId',
      'review'
    ])
    expect(JSON.stringify(providerRequest, (_key, value) =>
      typeof value === 'bigint' ? value.toString() : value
    )).not.toMatch(/signer|wallet|private|wif|chronik|broadcast|transport/i)
  })

  test('does not inspect candidate or hidden UTXO/Chronik-like request properties', async () => {
    const request = signingRequest()
    const forbiddenGetter = vi.fn(() => { throw new Error('forbidden read') })
    Object.defineProperty(request.review.candidate, 'utxos', { get: forbiddenGetter })
    Object.defineProperty(request, 'chronik', { get: forbiddenGetter })
    const harness = createHarness()

    await expect(harness.adapter.requestSigningAuthorization(request)).resolves.toMatchObject({
      status: 'approved'
    })
    expect(forbiddenGetter).not.toHaveBeenCalled()
  })

  test('rejects nested preparedId or bindingHash drift from the outer request', async () => {
    const preparedDrift = signingRequest()
    ;(preparedDrift.review as Mutable<typeof preparedDrift.review>).preparedId = 'another-prepared'
    const bindingDrift = signingRequest()
    ;(bindingDrift.review as Mutable<typeof bindingDrift.review>).bindingHash = '22'.repeat(32)
    const harness = createHarness()

    await expectAdapterCode(
      harness.adapter.requestSigningAuthorization(preparedDrift),
      'INVALID_AUTHORIZATION_REQUEST'
    )
    await expectAdapterCode(
      harness.adapter.requestSigningAuthorization(bindingDrift),
      'INVALID_AUTHORIZATION_REQUEST'
    )
  })

  test('rejects a canonical bindingHash that is not SHA256d(review.effectiveContent)', async () => {
    const request = signingRequest()
    request.review.effectiveContent[0] = 2
    const harness = createHarness()

    await expectAdapterCode(
      harness.adapter.requestSigningAuthorization(request),
      'INVALID_AUTHORIZATION_REQUEST'
    )
  })

  test('rejects malformed provider decisions', async () => {
    const harness = createHarness({ provider: async () => ({ status: 'expired' } as never) })
    await expectAdapterCode(
      harness.adapter.requestSigningAuthorization(signingRequest()),
      'INVALID_AUTHORIZATION_DECISION'
    )
  })

  test('normalizes provider exceptions without granting authorization', async () => {
    const harness = createHarness({ provider: async () => { throw new Error('provider failed') } })
    await expectAdapterCode(
      harness.adapter.requestSigningAuthorization(signingRequest()),
      'AUTHORIZATION_PROVIDER_FAILED'
    )
    expect(harness.ledger.records).toHaveLength(0)
  })
})

type Mutable<T> = { -readonly [Key in keyof T]: T[Key] }

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

function integrationHarness(
  provider: Tm1RegtestAuthorizationDecisionProvider['requestDecision'],
  ttlMs = 10_000
) {
  const events: string[] = []
  let adapterIds = 0
  let publicationIds = 0
  const ledger = new TestLedger()
  const now = ttlMs <= 100 ? Date.now : () => NOW
  const core = new UniversalAuthorizationCore({
    enabled: true,
    lock: new TestLock(),
    approvalLedger: ledger,
    now,
    createCapabilityId: operationId => `${operationId}:integration-capability`
  })
  const signingAuthorization = new Tm1RegtestAuthorizationAdapter({
    core,
    decisionProvider: {
      async requestDecision(request, signal) {
        events.push('authorization-decision')
        return provider(request, signal)
      }
    },
    now,
    ttlMs,
    createOperationId: () => `integration-authorization-${++adapterIds}`,
    requester: {
      declaredOrigin: 'https://tm1-regtest.invalid',
      displayName: 'TM1 integration test'
    }
  })
  const calls = { attest: 0, utxos: 0, signer: 0 }
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
      async auditSignedArtifact({ signedArtifact }) {
        return signedArtifact
      }
    },
    broadcastAuthorization: {
      async requestBroadcastAuthorization(review) {
        return Object.freeze({
          status: 'approved' as const,
          authorizationId: 'unused-broadcast-authorization',
          signedId: review.signedId,
          txid: review.txid,
          signedArtifactHash: review.signedArtifactHash
        })
      }
    },
    deliveryTransport: {
      async broadcast(signedArtifact) {
        return Object.freeze({ txid: signedArtifact.txid, disposition: 'accepted' as const })
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
  return Object.freeze({
    orchestrator: new Tm1RegtestPublicationOrchestratorImpl(dependencies),
    calls,
    events,
    ledger
  })
}

const PUBLICATION_REQUEST: Tm1PublicationRequest = Object.freeze({
  message: 'TM1 adapter integration',
  activeLockingScriptHex: TM1_REGTEST_FIXTURE_LOCKING_SCRIPT_HEX,
  maxFeeSats: 10_000n
})

describe('TM1 adapter integration with the unchanged 6-B orchestrator', () => {
  test('authorizes the exact binding, then 6-B revalidates before invoking signer', async () => {
    const harness = integrationHarness(async request => {
      expect(request.preparedId).toBe('prepared-1')
      expect(request.bindingHash).toMatch(/^[0-9a-f]{64}$/)
      return { status: 'approved' }
    })
    const review = await harness.orchestrator.prepare(PUBLICATION_REQUEST)

    const signed = await harness.orchestrator.authorizeAndSign(review.preparedId)

    expect(signed.preparedId).toBe(review.preparedId)
    expect(signed.bindingHash).toBe(review.bindingHash)
    expect(harness.calls).toEqual({ attest: 2, utxos: 2, signer: 1 })
    expect(harness.events).toEqual([
      'attest-1',
      'utxos-1',
      'authorization-decision',
      'attest-2',
      'utxos-2',
      'sign'
    ])
    expect(harness.ledger.records).toHaveLength(1)
  })

  test('provider rejection prevents 6-B signer invocation', async () => {
    const harness = integrationHarness(async () => ({ status: 'rejected', reason: 'no' }))
    const review = await harness.orchestrator.prepare(PUBLICATION_REQUEST)

    await expect(harness.orchestrator.authorizeAndSign(review.preparedId)).rejects.toMatchObject({
      code: 'SIGNING_REJECTED'
    })
    expect(harness.calls.signer).toBe(0)
  })

  test('core expiry prevents 6-B signer invocation', async () => {
    const harness = integrationHarness(
      async (_request, signal) => abortAwarePending(signal),
      10
    )
    const review = await harness.orchestrator.prepare(PUBLICATION_REQUEST)

    await expect(harness.orchestrator.authorizeAndSign(review.preparedId)).rejects.toMatchObject({
      code: 'SIGNING_AUTHORIZATION_EXPIRED'
    })
    expect(harness.calls.signer).toBe(0)
  })

  test('external abort prevents 6-B signer invocation', async () => {
    const started = deferred<void>()
    const harness = integrationHarness(async (_request, signal) => {
      started.resolve()
      return abortAwarePending(signal)
    })
    const review = await harness.orchestrator.prepare(PUBLICATION_REQUEST)
    const controller = new AbortController()
    const result = harness.orchestrator.authorizeAndSign(review.preparedId, controller.signal)
    await started.promise
    controller.abort()

    await expect(result).rejects.toSatisfy(error =>
      error instanceof Tm1PublicationError && error.code === 'ABORTED'
    )
    expect(harness.calls.signer).toBe(0)
  })
})
