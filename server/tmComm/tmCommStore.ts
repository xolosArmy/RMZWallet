import { mkdirSync } from 'node:fs'
import { dirname } from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import type {
  TmCommAuditEvent,
  TmCommConversation,
  TmCommMessage,
  TmCommMessageReceipt,
  TmCommPrincipal,
  TmCommReservationBinding,
  TmCommSenderKind
} from '../../src/features/privateMessaging/types'
import { createTmCommId } from './tmCommIds'
import {
  TM_COMM_SQLITE_APPLICATION_ID,
  TM_COMM_SQLITE_SCHEMA_SQL,
  TM_COMM_SQLITE_SCHEMA_VERSION
} from './tmCommSchema'
export { TM_COMM_SQLITE_APPLICATION_ID, TM_COMM_SQLITE_SCHEMA_VERSION } from './tmCommSchema'

export type TmCommChallengeRecord = Readonly<{
  id: string
  nonceHash: string
  audience: string
  origin: string
  sessionContext: string
  canonicalMessage: string
  expiresAt: number
  consumedAt: number | null
  createdAt: number
}>

export type TmCommSessionRecord = Readonly<{
  id: string
  tokenHash: string
  principalId: string
  challengeId: string
  audience: string
  expiresAt: number
  createdAt: number
  revokedAt: number | null
}>

export type TmCommEnrollmentRecord = Readonly<{
  id: string
  tokenHash: string
  reservationId: string
  expectedEmail: string | null
  issuedBy: 'xolos-ramirez-operator'
  expiresAt: number
  consumedAt: number | null
  consumedByPrincipalId: string | null
  createdAt: number
}>

type SqlRow = Record<string, unknown>

const asString = (value: unknown): string => {
  if (typeof value !== 'string') throw new Error('TM-COMM store row is malformed.')
  return value
}

const asNullableString = (value: unknown): string | null => {
  if (value === null || value === undefined) return null
  if (typeof value !== 'string') throw new Error('TM-COMM store row is malformed.')
  return value
}

const asNumber = (value: unknown): number => {
  if (typeof value !== 'number' || !Number.isInteger(value)) {
    throw new Error('TM-COMM store row is malformed.')
  }
  return value
}

const asNullableNumber = (value: unknown): number | null => {
  if (value === null || value === undefined) return null
  return asNumber(value)
}

export class TmCommMetadataMismatchError extends Error {
  readonly code = 'TM_COMM_METADATA_MISMATCH'

  constructor(message: string) {
    super(`TM_COMM_METADATA_MISMATCH: ${message}`)
    this.name = 'TmCommMetadataMismatchError'
  }
}

export class TmCommStore {
  readonly databasePath: string
  private readonly database: DatabaseSync
  private closed = false

  constructor(databasePath: string, now: () => number = () => Date.now()) {
    this.databasePath = databasePath
    if (databasePath !== ':memory:') {
      mkdirSync(dirname(databasePath), { recursive: true, mode: 0o700 })
    }
    this.database = new DatabaseSync(databasePath, {
      allowExtension: false,
      enableDoubleQuotedStringLiterals: false,
      enableForeignKeyConstraints: true
    })
    try {
      this.database.enableLoadExtension(false)
      this.database.exec('PRAGMA foreign_keys = ON')
      this.database.exec('PRAGMA trusted_schema = OFF')
      this.database.exec('PRAGMA busy_timeout = 5000')
      if (databasePath !== ':memory:') {
        this.database.exec('PRAGMA journal_mode = WAL')
        this.database.exec('PRAGMA synchronous = FULL')
      }
      this.initializeSchemaAndMetadata(now)
    } catch (error) {
      this.close()
      throw error
    }
  }

  private initializeSchemaAndMetadata(now: () => number): void {
    const tables = this.database.prepare(
      "SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%'"
    ).all() as Array<{ name: string }>

    if (tables.length === 0) {
      // Empty / brand-new database: create schema, insert canonical metadata, verify
      this.database.exec(TM_COMM_SQLITE_SCHEMA_SQL)
      this.database.prepare(`
        INSERT INTO tm_comm_metadata (
          singleton_id, schema_version, application_id, environment, created_at
        ) VALUES (1, ?, ?, 'staging', ?)
      `).run(
        TM_COMM_SQLITE_SCHEMA_VERSION,
        TM_COMM_SQLITE_APPLICATION_ID,
        now()
      )
      this.verifyCanonicalMetadata()
      return
    }

    // Existing non-empty database: check tm_comm_metadata existence and validate
    const hasMetadataTable = tables.some((t) => t.name === 'tm_comm_metadata')
    if (!hasMetadataTable) {
      throw new TmCommMetadataMismatchError(
        'Non-empty database does not contain tm_comm_metadata table.'
      )
    }

    this.verifyCanonicalMetadata()

    // Once metadata is validated to be completely compatible, we can safely ensure schema definition
    this.database.exec(TM_COMM_SQLITE_SCHEMA_SQL)
  }

  private verifyCanonicalMetadata(): void {
    let row: SqlRow | undefined
    try {
      row = this.database.prepare(
        'SELECT singleton_id, schema_version, application_id, environment FROM tm_comm_metadata WHERE singleton_id = 1'
      ).get() as SqlRow | undefined
    } catch (err) {
      throw new TmCommMetadataMismatchError(
        `Failed to read tm_comm_metadata: ${err instanceof Error ? err.message : String(err)}`
      )
    }

    if (row === undefined) {
      throw new TmCommMetadataMismatchError(
        'Singleton metadata row (singleton_id = 1) is missing.'
      )
    }

    const schemaVersion = row.schema_version
    const applicationId = row.application_id
    const environment = row.environment

    if (
      typeof schemaVersion !== 'number' ||
      !Number.isInteger(schemaVersion) ||
      typeof applicationId !== 'number' ||
      !Number.isInteger(applicationId) ||
      typeof environment !== 'string'
    ) {
      throw new TmCommMetadataMismatchError(
        'Malformed tm_comm_metadata row: expected integer schema_version, integer application_id, string environment.'
      )
    }

    if (schemaVersion !== TM_COMM_SQLITE_SCHEMA_VERSION) {
      throw new TmCommMetadataMismatchError(
        `Incompatible schema_version: expected ${TM_COMM_SQLITE_SCHEMA_VERSION}, got ${schemaVersion}.`
      )
    }

    if (applicationId !== TM_COMM_SQLITE_APPLICATION_ID) {
      throw new TmCommMetadataMismatchError(
        `Incompatible application_id: expected 0x${TM_COMM_SQLITE_APPLICATION_ID.toString(16)}, got 0x${applicationId.toString(16)}.`
      )
    }

    if (environment !== 'staging') {
      throw new TmCommMetadataMismatchError(
        `Incompatible environment: expected "staging", got "${environment}".`
      )
    }
  }

  close(): void {
    if (this.closed) return
    this.closed = true
    this.database.close()
  }

  withTransaction<T>(operation: () => T): T {
    this.database.exec('BEGIN IMMEDIATE')
    try {
      const result = operation()
      this.database.exec('COMMIT')
      return result
    } catch (error) {
      this.database.exec('ROLLBACK')
      throw error
    }
  }

  insertPrincipal(principal: TmCommPrincipal): TmCommPrincipal {
    this.database.prepare(`
      INSERT INTO tm_comm_principals (id, kind, wallet_address, public_key_hex, created_at)
      VALUES (?, ?, ?, ?, ?)
    `).run(
      principal.id,
      principal.kind,
      principal.walletAddress,
      principal.publicKeyHex,
      principal.createdAt
    )
    return principal
  }

  findPrincipalByAddress(walletAddress: string): TmCommPrincipal | null {
    const row = this.database.prepare(
      'SELECT * FROM tm_comm_principals WHERE wallet_address = ?'
    ).get(walletAddress) as SqlRow | undefined
    return row === undefined ? null : mapPrincipal(row)
  }

  findPrincipalById(id: string): TmCommPrincipal | null {
    const row = this.database.prepare(
      'SELECT * FROM tm_comm_principals WHERE id = ?'
    ).get(id) as SqlRow | undefined
    return row === undefined ? null : mapPrincipal(row)
  }

  insertChallenge(record: TmCommChallengeRecord): void {
    this.database.prepare(`
      INSERT INTO tm_comm_challenges (
        id, nonce_hash, audience, origin, session_context, canonical_message,
        expires_at, consumed_at, created_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
      record.id,
      record.nonceHash,
      record.audience,
      record.origin,
      record.sessionContext,
      record.canonicalMessage,
      record.expiresAt,
      record.consumedAt,
      record.createdAt
    )
  }

  findChallengeById(id: string): TmCommChallengeRecord | null {
    const row = this.database.prepare(
      'SELECT * FROM tm_comm_challenges WHERE id = ?'
    ).get(id) as SqlRow | undefined
    return row === undefined ? null : mapChallenge(row)
  }

  consumeChallenge(id: string, consumedAt: number): boolean {
    const result = this.database.prepare(`
      UPDATE tm_comm_challenges
      SET consumed_at = ?
      WHERE id = ? AND consumed_at IS NULL
    `).run(consumedAt, id)
    return result.changes === 1
  }

  insertSession(record: TmCommSessionRecord): void {
    this.database.prepare(`
      INSERT INTO tm_comm_sessions (
        id, token_hash, principal_id, challenge_id, audience, expires_at, created_at, revoked_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
      record.id,
      record.tokenHash,
      record.principalId,
      record.challengeId,
      record.audience,
      record.expiresAt,
      record.createdAt,
      record.revokedAt
    )
  }

  findSessionByTokenHash(tokenHash: string): TmCommSessionRecord | null {
    const row = this.database.prepare(
      'SELECT * FROM tm_comm_sessions WHERE token_hash = ?'
    ).get(tokenHash) as SqlRow | undefined
    return row === undefined ? null : mapSession(row)
  }

  insertEnrollment(record: TmCommEnrollmentRecord): void {
    this.database.prepare(`
      INSERT INTO tm_comm_enrollment_tokens (
        id, token_hash, reservation_id, expected_email, issued_by, expires_at,
        consumed_at, consumed_by_principal_id, created_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
      record.id,
      record.tokenHash,
      record.reservationId,
      record.expectedEmail,
      record.issuedBy,
      record.expiresAt,
      record.consumedAt,
      record.consumedByPrincipalId,
      record.createdAt
    )
  }

  findEnrollmentByTokenHash(tokenHash: string): TmCommEnrollmentRecord | null {
    const row = this.database.prepare(
      'SELECT * FROM tm_comm_enrollment_tokens WHERE token_hash = ?'
    ).get(tokenHash) as SqlRow | undefined
    return row === undefined ? null : mapEnrollment(row)
  }

  consumeEnrollment(id: string, principalId: string, consumedAt: number): boolean {
    const result = this.database.prepare(`
      UPDATE tm_comm_enrollment_tokens
      SET consumed_at = ?, consumed_by_principal_id = ?
      WHERE id = ? AND consumed_at IS NULL
    `).run(consumedAt, principalId, id)
    return result.changes === 1
  }

  insertBinding(binding: TmCommReservationBinding): void {
    this.database.prepare(`
      INSERT INTO tm_comm_reservation_bindings (
        id, principal_id, reservation_id, enrollment_token_id, bound_at, created_by
      ) VALUES (?, ?, ?, ?, ?, ?)
    `).run(
      binding.id,
      binding.principalId,
      binding.reservationId,
      binding.enrollmentTokenId,
      binding.boundAt,
      binding.createdBy
    )
  }

  listBindingsForPrincipal(principalId: string): TmCommReservationBinding[] {
    const rows = this.database.prepare(
      'SELECT * FROM tm_comm_reservation_bindings WHERE principal_id = ? ORDER BY bound_at ASC'
    ).all(principalId) as SqlRow[]
    return rows.map(mapBinding)
  }

  findBinding(principalId: string, reservationId: string): TmCommReservationBinding | null {
    const row = this.database.prepare(`
      SELECT * FROM tm_comm_reservation_bindings
      WHERE principal_id = ? AND reservation_id = ?
    `).get(principalId, reservationId) as SqlRow | undefined
    return row === undefined ? null : mapBinding(row)
  }

  findConversationByReservation(reservationId: string): TmCommConversation | null {
    const row = this.database.prepare(
      'SELECT * FROM tm_comm_conversations WHERE reservation_id = ?'
    ).get(reservationId) as SqlRow | undefined
    return row === undefined ? null : this.hydrateConversation(row)
  }

  findConversationById(id: string): TmCommConversation | null {
    const row = this.database.prepare(
      'SELECT * FROM tm_comm_conversations WHERE id = ?'
    ).get(id) as SqlRow | undefined
    return row === undefined ? null : this.hydrateConversation(row)
  }

  insertConversation(conversation: TmCommConversation): void {
    this.database.prepare(`
      INSERT INTO tm_comm_conversations (id, reservation_id, created_at)
      VALUES (?, ?, ?)
    `).run(conversation.id, conversation.reservationId, conversation.createdAt)
    const insertParticipant = this.database.prepare(`
      INSERT INTO tm_comm_conversation_participants (conversation_id, principal_id)
      VALUES (?, ?)
    `)
    for (const principalId of conversation.participantPrincipalIds) {
      insertParticipant.run(conversation.id, principalId)
    }
  }

  isConversationParticipant(conversationId: string, principalId: string): boolean {
    const row = this.database.prepare(`
      SELECT 1 AS ok
      FROM tm_comm_conversation_participants
      WHERE conversation_id = ? AND principal_id = ?
    `).get(conversationId, principalId) as SqlRow | undefined
    return row !== undefined
  }

  listConversationsForPrincipal(principalId: string): TmCommConversation[] {
    const rows = this.database.prepare(`
      SELECT c.*
      FROM tm_comm_conversations c
      INNER JOIN tm_comm_conversation_participants p
        ON p.conversation_id = c.id
      WHERE p.principal_id = ?
      ORDER BY c.created_at ASC
    `).all(principalId) as SqlRow[]
    return rows.map((row) => this.hydrateConversation(row))
  }

  insertMessage(message: TmCommMessage): void {
    this.database.prepare(`
      INSERT INTO tm_comm_messages (
        id, client_message_id, conversation_id, sender_principal_id, sender_kind,
        body, server_created_at, reply_to_id, status
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
      message.id,
      message.clientMessageId,
      message.conversationId,
      message.senderPrincipalId,
      message.senderKind,
      message.body,
      message.serverCreatedAt,
      message.replyToId,
      message.status
    )
  }

  findMessageByClientId(
    conversationId: string,
    clientMessageId: string
  ): TmCommMessage | null {
    const row = this.database.prepare(`
      SELECT * FROM tm_comm_messages
      WHERE conversation_id = ? AND client_message_id = ?
    `).get(conversationId, clientMessageId) as SqlRow | undefined
    return row === undefined ? null : mapMessage(row)
  }

  findMessageById(id: string): TmCommMessage | null {
    const row = this.database.prepare(
      'SELECT * FROM tm_comm_messages WHERE id = ?'
    ).get(id) as SqlRow | undefined
    return row === undefined ? null : mapMessage(row)
  }

  listMessages(conversationId: string): TmCommMessage[] {
    const rows = this.database.prepare(`
      SELECT * FROM tm_comm_messages
      WHERE conversation_id = ?
      ORDER BY server_created_at ASC, id ASC
    `).all(conversationId) as SqlRow[]
    return rows.map(mapMessage)
  }

  upsertReceipt(receipt: TmCommMessageReceipt): TmCommMessageReceipt {
    const existing = this.database.prepare(`
      SELECT * FROM tm_comm_receipts WHERE message_id = ? AND principal_id = ?
    `).get(receipt.messageId, receipt.principalId) as SqlRow | undefined
    if (existing === undefined) {
      this.database.prepare(`
        INSERT INTO tm_comm_receipts (id, message_id, principal_id, state, recorded_at)
        VALUES (?, ?, ?, ?, ?)
      `).run(
        receipt.id,
        receipt.messageId,
        receipt.principalId,
        receipt.state,
        receipt.recordedAt
      )
      this.syncMessageStatus(receipt.messageId)
      return receipt
    }
    const current = mapReceipt(existing)
    const nextState = current.state === 'read' ? 'read' : receipt.state
    this.database.prepare(`
      UPDATE tm_comm_receipts
      SET state = ?, recorded_at = ?
      WHERE id = ?
    `).run(nextState, receipt.recordedAt, current.id)
    this.syncMessageStatus(receipt.messageId)
    return {
      ...current,
      state: nextState,
      recordedAt: receipt.recordedAt
    }
  }

  listReceipts(messageId: string): TmCommMessageReceipt[] {
    const rows = this.database.prepare(
      'SELECT * FROM tm_comm_receipts WHERE message_id = ? ORDER BY recorded_at ASC'
    ).all(messageId) as SqlRow[]
    return rows.map(mapReceipt)
  }

  insertAudit(event: TmCommAuditEvent): void {
    this.database.prepare(`
      INSERT INTO tm_comm_audit_events (
        id, at, actor_principal_id, action, resource_type, resource_id, outcome, reason_code
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
      event.id,
      event.at,
      event.actorPrincipalId,
      event.action,
      event.resourceType,
      event.resourceId,
      event.outcome,
      event.reasonCode
    )
  }

  listAuditEvents(): TmCommAuditEvent[] {
    const rows = this.database.prepare(
      'SELECT * FROM tm_comm_audit_events ORDER BY at ASC, id ASC'
    ).all() as SqlRow[]
    return rows.map(mapAudit)
  }

  findOperatorPrincipal(): TmCommPrincipal | null {
    const row = this.database.prepare(
      "SELECT * FROM tm_comm_principals WHERE kind = 'operator' ORDER BY created_at ASC LIMIT 1"
    ).get() as SqlRow | undefined
    return row === undefined ? null : mapPrincipal(row)
  }

  private hydrateConversation(row: SqlRow): TmCommConversation {
    const id = asString(row.id)
    const participants = this.database.prepare(
      'SELECT principal_id FROM tm_comm_conversation_participants WHERE conversation_id = ? ORDER BY principal_id ASC'
    ).all(id) as SqlRow[]
    return Object.freeze({
      id,
      reservationId: asString(row.reservation_id),
      participantPrincipalIds: Object.freeze(
        participants.map((participant) => asString(participant.principal_id))
      ),
      createdAt: asNumber(row.created_at)
    })
  }

  private syncMessageStatus(messageId: string): void {
    const message = this.findMessageById(messageId)
    if (message === null) return
    const receipts = this.listReceipts(messageId)
      .filter((receipt) => receipt.principalId !== message.senderPrincipalId)
    const status = receipts.some((receipt) => receipt.state === 'read')
      ? 'read'
      : receipts.some((receipt) => receipt.state === 'delivered')
        ? 'delivered'
        : 'accepted'
    this.database.prepare(
      'UPDATE tm_comm_messages SET status = ? WHERE id = ?'
    ).run(status, messageId)
  }
}

export function createAuditEvent(
  input: Omit<TmCommAuditEvent, 'id'> & { id?: string }
): TmCommAuditEvent {
  return Object.freeze({
    id: input.id ?? createTmCommId('audit'),
    at: input.at,
    actorPrincipalId: input.actorPrincipalId,
    action: input.action,
    resourceType: input.resourceType,
    resourceId: input.resourceId,
    outcome: input.outcome,
    reasonCode: input.reasonCode
  })
}

function mapPrincipal(row: SqlRow): TmCommPrincipal {
  return Object.freeze({
    id: asString(row.id),
    kind: asString(row.kind) as TmCommPrincipal['kind'],
    walletAddress: asString(row.wallet_address),
    publicKeyHex: asString(row.public_key_hex),
    createdAt: asNumber(row.created_at)
  })
}

function mapChallenge(row: SqlRow): TmCommChallengeRecord {
  return Object.freeze({
    id: asString(row.id),
    nonceHash: asString(row.nonce_hash),
    audience: asString(row.audience),
    origin: asString(row.origin),
    sessionContext: asString(row.session_context),
    canonicalMessage: asString(row.canonical_message),
    expiresAt: asNumber(row.expires_at),
    consumedAt: asNullableNumber(row.consumed_at),
    createdAt: asNumber(row.created_at)
  })
}

function mapSession(row: SqlRow): TmCommSessionRecord {
  return Object.freeze({
    id: asString(row.id),
    tokenHash: asString(row.token_hash),
    principalId: asString(row.principal_id),
    challengeId: asString(row.challenge_id),
    audience: asString(row.audience),
    expiresAt: asNumber(row.expires_at),
    createdAt: asNumber(row.created_at),
    revokedAt: asNullableNumber(row.revoked_at)
  })
}

function mapEnrollment(row: SqlRow): TmCommEnrollmentRecord {
  return Object.freeze({
    id: asString(row.id),
    tokenHash: asString(row.token_hash),
    reservationId: asString(row.reservation_id),
    expectedEmail: asNullableString(row.expected_email),
    issuedBy: 'xolos-ramirez-operator',
    expiresAt: asNumber(row.expires_at),
    consumedAt: asNullableNumber(row.consumed_at),
    consumedByPrincipalId: asNullableString(row.consumed_by_principal_id),
    createdAt: asNumber(row.created_at)
  })
}

function mapBinding(row: SqlRow): TmCommReservationBinding {
  return Object.freeze({
    id: asString(row.id),
    principalId: asString(row.principal_id),
    reservationId: asString(row.reservation_id),
    enrollmentTokenId: asString(row.enrollment_token_id),
    boundAt: asNumber(row.bound_at),
    createdBy: 'xolos-ramirez-operator'
  })
}

function mapMessage(row: SqlRow): TmCommMessage {
  return Object.freeze({
    id: asString(row.id),
    clientMessageId: asString(row.client_message_id),
    conversationId: asString(row.conversation_id),
    senderPrincipalId: asString(row.sender_principal_id),
    senderKind: asString(row.sender_kind) as TmCommSenderKind,
    body: asString(row.body),
    serverCreatedAt: asNumber(row.server_created_at),
    replyToId: asNullableString(row.reply_to_id),
    status: asString(row.status) as TmCommMessage['status']
  })
}

function mapReceipt(row: SqlRow): TmCommMessageReceipt {
  return Object.freeze({
    id: asString(row.id),
    messageId: asString(row.message_id),
    principalId: asString(row.principal_id),
    state: asString(row.state) as TmCommMessageReceipt['state'],
    recordedAt: asNumber(row.recorded_at)
  })
}

function mapAudit(row: SqlRow): TmCommAuditEvent {
  return Object.freeze({
    id: asString(row.id),
    at: asNumber(row.at),
    actorPrincipalId: asNullableString(row.actor_principal_id),
    action: asString(row.action),
    resourceType: asString(row.resource_type),
    resourceId: asNullableString(row.resource_id),
    outcome: asString(row.outcome) as TmCommAuditEvent['outcome'],
    reasonCode: asString(row.reason_code)
  })
}
