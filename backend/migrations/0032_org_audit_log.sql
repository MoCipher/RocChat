-- 0032: Privacy-preserving organization admin audit events

CREATE TABLE IF NOT EXISTS organization_audit_log (
  id TEXT PRIMARY KEY,
  org_id TEXT NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  actor_user_id TEXT NOT NULL REFERENCES users(id),
  action TEXT NOT NULL,
  target_user_id TEXT,
  target_device_id TEXT,
  metadata_json TEXT,
  created_at INTEGER NOT NULL DEFAULT (unixepoch())
);

CREATE INDEX IF NOT EXISTS idx_org_audit_org_time
  ON organization_audit_log(org_id, created_at DESC);

CREATE INDEX IF NOT EXISTS idx_org_audit_actor_time
  ON organization_audit_log(actor_user_id, created_at DESC);
