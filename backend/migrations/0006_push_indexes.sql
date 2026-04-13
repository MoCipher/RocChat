-- Performance indexes for push and hardening
CREATE INDEX IF NOT EXISTS idx_devices_push ON devices(user_id, push_token) WHERE push_token IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_messages_expires ON messages(expires_at) WHERE expires_at IS NOT NULL;
