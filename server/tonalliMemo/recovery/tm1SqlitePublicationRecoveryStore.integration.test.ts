import { fork, type ChildProcess } from 'node:child_process'
import {
  chmodSync,
  closeSync,
  existsSync,
  lstatSync,
  mkdtempSync,
  openSync,
  readlinkSync,
  readdirSync,
  readFileSync,
  rmSync,
  writeFileSync
} from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import { fileURLToPath } from 'node:url'
import { afterEach, describe, expect, test } from 'vitest'
import type { Tm1PublicationRecoveryRecord } from '../../../src/integrations/tonalliMemo/recovery/tm1PublicationRecoveryModel'
import {
  initializeOrVerifyTm1SqliteSchema,
  inspectTm1SqliteSchema
} from './tm1SqliteMigrations'
import {
  createTm1SqlitePublicationRecoveryStore,
  type Tm1SqlitePublicationRecoveryStore
} from './tm1SqlitePublicationRecoveryStore'
import {
  TM1_SQLITE_APPLICATION_ID,
  TM1_SQLITE_PHYSICAL_SCHEMA_VERSION,
  TM1_SQLITE_SCHEMA_V1_SQL,
  type Tm1CanonicalRecoveryRecord
} from './tm1SqliteSchema'
import { encodeTm1SqliteIdentifierKey } from './tm1SqliteIdentifierKey'
import {
  allowLegacyMutationInPhysicalStoreTest,
  outcomeUnknownRecord,
  preparedRecord,
  signingConsumedRecord,
  signingPendingRecord
} from './tm1SqliteTestFixtures'

const workerPath = fileURLToPath(new URL(
  '../../../scripts/tm1-recovery-store-crash-worker.ts',
  import.meta.url
))
const temporaryDirectories: string[] = []
const liveWorkers = new Set<ChildProcess>()

afterEach(async () => {
  await Promise.all([...liveWorkers].map(killWorker))
  for (const directory of temporaryDirectories.splice(0)) {
    rmSync(directory, { recursive: true, force: true })
  }
})

describe('TM1 SQLite real-file and process behavior', () => {
  test('rejects an unrelated DELETE database without persistent TM1 side effects', () => {
    const { databasePath } = emptyPath()
    const before = createUnrelatedDatabase(databasePath)
    expect(before).toMatchObject({
      journalMode: 'delete',
      applicationId: 123_456,
      userVersion: 77,
      sentinelRows: [{ id: 1, value: 'preserve-me' }]
    })
    expect(before.schema.map(row => row.name)).toEqual(['unrelated_sentinel'])
    expect(databaseSidecars(databasePath)).toEqual([])

    expectOpenToFail(databasePath)

    expect(databaseSidecars(databasePath)).toEqual([])
    expect(snapshotUnrelatedDatabase(databasePath)).toEqual(before)
  })

  test('rejects spoofed TM1 markers and wrong schema before WAL mutation', () => {
    const { databasePath } = emptyPath()
    const before = createUnrelatedDatabase(databasePath, true)
    expect(before).toMatchObject({
      journalMode: 'delete',
      applicationId: TM1_SQLITE_APPLICATION_ID,
      userVersion: TM1_SQLITE_PHYSICAL_SCHEMA_VERSION
    })
    expect(before.schema.map(row => row.name)).toContain('unrelated_sentinel')
    expect(databaseSidecars(databasePath)).toEqual([])

    expectOpenToFail(databasePath)

    expect(databaseSidecars(databasePath)).toEqual([])
    expect(snapshotUnrelatedDatabase(databasePath)).toEqual(before)
  })

  test('rolls back failed pre-WAL identity inspection and leaves no transaction open', () => {
    const { databasePath } = emptyPath()
    const before = createUnrelatedDatabase(databasePath)
    const database = new DatabaseSync(databasePath, { allowExtension: false })

    let thrown: unknown
    try {
      initializeOrVerifyTm1SqliteSchema(database, 1_000)
    } catch (error) {
      thrown = error
    }

    expect(thrown).toMatchObject({ code: 'RECOVERY_STORE_FAILED' })
    expect(database.isTransaction).toBe(false)
    database.close()
    expect(databaseSidecars(databasePath)).toEqual([])
    expect(snapshotUnrelatedDatabase(databasePath)).toEqual(before)
  })

  test('attests canonical TM1 v1 in DELETE mode before transitioning it to WAL', async () => {
    const { databasePath } = emptyPath()
    createCanonicalDeleteDatabase(databasePath)
    expect(databaseSidecars(databasePath)).toEqual([])

    const store = openStore(databasePath)
    expect(store.inspectDurability().journalMode).toBe('wal')
    const record = preparedRecord()
    await expect(store.create({ record })).resolves.toEqual(record)
    await expect(store.load(record.publicationId)).resolves.toEqual(record)
    store.close()

    const raw = new DatabaseSync(databasePath, { allowExtension: false })
    expect(inspectTm1SqliteSchema(raw)).toBe('v1')
    expect(readPragmaString(raw, 'journal_mode')).toBe('wal')
    raw.close()
  })

  test('attests canonical DELETE mode with statistics before transitioning to WAL', async () => {
    const { databasePath } = emptyPath()
    createCanonicalDeleteDatabase(databasePath)
    const maintenance = new DatabaseSync(databasePath, { allowExtension: false })
    maintenance.exec('ANALYZE')
    expect(readPragmaString(maintenance, 'journal_mode')).toBe('delete')
    expect(readStatisticsObjects(maintenance).map(row => row.name))
      .toContain('sqlite_stat1')
    maintenance.close()
    expect(databaseSidecars(databasePath)).toEqual([])

    const store = openStore(databasePath)
    expect(store.inspectDurability().journalMode).toBe('wal')
    const record = preparedRecord({ publicationId: 'publication:analyzed-delete' })
    await expect(store.create({ record })).resolves.toEqual(record)
    await expect(store.load(record.publicationId)).resolves.toEqual(record)
    store.close()

    const raw = new DatabaseSync(databasePath, { allowExtension: false })
    expect(inspectTm1SqliteSchema(raw)).toBe('v1')
    expect(readPragmaString(raw, 'journal_mode')).toBe('wal')
    raw.close()
  })

  test('keeps live and reopened stores usable across repeated ANALYZE maintenance', async () => {
    const { databasePath } = emptyPath()
    const first = outcomeUnknownRecord({
      publicationId: 'publication:analyze-a',
      signingCapabilityId: 'capability:sign:analyze-a',
      broadcastCapabilityId: 'capability:broadcast:analyze-a'
    })
    const second = preparedRecord({ publicationId: 'publication:analyze-b' })
    const third = preparedRecord({ publicationId: 'publication:analyze-c' })
    const store = openStore(databasePath)
    await store.create({ record: first })

    const maintenance = new DatabaseSync(databasePath, { allowExtension: false })
    maintenance.exec('ANALYZE')
    const statisticsObjects = readStatisticsObjects(maintenance)
    const initialStatistics = readStatisticsRows(maintenance)
    expect(statisticsObjects).toContainEqual({
      type: 'table',
      name: 'sqlite_stat1',
      tbl_name: 'sqlite_stat1',
      sql: 'CREATE TABLE sqlite_stat1(tbl,idx,stat)'
    })

    await expect(store.load(first.publicationId)).resolves.toEqual(first)
    await expect(store.listRecoverable()).resolves.toEqual([first])
    await expect(store.create({ record: second })).resolves.toEqual(second)
    maintenance.exec('ANALYZE')
    const updatedStatistics = readStatisticsRows(maintenance)
    expect(updatedStatistics).not.toEqual(initialStatistics)
    await expect(store.listRecoverable()).resolves.toEqual([first, second])

    maintenance.exec('PRAGMA optimize')
    maintenance.exec('ANALYZE')
    expect(readStatisticsObjects(maintenance)).toEqual(statisticsObjects)
    maintenance.close()
    await expect(store.load(second.publicationId)).resolves.toEqual(second)
    store.close()

    const reopened = openStore(databasePath)
    await expect(reopened.load(first.publicationId)).resolves.toEqual(first)
    await expect(reopened.load(second.publicationId)).resolves.toEqual(second)
    await expect(reopened.create({ record: third })).resolves.toEqual(third)
    await expect(reopened.listRecoverable()).resolves.toEqual([first, second, third])
    reopened.close()
  })

  test('initializes canonical v1 from a pre-existing empty file and reopens it', async () => {
    const { databasePath } = emptyPath()
    const descriptor = openSync(databasePath, 'wx', 0o600)
    closeSync(descriptor)
    const record = preparedRecord()

    const first = openStore(databasePath)
    await expect(first.create({ record })).resolves.toEqual(record)
    await expect(first.load(record.publicationId)).resolves.toEqual(record)
    first.close()

    const raw = new DatabaseSync(databasePath, { allowExtension: false })
    expect(inspectTm1SqliteSchema(raw)).toBe('v1')
    raw.close()

    const reopened = openStore(databasePath)
    await expect(reopened.load(record.publicationId)).resolves.toEqual(record)
    reopened.close()
  })

  test('two processes first-open one absent path and both obtain a usable store', async () => {
    const { directory, databasePath } = emptyPath()
    const first = spawnWorker('open-on-command', databasePath)
    const second = spawnWorker('open-on-command', databasePath)
    await expect(Promise.all([nextMessage(first), nextMessage(second)]))
      .resolves.toEqual([{ status: 'ready' }, { status: 'ready' }])
    expect(existsSync(databasePath)).toBe(false)

    const firstOpened = nextMessage(first)
    const secondOpened = nextMessage(second)
    first.send?.({ command: 'open' })
    second.send?.({ command: 'open' })
    await expect(Promise.all([firstOpened, secondOpened])).resolves.toEqual([
      { status: 'opened', empty: true, journalMode: 'wal' },
      { status: 'opened', empty: true, journalMode: 'wal' }
    ])
    await Promise.all([killWorker(first), killWorker(second)])

    expect(readdirSync(directory).filter(name => name.endsWith('.db')))
      .toEqual(['recovery.db'])
    const reopened = openStore(databasePath)
    await expect(reopened.load('publication:first-open')).resolves.toBeNull()
    reopened.close()

    const raw = new DatabaseSync(databasePath, { allowExtension: false })
    expect(inspectTm1SqliteSchema(raw)).toBe('v1')
    raw.close()
  })

  test('bounds concurrent WAL transition after both processes attest canonical v1', async () => {
    const { databasePath } = emptyPath()
    createCanonicalDeleteDatabase(databasePath)
    const first = spawnWorker('open-on-command', databasePath)
    const second = spawnWorker('open-on-command', databasePath)
    await expect(Promise.all([nextMessage(first), nextMessage(second)]))
      .resolves.toEqual([{ status: 'ready' }, { status: 'ready' }])

    const firstOpened = nextMessage(first)
    const secondOpened = nextMessage(second)
    first.send?.({ command: 'open' })
    second.send?.({ command: 'open' })
    await expect(Promise.all([firstOpened, secondOpened])).resolves.toEqual([
      { status: 'opened', empty: true, journalMode: 'wal' },
      { status: 'opened', empty: true, journalMode: 'wal' }
    ])
    await Promise.all([killWorker(first), killWorker(second)])

    const raw = new DatabaseSync(databasePath, { allowExtension: false })
    expect(inspectTm1SqliteSchema(raw)).toBe('v1')
    expect(readPragmaString(raw, 'journal_mode')).toBe('wal')
    raw.close()
  })

  test('recovers after the exclusive creator dies before schema initialization', async () => {
    const { databasePath } = emptyPath()
    const creator = spawnWorker('create-empty-and-hold', databasePath)
    await expect(nextMessage(creator)).resolves.toEqual({ status: 'empty-file-created' })
    expect(lstatSync(databasePath).size).toBe(0)
    await killWorker(creator)

    const record = preparedRecord()
    const recovery = openStore(databasePath)
    await expect(recovery.create({ record })).resolves.toEqual(record)
    recovery.close()

    const reopened = openStore(databasePath)
    await expect(reopened.load(record.publicationId)).resolves.toEqual(record)
    reopened.close()
  })

  test('keeps non-EEXIST filesystem failures fail-closed', () => {
    const { directory } = emptyPath()
    const databasePath = join(directory, 'missing-parent', 'recovery.db')

    let thrown: unknown
    try {
      openStore(databasePath)
    } catch (error) {
      thrown = error
    }
    expect(thrown).toMatchObject({
      code: 'RECOVERY_STORE_FAILED',
      message: 'RECOVERY_STORE_FAILED'
    })
    expect(existsSync(databasePath)).toBe(false)
  })

  test.skipIf(process.platform !== 'linux')(
    'closes first-open and SQLite file descriptors when the store closes',
    () => {
      const { databasePath } = emptyPath()
      const store = openStore(databasePath)
      store.close()

      expect(openDescriptorsFor(databasePath)).toEqual([])
    }
  )

  test('persists through close/reopen and a WAL checkpoint', async () => {
    const { databasePath } = emptyPath()
    const record = outcomeUnknownRecord()
    const first = openStore(databasePath)
    await first.create({ record })
    first.close()

    const checkpoint = new DatabaseSync(databasePath, { allowExtension: false })
    const result = checkpoint.prepare('PRAGMA wal_checkpoint(TRUNCATE)').get()
    expect(result).toMatchObject({ busy: 0 })
    checkpoint.close()

    const reopened = openStore(databasePath)
    await expect(reopened.load(record.publicationId)).resolves.toEqual(record)
    reopened.close()
  })

  test('supports two connections while preserving CAS', async () => {
    const { databasePath } = emptyPath()
    const first = openStore(databasePath)
    const second = openStore(databasePath)
    const record = preparedRecord()
    await first.create({ record })

    const firstSnapshot = await first.load(record.publicationId) as Tm1PublicationRecoveryRecord
    const secondSnapshot = await second.load(record.publicationId) as Tm1PublicationRecoveryRecord
    const claimed = await first.claimOwnership({
      publicationId: record.publicationId,
      expectedRevision: firstSnapshot.revision,
      expectedOwnerEpoch: firstSnapshot.ownerEpoch,
      nextOwnerEpoch: 1
    }) as Tm1PublicationRecoveryRecord

    await expect(second.claimOwnership({
      publicationId: record.publicationId,
      expectedRevision: secondSnapshot.revision,
      expectedOwnerEpoch: secondSnapshot.ownerEpoch,
      nextOwnerEpoch: 2
    })).rejects.toMatchObject({ code: 'REVISION_MISMATCH' })
    await expect(second.load(record.publicationId)).resolves.toEqual(claimed)
    first.close()
    second.close()
  })

  test('rejects the post-open AFTER INSERT deletion-trigger exploit', async () => {
    const { databasePath } = emptyPath()
    const store = openStore(databasePath)
    const attacker = new DatabaseSync(databasePath, { allowExtension: false })
    attacker.exec(`
      CREATE TRIGGER hostile_delete_after_insert
      AFTER INSERT ON tm1_publications
      BEGIN
        DELETE FROM tm1_publications
        WHERE publication_id = NEW.publication_id;
      END
    `)

    await expect(store.create({ record: preparedRecord() })).rejects.toMatchObject({
      code: 'RECOVERY_STORE_FAILED'
    })
    expect(readSeam(store).database.isTransaction).toBe(false)
    expect(attacker.prepare('SELECT count(*) AS count FROM tm1_publications').get()?.count)
      .toBe(0)
    expect(attacker.prepare(`
      SELECT name
      FROM sqlite_schema
      WHERE type = 'trigger' AND name = 'hostile_delete_after_insert'
    `).get()?.name).toBe('hostile_delete_after_insert')

    attacker.close()
    store.close()
  })

  test('rejects a post-open AFTER UPDATE trigger before mutating a record', async () => {
    const { databasePath } = emptyPath()
    const store = openStore(databasePath)
    const record = preparedRecord()
    await store.create({ record })
    const attacker = new DatabaseSync(databasePath, { allowExtension: false })
    attacker.exec(`
      CREATE TRIGGER hostile_delete_after_update
      AFTER UPDATE ON tm1_publications
      BEGIN
        DELETE FROM tm1_publications
        WHERE publication_id = NEW.publication_id;
      END
    `)

    await expect(store.claimOwnership({
      publicationId: record.publicationId,
      expectedRevision: record.revision,
      expectedOwnerEpoch: record.ownerEpoch,
      nextOwnerEpoch: 1
    })).rejects.toMatchObject({ code: 'RECOVERY_STORE_FAILED' })
    expect(readSeam(store).database.isTransaction).toBe(false)
    expect(attacker.prepare(`
      SELECT revision, owner_epoch
      FROM tm1_publications
      WHERE publication_id = ?
    `).get(encodeTm1SqliteIdentifierKey(record.publicationId))).toEqual({
      revision: 0,
      owner_epoch: 0
    })

    attacker.close()
    store.close()
  })

  test.each([
    [
      'unexpected view through load',
      'CREATE VIEW hostile_publications AS SELECT publication_id FROM tm1_publications',
      'load'
    ],
    [
      'unexpected index through listRecoverable',
      'CREATE INDEX hostile_owner_idx ON tm1_publications(owner_epoch)',
      'list'
    ],
    [
      'dropped required index through load',
      'DROP INDEX tm1_publications_txid_idx',
      'load'
    ]
  ] as const)('detects a post-open %s', async (_description, mutation, operation) => {
    const { databasePath } = emptyPath()
    const store = openStore(databasePath)
    const record = preparedRecord()
    await store.create({ record })
    const attacker = new DatabaseSync(databasePath, { allowExtension: false })
    attacker.exec(mutation)

    const result = operation === 'load'
      ? store.load(record.publicationId)
      : store.listRecoverable()
    await expect(result).rejects.toMatchObject({ code: 'RECOVERY_STORE_FAILED' })
    expect(readSeam(store).database.isTransaction).toBe(false)

    attacker.close()
    store.close()
  })

  test('accepts a later operation after external restoration to exact canonical v1', async () => {
    const { databasePath } = emptyPath()
    const store = openStore(databasePath)
    const record = preparedRecord()
    await store.create({ record })
    const attacker = new DatabaseSync(databasePath, { allowExtension: false })
    attacker.exec(`
      CREATE VIEW hostile_publications AS
      SELECT publication_id FROM tm1_publications
    `)

    await expect(store.load(record.publicationId)).rejects.toMatchObject({
      code: 'RECOVERY_STORE_FAILED'
    })
    expect(readSeam(store).database.isTransaction).toBe(false)
    attacker.exec('DROP VIEW hostile_publications')
    await expect(store.load(record.publicationId)).resolves.toEqual(record)

    attacker.close()
    store.close()
  })

  test('BEGIN IMMEDIATE prevents DDL between write attestation and mutation', async () => {
    const { databasePath } = emptyPath()
    const store = openStore(databasePath)
    const attacker = new DatabaseSync(databasePath, {
      allowExtension: false,
      timeout: 20
    })
    attacker.exec('PRAGMA busy_timeout = 20')
    const seam = readSeam(store)
    const insertPublication = seam.insertPublication.bind(store)
    let blockedDdlError: unknown
    seam.insertPublication = canonical => {
      try {
        attacker.exec(`
          CREATE TRIGGER hostile_delete_after_insert
          AFTER INSERT ON tm1_publications
          BEGIN
            DELETE FROM tm1_publications
            WHERE publication_id = NEW.publication_id;
          END
        `)
      } catch (error) {
        blockedDdlError = error
      }
      insertPublication(canonical)
    }
    const record = preparedRecord()

    await expect(store.create({ record })).resolves.toEqual(record)
    expect(blockedDdlError).toMatchObject({ code: 'ERR_SQLITE_ERROR', errcode: 5 })
    expect(attacker.prepare(`
      SELECT publication_id
      FROM tm1_publications
      WHERE publication_id = ?
    `).get(encodeTm1SqliteIdentifierKey(record.publicationId))?.publication_id)
      .toBe(encodeTm1SqliteIdentifierKey(record.publicationId))

    attacker.exec(`
      CREATE TRIGGER hostile_delete_after_insert
      AFTER INSERT ON tm1_publications
      BEGIN
        DELETE FROM tm1_publications
        WHERE publication_id = NEW.publication_id;
      END
    `)
    await expect(store.load(record.publicationId)).rejects.toMatchObject({
      code: 'RECOVERY_STORE_FAILED'
    })

    attacker.close()
    store.close()
  })

  test('a coherent read snapshot may finish before the next operation detects DDL', async () => {
    const { databasePath } = emptyPath()
    const store = openStore(databasePath)
    const record = preparedRecord()
    await store.create({ record })
    const attacker = new DatabaseSync(databasePath, { allowExtension: false })
    const seam = readSeam(store)
    const selectPublicationRow = seam.selectPublicationRow.bind(store)
    let ddlCommitted = false
    seam.selectPublicationRow = publicationId => {
      const row = selectPublicationRow(publicationId)
      attacker.exec(`
        CREATE VIEW hostile_publications AS
        SELECT publication_id FROM tm1_publications
      `)
      ddlCommitted = true
      return row
    }

    await expect(store.load(record.publicationId)).resolves.toEqual(record)
    expect(ddlCommitted).toBe(true)
    seam.selectPublicationRow = selectPublicationRow
    await expect(store.load(record.publicationId)).rejects.toMatchObject({
      code: 'RECOVERY_STORE_FAILED'
    })

    attacker.close()
    store.close()
  })

  test('schema failure inside a caller-owned read transaction preserves ownership', async () => {
    const { databasePath } = emptyPath()
    const store = openStore(databasePath)
    const record = preparedRecord()
    await store.create({ record })
    const attacker = new DatabaseSync(databasePath, { allowExtension: false })
    attacker.exec(`
      CREATE VIEW hostile_publications AS
      SELECT publication_id FROM tm1_publications
    `)
    const database = readSeam(store).database
    database.exec('BEGIN')

    await expect(store.load(record.publicationId)).rejects.toMatchObject({
      code: 'RECOVERY_STORE_FAILED'
    })
    expect(database.isTransaction).toBe(true)
    database.exec('ROLLBACK')

    attacker.close()
    store.close()
  })

  test('load reads publication and capability evidence from one WAL snapshot', async () => {
    const { databasePath } = emptyPath()
    const reader = openStore(databasePath)
    const writer = openStore(databasePath, 20)
    const before = signingPendingRecord()
    const after = signingConsumedRecord()
    await reader.create({ record: before })

    const seam = readSeam(reader)
    const selectPublicationRow = seam.selectPublicationRow.bind(reader)
    let writerCommit: Promise<unknown> | undefined
    let interleaved = false
    seam.selectPublicationRow = publicationId => {
      const row = selectPublicationRow(publicationId)
      if (!interleaved) {
        interleaved = true
        expect(seam.database.isTransaction).toBe(true)
        writerCommit = writer.commitExecutionEvidence({
          publicationId: before.publicationId,
          expectedRevision: before.revision,
          expectedOwnerEpoch: before.ownerEpoch,
          nextRecord: after,
          newlyConsumedCapabilityIds: [after.signingAuthorization!.capabilityId]
        })
        void writerCommit.catch(() => undefined)
      }
      return row
    }

    await expect(reader.load(before.publicationId)).resolves.toEqual(before)
    expect(interleaved).toBe(true)
    if (writerCommit === undefined) throw new Error('WRITER_COMMIT_NOT_STARTED')
    await expect(writerCommit).resolves.toEqual(after)
    expect(seam.database.isTransaction).toBe(false)
    await expect(reader.load(before.publicationId)).resolves.toEqual(after)
    reader.close()
    writer.close()
  })

  test('listRecoverable hydrates every record from one WAL snapshot', async () => {
    const { databasePath } = emptyPath()
    const reader = openStore(databasePath)
    const writer = openStore(databasePath, 20)
    const before = signingPendingRecord()
    const after = signingConsumedRecord()
    await reader.create({ record: before })

    const seam = readSeam(reader)
    const selectPublicationRows = seam.selectPublicationRows.bind(reader)
    let writerCommit: Promise<unknown> | undefined
    let interleaved = false
    seam.selectPublicationRows = () => {
      const rows = selectPublicationRows()
      if (!interleaved) {
        interleaved = true
        expect(seam.database.isTransaction).toBe(true)
        writerCommit = writer.commitExecutionEvidence({
          publicationId: before.publicationId,
          expectedRevision: before.revision,
          expectedOwnerEpoch: before.ownerEpoch,
          nextRecord: after,
          newlyConsumedCapabilityIds: [after.signingAuthorization!.capabilityId]
        })
        void writerCommit.catch(() => undefined)
      }
      return rows
    }

    await expect(reader.listRecoverable()).resolves.toEqual([before])
    expect(interleaved).toBe(true)
    if (writerCommit === undefined) throw new Error('WRITER_COMMIT_NOT_STARTED')
    await expect(writerCommit).resolves.toEqual(after)
    expect(seam.database.isTransaction).toBe(false)
    await expect(reader.listRecoverable()).resolves.toEqual([after])
    reader.close()
    writer.close()
  })

  test('standalone failing reads roll back their snapshots and preserve taxonomy', async () => {
    const { databasePath } = emptyPath()
    const setup = openStore(databasePath)
    const corrupt = preparedRecord({ publicationId: 'publication:a-corrupt' })
    const valid = preparedRecord({ publicationId: 'publication:z-valid' })
    await setup.create({ record: corrupt })
    await setup.create({ record: valid })
    setup.close()
    corruptDigest(databasePath, corrupt.publicationId)

    const reader = openStore(databasePath)
    const seam = readSeam(reader)
    await expect(reader.load(corrupt.publicationId)).rejects.toMatchObject({
      code: 'RECOVERY_STORE_FAILED'
    })
    expect(seam.database.isTransaction).toBe(false)
    await expect(reader.listRecoverable()).rejects.toMatchObject({
      code: 'RECOVERY_STORE_FAILED'
    })
    expect(seam.database.isTransaction).toBe(false)
    await expect(reader.load(valid.publicationId)).resolves.toEqual(valid)
    reader.close()
  })

  test('read helper neither commits nor rolls back a caller-owned transaction', async () => {
    const { databasePath } = emptyPath()
    const setup = openStore(databasePath)
    const corrupt = preparedRecord({ publicationId: 'publication:a-corrupt' })
    const valid = preparedRecord({ publicationId: 'publication:z-valid' })
    await setup.create({ record: corrupt })
    await setup.create({ record: valid })
    setup.close()
    corruptDigest(databasePath, corrupt.publicationId)

    const reader = openStore(databasePath)
    const database = readSeam(reader).database
    database.exec('BEGIN')
    await expect(reader.load(valid.publicationId)).resolves.toEqual(valid)
    expect(database.isTransaction).toBe(true)
    database.exec('COMMIT')

    database.exec('BEGIN')
    await expect(reader.load(corrupt.publicationId)).rejects.toMatchObject({
      code: 'RECOVERY_STORE_FAILED'
    })
    expect(database.isTransaction).toBe(true)
    database.exec('ROLLBACK')
    await expect(reader.load(valid.publicationId)).resolves.toEqual(valid)
    reader.close()
  })

  test('normalizes a bounded BUSY timeout and leaves state unchanged', async () => {
    const { databasePath } = emptyPath()
    const setup = openStore(databasePath)
    const record = preparedRecord()
    await setup.create({ record })
    setup.close()
    const contender = openStore(databasePath, 20)

    const locker = new DatabaseSync(databasePath, {
      allowExtension: false,
      timeout: 20
    })
    locker.exec('BEGIN IMMEDIATE')
    await expect(contender.claimOwnership({
      publicationId: record.publicationId,
      expectedRevision: record.revision,
      expectedOwnerEpoch: record.ownerEpoch,
      nextOwnerEpoch: 1
    })).rejects.toMatchObject({ code: 'RECOVERY_STORE_FAILED' })
    locker.exec('ROLLBACK')
    locker.close()
    await expect(contender.load(record.publicationId)).resolves.toEqual(record)
    contender.close()
  })

  test.skipIf(process.platform === 'win32')(
    'fails closed when an existing database is read-only',
    async () => {
      const { databasePath } = emptyPath()
      const store = openStore(databasePath)
      await store.create({ record: preparedRecord() })
      store.close()
      const raw = new DatabaseSync(databasePath, { allowExtension: false })
      expect(readPragmaString(raw, 'journal_mode', 'DELETE')).toBe('delete')
      raw.close()
      chmodSync(databasePath, 0o400)

      let thrown: unknown
      try {
        openStore(databasePath)
      } catch (error) {
        thrown = error
      }
      expect(thrown).toMatchObject({ code: 'RECOVERY_STORE_FAILED' })
      expect(databaseSidecars(databasePath)).toEqual([])
    }
  )

  test('normalizes a non-database/corrupt file without leaking its path', () => {
    const { databasePath } = emptyPath()
    writeFileSync(databasePath, 'not-a-sqlite-database', { mode: 0o600 })

    let thrown: unknown
    try {
      openStore(databasePath)
    } catch (error) {
      thrown = error
    }
    expect(thrown).toMatchObject({
      code: 'RECOVERY_STORE_FAILED',
      message: 'RECOVERY_STORE_FAILED'
    })
    expect(databaseSidecars(databasePath)).toEqual([])
  })

  test('rolls back a real transaction when transition validation throws', async () => {
    const { databasePath } = emptyPath()
    const store = openStore(databasePath)
    const prepared = preparedRecord()
    await store.create({ record: prepared })

    await expect(store.commitExecutionEvidence({
      publicationId: prepared.publicationId,
      expectedRevision: prepared.revision,
      expectedOwnerEpoch: prepared.ownerEpoch,
      nextRecord: {
        ...signingPendingRecord(),
        revision: prepared.revision + 2
      } as Tm1PublicationRecoveryRecord,
      newlyConsumedCapabilityIds: []
    })).rejects.toMatchObject({ code: 'INVALID_RECOVERY_TRANSITION' })
    store.close()

    const reopened = openStore(databasePath)
    await expect(reopened.load(prepared.publicationId)).resolves.toEqual(prepared)
    reopened.close()
  })

  test('process death before COMMIT rolls back the mutation', async () => {
    const { databasePath } = emptyPath()
    const setup = openStore(databasePath)
    setup.close()

    const worker = spawnWorker('hold-before-commit', databasePath)
    const message = await nextMessage(worker)
    expect(message.status).toBe('before-commit')
    expect(typeof message.previous).toBe('number')
    await killWorker(worker)

    const database = new DatabaseSync(databasePath, { allowExtension: false })
    const current = database.prepare(`
      SELECT created_at
      FROM tm1_store_metadata
      WHERE singleton_id = 1
    `).get()?.created_at
    database.close()
    expect(current).toBe(message.previous)
  })

  test('process death after COMMIT preserves the publication on restart', async () => {
    const { directory, databasePath } = emptyPath()
    const setup = openStore(databasePath)
    setup.close()
    const record = preparedRecord()
    const payloadPath = join(directory, 'record.json')
    writeFileSync(payloadPath, JSON.stringify(record), { mode: 0o600 })

    const worker = spawnWorker('create-and-hold', databasePath, payloadPath)
    await expect(nextMessage(worker)).resolves.toMatchObject({
      status: 'after-commit',
      publicationId: record.publicationId
    })
    await killWorker(worker)

    const reopened = openStore(databasePath)
    await expect(reopened.load(record.publicationId)).resolves.toEqual(record)
    reopened.close()
  })

  test('a stale process cannot commit after ownership takeover', async () => {
    const { databasePath } = emptyPath()
    const initial = outcomeUnknownRecord()
    const setup = openStore(databasePath)
    await setup.create({ record: initial })
    setup.close()

    const worker = spawnWorker('stale-recovery', databasePath, initial.publicationId)
    await expect(nextMessage(worker)).resolves.toMatchObject({
      status: 'loaded',
      revision: initial.revision,
      ownerEpoch: initial.ownerEpoch
    })

    const owner = openStore(databasePath)
    const claimed = await owner.claimOwnership({
      publicationId: initial.publicationId,
      expectedRevision: initial.revision,
      expectedOwnerEpoch: initial.ownerEpoch,
      nextOwnerEpoch: 1
    }) as Tm1PublicationRecoveryRecord
    owner.close()

    worker.send?.({ command: 'commit' })
    await expect(nextMessage(worker)).resolves.toMatchObject({
      status: 'rejected',
      code: 'REVISION_MISMATCH'
    })
    await killWorker(worker)

    const reopened = openStore(databasePath)
    await expect(reopened.load(initial.publicationId)).resolves.toEqual(claimed)
    reopened.close()
  })

  test('a restart worker loads exact outcomeUnknown evidence only', async () => {
    const { databasePath } = emptyPath()
    const record = outcomeUnknownRecord()
    const setup = openStore(databasePath)
    await setup.create({ record })
    setup.close()

    const worker = spawnWorker('load-only', databasePath, record.publicationId)
    await expect(nextMessage(worker)).resolves.toEqual({
      status: 'loaded',
      record: JSON.parse(JSON.stringify(record))
    })
    await killWorker(worker)
  })

  test('the worker and store contain no signer or network dispatch route', () => {
    const worker = readFileSync(workerPath, 'utf8')
    const store = readFileSync(
      fileURLToPath(new URL('./tm1SqlitePublicationRecoveryStore.ts', import.meta.url)),
      'utf8'
    )
    const combined = `${worker}\n${store}`

    expect(combined).not.toMatch(/P2pkhSigner|ChronikClient|broadcastTx|\.broadcast\s*\(|\.sign\s*\(/)
    expect(worker).not.toMatch(/rebroadcast|deliveryTransport|authorization core/i)
  })

  test('client production sources do not import Node SQLite or the store', () => {
    const repositoryRoot = fileURLToPath(new URL('../../../', import.meta.url))
    const clientFiles = productionTypeScriptFiles(join(repositoryRoot, 'src'))
    const combined = clientFiles.map(path => readFileSync(path, 'utf8')).join('\n')

    expect(combined).not.toContain("from 'node:sqlite'")
    expect(combined).not.toContain('tm1SqlitePublicationRecoveryStore')
    expect(combined).not.toContain('server/tonalliMemo/recovery')
  })
})

function emptyPath(): Readonly<{ directory: string; databasePath: string }> {
  const directory = mkdtempSync(join(tmpdir(), 'rmz-tm1-sqlite-integration-'))
  temporaryDirectories.push(directory)
  return Object.freeze({ directory, databasePath: join(directory, 'recovery.db') })
}

function openStore(
  databasePath: string,
  busyTimeoutMs?: number
): Tm1SqlitePublicationRecoveryStore {
  const store = createTm1SqlitePublicationRecoveryStore({
    databasePath,
    ...(busyTimeoutMs === undefined ? {} : { busyTimeoutMs }),
    now: () => 1_000
  })
  allowLegacyMutationInPhysicalStoreTest(store)
  return store
}

type UnrelatedDatabaseSnapshot = Readonly<{
  journalMode: string
  schema: readonly Record<string, unknown>[]
  sentinelRows: readonly Record<string, unknown>[]
  applicationId: number
  userVersion: number
}>

function createUnrelatedDatabase(
  databasePath: string,
  spoofTm1Markers = false
): UnrelatedDatabaseSnapshot {
  const database = new DatabaseSync(databasePath, { allowExtension: false })
  database.exec('PRAGMA journal_mode = DELETE')
  if (spoofTm1Markers) {
    database.exec(TM1_SQLITE_SCHEMA_V1_SQL)
    database.prepare(`
      INSERT INTO tm1_store_metadata (
        singleton_id,
        physical_schema_version,
        created_at
      ) VALUES (1, ?, ?)
    `).run(TM1_SQLITE_PHYSICAL_SCHEMA_VERSION, 1_000)
  }
  database.exec(`
    CREATE TABLE unrelated_sentinel (
      id INTEGER PRIMARY KEY,
      value TEXT NOT NULL
    ) STRICT;
    INSERT INTO unrelated_sentinel (id, value) VALUES (1, 'preserve-me');
  `)
  database.exec(`PRAGMA application_id = ${
    spoofTm1Markers ? TM1_SQLITE_APPLICATION_ID : 123_456
  }`)
  database.exec(`PRAGMA user_version = ${
    spoofTm1Markers ? TM1_SQLITE_PHYSICAL_SCHEMA_VERSION : 77
  }`)
  database.close()
  if (process.platform !== 'win32') chmodSync(databasePath, 0o600)
  return snapshotUnrelatedDatabase(databasePath)
}

function snapshotUnrelatedDatabase(databasePath: string): UnrelatedDatabaseSnapshot {
  const database = new DatabaseSync(databasePath, { allowExtension: false })
  try {
    return Object.freeze({
      journalMode: readPragmaString(database, 'journal_mode'),
      schema: Object.freeze(database.prepare(`
        SELECT type, name, tbl_name, sql
        FROM sqlite_schema
        WHERE name NOT LIKE 'sqlite_%'
        ORDER BY type, name
      `).all().map(row => Object.freeze({ ...row }))),
      sentinelRows: Object.freeze(database.prepare(`
        SELECT id, value
        FROM unrelated_sentinel
        ORDER BY id
      `).all().map(row => Object.freeze({ ...row }))),
      applicationId: readPragmaInteger(database, 'application_id'),
      userVersion: readPragmaInteger(database, 'user_version')
    })
  } finally {
    database.close()
  }
}

function createCanonicalDeleteDatabase(databasePath: string): void {
  const initialized = openStore(databasePath)
  initialized.close()
  const database = new DatabaseSync(databasePath, { allowExtension: false })
  try {
    expect(inspectTm1SqliteSchema(database)).toBe('v1')
    expect(readPragmaString(database, 'journal_mode', 'DELETE')).toBe('delete')
  } finally {
    database.close()
  }
}

function expectOpenToFail(databasePath: string): void {
  let thrown: unknown
  try {
    openStore(databasePath)
  } catch (error) {
    thrown = error
  }
  expect(thrown).toMatchObject({
    code: 'RECOVERY_STORE_FAILED',
    message: 'RECOVERY_STORE_FAILED'
  })
}

function databaseSidecars(databasePath: string): string[] {
  return [`${databasePath}-wal`, `${databasePath}-shm`]
    .filter(path => existsSync(path))
}

function readPragmaString(
  database: DatabaseSync,
  pragma: string,
  assignedValue?: string
): string {
  const row = assignedValue === undefined
    ? database.prepare(`PRAGMA ${pragma}`).get()
    : database.prepare(`PRAGMA ${pragma} = ${assignedValue}`).get()
  const value = row?.[pragma]
  if (typeof value !== 'string') throw new Error('INVALID_TEST_PRAGMA')
  return value.toLowerCase()
}

function readPragmaInteger(database: DatabaseSync, pragma: string): number {
  const value = database.prepare(`PRAGMA ${pragma}`).get()?.[pragma]
  if (typeof value !== 'number') throw new Error('INVALID_TEST_PRAGMA')
  return value
}

function readStatisticsObjects(database: DatabaseSync): Record<string, unknown>[] {
  return database.prepare(`
    SELECT type, name, tbl_name, sql
    FROM sqlite_schema
    WHERE name LIKE 'sqlite_stat%'
    ORDER BY type, name
  `).all().map(row => ({ ...row }))
}

function readStatisticsRows(database: DatabaseSync): Record<string, unknown>[] {
  return database.prepare(`
    SELECT tbl, idx, stat
    FROM sqlite_stat1
    ORDER BY tbl, idx
  `).all().map(row => ({ ...row }))
}

type Tm1SqliteReadTestSeam = {
  database: DatabaseSync
  insertPublication(canonical: Tm1CanonicalRecoveryRecord): void
  selectPublicationRow(
    publicationId: string
  ): Record<string, unknown> | undefined
  selectPublicationRows(): Record<string, unknown>[]
}

function readSeam(
  store: Tm1SqlitePublicationRecoveryStore
): Tm1SqliteReadTestSeam {
  return store as unknown as Tm1SqliteReadTestSeam
}

function corruptDigest(databasePath: string, publicationId: string): void {
  const database = new DatabaseSync(databasePath, { allowExtension: false })
  database.prepare(`
    UPDATE tm1_publications
    SET record_sha256 = ?
    WHERE publication_id = ?
  `).run('0'.repeat(64), encodeTm1SqliteIdentifierKey(publicationId))
  database.close()
}

function spawnWorker(
  mode: string,
  databasePath: string,
  argument?: string
): ChildProcess {
  const worker = fork(
    workerPath,
    [mode, databasePath, ...(argument === undefined ? [] : [argument])],
    {
      cwd: dirname(workerPath),
      execArgv: ['--import', 'tsx'],
      serialization: 'json',
      stdio: ['ignore', 'ignore', 'pipe', 'ipc']
    }
  )
  liveWorkers.add(worker)
  worker.once('exit', () => liveWorkers.delete(worker))
  return worker
}

function nextMessage(worker: ChildProcess): Promise<Record<string, unknown>> {
  return new Promise((resolveMessage, rejectMessage) => {
    let stderr = ''
    const timeout = setTimeout(() => {
      cleanup()
      rejectMessage(new Error('WORKER_MESSAGE_TIMEOUT'))
    }, 5_000)
    const onData = (value: Buffer | string) => {
      stderr += value.toString()
    }
    const onMessage = (value: unknown) => {
      cleanup()
      if (!value || typeof value !== 'object' || Array.isArray(value)) {
        rejectMessage(new Error('INVALID_WORKER_MESSAGE'))
        return
      }
      resolveMessage(value as Record<string, unknown>)
    }
    const onError = (error: Error) => {
      cleanup()
      rejectMessage(error)
    }
    const onExit = (code: number | null) => {
      cleanup()
      rejectMessage(new Error(`WORKER_EXIT_${String(code)}:${stderr}`))
    }
    const cleanup = () => {
      clearTimeout(timeout)
      worker.stderr?.off('data', onData)
      worker.off('message', onMessage)
      worker.off('error', onError)
      worker.off('exit', onExit)
    }
    worker.stderr?.on('data', onData)
    worker.once('message', onMessage)
    worker.once('error', onError)
    worker.once('exit', onExit)
  })
}

async function killWorker(worker: ChildProcess): Promise<void> {
  liveWorkers.delete(worker)
  if (worker.exitCode !== null || worker.signalCode !== null) return
  await new Promise<void>(resolveExit => {
    worker.once('exit', () => resolveExit())
    worker.kill('SIGKILL')
  })
}

function productionTypeScriptFiles(root: string): string[] {
  const entries = readDirectory(root)
  return entries.filter(path =>
    /\.(ts|tsx)$/.test(path) &&
    !/\.(test|spec)\.(ts|tsx)$/.test(path) &&
    !path.endsWith('.d.ts')
  )
}

function readDirectory(root: string): string[] {
  return readdirSync(root, { withFileTypes: true }).flatMap(entry => {
    const path = join(root, entry.name)
    return entry.isDirectory() ? readDirectory(path) : [path]
  })
}

function openDescriptorsFor(databasePath: string): string[] {
  return readdirSync('/proc/self/fd').flatMap(descriptor => {
    try {
      const target = readlinkSync(join('/proc/self/fd', descriptor))
      return target === databasePath || target.startsWith(`${databasePath}-`)
        ? [target]
        : []
    } catch {
      return []
    }
  })
}
