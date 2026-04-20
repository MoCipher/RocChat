-- Channel scheduled posts & analytics

-- Scheduled posts queue
CREATE TABLE IF NOT EXISTS channel_scheduled_posts (
  id TEXT PRIMARY KEY,
  channel_id TEXT NOT NULL REFERENCES channels(id) ON DELETE CASCADE,
  author_id TEXT NOT NULL REFERENCES users(id),
  ciphertext TEXT NOT NULL,
  iv TEXT NOT NULL DEFAULT '',
  scheduled_at INTEGER NOT NULL,  -- unix epoch when to publish
  created_at INTEGER NOT NULL DEFAULT (unixepoch()),
  status TEXT NOT NULL DEFAULT 'pending' CHECK (status IN ('pending', 'published', 'cancelled'))
);

CREATE INDEX IF NOT EXISTS idx_scheduled_posts_pending
  ON channel_scheduled_posts(scheduled_at)
  WHERE status = 'pending';

-- Channel post read receipts (analytics)
CREATE TABLE IF NOT EXISTS channel_post_reads (
  message_id TEXT NOT NULL,
  user_id TEXT NOT NULL,
  read_at INTEGER NOT NULL DEFAULT (unixepoch()),
  PRIMARY KEY (message_id, user_id)
);

CREATE INDEX IF NOT EXISTS idx_post_reads_message ON channel_post_reads(message_id);
