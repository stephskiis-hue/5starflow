-- Add accountId to ReviewSent for per-account visibility
ALTER TABLE "ReviewSent" ADD COLUMN "accountId" TEXT;

-- Add channel tracking and follow-up fields to PendingReview
ALTER TABLE "PendingReview" ADD COLUMN "channel"             TEXT;
ALTER TABLE "PendingReview" ADD COLUMN "followUpScheduledAt" TIMESTAMP(3);
ALTER TABLE "PendingReview" ADD COLUMN "followUpSent"        BOOLEAN NOT NULL DEFAULT false;
