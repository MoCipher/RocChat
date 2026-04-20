-- Keyword alerts: words that break through DND/quiet hours (checked client-side on decrypted messages)
ALTER TABLE users ADD COLUMN alert_keywords TEXT DEFAULT NULL; -- JSON array of strings
