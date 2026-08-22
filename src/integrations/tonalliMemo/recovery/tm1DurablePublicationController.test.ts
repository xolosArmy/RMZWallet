import { describe, expect, test, vi } from 'vitest'
import type { Tm1ChronikRecoveryObserver } from './tm1ChronikRecoveryObserver'
import {
  createTm1DurablePublicationController
} from './tm1DurablePublicationController'
import {
  TM1_PUBLICATION_RECOVERY_SCHEMA,
  TM1_PUBLICATION_RECOVERY_SCHEMA_VERSION,
  assertTm1DispatchIntentTransition,
  assertTm1ExecutionEvidenceTransition,
  assertTm1OwnershipTransition,
  assertTm1RecoveryTransition,
  assertTm1TransportAcknowledgementTransition,
  consumedCapabilityIds,
  createTm1TransportAcknowledgedRecord,
  parseTm1PublicationRecoveryRecord,
  type Tm1PublicationRecoveryRecord,
  type Tm1RecoveryPreDispatchStage,
  type Tm1TransportAcknowledgementCommitEvidence
} from './tm1PublicationRecoveryModel'
import {
  Tm1PublicationRecoveryStoreError,
  type Tm1PublicationRecoveryStore,
  type Tm1RecoveryStoreCreate,
  type Tm1RecoveryStoreDispatchIntentCommit,
  type Tm1RecoveryStoreExecutionCommit,
  type Tm1RecoveryStoreOwnershipClaim,
  type Tm1RecoveryStoreRecoveryCommit,
  type Tm1RecoveryStoreTransportAcknowledgementCommit
} from './tm1PublicationRecoveryStore'

const HASH_A = 'aa'.repeat(32)
const HASH_B = 'bb'.repeat(32)
const HASH_C = 'cc'.repeat(32)
const BLOCK_HASH = 'dd'.repeat(32)
const CONTENT_HASH_A = `sha256:${'11'.repeat(32)}` as const
const CONTENT_HASH_B = `sha256:${'22'.repeat(32)}` as const
const PUBLICATION_ID = 'publication:recovery-test'

const STAGE_ORDER: readonly Tm1RecoveryPreDispatchStage[] = [
  'prepared',
  'signAuthorizationPending',
  'signAuthorizationConsumed',
  'signedAudited',
  'broadcastAuthorizationPending',
  'broadcastAuthorizationConsumed'
]

function preparedEvidence() {
  return {
    preparedId: 'prepared:one',
    bindingHash: HASH_A,
    preparedDigest: HASH_B
  }
}

function signedEvidence() {
  return {
    signedId: 'signed:one',
    txid: HASH_B,
    signedArtifactHash: HASH_C
  }
}

function signingAuthorization() {
  return {
    operationId: 'tm1-regtest.signing-authorization:one',
    capabilityId: 'capability:signing-one',
    contentHash: CONTENT_HASH_A,
    expiresAt: 2_000,
    consumedAt: 1_500,
    preparedId: 'prepared:one',
    bindingHash: HASH_A
  }
}

function broadcastAuthorization() {
  return {
    operationId: 'tm1-regtest.broadcast-authorization:one',
    capabilityId: 'capability:broadcast-one',
    contentHash: CONTENT_HASH_B,
    expiresAt: 3_000,
    consumedAt: 2_500,
    signedId: 'signed:one',
    txid: HASH_B,
    signedArtifactHash: HASH_C
  }
}

function preDispatchRecord(
  stage: Tm1RecoveryPreDispatchStage = 'broadcastAuthorizationConsumed',
  overrides: Partial<Tm1PublicationRecoveryRecord> = {}
): Tm1PublicationRecoveryRecord {
  const order = STAGE_ORDER.indexOf(stage)
  return parseTm1PublicationRecoveryRecord({
    schema: TM1_PUBLICATION_RECOVERY_SCHEMA,
    schemaVersion: TM1_PUBLICATION_RECOVERY_SCHEMA_VERSION,
    publicationId: PUBLICATION_ID,
    revision: 4,
    ownerEpoch: 2,
    phase: 'preDispatch',
    preDispatchStage: stage,
    prepared: preparedEvidence(),
    signed: order >= 3 ? signedEvidence() : null,
    signingAuthorization: order >= 2 ? signingAuthorization() : null,
    broadcastAuthorization: order >= 5 ? broadcastAuthorization() : null,
    dispatchIntent: null,
    transportAcknowledgement: null,
    lastObservation: null,
    terminal: null,
    ...overrides
  })
}

function outcomeUnknownRecord(
  overrides: Partial<Tm1PublicationRecoveryRecord> = {}
): Tm1PublicationRecoveryRecord {
  return parseTm1PublicationRecoveryRecord({
    ...preDispatchRecord(),
    revision: 5,
    phase: 'outcomeUnknown',
    preDispatchStage: null,
    dispatchIntent: {
      submissionId: 'submission:one',
      txid: HASH_B,
      signedArtifactHash: HASH_C,
      broadcastCapabilityId: 'capability:broadcast-one',
      committedAt: 2_600
    },
    ...overrides
  })
}

function submittedRecord(
  overrides: Partial<Tm1PublicationRecoveryRecord> = {}
): Tm1PublicationRecoveryRecord {
  return parseTm1PublicationRecoveryRecord({
    ...outcomeUnknownRecord(),
    revision: 6,
    phase: 'submittedObserved',
    lastObservation: {
      status: 'mempool',
      txid: HASH_B,
      observedAt: 3_000
    },
    ...overrides
  })
}

function observerResult(
  result: unknown = { status: 'absent', txid: HASH_B }
): Tm1ChronikRecoveryObserver {
  return Object.freeze({ observe: vi.fn().mockResolvedValue(result) })
}

function acceptedAcknowledgement(
  overrides: Partial<Tm1TransportAcknowledgementCommitEvidence> = {}
): Tm1TransportAcknowledgementCommitEvidence {
  return {
    submissionId: 'submission:one',
    signedId: 'signed:one',
    txid: HASH_B,
    signedArtifactHash: HASH_C,
    disposition: 'accepted',
    acknowledgedAt: 2_700,
    ...overrides
  }
}

class TestOnlyInMemoryRecoveryStore implements Tm1PublicationRecoveryStore {
  private readonly records = new Map<string, Tm1PublicationRecoveryRecord>()
  private readonly capabilityIds = new Set<string>()

  constructor(...records: readonly Tm1PublicationRecoveryRecord[]) {
    for (const record of records) this.insertInitial(record)
  }

  async load(publicationId: string): Promise<unknown | null> {
    return this.records.get(publicationId) ?? null
  }

  async listRecoverable(): Promise<unknown> {
    return [...this.records.values()]
  }

  async create(input: Tm1RecoveryStoreCreate): Promise<unknown> {
    const record = parseTm1PublicationRecoveryRecord(input.record)
    if (this.records.has(record.publicationId)) {
      throw new Tm1PublicationRecoveryStoreError('DUPLICATE_PUBLICATION_ID')
    }
    this.reserveCapabilities(consumedCapabilityIds(record))
    this.records.set(record.publicationId, record)
    return record
  }

  async commitExecutionEvidence(input: Tm1RecoveryStoreExecutionCommit): Promise<unknown> {
    const current = this.current(input)
    const next = parseTm1PublicationRecoveryRecord(input.nextRecord)
    assertTm1ExecutionEvidenceTransition(current, next)
    const expectedNew = consumedCapabilityIds(next).filter(
      capabilityId => !consumedCapabilityIds(current).includes(capabilityId)
    )
    expect([...input.newlyConsumedCapabilityIds]).toEqual(expectedNew)
    this.reserveCapabilities(expectedNew)
    this.records.set(current.publicationId, next)
    return next
  }

  async commitDispatchIntent(input: Tm1RecoveryStoreDispatchIntentCommit): Promise<unknown> {
    const current = this.current(input)
    const next = parseTm1PublicationRecoveryRecord(input.nextRecord)
    assertTm1DispatchIntentTransition(current, next)
    this.records.set(current.publicationId, next)
    return next
  }

  async commitTransportAcknowledgement(
    input: Tm1RecoveryStoreTransportAcknowledgementCommit
  ): Promise<unknown> {
    const current = this.current(input)
    const next = createTm1TransportAcknowledgedRecord(current, input.acknowledgement)
    assertTm1TransportAcknowledgementTransition(current, next)
    this.records.set(current.publicationId, next)
    return next
  }

  async commitRecoveryTransition(input: Tm1RecoveryStoreRecoveryCommit): Promise<unknown> {
    const current = this.current(input)
    const next = parseTm1PublicationRecoveryRecord(input.nextRecord)
    assertTm1RecoveryTransition(current, next)
    this.records.set(current.publicationId, next)
    return next
  }

  async claimOwnership(input: Tm1RecoveryStoreOwnershipClaim): Promise<unknown> {
    const current = this.current(input)
    if (
      !Number.isSafeInteger(input.nextOwnerEpoch) ||
      input.nextOwnerEpoch <= current.ownerEpoch
    ) throw new Tm1PublicationRecoveryStoreError('STALE_OWNER_EPOCH')
    const next = parseTm1PublicationRecoveryRecord({
      ...current,
      revision: current.revision + 1,
      ownerEpoch: input.nextOwnerEpoch
    })
    assertTm1OwnershipTransition(current, next)
    this.records.set(current.publicationId, next)
    return next
  }

  private insertInitial(recordValue: Tm1PublicationRecoveryRecord): void {
    const record = parseTm1PublicationRecoveryRecord(recordValue)
    if (this.records.has(record.publicationId)) {
      throw new Tm1PublicationRecoveryStoreError('DUPLICATE_PUBLICATION_ID')
    }
    this.reserveCapabilities(consumedCapabilityIds(record))
    this.records.set(record.publicationId, record)
  }

  private current(input: {
    publicationId: string
    expectedRevision: number
    expectedOwnerEpoch: number
  }): Tm1PublicationRecoveryRecord {
    const current = this.records.get(input.publicationId)
    if (!current) throw new Tm1PublicationRecoveryStoreError('PUBLICATION_NOT_FOUND')
    if (current.revision !== input.expectedRevision) {
      throw new Tm1PublicationRecoveryStoreError('REVISION_MISMATCH')
    }
    if (current.ownerEpoch !== input.expectedOwnerEpoch) {
      throw new Tm1PublicationRecoveryStoreError('STALE_OWNER_EPOCH')
    }
    return current
  }

  private reserveCapabilities(capabilityIds: readonly string[]): void {
    for (const capabilityId of capabilityIds) {
      if (this.capabilityIds.has(capabilityId)) {
        throw new Tm1PublicationRecoveryStoreError('DUPLICATE_CAPABILITY_CONSUMPTION')
      }
    }
    for (const capabilityId of capabilityIds) this.capabilityIds.add(capabilityId)
  }
}

function controllerHarness(
  record: Tm1PublicationRecoveryRecord,
  observer: Tm1ChronikRecoveryObserver = observerResult()
) {
  const store = new TestOnlyInMemoryRecoveryStore(record)
  const controller = createTm1DurablePublicationController({
    store,
    observer,
    now: () => 4_000
  })
  return Object.freeze({ store, observer, controller })
}

function command(record: Tm1PublicationRecoveryRecord) {
  return {
    publicationId: record.publicationId,
    expectedRevision: record.revision,
    expectedOwnerEpoch: record.ownerEpoch
  }
}

describe('TM1 conservative durable publication controller', () => {
  test('fails closed on malformed persisted state', async () => {
    const store = {
      ...emptyStore(),
      load: vi.fn().mockResolvedValue({ schema: TM1_PUBLICATION_RECOVERY_SCHEMA })
    }
    const controller = createTm1DurablePublicationController({
      store,
      observer: observerResult()
    })

    await expect(controller.getPublication(PUBLICATION_ID)).rejects.toMatchObject({
      code: 'MALFORMED_RECOVERY_RECORD'
    })
  })

  test('rejects an unsupported persisted schema version', async () => {
    const incompatible = { ...preDispatchRecord(), schemaVersion: 2 }
    const store = { ...emptyStore(), load: vi.fn().mockResolvedValue(incompatible) }
    const controller = createTm1DurablePublicationController({
      store,
      observer: observerResult()
    })

    await expect(controller.getPublication(PUBLICATION_ID)).rejects.toMatchObject({
      code: 'UNSUPPORTED_RECOVERY_SCHEMA'
    })
  })

  test('rejects stale expectedRevision before observing', async () => {
    const record = outcomeUnknownRecord()
    const harness = controllerHarness(record)

    await expect(harness.controller.reconcile({
      ...command(record),
      expectedRevision: record.revision - 1
    })).rejects.toMatchObject({ code: 'REVISION_MISMATCH' })
    expect(harness.observer.observe).not.toHaveBeenCalled()
  })

  test('rejects a stale owner epoch before observing', async () => {
    const record = outcomeUnknownRecord()
    const harness = controllerHarness(record)

    await expect(harness.controller.reconcile({
      ...command(record),
      expectedOwnerEpoch: record.ownerEpoch - 1
    })).rejects.toMatchObject({ code: 'STALE_OWNER_EPOCH' })
    expect(harness.observer.observe).not.toHaveBeenCalled()
  })

  test('abandons an interrupted pending SIGN without creating authority', async () => {
    const record = preDispatchRecord('signAuthorizationPending')
    const harness = controllerHarness(record)

    const abandoned = await harness.controller.abandonInterruptedPublication(command(record))

    expect(abandoned).toMatchObject({
      phase: 'abandoned',
      revision: record.revision + 1,
      terminal: { status: 'abandoned', code: 'PROCESS_INTERRUPTED' }
    })
    expect(abandoned.signingAuthorization).toBeNull()
    expect(abandoned.dispatchIntent).toBeNull()
    expect(harness.observer.observe).not.toHaveBeenCalled()
  })

  test('abandons pending BROADCAST only while dispatch is provably absent', async () => {
    const record = preDispatchRecord('broadcastAuthorizationPending')
    const harness = controllerHarness(record)

    const abandoned = await harness.controller.abandonInterruptedPublication(command(record))

    expect(abandoned.phase).toBe('abandoned')
    expect(abandoned.signed).toEqual(record.signed)
    expect(abandoned.dispatchIntent).toBeNull()
  })

  test('never abandons an attempt once dispatch intent exists', async () => {
    const record = outcomeUnknownRecord()
    const harness = controllerHarness(record)

    await expect(
      harness.controller.abandonInterruptedPublication(command(record))
    ).rejects.toMatchObject({ code: 'INVALID_RECOVERY_STATE' })
  })

  test('atomically converts consumed BROADCAST evidence into outcomeUnknown', async () => {
    const before = preDispatchRecord()
    const store = new TestOnlyInMemoryRecoveryStore(before)
    const after = outcomeUnknownRecord()

    const committed = await store.commitDispatchIntent({
      ...command(before),
      nextRecord: after
    })

    expect(committed).toEqual(after)
    await expect(store.load(PUBLICATION_ID)).resolves.toMatchObject({
      phase: 'outcomeUnknown',
      dispatchIntent: { txid: HASH_B },
      transportAcknowledgement: null
    })
  })

  test.each([2_500, 2_600])(
    'accepts dispatch committedAt %i at or after BROADCAST consumption',
    committedAt => {
      const valid = outcomeUnknownRecord()
      const snapshot = parseTm1PublicationRecoveryRecord({
        ...valid,
        dispatchIntent: {
          ...valid.dispatchIntent,
          committedAt
        }
      })

      expect(snapshot.dispatchIntent?.committedAt).toBe(committedAt)
      expect(Object.isFrozen(snapshot.dispatchIntent)).toBe(true)
    }
  )

  test('rejects persisted dispatch committed before BROADCAST consumption', () => {
    const valid = outcomeUnknownRecord()
    const invalid = {
      ...valid,
      dispatchIntent: {
        ...valid.dispatchIntent,
        committedAt: 2_499
      }
    }

    expect(() => parseTm1PublicationRecoveryRecord(invalid)).toThrowError(
      expect.objectContaining({ code: 'MALFORMED_RECOVERY_RECORD' })
    )
  })

  test('rejects invalid dispatch ordering through commit without mutation', async () => {
    const before = preDispatchRecord()
    const store = new TestOnlyInMemoryRecoveryStore(before)
    const validAfter = outcomeUnknownRecord()
    const invalidAfter = {
      ...validAfter,
      dispatchIntent: {
        ...validAfter.dispatchIntent,
        committedAt: 2_499
      }
    } as Tm1PublicationRecoveryRecord

    expect(() => assertTm1DispatchIntentTransition(before, invalidAfter)).toThrowError(
      expect.objectContaining({ code: 'INVALID_RECOVERY_TRANSITION' })
    )
    await expect(store.commitDispatchIntent({
      ...command(before),
      nextRecord: invalidAfter
    })).rejects.toMatchObject({ code: 'MALFORMED_RECOVERY_RECORD' })
    await expect(store.load(PUBLICATION_ID)).resolves.toMatchObject({
      revision: before.revision,
      ownerEpoch: before.ownerEpoch,
      phase: 'preDispatch',
      dispatchIntent: null
    })
  })

  test('rejects invalid dispatch ordering in recovery and acknowledgement paths', () => {
    const valid = outcomeUnknownRecord()
    const invalid = {
      ...valid,
      dispatchIntent: {
        ...valid.dispatchIntent,
        committedAt: 2_499
      }
    } as Tm1PublicationRecoveryRecord
    const invalidRecoveryNext = {
      ...invalid,
      revision: invalid.revision + 1,
      lastObservation: {
        status: 'absent' as const,
        txid: HASH_B,
        observedAt: 4_000
      }
    } as Tm1PublicationRecoveryRecord
    const invalidAcknowledgedNext = {
      ...invalid,
      revision: invalid.revision + 1,
      phase: 'submittedObserved',
      transportAcknowledgement: {
        txid: HASH_B,
        disposition: 'accepted',
        acknowledgedAt: 2_700
      }
    } as Tm1PublicationRecoveryRecord

    expect(() => assertTm1RecoveryTransition(invalid, invalidRecoveryNext)).toThrowError(
      expect.objectContaining({ code: 'INVALID_RECOVERY_TRANSITION' })
    )
    expect(() => assertTm1TransportAcknowledgementTransition(
      invalid,
      invalidAcknowledgedNext
    )).toThrowError(expect.objectContaining({ code: 'INVALID_RECOVERY_TRANSITION' }))
    expect(() => createTm1TransportAcknowledgedRecord(
      invalid,
      acceptedAcknowledgement()
    )).toThrowError(expect.objectContaining({ code: 'MALFORMED_RECOVERY_RECORD' }))
  })

  test('rejects invalid hydrated ordering before invoking the recovery observer', async () => {
    const valid = outcomeUnknownRecord()
    const invalid = {
      ...valid,
      dispatchIntent: {
        ...valid.dispatchIntent,
        committedAt: 2_499
      }
    }
    const observer = observerResult()
    const controller = createTm1DurablePublicationController({
      store: {
        ...emptyStore(),
        load: vi.fn().mockResolvedValue(invalid)
      },
      observer
    })

    await expect(controller.reconcile(command(valid))).rejects.toMatchObject({
      code: 'MALFORMED_RECOVERY_RECORD'
    })
    expect(observer.observe).not.toHaveBeenCalled()
  })

  test('fails closed on malformed or hostile dispatch timestamps', () => {
    const valid = outcomeUnknownRecord()
    expect(() => parseTm1PublicationRecoveryRecord({
      ...valid,
      dispatchIntent: {
        ...valid.dispatchIntent,
        committedAt: Number.NaN
      }
    })).toThrowError(expect.objectContaining({ code: 'MALFORMED_RECOVERY_RECORD' }))

    let getterCalls = 0
    const hostileDispatchIntent = { ...valid.dispatchIntent }
    Object.defineProperty(hostileDispatchIntent, 'committedAt', {
      enumerable: true,
      get: () => {
        getterCalls += 1
        return 2_600
      }
    })
    expect(() => parseTm1PublicationRecoveryRecord({
      ...valid,
      dispatchIntent: hostileDispatchIntent
    })).toThrowError(expect.objectContaining({ code: 'MALFORMED_RECOVERY_RECORD' }))
    expect(getterCalls).toBe(0)
  })

  test('accepts the complete causal timeline at equality boundaries', async () => {
    const base = outcomeUnknownRecord()
    const before = parseTm1PublicationRecoveryRecord({
      ...base,
      dispatchIntent: {
        ...base.dispatchIntent,
        committedAt: 2_500
      }
    })
    const store = new TestOnlyInMemoryRecoveryStore(before)

    const committed = await store.commitTransportAcknowledgement({
      ...command(before),
      acknowledgement: acceptedAcknowledgement({ acknowledgedAt: 2_500 })
    }) as Tm1PublicationRecoveryRecord

    expect(committed).toMatchObject({
      phase: 'submittedObserved',
      revision: before.revision + 1,
      broadcastAuthorization: { consumedAt: 2_500 },
      dispatchIntent: { committedAt: 2_500 },
      transportAcknowledgement: { acknowledgedAt: 2_500 }
    })
  })

  test('durably commits a matching accepted acknowledgement for the exact dispatch', async () => {
    const before = outcomeUnknownRecord()
    const store = new TestOnlyInMemoryRecoveryStore(before)

    const committed = await store.commitTransportAcknowledgement({
      ...command(before),
      acknowledgement: acceptedAcknowledgement()
    }) as Tm1PublicationRecoveryRecord

    expect(committed).toMatchObject({
      revision: before.revision + 1,
      phase: 'submittedObserved',
      signed: {
        signedId: 'signed:one',
        txid: HASH_B,
        signedArtifactHash: HASH_C
      },
      dispatchIntent: {
        submissionId: 'submission:one',
        txid: HASH_B,
        signedArtifactHash: HASH_C
      },
      transportAcknowledgement: {
        txid: HASH_B,
        disposition: 'accepted',
        acknowledgedAt: 2_700
      }
    })
    expect(committed.signingAuthorization).toEqual(before.signingAuthorization)
    expect(committed.broadcastAuthorization).toEqual(before.broadcastAuthorization)
    expect(Object.isFrozen(committed)).toBe(true)
    expect(Object.isFrozen(committed.transportAcknowledgement)).toBe(true)
  })

  test('keeps acknowledgement outside the generic recovery transition path', () => {
    const before = outcomeUnknownRecord()
    const acknowledged = createTm1TransportAcknowledgedRecord(
      before,
      acceptedAcknowledgement()
    )

    expect(() => assertTm1RecoveryTransition(before, acknowledged)).toThrowError(
      expect.objectContaining({ code: 'INVALID_RECOVERY_TRANSITION' })
    )
    expect(() => assertTm1TransportAcknowledgementTransition(
      before,
      acknowledged
    )).not.toThrow()
  })

  test('rejects stale acknowledgement revision and owner epoch', async () => {
    const before = outcomeUnknownRecord()
    const store = new TestOnlyInMemoryRecoveryStore(before)

    await expect(store.commitTransportAcknowledgement({
      ...command(before),
      expectedRevision: before.revision - 1,
      acknowledgement: acceptedAcknowledgement()
    })).rejects.toMatchObject({ code: 'REVISION_MISMATCH' })
    await expect(store.commitTransportAcknowledgement({
      ...command(before),
      expectedOwnerEpoch: before.ownerEpoch - 1,
      acknowledgement: acceptedAcknowledgement()
    })).rejects.toMatchObject({ code: 'STALE_OWNER_EPOCH' })
    await expect(store.load(PUBLICATION_ID)).resolves.toEqual(before)
  })

  test('rejects acknowledgement before a durable dispatch intent exists', async () => {
    const before = preDispatchRecord()
    const store = new TestOnlyInMemoryRecoveryStore(before)

    await expect(store.commitTransportAcknowledgement({
      ...command(before),
      acknowledgement: acceptedAcknowledgement()
    })).rejects.toMatchObject({ code: 'INVALID_RECOVERY_TRANSITION' })
  })

  test.each([
    ['submissionId', 'submission:different'],
    ['signedId', 'signed:different'],
    ['txid', HASH_A],
    ['signedArtifactHash', HASH_A]
  ] as const)('rejects acknowledgement with mismatched %s', async (field, value) => {
    const before = outcomeUnknownRecord()
    const store = new TestOnlyInMemoryRecoveryStore(before)

    await expect(store.commitTransportAcknowledgement({
      ...command(before),
      acknowledgement: acceptedAcknowledgement({ [field]: value })
    })).rejects.toMatchObject({ code: 'INVALID_RECOVERY_TRANSITION' })
    await expect(store.load(PUBLICATION_ID)).resolves.toEqual(before)
  })

  test('rejects repeated acknowledgement deterministically', async () => {
    const before = outcomeUnknownRecord()
    const store = new TestOnlyInMemoryRecoveryStore(before)
    const first = await store.commitTransportAcknowledgement({
      ...command(before),
      acknowledgement: acceptedAcknowledgement()
    }) as Tm1PublicationRecoveryRecord

    await expect(store.commitTransportAcknowledgement({
      ...command(before),
      acknowledgement: acceptedAcknowledgement()
    })).rejects.toMatchObject({ code: 'REVISION_MISMATCH' })
    await expect(store.commitTransportAcknowledgement({
      ...command(first),
      acknowledgement: acceptedAcknowledgement({ acknowledgedAt: 2_800 })
    })).rejects.toMatchObject({ code: 'INVALID_RECOVERY_TRANSITION' })
    await expect(store.load(PUBLICATION_ID)).resolves.toEqual(first)
  })

  test('does not downgrade a confirmed record when acknowledgement arrives late', async () => {
    const confirmed = parseTm1PublicationRecoveryRecord({
      ...submittedRecord(),
      revision: 7,
      phase: 'confirmedObserved',
      lastObservation: {
        status: 'confirmed',
        txid: HASH_B,
        observedAt: 3_500,
        confirmations: 1,
        blockHash: BLOCK_HASH,
        blockHeight: 109
      }
    })
    const store = new TestOnlyInMemoryRecoveryStore(confirmed)

    await expect(store.commitTransportAcknowledgement({
      ...command(confirmed),
      acknowledgement: acceptedAcknowledgement()
    })).rejects.toMatchObject({ code: 'INVALID_RECOVERY_TRANSITION' })
    await expect(store.load(PUBLICATION_ID)).resolves.toEqual(confirmed)
  })

  test('fails closed on malformed or hostile acknowledgement evidence', async () => {
    const before = outcomeUnknownRecord()
    const store = new TestOnlyInMemoryRecoveryStore(before)
    let getterCalls = 0
    const accessor = { ...acceptedAcknowledgement() }
    Object.defineProperty(accessor, 'txid', {
      enumerable: true,
      get: () => {
        getterCalls += 1
        return HASH_B
      }
    })

    await expect(store.commitTransportAcknowledgement({
      ...command(before),
      acknowledgement: accessor as Tm1TransportAcknowledgementCommitEvidence
    })).rejects.toMatchObject({ code: 'MALFORMED_RECOVERY_RECORD' })
    expect(getterCalls).toBe(0)

    const hostile = new Proxy({}, {
      ownKeys: () => { throw new Error('hostile acknowledgement') }
    })
    await expect(store.commitTransportAcknowledgement({
      ...command(before),
      acknowledgement: hostile as Tm1TransportAcknowledgementCommitEvidence
    })).rejects.toMatchObject({ code: 'MALFORMED_RECOVERY_RECORD' })
    await expect(store.commitTransportAcknowledgement({
      ...command(before),
      acknowledgement: {
        ...acceptedAcknowledgement(),
        disposition: 'ambiguous'
      } as unknown as Tm1TransportAcknowledgementCommitEvidence
    })).rejects.toMatchObject({ code: 'MALFORMED_RECOVERY_RECORD' })
    await expect(store.load(PUBLICATION_ID)).resolves.toEqual(before)
  })

  test('rejects acknowledgement timestamps before the durable dispatch intent', async () => {
    const before = outcomeUnknownRecord()
    const store = new TestOnlyInMemoryRecoveryStore(before)

    await expect(store.commitTransportAcknowledgement({
      ...command(before),
      acknowledgement: acceptedAcknowledgement({ acknowledgedAt: 2_599 })
    })).rejects.toMatchObject({ code: 'INVALID_RECOVERY_TRANSITION' })
  })

  test('keeps outcomeUnknown when exact txid is absent', async () => {
    const record = outcomeUnknownRecord()
    const harness = controllerHarness(record)

    const next = await harness.controller.reconcile(command(record))

    expect(next.phase).toBe('outcomeUnknown')
    expect(next.lastObservation).toEqual({
      status: 'absent',
      txid: HASH_B,
      observedAt: 4_000
    })
    expect(next.dispatchIntent).toEqual(record.dispatchIntent)
  })

  test('keeps durable uncertainty unchanged when observation is unavailable', async () => {
    const record = outcomeUnknownRecord()
    const observer = Object.freeze<Tm1ChronikRecoveryObserver>({
      observe: vi.fn().mockRejectedValue(new Error('Chronik unavailable'))
    })
    const harness = controllerHarness(record, observer)

    await expect(harness.controller.reconcile(command(record))).rejects.toMatchObject({
      code: 'OBSERVATION_UNAVAILABLE'
    })
    await expect(harness.store.load(PUBLICATION_ID)).resolves.toEqual(record)
  })

  test('fails closed on a malformed observer result without changing state', async () => {
    const record = outcomeUnknownRecord()
    const observer = Object.freeze<Tm1ChronikRecoveryObserver>({
      observe: vi.fn().mockResolvedValue({ status: 'mempool', txid: HASH_A })
    })
    const harness = controllerHarness(record, observer)

    await expect(harness.controller.reconcile(command(record))).rejects.toMatchObject({
      code: 'INVALID_RECOVERY_OBSERVATION'
    })
    await expect(harness.store.load(PUBLICATION_ID)).resolves.toEqual(record)
  })

  test('promotes an exact mempool observation to submittedObserved', async () => {
    const record = outcomeUnknownRecord()
    const harness = controllerHarness(record, observerResult({ status: 'mempool', txid: HASH_B }))

    const next = await harness.controller.reconcile(command(record))

    expect(next).toMatchObject({
      phase: 'submittedObserved',
      lastObservation: { status: 'mempool', txid: HASH_B }
    })
  })

  test('promotes an exact confirmation directly from outcomeUnknown', async () => {
    const record = outcomeUnknownRecord()
    const harness = controllerHarness(record, observerResult({
      status: 'confirmed',
      txid: HASH_B,
      confirmations: 2,
      blockHash: BLOCK_HASH,
      blockHeight: 109
    }))

    const next = await harness.controller.reconcile(command(record))

    expect(next).toMatchObject({
      phase: 'confirmedObserved',
      lastObservation: {
        status: 'confirmed',
        confirmations: 2,
        blockHash: BLOCK_HASH,
        blockHeight: 109
      }
    })
  })

  test('promotes submittedObserved to confirmedObserved', async () => {
    const record = submittedRecord()
    const harness = controllerHarness(record, observerResult({
      status: 'confirmed',
      txid: HASH_B,
      confirmations: 1,
      blockHash: BLOCK_HASH,
      blockHeight: 110
    }))

    const next = await harness.controller.observeConfirmation(command(record))

    expect(next.phase).toBe('confirmedObserved')
  })

  test('does not regress submittedObserved when a later read is absent', async () => {
    const record = submittedRecord()
    const harness = controllerHarness(record)

    const next = await harness.controller.observeConfirmation(command(record))

    expect(next.phase).toBe('submittedObserved')
    expect(next.lastObservation?.status).toBe('absent')
  })

  test('rejects every recovery transition back to a transport-capable phase', () => {
    const previous = outcomeUnknownRecord()
    const regressed = preDispatchRecord('broadcastAuthorizationConsumed', {
      revision: previous.revision + 1
    })

    expect(() => assertTm1RecoveryTransition(previous, regressed)).toThrowError(
      expect.objectContaining({ code: 'INVALID_RECOVERY_TRANSITION' })
    )
  })

  test('keeps consumed SIGN evidence immutable and non-reusable', () => {
    const previous = outcomeUnknownRecord()
    const mutated = parseTm1PublicationRecoveryRecord({
      ...previous,
      revision: previous.revision + 1,
      signingAuthorization: {
        ...previous.signingAuthorization,
        capabilityId: 'capability:signing-replayed'
      },
      lastObservation: { status: 'absent', txid: HASH_B, observedAt: 4_000 }
    })

    expect(() => assertTm1RecoveryTransition(previous, mutated)).toThrowError(
      expect.objectContaining({ code: 'INVALID_RECOVERY_TRANSITION' })
    )
  })

  test('keeps consumed BROADCAST evidence immutable and non-reusable', () => {
    const previous = outcomeUnknownRecord()
    const mutated = parseTm1PublicationRecoveryRecord({
      ...previous,
      revision: previous.revision + 1,
      broadcastAuthorization: {
        ...previous.broadcastAuthorization,
        operationId: 'tm1-regtest.broadcast-authorization:replayed'
      },
      dispatchIntent: {
        ...previous.dispatchIntent,
        broadcastCapabilityId: 'capability:broadcast-one'
      },
      lastObservation: { status: 'absent', txid: HASH_B, observedAt: 4_000 }
    })

    expect(() => assertTm1RecoveryTransition(previous, mutated)).toThrowError(
      expect.objectContaining({ code: 'INVALID_RECOVERY_TRANSITION' })
    )
  })

  test('rejects any SIGN or BROADCAST binding mismatch', () => {
    expect(() => parseTm1PublicationRecoveryRecord({
      ...preDispatchRecord(),
      signingAuthorization: {
        ...signingAuthorization(),
        bindingHash: HASH_C
      }
    })).toThrowError(expect.objectContaining({ code: 'MALFORMED_RECOVERY_RECORD' }))

    expect(() => parseTm1PublicationRecoveryRecord({
      ...preDispatchRecord(),
      broadcastAuthorization: {
        ...broadcastAuthorization(),
        txid: HASH_A
      }
    })).toThrowError(expect.objectContaining({ code: 'MALFORMED_RECOVERY_RECORD' }))
  })

  test('contains hostile persisted accessors and Proxy traps', async () => {
    let getterCalls = 0
    const accessor = { ...outcomeUnknownRecord() }
    Object.defineProperty(accessor, 'phase', {
      enumerable: true,
      get: () => {
        getterCalls += 1
        throw new Error('hostile getter')
      }
    })
    expect(() => parseTm1PublicationRecoveryRecord(accessor)).toThrowError(
      expect.objectContaining({ code: 'MALFORMED_RECOVERY_RECORD' })
    )
    expect(getterCalls).toBe(0)

    const hostile = new Proxy({}, {
      ownKeys: () => { throw new Error('hostile proxy') }
    })
    const store = { ...emptyStore(), load: vi.fn().mockResolvedValue(hostile) }
    const controller = createTm1DurablePublicationController({
      store,
      observer: observerResult()
    })
    await expect(controller.getPublication(PUBLICATION_ID)).rejects.toMatchObject({
      code: 'MALFORMED_RECOVERY_RECORD'
    })
  })

  test.each(['privateKey', 'private_key', 'wif', 'signer', 'transport', 'abortSignal'])(
    'rejects forbidden authority field %s',
    forbiddenField => {
      expect(() => parseTm1PublicationRecoveryRecord({
        ...outcomeUnknownRecord(),
        [forbiddenField]: 'forbidden'
      })).toThrowError(expect.objectContaining({ code: 'FORBIDDEN_AUTHORITY_FIELD' }))
    }
  )

  test('returns defensive frozen snapshots that isolate store mutation', async () => {
    const mutable = structuredClone(outcomeUnknownRecord())
    const store = { ...emptyStore(), load: vi.fn().mockResolvedValue(mutable) }
    const controller = createTm1DurablePublicationController({
      store,
      observer: observerResult()
    })

    const snapshot = await controller.getPublication(PUBLICATION_ID)
    ;(mutable.signed as { signedId: string }).signedId = 'signed:mutated-after-read'

    expect(snapshot.signed?.signedId).toBe('signed:one')
    expect(Object.isFrozen(snapshot)).toBe(true)
    expect(Object.isFrozen(snapshot.signed)).toBe(true)
    expect(Object.isFrozen(snapshot.dispatchIntent)).toBe(true)
  })

  test('serializes duplicate reconcile attempts so only one CAS wins', async () => {
    const record = outcomeUnknownRecord()
    const harness = controllerHarness(record)

    const results = await Promise.allSettled([
      harness.controller.reconcile(command(record)),
      harness.controller.reconcile(command(record))
    ])

    expect(results.filter(result => result.status === 'fulfilled')).toHaveLength(1)
    const rejection = results.find(result => result.status === 'rejected')
    expect(rejection).toMatchObject({
      status: 'rejected',
      reason: { code: 'REVISION_MISMATCH' }
    })
  })

  test('prevents an old process from committing after ownership takeover', async () => {
    const record = outcomeUnknownRecord()
    const harness = controllerHarness(record)
    const taken = await harness.store.claimOwnership({
      ...command(record),
      nextOwnerEpoch: record.ownerEpoch + 1
    }) as Tm1PublicationRecoveryRecord

    await expect(harness.controller.reconcile({
      publicationId: record.publicationId,
      expectedRevision: taken.revision,
      expectedOwnerEpoch: record.ownerEpoch
    })).rejects.toMatchObject({ code: 'STALE_OWNER_EPOCH' })
  })

  test('never allows observation to mutate authoritative signed evidence', async () => {
    const record = outcomeUnknownRecord()
    const observer = Object.freeze<Tm1ChronikRecoveryObserver>({
      observe: vi.fn().mockImplementation(async () => {
        const attempted = record.signed as { signedId: string }
        expect(() => { attempted.signedId = 'signed:observer-mutation' }).toThrow()
        return { status: 'absent', txid: HASH_B }
      })
    })
    const harness = controllerHarness(record, observer)

    const next = await harness.controller.reconcile(command(record))

    expect(next.signed).toEqual(record.signed)
  })

  test('never recovers rejected, expired, failed, abandoned, or confirmed terminals', async () => {
    const terminalRecords = [
      parseTm1PublicationRecoveryRecord({
        ...preDispatchRecord('prepared'),
        phase: 'failedTerminal',
        preDispatchStage: null,
        terminal: {
          status: 'expired',
          stage: 'signing',
          code: 'SIGNING_AUTHORIZATION_EXPIRED',
          recordedAt: 3_000
        }
      }),
      parseTm1PublicationRecoveryRecord({
        ...preDispatchRecord('prepared'),
        phase: 'failedTerminal',
        preDispatchStage: null,
        terminal: {
          status: 'rejected',
          stage: 'signing',
          code: 'SIGNING_REJECTED',
          recordedAt: 3_000
        }
      })
    ]

    for (const record of terminalRecords) {
      const harness = controllerHarness(record)
      await expect(harness.controller.reconcile(command(record))).rejects.toMatchObject({
        code: 'INVALID_RECOVERY_STATE'
      })
    }
  })

  test('lists only nonterminal recoverable records as frozen snapshots', async () => {
    const recoverable = outcomeUnknownRecord()
    const terminal = parseTm1PublicationRecoveryRecord({
      ...preDispatchRecord('prepared', {
        publicationId: 'publication:terminal',
        revision: 1
      }),
      phase: 'abandoned',
      preDispatchStage: null,
      terminal: {
        status: 'abandoned',
        stage: 'preDispatch',
        code: 'PROCESS_INTERRUPTED',
        recordedAt: 3_000
      }
    })
    const store = new TestOnlyInMemoryRecoveryStore(recoverable, terminal)
    const controller = createTm1DurablePublicationController({
      store,
      observer: observerResult()
    })

    const listed = await controller.listRecoverablePublications()

    expect(listed.map(record => record.publicationId)).toEqual([PUBLICATION_ID])
    expect(Object.isFrozen(listed)).toBe(true)
    expect(Object.isFrozen(listed[0])).toBe(true)
  })

  test('requires globally unique capability consumption in the store contract', async () => {
    const first = outcomeUnknownRecord()
    const second = parseTm1PublicationRecoveryRecord({
      ...first,
      publicationId: 'publication:duplicate-capability'
    })
    const store = new TestOnlyInMemoryRecoveryStore(first)

    await expect(store.create({ record: second })).rejects.toMatchObject({
      code: 'DUPLICATE_CAPABILITY_CONSUMPTION'
    })
  })

  test('records consumed authorization only through monotonic execution evidence', async () => {
    const before = preDispatchRecord('signAuthorizationPending')
    const after = preDispatchRecord('signAuthorizationConsumed', {
      revision: before.revision + 1
    })
    const store = new TestOnlyInMemoryRecoveryStore(before)

    const committed = await store.commitExecutionEvidence({
      ...command(before),
      nextRecord: after,
      newlyConsumedCapabilityIds: ['capability:signing-one']
    })

    expect(committed).toEqual(after)
  })

  test('represents a known transport acknowledgement as submitted evidence', () => {
    const record = parseTm1PublicationRecoveryRecord({
      ...outcomeUnknownRecord(),
      revision: 6,
      phase: 'submittedObserved',
      transportAcknowledgement: {
        txid: HASH_B,
        disposition: 'accepted',
        acknowledgedAt: 2_700
      }
    })

    expect(record).toMatchObject({
      phase: 'submittedObserved',
      transportAcknowledgement: { txid: HASH_B, disposition: 'accepted' }
    })
  })
})

function emptyStore(): Tm1PublicationRecoveryStore {
  const unavailable = async (): Promise<never> => {
    throw new Tm1PublicationRecoveryStoreError('RECOVERY_STORE_FAILED')
  }
  return {
    load: vi.fn().mockResolvedValue(null),
    listRecoverable: vi.fn().mockResolvedValue([]),
    create: unavailable,
    commitExecutionEvidence: unavailable,
    commitDispatchIntent: unavailable,
    commitTransportAcknowledgement: unavailable,
    commitRecoveryTransition: unavailable,
    claimOwnership: unavailable
  }
}
