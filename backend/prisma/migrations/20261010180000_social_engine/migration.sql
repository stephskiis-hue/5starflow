-- SocialAction: reserve-then-confirm rows carry the exact text, a result link and an expiry
ALTER TABLE "SocialAction" ADD COLUMN "text" TEXT;
ALTER TABLE "SocialAction" ADD COLUMN "expiresAt" TIMESTAMP(3);
ALTER TABLE "SocialAction" ADD COLUMN "shiftId" TEXT;
CREATE INDEX "SocialAction_userId_groupId_idx" ON "SocialAction"("userId", "groupId");

CREATE TABLE "SocialThread" (
    "id" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "platform" TEXT NOT NULL DEFAULT 'facebook',
    "url" TEXT NOT NULL,
    "person" TEXT NOT NULL DEFAULT '',
    "need" TEXT NOT NULL DEFAULT '',
    "neighbourhood" TEXT NOT NULL DEFAULT '',
    "source" TEXT NOT NULL DEFAULT '',
    "status" TEXT NOT NULL DEFAULT 'open',
    "jobberRequestId" TEXT,
    "notes" TEXT NOT NULL DEFAULT '',
    "followedUpAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    CONSTRAINT "SocialThread_pkey" PRIMARY KEY ("id")
);
CREATE UNIQUE INDEX "SocialThread_userId_url_key" ON "SocialThread"("userId", "url");
CREATE INDEX "SocialThread_userId_status_createdAt_idx" ON "SocialThread"("userId", "status", "createdAt");

CREATE TABLE "SocialShift" (
    "id" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "day" TEXT NOT NULL,
    "kind" TEXT NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'due',
    "attempts" INTEGER NOT NULL DEFAULT 0,
    "claimedAt" TIMESTAMP(3),
    "finishedAt" TIMESTAMP(3),
    "summary" TEXT,
    "error" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    CONSTRAINT "SocialShift_pkey" PRIMARY KEY ("id")
);
CREATE UNIQUE INDEX "SocialShift_userId_day_kind_key" ON "SocialShift"("userId", "day", "kind");
CREATE INDEX "SocialShift_userId_day_idx" ON "SocialShift"("userId", "day");
