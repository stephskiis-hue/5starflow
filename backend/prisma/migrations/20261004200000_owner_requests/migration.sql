-- CreateTable
CREATE TABLE "OwnerRequest" (
    "id" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "body" TEXT NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'pending',
    "claimedAt" TIMESTAMP(3),
    "claimedBy" TEXT,
    "response" TEXT NOT NULL DEFAULT '',
    "runId" TEXT,
    "completedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "OwnerRequest_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "OwnerRequest_userId_status_idx" ON "OwnerRequest"("userId", "status");
