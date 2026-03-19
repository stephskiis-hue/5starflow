-- Make passwordHash optional (nullable) to support Google OAuth users
ALTER TABLE "User" ALTER COLUMN "passwordHash" DROP NOT NULL;

-- Add googleId for reliable Google account matching
ALTER TABLE "User" ADD COLUMN "googleId" TEXT;
ALTER TABLE "User" ADD CONSTRAINT "User_googleId_key" UNIQUE ("googleId");
