-- 0033 — Performance indexes & retention helpers (idempotent).
-- Adds covering/secondary indexes for the hottest read paths discovered in
-- production. All statements use IF NOT EXISTS so migration is safe to re-run.

-- Messages: covering index for the conversation timeline query
CREATE INDEX IF NOT EXISTS idx_messages_conv_ts_id
  ON messages(conversation_id, server_timestamp DESC, id);

-- Messages: sender lookups (export, audit)
CREATE INDEX IF NOT EXISTS idx_messages_sender ON messages(sender_id);

-- Devices: by user + last_active for online lists
CREATE INDEX IF NOT EXISTS idx_devices_user_active
  ON devices(user_id, last_active DESC);

-- Conversation members: reverse lookup (user → conversations) covering role
CREATE INDEX IF NOT EXISTS idx_conv_members_user_role
  ON conversation_members(user_id, conversation_id, role);

-- Contacts: unblocked-only filter
CREATE INDEX IF NOT EXISTS idx_contacts_user_blocked
  ON contacts(user_id, blocked);

-- Signed pre-keys: latest-first selection
CREATE INDEX IF NOT EXISTS idx_signed_pre_keys_user_created
  ON signed_pre_keys(user_id, created_at DESC);

-- One-time pre-keys: unused selection
CREATE INDEX IF NOT EXISTS idx_one_time_pre_keys_user_used
  ON one_time_pre_keys(user_id, used);
