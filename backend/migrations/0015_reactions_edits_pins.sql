-- 0015: Message reactions, edits, deletions, and pinned messages

-- Message reactions (encrypted reaction emoji per user per message)
CREATE TABLE IF NOT EXISTS message_reactions (
  id TEXT PRIMARY KEY,
  message_id TEXT NOT NULL REFERENCES messages(id) ON DELETE CASCADE,
  user_id TEXT NOT NULL REFERENCES users(id),
  encrypted_reaction TEXT NOT NULL, -- AES-GCM encrypted emoji
  created_at INTEGER NOT NULL DEFAULT (unixepoch()),
  UNIQUE(message_id, user_id)
);

CREATE INDEX IF NOT EXISTS idx_reactions_message ON message_reactions(message_id);

-- Message edits (stores encrypted edit history)
ALTER TABLE messages ADD COLUMN edited_at INTEGER;
ALTER TABLE messages ADD COLUMN deleted_at INTEGER;

-- Pinned messages per conversation
CREATE TABLE IF NOT EXISTS pinned_messages (
  conversation_id TEXT NOT NULL REFERENCES conversations(id) ON DELETE CASCADE,
  message_id TEXT NOT NULL REFERENCES messages(id) ON DELETE CASCADE,
  pinned_by TEXT NOT NULL REFERENCES users(id),
  pinned_at INTEGER NOT NULL DEFAULT (unixepoch()),
  PRIMARY KEY (conversation_id, message_id)
);
