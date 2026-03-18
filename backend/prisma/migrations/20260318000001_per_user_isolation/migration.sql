-- Per-user isolation: add userId to existing tables + new TwilioCredential/GmailCredential tables

-- PendingReview: add userId
ALTER TABLE "PendingReview" ADD COLUMN "userId" TEXT;

-- WeatherCheck: add userId
ALTER TABLE "WeatherCheck" ADD COLUMN "userId" TEXT;
CREATE INDEX "WeatherCheck_userId_idx" ON "WeatherCheck"("userId");

-- RainReschedule: add userId
ALTER TABLE "RainReschedule" ADD COLUMN "userId" TEXT;
CREATE INDEX "RainReschedule_userId_idx" ON "RainReschedule"("userId");

-- WeatherSettings: add userId (one row per user)
ALTER TABLE "WeatherSettings" ADD COLUMN "userId" TEXT;
CREATE UNIQUE INDEX "WeatherSettings_userId_key" ON "WeatherSettings"("userId");

-- SeoAudit: add userId
ALTER TABLE "SeoAudit" ADD COLUMN "userId" TEXT;
CREATE INDEX "SeoAudit_userId_idx" ON "SeoAudit"("userId");

-- SeoProposal: add userId
ALTER TABLE "SeoProposal" ADD COLUMN "userId" TEXT;
CREATE INDEX "SeoProposal_userId_idx" ON "SeoProposal"("userId");

-- SeoChange: add userId
ALTER TABLE "SeoChange" ADD COLUMN "userId" TEXT;
CREATE INDEX "SeoChange_userId_idx" ON "SeoChange"("userId");

-- FtpConfig: add userId
ALTER TABLE "FtpConfig" ADD COLUMN "userId" TEXT;
CREATE INDEX "FtpConfig_userId_idx" ON "FtpConfig"("userId");

-- AuditIgnore: drop old global unique on pattern, add userId + composite unique
ALTER TABLE "AuditIgnore" DROP CONSTRAINT IF EXISTS "AuditIgnore_pattern_key";
ALTER TABLE "AuditIgnore" ADD COLUMN "userId" TEXT;
CREATE UNIQUE INDEX "AuditIgnore_userId_pattern_key" ON "AuditIgnore"("userId", "pattern");
CREATE INDEX "AuditIgnore_userId_idx" ON "AuditIgnore"("userId");

-- AuditPage: drop old global unique on path, add userId + composite unique
ALTER TABLE "AuditPage" DROP CONSTRAINT IF EXISTS "AuditPage_path_key";
ALTER TABLE "AuditPage" ADD COLUMN "userId" TEXT;
CREATE UNIQUE INDEX "AuditPage_userId_path_key" ON "AuditPage"("userId", "path");
CREATE INDEX "AuditPage_userId_idx" ON "AuditPage"("userId");

-- SeoSettings: add userId (one row per user)
ALTER TABLE "SeoSettings" ADD COLUMN "userId" TEXT;
CREATE UNIQUE INDEX "SeoSettings_userId_key" ON "SeoSettings"("userId");

-- New table: TwilioCredential
CREATE TABLE "TwilioCredential" (
    "id"          TEXT NOT NULL,
    "userId"      TEXT NOT NULL,
    "accountSid"  TEXT NOT NULL,
    "authToken"   TEXT NOT NULL,
    "fromNumber"  TEXT NOT NULL,
    "createdAt"   TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt"   TIMESTAMP(3) NOT NULL,
    CONSTRAINT "TwilioCredential_pkey" PRIMARY KEY ("id")
);
CREATE UNIQUE INDEX "TwilioCredential_userId_key" ON "TwilioCredential"("userId");

-- New table: GmailCredential
CREATE TABLE "GmailCredential" (
    "id"          TEXT NOT NULL,
    "userId"      TEXT NOT NULL,
    "gmailUser"   TEXT NOT NULL,
    "appPassword" TEXT NOT NULL,
    "fromName"    TEXT NOT NULL DEFAULT '',
    "createdAt"   TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt"   TIMESTAMP(3) NOT NULL,
    CONSTRAINT "GmailCredential_pkey" PRIMARY KEY ("id")
);
CREATE UNIQUE INDEX "GmailCredential_userId_key" ON "GmailCredential"("userId");
