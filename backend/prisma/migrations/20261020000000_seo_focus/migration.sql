-- AlterTable
ALTER TABLE "SeoKeyword" ADD COLUMN     "focus" BOOLEAN NOT NULL DEFAULT false,
ADD COLUMN     "focusGoal" INTEGER NOT NULL DEFAULT 3,
ADD COLUMN     "focusSince" TIMESTAMP(3),
ADD COLUMN     "focusStatus" TEXT,
ADD COLUMN     "supportsId" TEXT;

-- AlterTable
ALTER TABLE "SeoPage" ADD COLUMN     "linkedFrom" JSONB;

-- CreateTable
CREATE TABLE "SeoFocusStep" (
    "id" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "keywordId" TEXT NOT NULL,
    "kind" TEXT NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'planned',
    "title" TEXT NOT NULL,
    "detail" JSONB,
    "refId" TEXT,
    "doneAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "SeoFocusStep_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "SeoFocusStep_userId_keywordId_idx" ON "SeoFocusStep"("userId", "keywordId");

-- CreateIndex
CREATE INDEX "SeoFocusStep_userId_status_idx" ON "SeoFocusStep"("userId", "status");

-- CreateIndex
CREATE INDEX "SeoKeyword_userId_supportsId_idx" ON "SeoKeyword"("userId", "supportsId");
