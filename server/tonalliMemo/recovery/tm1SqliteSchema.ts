import { createHash } from 'node:crypto'
import {
  parseTm1PublicationRecoveryRecord,
  type Tm1PublicationRecoveryRecord
} from '../../../src/integrations/tonalliMemo/recovery/tm1PublicationRecoveryModel'
import { Tm1PublicationRecoveryStoreError } from '../../../src/integrations/tonalliMemo/recovery/tm1PublicationRecoveryStore'
import { encodeTm1SqliteIdentifierKey } from './tm1SqliteIdentifierKey'

export const TM1_SQLITE_PHYSICAL_SCHEMA_VERSION = 1
export const TM1_SQLITE_APPLICATION_ID = 0x544d3131

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

function encodeCanonicalJson(value: unknown): string {
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

function canonicalFailure(): never {
  throw new Tm1PublicationRecoveryStoreError('RECOVERY_STORE_FAILED')
}
