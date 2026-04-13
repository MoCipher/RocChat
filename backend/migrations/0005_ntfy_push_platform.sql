-- Replace FCM with ntfy.sh for Android push
-- Drop old constrained column and re-add with ntfy support
ALTER TABLE devices DROP COLUMN push_platform;
ALTER TABLE devices ADD COLUMN push_platform TEXT CHECK (push_platform IN ('apns', 'ntfy', 'web')) DEFAULT NULL;
