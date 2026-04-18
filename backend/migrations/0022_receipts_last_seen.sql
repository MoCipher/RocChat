-- Delivery/read receipt persistence + last_seen

CREATE TABLE IF NOT EXISTS message_receipts (
  message_id TEXT NOT NULL,
  user_id TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'delivered', -- 'delivered' or 'read'
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  PRIMARY KEY (message_id, user_id)
);

CREATE INDEX IF NOT EXISTS idx_receipts_message ON message_receipts(message_id);

-- Add last_seen_at to conversation_members
ALTER TABLE conversation_members ADD COLUMN last_read_message_id TEXT;
ALTER TABLE conversation_members ADD COLUMN last_seen_at TEXT;

-- User-level last_seen for presence
ALTER TABLE users ADD COLUMN last_seen_at TEXT;
