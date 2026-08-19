import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest'
import type {
  UniversalAuthorizationAdapter,
  UniversalReviewAuthorizationAdapter,
  UniversalReviewSnapshot,
  UniversalSignedResult
} from './adapters'
import type {
  ApprovalConsumption,
  ApprovalConsumptionLedger
} from './approval'
import { InMemoryApprovalCapability } from './approval'
import {
  UniversalAuthorizationCore,
  UNIVERSAL_AUTHORIZATION_MAX_TIMER_DELAY_MS,
  type UniversalAuthorizationCoreDependencies,
  type UniversalOperationHandle
} from './core'
import {
  parseUniversalAuthorizationEnvelope,
  UniversalAuthorizationError,
  type UniversalAuthorizationEnvelopeV1
} from './contract'
import type { UniversalOperationLease, UniversalOperationLock } from './lock'

const TEST_NOW = 1_800_000_000_000
const PROFILE_ID = 'synthetic.authorization.v1'

type Controlled<T> = Readonly<{
  promise: Promise<T>
  resolve: (value: T) => void
  reject: (reason: unknown) => void
}>

const controlled = <T>(): Controlled<T> => {
  let resolvePromise: (value: T) => void = () => undefined
  let rejectPromise: (reason: unknown) => void = () => undefined
  const promise = new Promise<T>((resolve, reject) => {
    resolvePromise = resolve
    rejectPromise = reject
  })
  return Object.freeze({ promise, resolve: resolvePromise, reject: rejectPromise })
}

const rawEnvelope = (
  operationId = 'operation-a',
  expiresInMs = 10_000
): Record<string, unknown> => ({
  schema: 'tonalli.authorization-envelope',
  version: 1,
  operationId,
  profileId: PROFILE_ID,
  issuedAt: Date.now() - 1,
  expiresAt: Date.now() + expiresInMs,
  requester: {
    declaredOrigin: 'https://fixture.invalid',
    displayName: 'Synthetic fixture'
  }
})

const envelope = (
  operationId = 'operation-a',
  expiresInMs = 10_000
): UniversalAuthorizationEnvelopeV1 => parseUniversalAuthorizationEnvelope(
  rawEnvelope(operationId, expiresInMs)
)

const review = (bytes: readonly number[] = [1, 2, 3]): UniversalReviewSnapshot => Object.freeze({
  fields: Object.freeze([
    Object.freeze({ label: 'Action', value: 'Synthetic authorization' }),
    Object.freeze({ label: 'Bytes', value: bytes.join(',') })
  ]),
  effectiveContent: new Uint8Array(bytes)
})

class InstrumentedLease implements UniversalOperationLease {
  readonly ownerOperationId: string
  private owned = true
  releaseCalls = 0
  readonly events: string[]

  constructor(ownerOperationId: string, events: string[]) {
    this.ownerOperationId = ownerOperationId
    this.events = events
  }

  isOwned(): boolean {
    return this.owned
  }

  release(): void {
    this.releaseCalls += 1
    if (!this.owned) throw new Error('lease released twice')
    this.owned = false
    this.events.push(`release:${this.ownerOperationId}`)
  }
}

class InstrumentedLock implements UniversalOperationLock {
  readonly events: string[]
  readonly leases = new Map<string, InstrumentedLease>()
  acquireCalls = 0

  constructor(events: string[]) {
    this.events = events
  }

  async acquire(operationId: string, signal: AbortSignal): Promise<UniversalOperationLease> {
    this.acquireCalls += 1
    this.events.push(`acquire:${operationId}`)
    if (signal.aborted) throw new UniversalAuthorizationError('OPERATION_ABORTED')
    const lease = new InstrumentedLease(operationId, this.events)
    this.leases.set(operationId, lease)
    return lease
  }
}

class InstrumentedLedger implements ApprovalConsumptionLedger {
  readonly events: string[]
  readonly records = new Map<string, ApprovalConsumption>()
  consumeCalls = 0

  constructor(events: string[]) {
    this.events = events
  }

  async consume(consumption: ApprovalConsumption, signal: AbortSignal): Promise<void> {
    this.consumeCalls += 1
    this.events.push(`consume:${consumption.operationId}`)
    if (signal.aborted) throw new UniversalAuthorizationError('OPERATION_ABORTED')
    if (this.records.has(consumption.operationId)) {
      throw new UniversalAuthorizationError('APPROVAL_ALREADY_CONSUMED')
    }
    this.records.set(consumption.operationId, consumption)
  }
}

type AdapterFunctions = Readonly<{
  prepare?: UniversalAuthorizationAdapter['prepareReview']
  revalidate?: UniversalAuthorizationAdapter['revalidateReview']
  sign?: UniversalAuthorizationAdapter['signApprovedContent']
}>

const syntheticAdapter = (
  events: string[],
  functions: AdapterFunctions = {}
): UniversalAuthorizationAdapter => ({
  profileId: PROFILE_ID,
  prepareReview: vi.fn(functions.prepare ?? (async (_envelope, signal) => {
    events.push('prepare')
    if (signal.aborted) throw new UniversalAuthorizationError('OPERATION_ABORTED')
    return review()
  })),
  revalidateReview: vi.fn(functions.revalidate ?? (async (_envelope, approved, signal) => {
    events.push('revalidate')
    if (signal.aborted) throw new UniversalAuthorizationError('OPERATION_ABORTED')
    return approved
  })),
  signApprovedContent: vi.fn(functions.sign ?? (async input => {
    events.push('sign')
    if (input.signal.aborted) throw new UniversalAuthorizationError('OPERATION_ABORTED')
    return Object.freeze({
      format: 'synthetic/bytes',
      bytes: new Uint8Array([9, ...input.effectiveContent]),
      contentHash: input.contentHash
    })
  }))
})

const reviewAuthorizationAdapter = (
  events: string[],
  functions: Pick<AdapterFunctions, 'prepare' | 'revalidate'> = {}
): UniversalReviewAuthorizationAdapter => ({
  profileId: PROFILE_ID,
  prepareReview: vi.fn(functions.prepare ?? (async (_envelope, signal) => {
    events.push('prepare')
    if (signal.aborted) throw new UniversalAuthorizationError('OPERATION_ABORTED')
    return review()
  })),
  revalidateReview: vi.fn(functions.revalidate ?? (async (_envelope, approved, signal) => {
    events.push('revalidate')
    if (signal.aborted) throw new UniversalAuthorizationError('OPERATION_ABORTED')
    return approved
  }))
})

type Harness = Readonly<{
  core: UniversalAuthorizationCore
  lock: InstrumentedLock
  ledger: InstrumentedLedger
  adapter: UniversalAuthorizationAdapter
  events: string[]
  capabilityIds: string[]
}>

const harness = (functions: AdapterFunctions = {}): Harness => {
  const events: string[] = []
  const capabilityIds: string[] = []
  const lock = new InstrumentedLock(events)
  const ledger = new InstrumentedLedger(events)
  const adapter = syntheticAdapter(events, functions)
  const core = new UniversalAuthorizationCore({
    enabled: true,
    lock,
    approvalLedger: ledger,
    now: Date.now,
    createCapabilityId: operationId => {
      const capabilityId = `${operationId}:capability-${capabilityIds.length + 1}`
      capabilityIds.push(capabilityId)
      return capabilityId
    }
  })
  return Object.freeze({ core, lock, ledger, adapter, events, capabilityIds })
}

const expectRejected = async (promise: Promise<unknown>) => {
  await expect(promise).rejects.toBeInstanceOf(Error)
}

beforeEach(() => {
  vi.useFakeTimers()
  vi.setSystemTime(TEST_NOW)
})

afterEach(() => {
  vi.restoreAllMocks()
  vi.useRealTimers()
})

describe('universal authorization ownership and lifecycle', () => {
  test('the synthetic adapter exposes only prepare, revalidate, and sign capabilities', () => {
    const testHarness = harness()
    expect(Object.keys(testHarness.adapter).sort()).toEqual([
      'prepareReview',
      'profileId',
      'revalidateReview',
      'signApprovedContent'
    ])
  })

  test('start runtime-validates structurally cast envelopes before acquiring a lease', () => {
    const testHarness = harness()
    const cast = (value: unknown) => value as UniversalAuthorizationEnvelopeV1
    const invalidEnvelopes = [
      { ...rawEnvelope(), schema: 'forged.authorization-envelope' },
      { ...rawEnvelope(), version: 2 },
      { ...rawEnvelope(), issuedAt: 'not-a-timestamp' },
      { ...rawEnvelope(), extra: true },
      {
        ...rawEnvelope(),
        requester: {
          origin: 'https://fixture.invalid',
          displayName: 'Legacy cast'
        }
      },
      {
        ...rawEnvelope(),
        requester: {
          declaredOrigin: 'https://fixture.invalid/path',
          displayName: 'Untrusted path'
        }
      }
    ]

    for (const candidate of invalidEnvelopes) {
      expect(() => testHarness.core.start(cast(candidate), testHarness.adapter))
        .toThrowError(UniversalAuthorizationError)
    }
    expect(testHarness.lock.acquireCalls).toBe(0)
  })

  test('start normalizes a cast envelope before exposing it to an adapter', async () => {
    const testHarness = harness()
    const candidate = {
      ...rawEnvelope('operation-normalized'),
      requester: {
        declaredOrigin: 'https://fixture.invalid',
        displayName: 'Cafe\u0301 fixture'
      }
    } as unknown as UniversalAuthorizationEnvelopeV1

    const handle = testHarness.core.start(candidate, testHarness.adapter)
    await handle.ready
    expect(vi.mocked(testHarness.adapter.prepareReview).mock.calls[0][0].requester)
      .toEqual({
        declaredOrigin: 'https://fixture.invalid',
        displayName: 'Café fixture'
      })
    handle.abort()
  })

  test('double approval interaction creates one capability and at most one synthetic signature', async () => {
    const testHarness = harness()
    const handle = testHarness.core.start(envelope(), testHarness.adapter)
    await handle.ready
    const firstApproval = handle.approve()
    expect(() => handle.approve()).toThrowError('UNEXPECTED_OPERATION_STATE')
    await firstApproval
    expect(testHarness.capabilityIds).toHaveLength(1)
    expect(testHarness.adapter.signApprovedContent).toHaveBeenCalledTimes(1)
    expect(handle.state()).toBe('completed')
  })

  test('a synchronous guard prevents two operations and two capabilities from coexisting', async () => {
    const testHarness = harness()
    const first = testHarness.core.start(envelope('operation-a'), testHarness.adapter)
    expect(() => testHarness.core.start(envelope('operation-b'), testHarness.adapter))
      .toThrowError('OPERATION_ALREADY_ACTIVE')
    expect(testHarness.lock.acquireCalls).toBe(1)
    await first.ready
    const approval = first.approve()
    expect(() => first.approve()).toThrowError('UNEXPECTED_OPERATION_STATE')
    await approval
    expect(testHarness.capabilityIds).toHaveLength(1)
  })

  test('concurrent approve and reject ends rejected without signing', async () => {
    const revalidation = controlled<UniversalReviewSnapshot>()
    const testHarness = harness({ revalidate: () => revalidation.promise })
    const handle = testHarness.core.start(envelope(), testHarness.adapter)
    const approvedReview = (await handle.ready).review
    const approval = handle.approve()
    handle.reject()
    revalidation.resolve(approvedReview)
    await expectRejected(approval)
    expect(handle.state()).toBe('rejected')
    expect(testHarness.adapter.signApprovedContent).not.toHaveBeenCalled()
  })

  test('navigation during preparation aborts and a late preparation cannot sign', async () => {
    const preparation = controlled<UniversalReviewSnapshot>()
    const testHarness = harness({ prepare: () => preparation.promise })
    const handle = testHarness.core.start(envelope(), testHarness.adapter)
    await Promise.resolve()
    handle.abort()
    preparation.resolve(review())
    await expectRejected(handle.ready)
    await Promise.resolve()
    expect(handle.state()).toBe('aborted')
    expect(testHarness.adapter.revalidateReview).not.toHaveBeenCalled()
    expect(testHarness.adapter.signApprovedContent).not.toHaveBeenCalled()
  })

  test('navigation during revalidation prevents signing', async () => {
    const revalidation = controlled<UniversalReviewSnapshot>()
    const testHarness = harness({ revalidate: () => revalidation.promise })
    const handle = testHarness.core.start(envelope(), testHarness.adapter)
    const approvedReview = (await handle.ready).review
    const approval = handle.approve()
    handle.abort()
    revalidation.resolve(approvedReview)
    await expectRejected(approval)
    expect(handle.state()).toBe('aborted')
    expect(testHarness.adapter.signApprovedContent).not.toHaveBeenCalled()
  })

  test('unmount cleanup during revalidation prevents signing', async () => {
    const revalidation = controlled<UniversalReviewSnapshot>()
    const testHarness = harness({ revalidate: () => revalidation.promise })
    const handle = testHarness.core.start(envelope(), testHarness.adapter)
    const approvedReview = (await handle.ready).review
    const approval = handle.approve()
    handle.cleanup()
    revalidation.resolve(approvedReview)
    await expectRejected(approval)
    expect(handle.state()).toBe('aborted')
    expect(testHarness.adapter.signApprovedContent).not.toHaveBeenCalled()
  })

  test('expiration during revalidation prevents signing', async () => {
    const revalidation = controlled<UniversalReviewSnapshot>()
    const testHarness = harness({ revalidate: () => revalidation.promise })
    const handle = testHarness.core.start(envelope('operation-expiring', 1_000), testHarness.adapter)
    const approvedReview = (await handle.ready).review
    const approval = handle.approve()
    const approvalRejected = expectRejected(approval)
    await vi.advanceTimersByTimeAsync(1_001)
    revalidation.resolve(approvedReview)
    await approvalRejected
    expect(handle.state()).toBe('expired')
    expect(testHarness.adapter.signApprovedContent).not.toHaveBeenCalled()
  })

  test('changing operationId invalidates the prior continuation', async () => {
    const oldPreparation = controlled<UniversalReviewSnapshot>()
    const events: string[] = []
    const lock = new InstrumentedLock(events)
    const ledger = new InstrumentedLedger(events)
    const firstAdapter = syntheticAdapter(events, { prepare: () => oldPreparation.promise })
    const secondAdapter = syntheticAdapter(events)
    const core = new UniversalAuthorizationCore({ enabled: true, lock, approvalLedger: ledger })
    const first = core.start(envelope('operation-old'), firstAdapter)
    await Promise.resolve()
    const second = core.replace(envelope('operation-new'), secondAdapter)
    oldPreparation.resolve(review())
    await expectRejected(first.ready)
    await second.ready
    expect(first.state()).toBe('aborted')
    expect(core.activeOperationId).toBe('operation-new')
    expect(firstAdapter.revalidateReview).not.toHaveBeenCalled()
    second.abort()
  })

  test('a promise resolved after abort cannot continue', async () => {
    const revalidation = controlled<UniversalReviewSnapshot>()
    const testHarness = harness({ revalidate: () => revalidation.promise })
    const handle = testHarness.core.start(envelope(), testHarness.adapter)
    const approvedReview = (await handle.ready).review
    const approval = handle.approve()
    handle.abort()
    await Promise.resolve()
    revalidation.resolve(approvedReview)
    await expectRejected(approval)
    await Promise.resolve()
    expect(testHarness.events).not.toContain('sign')
  })

  test('the lease remains owned from preparation through signing and releases after completion', async () => {
    const events: string[] = []
    const lock = new InstrumentedLock(events)
    const ledger = new InstrumentedLedger(events)
    const adapter = syntheticAdapter(events, {
      prepare: async envelopeValue => {
        expect(lock.leases.get(envelopeValue.operationId)?.isOwned()).toBe(true)
        events.push('prepare')
        return review()
      },
      revalidate: async (envelopeValue, approved) => {
        expect(lock.leases.get(envelopeValue.operationId)?.isOwned()).toBe(true)
        events.push('revalidate')
        return approved
      },
      sign: async input => {
        expect(lock.leases.get(input.envelope.operationId)?.isOwned()).toBe(true)
        events.push('sign')
        return { format: 'synthetic/bytes', bytes: new Uint8Array([9]), contentHash: input.contentHash }
      }
    })
    const core = new UniversalAuthorizationCore({ enabled: true, lock, approvalLedger: ledger })
    const handle = core.start(envelope(), adapter)
    await handle.ready
    await handle.approve()
    expect(events).toEqual([
      'acquire:operation-a',
      'prepare',
      'revalidate',
      'consume:operation-a',
      'sign',
      'release:operation-a'
    ])
    expect(lock.leases.get('operation-a')?.isOwned()).toBe(false)
  })

  test('only the lease owner releases each operation lease', async () => {
    const testHarness = harness()
    const first = testHarness.core.start(envelope('owner-a'), testHarness.adapter)
    await first.ready
    first.abort()
    const second = testHarness.core.start(envelope('owner-b'), testHarness.adapter)
    await second.ready
    second.abort()
    expect(testHarness.events.filter(event => event.startsWith('release:'))).toEqual([
      'release:owner-a',
      'release:owner-b'
    ])
    expect(testHarness.lock.leases.get('owner-a')?.releaseCalls).toBe(1)
    expect(testHarness.lock.leases.get('owner-b')?.releaseCalls).toBe(1)
  })

  test('cleanup is idempotent', async () => {
    const testHarness = harness()
    const handle = testHarness.core.start(envelope(), testHarness.adapter)
    await handle.ready
    handle.cleanup()
    handle.cleanup()
    handle.abort()
    expect(testHarness.lock.leases.get('operation-a')?.releaseCalls).toBe(1)
    expect(handle.history().filter(state => state === 'aborted')).toHaveLength(1)
  })

  test('an approval capability can be consumed only once', async () => {
    const testHarness = harness()
    const signal = new AbortController().signal
    const capability = new InMemoryApprovalCapability(
      'operation-capability',
      'capability-id',
      `sha256:${'11'.repeat(32)}`,
      Date.now() + 1_000
    )
    await capability.consume(testHarness.ledger, signal, Date.now())
    await expect(capability.consume(testHarness.ledger, signal, Date.now()))
      .rejects.toThrowError('APPROVAL_NOT_FRESH')
    expect(testHarness.ledger.consumeCalls).toBe(1)
  })

  test('mutated effective content blocks signing', async () => {
    const testHarness = harness({ revalidate: async () => review([1, 2, 4]) })
    const handle = testHarness.core.start(envelope(), testHarness.adapter)
    await handle.ready
    await expect(handle.approve()).rejects.toThrowError('CONTENT_BINDING_MISMATCH')
    expect(handle.state()).toBe('failed')
    expect(testHarness.adapter.signApprovedContent).not.toHaveBeenCalled()
  })

  test('the UI review receives a defensive copy of effective content', async () => {
    const testHarness = harness()
    const handle = testHarness.core.start(envelope(), testHarness.adapter)
    const prepared = await handle.ready
    prepared.review.effectiveContent[0] = 255
    await handle.approve()
    const signingInput = vi.mocked(testHarness.adapter.signApprovedContent).mock.calls[0][0]
    expect(Array.from(signingInput.effectiveContent)).toEqual([1, 2, 3])
  })

  test('the synthetic signing adapter is invoked at most once', async () => {
    const testHarness = harness()
    const handle = testHarness.core.start(envelope(), testHarness.adapter)
    await handle.ready
    const result = await handle.approve()
    expect(result.format).toBe('synthetic/bytes')
    expect(testHarness.adapter.signApprovedContent).toHaveBeenCalledTimes(1)
    expect(() => handle.approve()).toThrowError('OPERATION_OWNERSHIP_LOST')
    expect(testHarness.adapter.signApprovedContent).toHaveBeenCalledTimes(1)
  })

  test('abort after signing starts is cooperative and a later signer resolution completes once', async () => {
    const signing = controlled<UniversalSignedResult>()
    let signingInput: Parameters<UniversalAuthorizationAdapter['signApprovedContent']>[0] | undefined
    const testHarness = harness({
      sign: input => {
        signingInput = input
        return signing.promise
      }
    })
    const handle = testHarness.core.start(envelope(), testHarness.adapter)
    await handle.ready
    const approval = handle.approve()
    await vi.waitFor(() => expect(testHarness.adapter.signApprovedContent).toHaveBeenCalledTimes(1))
    if (!signingInput) throw new Error('signer input was not captured')

    expect(handle.state()).toBe('signing')
    handle.abort()
    expect(handle.state()).toBe('signing')
    handle.reject()
    expect(handle.state()).toBe('signing')
    expect(signingInput.signal.aborted).toBe(true)
    expect(testHarness.lock.leases.get('operation-a')?.isOwned()).toBe(true)

    signing.resolve(Object.freeze({
      format: 'synthetic/bytes',
      bytes: new Uint8Array([9, 1, 2, 3]),
      contentHash: signingInput.contentHash
    }))
    const result = await approval

    expect(result.bytes).toEqual(new Uint8Array([9, 1, 2, 3]))
    expect(handle.state()).toBe('completed')
    expect(handle.history()).not.toContain('aborted')
    expect(testHarness.adapter.signApprovedContent).toHaveBeenCalledTimes(1)
    expect(testHarness.lock.leases.get('operation-a')?.releaseCalls).toBe(1)
    expect(testHarness.events).not.toContain('deliver')
  })

  test('cleanup after signing starts cannot claim zero signatures and a later rejection fails once', async () => {
    const signing = controlled<UniversalSignedResult>()
    let signingSignal: AbortSignal | undefined
    const testHarness = harness({
      sign: input => {
        signingSignal = input.signal
        return signing.promise
      }
    })
    const handle = testHarness.core.start(envelope(), testHarness.adapter)
    await handle.ready
    const approval = handle.approve()
    await vi.waitFor(() => expect(testHarness.adapter.signApprovedContent).toHaveBeenCalledTimes(1))

    handle.cleanup()
    expect(handle.state()).toBe('signing')
    expect(signingSignal?.aborted).toBe(true)
    signing.reject(new Error('synthetic signer rejected after cleanup'))
    await expect(approval).rejects.toThrowError('synthetic signer rejected after cleanup')

    expect(handle.state()).toBe('failed')
    expect(handle.history()).not.toContain('aborted')
    expect(testHarness.adapter.signApprovedContent).toHaveBeenCalledTimes(1)
    expect(testHarness.lock.leases.get('operation-a')?.releaseCalls).toBe(1)
    expect(testHarness.events).not.toContain('deliver')
  })

  test('expiration after signing starts does not reclassify the operation as expired', async () => {
    const signing = controlled<UniversalSignedResult>()
    let signingInput: Parameters<UniversalAuthorizationAdapter['signApprovedContent']>[0] | undefined
    const testHarness = harness({
      sign: input => {
        signingInput = input
        return signing.promise
      }
    })
    const handle = testHarness.core.start(
      envelope('operation-signing-expiry', 100),
      testHarness.adapter
    )
    await handle.ready
    const approval = handle.approve()
    await vi.waitFor(() => expect(testHarness.adapter.signApprovedContent).toHaveBeenCalledTimes(1))
    if (!signingInput) throw new Error('signer input was not captured')

    await vi.advanceTimersByTimeAsync(101)
    expect(handle.state()).toBe('signing')
    expect(signingInput.signal.aborted).toBe(true)
    signing.resolve(Object.freeze({
      format: 'synthetic/bytes',
      bytes: new Uint8Array([9]),
      contentHash: signingInput.contentHash
    }))
    await approval

    expect(handle.state()).toBe('completed')
    expect(handle.history()).not.toContain('expired')
    expect(testHarness.adapter.signApprovedContent).toHaveBeenCalledTimes(1)
    expect(testHarness.lock.leases.get('operation-signing-expiry')?.releaseCalls).toBe(1)
  })

  test('negative terminals reached before signing have zero synthetic signatures', async () => {
    const cases: Array<Readonly<{
      expected: 'rejected' | 'aborted' | 'expired' | 'failed'
      run: (handle: UniversalOperationHandle) => Promise<void>
      expiresIn?: number
      adapter?: AdapterFunctions
    }>> = [
      { expected: 'rejected', run: async handle => handle.reject() },
      { expected: 'aborted', run: async handle => handle.abort() },
      {
        expected: 'expired',
        expiresIn: 100,
        run: async () => { await vi.advanceTimersByTimeAsync(101) }
      },
      {
        expected: 'failed',
        adapter: { revalidate: async () => review([7, 7, 7]) },
        run: async handle => { await expectRejected(handle.approve()) }
      }
    ]
    for (const [index, current] of cases.entries()) {
      const testHarness = harness(current.adapter)
      const handle = testHarness.core.start(
        envelope(`negative-${index}`, current.expiresIn ?? 10_000),
        testHarness.adapter
      )
      await handle.ready
      await current.run(handle)
      expect(handle.state()).toBe(current.expected)
      expect(testHarness.adapter.signApprovedContent).not.toHaveBeenCalled()
    }
  })

  test('production-disabled core cannot create an operation', () => {
    const events: string[] = []
    const lock = new InstrumentedLock(events)
    const ledger = new InstrumentedLedger(events)
    const core = new UniversalAuthorizationCore({ enabled: false, lock, approvalLedger: ledger })
    expect(() => core.start(envelope(), syntheticAdapter(events)))
      .toThrowError('AUTHORIZATION_DISABLED')
    expect(lock.acquireCalls).toBe(0)
  })

  test('successful flow records the sole explicit positive lifecycle', async () => {
    const testHarness = harness()
    const handle = testHarness.core.start(envelope(), testHarness.adapter)
    await handle.ready
    await handle.approve()
    expect(handle.history()).toEqual([
      'disabled',
      'receiving',
      'preparing',
      'reviewReady',
      'approving',
      'revalidating',
      'signing',
      'completed'
    ])
  })
})

describe('universal authorization-only grants', () => {
  const createAuthorizationHarness = (
    functions: Pick<AdapterFunctions, 'prepare' | 'revalidate'> = {},
    dependencies: Partial<UniversalAuthorizationCoreDependencies> = {}
  ) => {
    const events: string[] = []
    const lock = new InstrumentedLock(events)
    const ledger = new InstrumentedLedger(events)
    const adapter = reviewAuthorizationAdapter(events, functions)
    const core = new UniversalAuthorizationCore({
      enabled: true,
      lock,
      approvalLedger: ledger,
      now: Date.now,
      createCapabilityId: operationId => `${operationId}:authorization-capability`,
      ...dependencies
    })
    return Object.freeze({ core, lock, ledger, adapter, events })
  }

  test('authorizes only after revalidation and one-use ledger consumption', async () => {
    const testHarness = createAuthorizationHarness()
    const handle = testHarness.core.startAuthorization(
      envelope('authorization-only'),
      testHarness.adapter
    )
    const prepared = await handle.ready
    const grant = await handle.authorize()

    expect(grant).toEqual({
      authorizationId: 'authorization-only:authorization-capability',
      operationId: 'authorization-only',
      contentHash: prepared.contentHash,
      expiresAt: Date.now() + 10_000
    })
    expect(testHarness.events).toEqual([
      'acquire:authorization-only',
      'prepare',
      'revalidate',
      'consume:authorization-only',
      'release:authorization-only'
    ])
    expect(handle.state()).toBe('authorized')
    expect(handle.history()).toEqual([
      'disabled',
      'receiving',
      'preparing',
      'reviewReady',
      'approving',
      'revalidating',
      'authorized'
    ])
    expect(Object.keys(testHarness.adapter).sort()).toEqual([
      'prepareReview',
      'profileId',
      'revalidateReview'
    ])
  })

  test('publishes a grant when the effective terminal remains authorized before expiry', async () => {
    let consumed = false
    const events: string[] = []
    const lock = new InstrumentedLock(events)
    const ledger: ApprovalConsumptionLedger = {
      async consume() {
        consumed = true
      }
    }
    const core = new UniversalAuthorizationCore({
      enabled: true,
      lock,
      approvalLedger: ledger,
      now: () => consumed ? TEST_NOW + 99 : TEST_NOW,
      createCapabilityId: operationId => `${operationId}:before-expiry`
    })
    const adapter = reviewAuthorizationAdapter(events)
    const handle = core.startAuthorization(
      envelope('authorization-before-expiry', 100),
      adapter
    )
    await handle.ready

    await expect(handle.authorize()).resolves.toMatchObject({
      authorizationId: 'authorization-before-expiry:before-expiry'
    })
    expect(handle.state()).toBe('authorized')
    expect(core.activeOperationId).toBeNull()
  })

  test('does not publish a consumed grant when expiry wins terminalization', async () => {
    const events: string[] = []
    const lock = new InstrumentedLock(events)
    const records = new Map<string, ApprovalConsumption>()
    let consumed = false
    let postConsumeClockReads = 0
    const now = () => {
      if (!consumed) return TEST_NOW
      postConsumeClockReads += 1
      return postConsumeClockReads === 1 ? TEST_NOW : TEST_NOW + 100
    }
    const ledger: ApprovalConsumptionLedger = {
      async consume(consumption) {
        if (records.has(consumption.operationId)) {
          throw new UniversalAuthorizationError('APPROVAL_ALREADY_CONSUMED')
        }
        records.set(consumption.operationId, consumption)
        consumed = true
      }
    }
    const core = new UniversalAuthorizationCore({
      enabled: true,
      lock,
      approvalLedger: ledger,
      now,
      createCapabilityId: operationId => `${operationId}:expiry-race`
    })
    const adapter = reviewAuthorizationAdapter(events)
    const first = core.startAuthorization(
      envelope('authorization-terminal-expiry', 100),
      adapter
    )
    await first.ready

    await expect(first.authorize()).rejects.toThrowError('REQUEST_EXPIRED')

    expect(first.state()).toBe('expired')
    expect(first.history().at(-1)).toBe('expired')
    expect(records.get('authorization-terminal-expiry')?.capabilityId)
      .toBe('authorization-terminal-expiry:expiry-race')
    expect(lock.leases.get('authorization-terminal-expiry')?.releaseCalls).toBe(1)
    expect(core.activeOperationId).toBeNull()

    consumed = false
    postConsumeClockReads = 0
    const retry = core.startAuthorization(
      envelope('authorization-terminal-expiry', 100),
      adapter
    )
    await retry.ready
    await expect(retry.authorize()).rejects.toThrowError('APPROVAL_ALREADY_CONSUMED')
    expect(retry.state()).toBe('failed')
    expect(records).toHaveLength(1)
  })

  test('keeps the existing signing path lifecycle and signer invocation unchanged', async () => {
    const testHarness = harness()
    const handle = testHarness.core.start(envelope('legacy-signing'), testHarness.adapter)
    await handle.ready
    await handle.approve()

    expect(handle.history()).toEqual([
      'disabled',
      'receiving',
      'preparing',
      'reviewReady',
      'approving',
      'revalidating',
      'signing',
      'completed'
    ])
    expect(testHarness.adapter.signApprovedContent).toHaveBeenCalledTimes(1)
  })

  test('rejects without consuming a capability', async () => {
    const testHarness = createAuthorizationHarness()
    const handle = testHarness.core.startAuthorization(envelope(), testHarness.adapter)
    await handle.ready
    handle.reject()

    expect(handle.state()).toBe('rejected')
    expect(testHarness.ledger.consumeCalls).toBe(0)
    expect(testHarness.lock.leases.get('operation-a')?.releaseCalls).toBe(1)
  })

  test('expires while reviewReady and aborts the exposed internal signal', async () => {
    const testHarness = createAuthorizationHarness()
    const handle = testHarness.core.startAuthorization(
      envelope('authorization-expiry', 100),
      testHarness.adapter
    )
    await handle.ready

    await vi.advanceTimersByTimeAsync(101)

    expect(handle.state()).toBe('expired')
    expect(handle.signal.aborted).toBe(true)
    expect(testHarness.ledger.consumeCalls).toBe(0)
    expect(testHarness.lock.leases.get('authorization-expiry')?.releaseCalls).toBe(1)
  })

  test('expires once when the remaining lifetime equals the platform timer maximum', async () => {
    const timerSpy = vi.spyOn(globalThis, 'setTimeout')
    const testHarness = createAuthorizationHarness()
    const handle = testHarness.core.startAuthorization(
      envelope('authorization-timer-max', UNIVERSAL_AUTHORIZATION_MAX_TIMER_DELAY_MS),
      testHarness.adapter
    )
    await handle.ready

    expect(timerSpy).toHaveBeenCalledTimes(1)
    expect(timerSpy).toHaveBeenLastCalledWith(
      expect.any(Function),
      UNIVERSAL_AUTHORIZATION_MAX_TIMER_DELAY_MS
    )

    await vi.advanceTimersByTimeAsync(UNIVERSAL_AUTHORIZATION_MAX_TIMER_DELAY_MS)

    expect(handle.state()).toBe('expired')
    expect(handle.history().filter(state => state === 'expired')).toHaveLength(1)
    expect(testHarness.lock.leases.get('authorization-timer-max')?.releaseCalls).toBe(1)
    expect(vi.getTimerCount()).toBe(0)
  })

  test('chunks a lifetime one millisecond above the platform timer maximum', async () => {
    const timerSpy = vi.spyOn(globalThis, 'setTimeout')
    const testHarness = createAuthorizationHarness()
    const handle = testHarness.core.startAuthorization(
      envelope('authorization-timer-max-plus-one', UNIVERSAL_AUTHORIZATION_MAX_TIMER_DELAY_MS + 1),
      testHarness.adapter
    )
    await handle.ready

    expect(timerSpy).toHaveBeenNthCalledWith(
      1,
      expect.any(Function),
      UNIVERSAL_AUTHORIZATION_MAX_TIMER_DELAY_MS
    )

    await vi.advanceTimersByTimeAsync(UNIVERSAL_AUTHORIZATION_MAX_TIMER_DELAY_MS)

    expect(handle.state()).toBe('reviewReady')
    expect(timerSpy).toHaveBeenNthCalledWith(2, expect.any(Function), 1)
    expect(vi.getTimerCount()).toBe(1)

    await vi.advanceTimersByTimeAsync(1)

    expect(handle.state()).toBe('expired')
    expect(handle.history().filter(state => state === 'expired')).toHaveLength(1)
    expect(testHarness.lock.leases.get('authorization-timer-max-plus-one')?.releaseCalls).toBe(1)
    expect(vi.getTimerCount()).toBe(0)
  })

  test('rearms multi-chunk lifetimes without an immediate timer spin', async () => {
    const timerSpy = vi.spyOn(globalThis, 'setTimeout')
    const testHarness = createAuthorizationHarness()
    const remainderMs = 7
    const handle = testHarness.core.startAuthorization(
      envelope(
        'authorization-timer-multiple-chunks',
        UNIVERSAL_AUTHORIZATION_MAX_TIMER_DELAY_MS * 2 + remainderMs
      ),
      testHarness.adapter
    )
    await handle.ready

    await vi.advanceTimersByTimeAsync(UNIVERSAL_AUTHORIZATION_MAX_TIMER_DELAY_MS)
    expect(handle.state()).toBe('reviewReady')
    expect(timerSpy).toHaveBeenCalledTimes(2)
    expect(timerSpy).toHaveBeenLastCalledWith(
      expect.any(Function),
      UNIVERSAL_AUTHORIZATION_MAX_TIMER_DELAY_MS
    )

    await vi.advanceTimersByTimeAsync(UNIVERSAL_AUTHORIZATION_MAX_TIMER_DELAY_MS)
    expect(handle.state()).toBe('reviewReady')
    expect(timerSpy).toHaveBeenCalledTimes(3)
    expect(timerSpy).toHaveBeenLastCalledWith(expect.any(Function), remainderMs)

    await vi.advanceTimersByTimeAsync(remainderMs)

    expect(handle.state()).toBe('expired')
    expect(timerSpy).toHaveBeenCalledTimes(3)
    expect(testHarness.lock.leases.get('authorization-timer-multiple-chunks')?.releaseCalls).toBe(1)
    expect(vi.getTimerCount()).toBe(0)
  })

  test('caps an unsafe lifetime difference formed from safe envelope timestamps', async () => {
    const timerSpy = vi.spyOn(globalThis, 'setTimeout')
    const now = Number.MIN_SAFE_INTEGER
    const testHarness = createAuthorizationHarness({}, { now: () => now })
    const extremeEnvelope = {
      ...rawEnvelope('authorization-extreme-lifetime'),
      issuedAt: Number.MIN_SAFE_INTEGER,
      expiresAt: Number.MAX_SAFE_INTEGER
    } as UniversalAuthorizationEnvelopeV1

    const handle = testHarness.core.startAuthorization(extremeEnvelope, testHarness.adapter)
    await handle.ready

    expect(Number.isSafeInteger(extremeEnvelope.expiresAt - now)).toBe(false)
    expect(timerSpy).toHaveBeenCalledTimes(1)
    expect(timerSpy).toHaveBeenLastCalledWith(
      expect.any(Function),
      UNIVERSAL_AUTHORIZATION_MAX_TIMER_DELAY_MS
    )

    handle.abort()
    expect(handle.state()).toBe('aborted')
    expect(vi.getTimerCount()).toBe(0)
  })

  test('cancels a capped timer when authorization aborts before later chunks', async () => {
    const timerSpy = vi.spyOn(globalThis, 'setTimeout')
    const testHarness = createAuthorizationHarness()
    const handle = testHarness.core.startAuthorization(
      envelope(
        'authorization-timer-abort',
        UNIVERSAL_AUTHORIZATION_MAX_TIMER_DELAY_MS * 3
      ),
      testHarness.adapter
    )
    await handle.ready

    handle.abort()
    await vi.runOnlyPendingTimersAsync()

    expect(handle.state()).toBe('aborted')
    expect(handle.history().filter(state => state === 'aborted')).toHaveLength(1)
    expect(timerSpy).toHaveBeenCalledTimes(1)
    expect(testHarness.lock.leases.get('authorization-timer-abort')?.releaseCalls).toBe(1)
    expect(vi.getTimerCount()).toBe(0)
  })

  test('rearms an early expiry wake-up until the injected clock reaches expiresAt', async () => {
    let now = TEST_NOW
    const testHarness = createAuthorizationHarness({}, { now: () => now })
    const handle = testHarness.core.startAuthorization(
      envelope('authorization-early-wakeup', 100),
      testHarness.adapter
    )
    await handle.ready

    await vi.advanceTimersByTimeAsync(100)

    expect(handle.state()).toBe('reviewReady')
    expect(handle.signal.aborted).toBe(false)
    expect(testHarness.core.activeOperationId).toBe('authorization-early-wakeup')

    now = TEST_NOW + 100
    await vi.advanceTimersByTimeAsync(100)

    expect(handle.state()).toBe('expired')
    expect(handle.signal.aborted).toBe(true)
    expect(testHarness.core.activeOperationId).toBeNull()
    expect(testHarness.lock.leases.get('authorization-early-wakeup')?.releaseCalls).toBe(1)
  })

  test('does not invoke lock or prepare for an already-aborted external signal', () => {
    const testHarness = createAuthorizationHarness()
    const controller = new AbortController()
    controller.abort()

    expect(() => testHarness.core.startAuthorization(
      envelope(),
      testHarness.adapter,
      { signal: controller.signal }
    )).toThrowError('OPERATION_ABORTED')
    expect(testHarness.lock.acquireCalls).toBe(0)
    expect(testHarness.adapter.prepareReview).not.toHaveBeenCalled()
  })

  test('bridges external abort during preparation and blocks late continuation', async () => {
    const preparation = controlled<UniversalReviewSnapshot>()
    const testHarness = createAuthorizationHarness({ prepare: () => preparation.promise })
    const controller = new AbortController()
    const handle = testHarness.core.startAuthorization(
      envelope(),
      testHarness.adapter,
      { signal: controller.signal }
    )
    await Promise.resolve()

    controller.abort()
    preparation.resolve(review())

    await expectRejected(handle.ready)
    expect(handle.state()).toBe('aborted')
    expect(handle.signal.aborted).toBe(true)
    expect(testHarness.adapter.revalidateReview).not.toHaveBeenCalled()
  })

  test('bridges external abort during revalidation and produces no grant', async () => {
    const revalidation = controlled<UniversalReviewSnapshot>()
    const testHarness = createAuthorizationHarness({ revalidate: () => revalidation.promise })
    const controller = new AbortController()
    const handle = testHarness.core.startAuthorization(
      envelope(),
      testHarness.adapter,
      { signal: controller.signal }
    )
    const prepared = await handle.ready
    const authorization = handle.authorize()

    controller.abort()
    revalidation.resolve(prepared.review)

    await expectRejected(authorization)
    expect(handle.state()).toBe('aborted')
    expect(testHarness.ledger.consumeCalls).toBe(0)
  })

  test('double authorize creates and consumes exactly one capability', async () => {
    const revalidation = controlled<UniversalReviewSnapshot>()
    const testHarness = createAuthorizationHarness({ revalidate: () => revalidation.promise })
    const handle = testHarness.core.startAuthorization(envelope(), testHarness.adapter)
    const prepared = await handle.ready
    const first = handle.authorize()

    expect(() => handle.authorize()).toThrowError('UNEXPECTED_OPERATION_STATE')
    revalidation.resolve(prepared.review)
    await first

    expect(testHarness.ledger.consumeCalls).toBe(1)
  })

  test('preserves single active operation ownership for authorization-only handles', async () => {
    const testHarness = createAuthorizationHarness()
    const first = testHarness.core.startAuthorization(
      envelope('authorization-owner-a'),
      testHarness.adapter
    )

    expect(() => testHarness.core.startAuthorization(
      envelope('authorization-owner-b'),
      testHarness.adapter
    )).toThrowError('OPERATION_ALREADY_ACTIVE')
    await first.ready
    first.cleanup()
    expect(testHarness.core.activeOperationId).toBeNull()
  })

  test('cleanup is idempotent and permits a later authorization operation', async () => {
    const testHarness = createAuthorizationHarness()
    const first = testHarness.core.startAuthorization(
      envelope('authorization-cleanup-a'),
      testHarness.adapter
    )
    await first.ready
    first.cleanup()
    first.cleanup()

    const second = testHarness.core.startAuthorization(
      envelope('authorization-cleanup-b'),
      testHarness.adapter
    )
    await second.ready
    second.reject()

    expect(first.history().filter(state => state === 'aborted')).toHaveLength(1)
    expect(testHarness.lock.leases.get('authorization-cleanup-a')?.releaseCalls).toBe(1)
  })

  test('defensively isolates the prepared review before authorization', async () => {
    const testHarness = createAuthorizationHarness()
    const handle = testHarness.core.startAuthorization(envelope(), testHarness.adapter)
    const prepared = await handle.ready
    prepared.review.effectiveContent[0] = 255

    await handle.authorize()

    const approvedReview = vi.mocked(testHarness.adapter.revalidateReview).mock.calls[0][1]
    expect(Array.from(approvedReview.effectiveContent)).toEqual([1, 2, 3])
  })

  test('rejects authorization when revalidated content changes', async () => {
    const testHarness = createAuthorizationHarness({
      revalidate: async () => review([1, 2, 4])
    })
    const handle = testHarness.core.startAuthorization(envelope(), testHarness.adapter)
    await handle.ready

    await expect(handle.authorize()).rejects.toThrowError('CONTENT_BINDING_MISMATCH')

    expect(handle.state()).toBe('failed')
    expect(testHarness.ledger.consumeCalls).toBe(0)
  })

  test('returns the exact universal content hash committed before approval', async () => {
    const testHarness = createAuthorizationHarness()
    const handle = testHarness.core.startAuthorization(envelope(), testHarness.adapter)
    const prepared = await handle.ready
    const grant = await handle.authorize()

    expect(grant.contentHash).toBe(prepared.contentHash)
    expect(grant.contentHash).toMatch(/^sha256:[0-9a-f]{64}$/)
    expect(Object.isFrozen(grant)).toBe(true)
  })

  test('relies on the durable ledger to reject reuse of an operation capability', async () => {
    const testHarness = createAuthorizationHarness()
    const first = testHarness.core.startAuthorization(
      envelope('authorization-reuse'),
      testHarness.adapter
    )
    await first.ready
    await first.authorize()

    const second = testHarness.core.startAuthorization(
      envelope('authorization-reuse'),
      testHarness.adapter
    )
    await second.ready
    await expect(second.authorize()).rejects.toThrowError('APPROVAL_ALREADY_CONSUMED')

    expect(second.state()).toBe('failed')
  })

  test('burns a consumed capability when external abort wins before grant publication', async () => {
    const events: string[] = []
    const lock = new InstrumentedLock(events)
    const controller = new AbortController()
    const records = new Map<string, ApprovalConsumption>()
    let abortAfterConsume = true
    const ledger: ApprovalConsumptionLedger = {
      async consume(consumption) {
        if (records.has(consumption.operationId)) {
          throw new UniversalAuthorizationError('APPROVAL_ALREADY_CONSUMED')
        }
        records.set(consumption.operationId, consumption)
        if (abortAfterConsume) controller.abort()
      }
    }
    const adapter = reviewAuthorizationAdapter(events)
    const core = new UniversalAuthorizationCore({
      enabled: true,
      lock,
      approvalLedger: ledger,
      now: Date.now,
      createCapabilityId: operationId => `${operationId}:burned-capability`
    })
    const first = core.startAuthorization(
      envelope('authorization-burned'),
      adapter,
      { signal: controller.signal }
    )
    await first.ready

    await expect(first.authorize()).rejects.toThrowError('OPERATION_ABORTED')
    expect(first.state()).toBe('aborted')
    expect(records.get('authorization-burned')?.capabilityId)
      .toBe('authorization-burned:burned-capability')

    abortAfterConsume = false
    const retry = core.startAuthorization(
      envelope('authorization-burned'),
      adapter,
      { signal: new AbortController().signal }
    )
    await retry.ready
    await expect(retry.authorize()).rejects.toThrowError('APPROVAL_ALREADY_CONSUMED')
    expect(retry.state()).toBe('failed')
  })

  test('rejects an invalid authorization-only capability id before ledger consumption', async () => {
    const testHarness = createAuthorizationHarness({}, { createCapabilityId: () => '' })
    const handle = testHarness.core.startAuthorization(envelope(), testHarness.adapter)
    await handle.ready

    expect(() => handle.authorize()).toThrowError('INVALID_CAPABILITY_ID')
    expect(handle.state()).toBe('failed')
    expect(testHarness.ledger.consumeCalls).toBe(0)
  })

  test.each([
    ['Error', () => { throw new Error('hostile capability source') }],
    ['plain hostile value', () => { throw Object.create(null) }]
  ])('finalizes and releases authorization ownership when createCapabilityId throws %s', async (
    _description,
    createCapabilityId
  ) => {
    const testHarness = createAuthorizationHarness({}, { createCapabilityId })
    const handle = testHarness.core.startAuthorization(
      envelope('authorization-capability-throw'),
      testHarness.adapter
    )
    await handle.ready

    expect(() => handle.authorize()).toThrowError('INVALID_CAPABILITY_ID')

    expect(handle.state()).toBe('failed')
    expect(handle.history().at(-1)).toBe('failed')
    expect(testHarness.core.activeOperationId).toBeNull()
    expect(testHarness.lock.leases.get('authorization-capability-throw')?.releaseCalls).toBe(1)
    expect(testHarness.ledger.consumeCalls).toBe(0)

    const retry = testHarness.core.startAuthorization(
      envelope('authorization-capability-retry'),
      testHarness.adapter
    )
    await retry.ready
    retry.reject()
    expect(retry.state()).toBe('rejected')
  })

  test('finalizes the legacy signing path when createCapabilityId throws', async () => {
    const testHarness = harness()
    const core = new UniversalAuthorizationCore({
      enabled: true,
      lock: testHarness.lock,
      approvalLedger: testHarness.ledger,
      now: Date.now,
      createCapabilityId: () => { throw new Error('hostile capability source') }
    })
    const handle = core.start(
      envelope('legacy-capability-throw'),
      testHarness.adapter
    )
    await handle.ready

    expect(() => handle.approve()).toThrowError('INVALID_CAPABILITY_ID')

    expect(handle.state()).toBe('failed')
    expect(core.activeOperationId).toBeNull()
    expect(testHarness.lock.leases.get('legacy-capability-throw')?.releaseCalls).toBe(1)
    expect(testHarness.adapter.signApprovedContent).not.toHaveBeenCalled()

    const retry = core.start(envelope('legacy-capability-retry'), testHarness.adapter)
    await retry.ready
    retry.reject()
    expect(retry.state()).toBe('rejected')
  })
})
