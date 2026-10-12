-- CreateTable
CREATE TABLE "CommInsight" (
    "id" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "channel" TEXT NOT NULL DEFAULT 'textnow',
    "phoneKey" TEXT NOT NULL,
    "jobberClientId" TEXT,
    "lastInboundId" TEXT NOT NULL,
    "intent" TEXT NOT NULL,
    "confidence" DOUBLE PRECISION NOT NULL DEFAULT 0.5,
    "summary" TEXT NOT NULL DEFAULT '',
    "proposedReply" TEXT NOT NULL DEFAULT '',
    "proposedAction" JSONB,
    "ownerReply" TEXT,
    "ownerReplyAt" TIMESTAMP(3),
    "agreement" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "CommInsight_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "CommInsight_userId_channel_createdAt_idx" ON "CommInsight"("userId", "channel", "createdAt");

-- CreateIndex
CREATE INDEX "CommInsight_userId_intent_idx" ON "CommInsight"("userId", "intent");

-- CreateIndex
CREATE UNIQUE INDEX "CommInsight_userId_channel_lastInboundId_key" ON "CommInsight"("userId", "channel", "lastInboundId");

