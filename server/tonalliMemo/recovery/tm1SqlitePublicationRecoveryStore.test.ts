import { chmodSync, mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import { afterEach, describe, expect, test } from 'vitest'
import type { Tm1PublicationRecoveryRecord } from '../../../src/integrations/tonalliMemo/recovery/tm1PublicationRecoveryModel'
import {
  canonicalizeTm1RecoveryRecord,
  sha256Hex
} from './tm1SqliteSchema'
import {
  createTm1SqlitePublicationRecoveryStore,
  type Tm1SqlitePublicationRecoveryStore
} from './tm1SqlitePublicationRecoveryStore'
import {
  HASH_B,
  HASH_C,
  absentObservationRecord,
  abandonedRecord,
  broadcastConsumedRecord,
  outcomeUnknownRecord,
  preparedRecord,
  signingConsumedRecord,
  signingPendingRecord
} from './tm1SqliteTestFixtures'

const temporaryDirectories: string[] = []

afterEach(() => {
  for (const directory of temporaryDirectories.splice(0)) {
    rmSync(directory, { recursive: true, force: true })
  }
})

describe('TM1 Node SQLite recovery store', () => {
  test('creates a real WAL/FULL store with the required connection policy', () => {
    const { store } = harness({ busyTimeoutMs: 321 })

    expect(store.inspectDurability()).toEqual({
      sqliteVersion: process.versions.sqlite,
      journalMode: 'wal',
      synchronous: 2,
      foreignKeys: 1,
      trustedSchema: 0,
      busyTimeoutMs: 321
    })
    store.close()
  })

  test('round-trips validated records as defensive frozen snapshots', async () => {
    const { store } = harness()
    const original = preparedRecord()

    const created = await store.create({ record: original }) as Tm1PublicationRecoveryRecord
    const loaded = await store.load(original.publicationId) as Tm1PublicationRecoveryRecord

    expect(loaded).toEqual(original)
    expect(created).toEqual(original)
    expect(Object.isFrozen(loaded)).toBe(true)
    expect(Object.isFrozen(loaded.prepared)).toBe(true)
    expect(await store.load('publication:missing')).toBeNull()
    store.close()
  })

  test('canonical serialization is stable across caller property order', () => {
    const original = outcomeUnknownRecord()
    const reordered: Record<string, unknown> = Object.fromEntries(
      Object.entries(original).reverse()
    )
    reordered.prepared = Object.fromEntries(Object.entries(original.prepared!).reverse())
    reordered.dispatchIntent = Object.fromEntries(
      Object.entries(original.dispatchIntent!).reverse()
    )

    const first = canonicalizeTm1RecoveryRecord(original)
    const second = canonicalizeTm1RecoveryRecord(reordered)

    expect(second.recordJson).toBe(first.recordJson)
    expect(second.recordSha256).toBe(first.recordSha256)
    expect(first.recordJson).toBe(canonicalizeTm1RecoveryRecord(JSON.parse(first.recordJson)).recordJson)
  })

  test('lists only recoverable records in stable publication order', async () => {
    const { store } = harness()
    const later = preparedRecord({ publicationId: 'publication:z' })
    const earlier = outcomeUnknownRecord({
      publicationId: 'publication:a',
      signingCapabilityId: 'capability:sign:a',
      broadcastCapabilityId: 'capability:broadcast:a'
    })
    const terminalBase = preparedRecord({ publicationId: 'publication:terminal' })

    await store.create({ record: later })
    await store.create({ record: abandonedRecord(terminalBase) })
    await store.create({ record: earlier })

    const listed = await store.listRecoverable() as readonly Tm1PublicationRecoveryRecord[]
    expect(listed.map(record => record.publicationId)).toEqual([
      'publication:a',
      'publication:z'
    ])
    expect(Object.isFrozen(listed)).toBe(true)
    store.close()
  })

  test('rejects duplicate publication IDs without replacing the record', async () => {
    const { store } = harness()
    const record = preparedRecord()
    await store.create({ record })

    await expect(store.create({ record })).rejects.toMatchObject({
      code: 'DUPLICATE_PUBLICATION_ID'
    })
    await expect(store.load(record.publicationId)).resolves.toEqual(record)
    store.close()
  })

  test('enforces globally unique consumed SIGN capability IDs', async () => {
    const { store } = harness()
    const first = signingConsumedRecord({ publicationId: 'publication:first' })
    const second = signingConsumedRecord({ publicationId: 'publication:second' })
    await store.create({ record: first })

    await expect(store.create({ record: second })).rejects.toMatchObject({
      code: 'DUPLICATE_CAPABILITY_CONSUMPTION'
    })
    await expect(store.load(second.publicationId)).resolves.toBeNull()
    store.close()
  })

  test('enforces globally unique consumed BROADCAST capability IDs', async () => {
    const { store } = harness()
    const first = broadcastConsumedRecord({
      publicationId: 'publication:first',
      signingCapabilityId: 'capability:sign:first'
    })
    const second = broadcastConsumedRecord({
      publicationId: 'publication:second',
      signingCapabilityId: 'capability:sign:second'
    })
    await store.create({ record: first })

    await expect(store.create({ record: second })).rejects.toMatchObject({
      code: 'DUPLICATE_CAPABILITY_CONSUMPTION'
    })
    await expect(store.load(second.publicationId)).resolves.toBeNull()
    store.close()
  })

  test('atomically commits execution evidence and capability consumption', async () => {
    const { store } = harness()
    const prepared = preparedRecord()
    const pending = signingPendingRecord()
    const consumed = signingConsumedRecord()
    await store.create({ record: prepared })

    await expect(store.commitExecutionEvidence({
      publicationId: prepared.publicationId,
      expectedRevision: prepared.revision,
      expectedOwnerEpoch: prepared.ownerEpoch,
      nextRecord: pending,
      newlyConsumedCapabilityIds: []
    })).resolves.toEqual(pending)
    await expect(store.commitExecutionEvidence({
      publicationId: pending.publicationId,
      expectedRevision: pending.revision,
      expectedOwnerEpoch: pending.ownerEpoch,
      nextRecord: consumed,
      newlyConsumedCapabilityIds: ['capability:sign:one']
    })).resolves.toEqual(consumed)
    store.close()
  })

  test('rolls back when declared capability evidence does not match the record', async () => {
    const { store } = harness()
    const pending = signingPendingRecord()
    const consumed = signingConsumedRecord()
    await store.create({ record: pending })

    await expect(store.commitExecutionEvidence({
      publicationId: pending.publicationId,
      expectedRevision: pending.revision,
      expectedOwnerEpoch: pending.ownerEpoch,
      nextRecord: consumed,
      newlyConsumedCapabilityIds: []
    })).rejects.toMatchObject({ code: 'RECOVERY_STORE_FAILED' })
    await expect(store.load(pending.publicationId)).resolves.toEqual(pending)
    store.close()
  })

  test('rejects stale revision and stale ownerEpoch independently', async () => {
    const { store } = harness()
    const record = preparedRecord({ ownerEpoch: 4 })
    await store.create({ record })

    await expect(store.claimOwnership({
      publicationId: record.publicationId,
      expectedRevision: record.revision + 1,
      expectedOwnerEpoch: record.ownerEpoch,
      nextOwnerEpoch: 5
    })).rejects.toMatchObject({ code: 'REVISION_MISMATCH' })
    await expect(store.claimOwnership({
      publicationId: record.publicationId,
      expectedRevision: record.revision,
      expectedOwnerEpoch: record.ownerEpoch - 1,
      nextOwnerEpoch: 5
    })).rejects.toMatchObject({ code: 'STALE_OWNER_EPOCH' })
    store.close()
  })

  test('claimOwnership atomically advances revision and ownerEpoch', async () => {
    const { store } = harness()
    const record = preparedRecord()
    await store.create({ record })

    const claimed = await store.claimOwnership({
      publicationId: record.publicationId,
      expectedRevision: record.revision,
      expectedOwnerEpoch: record.ownerEpoch,
      nextOwnerEpoch: 7
    }) as Tm1PublicationRecoveryRecord

    expect(claimed.revision).toBe(record.revision + 1)
    expect(claimed.ownerEpoch).toBe(7)
    expect(await store.load(record.publicationId)).toEqual(claimed)
    store.close()
  })

  test('rejects invalid domain transitions without mutation', async () => {
    const { store } = harness()
    const record = preparedRecord()
    const invalid = signingConsumedRecord()
    await store.create({ record })

    await expect(store.commitExecutionEvidence({
      publicationId: record.publicationId,
      expectedRevision: record.revision,
      expectedOwnerEpoch: record.ownerEpoch,
      nextRecord: invalid,
      newlyConsumedCapabilityIds: ['capability:sign:one']
    })).rejects.toMatchObject({ code: 'INVALID_RECOVERY_TRANSITION' })
    await expect(store.load(record.publicationId)).resolves.toEqual(record)
    store.close()
  })

  test('commits dispatch intent atomically and rejects invalid causal time', async () => {
    const { store } = harness()
    const consumed = broadcastConsumedRecord()
    const valid = outcomeUnknownRecord()
    const invalid = {
      ...valid,
      dispatchIntent: {
        ...valid.dispatchIntent!,
        committedAt: consumed.broadcastAuthorization!.consumedAt - 1
      }
    } as Tm1PublicationRecoveryRecord
    await store.create({ record: consumed })

    await expect(store.commitDispatchIntent({
      publicationId: consumed.publicationId,
      expectedRevision: consumed.revision,
      expectedOwnerEpoch: consumed.ownerEpoch,
      nextRecord: invalid
    })).rejects.toMatchObject({ code: 'MALFORMED_RECOVERY_RECORD' })
    await expect(store.load(consumed.publicationId)).resolves.toEqual(consumed)
    await expect(store.commitDispatchIntent({
      publicationId: consumed.publicationId,
      expectedRevision: consumed.revision,
      expectedOwnerEpoch: consumed.ownerEpoch,
      nextRecord: valid
    })).resolves.toEqual(valid)
    store.close()
  })

  test('commits only an exact positive acknowledgement after dispatch', async () => {
    const { store } = harness()
    const current = outcomeUnknownRecord()
    await store.create({ record: current })
    const acknowledgement = {
      submissionId: current.dispatchIntent!.submissionId,
      signedId: current.signed!.signedId,
      txid: HASH_B,
      signedArtifactHash: HASH_C,
      disposition: 'accepted' as const,
      acknowledgedAt: current.dispatchIntent!.committedAt
    }

    await expect(store.commitTransportAcknowledgement({
      publicationId: current.publicationId,
      expectedRevision: current.revision,
      expectedOwnerEpoch: current.ownerEpoch,
      acknowledgement: { ...acknowledgement, signedId: 'signed:wrong' }
    })).rejects.toMatchObject({ code: 'INVALID_RECOVERY_TRANSITION' })
    await expect(store.load(current.publicationId)).resolves.toEqual(current)

    const committed = await store.commitTransportAcknowledgement({
      publicationId: current.publicationId,
      expectedRevision: current.revision,
      expectedOwnerEpoch: current.ownerEpoch,
      acknowledgement
    }) as Tm1PublicationRecoveryRecord
    expect(committed.phase).toBe('submittedObserved')
    expect(committed.transportAcknowledgement).toEqual({
      txid: HASH_B,
      disposition: 'accepted',
      acknowledgedAt: current.dispatchIntent!.committedAt
    })
    store.close()
  })

  test('rejects acknowledgement time before dispatch without mutation', async () => {
    const { store } = harness()
    const current = outcomeUnknownRecord()
    await store.create({ record: current })

    await expect(store.commitTransportAcknowledgement({
      publicationId: current.publicationId,
      expectedRevision: current.revision,
      expectedOwnerEpoch: current.ownerEpoch,
      acknowledgement: {
        submissionId: current.dispatchIntent!.submissionId,
        signedId: current.signed!.signedId,
        txid: HASH_B,
        signedArtifactHash: HASH_C,
        disposition: 'accepted',
        acknowledgedAt: current.dispatchIntent!.committedAt - 1
      }
    })).rejects.toMatchObject({ code: 'INVALID_RECOVERY_TRANSITION' })
    await expect(store.load(current.publicationId)).resolves.toEqual(current)
    store.close()
  })

  test('persists observation-only recovery transitions', async () => {
    const { store } = harness()
    const current = outcomeUnknownRecord()
    const observed = absentObservationRecord(current)
    await store.create({ record: current })

    await expect(store.commitRecoveryTransition({
      publicationId: current.publicationId,
      expectedRevision: current.revision,
      expectedOwnerEpoch: current.ownerEpoch,
      nextRecord: observed
    })).resolves.toEqual(observed)
    await expect(store.load(current.publicationId)).resolves.toEqual(observed)
    store.close()
  })

  test('fails closed on digest mismatch', async () => {
    const { store, databasePath } = harness()
    const record = preparedRecord()
    await store.create({ record })
    store.close()
    mutate(databasePath, 'UPDATE tm1_publications SET record_sha256 = ?', '0'.repeat(64))

    const reopened = openStore(databasePath)
    await expect(reopened.load(record.publicationId)).rejects.toMatchObject({
      code: 'RECOVERY_STORE_FAILED'
    })
    reopened.close()
  })

  test('fails closed on mirrored-column mismatch', async () => {
    const { store, databasePath } = harness()
    const record = preparedRecord()
    await store.create({ record })
    store.close()
    mutate(databasePath, 'UPDATE tm1_publications SET prepared_id = ?', 'prepared:hostile')

    const reopened = openStore(databasePath)
    await expect(reopened.load(record.publicationId)).rejects.toMatchObject({
      code: 'RECOVERY_STORE_FAILED'
    })
    reopened.close()
  })

  test('listRecoverable validates rows before trusting their mirrored phase', async () => {
    const { store, databasePath } = harness()
    const record = preparedRecord()
    await store.create({ record })
    store.close()
    mutate(databasePath, 'UPDATE tm1_publications SET phase = ?', 'abandoned')

    const reopened = openStore(databasePath)
    await expect(reopened.listRecoverable()).rejects.toMatchObject({
      code: 'RECOVERY_STORE_FAILED'
    })
    reopened.close()
  })

  test('fails closed when capability ledger evidence is missing', async () => {
    const { store, databasePath } = harness()
    const record = signingConsumedRecord()
    await store.create({ record })
    store.close()
    mutate(
      databasePath,
      'DELETE FROM tm1_consumed_capabilities WHERE capability_id = ?',
      record.signingAuthorization!.capabilityId
    )

    const reopened = openStore(databasePath)
    await expect(reopened.load(record.publicationId)).rejects.toMatchObject({
      code: 'RECOVERY_STORE_FAILED'
    })
    reopened.close()
  })

  test('fails closed on malformed canonical record JSON', async () => {
    const { store, databasePath } = harness()
    const record = preparedRecord()
    await store.create({ record })
    store.close()
    const malformed = '{'
    mutate(
      databasePath,
      'UPDATE tm1_publications SET record_json = ?, record_sha256 = ?',
      malformed,
      sha256Hex(malformed)
    )

    const reopened = openStore(databasePath)
    await expect(reopened.load(record.publicationId)).rejects.toMatchObject({
      code: 'RECOVERY_STORE_FAILED'
    })
    reopened.close()
  })

  test('fails closed on unsupported physical schema versions', () => {
    const { databasePath } = emptyPath()
    const database = new DatabaseSync(databasePath, { allowExtension: false })
    database.exec('PRAGMA user_version = 2')
    database.close()
    if (process.platform !== 'win32') chmodSync(databasePath, 0o600)

    let thrown: unknown
    try {
      openStore(databasePath)
    } catch (error) {
      thrown = error
    }
    expect(thrown).toMatchObject({ code: 'RECOVERY_STORE_FAILED' })
  })
})

function harness(
  options: Readonly<{ busyTimeoutMs?: number }> = {}
): Readonly<{
  store: Tm1SqlitePublicationRecoveryStore
  databasePath: string
}> {
  const { databasePath } = emptyPath()
  return Object.freeze({
    databasePath,
    store: openStore(databasePath, options.busyTimeoutMs)
  })
}

function emptyPath(): Readonly<{ directory: string; databasePath: string }> {
  const directory = mkdtempSync(join(tmpdir(), 'rmz-tm1-sqlite-'))
  temporaryDirectories.push(directory)
  return Object.freeze({ directory, databasePath: join(directory, 'recovery.db') })
}

function openStore(
  databasePath: string,
  busyTimeoutMs?: number
): Tm1SqlitePublicationRecoveryStore {
  return createTm1SqlitePublicationRecoveryStore({
    databasePath,
    ...(busyTimeoutMs === undefined ? {} : { busyTimeoutMs }),
    now: () => 1_000
  })
}

function mutate(databasePath: string, sql: string, ...values: string[]): void {
  const database = new DatabaseSync(databasePath, { allowExtension: false })
  database.prepare(sql).run(...values)
  database.close()
}
