-- Add push platform column to devices
ALTER TABLE devices ADD COLUMN push_platform TEXT CHECK (push_platform IN ('apns', 'fcm', 'web')) DEFAULT NULL;
