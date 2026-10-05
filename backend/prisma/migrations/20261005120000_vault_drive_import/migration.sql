-- AlterTable
ALTER TABLE "ContentAsset" ADD COLUMN     "driveFileId" TEXT,
ADD COLUMN     "edits" TEXT,
ADD COLUMN     "originalId" TEXT;

-- CreateTable
CREATE TABLE "DriveCredential" (
    "id" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "email" TEXT NOT NULL,
    "accessToken" TEXT NOT NULL DEFAULT '',
    "refreshToken" TEXT,
    "tokenExpiry" TIMESTAMP(3),
    "lastSyncAt" TIMESTAMP(3),
    "backfillPageToken" TEXT,
    "backfillDone" BOOLEAN NOT NULL DEFAULT false,
    "importedCount" INTEGER NOT NULL DEFAULT 0,
    "lastError" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "DriveCredential_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "DriveCredential_userId_key" ON "DriveCredential"("userId");

-- CreateIndex
CREATE UNIQUE INDEX "ContentAsset_userId_driveFileId_key" ON "ContentAsset"("userId", "driveFileId");
