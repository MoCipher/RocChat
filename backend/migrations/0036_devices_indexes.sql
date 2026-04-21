-- Migration 0036: additional performance indexes
-- Resilient form — safe to run even if columns already indexed

CREATE INDEX IF NOT EXISTS idx_devices_last_active ON devices(last_active);
CREATE INDEX IF NOT EXISTS idx_devices_user_id     ON devices(user_id);
CREATE INDEX IF NOT EXISTS idx_devices_push_token  ON devices(push_token) WHERE push_token IS NOT NULL;
