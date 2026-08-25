import { chmodSync, mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import { afterEach, describe, expect, test } from 'vitest'
import { createTm1InMemoryRollbackWitness } from '../../../src/integrations/tonalliMemo/recovery/tm1InMemoryRollbackWitness'
import { parseTm1RollbackWitnessSnapshot } from '../../../src/integrations/tonalliMemo/recovery/tm1RollbackWitness'
import { inspectTm1SqliteSchema } from './tm1SqliteMigrations'
import {
  createTm1SqlitePublicationRecoveryStore,
  type Tm1SqlitePublicationRecoveryStore
} from './tm1SqlitePublicationRecoveryStore'
import {
  outcomeUnknownRecord,
  preparedRecord,
  signingConsumedRecord,
  signingPendingRecord
} from './tm1SqliteTestFixtures'

const SLOT = 'account:device:tm1'
const STORE = `tm1-store:v1:${'a'.repeat(64)}`
const temporaryDirectories: string[] = []

afterEach(() => {
  for (const directory of temporaryDirectories.splice(0)) {
    rmSync(directory, { recursive: true, force: true })
  }
})

describe('TM1 SQLite rollback-witness binding and logical root', () => {
  test('explicitly enrolls and reopens one canonical v2 store identity', async () => {
    const { store, databasePath } = harness()
    await store.create({ record: preparedRecord() })
    const logicalRoot = store.computeEnrollmentLogicalRoot({
      slotId: SLOT,
      storeId: STORE
    })

    expect(store.enrollWitnessBinding({
      slotId: SLOT,
      storeId: STORE,
      logicalRoot
    })).toEqual({
      witnessProtocolVersion: 1,
      logicalRootSchemaVersion: 1,
      slotId: SLOT,
      storeId: STORE,
      generation: 0,
      logicalRoot
    })
    expect(store.inspectWitnessBinding()).toMatchObject({
      storeId: STORE,
      generation: 0,
      logicalRoot
    })
    store.close()

    const raw = new DatabaseSync(databasePath, { allowExtension: false })
    expect(inspectTm1SqliteSchema(raw)).toBe('v2')
    raw.close()

    const reopened = openStore(databasePath)
    expect(reopened.inspectWitnessBinding()).toMatchObject({
      slotId: SLOT,
      storeId: STORE,
      generation: 0,
      logicalRoot
    })
    await expect(reopened.load('publication:one')).resolves.toEqual(preparedRecord())
    reopened.close()
  })

  test('blocks every legacy mutation after enrollment while preserving reads', async () => {
    const { store } = harness()
    const record = preparedRecord()
    await store.create({ record })
    enroll(store)

    await expect(store.create({
      record: preparedRecord({ publicationId: 'publication:two' })
    })).rejects.toMatchObject({ code: 'ROLLBACK_WITNESS_REQUIRED' })
    await expect(store.claimOwnership({
      publicationId: record.publicationId,
      expectedRevision: record.revision,
      expectedOwnerEpoch: record.ownerEpoch,
      nextOwnerEpoch: 1
    })).rejects.toMatchObject({ code: 'ROLLBACK_WITNESS_REQUIRED' })
    await expect(store.load(record.publicationId)).resolves.toEqual(record)
    await expect(store.listRecoverable()).resolves.toEqual([record])
    store.close()
  })

  test('computes the same root across calls, ANALYZE, VACUUM and reopen', async () => {
    const { store, databasePath } = harness()
    await store.create({ record: outcomeUnknownRecord() })
    const before = store.computeEnrollmentLogicalRoot({ slotId: SLOT, storeId: STORE })
    expect(store.computeEnrollmentLogicalRoot({ slotId: SLOT, storeId: STORE }))
      .toBe(before)
    store.close()

    const maintenance = new DatabaseSync(databasePath, { allowExtension: false })
    maintenance.exec('ANALYZE')
    maintenance.exec('VACUUM')
    maintenance.close()

    const reopened = openStore(databasePath)
    expect(reopened.computeEnrollmentLogicalRoot({ slotId: SLOT, storeId: STORE }))
      .toBe(before)
    reopened.close()
  })

  test('changes the root for publications, capability consumption and ownership', async () => {
    const { store } = harness()
    const empty = store.computeEnrollmentLogicalRoot({ slotId: SLOT, storeId: STORE })
    const prepared = preparedRecord()
    await store.create({ record: prepared })
    const afterCreate = store.computeEnrollmentLogicalRoot({ slotId: SLOT, storeId: STORE })

    const pending = signingPendingRecord()
    await store.commitExecutionEvidence({
      publicationId: prepared.publicationId,
      expectedRevision: prepared.revision,
      expectedOwnerEpoch: prepared.ownerEpoch,
      nextRecord: pending,
      newlyConsumedCapabilityIds: []
    })
    const consumed = signingConsumedRecord()
    await store.commitExecutionEvidence({
      publicationId: pending.publicationId,
      expectedRevision: pending.revision,
      expectedOwnerEpoch: pending.ownerEpoch,
      nextRecord: consumed,
      newlyConsumedCapabilityIds: [consumed.signingAuthorization!.capabilityId]
    })
    const afterCapability = store.computeEnrollmentLogicalRoot({
      slotId: SLOT,
      storeId: STORE
    })

    await store.claimOwnership({
      publicationId: consumed.publicationId,
      expectedRevision: consumed.revision,
      expectedOwnerEpoch: consumed.ownerEpoch,
      nextOwnerEpoch: 1
    })
    const afterOwnership = store.computeEnrollmentLogicalRoot({
      slotId: SLOT,
      storeId: STORE
    })

    expect(new Set([empty, afterCreate, afterCapability, afterOwnership]).size).toBe(4)
    store.close()
  })

  test('changes the root when durable dispatch evidence is committed', async () => {
    const { store } = harness()
    const current = outcomeUnknownRecord()
    const preDispatch = {
      ...current,
      revision: current.revision - 1,
      phase: 'preDispatch' as const,
      preDispatchStage: 'broadcastAuthorizationConsumed' as const,
      dispatchIntent: null
    }
    await store.create({ record: preDispatch })
    const before = store.computeEnrollmentLogicalRoot({ slotId: SLOT, storeId: STORE })
    await store.commitDispatchIntent({
      publicationId: current.publicationId,
      expectedRevision: preDispatch.revision,
      expectedOwnerEpoch: preDispatch.ownerEpoch,
      nextRecord: current
    })
    expect(store.computeEnrollmentLogicalRoot({ slotId: SLOT, storeId: STORE }))
      .not.toBe(before)
    store.close()
  })

  test('commits only the exact matching pending witness generation', async () => {
    const { store } = harness()
    const witness = createTm1InMemoryRollbackWitness()
    const root0 = store.computeEnrollmentLogicalRoot({ slotId: SLOT, storeId: STORE })
    const enrolled = parseTm1RollbackWitnessSnapshot(await witness.enroll({
      slotId: SLOT,
      storeId: STORE,
      logicalRoot: root0,
      operationId: 'operation:enroll'
    }))
    store.enrollWitnessBinding({ slotId: SLOT, storeId: STORE, logicalRoot: root0 })
    const root1 = store.computeWitnessLogicalRoot(1)
    const reserved = parseTm1RollbackWitnessSnapshot(await witness.reserve({
      slotId: SLOT,
      storeId: STORE,
      expectedStableGeneration: 0,
      expectedStableLogicalRoot: root0,
      expectedStableReceiptHash: enrolled.stable.receiptHash,
      nextGeneration: 1,
      nextLogicalRoot: root1,
      operationId: 'operation:advance'
    }))

    expect(store.commitReservedWitnessBinding({
      expectedGeneration: 0,
      expectedLogicalRoot: root0,
      pendingRecord: reserved.pending!
    })).toMatchObject({ generation: 1, logicalRoot: root1 })
    expect(() => store.commitReservedWitnessBinding({
      expectedGeneration: 0,
      expectedLogicalRoot: root0,
      pendingRecord: reserved.pending!
    })).toThrowError(expect.objectContaining({ code: 'RECOVERY_STORE_FAILED' }))
    store.close()
  })

  test('rejects a substituted storeId even when it remains syntactically valid', () => {
    const { store, databasePath } = harness()
    enroll(store)
    store.close()
    const raw = new DatabaseSync(databasePath, { allowExtension: false })
    raw.prepare(`
      UPDATE tm1_witness_binding
      SET store_id = ?
      WHERE singleton_id = 1
    `).run(`tm1-store:v1:${'b'.repeat(64)}`)
    raw.close()

    expect(() => openStore(databasePath)).toThrowError(
      expect.objectContaining({ code: 'RECOVERY_STORE_FAILED' })
    )
  })
})

function harness(): {
  store: Tm1SqlitePublicationRecoveryStore
  databasePath: string
} {
  const directory = mkdtempSync(join(tmpdir(), 'tm1-witness-store-'))
  chmodSync(directory, 0o700)
  temporaryDirectories.push(directory)
  const databasePath = join(directory, 'tm1.sqlite')
  return { store: openStore(databasePath), databasePath }
}

function openStore(databasePath: string): Tm1SqlitePublicationRecoveryStore {
  return createTm1SqlitePublicationRecoveryStore({
    databasePath,
    now: () => 1_000
  })
}

function enroll(store: Tm1SqlitePublicationRecoveryStore): void {
  const logicalRoot = store.computeEnrollmentLogicalRoot({ slotId: SLOT, storeId: STORE })
  store.enrollWitnessBinding({ slotId: SLOT, storeId: STORE, logicalRoot })
}
