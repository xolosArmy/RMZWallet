import { DatabaseSync } from 'node:sqlite'
import { Tm1PublicationRecoveryStoreError } from '../../../src/integrations/tonalliMemo/recovery/tm1PublicationRecoveryStore'
import {
  TM1_SQLITE_APPLICATION_ID,
  TM1_SQLITE_PHYSICAL_SCHEMA_VERSION,
  TM1_SQLITE_SCHEMA_V1_SQL,
  TM1_SQLITE_SCHEMA_V2_SQL,
  TM1_SQLITE_WITNESS_SCHEMA_VERSION
} from './tm1SqliteSchema'

export type Tm1SqliteSchemaState = 'empty' | 'v1' | 'v2'

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

type SqliteStatisticsTableAttestation = Readonly<{
  object: SqliteSchemaObject
  definition: SqliteTableDefinition
}>

type Tm1ExpectedAttestation = Readonly<{
  authoritative: Tm1SqliteSchemaAttestation
  statistics: readonly SqliteStatisticsTableAttestation[]
}>

const V1_AUTHORITATIVE_TABLE_NAMES = Object.freeze([
  'tm1_store_metadata',
  'tm1_publications',
  'tm1_consumed_capabilities'
])
const V2_AUTHORITATIVE_TABLE_NAMES = Object.freeze([
  ...V1_AUTHORITATIVE_TABLE_NAMES,
  'tm1_witness_binding'
])

const SQLITE_STATISTICS_TABLE_NAME = /^sqlite_stat[1-9][0-9]*$/

const EXPECTED_V1_ATTESTATION = createExpectedAttestation(
  TM1_SQLITE_SCHEMA_V1_SQL,
  V1_AUTHORITATIVE_TABLE_NAMES
)
const EXPECTED_V2_ATTESTATION = createExpectedAttestation(
  TM1_SQLITE_SCHEMA_V2_SQL,
  V2_AUTHORITATIVE_TABLE_NAMES
)

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
  if (
    userVersion === TM1_SQLITE_WITNESS_SCHEMA_VERSION &&
    applicationId === TM1_SQLITE_APPLICATION_ID
  ) {
    verifyTm1SqliteSchemaV2(database)
    return 'v2'
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
  verifyTm1SqliteSchema(database)
}

export function verifyTm1SqliteSchema(database: DatabaseSync): void {
  const version = readPragmaInteger(database, 'user_version')
  if (version === TM1_SQLITE_PHYSICAL_SCHEMA_VERSION) {
    verifyTm1SqliteSchemaV1(database)
    return
  }
  if (version === TM1_SQLITE_WITNESS_SCHEMA_VERSION) {
    verifyTm1SqliteSchemaV2(database)
    return
  }
  schemaFailure()
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

  const actualObjects = readSchemaObjects(database)
  const authoritativeObjects = verifyAndRemoveEngineStatistics(
    database,
    actualObjects,
    EXPECTED_V1_ATTESTATION
  )
  const actualAttestation = extractAttestation(
    database,
    V1_AUTHORITATIVE_TABLE_NAMES,
    authoritativeObjects
  )
  if (
    JSON.stringify(actualAttestation) !==
    JSON.stringify(EXPECTED_V1_ATTESTATION.authoritative)
  ) schemaFailure()
}

export function verifyTm1SqliteSchemaV2(database: DatabaseSync): void {
  if (
    readPragmaInteger(database, 'user_version') !== TM1_SQLITE_WITNESS_SCHEMA_VERSION ||
    readPragmaInteger(database, 'application_id') !== TM1_SQLITE_APPLICATION_ID
  ) schemaFailure()

  const metadata = database.prepare(`
    SELECT physical_schema_version, created_at
    FROM tm1_store_metadata
    WHERE singleton_id = 1
  `).all()
  const binding = database.prepare(`
    SELECT singleton_id
    FROM tm1_witness_binding
    WHERE singleton_id = 1
  `).all()
  if (
    metadata.length !== 1 ||
    metadata[0].physical_schema_version !== TM1_SQLITE_WITNESS_SCHEMA_VERSION ||
    typeof metadata[0].created_at !== 'number' ||
    !Number.isSafeInteger(metadata[0].created_at) ||
    metadata[0].created_at < 0 ||
    binding.length !== 1 ||
    binding[0].singleton_id !== 1
  ) schemaFailure()

  const actualObjects = readSchemaObjects(database)
  const authoritativeObjects = verifyAndRemoveEngineStatistics(
    database,
    actualObjects,
    EXPECTED_V2_ATTESTATION
  )
  const actualAttestation = extractAttestation(
    database,
    V2_AUTHORITATIVE_TABLE_NAMES,
    authoritativeObjects
  )
  if (
    JSON.stringify(actualAttestation) !==
    JSON.stringify(EXPECTED_V2_ATTESTATION.authoritative)
  ) schemaFailure()
}

/**
 * Builds the expected physical-schema evidence from the same canonical SQL
 * used by the v1 migration. ANALYZE on that pristine reference derives the
 * only optional engine statistics tables. The authoritative catalog and every
 * present statistics structure must match their semantic PRAGMA projections;
 * no unknown user table, index, view or trigger is accepted.
 */
function createExpectedAttestation(
  schemaSql: string,
  tableNames: readonly string[]
): Tm1ExpectedAttestation {
  const reference = new DatabaseSync(':memory:', { allowExtension: false })
  try {
    reference.enableLoadExtension(false)
    reference.exec(schemaSql)
    const authoritative = extractAttestation(reference, tableNames)
    reference.exec('ANALYZE')
    const analyzedObjects = readSchemaObjects(reference)
    const authoritativeNames = new Set(authoritative.objects.map(object => object.name))
    const analyzedAuthoritative = analyzedObjects.filter(
      object => authoritativeNames.has(object.name)
    )
    if (
      JSON.stringify(analyzedAuthoritative) !==
      JSON.stringify(authoritative.objects)
    ) schemaFailure()
    const statisticsObjects = analyzedObjects.filter(
      object => !authoritativeNames.has(object.name)
    )
    const statistics = statisticsObjects.map(object => {
      if (
        object.type !== 'table' ||
        object.tableName !== object.name ||
        object.sql === null ||
        !SQLITE_STATISTICS_TABLE_NAME.test(object.name)
      ) schemaFailure()
      return Object.freeze({
        object,
        definition: extractTableDefinition(reference, object.name)
      })
    })
    if (new Set(statistics.map(entry => entry.object.name)).size !== statistics.length) {
      schemaFailure()
    }
    return Object.freeze({
      authoritative,
      statistics: Object.freeze(statistics)
    })
  } finally {
    reference.close()
  }
}

function verifyAndRemoveEngineStatistics(
  database: DatabaseSync,
  objects: readonly SqliteSchemaObject[],
  expectedAttestation: Tm1ExpectedAttestation
): readonly SqliteSchemaObject[] {
  const expectedStatistics = new Map(
    expectedAttestation.statistics.map(entry => [entry.object.name, entry])
  )
  const authoritative: SqliteSchemaObject[] = []
  const observedStatistics = new Set<string>()
  for (const object of objects) {
    const expected = expectedStatistics.get(object.name)
    if (expected === undefined) {
      authoritative.push(object)
      continue
    }
    if (
      observedStatistics.has(object.name) ||
      JSON.stringify(object) !== JSON.stringify(expected.object) ||
      JSON.stringify(extractTableDefinition(database, object.name)) !==
        JSON.stringify(expected.definition)
    ) schemaFailure()
    observedStatistics.add(object.name)
  }
  return Object.freeze(authoritative)
}

function extractAttestation(
  database: DatabaseSync,
  tableNames: readonly string[],
  objects: readonly SqliteSchemaObject[] = readSchemaObjects(database)
): Tm1SqliteSchemaAttestation {
  const tables = Object.fromEntries(tableNames.map(tableName => [
    tableName,
    extractTableDefinition(database, tableName)
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

function readSchemaObjects(database: DatabaseSync): readonly SqliteSchemaObject[] {
  return Object.freeze(database.prepare(`
    SELECT type, name, tbl_name, sql
    FROM sqlite_schema
    WHERE type IN ('table', 'index', 'trigger', 'view')
    ORDER BY type, name
  `).all().map(row => Object.freeze({
    type: requireString(row.type),
    name: requireString(row.name),
    tableName: requireString(row.tbl_name),
    sql: requireNullableString(row.sql)
  })))
}

function extractTableDefinition(
  database: DatabaseSync,
  tableName: string
): SqliteTableDefinition {
  return Object.freeze({
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
