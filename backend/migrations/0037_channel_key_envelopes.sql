-- Channel E2E sender-key envelopes.
-- Each row is the channel's symmetric key wrapped (ECIES-style) for a single
-- subscriber. The server cannot decrypt the wrapped key — it only stores it.
-- When an admin posts, they encrypt with the channel symmetric key and the
-- server stores only the ciphertext + IV. Subscribers fetch their envelope,
-- unwrap to recover the channel key, then decrypt posts client-side.

CREATE TABLE IF NOT EXISTS channel_key_envelopes (
  channel_id      TEXT NOT NULL,
  recipient_id    TEXT NOT NULL,    -- subscriber whose identity DH key wraps this envelope
  sender_id       TEXT NOT NULL,    -- admin who created the envelope
  ephemeral_pub   TEXT NOT NULL,    -- base64 X25519 ephemeral public key
  ciphertext      TEXT NOT NULL,    -- base64 AES-GCM ciphertext of the channel symmetric key
  iv              TEXT NOT NULL,    -- base64 AES-GCM IV
  tag             TEXT NOT NULL,    -- base64 AES-GCM tag
  key_version     INTEGER NOT NULL DEFAULT 1,
  created_at      INTEGER NOT NULL DEFAULT (strftime('%s','now')),
  PRIMARY KEY (channel_id, recipient_id, key_version)
);

CREATE INDEX IF NOT EXISTS idx_channel_key_envelopes_recipient
  ON channel_key_envelopes (recipient_id, channel_id);

-- Add ratchet_header column to scheduled posts so E2E auth tags + key version
-- can ride along with the ciphertext when an admin schedules an encrypted post.
ALTER TABLE channel_scheduled_posts ADD COLUMN ratchet_header TEXT NOT NULL DEFAULT '';
