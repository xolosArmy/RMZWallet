import { createHash } from 'node:crypto'
import {
  parseTm1PublicationRecoveryRecord,
  type Tm1PublicationRecoveryRecord
} from '../../../src/integrations/tonalliMemo/recovery/tm1PublicationRecoveryModel'
import { Tm1PublicationRecoveryStoreError } from '../../../src/integrations/tonalliMemo/recovery/tm1PublicationRecoveryStore'
import {
  decodeTm1SqliteIdentifierKey,
  encodeTm1SqliteIdentifierKey
} from './tm1SqliteIdentifierKey'

export const TM1_SQLITE_PHYSICAL_SCHEMA_VERSION = 1
export const TM1_SQLITE_WITNESS_SCHEMA_VERSION = 2
export const TM1_SQLITE_APPLICATION_ID = 0x544d3131
export const TM1_LOGICAL_STATE_ROOT_SCHEMA = 'tonalli.tm1-logical-state-root'
export const TM1_LOGICAL_STATE_ROOT_SCHEMA_VERSION = 1

/**
 * Identifier-bearing TEXT columns below are physical storage keys, never raw
 * domain identifiers. They use `u16:` plus four lowercase hex digits for each
 * JavaScript UTF-16 code unit. Hash/protocol columns remain canonical raw ASCII.
 */
export const TM1_SQLITE_SCHEMA_V1_SQL = `
CREATE TABLE tm1_store_metadata (
  singleton_id INTEGER PRIMARY KEY CHECK (singleton_id = 1),
  physical_schema_version INTEGER NOT NULL CHECK (physical_schema_version = 1),
  created_at INTEGER NOT NULL CHECK (created_at >= 0)
) STRICT;

CREATE TABLE tm1_publications (
  publication_id TEXT PRIMARY KEY,
  domain_schema TEXT NOT NULL CHECK (domain_schema = 'tonalli.tm1-publication-recovery'),
  domain_schema_version INTEGER NOT NULL CHECK (domain_schema_version = 1),
  revision INTEGER NOT NULL CHECK (revision >= 0),
  owner_epoch INTEGER NOT NULL CHECK (owner_epoch >= 0),
  phase TEXT NOT NULL CHECK (
    phase IN (
      'preDispatch',
      'abandoned',
      'outcomeUnknown',
      'submittedObserved',
      'confirmedObserved',
      'failedTerminal'
    )
  ),
  record_json TEXT NOT NULL,
  record_sha256 TEXT NOT NULL CHECK (
    length(record_sha256) = 64 AND record_sha256 NOT GLOB '*[^0-9a-f]*'
  ),
  prepared_id TEXT,
  binding_hash TEXT,
  signed_id TEXT,
  txid TEXT,
  signed_artifact_hash TEXT,
  broadcast_consumed_at INTEGER CHECK (broadcast_consumed_at >= 0),
  dispatch_submission_id TEXT,
  dispatch_capability_id TEXT,
  dispatch_committed_at INTEGER CHECK (dispatch_committed_at >= 0),
  ack_txid TEXT,
  acknowledged_at INTEGER CHECK (acknowledged_at >= 0),
  CHECK (${physicalIdentifierKeyCheck('publication_id')}),
  CHECK (${nullablePhysicalIdentifierKeyCheck('prepared_id')}),
  CHECK (${nullablePhysicalIdentifierKeyCheck('signed_id')}),
  CHECK (${nullablePhysicalIdentifierKeyCheck('dispatch_submission_id')}),
  CHECK (${nullablePhysicalIdentifierKeyCheck('dispatch_capability_id')}),
  CHECK (
    (prepared_id IS NULL AND binding_hash IS NULL) OR
    (prepared_id IS NOT NULL AND binding_hash IS NOT NULL)
  ),
  CHECK (
    (signed_id IS NULL AND txid IS NULL AND signed_artifact_hash IS NULL) OR
    (signed_id IS NOT NULL AND txid IS NOT NULL AND signed_artifact_hash IS NOT NULL)
  ),
  CHECK (
    (dispatch_submission_id IS NULL AND dispatch_capability_id IS NULL AND dispatch_committed_at IS NULL) OR
    (dispatch_submission_id IS NOT NULL AND dispatch_capability_id IS NOT NULL AND dispatch_committed_at IS NOT NULL)
  ),
  CHECK (
    dispatch_committed_at IS NULL OR
    (broadcast_consumed_at IS NOT NULL AND broadcast_consumed_at <= dispatch_committed_at)
  ),
  CHECK (
    (ack_txid IS NULL AND acknowledged_at IS NULL) OR
    (ack_txid IS NOT NULL AND acknowledged_at IS NOT NULL)
  ),
  CHECK (
    acknowledged_at IS NULL OR
    (dispatch_committed_at IS NOT NULL AND dispatch_committed_at <= acknowledged_at)
  ),
  CHECK (ack_txid IS NULL OR ack_txid = txid)
) STRICT;

CREATE INDEX tm1_publications_phase_idx
  ON tm1_publications(phase, publication_id);

CREATE INDEX tm1_publications_txid_idx
  ON tm1_publications(txid)
  WHERE txid IS NOT NULL;

CREATE TABLE tm1_consumed_capabilities (
  capability_id TEXT PRIMARY KEY,
  publication_id TEXT NOT NULL REFERENCES tm1_publications(publication_id) ON DELETE RESTRICT,
  kind TEXT NOT NULL CHECK (kind IN ('SIGN', 'BROADCAST')),
  operation_id TEXT NOT NULL,
  content_hash TEXT NOT NULL CHECK (
    length(content_hash) = 71 AND content_hash GLOB 'sha256:*' AND
    substr(content_hash, 8) NOT GLOB '*[^0-9a-f]*'
  ),
  consumed_at INTEGER NOT NULL CHECK (consumed_at >= 0),
  expires_at INTEGER NOT NULL CHECK (expires_at >= 0),
  prepared_id TEXT,
  binding_hash TEXT,
  signed_id TEXT,
  txid TEXT,
  signed_artifact_hash TEXT,
  CHECK (${physicalIdentifierKeyCheck('capability_id')}),
  CHECK (${physicalIdentifierKeyCheck('publication_id')}),
  CHECK (${physicalIdentifierKeyCheck('operation_id')}),
  CHECK (${nullablePhysicalIdentifierKeyCheck('prepared_id')}),
  CHECK (${nullablePhysicalIdentifierKeyCheck('signed_id')}),
  CHECK (consumed_at < expires_at),
  CHECK (
    (kind = 'SIGN' AND prepared_id IS NOT NULL AND binding_hash IS NOT NULL AND
      signed_id IS NULL AND txid IS NULL AND signed_artifact_hash IS NULL) OR
    (kind = 'BROADCAST' AND prepared_id IS NULL AND binding_hash IS NULL AND
      signed_id IS NOT NULL AND txid IS NOT NULL AND signed_artifact_hash IS NOT NULL)
  ),
  UNIQUE (publication_id, kind)
) STRICT;

CREATE INDEX tm1_consumed_capabilities_publication_idx
  ON tm1_consumed_capabilities(publication_id, kind);
`

export const TM1_SQLITE_SCHEMA_V2_METADATA_SQL = `
CREATE TABLE tm1_store_metadata (
  singleton_id INTEGER PRIMARY KEY CHECK (singleton_id = 1),
  physical_schema_version INTEGER NOT NULL CHECK (physical_schema_version = 2),
  created_at INTEGER NOT NULL CHECK (created_at >= 0)
) STRICT;
`

export const TM1_SQLITE_WITNESS_BINDING_SQL = `
CREATE TABLE tm1_witness_binding (
  singleton_id INTEGER PRIMARY KEY CHECK (singleton_id = 1),
  witness_protocol_version INTEGER NOT NULL CHECK (witness_protocol_version = 1),
  logical_root_schema_version INTEGER NOT NULL CHECK (logical_root_schema_version = 1),
  slot_id TEXT NOT NULL CHECK (${physicalIdentifierKeyCheck('slot_id')}),
  store_id TEXT NOT NULL CHECK (
    length(store_id) = 77 AND
    substr(store_id, 1, 13) = 'tm1-store:v1:' AND
    substr(store_id, 14) NOT GLOB '*[^0-9a-f]*'
  ),
  generation INTEGER NOT NULL CHECK (generation >= 0),
  logical_root TEXT NOT NULL CHECK (
    length(logical_root) = 64 AND logical_root NOT GLOB '*[^0-9a-f]*'
  )
) STRICT;
`

/** Canonical fresh-install schema used to attest an explicitly enrolled store. */
export const TM1_SQLITE_SCHEMA_V2_SQL =
  TM1_SQLITE_SCHEMA_V1_SQL.replace(
    'physical_schema_version INTEGER NOT NULL CHECK (physical_schema_version = 1)',
    'physical_schema_version INTEGER NOT NULL CHECK (physical_schema_version = 2)'
  ) + TM1_SQLITE_WITNESS_BINDING_SQL

export type Tm1SqliteWitnessIdentity = Readonly<{
  slotId: string
  storeId: string
  generation: number
}>

export type Tm1SqliteWitnessBinding = Readonly<
  Tm1SqliteWitnessIdentity & {
    witnessProtocolVersion: 1
    logicalRootSchemaVersion: 1
    logicalRoot: string
  }
>

function physicalIdentifierKeyCheck(column: string): string {
  return `length(${column}) BETWEEN 8 AND 1028 AND ` +
    `substr(${column}, 1, 4) = 'u16:' AND ` +
    `(length(${column}) - 4) % 4 = 0 AND ` +
    `substr(${column}, 5) NOT GLOB '*[^0-9a-f]*'`
}

function nullablePhysicalIdentifierKeyCheck(column: string): string {
  return `${column} IS NULL OR (${physicalIdentifierKeyCheck(column)})`
}

/** Identifier properties in this physical mirror type contain `u16:` keys. */
export type Tm1SqlitePublicationMirrors = Readonly<{
  publicationId: string
  domainSchema: string
  domainSchemaVersion: number
  revision: number
  ownerEpoch: number
  phase: string
  preparedId: string | null
  bindingHash: string | null
  signedId: string | null
  txid: string | null
  signedArtifactHash: string | null
  broadcastConsumedAt: number | null
  dispatchSubmissionId: string | null
  dispatchCapabilityId: string | null
  dispatchCommittedAt: number | null
  ackTxid: string | null
  acknowledgedAt: number | null
}>

/** Identifier properties in this physical evidence type contain `u16:` keys. */
export type Tm1SqliteCapabilityEvidenceRow = Readonly<{
  capabilityId: string
  publicationId: string
  kind: 'SIGN' | 'BROADCAST'
  operationId: string
  contentHash: string
  consumedAt: number
  expiresAt: number
  preparedId: string | null
  bindingHash: string | null
  signedId: string | null
  txid: string | null
  signedArtifactHash: string | null
}>

export type Tm1CanonicalRecoveryRecord = Readonly<{
  record: Tm1PublicationRecoveryRecord
  recordJson: string
  recordSha256: string
  mirrors: Tm1SqlitePublicationMirrors
}>

/**
 * Canonical record encoding for the physical store.
 *
 * The closed domain parser runs first. The resulting JSON-only snapshot is
 * encoded with object keys in lexicographic order, array order preserved and
 * no insignificant whitespace. This rule is independent of caller property
 * insertion order and is the only record encoding accepted on load.
 */
export function canonicalizeTm1RecoveryRecord(
  value: unknown
): Tm1CanonicalRecoveryRecord {
  const record = parseTm1PublicationRecoveryRecord(value)
  const recordJson = encodeCanonicalJson(record)
  return Object.freeze({
    record,
    recordJson,
    recordSha256: sha256Hex(recordJson),
    mirrors: publicationMirrors(record)
  })
}

export function sha256Hex(value: string): string {
  return createHash('sha256').update(value, 'utf8').digest('hex')
}

/**
 * Computes the canonical logical authority root from one coherent, already
 * attested SQLite transaction. Raw database bytes, WAL layout, page order,
 * VACUUM output and SQLite statistics are intentionally excluded.
 */
export function computeTm1LogicalStateRoot(
  database: import('node:sqlite').DatabaseSync,
  identity: Tm1SqliteWitnessIdentity
): string {
  const metadata = database.prepare(`
    SELECT created_at
    FROM tm1_store_metadata
    WHERE singleton_id = 1
  `).all()
  if (
    metadata.length !== 1 ||
    !Number.isSafeInteger(metadata[0].created_at) ||
    (metadata[0].created_at as number) < 0 ||
    !Number.isSafeInteger(identity.generation) ||
    identity.generation < 0
  ) canonicalFailure()

  const publications = database.prepare(`
    SELECT publication_id, record_json, record_sha256
    FROM tm1_publications
    ORDER BY publication_id
  `).all().map(row => Object.freeze({
    publicationId: decodeIdentifier(row.publication_id),
    recordJson: requireCanonicalJsonString(row.record_json),
    recordSha256: requireHash(row.record_sha256)
  }))
  for (const publication of publications) {
    if (sha256Hex(publication.recordJson) !== publication.recordSha256) canonicalFailure()
  }

  const capabilities = database.prepare(`
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
    ORDER BY capability_id
  `).all().map(row => Object.freeze({
    capabilityId: decodeIdentifier(row.capability_id),
    publicationId: decodeIdentifier(row.publication_id),
    kind: requireString(row.kind),
    operationId: decodeIdentifier(row.operation_id),
    contentHash: requireString(row.content_hash),
    consumedAt: requireNonNegativeSafeInteger(row.consumed_at),
    expiresAt: requireNonNegativeSafeInteger(row.expires_at),
    preparedId: decodeNullableIdentifier(row.prepared_id),
    bindingHash: requireNullableString(row.binding_hash),
    signedId: decodeNullableIdentifier(row.signed_id),
    txid: requireNullableString(row.txid),
    signedArtifactHash: requireNullableString(row.signed_artifact_hash)
  }))

  const logicalState = Object.freeze({
    schema: TM1_LOGICAL_STATE_ROOT_SCHEMA,
    schemaVersion: TM1_LOGICAL_STATE_ROOT_SCHEMA_VERSION,
    witnessProtocolVersion: 1,
    physicalSchemaVersion: TM1_SQLITE_WITNESS_SCHEMA_VERSION,
    storeId: requireStoreId(identity.storeId),
    slotId: requireIdentifier(identity.slotId),
    generation: identity.generation,
    createdAt: metadata[0].created_at as number,
    publications: Object.freeze(publications),
    consumedCapabilities: Object.freeze(capabilities)
  })
  return sha256Hex(encodeCanonicalJson(logicalState))
}

export function parseTm1SqliteWitnessBinding(
  value: unknown
): Tm1SqliteWitnessBinding {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) {
    canonicalFailure()
  }
  const source = value as Record<string, unknown>
  if (
    source.witnessProtocolVersion !== 1 ||
    source.logicalRootSchemaVersion !== 1
  ) canonicalFailure()
  return Object.freeze({
    witnessProtocolVersion: 1,
    logicalRootSchemaVersion: 1,
    slotId: requireIdentifier(source.slotId),
    storeId: requireStoreId(source.storeId),
    generation: requireNonNegativeSafeInteger(source.generation),
    logicalRoot: requireHash(source.logicalRoot)
  })
}

export function consumedCapabilityEvidenceRows(
  record: Tm1PublicationRecoveryRecord
): readonly Tm1SqliteCapabilityEvidenceRow[] {
  const signing = record.signingAuthorization
  const broadcast = record.broadcastAuthorization
  return Object.freeze([
    ...(signing === null
      ? []
      : [Object.freeze({
          capabilityId: encodeTm1SqliteIdentifierKey(signing.capabilityId),
          publicationId: encodeTm1SqliteIdentifierKey(record.publicationId),
          kind: 'SIGN' as const,
          operationId: encodeTm1SqliteIdentifierKey(signing.operationId),
          contentHash: signing.contentHash,
          consumedAt: signing.consumedAt,
          expiresAt: signing.expiresAt,
          preparedId: encodeTm1SqliteIdentifierKey(signing.preparedId),
          bindingHash: signing.bindingHash,
          signedId: null,
          txid: null,
          signedArtifactHash: null
        })]),
    ...(broadcast === null
      ? []
      : [Object.freeze({
          capabilityId: encodeTm1SqliteIdentifierKey(broadcast.capabilityId),
          publicationId: encodeTm1SqliteIdentifierKey(record.publicationId),
          kind: 'BROADCAST' as const,
          operationId: encodeTm1SqliteIdentifierKey(broadcast.operationId),
          contentHash: broadcast.contentHash,
          consumedAt: broadcast.consumedAt,
          expiresAt: broadcast.expiresAt,
          preparedId: null,
          bindingHash: null,
          signedId: encodeTm1SqliteIdentifierKey(broadcast.signedId),
          txid: broadcast.txid,
          signedArtifactHash: broadcast.signedArtifactHash
        })])
  ])
}

function publicationMirrors(
  record: Tm1PublicationRecoveryRecord
): Tm1SqlitePublicationMirrors {
  return Object.freeze({
    publicationId: encodeTm1SqliteIdentifierKey(record.publicationId),
    domainSchema: record.schema,
    domainSchemaVersion: record.schemaVersion,
    revision: record.revision,
    ownerEpoch: record.ownerEpoch,
    phase: record.phase,
    preparedId: encodeNullableIdentifier(record.prepared?.preparedId ?? null),
    bindingHash: record.prepared?.bindingHash ?? null,
    signedId: encodeNullableIdentifier(record.signed?.signedId ?? null),
    txid: record.signed?.txid ?? null,
    signedArtifactHash: record.signed?.signedArtifactHash ?? null,
    broadcastConsumedAt: record.broadcastAuthorization?.consumedAt ?? null,
    dispatchSubmissionId: encodeNullableIdentifier(
      record.dispatchIntent?.submissionId ?? null
    ),
    dispatchCapabilityId: encodeNullableIdentifier(
      record.dispatchIntent?.broadcastCapabilityId ?? null
    ),
    dispatchCommittedAt: record.dispatchIntent?.committedAt ?? null,
    ackTxid: record.transportAcknowledgement?.txid ?? null,
    acknowledgedAt: record.transportAcknowledgement?.acknowledgedAt ?? null
  })
}

function encodeNullableIdentifier(value: string | null): string | null {
  return value === null ? null : encodeTm1SqliteIdentifierKey(value)
}

export function encodeCanonicalJson(value: unknown): string {
  if (value === null) return 'null'
  if (typeof value === 'string' || typeof value === 'boolean') {
    return JSON.stringify(value)
  }
  if (typeof value === 'number' && Number.isSafeInteger(value)) {
    return JSON.stringify(value)
  }
  if (Array.isArray(value)) {
    return `[${value.map(encodeCanonicalJson).join(',')}]`
  }
  if (typeof value === 'object') {
    const prototype = Object.getPrototypeOf(value)
    if (prototype !== Object.prototype && prototype !== null) canonicalFailure()
    const record = value as Record<string, unknown>
    return `{${Object.keys(record)
      .sort()
      .map(key => `${JSON.stringify(key)}:${encodeCanonicalJson(record[key])}`)
      .join(',')}}`
  }
  return canonicalFailure()
}

function decodeIdentifier(value: unknown): string {
  try {
    return decodeTm1SqliteIdentifierKey(value)
  } catch {
    return canonicalFailure()
  }
}

function decodeNullableIdentifier(value: unknown): string | null {
  return value === null ? null : decodeIdentifier(value)
}

function requireCanonicalJsonString(value: unknown): string {
  const result = requireString(value)
  let decoded: unknown
  try {
    decoded = JSON.parse(result)
  } catch {
    return canonicalFailure()
  }
  if (encodeCanonicalJson(decoded) !== result) canonicalFailure()
  return result
}

function requireIdentifier(value: unknown): string {
  const result = requireString(value)
  if (
    result.length === 0 ||
    result.length > 256 ||
    result.trim() !== result ||
    result.includes('\0')
  ) canonicalFailure()
  return result
}

function requireStoreId(value: unknown): string {
  const result = requireString(value)
  if (!/^tm1-store:v1:[0-9a-f]{64}$/.test(result)) canonicalFailure()
  return result
}

function requireHash(value: unknown): string {
  const result = requireString(value)
  if (!/^[0-9a-f]{64}$/.test(result)) canonicalFailure()
  return result
}

function requireString(value: unknown): string {
  if (typeof value !== 'string') canonicalFailure()
  return value
}

function requireNullableString(value: unknown): string | null {
  return value === null ? null : requireString(value)
}

function requireNonNegativeSafeInteger(value: unknown): number {
  if (!Number.isSafeInteger(value) || (value as number) < 0) canonicalFailure()
  return value as number
}

function canonicalFailure(): never {
  throw new Tm1PublicationRecoveryStoreError('RECOVERY_STORE_FAILED')
}
