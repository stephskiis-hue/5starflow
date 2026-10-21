-- CreateTable
CREATE TABLE "SiteFileVersion" (
    "id" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "path" TEXT NOT NULL,
    "content" TEXT NOT NULL,
    "reason" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "SiteFileVersion_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "SiteFileVersion_userId_path_createdAt_idx" ON "SiteFileVersion"("userId", "path", "createdAt");
