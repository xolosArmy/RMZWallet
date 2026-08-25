import {
  accessSync,
  closeSync,
  constants as fsConstants,
  lstatSync,
  openSync
} from 'node:fs'
import { dirname, isAbsolute, resolve } from 'node:path'
import { performance } from 'node:perf_hooks'
import { DatabaseSync } from 'node:sqlite'
import {
  Tm1PublicationRecoveryError,
  assertTm1DispatchIntentTransition,
  assertTm1ExecutionEvidenceTransition,
  assertTm1OwnershipTransition,
  assertTm1RecoveryTransition,
  assertTm1TransportAcknowledgementTransition,
  consumedCapabilityIds,
  createTm1TransportAcknowledgedRecord,
  parseTm1PublicationRecoveryRecord,
  parseTm1TransportAcknowledgementCommitEvidence,
  type Tm1PublicationRecoveryRecord
} from '../../../src/integrations/tonalliMemo/recovery/tm1PublicationRecoveryModel'
import {
  Tm1PublicationRecoveryStoreError,
  type Tm1PublicationRecoveryStore,
  type Tm1RecoveryStoreCreate,
  type Tm1RecoveryStoreDispatchIntentCommit,
  type Tm1RecoveryStoreExecutionCommit,
  type Tm1RecoveryStoreExpectedVersion,
  type Tm1RecoveryStoreOwnershipClaim,
  type Tm1RecoveryStoreRecoveryCommit,
  type Tm1RecoveryStoreTransportAcknowledgementCommit
} from '../../../src/integrations/tonalliMemo/recovery/tm1PublicationRecoveryStore'
import {
  parseTm1RollbackWitnessRecord,
  type Tm1RollbackWitnessRecord
} from '../../../src/integrations/tonalliMemo/recovery/tm1RollbackWitness'
import {
  initializeOrVerifyTm1SqliteSchema,
  inspectTm1SqliteSchema,
  verifyTm1SqliteSchema,
  verifyTm1SqliteSchemaV1,
  verifyTm1SqliteSchemaV2
} from './tm1SqliteMigrations'
import {
  decodeTm1SqliteIdentifierKey,
  encodeTm1SqliteIdentifierKey
} from './tm1SqliteIdentifierKey'
import {
  TM1_LOGICAL_STATE_ROOT_SCHEMA_VERSION,
  TM1_SQLITE_SCHEMA_V2_METADATA_SQL,
  TM1_SQLITE_WITNESS_BINDING_SQL,
  TM1_SQLITE_WITNESS_SCHEMA_VERSION,
  canonicalizeTm1RecoveryRecord,
  computeTm1LogicalStateRoot,
  consumedCapabilityEvidenceRows,
  parseTm1SqliteWitnessBinding,
  sha256Hex,
  type Tm1CanonicalRecoveryRecord,
  type Tm1SqliteCapabilityEvidenceRow,
  type Tm1SqlitePublicationMirrors,
  type Tm1SqliteWitnessBinding,
  type Tm1SqliteWitnessIdentity
} from './tm1SqliteSchema'

const DEFAULT_BUSY_TIMEOUT_MS = 5_000
const MAX_BUSY_TIMEOUT_MS = 60_000
const WAL_MODE_RETRY_INTERVAL_MS = 10
const WAL_MODE_RETRY_SIGNAL = new Int32Array(new SharedArrayBuffer(4))
const PUBLICATION_COLUMNS = `
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
`

export type Tm1SqlitePublicationRecoveryStoreOptions = Readonly<{
  databasePath: string
  busyTimeoutMs?: number
  now?: () => number
}>

export type Tm1SqliteDurabilityState = Readonly<{
  sqliteVersion: string
  journalMode: 'wal'
  synchronous: 2
  foreignKeys: 1
  trustedSchema: 0
  busyTimeoutMs: number
}>

export type Tm1SqliteWitnessEnrollment = Readonly<{
  slotId: string
  storeId: string
  logicalRoot: string
}>

export type Tm1SqliteWitnessReservationCommit = Readonly<{
  expectedGeneration: number
  expectedLogicalRoot: string
  pendingRecord: Tm1RollbackWitnessRecord
}>

export class Tm1SqlitePublicationRecoveryStore
implements Tm1PublicationRecoveryStore {
  private readonly database: DatabaseSync
  private readonly busyTimeoutMs: number
  private closed = false

  constructor(options: Tm1SqlitePublicationRecoveryStoreOptions) {
    let database: DatabaseSync | undefined
    try {
      const bindings = snapshotOptions(options)
      prepareSecureDatabaseFile(bindings.databasePath)
      database = new DatabaseSync(bindings.databasePath, {
        allowExtension: false,
        enableDoubleQuotedStringLiterals: false,
        enableForeignKeyConstraints: true,
        timeout: bindings.busyTimeoutMs
      })
      database.enableLoadExtension(false)
      database.exec('PRAGMA foreign_keys = ON')
      database.exec('PRAGMA trusted_schema = OFF')
      database.exec(`PRAGMA busy_timeout = ${bindings.busyTimeoutMs}`)

      // Only connection-local safety settings run before this complete
      // identity check. The initializer mutates only an observed empty store.
      const createdAt = readNow(bindings.now)
      initializeOrVerifyTm1SqliteSchema(database, createdAt)
      // WAL is persistent, so it is requested only for an attested TM1 store.
      requestWalMode(database, bindings.busyTimeoutMs)
      if (readPragmaString(database, 'journal_mode') !== 'wal') storeFailure()
      database.exec('PRAGMA synchronous = FULL')
      verifyTm1SqliteSchema(database)

      this.database = database
      this.busyTimeoutMs = bindings.busyTimeoutMs
      this.inspectDurability()
      if (inspectTm1SqliteSchema(database) === 'v2') {
        this.inspectWitnessBinding()
      }
    } catch (error) {
      if (database?.isOpen) {
        try {
          database.close()
        } catch {
          // The original setup failure remains authoritative.
        }
      }
      throw normalizeStoreBoundaryError(error)
    }
  }

  async load(publicationId: string): Promise<unknown | null> {
    try {
      this.assertOpen()
      requirePublicationId(publicationId)
      return this.withReadSnapshot(() => {
        const row = this.selectPublicationRow(publicationId)
        return row === undefined ? null : this.parsePublicationRow(row)
      })
    } catch (error) {
      throw normalizeStoreBoundaryError(error)
    }
  }

  async listRecoverable(): Promise<unknown> {
    try {
      this.assertOpen()
      return this.withReadSnapshot(() => Object.freeze(
        this.selectPublicationRows()
          .map(row => this.parsePublicationRow(row))
          .filter(record =>
            record.phase === 'preDispatch' ||
            record.phase === 'outcomeUnknown' ||
            record.phase === 'submittedObserved'
          )
      ))
    } catch (error) {
      throw normalizeStoreBoundaryError(error)
    }
  }

  async create(input: Tm1RecoveryStoreCreate): Promise<unknown> {
    try {
      this.assertOpen()
      const canonical = canonicalizeTm1RecoveryRecord(readInputRecord(input))
      return this.withImmediateTransaction(() => {
        this.assertLegacyMutationAllowed()
        if (this.selectPublicationRow(canonical.record.publicationId) !== undefined) {
          throw new Tm1PublicationRecoveryStoreError('DUPLICATE_PUBLICATION_ID')
        }
        this.insertPublication(canonical)
        this.insertCapabilityRows(consumedCapabilityEvidenceRows(canonical.record))
        return canonical.record
      })
    } catch (error) {
      throw normalizeStoreBoundaryError(error)
    }
  }

  async commitExecutionEvidence(input: Tm1RecoveryStoreExecutionCommit): Promise<unknown> {
    try {
      this.assertOpen()
      const expected = snapshotExpectedVersion(input)
      const next = canonicalizeTm1RecoveryRecord(readInputRecord(input))
      const declaredCapabilityIds = snapshotIdentifierList(input.newlyConsumedCapabilityIds)
      return this.withImmediateTransaction(() => {
        this.assertLegacyMutationAllowed()
        const current = this.currentForMutation(expected)
        assertTm1ExecutionEvidenceTransition(current, next.record)
        const previousIds = new Set(
          consumedCapabilityIds(current).map(encodeTm1SqliteIdentifierKey)
        )
        const newRows = consumedCapabilityEvidenceRows(next.record).filter(
          row => !previousIds.has(row.capabilityId)
        )
        const actualIds = newRows.map(row => row.capabilityId)
        if (!equalStringLists(
          declaredCapabilityIds.map(encodeTm1SqliteIdentifierKey),
          actualIds
        )) storeFailure()
        this.insertCapabilityRows(newRows)
        this.updatePublication(next, expected)
        return next.record
      })
    } catch (error) {
      throw normalizeStoreBoundaryError(error)
    }
  }

  async commitDispatchIntent(
    input: Tm1RecoveryStoreDispatchIntentCommit
  ): Promise<unknown> {
    try {
      this.assertOpen()
      const expected = snapshotExpectedVersion(input)
      const next = canonicalizeTm1RecoveryRecord(readInputRecord(input))
      return this.withImmediateTransaction(() => {
        this.assertLegacyMutationAllowed()
        const current = this.currentForMutation(expected)
        assertTm1DispatchIntentTransition(current, next.record)
        this.updatePublication(next, expected)
        return next.record
      })
    } catch (error) {
      throw normalizeStoreBoundaryError(error)
    }
  }

  async commitTransportAcknowledgement(
    input: Tm1RecoveryStoreTransportAcknowledgementCommit
  ): Promise<unknown> {
    try {
      this.assertOpen()
      const expected = snapshotExpectedVersion(input)
      const parsedAcknowledgement =
        parseTm1TransportAcknowledgementCommitEvidence(input.acknowledgement)
      const acknowledgement = snapshotUnknown(parsedAcknowledgement)
      return this.withImmediateTransaction(() => {
        this.assertLegacyMutationAllowed()
        const current = this.currentForMutation(expected)
        const nextRecord = createTm1TransportAcknowledgedRecord(current, acknowledgement)
        assertTm1TransportAcknowledgementTransition(current, nextRecord)
        const next = canonicalizeTm1RecoveryRecord(nextRecord)
        this.updatePublication(next, expected)
        return next.record
      })
    } catch (error) {
      throw normalizeStoreBoundaryError(error)
    }
  }

  async commitRecoveryTransition(input: Tm1RecoveryStoreRecoveryCommit): Promise<unknown> {
    try {
      this.assertOpen()
      const expected = snapshotExpectedVersion(input)
      const next = canonicalizeTm1RecoveryRecord(readInputRecord(input))
      return this.withImmediateTransaction(() => {
        this.assertLegacyMutationAllowed()
        const current = this.currentForMutation(expected)
        assertTm1RecoveryTransition(current, next.record)
        this.updatePublication(next, expected)
        return next.record
      })
    } catch (error) {
      throw normalizeStoreBoundaryError(error)
    }
  }

  async claimOwnership(input: Tm1RecoveryStoreOwnershipClaim): Promise<unknown> {
    try {
      this.assertOpen()
      const expected = snapshotExpectedVersion(input)
      const nextOwnerEpoch = requireNonNegativeSafeInteger(input.nextOwnerEpoch)
      return this.withImmediateTransaction(() => {
        this.assertLegacyMutationAllowed()
        const current = this.currentForMutation(expected)
        if (nextOwnerEpoch <= current.ownerEpoch) {
          throw new Tm1PublicationRecoveryStoreError('STALE_OWNER_EPOCH')
        }
        const nextRecord = parseTm1PublicationRecoveryRecord({
          ...current,
          revision: current.revision + 1,
          ownerEpoch: nextOwnerEpoch
        })
        assertTm1OwnershipTransition(current, nextRecord)
        const next = canonicalizeTm1RecoveryRecord(nextRecord)
        this.updatePublication(next, expected)
        return next.record
      })
    } catch (error) {
      throw normalizeStoreBoundaryError(error)
    }
  }

  inspectDurability(): Tm1SqliteDurabilityState {
    try {
      this.assertOpen()
      return this.withReadSnapshot(() => {
        const sqliteVersion = this.database.prepare(
          'SELECT sqlite_version() AS version'
        ).get()?.version
        const journalMode = readPragmaString(this.database, 'journal_mode')
        const synchronous = readPragmaInteger(this.database, 'synchronous')
        const foreignKeys = readPragmaInteger(this.database, 'foreign_keys')
        const trustedSchema = readPragmaInteger(this.database, 'trusted_schema')
        const busyTimeoutMs = readPragmaInteger(this.database, 'busy_timeout', 'timeout')
        if (
          typeof sqliteVersion !== 'string' ||
          journalMode !== 'wal' ||
          synchronous !== 2 ||
          foreignKeys !== 1 ||
          trustedSchema !== 0 ||
          busyTimeoutMs !== this.busyTimeoutMs
        ) storeFailure()
        return Object.freeze({
          sqliteVersion,
          journalMode,
          synchronous,
          foreignKeys,
          trustedSchema,
          busyTimeoutMs
        })
      })
    } catch (error) {
      throw normalizeStoreBoundaryError(error)
    }
  }

  /** Returns null for a legacy, not-yet-enrolled v1 store. */
  inspectWitnessBinding(): Tm1SqliteWitnessBinding | null {
    try {
      this.assertOpen()
      return this.withReadSnapshot(() => {
        if (inspectTm1SqliteSchema(this.database) === 'v1') return null
        const binding = this.readWitnessBinding()
        this.assertLogicalRoot(binding)
        return binding
      })
    } catch (error) {
      throw normalizeStoreBoundaryError(error)
    }
  }

  /** Computes the proposed generation-zero root without mutating a v1 store. */
  computeEnrollmentLogicalRoot(
    identityValue: Omit<Tm1SqliteWitnessIdentity, 'generation'>
  ): string {
    try {
      this.assertOpen()
      const identity = snapshotWitnessIdentity({ ...identityValue, generation: 0 })
      return this.withReadSnapshot(() => {
        if (inspectTm1SqliteSchema(this.database) !== 'v1') storeFailure()
        return computeTm1LogicalStateRoot(this.database, identity)
      })
    } catch (error) {
      throw normalizeStoreBoundaryError(error)
    }
  }

  /** Computes a candidate root for the same enrolled identity at a generation. */
  computeWitnessLogicalRoot(generationValue: number): string {
    try {
      this.assertOpen()
      const generation = requireNonNegativeSafeInteger(generationValue)
      return this.withReadSnapshot(() => {
        if (inspectTm1SqliteSchema(this.database) !== 'v2') storeFailure()
        const current = this.readWitnessBinding()
        this.assertLogicalRoot(current)
        return computeTm1LogicalStateRoot(this.database, Object.freeze({
          slotId: current.slotId,
          storeId: current.storeId,
          generation
        }))
      })
    } catch (error) {
      throw normalizeStoreBoundaryError(error)
    }
  }

  /**
   * Explicit provisioning-only migration. Ordinary startup never calls this.
   * The caller must first authenticate a matching remote enrollment record.
   */
  enrollWitnessBinding(inputValue: Tm1SqliteWitnessEnrollment): Tm1SqliteWitnessBinding {
    try {
      this.assertOpen()
      const input = snapshotWitnessEnrollment(inputValue)
      this.database.exec('BEGIN IMMEDIATE')
      try {
        verifyTm1SqliteSchemaV1(this.database)
        const identity = Object.freeze({
          slotId: input.slotId,
          storeId: input.storeId,
          generation: 0
        })
        if (computeTm1LogicalStateRoot(this.database, identity) !== input.logicalRoot) {
          storeFailure()
        }
        const metadata = this.database.prepare(`
          SELECT created_at
          FROM tm1_store_metadata
          WHERE singleton_id = 1
        `).get()
        const createdAt = requireNonNegativeSafeInteger(metadata?.created_at)
        this.database.exec('DROP TABLE tm1_store_metadata')
        this.database.exec(TM1_SQLITE_SCHEMA_V2_METADATA_SQL)
        this.database.exec(TM1_SQLITE_WITNESS_BINDING_SQL)
        this.database.prepare(`
          INSERT INTO tm1_store_metadata (
            singleton_id, physical_schema_version, created_at
          ) VALUES (1, ?, ?)
        `).run(TM1_SQLITE_WITNESS_SCHEMA_VERSION, createdAt)
        this.database.prepare(`
          INSERT INTO tm1_witness_binding (
            singleton_id,
            witness_protocol_version,
            logical_root_schema_version,
            slot_id,
            store_id,
            generation,
            logical_root
          ) VALUES (1, 1, ?, ?, ?, 0, ?)
        `).run(
          TM1_LOGICAL_STATE_ROOT_SCHEMA_VERSION,
          encodeTm1SqliteIdentifierKey(input.slotId),
          input.storeId,
          input.logicalRoot
        )
        this.database.exec(`PRAGMA user_version = ${TM1_SQLITE_WITNESS_SCHEMA_VERSION}`)
        verifyTm1SqliteSchemaV2(this.database)
        const binding = this.readWitnessBinding()
        this.assertLogicalRoot(binding)
        this.database.exec('COMMIT')
        return binding
      } catch (error) {
        if (this.database.isTransaction) {
          try {
            this.database.exec('ROLLBACK')
          } catch {
            // The original migration failure remains authoritative.
          }
        }
        throw error
      }
    } catch (error) {
      throw normalizeStoreBoundaryError(error)
    }
  }

  /**
   * Persists only a previously reserved witness generation. The record is
   * evidence, not authority; startup must still authenticate it remotely.
   */
  commitReservedWitnessBinding(
    inputValue: Tm1SqliteWitnessReservationCommit
  ): Tm1SqliteWitnessBinding {
    try {
      this.assertOpen()
      const input = snapshotWitnessReservationCommit(inputValue)
      this.database.exec('BEGIN IMMEDIATE')
      try {
        verifyTm1SqliteSchemaV2(this.database)
        const current = this.readWitnessBinding()
        this.assertLogicalRoot(current)
        const pending = input.pendingRecord
        if (
          current.generation !== input.expectedGeneration ||
          current.logicalRoot !== input.expectedLogicalRoot ||
          pending.state !== 'pending' ||
          pending.slotId !== current.slotId ||
          pending.storeId !== current.storeId ||
          pending.generation !== current.generation + 1
        ) storeFailure()
        const nextIdentity = Object.freeze({
          slotId: current.slotId,
          storeId: current.storeId,
          generation: pending.generation
        })
        if (
          computeTm1LogicalStateRoot(this.database, nextIdentity) !==
          pending.logicalRoot
        ) storeFailure()
        const result = this.database.prepare(`
          UPDATE tm1_witness_binding
          SET generation = ?, logical_root = ?
          WHERE singleton_id = 1 AND generation = ? AND logical_root = ?
        `).run(
          pending.generation,
          pending.logicalRoot,
          current.generation,
          current.logicalRoot
        )
        if (!changesEqual(result.changes, 1)) storeFailure()
        const committed = this.readWitnessBinding()
        this.assertLogicalRoot(committed)
        this.database.exec('COMMIT')
        return committed
      } catch (error) {
        if (this.database.isTransaction) {
          try {
            this.database.exec('ROLLBACK')
          } catch {
            // The original binding failure remains authoritative.
          }
        }
        throw error
      }
    } catch (error) {
      throw normalizeStoreBoundaryError(error)
    }
  }

  close(): void {
    if (this.closed) return
    try {
      this.database.close()
      this.closed = true
    } catch (error) {
      throw normalizeStoreBoundaryError(error)
    }
  }

  private assertOpen(): void {
    if (this.closed || !this.database.isOpen) storeFailure()
  }

  private withReadSnapshot<T>(operation: () => T): T {
    if (this.database.isTransaction) {
      // Full attestation per operation is an intentional conservative choice:
      // it binds authoritative reads to the caller-owned snapshot too.
      verifyTm1SqliteSchema(this.database)
      return operation()
    }

    this.database.exec('BEGIN')
    try {
      // Establish and attest the same snapshot used by all hydration queries.
      verifyTm1SqliteSchema(this.database)
      const result = operation()
      this.database.exec('COMMIT')
      return result
    } catch (error) {
      if (this.database.isTransaction) {
        try {
          this.database.exec('ROLLBACK')
        } catch {
          // The original read or validation failure remains authoritative.
        }
      }
      throw error
    }
  }

  private withImmediateTransaction<T>(operation: () => T): T {
    this.database.exec('BEGIN IMMEDIATE')
    try {
      // The reserved write lock closes the DDL TOCTOU after attestation.
      verifyTm1SqliteSchema(this.database)
      const result = operation()
      this.database.exec('COMMIT')
      return result
    } catch (error) {
      if (this.database.isTransaction) {
        try {
          this.database.exec('ROLLBACK')
        } catch {
          // The original transaction failure remains authoritative.
        }
      }
      throw error
    }
  }

  private currentForMutation(
    expected: Tm1RecoveryStoreExpectedVersion
  ): Tm1PublicationRecoveryRecord {
    const row = this.selectPublicationRow(expected.publicationId)
    if (row === undefined) {
      throw new Tm1PublicationRecoveryStoreError('PUBLICATION_NOT_FOUND')
    }
    const current = this.parsePublicationRow(row)
    if (current.revision !== expected.expectedRevision) {
      throw new Tm1PublicationRecoveryStoreError('REVISION_MISMATCH')
    }
    if (current.ownerEpoch !== expected.expectedOwnerEpoch) {
      throw new Tm1PublicationRecoveryStoreError('STALE_OWNER_EPOCH')
    }
    return current
  }

  private assertLegacyMutationAllowed(): void {
    if (inspectTm1SqliteSchema(this.database) !== 'v1') {
      throw new Tm1PublicationRecoveryStoreError('ROLLBACK_WITNESS_REQUIRED')
    }
  }

  private readWitnessBinding(): Tm1SqliteWitnessBinding {
    const rows = this.database.prepare(`
      SELECT
        witness_protocol_version,
        logical_root_schema_version,
        slot_id,
        store_id,
        generation,
        logical_root
      FROM tm1_witness_binding
      WHERE singleton_id = 1
    `).all()
    if (rows.length !== 1) storeFailure()
    return parseTm1SqliteWitnessBinding({
      witnessProtocolVersion: rows[0].witness_protocol_version,
      logicalRootSchemaVersion: rows[0].logical_root_schema_version,
      slotId: decodeWitnessSlotId(rows[0].slot_id),
      storeId: rows[0].store_id,
      generation: rows[0].generation,
      logicalRoot: rows[0].logical_root
    })
  }

  private assertLogicalRoot(binding: Tm1SqliteWitnessBinding): void {
    if (computeTm1LogicalStateRoot(this.database, binding) !== binding.logicalRoot) {
      storeFailure()
    }
  }

  private selectPublicationRow(
    publicationId: string
  ): Record<string, unknown> | undefined {
    return this.database.prepare(`
      SELECT ${PUBLICATION_COLUMNS}
      FROM tm1_publications
      WHERE publication_id = ?
    `).get(encodeTm1SqliteIdentifierKey(publicationId))
  }

  private selectPublicationRows(): Record<string, unknown>[] {
    return this.database.prepare(`
      SELECT ${PUBLICATION_COLUMNS}
      FROM tm1_publications
      ORDER BY publication_id
    `).all()
  }

  private parsePublicationRow(row: Record<string, unknown>): Tm1PublicationRecoveryRecord {
    const recordJson = requireString(row.record_json)
    const recordSha256 = requireCanonicalHash(row.record_sha256)
    if (sha256Hex(recordJson) !== recordSha256) storeFailure()

    let decoded: unknown
    try {
      decoded = JSON.parse(recordJson)
    } catch {
      return storeFailure()
    }
    const canonical = canonicalizeTm1RecoveryRecord(decoded)
    if (
      canonical.recordJson !== recordJson ||
      canonical.recordSha256 !== recordSha256
    ) storeFailure()

    const persistedMirrors = mirrorsFromRow(row)
    assertMirrorsEqual(persistedMirrors, canonical.mirrors)
    this.assertCapabilityRowsMatch(canonical.record)
    return canonical.record
  }

  private assertCapabilityRowsMatch(record: Tm1PublicationRecoveryRecord): void {
    const actualRows = this.database.prepare(`
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
      WHERE publication_id = ?
      ORDER BY kind
    `).all(encodeTm1SqliteIdentifierKey(record.publicationId))
    const expectedRows = [...consumedCapabilityEvidenceRows(record)]
      .sort((left, right) => left.kind.localeCompare(right.kind))
    if (actualRows.length !== expectedRows.length) storeFailure()
    actualRows.forEach((row, index) => {
      assertCapabilityRowEqual(row, expectedRows[index])
    })
  }

  private insertPublication(canonical: Tm1CanonicalRecoveryRecord): void {
    const mirrors = canonical.mirrors
    const result = this.database.prepare(`
      INSERT INTO tm1_publications (
        ${PUBLICATION_COLUMNS}
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
    if (!changesEqual(result.changes, 1)) storeFailure()
  }

  private updatePublication(
    canonical: Tm1CanonicalRecoveryRecord,
    expected: Tm1RecoveryStoreExpectedVersion
  ): void {
    const mirrors = canonical.mirrors
    const result = this.database.prepare(`
      UPDATE tm1_publications
      SET
        domain_schema = ?,
        domain_schema_version = ?,
        revision = ?,
        owner_epoch = ?,
        phase = ?,
        record_json = ?,
        record_sha256 = ?,
        prepared_id = ?,
        binding_hash = ?,
        signed_id = ?,
        txid = ?,
        signed_artifact_hash = ?,
        broadcast_consumed_at = ?,
        dispatch_submission_id = ?,
        dispatch_capability_id = ?,
        dispatch_committed_at = ?,
        ack_txid = ?,
        acknowledged_at = ?
      WHERE publication_id = ? AND revision = ? AND owner_epoch = ?
    `).run(
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
      mirrors.acknowledgedAt,
      encodeTm1SqliteIdentifierKey(expected.publicationId),
      expected.expectedRevision,
      expected.expectedOwnerEpoch
    )
    if (!changesEqual(result.changes, 1)) this.failCas(expected)
  }

  private failCas(expected: Tm1RecoveryStoreExpectedVersion): never {
    const row = this.selectPublicationRow(expected.publicationId)
    if (row === undefined) {
      throw new Tm1PublicationRecoveryStoreError('PUBLICATION_NOT_FOUND')
    }
    const current = this.parsePublicationRow(row)
    if (current.revision !== expected.expectedRevision) {
      throw new Tm1PublicationRecoveryStoreError('REVISION_MISMATCH')
    }
    if (current.ownerEpoch !== expected.expectedOwnerEpoch) {
      throw new Tm1PublicationRecoveryStoreError('STALE_OWNER_EPOCH')
    }
    return storeFailure()
  }

  private insertCapabilityRows(
    rows: readonly Tm1SqliteCapabilityEvidenceRow[]
  ): void {
    const seen = new Set<string>()
    for (const row of rows) {
      if (seen.has(row.capabilityId) || this.capabilityKeyExists(row.capabilityId)) {
        throw new Tm1PublicationRecoveryStoreError(
          'DUPLICATE_CAPABILITY_CONSUMPTION'
        )
      }
      seen.add(row.capabilityId)
    }
    const insert = this.database.prepare(`
      INSERT INTO tm1_consumed_capabilities (
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
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `)
    for (const row of rows) {
      const result = insert.run(
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
      if (!changesEqual(result.changes, 1)) storeFailure()
    }
  }

  private capabilityKeyExists(capabilityKey: string): boolean {
    return this.database.prepare(`
      SELECT 1 AS present
      FROM tm1_consumed_capabilities
      WHERE capability_id = ?
    `).get(capabilityKey)?.present === 1
  }
}

export function createTm1SqlitePublicationRecoveryStore(
  options: Tm1SqlitePublicationRecoveryStoreOptions
): Tm1SqlitePublicationRecoveryStore {
  return new Tm1SqlitePublicationRecoveryStore(options)
}

type SafeOptions = Readonly<{
  databasePath: string
  busyTimeoutMs: number
  now: () => number
}>

function snapshotOptions(
  options: Tm1SqlitePublicationRecoveryStoreOptions
): SafeOptions {
  if (!options || typeof options !== 'object') storeFailure()
  const databasePath = options.databasePath
  const busyTimeoutMs = options.busyTimeoutMs ?? DEFAULT_BUSY_TIMEOUT_MS
  const now = options.now ?? Date.now
  if (
    typeof databasePath !== 'string' ||
    databasePath.length === 0 ||
    databasePath.includes('\0') ||
    !isAbsolute(databasePath) ||
    resolve(databasePath) !== databasePath ||
    databasePath === ':memory:' ||
    !Number.isSafeInteger(busyTimeoutMs) ||
    busyTimeoutMs < 1 ||
    busyTimeoutMs > MAX_BUSY_TIMEOUT_MS ||
    typeof now !== 'function'
  ) storeFailure()
  return Object.freeze({ databasePath, busyTimeoutMs, now })
}

function prepareSecureDatabaseFile(databasePath: string): void {
  const parent = dirname(databasePath)
  const parentStat = lstatSync(parent)
  if (!parentStat.isDirectory() || parentStat.isSymbolicLink()) storeFailure()
  if (process.platform !== 'win32') {
    if ((parentStat.mode & 0o077) !== 0) storeFailure()
  }

  ensureDatabaseFile(databasePath)
  const databaseStat = lstatSync(databasePath)
  if (!databaseStat.isFile() || databaseStat.isSymbolicLink()) storeFailure()
  if (
    process.platform !== 'win32' &&
    ((databaseStat.mode & 0o600) !== 0o600 || (databaseStat.mode & 0o077) !== 0)
  ) storeFailure()
  accessSync(databasePath, fsConstants.R_OK | fsConstants.W_OK)
}

function ensureDatabaseFile(databasePath: string): void {
  let descriptor: number
  try {
    descriptor = openSync(databasePath, 'wx', 0o600)
  } catch (error) {
    if (isFileAlreadyExistsError(error)) return
    throw error
  }
  closeSync(descriptor)
}

function isFileAlreadyExistsError(error: unknown): boolean {
  return (
    error !== null &&
    typeof error === 'object' &&
    'code' in error &&
    error.code === 'EEXIST'
  )
}

function requestWalMode(database: DatabaseSync, busyTimeoutMs: number): void {
  const deadline = performance.now() + busyTimeoutMs
  while (true) {
    try {
      if (readPragmaString(database, 'journal_mode', 'WAL') === 'wal') return
    } catch (error) {
      if (!isSqliteBusyError(error)) throw error
    }

    try {
      if (readPragmaString(database, 'journal_mode') === 'wal') return
    } catch (error) {
      if (!isSqliteBusyError(error)) throw error
    }

    const remainingMs = deadline - performance.now()
    if (remainingMs <= 0) storeFailure()
    Atomics.wait(
      WAL_MODE_RETRY_SIGNAL,
      0,
      0,
      Math.min(WAL_MODE_RETRY_INTERVAL_MS, remainingMs)
    )
  }
}

function isSqliteBusyError(error: unknown): boolean {
  return (
    error !== null &&
    typeof error === 'object' &&
    'code' in error &&
    error.code === 'ERR_SQLITE_ERROR' &&
    'errcode' in error &&
    error.errcode === 5
  )
}

function snapshotExpectedVersion(
  value: Tm1RecoveryStoreExpectedVersion
): Tm1RecoveryStoreExpectedVersion {
  if (!value || typeof value !== 'object') storeFailure()
  return Object.freeze({
    publicationId: requirePublicationId(value.publicationId),
    expectedRevision: requireNonNegativeSafeInteger(value.expectedRevision),
    expectedOwnerEpoch: requireNonNegativeSafeInteger(value.expectedOwnerEpoch)
  })
}

function snapshotWitnessIdentity(
  value: Tm1SqliteWitnessIdentity
): Tm1SqliteWitnessIdentity {
  const source = exactDataRecord(value, ['slotId', 'storeId', 'generation'])
  return Object.freeze({
    slotId: requirePublicationId(readDataProperty(source, 'slotId')),
    storeId: requireStoreId(readDataProperty(source, 'storeId')),
    generation: requireNonNegativeSafeInteger(readDataProperty(source, 'generation'))
  })
}

function snapshotWitnessEnrollment(
  value: Tm1SqliteWitnessEnrollment
): Tm1SqliteWitnessEnrollment {
  const source = exactDataRecord(value, ['slotId', 'storeId', 'logicalRoot'])
  return Object.freeze({
    slotId: requirePublicationId(readDataProperty(source, 'slotId')),
    storeId: requireStoreId(readDataProperty(source, 'storeId')),
    logicalRoot: requireCanonicalHash(readDataProperty(source, 'logicalRoot'))
  })
}

function snapshotWitnessReservationCommit(
  value: Tm1SqliteWitnessReservationCommit
): Tm1SqliteWitnessReservationCommit {
  const source = exactDataRecord(value, [
    'expectedGeneration', 'expectedLogicalRoot', 'pendingRecord'
  ])
  return Object.freeze({
    expectedGeneration: requireNonNegativeSafeInteger(
      readDataProperty(source, 'expectedGeneration')
    ),
    expectedLogicalRoot: requireCanonicalHash(
      readDataProperty(source, 'expectedLogicalRoot')
    ),
    pendingRecord: parseTm1RollbackWitnessRecord(
      readDataProperty(source, 'pendingRecord')
    )
  })
}

function exactDataRecord(
  value: unknown,
  expectedKeys: readonly string[]
): Record<string, unknown> {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) {
    return storeFailure()
  }
  let prototype: object | null
  let keys: readonly PropertyKey[]
  try {
    prototype = Object.getPrototypeOf(value)
    keys = Reflect.ownKeys(value)
  } catch {
    return storeFailure()
  }
  if (
    prototype !== Object.prototype && prototype !== null ||
    keys.length !== expectedKeys.length ||
    keys.some(key => typeof key !== 'string' || !expectedKeys.includes(key)) ||
    expectedKeys.some(key => !keys.includes(key))
  ) return storeFailure()
  return value as Record<string, unknown>
}

function readDataProperty(source: Record<string, unknown>, key: string): unknown {
  let descriptor: PropertyDescriptor | undefined
  try {
    descriptor = Object.getOwnPropertyDescriptor(source, key)
  } catch {
    return storeFailure()
  }
  if (descriptor === undefined || !('value' in descriptor)) return storeFailure()
  return descriptor.value
}

function decodeWitnessSlotId(value: unknown): string {
  try {
    return requirePublicationId(decodeTm1SqliteIdentifierKey(value))
  } catch {
    return storeFailure()
  }
}

function requireStoreId(value: unknown): string {
  const result = requireString(value)
  if (!/^tm1-store:v1:[0-9a-f]{64}$/.test(result)) return storeFailure()
  return result
}

function readInputRecord(input: { readonly nextRecord?: unknown; readonly record?: unknown }): unknown {
  if (!input || typeof input !== 'object') storeFailure()
  if ('nextRecord' in input) return input.nextRecord
  if ('record' in input) return input.record
  return storeFailure()
}

function snapshotIdentifierList(value: unknown): readonly string[] {
  if (!Array.isArray(value)) storeFailure()
  const result = value.map(requirePublicationId)
  if (new Set(result).size !== result.length) storeFailure()
  return Object.freeze(result)
}

function snapshotUnknown(value: unknown): unknown {
  if (value === null || typeof value !== 'object') return value
  if (Array.isArray(value)) return Object.freeze(value.map(snapshotUnknown))
  const source = value as Record<string, unknown>
  const result: Record<string, unknown> = {}
  for (const key of Object.keys(source)) result[key] = snapshotUnknown(source[key])
  return Object.freeze(result)
}

function mirrorsFromRow(row: Record<string, unknown>): Tm1SqlitePublicationMirrors {
  return Object.freeze({
    publicationId: requireString(row.publication_id),
    domainSchema: requireString(row.domain_schema),
    domainSchemaVersion: requireNonNegativeSafeInteger(row.domain_schema_version),
    revision: requireNonNegativeSafeInteger(row.revision),
    ownerEpoch: requireNonNegativeSafeInteger(row.owner_epoch),
    phase: requireString(row.phase),
    preparedId: requireNullableString(row.prepared_id),
    bindingHash: requireNullableString(row.binding_hash),
    signedId: requireNullableString(row.signed_id),
    txid: requireNullableString(row.txid),
    signedArtifactHash: requireNullableString(row.signed_artifact_hash),
    broadcastConsumedAt: requireNullableSafeInteger(row.broadcast_consumed_at),
    dispatchSubmissionId: requireNullableString(row.dispatch_submission_id),
    dispatchCapabilityId: requireNullableString(row.dispatch_capability_id),
    dispatchCommittedAt: requireNullableSafeInteger(row.dispatch_committed_at),
    ackTxid: requireNullableString(row.ack_txid),
    acknowledgedAt: requireNullableSafeInteger(row.acknowledged_at)
  })
}

function assertMirrorsEqual(
  actual: Tm1SqlitePublicationMirrors,
  expected: Tm1SqlitePublicationMirrors
): void {
  for (const key of Object.keys(expected) as (keyof Tm1SqlitePublicationMirrors)[]) {
    if (actual[key] !== expected[key]) storeFailure()
  }
}

function assertCapabilityRowEqual(
  actual: Record<string, unknown>,
  expected: Tm1SqliteCapabilityEvidenceRow | undefined
): void {
  if (expected === undefined) storeFailure()
  const values = Object.freeze({
    capabilityId: requireString(actual.capability_id),
    publicationId: requireString(actual.publication_id),
    kind: requireString(actual.kind),
    operationId: requireString(actual.operation_id),
    contentHash: requireString(actual.content_hash),
    consumedAt: requireNonNegativeSafeInteger(actual.consumed_at),
    expiresAt: requireNonNegativeSafeInteger(actual.expires_at),
    preparedId: requireNullableString(actual.prepared_id),
    bindingHash: requireNullableString(actual.binding_hash),
    signedId: requireNullableString(actual.signed_id),
    txid: requireNullableString(actual.txid),
    signedArtifactHash: requireNullableString(actual.signed_artifact_hash)
  })
  for (const key of Object.keys(expected) as (keyof Tm1SqliteCapabilityEvidenceRow)[]) {
    if (values[key] !== expected[key]) storeFailure()
  }
}

function requirePublicationId(value: unknown): string {
  const result = requireString(value)
  if (result.length > 256 || result.trim() !== result || result.length === 0) {
    return storeFailure()
  }
  return result
}

function requireCanonicalHash(value: unknown): string {
  const result = requireString(value)
  if (!/^[0-9a-f]{64}$/.test(result)) return storeFailure()
  return result
}

function requireString(value: unknown): string {
  if (typeof value !== 'string') return storeFailure()
  return value
}

function requireNullableString(value: unknown): string | null {
  if (value === null) return null
  return requireString(value)
}

function requireNonNegativeSafeInteger(value: unknown): number {
  if (!Number.isSafeInteger(value) || (value as number) < 0) return storeFailure()
  return value as number
}

function requireNullableSafeInteger(value: unknown): number | null {
  if (value === null) return null
  return requireNonNegativeSafeInteger(value)
}

function readNow(now: () => number): number {
  let value: unknown
  try {
    value = now()
  } catch {
    return storeFailure()
  }
  return requireNonNegativeSafeInteger(value)
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
  if (typeof value !== 'string') return storeFailure()
  return value.toLowerCase()
}

function readPragmaInteger(
  database: DatabaseSync,
  pragma: string,
  resultKey = pragma
): number {
  const value = database.prepare(`PRAGMA ${pragma}`).get()?.[resultKey]
  return requireNonNegativeSafeInteger(value)
}

function equalStringLists(left: readonly string[], right: readonly string[]): boolean {
  return left.length === right.length && left.every((value, index) => value === right[index])
}

function changesEqual(value: number | bigint, expected: number): boolean {
  return value === expected || value === BigInt(expected)
}

function normalizeStoreBoundaryError(error: unknown): never {
  if (
    error instanceof Tm1PublicationRecoveryStoreError ||
    error instanceof Tm1PublicationRecoveryError
  ) throw error
  throw new Tm1PublicationRecoveryStoreError('RECOVERY_STORE_FAILED')
}

function storeFailure(): never {
  throw new Tm1PublicationRecoveryStoreError('RECOVERY_STORE_FAILED')
}
