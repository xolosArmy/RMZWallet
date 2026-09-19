export const TM_COMM_SQLITE_APPLICATION_ID = 0x544d4331
export const TM_COMM_SQLITE_SCHEMA_VERSION = 1

export const TM_COMM_SQLITE_SCHEMA_SQL = `
PRAGMA foreign_keys = ON;
PRAGMA trusted_schema = OFF;

CREATE TABLE IF NOT EXISTS tm_comm_metadata (
  singleton_id INTEGER PRIMARY KEY CHECK (singleton_id = 1),
  schema_version INTEGER NOT NULL CHECK (schema_version = 1),
  application_id INTEGER NOT NULL CHECK (application_id = ${TM_COMM_SQLITE_APPLICATION_ID}),
  environment TEXT NOT NULL CHECK (environment = 'staging'),
  created_at INTEGER NOT NULL CHECK (created_at >= 0)
) STRICT;

CREATE TABLE IF NOT EXISTS tm_comm_principals (
  id TEXT PRIMARY KEY,
  kind TEXT NOT NULL CHECK (kind IN ('customer', 'operator', 'agent')),
  wallet_address TEXT NOT NULL UNIQUE,
  public_key_hex TEXT NOT NULL,
  created_at INTEGER NOT NULL CHECK (created_at >= 0)
) STRICT;

CREATE TABLE IF NOT EXISTS tm_comm_challenges (
  id TEXT PRIMARY KEY,
  nonce_hash TEXT NOT NULL UNIQUE,
  audience TEXT NOT NULL,
  origin TEXT NOT NULL,
  session_context TEXT NOT NULL,
  canonical_message TEXT NOT NULL,
  expires_at INTEGER NOT NULL CHECK (expires_at >= 0),
  consumed_at INTEGER CHECK (consumed_at >= 0),
  created_at INTEGER NOT NULL CHECK (created_at >= 0)
) STRICT;

CREATE TABLE IF NOT EXISTS tm_comm_sessions (
  id TEXT PRIMARY KEY,
  token_hash TEXT NOT NULL UNIQUE,
  principal_id TEXT NOT NULL,
  challenge_id TEXT NOT NULL UNIQUE,
  audience TEXT NOT NULL,
  expires_at INTEGER NOT NULL CHECK (expires_at >= 0),
  created_at INTEGER NOT NULL CHECK (created_at >= 0),
  revoked_at INTEGER CHECK (revoked_at >= 0),
  FOREIGN KEY (principal_id) REFERENCES tm_comm_principals(id),
  FOREIGN KEY (challenge_id) REFERENCES tm_comm_challenges(id)
) STRICT;

CREATE TABLE IF NOT EXISTS tm_comm_enrollment_tokens (
  id TEXT PRIMARY KEY,
  token_hash TEXT NOT NULL UNIQUE,
  reservation_id TEXT NOT NULL,
  expected_email TEXT,
  issued_by TEXT NOT NULL CHECK (issued_by = 'xolos-ramirez-operator'),
  expires_at INTEGER NOT NULL CHECK (expires_at >= 0),
  consumed_at INTEGER CHECK (consumed_at >= 0),
  consumed_by_principal_id TEXT,
  created_at INTEGER NOT NULL CHECK (created_at >= 0),
  FOREIGN KEY (consumed_by_principal_id) REFERENCES tm_comm_principals(id)
) STRICT;

CREATE TABLE IF NOT EXISTS tm_comm_reservation_bindings (
  id TEXT PRIMARY KEY,
  principal_id TEXT NOT NULL,
  reservation_id TEXT NOT NULL,
  enrollment_token_id TEXT NOT NULL UNIQUE,
  bound_at INTEGER NOT NULL CHECK (bound_at >= 0),
  created_by TEXT NOT NULL CHECK (created_by = 'xolos-ramirez-operator'),
  UNIQUE (principal_id, reservation_id),
  FOREIGN KEY (principal_id) REFERENCES tm_comm_principals(id),
  FOREIGN KEY (enrollment_token_id) REFERENCES tm_comm_enrollment_tokens(id)
) STRICT;

CREATE TABLE IF NOT EXISTS tm_comm_conversations (
  id TEXT PRIMARY KEY,
  reservation_id TEXT NOT NULL UNIQUE,
  created_at INTEGER NOT NULL CHECK (created_at >= 0)
) STRICT;

CREATE TABLE IF NOT EXISTS tm_comm_conversation_participants (
  conversation_id TEXT NOT NULL,
  principal_id TEXT NOT NULL,
  PRIMARY KEY (conversation_id, principal_id),
  FOREIGN KEY (conversation_id) REFERENCES tm_comm_conversations(id),
  FOREIGN KEY (principal_id) REFERENCES tm_comm_principals(id)
) STRICT;

CREATE TABLE IF NOT EXISTS tm_comm_messages (
  id TEXT PRIMARY KEY,
  client_message_id TEXT NOT NULL,
  conversation_id TEXT NOT NULL,
  sender_principal_id TEXT NOT NULL,
  sender_kind TEXT NOT NULL CHECK (sender_kind IN ('customer', 'operator', 'agent', 'system')),
  body TEXT NOT NULL,
  server_created_at INTEGER NOT NULL CHECK (server_created_at >= 0),
  reply_to_id TEXT,
  status TEXT NOT NULL CHECK (status IN ('accepted', 'delivered', 'read')),
  UNIQUE (conversation_id, client_message_id),
  FOREIGN KEY (conversation_id) REFERENCES tm_comm_conversations(id),
  FOREIGN KEY (sender_principal_id) REFERENCES tm_comm_principals(id),
  FOREIGN KEY (reply_to_id) REFERENCES tm_comm_messages(id)
) STRICT;

CREATE TABLE IF NOT EXISTS tm_comm_receipts (
  id TEXT PRIMARY KEY,
  message_id TEXT NOT NULL,
  principal_id TEXT NOT NULL,
  state TEXT NOT NULL CHECK (state IN ('delivered', 'read')),
  recorded_at INTEGER NOT NULL CHECK (recorded_at >= 0),
  UNIQUE (message_id, principal_id),
  FOREIGN KEY (message_id) REFERENCES tm_comm_messages(id),
  FOREIGN KEY (principal_id) REFERENCES tm_comm_principals(id)
) STRICT;

CREATE TABLE IF NOT EXISTS tm_comm_audit_events (
  id TEXT PRIMARY KEY,
  at INTEGER NOT NULL CHECK (at >= 0),
  actor_principal_id TEXT,
  action TEXT NOT NULL,
  resource_type TEXT NOT NULL,
  resource_id TEXT,
  outcome TEXT NOT NULL CHECK (outcome IN ('allow', 'deny')),
  reason_code TEXT NOT NULL
) STRICT;

CREATE TABLE IF NOT EXISTS tm_comm_email_dispatches (
  id TEXT PRIMARY KEY,
  message_id TEXT NOT NULL,
  principal_id TEXT NOT NULL,
  channel TEXT NOT NULL CHECK (channel = 'email-fallback'),
  status TEXT NOT NULL CHECK (status IN ('pending', 'sent', 'failed', 'suppressed')),
  created_at INTEGER NOT NULL CHECK (created_at >= 0),
  UNIQUE (message_id, principal_id, channel),
  FOREIGN KEY (message_id) REFERENCES tm_comm_messages(id),
  FOREIGN KEY (principal_id) REFERENCES tm_comm_principals(id)
) STRICT;

CREATE INDEX IF NOT EXISTS tm_comm_messages_conversation_idx
  ON tm_comm_messages(conversation_id, server_created_at);

CREATE INDEX IF NOT EXISTS tm_comm_audit_actor_idx
  ON tm_comm_audit_events(actor_principal_id, at);
`
