-- Quiet hours and DND exceptions
ALTER TABLE users ADD COLUMN quiet_start TEXT DEFAULT NULL;
ALTER TABLE users ADD COLUMN quiet_end TEXT DEFAULT NULL;
ALTER TABLE users ADD COLUMN dnd_exceptions TEXT DEFAULT NULL;
