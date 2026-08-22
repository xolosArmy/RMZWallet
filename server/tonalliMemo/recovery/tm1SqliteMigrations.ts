import type { DatabaseSync } from 'node:sqlite'
import { Tm1PublicationRecoveryStoreError } from '../../../src/integrations/tonalliMemo/recovery/tm1PublicationRecoveryStore'
import {
  TM1_SQLITE_APPLICATION_ID,
  TM1_SQLITE_PHYSICAL_SCHEMA_VERSION,
  TM1_SQLITE_SCHEMA_V1_SQL
} from './tm1SqliteSchema'

export type Tm1SqliteSchemaState = 'empty' | 'v1'

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
  expectedState: Tm1SqliteSchemaState,
  createdAt: number
): void {
  if (!Number.isSafeInteger(createdAt) || createdAt < 0) schemaFailure()
  if (expectedState === 'v1') {
    verifyTm1SqliteSchemaV1(database)
    return
  }

  database.exec('BEGIN IMMEDIATE')
  try {
    const currentState = inspectTm1SqliteSchema(database)
    if (currentState === 'v1') {
      database.exec('COMMIT')
      return
    }
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

  database.prepare(`
    SELECT
      publication_id,
      domain_schema,
      domain_schema_version,
      revision,
      owner_epoch,
      phase,
      record_json,
      record_sha256,
      prepared_id,
      binding_hash,
      signed_id,
      txid,
      signed_artifact_hash,
      broadcast_consumed_at,
      dispatch_submission_id,
      dispatch_capability_id,
      dispatch_committed_at,
      ack_txid,
      acknowledged_at
    FROM tm1_publications
    LIMIT 0
  `)
  database.prepare(`
    SELECT
      capability_id,
      publication_id,
      kind,
      operation_id,
      content_hash,
      consumed_at,
      expires_at,
      prepared_id,
      binding_hash,
      signed_id,
      txid,
      signed_artifact_hash
    FROM tm1_consumed_capabilities
    LIMIT 0
  `)
}

function readObjectCount(database: DatabaseSync): number {
  const row = database.prepare(`
    SELECT count(*) AS count
    FROM sqlite_master
    WHERE name NOT LIKE 'sqlite_%'
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
