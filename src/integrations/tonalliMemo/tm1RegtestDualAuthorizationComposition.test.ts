import { afterEach, describe, expect, test, vi } from 'vitest'
import type {
  ApprovalConsumption,
  ApprovalConsumptionLedger
} from '../../features/externalSign/approval'
import type {
  UniversalOperationLease,
  UniversalOperationLock
} from '../../features/externalSign/lock'
import type { Tm1Draft02FreshUtxo } from './tm1Draft02Candidate'
import {
  TM1_REGTEST_FIXTURE_LOCKING_SCRIPT_HEX,
  signTm1Draft02RegtestCandidate
} from './tm1Draft02RegtestP2pkhSigner'
import type {
  Tm1RegtestAuthorizationDecisionRequest,
  Tm1RegtestAuthorizationDecisionProvider,
  Tm1RegtestAuthorizationProviderDecision
} from './tm1RegtestAuthorizationAdapter'
import type {
  Tm1RegtestBroadcastAuthorizationDecisionRequest,
  Tm1RegtestBroadcastAuthorizationDecisionProvider,
  Tm1RegtestBroadcastAuthorizationProviderDecision
} from './tm1RegtestBroadcastAuthorizationAdapter'
import {
  TM1_REGTEST_BROADCAST_OPERATION_ID_PREFIX,
  TM1_REGTEST_SIGNING_OPERATION_ID_PREFIX,
  Tm1RegtestDualAuthorizationCompositionError,
  createTm1RegtestDualAuthorizationPorts
} from './tm1RegtestDualAuthorizationComposition'
import {
  Tm1PublicationError,
  Tm1RegtestPublicationOrchestratorImpl,
  type Tm1PublicationRequest,
  type Tm1RegtestPublicationDependencies,
  type Tm1SignedReview,
  type Tm1SigningAuthorizationRequest
} from './tm1RegtestPublicationOrchestrator'

const NOW = 1_900_000_000_000
const PREPARED_ID = 'prepared-direct-1'
const SIGNED_ID = 'signed-direct-1'
const TXID = '22'.repeat(32)
const ARTIFACT_HASH = '33'.repeat(32)
const BINDING_HASH = '8de472e2399610baaa7f84840547cd409434e31f5d3bd71e4d947f283874f9c0'
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
  releaseCalls = 0

  constructor(operationId: string) {
    this.ownerOperationId = operationId
  }

  isOwned(): boolean {
    return this.owned
  }

  release(): void {
    if (!this.owned) throw new Error('lease released twice')
    this.releaseCalls += 1
    this.owned = false
  }
}

class TestLock implements UniversalOperationLock {
  readonly leases = new Map<string, TestLease>()
  acquireCalls = 0

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
  private nextFailure: unknown = null

  failNextConsumption(error: unknown): void {
    this.nextFailure = error
  }

  async consume(consumption: ApprovalConsumption, signal: AbortSignal): Promise<void> {
    if (signal.aborted) throw signal.reason
    if (this.nextFailure !== null) {
      const failure = this.nextFailure
      this.nextFailure = null
      throw failure
    }
    if (this.consumedCapabilityIds.has(consumption.capabilityId)) {
      throw new Error('APPROVAL_ALREADY_CONSUMED')
    }
    this.consumedCapabilityIds.add(consumption.capabilityId)
    this.records.push(consumption)
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
      message: 'Authorize this composed TM1 publication',
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

function signedReview(signingAuthorizationId: string): Tm1SignedReview {
  const rawTransactionBytes = new Uint8Array([1, 2, 3, 4])
  return {
    preparedId: PREPARED_ID,
    signedId: SIGNED_ID,
    txid: TXID,
    signedArtifactHash: ARTIFACT_HASH,
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
      txid: TXID,
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

type DirectHarnessOptions = Readonly<{
  ledger?: TestLedger
  now?: () => number
  signingTtlMs?: number
  broadcastTtlMs?: number
  createOperationIdSuffix?: () => string
  createCapabilityId?: (operationId: string) => string
  signingProvider?: Tm1RegtestAuthorizationDecisionProvider
  broadcastProvider?: Tm1RegtestBroadcastAuthorizationDecisionProvider
}>

function createDirectHarness(options: DirectHarnessOptions = {}) {
  const lock = new TestLock()
  const ledger = options.ledger ?? new TestLedger()
  let suffix = 0
  const signingProvider = options.signingProvider ?? {
    async requestDecision() {
      return Object.freeze({ status: 'approved' as const })
    }
  }
  const broadcastProvider = options.broadcastProvider ?? {
    async requestDecision() {
      return Object.freeze({ status: 'approved' as const })
    }
  }
  const ports = createTm1RegtestDualAuthorizationPorts({
    core: {
      enabled: true,
      lock,
      approvalLedger: ledger,
      ...(options.createCapabilityId === undefined
        ? {}
        : { createCapabilityId: options.createCapabilityId })
    },
    now: options.now ?? (() => NOW),
    createOperationIdSuffix:
      options.createOperationIdSuffix ?? (() => `operation-${++suffix}`),
    signing: {
      decisionProvider: signingProvider,
      ttlMs: options.signingTtlMs ?? 10_000,
      requester: {
        declaredOrigin: 'https://sign.tm1-regtest.invalid',
        displayName: 'TM1 signing consent'
      }
    },
    broadcast: {
      decisionProvider: broadcastProvider,
      ttlMs: options.broadcastTtlMs ?? 10_000,
      requester: {
        declaredOrigin: 'https://broadcast.tm1-regtest.invalid',
        displayName: 'TM1 broadcast consent'
      }
    }
  })
  return Object.freeze({ ports, lock, ledger, signingProvider, broadcastProvider })
}

async function expectAdapterCode(promise: Promise<unknown>, code: string): Promise<void> {
  await expect(promise).rejects.toMatchObject({ code })
}

afterEach(() => {
  vi.useRealTimers()
})

describe('TM1 dual authorization composition', () => {
  test('returns only two frozen least-authority ports', () => {
    const { ports } = createDirectHarness()

    expect(Object.keys(ports).sort()).toEqual([
      'broadcastAuthorization',
      'signingAuthorization'
    ])
    expect(Object.isFrozen(ports)).toBe(true)
    expect(ports).not.toHaveProperty('authorizationCore')
    expect(ports).not.toHaveProperty('ledger')
    expect(ports).not.toHaveProperty('lock')
  })

  test('uses one shared core sequentially and allows the same raw suffix across profiles', async () => {
    const suffixes = ['same-suffix', 'same-suffix']
    const signingDecision = vi.fn(async (
      _request: Tm1RegtestAuthorizationDecisionRequest,
      _signal: AbortSignal
    ) => {
      void _request
      void _signal
      return { status: 'approved' as const }
    })
    const broadcastDecision = vi.fn(async (
      _request: Tm1RegtestBroadcastAuthorizationDecisionRequest,
      _signal: AbortSignal
    ) => {
      void _request
      void _signal
      return { status: 'approved' as const }
    })
    const harness = createDirectHarness({
      createOperationIdSuffix: () => suffixes.shift() ?? 'unexpected',
      createCapabilityId: operationId => `${operationId}:capability`,
      signingProvider: { requestDecision: signingDecision },
      broadcastProvider: { requestDecision: broadcastDecision }
    })

    const signing = await harness.ports.signingAuthorization
      .requestSigningAuthorization(signingRequest())
    expect(signing.status).toBe('approved')
    if (signing.status !== 'approved') throw new Error('expected signing approval')

    const broadcast = await harness.ports.broadcastAuthorization
      .requestBroadcastAuthorization(signedReview(signing.authorizationId))
    expect(broadcast.status).toBe('approved')
    if (broadcast.status !== 'approved') throw new Error('expected broadcast approval')

    const signingOperationId = `${TM1_REGTEST_SIGNING_OPERATION_ID_PREFIX}same-suffix`
    const broadcastOperationId = `${TM1_REGTEST_BROADCAST_OPERATION_ID_PREFIX}same-suffix`
    expect(signingDecision.mock.calls[0]?.[0].operationId).toBe(signingOperationId)
    expect(broadcastDecision.mock.calls[0]?.[0].operationId).toBe(broadcastOperationId)
    expect(signingOperationId).not.toBe(broadcastOperationId)
    expect(signing.authorizationId).not.toBe(broadcast.authorizationId)
    expect(harness.ledger.records.map(record => record.operationId)).toEqual([
      signingOperationId,
      broadcastOperationId
    ])
    expect(harness.lock.leases.get(signingOperationId)?.releaseCalls).toBe(1)
    expect(harness.lock.leases.get(broadcastOperationId)?.releaseCalls).toBe(1)
  })

  test('preserves the native core capability allocator when no custom allocator is supplied', async () => {
    const harness = createDirectHarness()
    const signing = await harness.ports.signingAuthorization
      .requestSigningAuthorization(signingRequest())
    if (signing.status !== 'approved') throw new Error('expected signing approval')
    const broadcast = await harness.ports.broadcastAuthorization
      .requestBroadcastAuthorization(signedReview(signing.authorizationId))
    if (broadcast.status !== 'approved') throw new Error('expected broadcast approval')

    expect(signing.authorizationId).toMatch(/:[0-9a-f]{64}$/)
    expect(broadcast.authorizationId).toMatch(/:[0-9a-f]{64}$/)
    expect(signing.authorizationId).not.toBe(broadcast.authorizationId)
  })

  test('rejects the same provider object synchronously', () => {
    const sharedProvider = {
      async requestDecision(_request: unknown, _signal: AbortSignal) {
        void _request
        void _signal
        return Object.freeze({ status: 'approved' as const })
      }
    }
    const lock = new TestLock()
    const ledger = new TestLedger()

    expect(() => createTm1RegtestDualAuthorizationPorts({
      core: { enabled: true, lock, approvalLedger: ledger },
      now: () => NOW,
      createOperationIdSuffix: () => 'same-provider',
      signing: {
        decisionProvider: sharedProvider,
        ttlMs: 1_000,
        requester: { declaredOrigin: 'https://sign.invalid', displayName: 'Sign' }
      },
      broadcast: {
        decisionProvider: sharedProvider,
        ttlMs: 1_000,
        requester: { declaredOrigin: 'https://broadcast.invalid', displayName: 'Broadcast' }
      }
    })).toThrowError(Tm1RegtestDualAuthorizationCompositionError)
  })

  test('allows two instances of the same provider class', () => {
    class Provider {
      async requestDecision(_request: unknown, _signal: AbortSignal) {
        void _request
        void _signal
        return Object.freeze({ status: 'approved' as const })
      }
    }

    expect(() => createDirectHarness({
      signingProvider: new Provider(),
      broadcastProvider: new Provider()
    })).not.toThrow()
  })

  test('allows two distinct provider implementations', () => {
    const signingProvider = {
      async requestDecision() { return Object.freeze({ status: 'approved' as const }) }
    }
    const broadcastProvider = {
      async requestDecision() { return Object.freeze({ status: 'rejected' as const }) }
    }

    expect(() => createDirectHarness({ signingProvider, broadcastProvider })).not.toThrow()
  })

  test('burns a full signing operation ID when its authorization is rejected', async () => {
    const harness = createDirectHarness({
      createOperationIdSuffix: () => 'repeated-signing',
      signingProvider: {
        async requestDecision() { return { status: 'rejected' } }
      }
    })

    await expect(harness.ports.signingAuthorization.requestSigningAuthorization(signingRequest()))
      .resolves.toMatchObject({ status: 'rejected' })
    await expectAdapterCode(
      harness.ports.signingAuthorization.requestSigningAuthorization(signingRequest()),
      'INVALID_AUTHORIZATION_CONFIGURATION'
    )
    expect(harness.lock.acquireCalls).toBe(1)
  })

  test('burns a full broadcast operation ID when its authorization is rejected', async () => {
    const harness = createDirectHarness({
      createOperationIdSuffix: () => 'repeated-broadcast',
      broadcastProvider: {
        async requestDecision() { return { status: 'rejected' } }
      }
    })

    await expect(harness.ports.broadcastAuthorization.requestBroadcastAuthorization(
      signedReview('signing-capability')
    )).resolves.toMatchObject({ status: 'rejected' })
    await expectAdapterCode(
      harness.ports.broadcastAuthorization.requestBroadcastAuthorization(
        signedReview('signing-capability')
      ),
      'INVALID_AUTHORIZATION_CONFIGURATION'
    )
    expect(harness.lock.acquireCalls).toBe(1)
  })

  test('fails safely when the operation suffix allocator throws', async () => {
    const harness = createDirectHarness({
      createOperationIdSuffix: () => { throw new Error('suffix unavailable') }
    })

    await expectAdapterCode(
      harness.ports.signingAuthorization.requestSigningAuthorization(signingRequest()),
      'INVALID_AUTHORIZATION_CONFIGURATION'
    )
    expect(harness.lock.acquireCalls).toBe(0)
    expect(harness.ledger.records).toHaveLength(0)
  })

  test('burns a custom capability ID at issuance and rejects its reuse', async () => {
    const broadcastDecision = vi.fn(async () => ({ status: 'approved' as const }))
    const harness = createDirectHarness({
      createCapabilityId: () => 'capability-A',
      broadcastProvider: { requestDecision: broadcastDecision }
    })
    const signing = await harness.ports.signingAuthorization
      .requestSigningAuthorization(signingRequest())
    if (signing.status !== 'approved') throw new Error('expected signing approval')

    await expectAdapterCode(
      harness.ports.broadcastAuthorization.requestBroadcastAuthorization(
        signedReview(signing.authorizationId)
      ),
      'AUTHORIZATION_CORE_FAILED'
    )
    expect(broadcastDecision).toHaveBeenCalledTimes(1)
    expect(harness.ledger.records.map(record => record.capabilityId)).toEqual(['capability-A'])
  })

  test('does not resurrect a custom capability ID after downstream ledger failure', async () => {
    const ledger = new TestLedger()
    ledger.failNextConsumption(new Error('durable ledger unavailable'))
    const signingDecision = vi.fn(async () => ({ status: 'approved' as const }))
    const harness = createDirectHarness({
      ledger,
      createCapabilityId: () => 'capability-burned-at-issuance',
      signingProvider: { requestDecision: signingDecision }
    })

    await expectAdapterCode(
      harness.ports.signingAuthorization.requestSigningAuthorization(signingRequest()),
      'AUTHORIZATION_CORE_FAILED'
    )
    await expectAdapterCode(
      harness.ports.signingAuthorization.requestSigningAuthorization(signingRequest()),
      'AUTHORIZATION_CORE_FAILED'
    )
    expect(signingDecision).toHaveBeenCalledTimes(2)
    expect(ledger.records).toHaveLength(0)
  })

  test('rejects a broadcast capability replayed later through signing', async () => {
    const harness = createDirectHarness({
      createCapabilityId: () => 'cross-profile-capability'
    })
    const broadcast = await harness.ports.broadcastAuthorization.requestBroadcastAuthorization(
      signedReview('prior-signing-capability')
    )
    expect(broadcast.status).toBe('approved')

    await expectAdapterCode(
      harness.ports.signingAuthorization.requestSigningAuthorization(signingRequest()),
      'AUTHORIZATION_CORE_FAILED'
    )
    expect(harness.ledger.records.map(record => record.capabilityId)).toEqual([
      'cross-profile-capability'
    ])
  })

  test('allows distinct custom capability IDs', async () => {
    let capability = 0
    const harness = createDirectHarness({
      createCapabilityId: () => `capability-${++capability}`
    })
    const signing = await harness.ports.signingAuthorization
      .requestSigningAuthorization(signingRequest())
    if (signing.status !== 'approved') throw new Error('expected signing approval')
    const broadcast = await harness.ports.broadcastAuthorization
      .requestBroadcastAuthorization(signedReview(signing.authorizationId))

    expect(broadcast.status).toBe('approved')
    expect(harness.ledger.records.map(record => record.capabilityId)).toEqual([
      'capability-1',
      'capability-2'
    ])
  })

  test('fails fast across boundaries while signing is pending and recovers afterward', async () => {
    const providerStarted = deferred<void>()
    const signingDecision = vi.fn((_request, _signal) => {
      void _request
      void _signal
      providerStarted.resolve()
      return new Promise<Tm1RegtestAuthorizationProviderDecision>(() => undefined)
    })
    const broadcastDecision = vi.fn(async () => ({ status: 'approved' as const }))
    const harness = createDirectHarness({
      signingProvider: { requestDecision: signingDecision },
      broadcastProvider: { requestDecision: broadcastDecision }
    })
    const controller = new AbortController()
    const signing = harness.ports.signingAuthorization
      .requestSigningAuthorization(signingRequest(), controller.signal)
    await providerStarted.promise

    await expectAdapterCode(
      harness.ports.broadcastAuthorization.requestBroadcastAuthorization(
        signedReview('signing-capability')
      ),
      'AUTHORIZATION_CORE_FAILED'
    )
    expect(broadcastDecision).not.toHaveBeenCalled()

    controller.abort()
    await expect(signing).rejects.toMatchObject({ name: 'AbortError' })
    await expect(harness.ports.broadcastAuthorization.requestBroadcastAuthorization(
      signedReview('signing-capability')
    )).resolves.toMatchObject({ status: 'approved' })
  })

  test('a never-settling signing provider expires and permits immediate retry', async () => {
    vi.useFakeTimers()
    vi.setSystemTime(NOW)
    const providerStarted = deferred<void>()
    const signingDecision = vi.fn()
      .mockImplementationOnce(() => {
        providerStarted.resolve()
        return new Promise<Tm1RegtestAuthorizationProviderDecision>(() => undefined)
      })
      .mockResolvedValue({ status: 'approved' })
    const harness = createDirectHarness({
      now: Date.now,
      signingTtlMs: 100,
      signingProvider: { requestDecision: signingDecision }
    })
    const first = harness.ports.signingAuthorization.requestSigningAuthorization(signingRequest())
    const firstExpectation = expect(first).resolves.toMatchObject({ status: 'expired' })
    await providerStarted.promise

    await vi.advanceTimersByTimeAsync(100)

    await firstExpectation
    await expect(harness.ports.signingAuthorization.requestSigningAuthorization(signingRequest()))
      .resolves.toMatchObject({ status: 'approved' })
    expect(vi.getTimerCount()).toBe(0)
  })

  test('a never-settling broadcast provider expires and permits the next operation', async () => {
    vi.useFakeTimers()
    vi.setSystemTime(NOW)
    const providerStarted = deferred<void>()
    const broadcastDecision = vi.fn()
      .mockImplementationOnce(() => {
        providerStarted.resolve()
        return new Promise<Tm1RegtestBroadcastAuthorizationProviderDecision>(() => undefined)
      })
      .mockResolvedValue({ status: 'approved' })
    const harness = createDirectHarness({
      now: Date.now,
      broadcastTtlMs: 100,
      broadcastProvider: { requestDecision: broadcastDecision }
    })
    const first = harness.ports.broadcastAuthorization.requestBroadcastAuthorization(
      signedReview('signing-capability')
    )
    const firstExpectation = expect(first).resolves.toMatchObject({ status: 'expired' })
    await providerStarted.promise

    await vi.advanceTimersByTimeAsync(100)

    await firstExpectation
    await expect(harness.ports.broadcastAuthorization.requestBroadcastAuthorization(
      signedReview('signing-capability')
    )).resolves.toMatchObject({ status: 'approved' })
    expect(vi.getTimerCount()).toBe(0)
  })

  test.each([
    ['rejection', async () => ({ status: 'rejected' as const })],
    ['throw', async () => { throw new Error('provider failed') }],
    ['malformed result', async () => ({ status: 'unknown' }) as never]
  ])('reuses the core after signing provider %s', async (_name, firstDecision) => {
    const signingDecision = vi.fn()
      .mockImplementationOnce(firstDecision)
      .mockResolvedValue({ status: 'approved' })
    const harness = createDirectHarness({
      signingProvider: { requestDecision: signingDecision }
    })

    const first = harness.ports.signingAuthorization.requestSigningAuthorization(signingRequest())
    if (_name === 'rejection') {
      await expect(first).resolves.toMatchObject({ status: 'rejected' })
    } else {
      await expect(first).rejects.toBeDefined()
    }
    await expect(harness.ports.signingAuthorization.requestSigningAuthorization(signingRequest()))
      .resolves.toMatchObject({ status: 'approved' })
  })

  test('reuses the core after signing external abort', async () => {
    const providerStarted = deferred<void>()
    const signingDecision = vi.fn()
      .mockImplementationOnce(() => {
        providerStarted.resolve()
        return new Promise<Tm1RegtestAuthorizationProviderDecision>(() => undefined)
      })
      .mockResolvedValue({ status: 'approved' })
    const harness = createDirectHarness({
      signingProvider: { requestDecision: signingDecision }
    })
    const controller = new AbortController()
    const first = harness.ports.signingAuthorization
      .requestSigningAuthorization(signingRequest(), controller.signal)
    await providerStarted.promise

    controller.abort()

    await expect(first).rejects.toMatchObject({ name: 'AbortError' })
    await expect(harness.ports.signingAuthorization.requestSigningAuthorization(signingRequest()))
      .resolves.toMatchObject({ status: 'approved' })
  })

  test('reuses the core after broadcast external abort', async () => {
    const providerStarted = deferred<void>()
    const broadcastDecision = vi.fn()
      .mockImplementationOnce(() => {
        providerStarted.resolve()
        return new Promise<Tm1RegtestBroadcastAuthorizationProviderDecision>(() => undefined)
      })
      .mockResolvedValue({ status: 'approved' })
    const harness = createDirectHarness({
      broadcastProvider: { requestDecision: broadcastDecision }
    })
    const controller = new AbortController()
    const first = harness.ports.broadcastAuthorization.requestBroadcastAuthorization(
      signedReview('signing-capability'),
      controller.signal
    )
    await providerStarted.promise

    controller.abort()

    await expect(first).rejects.toMatchObject({ name: 'AbortError' })
    await expect(harness.ports.broadcastAuthorization.requestBroadcastAuthorization(
      signedReview('signing-capability')
    )).resolves.toMatchObject({ status: 'approved' })
  })

  test.each([
    ['rejection', async () => ({ status: 'rejected' as const })],
    ['throw', async () => { throw new Error('provider failed') }],
    ['malformed result', async () => ({ status: 'unknown' }) as never]
  ])('reuses the core after broadcast provider %s', async (_name, firstDecision) => {
    const broadcastDecision = vi.fn()
      .mockImplementationOnce(firstDecision)
      .mockResolvedValue({ status: 'approved' })
    const harness = createDirectHarness({
      broadcastProvider: { requestDecision: broadcastDecision }
    })

    const first = harness.ports.broadcastAuthorization.requestBroadcastAuthorization(
      signedReview('signing-capability')
    )
    if (_name === 'rejection') {
      await expect(first).resolves.toMatchObject({ status: 'rejected' })
    } else {
      await expect(first).rejects.toBeDefined()
    }
    await expect(harness.ports.broadcastAuthorization.requestBroadcastAuthorization(
      signedReview('signing-capability')
    )).resolves.toMatchObject({ status: 'approved' })
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
  message: 'TM1 dual authorization composition integration',
  activeLockingScriptHex: TM1_REGTEST_FIXTURE_LOCKING_SCRIPT_HEX,
  maxFeeSats: 10_000n
})

type IntegrationOptions = Readonly<{
  now?: () => number
  signingTtlMs?: number
  broadcastTtlMs?: number
  signingProvider?: Tm1RegtestAuthorizationDecisionProvider['requestDecision']
  broadcastProvider?: Tm1RegtestBroadcastAuthorizationDecisionProvider['requestDecision']
  failRevalidation?: boolean
  failSigner?: boolean
  failSecondAudit?: boolean
}>

function integrationHarness(options: IntegrationOptions = {}) {
  const lock = new TestLock()
  const ledger = new TestLedger()
  const events: string[] = []
  const now = options.now ?? (() => NOW)
  let operationSuffix = 0
  let capability = 0
  let publicationId = 0
  let utxoReads = 0
  const signingRequestDecision = vi.fn(options.signingProvider ?? (async () => {
    events.push('signing-approval')
    return Object.freeze({ status: 'approved' as const })
  }))
  const broadcastRequestDecision = vi.fn(options.broadcastProvider ?? (async () => {
    events.push('broadcast-approval')
    return Object.freeze({ status: 'approved' as const })
  }))
  const ports = createTm1RegtestDualAuthorizationPorts({
    core: {
      enabled: true,
      lock,
      approvalLedger: ledger,
      createCapabilityId: () => `integration-capability-${++capability}`
    },
    now,
    createOperationIdSuffix: () => `integration-${++operationSuffix}`,
    signing: {
      decisionProvider: { requestDecision: signingRequestDecision },
      ttlMs: options.signingTtlMs ?? 10_000,
      requester: {
        declaredOrigin: 'https://sign.tm1-regtest.invalid',
        displayName: 'TM1 signing consent'
      }
    },
    broadcast: {
      decisionProvider: { requestDecision: broadcastRequestDecision },
      ttlMs: options.broadcastTtlMs ?? 10_000,
      requester: {
        declaredOrigin: 'https://broadcast.tm1-regtest.invalid',
        displayName: 'TM1 broadcast consent'
      }
    }
  })
  const calls = { signer: 0, audit: 0, broadcast: 0 }
  const dependencies: Tm1RegtestPublicationDependencies = {
    networkAttestation: {
      async attest(signal) {
        if (signal?.aborted) throw signal.reason
        events.push('attest')
        return Object.freeze({
          environment: 'deterministic-regtest-fixture' as const,
          chainIdentity: 'tm1-regtest-chain'
        })
      }
    },
    utxoProvider: {
      async readUtxos(signal) {
        if (signal?.aborted) throw signal.reason
        utxoReads += 1
        events.push('utxos')
        if (options.failRevalidation && utxoReads === 2) {
          throw new Error('candidate revalidation unavailable')
        }
        return fixtureUtxos()
      }
    },
    signingAuthorization: ports.signingAuthorization,
    signer: {
      async sign(review, signal) {
        calls.signer += 1
        events.push('sign')
        if (options.failSigner) throw new Error('signer failed')
        return signTm1Draft02RegtestCandidate({ candidate: review.candidate, signal })
      }
    },
    signedArtifactAudit: {
      async auditSignedArtifact({ signedArtifact, signal }) {
        if (signal?.aborted) throw signal.reason
        calls.audit += 1
        events.push(`audit-${calls.audit}`)
        if (options.failSecondAudit && calls.audit === 2) {
          throw new Error('post-approval re-audit failed')
        }
        return Object.freeze({
          ...signedArtifact,
          rawTransactionBytes: new Uint8Array(signedArtifact.rawTransactionBytes)
        })
      }
    },
    broadcastAuthorization: ports.broadcastAuthorization,
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
      async confirm({ submissionId, txid, signal }) {
        if (signal?.aborted) throw signal.reason
        return Object.freeze({ submissionId, txid, confirmations: 1 })
      }
    },
    clock: {
      createId(prefix) {
        publicationId += 1
        return `${prefix}-${publicationId}`
      }
    }
  }
  const orchestrator = new Tm1RegtestPublicationOrchestratorImpl(dependencies)
  return Object.freeze({
    orchestrator,
    ports,
    lock,
    ledger,
    events,
    calls,
    signingRequestDecision,
    broadcastRequestDecision
  })
}

async function prepareAndSign(harness: ReturnType<typeof integrationHarness>) {
  const review = await harness.orchestrator.prepare(PUBLICATION_REQUEST)
  return harness.orchestrator.authorizeAndSign(review.preparedId)
}

async function expectPublicationCode(promise: Promise<unknown>, code: string): Promise<void> {
  await expect(promise).rejects.toSatisfy(error =>
    error instanceof Tm1PublicationError && error.code === code
  )
}

describe('TM1 dual authorization composition with unchanged orchestrator', () => {
  test('runs the exact nominal authorization, sign, re-audit, and broadcast order', async () => {
    const harness = integrationHarness()
    const signed = await prepareAndSign(harness)
    const receipt = await harness.orchestrator.approveAndBroadcast(signed.signedId)

    expect(receipt.txid).toBe(signed.txid)
    expect(harness.calls).toEqual({ signer: 1, audit: 2, broadcast: 1 })
    expect(harness.events).toEqual([
      'attest',
      'utxos',
      'signing-approval',
      'attest',
      'utxos',
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

  test('signing rejection blocks signing, broadcast consent, and transport', async () => {
    const harness = integrationHarness({
      signingProvider: async () => ({ status: 'rejected', reason: 'declined' })
    })
    const review = await harness.orchestrator.prepare(PUBLICATION_REQUEST)

    await expectPublicationCode(
      harness.orchestrator.authorizeAndSign(review.preparedId),
      'SIGNING_REJECTED'
    )
    expect(harness.calls).toEqual({ signer: 0, audit: 0, broadcast: 0 })
    expect(harness.broadcastRequestDecision).not.toHaveBeenCalled()
  })

  test('signing expiry blocks signing, broadcast consent, and transport', async () => {
    vi.useFakeTimers()
    vi.setSystemTime(NOW)
    const providerStarted = deferred<void>()
    const harness = integrationHarness({
      now: Date.now,
      signingTtlMs: 100,
      signingProvider: () => {
        providerStarted.resolve()
        return new Promise<Tm1RegtestAuthorizationProviderDecision>(() => undefined)
      }
    })
    const review = await harness.orchestrator.prepare(PUBLICATION_REQUEST)
    const result = harness.orchestrator.authorizeAndSign(review.preparedId)
    const resultExpectation = expectPublicationCode(result, 'SIGNING_AUTHORIZATION_EXPIRED')
    await providerStarted.promise

    await vi.advanceTimersByTimeAsync(100)

    await resultExpectation
    expect(harness.calls).toEqual({ signer: 0, audit: 0, broadcast: 0 })
    expect(harness.broadcastRequestDecision).not.toHaveBeenCalled()
  })

  test('signing abort blocks all later authority and permits reset with a new signal', async () => {
    const providerStarted = deferred<void>()
    const firstProvider = vi.fn(() => {
      providerStarted.resolve()
      return new Promise<Tm1RegtestAuthorizationProviderDecision>(() => undefined)
    })
    const harness = integrationHarness({ signingProvider: firstProvider })
    const review = await harness.orchestrator.prepare(PUBLICATION_REQUEST)
    const controller = new AbortController()
    const result = harness.orchestrator.authorizeAndSign(review.preparedId, controller.signal)
    await providerStarted.promise

    controller.abort()

    await expectPublicationCode(result, 'ABORTED')
    expect(harness.calls).toEqual({ signer: 0, audit: 0, broadcast: 0 })
    expect(harness.broadcastRequestDecision).not.toHaveBeenCalled()
    expect(() => harness.orchestrator.reset()).not.toThrow()
  })

  test('an aborted first-cycle signal does not poison the next publication cycle', async () => {
    const providerStarted = deferred<void>()
    const signingProvider = vi.fn()
      .mockImplementationOnce(() => {
        providerStarted.resolve()
        return new Promise<Tm1RegtestAuthorizationProviderDecision>(() => undefined)
      })
      .mockResolvedValue({ status: 'approved' })
    const harness = integrationHarness({ signingProvider })
    const firstReview = await harness.orchestrator.prepare(PUBLICATION_REQUEST)
    const firstController = new AbortController()
    const first = harness.orchestrator.authorizeAndSign(
      firstReview.preparedId,
      firstController.signal
    )
    await providerStarted.promise
    firstController.abort()
    await expectPublicationCode(first, 'ABORTED')
    harness.orchestrator.reset()

    const secondReview = await harness.orchestrator.prepare({
      ...PUBLICATION_REQUEST,
      message: 'TM1 publication after authorization abort'
    })
    const secondSigned = await harness.orchestrator.authorizeAndSign(
      secondReview.preparedId,
      new AbortController().signal
    )
    await expect(harness.orchestrator.approveAndBroadcast(secondSigned.signedId))
      .resolves.toMatchObject({ txid: secondSigned.txid })

    expect(harness.signingRequestDecision).toHaveBeenCalledTimes(2)
    expect(harness.broadcastRequestDecision).toHaveBeenCalledTimes(1)
    expect(harness.ledger.records).toHaveLength(2)
  })

  test('candidate revalidation failure burns signing consent and blocks later authority', async () => {
    const harness = integrationHarness({ failRevalidation: true })
    const review = await harness.orchestrator.prepare(PUBLICATION_REQUEST)

    await expectPublicationCode(
      harness.orchestrator.authorizeAndSign(review.preparedId),
      'CANDIDATE_REVALIDATION_FAILED'
    )
    expect(harness.ledger.records).toHaveLength(1)
    expect(harness.calls).toEqual({ signer: 0, audit: 0, broadcast: 0 })
    expect(harness.broadcastRequestDecision).not.toHaveBeenCalled()
  })

  test('signer failure blocks broadcast consent and transport', async () => {
    const harness = integrationHarness({ failSigner: true })
    const review = await harness.orchestrator.prepare(PUBLICATION_REQUEST)

    await expectPublicationCode(
      harness.orchestrator.authorizeAndSign(review.preparedId),
      'SIGNING_FAILED'
    )
    expect(harness.ledger.records).toHaveLength(1)
    expect(harness.calls).toEqual({ signer: 1, audit: 0, broadcast: 0 })
    expect(harness.broadcastRequestDecision).not.toHaveBeenCalled()
  })

  test('broadcast rejection leaves transport unused', async () => {
    const harness = integrationHarness({
      broadcastProvider: async () => ({ status: 'rejected', reason: 'declined' })
    })
    const signed = await prepareAndSign(harness)

    await expectPublicationCode(
      harness.orchestrator.approveAndBroadcast(signed.signedId),
      'BROADCAST_REJECTED'
    )
    expect(harness.calls).toEqual({ signer: 1, audit: 1, broadcast: 0 })
  })

  test('broadcast expiry leaves transport unused', async () => {
    vi.useFakeTimers()
    vi.setSystemTime(NOW)
    const providerStarted = deferred<void>()
    const harness = integrationHarness({
      now: Date.now,
      broadcastTtlMs: 100,
      broadcastProvider: () => {
        providerStarted.resolve()
        return new Promise<Tm1RegtestBroadcastAuthorizationProviderDecision>(() => undefined)
      }
    })
    const signed = await prepareAndSign(harness)
    const result = harness.orchestrator.approveAndBroadcast(signed.signedId)
    const resultExpectation = expectPublicationCode(result, 'BROADCAST_AUTHORIZATION_EXPIRED')
    await providerStarted.promise

    await vi.advanceTimersByTimeAsync(100)

    await resultExpectation
    expect(harness.calls).toEqual({ signer: 1, audit: 1, broadcast: 0 })
  })

  test('broadcast abort leaves transport unused', async () => {
    const providerStarted = deferred<void>()
    const harness = integrationHarness({
      broadcastProvider: () => {
        providerStarted.resolve()
        return new Promise<Tm1RegtestBroadcastAuthorizationProviderDecision>(() => undefined)
      }
    })
    const signed = await prepareAndSign(harness)
    const controller = new AbortController()
    const result = harness.orchestrator.approveAndBroadcast(signed.signedId, controller.signal)
    await providerStarted.promise

    controller.abort()

    await expectPublicationCode(result, 'ABORTED')
    expect(harness.calls).toEqual({ signer: 1, audit: 1, broadcast: 0 })
  })

  test('post-approval re-audit failure leaves broadcast capability burned', async () => {
    const harness = integrationHarness({ failSecondAudit: true })
    const signed = await prepareAndSign(harness)

    await expectPublicationCode(
      harness.orchestrator.approveAndBroadcast(signed.signedId),
      'SIGNED_ARTIFACT_INVALID'
    )
    expect(harness.calls).toEqual({ signer: 1, audit: 2, broadcast: 0 })
    expect(harness.ledger.records).toHaveLength(2)
    expect(harness.ledger.consumedCapabilityIds).toContain('integration-capability-2')
  })

  test('survives reset and produces fresh publication, operation, and capability IDs', async () => {
    const harness = integrationHarness()
    const firstPrepared = await harness.orchestrator.prepare(PUBLICATION_REQUEST)
    const firstSigned = await harness.orchestrator.authorizeAndSign(firstPrepared.preparedId)
    const firstReceipt = await harness.orchestrator.approveAndBroadcast(firstSigned.signedId)
    await harness.orchestrator.confirm(firstReceipt.submissionId)
    harness.orchestrator.reset()

    const secondPrepared = await harness.orchestrator.prepare({
      ...PUBLICATION_REQUEST,
      message: 'TM1 second publication cycle'
    })
    await expectPublicationCode(
      harness.orchestrator.authorizeAndSign(firstPrepared.preparedId),
      'STALE_PREPARED_REVIEW'
    )
    const secondSigned = await harness.orchestrator.authorizeAndSign(secondPrepared.preparedId)
    await expectPublicationCode(
      harness.orchestrator.approveAndBroadcast(firstSigned.signedId),
      'STALE_SIGNED_REVIEW'
    )
    const secondReceipt = await harness.orchestrator.approveAndBroadcast(secondSigned.signedId)

    expect(secondPrepared.preparedId).not.toBe(firstPrepared.preparedId)
    expect(secondSigned.signedId).not.toBe(firstSigned.signedId)
    expect(secondReceipt.submissionId).not.toBe(firstReceipt.submissionId)
    expect(harness.ledger.records).toHaveLength(4)
    expect(new Set(harness.ledger.records.map(record => record.operationId)).size).toBe(4)
    expect(new Set(harness.ledger.records.map(record => record.capabilityId)).size).toBe(4)
  })

  test('keeps signing and broadcast universal content hashes profile-separated', async () => {
    const harness = integrationHarness()
    const signed = await prepareAndSign(harness)
    await harness.orchestrator.approveAndBroadcast(signed.signedId)
    const signingRequestValue = harness.signingRequestDecision.mock.calls[0]?.[0]
    const broadcastRequestValue = harness.broadcastRequestDecision.mock.calls[0]?.[0]

    expect(signingRequestValue?.contentHash).not.toBe(broadcastRequestValue?.contentHash)
    expect(signingRequestValue).not.toHaveProperty('signedId')
    expect(signingRequestValue).not.toHaveProperty('txid')
    expect(broadcastRequestValue).not.toHaveProperty('signingAuthorizationId')
  })
})
