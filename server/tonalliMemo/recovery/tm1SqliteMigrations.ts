import { DatabaseSync } from 'node:sqlite'
import { Tm1PublicationRecoveryStoreError } from '../../../src/integrations/tonalliMemo/recovery/tm1PublicationRecoveryStore'
import {
  TM1_SQLITE_APPLICATION_ID,
  TM1_SQLITE_PHYSICAL_SCHEMA_VERSION,
  TM1_SQLITE_SCHEMA_V1_SQL
} from './tm1SqliteSchema'

export type Tm1SqliteSchemaState = 'empty' | 'v1'

type SqliteSchemaObject = Readonly<{
  type: string
  name: string
  tableName: string
  sql: string | null
}>

type SqliteTableDefinition = Readonly<{
  tableList: readonly unknown[]
  columns: readonly unknown[]
  foreignKeys: readonly unknown[]
  indexes: readonly unknown[]
}>

type Tm1SqliteSchemaAttestation = Readonly<{
  objects: readonly SqliteSchemaObject[]
  tables: Readonly<Record<string, SqliteTableDefinition>>
  indexColumns: Readonly<Record<string, readonly unknown[]>>
}>

const AUTHORITATIVE_TABLE_NAMES = Object.freeze([
  'tm1_store_metadata',
  'tm1_publications',
  'tm1_consumed_capabilities'
])

const EXPECTED_V1_ATTESTATION = createExpectedV1Attestation()

export function inspectTm1SqliteSchema(
  database: DatabaseSync
): Tm1SqliteSchemaState {
  const userVersion = readPragmaInteger(database, 'user_version')
  const applicationId = readPragmaInteger(database, 'application_id')
  const objectCount = readObjectCount(database)

  if (userVersion === 0 && applicationId === 0 && objectCount === 0) {
    return 'empty'
  }
  if (
    userVersion === TM1_SQLITE_PHYSICAL_SCHEMA_VERSION &&
    applicationId === TM1_SQLITE_APPLICATION_ID
  ) {
    verifyTm1SqliteSchemaV1(database)
    return 'v1'
  }
  return schemaFailure()
}

export function initializeOrVerifyTm1SqliteSchema(
  database: DatabaseSync,
  createdAt: number
): void {
  if (!Number.isSafeInteger(createdAt) || createdAt < 0) schemaFailure()

  // Schema identity markers are written as separate SQLite statements inside
  // the migration transaction. Serialize before the first inspection so a
  // concurrent opener cannot observe that transaction mid-initialization.
  database.exec('BEGIN IMMEDIATE')
  try {
    const currentState = inspectTm1SqliteSchema(database)
    if (currentState === 'empty') {
      database.exec(TM1_SQLITE_SCHEMA_V1_SQL)
      database.prepare(`
        INSERT INTO tm1_store_metadata (
          singleton_id,
          physical_schema_version,
          created_at
        ) VALUES (1, ?, ?)
      `).run(TM1_SQLITE_PHYSICAL_SCHEMA_VERSION, createdAt)
      database.exec(`PRAGMA application_id = ${TM1_SQLITE_APPLICATION_ID}`)
      database.exec(`PRAGMA user_version = ${TM1_SQLITE_PHYSICAL_SCHEMA_VERSION}`)
    }
    database.exec('COMMIT')
  } catch (error) {
    if (database.isTransaction) {
      try {
        database.exec('ROLLBACK')
      } catch {
        // The original failure remains authoritative.
      }
    }
    throw error
  }
  verifyTm1SqliteSchemaV1(database)
}

export function verifyTm1SqliteSchemaV1(database: DatabaseSync): void {
  if (
    readPragmaInteger(database, 'user_version') !== TM1_SQLITE_PHYSICAL_SCHEMA_VERSION ||
    readPragmaInteger(database, 'application_id') !== TM1_SQLITE_APPLICATION_ID
  ) schemaFailure()

  const metadata = database.prepare(`
    SELECT physical_schema_version, created_at
    FROM tm1_store_metadata
    WHERE singleton_id = 1
  `).all()
  if (
    metadata.length !== 1 ||
    metadata[0].physical_schema_version !== TM1_SQLITE_PHYSICAL_SCHEMA_VERSION ||
    typeof metadata[0].created_at !== 'number' ||
    !Number.isSafeInteger(metadata[0].created_at) ||
    metadata[0].created_at < 0
  ) schemaFailure()

  const actualAttestation = extractV1Attestation(
    database,
    EXPECTED_V1_ATTESTATION.objects
  )
  if (
    JSON.stringify(actualAttestation) !==
    JSON.stringify(EXPECTED_V1_ATTESTATION)
  ) schemaFailure()
}

/**
 * Builds the expected physical-schema evidence from the same canonical SQL
 * used by the v1 migration. The target must match the complete reference
 * catalog and its semantic PRAGMA projections. No unknown user table, index,
 * view or trigger is accepted.
 */
function createExpectedV1Attestation(): Tm1SqliteSchemaAttestation {
  const reference = new DatabaseSync(':memory:', { allowExtension: false })
  try {
    reference.enableLoadExtension(false)
    reference.exec(TM1_SQLITE_SCHEMA_V1_SQL)
    return extractV1Attestation(reference)
  } finally {
    reference.close()
  }
}

function extractV1Attestation(
  database: DatabaseSync,
  expectedObjects?: readonly SqliteSchemaObject[]
): Tm1SqliteSchemaAttestation {
  const objects = database.prepare(`
    SELECT type, name, tbl_name, sql
    FROM sqlite_schema
    WHERE type IN ('table', 'index', 'trigger', 'view')
    ORDER BY type, name
  `).all().map(row => Object.freeze({
    type: requireString(row.type),
    name: requireString(row.name),
    tableName: requireString(row.tbl_name),
    sql: requireNullableString(row.sql)
  }))

  if (
    expectedObjects !== undefined &&
    JSON.stringify(objects) !== JSON.stringify(expectedObjects)
  ) schemaFailure()

  const tables = Object.fromEntries(AUTHORITATIVE_TABLE_NAMES.map(tableName => [
    tableName,
    Object.freeze({
      tableList: queryRows(database, `
        SELECT name, type, ncol, wr, strict
        FROM pragma_table_list
        WHERE schema = 'main' AND name = ?
        ORDER BY name
      `, tableName),
      columns: queryRows(database, `
        SELECT cid, name, type, "notnull", dflt_value, pk, hidden
        FROM pragma_table_xinfo(?)
        ORDER BY cid
      `, tableName),
      foreignKeys: queryRows(database, `
        SELECT id, seq, "table", "from", "to", on_update, on_delete, match
        FROM pragma_foreign_key_list(?)
        ORDER BY id, seq
      `, tableName),
      indexes: queryRows(database, `
        SELECT name, "unique", origin, partial
        FROM pragma_index_list(?)
        ORDER BY name
      `, tableName)
    })
  ]))

  const indexNames = objects
    .filter(object => object.type === 'index')
    .map(object => object.name)
    .sort()
  const indexColumns = Object.fromEntries(indexNames.map(indexName => [
    indexName,
    queryRows(database, `
      SELECT seqno, cid, name, "desc", coll, "key"
      FROM pragma_index_xinfo(?)
      ORDER BY seqno
    `, indexName)
  ]))

  return Object.freeze({
    objects: Object.freeze(objects),
    tables: Object.freeze(tables),
    indexColumns: Object.freeze(indexColumns)
  })
}

function queryRows(
  database: DatabaseSync,
  sql: string,
  parameter: string
): readonly unknown[] {
  return Object.freeze(database.prepare(sql).all(parameter).map(row =>
    Object.freeze(Object.fromEntries(Object.entries(row)))
  ))
}

function requireString(value: unknown): string {
  return typeof value === 'string' ? value : schemaFailure()
}

function requireNullableString(value: unknown): string | null {
  return value === null || typeof value === 'string' ? value : schemaFailure()
}

function readObjectCount(database: DatabaseSync): number {
  const row = database.prepare(`
    SELECT count(*) AS count
    FROM sqlite_schema
  `).get()
  const count = row?.count
  if (typeof count !== 'number' || !Number.isSafeInteger(count) || count < 0) {
    return schemaFailure()
  }
  return count
}

function readPragmaInteger(database: DatabaseSync, name: string): number {
  const row = database.prepare(`PRAGMA ${name}`).get()
  const value = row?.[name]
  if (typeof value !== 'number' || !Number.isSafeInteger(value)) {
    return schemaFailure()
  }
  return value
}

function schemaFailure(): never {
  throw new Tm1PublicationRecoveryStoreError('RECOVERY_STORE_FAILED')
}
