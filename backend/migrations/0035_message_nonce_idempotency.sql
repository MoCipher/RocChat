-- RocChat migration 0035: message idempotency via client nonce
-- Prevents duplicate rows when offline retries resend the same payload.

CREATE UNIQUE INDEX IF NOT EXISTS idx_messages_idempotency_nonce
ON messages(
  conversation_id,
  sender_id,
  json_extract(encrypted, '$.message_nonce')
)
WHERE json_valid(encrypted) = 1
  AND json_extract(encrypted, '$.message_nonce') IS NOT NULL;