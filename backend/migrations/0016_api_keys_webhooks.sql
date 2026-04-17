-- 0016: API keys and webhooks for business integrations

CREATE TABLE IF NOT EXISTS api_keys (
  id TEXT PRIMARY KEY,
  org_id TEXT NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  name TEXT NOT NULL,
  key_hash TEXT NOT NULL,
  key_prefix TEXT NOT NULL,
  scopes TEXT NOT NULL DEFAULT '["read"]',
  created_by TEXT NOT NULL REFERENCES users(id),
  created_at INTEGER NOT NULL DEFAULT (unixepoch()),
  last_used_at INTEGER
);

CREATE INDEX IF NOT EXISTS idx_api_keys_org ON api_keys(org_id);

CREATE TABLE IF NOT EXISTS webhooks (
  id TEXT PRIMARY KEY,
  org_id TEXT NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  url TEXT NOT NULL,
  events TEXT NOT NULL DEFAULT '["message.sent"]',
  signing_secret TEXT NOT NULL,
  created_by TEXT NOT NULL REFERENCES users(id),
  created_at INTEGER NOT NULL DEFAULT (unixepoch()),
  last_delivery_at INTEGER,
  last_status INTEGER
);

CREATE INDEX IF NOT EXISTS idx_webhooks_org ON webhooks(org_id);
