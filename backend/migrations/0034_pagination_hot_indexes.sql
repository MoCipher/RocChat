-- RocChat migration 0034: pagination hot-path indexes
-- Improves high-volume conversation paging and conversation listing.

CREATE INDEX IF NOT EXISTS idx_messages_conversation_ts_id
ON messages(conversation_id, server_timestamp DESC, id);

CREATE INDEX IF NOT EXISTS idx_conversation_members_user_archived_pinned
ON conversation_members(user_id, archived_at, pinned_at);
