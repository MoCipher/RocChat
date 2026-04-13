-- 0003: Add missing indexes and session improvements

-- Missing indexes for common query patterns
CREATE INDEX IF NOT EXISTS idx_signed_pre_keys_user ON signed_pre_keys(user_id, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_contacts_user ON contacts(user_id);
CREATE INDEX IF NOT EXISTS idx_one_time_pre_keys_user ON one_time_pre_keys(user_id, used);
CREATE INDEX IF NOT EXISTS idx_messages_sender ON messages(sender_id, server_timestamp DESC);
CREATE INDEX IF NOT EXISTS idx_users_username ON users(username);
