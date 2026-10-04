-- CreateTable
CREATE TABLE "ContentAsset" (
    "id" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "kind" TEXT NOT NULL DEFAULT 'photo',
    "name" TEXT NOT NULL,
    "mime" TEXT NOT NULL,
    "bytes" BYTEA NOT NULL,
    "size" INTEGER NOT NULL,
    "sha256" TEXT NOT NULL,
    "width" INTEGER,
    "height" INTEGER,
    "tags" TEXT NOT NULL DEFAULT '[]',
    "source" TEXT NOT NULL DEFAULT 'upload',
    "notes" TEXT,
    "contentItemId" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "ContentAsset_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "ContentItem" (
    "id" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'draft',
    "title" TEXT NOT NULL,
    "pillar" TEXT,
    "format" TEXT NOT NULL DEFAULT 'post',
    "layout" TEXT,
    "platforms" TEXT NOT NULL DEFAULT '["facebook"]',
    "slots" JSONB,
    "caption" TEXT NOT NULL DEFAULT '',
    "captionIg" TEXT,
    "groupId" TEXT,
    "assetIds" JSONB,
    "qa" JSONB,
    "grounding" TEXT,
    "source" TEXT,
    "scheduledFor" TIMESTAMP(3),
    "approvedAt" TIMESTAMP(3),
    "publishedAt" TIMESTAMP(3),
    "postUrl" TEXT,
    "metrics" JSONB,
    "note" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "ContentItem_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "SocialGroup" (
    "id" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "platform" TEXT NOT NULL DEFAULT 'facebook',
    "name" TEXT NOT NULL,
    "url" TEXT,
    "location" TEXT,
    "audience" TEXT,
    "relevance" INTEGER NOT NULL DEFAULT 3,
    "membership" TEXT NOT NULL DEFAULT 'unknown',
    "rules" TEXT NOT NULL DEFAULT '',
    "promoPolicy" TEXT NOT NULL DEFAULT 'unknown',
    "promoNotes" TEXT NOT NULL DEFAULT '',
    "cooldownDays" INTEGER NOT NULL DEFAULT 14,
    "topics" TEXT NOT NULL DEFAULT '',
    "notes" TEXT NOT NULL DEFAULT '',
    "leads" INTEGER NOT NULL DEFAULT 0,
    "postsCount" INTEGER NOT NULL DEFAULT 0,
    "lastCheckedAt" TIMESTAMP(3),
    "lastPostedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "SocialGroup_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "SocialAction" (
    "id" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "platform" TEXT NOT NULL,
    "kind" TEXT NOT NULL,
    "target" TEXT,
    "groupId" TEXT,
    "contentItemId" TEXT,
    "summary" TEXT NOT NULL DEFAULT '',
    "status" TEXT NOT NULL DEFAULT 'done',
    "url" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "SocialAction_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "ContentAsset_userId_kind_idx" ON "ContentAsset"("userId", "kind");

-- CreateIndex
CREATE INDEX "ContentAsset_contentItemId_idx" ON "ContentAsset"("contentItemId");

-- CreateIndex
CREATE UNIQUE INDEX "ContentAsset_userId_sha256_key" ON "ContentAsset"("userId", "sha256");

-- CreateIndex
CREATE INDEX "ContentItem_userId_status_idx" ON "ContentItem"("userId", "status");

-- CreateIndex
CREATE INDEX "ContentItem_userId_scheduledFor_idx" ON "ContentItem"("userId", "scheduledFor");

-- CreateIndex
CREATE INDEX "SocialGroup_userId_membership_idx" ON "SocialGroup"("userId", "membership");

-- CreateIndex
CREATE UNIQUE INDEX "SocialGroup_userId_platform_name_key" ON "SocialGroup"("userId", "platform", "name");

-- CreateIndex
CREATE INDEX "SocialAction_userId_platform_kind_createdAt_idx" ON "SocialAction"("userId", "platform", "kind", "createdAt");

-- CreateIndex
CREATE INDEX "SocialAction_userId_createdAt_idx" ON "SocialAction"("userId", "createdAt");

