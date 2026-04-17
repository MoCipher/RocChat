-- Pin conversations to top of list
ALTER TABLE conversation_members ADD COLUMN pinned_at INTEGER DEFAULT NULL;
CREATE INDEX IF NOT EXISTS idx_conversation_members_pinned ON conversation_members(user_id, pinned_at);
