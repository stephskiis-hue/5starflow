-- Add role field to User model
-- Default: "client" for all existing users
-- The NoBS Yardwork admin account should be manually set to "admin" after migration

ALTER TABLE "User" ADD COLUMN "role" TEXT NOT NULL DEFAULT 'client';
