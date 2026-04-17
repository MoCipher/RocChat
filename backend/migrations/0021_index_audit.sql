-- D1 Index Audit: drop redundant indexes and add covering index for listConversations

-- Drop duplicates superseded by 0018_hot_path_indexes
DROP INDEX IF EXISTS idx_messages_conv;
DROP INDEX IF EXISTS idx_messages_expires;
DROP INDEX IF EXISTS idx_devices_user;
DROP INDEX IF EXISTS idx_devices_push;
DROP INDEX IF EXISTS idx_conv_members_user;
DROP INDEX IF EXISTS idx_one_time_pre_keys_user;

-- Replace idx_conversation_members_user with covering index (adds archived_at)
DROP INDEX IF EXISTS idx_conversation_members_user;
CREATE INDEX IF NOT EXISTS idx_conv_members_user_archive_conv
  ON conversation_members(user_id, conversation_id, archived_at);
