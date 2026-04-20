-- Per-conversation disappearing timers for media, voice notes, call history + burn-on-read
ALTER TABLE conversation_members ADD COLUMN media_expiry INTEGER DEFAULT NULL;
ALTER TABLE conversation_members ADD COLUMN voice_expiry INTEGER DEFAULT NULL;
ALTER TABLE conversation_members ADD COLUMN call_history_expiry INTEGER DEFAULT NULL;
ALTER TABLE conversation_members ADD COLUMN burn_on_read INTEGER DEFAULT 0;
