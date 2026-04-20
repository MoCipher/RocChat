-- Key transparency audit log
CREATE TABLE IF NOT EXISTS key_audit_log (
  id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL,
  event_type TEXT NOT NULL DEFAULT 'identity_key_change', -- identity_key_change, prekey_upload, signed_prekey_rotation
  old_key_fingerprint TEXT,
  new_key_fingerprint TEXT NOT NULL,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  FOREIGN KEY (user_id) REFERENCES users(id)
);
CREATE INDEX IF NOT EXISTS idx_key_audit_user ON key_audit_log(user_id, created_at DESC);
