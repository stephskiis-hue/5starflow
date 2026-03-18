-- Switch GmailCredential from app-password to Google OAuth2 tokens

ALTER TABLE "GmailCredential" DROP COLUMN IF EXISTS "appPassword";
ALTER TABLE "GmailCredential" ADD COLUMN IF NOT EXISTS "accessToken"  TEXT NOT NULL DEFAULT '';
ALTER TABLE "GmailCredential" ADD COLUMN IF NOT EXISTS "refreshToken" TEXT;
ALTER TABLE "GmailCredential" ADD COLUMN IF NOT EXISTS "tokenExpiry"  TIMESTAMP(3);
