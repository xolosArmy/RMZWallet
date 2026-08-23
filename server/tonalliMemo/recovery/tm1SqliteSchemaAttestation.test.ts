import { chmodSync, mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import { afterEach, describe, expect, test } from 'vitest'
import {
  createTm1SqlitePublicationRecoveryStore,
  type Tm1SqlitePublicationRecoveryStore
} from './tm1SqlitePublicationRecoveryStore'
import {
  TM1_SQLITE_APPLICATION_ID,
  TM1_SQLITE_PHYSICAL_SCHEMA_VERSION,
  TM1_SQLITE_SCHEMA_V1_SQL
} from './tm1SqliteSchema'
import { preparedRecord } from './tm1SqliteTestFixtures'

const temporaryDirectories: string[] = []

afterEach(() => {
  for (const directory of temporaryDirectories.splice(0)) {
    rmSync(directory, { recursive: true, force: true })
  }
})

describe('TM1 SQLite v1 physical-schema attestation', () => {
  test('accepts a freshly migrated v1 database across close and reopen', async () => {
    const databasePath = emptyDatabasePath()
    const record = preparedRecord()
    const first = openStore(databasePath)
    await first.create({ record })
    first.close()

    const reopened = openStore(databasePath)
    await expect(reopened.load(record.publicationId)).resolves.toEqual(record)
    reopened.close()
  })

  test.each([
    ['a removed CHECK constraint', (sql: string) => replaceRequired(
      sql,
      '  CHECK (consumed_at < expires_at),\n',
      ''
    )],
    ['changed publication primary-key semantics', (sql: string) => replaceRequired(
      sql,
      '  publication_id TEXT PRIMARY KEY,',
      '  publication_id TEXT UNIQUE NOT NULL,'
    )],
    ['an obsolete SQLite identifier-length approximation', (sql: string) => replaceRequired(
      sql,
      '  publication_id TEXT PRIMARY KEY,',
      '  publication_id TEXT PRIMARY KEY CHECK (length(publication_id) BETWEEN 1 AND 256),'
    )],
    ['changed capability uniqueness semantics', (sql: string) => replaceRequired(
      sql,
      '  UNIQUE (publication_id, kind)',
      '  UNIQUE (publication_id, operation_id)'
    )],
    ['a removed required explicit index', (sql: string) => replaceRequired(
      sql,
      `CREATE INDEX tm1_publications_phase_idx
  ON tm1_publications(phase, publication_id);

`,
      ''
    )],
    ['a required index with a different definition', (sql: string) => replaceRequired(
      sql,
      'ON tm1_publications(phase, publication_id);',
      'ON tm1_publications(phase, owner_epoch);'
    )],
    ['a removed foreign key', (sql: string) => replaceRequired(
      sql,
      '  publication_id TEXT NOT NULL REFERENCES tm1_publications(publication_id) ON DELETE RESTRICT,',
      '  publication_id TEXT NOT NULL,'
    )],
    ['a changed foreign-key action', (sql: string) => replaceRequired(
      sql,
      'REFERENCES tm1_publications(publication_id) ON DELETE RESTRICT',
      'REFERENCES tm1_publications(publication_id) ON DELETE CASCADE'
    )],
    ['an unexpected user table', (sql: string) => `${sql}\nCREATE TABLE hostile_extra (value TEXT) STRICT;\n`],
    ['an unexpected user index', (sql: string) => `${sql}\nCREATE INDEX hostile_owner_idx ON tm1_publications(owner_epoch);\n`],
    ['an unexpected view', (sql: string) => `${sql}\nCREATE VIEW hostile_publications AS SELECT publication_id FROM tm1_publications;\n`],
    ['an unexpected trigger', (sql: string) => `${sql}\nCREATE TRIGGER hostile_metadata_update AFTER UPDATE ON tm1_store_metadata BEGIN UPDATE tm1_store_metadata SET created_at = OLD.created_at WHERE singleton_id = 1; END;\n`],
    ['a trigger that mutates authoritative evidence after update', (sql: string) => `${sql}\nCREATE TRIGGER hostile_evidence_update AFTER UPDATE ON tm1_publications BEGIN UPDATE tm1_publications SET record_sha256 = '${'0'.repeat(64)}' WHERE publication_id = NEW.publication_id; END;\n`],
    ['an authoritative table with the same columns but without STRICT', (sql: string) => replaceRequired(
      sql,
      `  CHECK (ack_txid IS NULL OR ack_txid = txid)
) STRICT;

CREATE INDEX tm1_publications_phase_idx`,
      `  CHECK (ack_txid IS NULL OR ack_txid = txid)
);

CREATE INDEX tm1_publications_phase_idx`
    )],
    ['an expected-looking object name with the wrong object type', (sql: string) => `${replaceRequired(
      sql,
      `CREATE INDEX tm1_publications_phase_idx
  ON tm1_publications(phase, publication_id);

`,
      ''
    )}\nCREATE VIEW tm1_publications_phase_idx AS SELECT phase, publication_id FROM tm1_publications;\n`]
  ])('rejects %s before authoritative operations', (_description, transform) => {
    const databasePath = createV1LookingDatabase(transform(TM1_SQLITE_SCHEMA_V1_SQL))
    expectOpenToFail(databasePath)
  })

  test('rejects the deletion-trigger exploit before create can report success', () => {
    const hostileSchema = `${TM1_SQLITE_SCHEMA_V1_SQL}
CREATE TRIGGER hostile_delete_publication
AFTER INSERT ON tm1_publications
BEGIN
  DELETE FROM tm1_publications WHERE publication_id = NEW.publication_id;
END;
`
    const databasePath = createV1LookingDatabase(hostileSchema)

    expectOpenToFail(databasePath)

    const raw = new DatabaseSync(databasePath, { allowExtension: false })
    const row = raw.prepare('SELECT count(*) AS count FROM tm1_publications').get()
    expect(row?.count).toBe(0)
    expect(raw.prepare(`
      SELECT name
      FROM sqlite_schema
      WHERE type = 'trigger' AND name = 'hostile_delete_publication'
    `).get()?.name).toBe('hostile_delete_publication')
    raw.close()
  })

  test('rejects malicious physical schema despite correct identity and metadata markers', () => {
    const databasePath = createV1LookingDatabase(
      `${TM1_SQLITE_SCHEMA_V1_SQL}\nCREATE TABLE hostile_marker (value TEXT) STRICT;\n`
    )
    const raw = new DatabaseSync(databasePath, { allowExtension: false })

    expect(raw.prepare('PRAGMA application_id').get()?.application_id)
      .toBe(TM1_SQLITE_APPLICATION_ID)
    expect(raw.prepare('PRAGMA user_version').get()?.user_version)
      .toBe(TM1_SQLITE_PHYSICAL_SCHEMA_VERSION)
    expect(raw.prepare(`
      SELECT physical_schema_version, created_at
      FROM tm1_store_metadata
      WHERE singleton_id = 1
    `).get()).toEqual({
      physical_schema_version: TM1_SQLITE_PHYSICAL_SCHEMA_VERSION,
      created_at: 1_000
    })
    raw.close()

    expectOpenToFail(databasePath)
  })
})

function emptyDatabasePath(): string {
  const directory = mkdtempSync(join(tmpdir(), 'rmz-tm1-schema-attestation-'))
  temporaryDirectories.push(directory)
  return join(directory, 'recovery.db')
}

function createV1LookingDatabase(schemaSql: string): string {
  const databasePath = emptyDatabasePath()
  const database = new DatabaseSync(databasePath, { allowExtension: false })
  try {
    database.enableLoadExtension(false)
    database.exec(schemaSql)
    database.prepare(`
      INSERT INTO tm1_store_metadata (
        singleton_id,
        physical_schema_version,
        created_at
      ) VALUES (1, ?, ?)
    `).run(TM1_SQLITE_PHYSICAL_SCHEMA_VERSION, 1_000)
    database.exec(`PRAGMA application_id = ${TM1_SQLITE_APPLICATION_ID}`)
    database.exec(`PRAGMA user_version = ${TM1_SQLITE_PHYSICAL_SCHEMA_VERSION}`)
  } finally {
    database.close()
  }
  if (process.platform !== 'win32') chmodSync(databasePath, 0o600)
  return databasePath
}

function openStore(databasePath: string): Tm1SqlitePublicationRecoveryStore {
  return createTm1SqlitePublicationRecoveryStore({
    databasePath,
    now: () => 1_000
  })
}

function expectOpenToFail(databasePath: string): void {
  let thrown: unknown
  try {
    openStore(databasePath)
  } catch (error) {
    thrown = error
  }
  expect(thrown).toMatchObject({ code: 'RECOVERY_STORE_FAILED' })
}

function replaceRequired(source: string, expected: string, replacement: string): string {
  const first = source.indexOf(expected)
  if (first === -1 || source.indexOf(expected, first + expected.length) !== -1) {
    throw new Error('Expected exactly one canonical schema fragment.')
  }
  return source.replace(expected, replacement)
}
