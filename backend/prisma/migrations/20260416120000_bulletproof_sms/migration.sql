-- ---------------------------------------------------------------------------
-- Bulletproof SMS migration
--   1. Extend MarketingMessage with body / attempts / retry bookkeeping + userId
--   2. Add the AppLog table + indexes
--   3. Add summer-critical indexes on PendingReview, CachedJobberClient, MarketingMessage, InboundSMS
-- ---------------------------------------------------------------------------

-- 1. MarketingMessage new columns
ALTER TABLE "MarketingMessage" ADD COLUMN IF NOT EXISTS "body"          TEXT    NOT NULL DEFAULT '';
ALTER TABLE "MarketingMessage" ADD COLUMN IF NOT EXISTS "attempts"      INTEGER NOT NULL DEFAULT 0;
ALTER TABLE "MarketingMessage" ADD COLUMN IF NOT EXISTS "userId"        TEXT;
ALTER TABLE "MarketingMessage" ADD COLUMN IF NOT EXISTS "lastAttemptAt" TIMESTAMP(3);
ALTER TABLE "MarketingMessage" ADD COLUMN IF NOT EXISTS "nextRetryAt"   TIMESTAMP(3);

-- Backfill userId on existing MarketingMessage rows so the cron retry worker can find them
UPDATE "MarketingMessage" m
SET    "userId" = c."userId"
FROM   "MarketingCampaign" c
WHERE  m."campaignId" = c."id"
  AND  m."userId" IS NULL;

-- New indexes for MarketingMessage
CREATE INDEX IF NOT EXISTS "MarketingMessage_campaignId_status_idx"  ON "MarketingMessage" ("campaignId", "status");
CREATE INDEX IF NOT EXISTS "MarketingMessage_status_nextRetryAt_idx" ON "MarketingMessage" ("status", "nextRetryAt");
CREATE INDEX IF NOT EXISTS "MarketingMessage_userId_status_idx"      ON "MarketingMessage" ("userId", "status");
CREATE INDEX IF NOT EXISTS "MarketingMessage_phone_status_idx"       ON "MarketingMessage" ("phone", "status");

-- 2. AppLog table
CREATE TABLE IF NOT EXISTS "AppLog" (
  "id"        TEXT        NOT NULL,
  "userId"    TEXT,
  "category"  TEXT        NOT NULL,
  "level"     TEXT        NOT NULL,
  "message"   TEXT        NOT NULL,
  "context"   JSONB,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "AppLog_pkey" PRIMARY KEY ("id")
);
CREATE INDEX IF NOT EXISTS "AppLog_category_level_createdAt_idx" ON "AppLog" ("category", "level", "createdAt");
CREATE INDEX IF NOT EXISTS "AppLog_userId_createdAt_idx"         ON "AppLog" ("userId", "createdAt");
CREATE INDEX IF NOT EXISTS "AppLog_createdAt_idx"                ON "AppLog" ("createdAt");

-- 3. Summer-critical indexes
CREATE INDEX IF NOT EXISTS "PendingReview_processed_cancelled_scheduledAt_idx"
  ON "PendingReview" ("processed", "cancelled", "scheduledAt");
CREATE INDEX IF NOT EXISTS "PendingReview_userId_idx"
  ON "PendingReview" ("userId");

CREATE INDEX IF NOT EXISTS "CachedJobberClient_userId_phone_idx"
  ON "CachedJobberClient" ("userId", "phone");

CREATE INDEX IF NOT EXISTS "InboundSMS_userId_read_idx"
  ON "InboundSMS" ("userId", "read");
