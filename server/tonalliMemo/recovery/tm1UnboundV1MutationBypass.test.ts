import { chmodSync, copyFileSync, mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import { afterEach, describe, expect, test } from 'vitest'
import type { Tm1PublicationRecoveryRecord } from '../../../src/integrations/tonalliMemo/recovery/tm1PublicationRecoveryModel'
import { createTm1InMemoryRollbackWitness } from '../../../src/integrations/tonalliMemo/recovery/tm1InMemoryRollbackWitness'
import { parseTm1RollbackWitnessSnapshot } from '../../../src/integrations/tonalliMemo/recovery/tm1RollbackWitness'
import {
  establishTm1RollbackWitnessFreshness,
  provisionTm1RollbackWitness
} from './tm1RollbackWitnessAuthorityGate'
import { reserveTm1RollbackWitnessWithGrant } from './tm1RollbackWitnessReservationGrant'
import {
  createTm1SqlitePublicationRecoveryStore,
  type Tm1SqlitePublicationRecoveryStore
} from './tm1SqlitePublicationRecoveryStore'
import {
  canonicalizeTm1RecoveryRecord,
  consumedCapabilityEvidenceRows
} from './tm1SqliteSchema'
import {
  HASH_B,
  HASH_C,
  absentObservationRecord,
  broadcastConsumedRecord,
  outcomeUnknownRecord,
  preparedRecord,
  signingPendingRecord
} from './tm1SqliteTestFixtures'

const SLOT = 'account:device:tm1'
const STORE = `tm1-store:v1:${'a'.repeat(64)}`
const temporaryDirectories: string[] = []

type MutationCase = Readonly<{
  label: string
  seed: Tm1PublicationRecoveryRecord | null
  invoke: (store: Tm1SqlitePublicationRecoveryStore) => Promise<unknown>
}>

const MUTATION_CASES: readonly MutationCase[] = Object.freeze([
  {
    label: 'create',
    seed: null,
    invoke: store => store.create({ record: preparedRecord() })
  },
  {
    label: 'commitExecutionEvidence',
    seed: preparedRecord(),
    invoke: store => store.commitExecutionEvidence({
      publicationId: preparedRecord().publicationId,
      expectedRevision: preparedRecord().revision,
      expectedOwnerEpoch: preparedRecord().ownerEpoch,
      nextRecord: signingPendingRecord(),
      newlyConsumedCapabilityIds: []
    })
  },
  {
    label: 'commitDispatchIntent',
    seed: broadcastConsumedRecord(),
    invoke: store => store.commitDispatchIntent({
      publicationId: broadcastConsumedRecord().publicationId,
      expectedRevision: broadcastConsumedRecord().revision,
      expectedOwnerEpoch: broadcastConsumedRecord().ownerEpoch,
      nextRecord: outcomeUnknownRecord()
    })
  },
  {
    label: 'commitTransportAcknowledgement',
    seed: outcomeUnknownRecord(),
    invoke: store => {
      const current = outcomeUnknownRecord()
      return store.commitTransportAcknowledgement({
        publicationId: current.publicationId,
        expectedRevision: current.revision,
        expectedOwnerEpoch: current.ownerEpoch,
        acknowledgement: {
          submissionId: current.dispatchIntent!.submissionId,
          signedId: current.signed!.signedId,
          txid: HASH_B,
          signedArtifactHash: HASH_C,
          disposition: 'accepted',
          acknowledgedAt: current.dispatchIntent!.committedAt
        }
      })
    }
  },
  {
    label: 'commitRecoveryTransition',
    seed: outcomeUnknownRecord(),
    invoke: store => {
      const current = outcomeUnknownRecord()
      return store.commitRecoveryTransition({
        publicationId: current.publicationId,
        expectedRevision: current.revision,
        expectedOwnerEpoch: current.ownerEpoch,
        nextRecord: absentObservationRecord(current)
      })
    }
  },
  {
    label: 'claimOwnership',
    seed: preparedRecord(),
    invoke: store => store.claimOwnership({
      publicationId: preparedRecord().publicationId,
      expectedRevision: preparedRecord().revision,
      expectedOwnerEpoch: preparedRecord().ownerEpoch,
      nextOwnerEpoch: 1
    })
  }
])

afterEach(() => {
  for (const directory of temporaryDirectories.splice(0)) {
    rmSync(directory, { recursive: true, force: true })
  }
})

describe('TM1 unbound schema-v1 mutation authority', () => {
  test.each(MUTATION_CASES)(
    'fresh unbound v1 rejects $label without changing durable state',
    async ({ seed, invoke }) => {
      const databasePath = initializeV1(seed)
      const store = openStore(databasePath)
      const before = physicalSnapshot(databasePath)

      await expect(invoke(store)).rejects.toMatchObject({
        code: 'ROLLBACK_WITNESS_REQUIRED'
      })
      expect(physicalSnapshot(databasePath)).toEqual(before)
      store.close()
    }
  )

  test.each(MUTATION_CASES)(
    'restored pre-enrollment v1 rejects $label without regaining authority',
    async ({ seed, invoke }) => {
      const databasePath = await restoredV1Fixture(seed)
      const store = openStore(databasePath)
      const before = physicalSnapshot(databasePath)

      await expect(invoke(store)).rejects.toMatchObject({
        code: 'ROLLBACK_WITNESS_REQUIRED'
      })
      expect(physicalSnapshot(databasePath)).toEqual(before)
      store.close()
    }
  )

  test('keeps unbound v1 read-only inspection available without implicit enrollment', async () => {
    const record = preparedRecord()
    const databasePath = initializeV1(record)
    const store = openStore(databasePath)
    const witness = createTm1InMemoryRollbackWitness()
    const before = physicalSnapshot(databasePath)

    expect(store.inspectDurability()).toMatchObject({ journalMode: 'wal', synchronous: 2 })
    await expect(store.load(record.publicationId)).resolves.toEqual(record)
    await expect(store.listRecoverable()).resolves.toEqual([record])
    expect(store.inspectWitnessBinding()).toBeNull()
    expect(store.computeEnrollmentLogicalRoot({ slotId: SLOT, storeId: STORE }))
      .toMatch(/^[0-9a-f]{64}$/)
    await expect(establishTm1RollbackWitnessFreshness(
      { store },
      { slotId: SLOT }
    )).rejects.toMatchObject({ code: 'WITNESS_NOT_CONFIGURED' })
    await expect(establishTm1RollbackWitnessFreshness(
      { store, witness },
      { slotId: SLOT }
    )).rejects.toMatchObject({ code: 'WITNESS_NOT_ENROLLED' })
    expect(witness.inspect(SLOT)).toBeNull()
    expect(store.inspectWitnessBinding()).toBeNull()
    expect(physicalSnapshot(databasePath)).toEqual(before)
    store.close()
  })

  test('classifies a restored v1 with its remote witness as enrollment recovery', async () => {
    const { databasePath, witness } = await restoredV1WithWitness(preparedRecord())
    const store = openStore(databasePath)
    const before = physicalSnapshot(databasePath)

    await expect(establishTm1RollbackWitnessFreshness(
      { store, witness },
      { slotId: SLOT }
    )).rejects.toMatchObject({ code: 'ENROLLMENT_RECOVERY_REQUIRED' })
    expect(store.inspectWitnessBinding()).toBeNull()
    expect(physicalSnapshot(databasePath)).toEqual(before)
    store.close()
  })

  test('allows explicit provisioning but never turns enrollment into legacy authority', async () => {
    const databasePath = initializeV1(preparedRecord())
    const store = openStore(databasePath)
    const witness = createTm1InMemoryRollbackWitness()

    await expect(provisionTm1RollbackWitness(
      { store, witness },
      { slotId: SLOT, storeId: STORE, operationId: 'operation:enroll' }
    )).resolves.toMatchObject({ generation: 0, slotId: SLOT, storeId: STORE })
    expect(store.inspectWitnessBinding()).toMatchObject({ generation: 0, storeId: STORE })
    const before = physicalSnapshot(databasePath)

    for (const mutation of MUTATION_CASES) {
      await expect(mutation.invoke(store)).rejects.toMatchObject({
        code: 'ROLLBACK_WITNESS_REQUIRED'
      })
      expect(physicalSnapshot(databasePath)).toEqual(before)
    }
    store.close()
  })

  test('keeps the exact CAS-winner reserved binding commit single-use', async () => {
    const databasePath = initializeV1(null)
    const store = openStore(databasePath)
    const witness = createTm1InMemoryRollbackWitness()
    await provisionTm1RollbackWitness(
      { store, witness },
      { slotId: SLOT, storeId: STORE, operationId: 'operation:enroll' }
    )
    const stable = parseTm1RollbackWitnessSnapshot(
      await witness.read({ slotId: SLOT })
    ).stable
    const nextLogicalRoot = store.computeWitnessLogicalRoot(1)
    const outcome = await reserveTm1RollbackWitnessWithGrant(witness, {
      slotId: SLOT,
      storeId: STORE,
      expectedStableGeneration: stable.generation,
      expectedStableLogicalRoot: stable.logicalRoot,
      expectedStableReceiptHash: stable.receiptHash,
      nextGeneration: 1,
      nextLogicalRoot,
      operationId: 'operation:generation:1'
    })
    const commit = {
      expectedGeneration: outcome.grant.previousStableGeneration,
      expectedLogicalRoot: outcome.grant.previousStableLogicalRoot,
      pendingRecord: outcome.observation.pending,
      grant: outcome.grant
    }

    expect(store.commitReservedWitnessBinding(commit)).toMatchObject({
      generation: 1,
      logicalRoot: nextLogicalRoot
    })
    expect(() => store.commitReservedWitnessBinding(commit)).toThrowError(
      expect.objectContaining({ code: 'WITNESS_RESERVATION_FENCE_MISMATCH' })
    )
    store.close()
  })
})

function initializeV1(seed: Tm1PublicationRecoveryRecord | null): string {
  const directory = mkdtempSync(join(tmpdir(), 'tm1-unbound-v1-'))
  chmodSync(directory, 0o700)
  temporaryDirectories.push(directory)
  const databasePath = join(directory, 'tm1.sqlite')
  const store = openStore(databasePath)
  store.close()
  if (seed !== null) seedV1(databasePath, seed)
  return databasePath
}

async function restoredV1Fixture(
  seed: Tm1PublicationRecoveryRecord | null
): Promise<string> {
  return (await restoredV1WithWitness(seed)).databasePath
}

async function restoredV1WithWitness(
  seed: Tm1PublicationRecoveryRecord | null
): Promise<Readonly<{
  databasePath: string
  witness: ReturnType<typeof createTm1InMemoryRollbackWitness>
}>> {
  const databasePath = initializeV1(seed)
  const backupPath = join(databasePath.slice(0, databasePath.lastIndexOf('/')), 'v1.sqlite')
  copyFileSync(databasePath, backupPath)
  chmodSync(backupPath, 0o600)

  const live = openStore(databasePath)
  const witness = createTm1InMemoryRollbackWitness()
  await provisionTm1RollbackWitness(
    { store: live, witness },
    { slotId: SLOT, storeId: STORE, operationId: 'operation:enroll' }
  )
  expect(live.inspectWitnessBinding()).toMatchObject({ generation: 0, storeId: STORE })
  live.close()

  rmSync(`${databasePath}-wal`, { force: true })
  rmSync(`${databasePath}-shm`, { force: true })
  copyFileSync(backupPath, databasePath)
  chmodSync(databasePath, 0o600)
  return Object.freeze({ databasePath, witness })
}

function openStore(databasePath: string): Tm1SqlitePublicationRecoveryStore {
  return createTm1SqlitePublicationRecoveryStore({ databasePath, now: () => 1_000 })
}

function seedV1(databasePath: string, record: Tm1PublicationRecoveryRecord): void {
  const canonical = canonicalizeTm1RecoveryRecord(record)
  const mirrors = canonical.mirrors
  const database = new DatabaseSync(databasePath, { allowExtension: false })
  database.exec('PRAGMA foreign_keys = ON')
  database.exec('BEGIN IMMEDIATE')
  try {
    database.prepare(`
      INSERT INTO tm1_publications (
        publication_id, domain_schema, domain_schema_version, revision,
        owner_epoch, phase, record_json, record_sha256, prepared_id,
        binding_hash, signed_id, txid, signed_artifact_hash,
        broadcast_consumed_at, dispatch_submission_id,
        dispatch_capability_id, dispatch_committed_at, ack_txid,
        acknowledged_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
      mirrors.publicationId,
      mirrors.domainSchema,
      mirrors.domainSchemaVersion,
      mirrors.revision,
      mirrors.ownerEpoch,
      mirrors.phase,
      canonical.recordJson,
      canonical.recordSha256,
      mirrors.preparedId,
      mirrors.bindingHash,
      mirrors.signedId,
      mirrors.txid,
      mirrors.signedArtifactHash,
      mirrors.broadcastConsumedAt,
      mirrors.dispatchSubmissionId,
      mirrors.dispatchCapabilityId,
      mirrors.dispatchCommittedAt,
      mirrors.ackTxid,
      mirrors.acknowledgedAt
    )
    const insertCapability = database.prepare(`
      INSERT INTO tm1_consumed_capabilities (
        capability_id, publication_id, kind, operation_id, content_hash,
        consumed_at, expires_at, prepared_id, binding_hash, signed_id,
        txid, signed_artifact_hash
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `)
    for (const row of consumedCapabilityEvidenceRows(canonical.record)) {
      insertCapability.run(
        row.capabilityId,
        row.publicationId,
        row.kind,
        row.operationId,
        row.contentHash,
        row.consumedAt,
        row.expiresAt,
        row.preparedId,
        row.bindingHash,
        row.signedId,
        row.txid,
        row.signedArtifactHash
      )
    }
    database.exec('COMMIT')
    database.exec('PRAGMA wal_checkpoint(TRUNCATE)')
  } catch (error) {
    if (database.isTransaction) database.exec('ROLLBACK')
    throw error
  } finally {
    database.close()
  }
}

function physicalSnapshot(databasePath: string): string {
  const database = new DatabaseSync(databasePath, { allowExtension: false })
  try {
    const hasWitnessBinding = database.prepare(`
      SELECT 1 AS present
      FROM sqlite_schema
      WHERE type = 'table' AND name = 'tm1_witness_binding'
    `).get()?.present === 1
    return JSON.stringify({
      userVersion: database.prepare('PRAGMA user_version').get(),
      metadata: database.prepare(
        'SELECT * FROM tm1_store_metadata ORDER BY singleton_id'
      ).all(),
      publications: database.prepare(
        'SELECT * FROM tm1_publications ORDER BY publication_id'
      ).all(),
      capabilities: database.prepare(
        'SELECT * FROM tm1_consumed_capabilities ORDER BY capability_id'
      ).all(),
      witnessBinding: hasWitnessBinding
        ? database.prepare(
            'SELECT * FROM tm1_witness_binding ORDER BY singleton_id'
          ).all()
        : []
    })
  } finally {
    database.close()
  }
}
