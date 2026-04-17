-- 0018_hot_path_indexes.sql
-- Add indexes on hot query paths identified in audit.
-- All CREATE INDEX IF NOT EXISTS so re-runs are safe.

CREATE INDEX IF NOT EXISTS idx_messages_conversation
  ON messages(conversation_id, server_timestamp DESC);

CREATE INDEX IF NOT EXISTS idx_devices_user_push
  ON devices(user_id, push_token);

CREATE INDEX IF NOT EXISTS idx_one_time_pre_keys_unused
  ON one_time_pre_keys(user_id, used);

CREATE INDEX IF NOT EXISTS idx_conversation_members_user
  ON conversation_members(user_id, conversation_id);

-- Also helpful for archived-filter and scheduled cleanup:
CREATE INDEX IF NOT EXISTS idx_conversation_members_archived
  ON conversation_members(user_id, archived_at);

CREATE INDEX IF NOT EXISTS idx_messages_expires_at
  ON messages(expires_at)
  WHERE expires_at IS NOT NULL;
