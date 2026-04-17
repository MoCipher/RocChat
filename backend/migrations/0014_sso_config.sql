-- SSO configuration per organization
CREATE TABLE IF NOT EXISTS sso_configs (
  org_id TEXT PRIMARY KEY,
  provider TEXT NOT NULL DEFAULT 'oidc',
  issuer_url TEXT NOT NULL,
  client_id TEXT NOT NULL,
  client_secret TEXT NOT NULL,
  redirect_uri TEXT NOT NULL,
  enabled INTEGER NOT NULL DEFAULT 0,
  created_at INTEGER NOT NULL DEFAULT (unixepoch()),
  updated_at INTEGER NOT NULL DEFAULT (unixepoch()),
  FOREIGN KEY (org_id) REFERENCES organizations(id) ON DELETE CASCADE
);
