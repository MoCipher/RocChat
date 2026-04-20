-- Extended privacy settings
ALTER TABLE users ADD COLUMN show_last_seen_to TEXT NOT NULL DEFAULT 'everyone'; -- everyone, contacts, nobody
ALTER TABLE users ADD COLUMN show_photo_to TEXT NOT NULL DEFAULT 'everyone'; -- everyone, contacts, nobody
ALTER TABLE users ADD COLUMN screenshot_detection INTEGER NOT NULL DEFAULT 1;
