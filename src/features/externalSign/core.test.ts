import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest'
import type {
  UniversalAuthorizationAdapter,
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
