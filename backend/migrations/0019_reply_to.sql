-- Add reply_to column for quoted replies
ALTER TABLE messages ADD COLUMN reply_to TEXT;
CREATE INDEX IF NOT EXISTS idx_messages_reply_to ON messages(reply_to);
