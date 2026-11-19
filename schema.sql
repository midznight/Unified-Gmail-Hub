-- D1 enforces foreign keys by default; no PRAGMA toggle is required.

CREATE TABLE IF NOT EXISTS accounts (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  email TEXT UNIQUE NOT NULL,
  alias TEXT NOT NULL,
  category TEXT DEFAULT 'General',
  refresh_token_enc TEXT NOT NULL,
  access_token TEXT,
  token_expires_at INTEGER DEFAULT 0,
  last_synced_at INTEGER DEFAULT 0,
  sync_error TEXT,
  history_page_token TEXT,
  history_scan_complete INTEGER NOT NULL DEFAULT 0,
  created_at INTEGER DEFAULT (unixepoch())
);

CREATE TABLE IF NOT EXISTS messages (
  id TEXT PRIMARY KEY,
  thread_id TEXT NOT NULL,
  account_id INTEGER NOT NULL,
  sender_name TEXT,
  sender_email TEXT,
  reply_to TEXT,
  rfc_message_id TEXT,
  subject TEXT,
  snippet TEXT,
  is_unread INTEGER DEFAULT 1,
  received_at INTEGER NOT NULL,
  FOREIGN KEY (account_id) REFERENCES accounts(id) ON DELETE CASCADE
);

CREATE INDEX IF NOT EXISTS idx_messages_received ON messages(received_at DESC);
CREATE INDEX IF NOT EXISTS idx_messages_account ON messages(account_id);
CREATE INDEX IF NOT EXISTS idx_messages_unread_account ON messages(account_id, is_unread);
CREATE INDEX IF NOT EXISTS idx_messages_thread ON messages(thread_id);

-- Persist discovered Gmail IDs so rate-limited metadata batches never lose messages.
CREATE TABLE IF NOT EXISTS pending_messages (
  id TEXT PRIMARY KEY,
  account_id INTEGER NOT NULL,
  queued_at INTEGER NOT NULL DEFAULT (unixepoch()),
  attempts INTEGER NOT NULL DEFAULT 0,
  last_error TEXT,
  FOREIGN KEY (account_id) REFERENCES accounts(id) ON DELETE CASCADE
);
CREATE INDEX IF NOT EXISTS idx_pending_account_queue ON pending_messages(account_id, queued_at ASC);
CREATE INDEX IF NOT EXISTS idx_pending_queued_at ON pending_messages(queued_at);

-- OAuth state nonce is persisted once and consumed by /auth/callback.
CREATE TABLE IF NOT EXISTS oauth_states (
  nonce_hash TEXT PRIMARY KEY,
  created_at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_oauth_states_created ON oauth_states(created_at);

-- Prevent overlapping one-minute Cron runs from processing the same accounts.
CREATE TABLE IF NOT EXISTS cron_lock (
  id INTEGER PRIMARY KEY CHECK (id = 1),
  owner TEXT,
  lease_until INTEGER NOT NULL DEFAULT 0
);
INSERT INTO cron_lock (id, owner, lease_until) VALUES (1, NULL, 0) ON CONFLICT(id) DO NOTHING;
