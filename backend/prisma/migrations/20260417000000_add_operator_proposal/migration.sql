-- CreateTable
CREATE TABLE "PageSpeedHistory" (
    "id" TEXT NOT NULL,
    "userId" TEXT,
    "siteUrl" TEXT NOT NULL,
    "mobileScore" INTEGER,
    "desktopScore" INTEGER,
    "mobileSeo" INTEGER,
    "lcp" DOUBLE PRECISION,
    "cls" DOUBLE PRECISION,
    "fid" DOUBLE PRECISION,
    "issuesJson" TEXT,
    "runAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "PageSpeedHistory_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "OperatorProposal" (
    "id" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "shortCode" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "category" TEXT NOT NULL,
    "tier" TEXT NOT NULL,
    "summary" TEXT NOT NULL,
    "payload" JSONB NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'pending',
    "smsSentAt" TIMESTAMP(3),
    "smsMessageSid" TEXT,
    "respondedAt" TIMESTAMP(3),
    "respondedVia" TEXT,
    "executedAt" TIMESTAMP(3),
    "result" JSONB,
    "expiresAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "OperatorProposal_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "PageSpeedHistory_userId_idx" ON "PageSpeedHistory"("userId");

-- CreateIndex
CREATE INDEX "OperatorProposal_userId_status_idx" ON "OperatorProposal"("userId", "status");

-- CreateIndex
CREATE INDEX "OperatorProposal_status_expiresAt_idx" ON "OperatorProposal"("status", "expiresAt");

-- CreateIndex
CREATE UNIQUE INDEX "OperatorProposal_userId_shortCode_key" ON "OperatorProposal"("userId", "shortCode");
