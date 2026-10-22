-- CreateTable
CREATE TABLE "WfpAssignment" (
    "id" TEXT NOT NULL,
    "keywordId" TEXT NOT NULL,
    "keyword" TEXT NOT NULL,
    "mode" TEXT NOT NULL,
    "brief" JSONB NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'reserved',
    "expiresAt" TIMESTAMP(3) NOT NULL,
    "postId" TEXT,
    "skipReason" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "WfpAssignment_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "WfpAssignment_status_createdAt_idx" ON "WfpAssignment"("status", "createdAt");
