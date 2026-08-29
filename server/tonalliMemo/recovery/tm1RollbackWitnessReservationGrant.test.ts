import { chmodSync, mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, test } from 'vitest'
import { createTm1InMemoryRollbackWitness } from '../../../src/integrations/tonalliMemo/recovery/tm1InMemoryRollbackWitness'
import {
  parseTm1RollbackWitnessRecord,
  parseTm1RollbackWitnessSnapshot,
  type Tm1RollbackWitness,
  type Tm1RollbackWitnessRecord,
  type Tm1RollbackWitnessReservation
} from '../../../src/integrations/tonalliMemo/recovery/tm1RollbackWitness'
import {
  establishTm1RollbackWitnessFreshness,
  provisionTm1RollbackWitness
} from './tm1RollbackWitnessAuthorityGate'
import {
  reserveTm1RollbackWitnessWithGrant,
  type Tm1RollbackWitnessReservationOutcome
} from './tm1RollbackWitnessReservationGrant'
import {
  createTm1SqlitePublicationRecoveryStore,
  type Tm1SqlitePublicationRecoveryStore
} from './tm1SqlitePublicationRecoveryStore'

const SLOT = 'account:device:tm1'
const OTHER_SLOT = 'account:device:other'
const STORE = `tm1-store:v1:${'a'.repeat(64)}`
const OTHER_STORE = `tm1-store:v1:${'b'.repeat(64)}`
const temporaryDirectories: string[] = []

afterEach(() => {
  for (const directory of temporaryDirectories.splice(0)) {
    rmSync(directory, { recursive: true, force: true })
  }
})

describe('TM1 rollback witness reservation grant fencing', () => {
  test('rejects raw, parsed and verified-read pending evidence without a grant', async () => {
    const { store } = harness()
    const witness = createTm1InMemoryRollbackWitness()
    await provision(store, witness)
    const reserved = await reserveRaw(store, witness, 'operation:raw-pending')
    const pending = reserved.pending!
    expect(await witness.verifyRecord(pending)).toBe(true)
    const before = store.inspectWitnessBinding()

    for (const input of [
      commitInput(reserved.stable.logicalRoot, pending),
      { ...commitInput(reserved.stable.logicalRoot, pending), grant: pending },
      {
        ...commitInput(reserved.stable.logicalRoot, pending),
        grant: parseTm1RollbackWitnessRecord(pending)
      }
    ]) {
      expect(() => commitUnknown(store, input)).toThrowError(
        expect.objectContaining({ code: 'WITNESS_RESERVATION_GRANT_REQUIRED' })
      )
      expect(store.inspectWitnessBinding()).toEqual(before)
    }
    store.close()
  })

  test('rejects structurally complete and copied grant lookalikes before mutation', async () => {
    const { store } = harness()
    const witness = createTm1InMemoryRollbackWitness()
    await provision(store, witness)
    const outcome = await reserveGrant(store, witness, 'operation:lookalike')
    const input = exactCommitInput(outcome)
    const before = store.inspectWitnessBinding()
    const lookalikes = [
      { ...outcome.grant },
      Object.freeze({ ...outcome.grant }),
      Object.assign(Object.create(null), outcome.grant)
    ]

    for (const grant of lookalikes) {
      expect(() => commitUnknown(store, { ...input, grant })).toThrowError(
        expect.objectContaining({ code: 'WITNESS_RESERVATION_GRANT_REQUIRED' })
      )
      expect(store.inspectWitnessBinding()).toEqual(before)
    }

    expect(store.commitReservedWitnessBinding(input)).toMatchObject({ generation: 1 })
    store.close()
  })

  test('winner grant commits exactly once and replay remains rejected', async () => {
    const { store } = harness()
    const witness = createTm1InMemoryRollbackWitness()
    await provision(store, witness)
    const outcome = await reserveGrant(store, witness, 'operation:winner')
    expect(Object.isFrozen(outcome)).toBe(true)
    expect(Object.isFrozen(outcome.observation)).toBe(true)
    expect(Object.isFrozen(outcome.grant)).toBe(true)

    expect(store.commitReservedWitnessBinding(exactCommitInput(outcome))).toMatchObject({
      generation: outcome.grant.nextGeneration,
      logicalRoot: outcome.grant.nextLogicalRoot
    })
    expect(() => store.commitReservedWitnessBinding(exactCommitInput(outcome)))
      .toThrowError(expect.objectContaining({
        code: 'WITNESS_RESERVATION_FENCE_MISMATCH'
      }))
    store.close()
  })

  test('binds every reservation identity field and leaves state unchanged on mismatch', async () => {
    const { store } = harness()
    const witness = createTm1InMemoryRollbackWitness()
    await provision(store, witness)
    const outcome = await reserveGrant(store, witness, 'operation:bound-fields')
    const pending = outcome.observation.pending
    const before = store.inspectWitnessBinding()
    const mismatches = [
      { ...exactCommitInput(outcome), expectedGeneration: 1 },
      { ...exactCommitInput(outcome), expectedLogicalRoot: '9'.repeat(64) },
      commitWithPending(outcome, { operationId: 'operation:different' }),
      commitWithPending(outcome, { receiptHash: '8'.repeat(64) }),
      commitWithPending(outcome, { previousStableReceiptHash: '7'.repeat(64) }),
      commitWithPending(outcome, { logicalRoot: '6'.repeat(64) }),
      commitWithPending(outcome, { generation: pending.generation + 1 }),
      commitWithPending(outcome, { storeId: OTHER_STORE }),
      commitWithPending(outcome, { slotId: OTHER_SLOT }),
      commitWithPending(outcome, { witnessKeyId: 'witness-key:different' }),
      commitWithPending(outcome, { authenticatedReceipt: 'different-receipt-body' })
    ]

    for (const input of mismatches) {
      expect(() => store.commitReservedWitnessBinding(input)).toThrowError(
        expect.objectContaining({ code: 'WITNESS_RESERVATION_FENCE_MISMATCH' })
      )
      expect(store.inspectWitnessBinding()).toEqual(before)
    }

    expect(store.commitReservedWitnessBinding(exactCommitInput(outcome)))
      .toMatchObject({ generation: 1 })
    store.close()
  })

  test('rejects a genuine grant bound to another slot and store', async () => {
    const canonical = harness()
    const other = harness()
    const canonicalWitness = createTm1InMemoryRollbackWitness()
    const otherWitness = createTm1InMemoryRollbackWitness('other-witness-key:v1')
    await provision(canonical.store, canonicalWitness)
    await provisionTm1RollbackWitness(
      { store: other.store, witness: otherWitness },
      {
        slotId: OTHER_SLOT,
        storeId: OTHER_STORE,
        operationId: 'operation:enroll:other'
      }
    )
    const otherGrant = await reserveGrantFor(
      other.store,
      otherWitness,
      OTHER_SLOT,
      OTHER_STORE,
      'operation:other-store'
    )
    const before = canonical.store.inspectWitnessBinding()

    expect(() => canonical.store.commitReservedWitnessBinding(
      exactCommitInput(otherGrant)
    )).toThrowError(expect.objectContaining({
      code: 'WITNESS_RESERVATION_FENCE_MISMATCH'
    }))
    expect(canonical.store.inspectWitnessBinding()).toEqual(before)
    canonical.store.close()
    other.store.close()
  })

  test('lets exactly one controller reserve and denies the loser winner-pending authority', async () => {
    const firstHarness = harness()
    const witness = createTm1InMemoryRollbackWitness()
    await provision(firstHarness.store, witness)
    const second = openStore(firstHarness.databasePath)
    const stable = parseTm1RollbackWitnessSnapshot(
      await witness.read({ slotId: SLOT })
    ).stable
    const nextRoot = firstHarness.store.computeWitnessLogicalRoot(1)
    const baseRequest = {
      slotId: SLOT,
      storeId: STORE,
      expectedStableGeneration: stable.generation,
      expectedStableLogicalRoot: stable.logicalRoot,
      expectedStableReceiptHash: stable.receiptHash,
      nextGeneration: 1,
      nextLogicalRoot: nextRoot
    }
    const results = await Promise.allSettled([
      reserveTm1RollbackWitnessWithGrant(witness, {
        ...baseRequest,
        operationId: 'operation:controller:a'
      }),
      reserveTm1RollbackWitnessWithGrant(witness, {
        ...baseRequest,
        operationId: 'operation:controller:b'
      })
    ])
    const winners = results.filter(
      (result): result is PromiseFulfilledResult<Tm1RollbackWitnessReservationOutcome> =>
        result.status === 'fulfilled'
    )
    expect(winners).toHaveLength(1)
    expect(results.filter(result => result.status === 'rejected')).toHaveLength(1)
    const winner = winners[0].value
    const observed = parseTm1RollbackWitnessSnapshot(
      await witness.read({ slotId: SLOT })
    )
    expect(await witness.verifyRecord(observed.pending!)).toBe(true)

    for (const grant of [
      observed.pending,
      { ...winner.grant },
      {
        operationId: observed.pending!.operationId,
        pendingReceiptHash: observed.pending!.receiptHash
      }
    ]) {
      expect(() => commitUnknown(second, {
        ...commitInput(stable.logicalRoot, observed.pending!),
        grant
      })).toThrowError(expect.objectContaining({
        code: 'WITNESS_RESERVATION_GRANT_REQUIRED'
      }))
      expect(second.inspectWitnessBinding()?.generation).toBe(0)
    }

    expect(firstHarness.store.commitReservedWitnessBinding(exactCommitInput(winner)))
      .toMatchObject({ generation: 1 })
    expect(() => second.commitReservedWitnessBinding(exactCommitInput(winner)))
      .toThrowError(expect.objectContaining({
        code: 'WITNESS_RESERVATION_FENCE_MISMATCH'
      }))
    firstHarness.store.close()
    second.close()
  })

  test('does not recreate a grant after reserve succeeds and the process crashes', async () => {
    const { store } = harness()
    const witness = createTm1InMemoryRollbackWitness()
    await provision(store, witness)
    await reserveGrant(store, witness, 'operation:crash-before-commit')
    const observed = parseTm1RollbackWitnessSnapshot(
      await witness.read({ slotId: SLOT })
    )
    expect(await witness.verifyRecord(observed.pending!)).toBe(true)

    expect(() => commitUnknown(store, {
      ...commitInput(observed.stable.logicalRoot, observed.pending!),
      grant: { ...observed.pending }
    })).toThrowError(expect.objectContaining({
      code: 'WITNESS_RESERVATION_GRANT_REQUIRED'
    }))
    await expect(establishTm1RollbackWitnessFreshness(
      { store, witness },
      { slotId: SLOT }
    )).rejects.toMatchObject({ code: 'WITNESS_PENDING_QUARANTINE' })
    expect(store.inspectWitnessBinding()?.generation).toBe(0)
    expect(witness.inspect(SLOT)?.pending).toEqual(observed.pending)
    store.close()
  })

  test('finalizes after committed DB recovery without reconstructing the grant', async () => {
    const { store } = harness()
    const witness = createTm1InMemoryRollbackWitness()
    await provision(store, witness)
    const outcome = await reserveGrant(store, witness, 'operation:crash-after-commit')
    store.commitReservedWitnessBinding(exactCommitInput(outcome))

    await expect(establishTm1RollbackWitnessFreshness(
      { store, witness },
      { slotId: SLOT }
    )).resolves.toMatchObject({ generation: 1, logicalRoot: outcome.grant.nextLogicalRoot })
    expect(witness.inspect(SLOT)?.pending).toBeNull()
    expect(witness.inspect(SLOT)?.stable.generation).toBe(1)
    store.close()
  })

  test('does not issue a grant from structurally valid but unauthenticated reserve output', async () => {
    const { store } = harness()
    const witness = createTm1InMemoryRollbackWitness()
    await provision(store, witness)
    const request = reservationRequest(store, witness, SLOT, STORE, 'operation:unverified')
    const untrusted = proxyWitness(witness, { verifyRecord: async () => false })

    await expect(reserveTm1RollbackWitnessWithGrant(untrusted, await request))
      .rejects.toMatchObject({ code: 'WITNESS_UNVERIFIABLE' })
    expect(store.inspectWitnessBinding()?.generation).toBe(0)
    store.close()
  })
})

function harness(): {
  store: Tm1SqlitePublicationRecoveryStore
  databasePath: string
} {
  const directory = mkdtempSync(join(tmpdir(), 'tm1-reservation-grant-'))
  chmodSync(directory, 0o700)
  temporaryDirectories.push(directory)
  const databasePath = join(directory, 'tm1.sqlite')
  return { store: openStore(databasePath), databasePath }
}

function openStore(databasePath: string): Tm1SqlitePublicationRecoveryStore {
  return createTm1SqlitePublicationRecoveryStore({ databasePath, now: () => 1_000 })
}

async function provision(
  store: Tm1SqlitePublicationRecoveryStore,
  witness: Tm1RollbackWitness
): Promise<void> {
  await provisionTm1RollbackWitness(
    { store, witness },
    { slotId: SLOT, storeId: STORE, operationId: 'operation:enroll' }
  )
}

async function reserveRaw(
  store: Tm1SqlitePublicationRecoveryStore,
  witness: Tm1RollbackWitness,
  operationId: string
) {
  return parseTm1RollbackWitnessSnapshot(await witness.reserve(
    await reservationRequest(store, witness, SLOT, STORE, operationId)
  ))
}

async function reserveGrant(
  store: Tm1SqlitePublicationRecoveryStore,
  witness: Tm1RollbackWitness,
  operationId: string
): Promise<Tm1RollbackWitnessReservationOutcome> {
  return reserveGrantFor(store, witness, SLOT, STORE, operationId)
}

async function reserveGrantFor(
  store: Tm1SqlitePublicationRecoveryStore,
  witness: Tm1RollbackWitness,
  slotId: string,
  storeId: string,
  operationId: string
): Promise<Tm1RollbackWitnessReservationOutcome> {
  return reserveTm1RollbackWitnessWithGrant(
    witness,
    await reservationRequest(store, witness, slotId, storeId, operationId)
  )
}

async function reservationRequest(
  store: Tm1SqlitePublicationRecoveryStore,
  witness: Tm1RollbackWitness,
  slotId: string,
  storeId: string,
  operationId: string
): Promise<Tm1RollbackWitnessReservation> {
  const stable = parseTm1RollbackWitnessSnapshot(
    await witness.read({ slotId })
  ).stable
  return {
    slotId,
    storeId,
    expectedStableGeneration: stable.generation,
    expectedStableLogicalRoot: stable.logicalRoot,
    expectedStableReceiptHash: stable.receiptHash,
    nextGeneration: stable.generation + 1,
    nextLogicalRoot: store.computeWitnessLogicalRoot(stable.generation + 1),
    operationId
  }
}

function exactCommitInput(outcome: Tm1RollbackWitnessReservationOutcome) {
  return {
    expectedGeneration: outcome.grant.previousStableGeneration,
    expectedLogicalRoot: outcome.grant.previousStableLogicalRoot,
    pendingRecord: outcome.observation.pending,
    grant: outcome.grant
  }
}

function commitInput(
  expectedLogicalRoot: string,
  pendingRecord: Tm1RollbackWitnessRecord
) {
  return { expectedGeneration: 0, expectedLogicalRoot, pendingRecord }
}

function commitWithPending(
  outcome: Tm1RollbackWitnessReservationOutcome,
  overrides: Partial<Tm1RollbackWitnessRecord>
) {
  return {
    ...exactCommitInput(outcome),
    pendingRecord: parseTm1RollbackWitnessRecord({
      ...outcome.observation.pending,
      ...overrides
    })
  }
}

function commitUnknown(
  store: Tm1SqlitePublicationRecoveryStore,
  input: unknown
): unknown {
  return (store.commitReservedWitnessBinding as (value: unknown) => unknown)(input)
}

function proxyWitness(
  base: Tm1RollbackWitness,
  overrides: Partial<Tm1RollbackWitness>
): Tm1RollbackWitness {
  return {
    read: overrides.read?.bind(overrides) ?? base.read.bind(base),
    enroll: overrides.enroll?.bind(overrides) ?? base.enroll.bind(base),
    reserve: overrides.reserve?.bind(overrides) ?? base.reserve.bind(base),
    finalize: overrides.finalize?.bind(overrides) ?? base.finalize.bind(base),
    verifyRecord: overrides.verifyRecord?.bind(overrides) ?? base.verifyRecord.bind(base)
  }
}
