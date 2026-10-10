-- AlterTable
ALTER TABLE "SeoSettings" ADD COLUMN     "growthConfig" JSONB,
ADD COLUMN     "growthState" JSONB;

-- CreateTable
CREATE TABLE "SeoDailyTotal" (
    "userId" TEXT NOT NULL,
    "date" DATE NOT NULL,
    "clicks" INTEGER NOT NULL,
    "impressions" INTEGER NOT NULL,
    "ctr" DOUBLE PRECISION NOT NULL,
    "position" DOUBLE PRECISION NOT NULL,
    "final" BOOLEAN NOT NULL DEFAULT false,

    CONSTRAINT "SeoDailyTotal_pkey" PRIMARY KEY ("userId","date")
);

-- CreateTable
CREATE TABLE "SeoQueryStat" (
    "userId" TEXT NOT NULL,
    "date" DATE NOT NULL,
    "query" TEXT NOT NULL,
    "page" TEXT NOT NULL,
    "clicks" INTEGER NOT NULL,
    "impressions" INTEGER NOT NULL,
    "position" DOUBLE PRECISION NOT NULL,
    "final" BOOLEAN NOT NULL DEFAULT false,

    CONSTRAINT "SeoQueryStat_pkey" PRIMARY KEY ("userId","date","query","page")
);

-- CreateTable
CREATE TABLE "SeoQueryMonth" (
    "userId" TEXT NOT NULL,
    "month" DATE NOT NULL,
    "query" TEXT NOT NULL,
    "page" TEXT NOT NULL,
    "clicks" INTEGER NOT NULL,
    "impressions" INTEGER NOT NULL,
    "position" DOUBLE PRECISION NOT NULL,

    CONSTRAINT "SeoQueryMonth_pkey" PRIMARY KEY ("userId","month","query","page")
);

-- CreateTable
CREATE TABLE "SeoKeyword" (
    "id" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "keyword" TEXT NOT NULL,
    "matchKey" TEXT NOT NULL,
    "cluster" TEXT NOT NULL,
    "intent" TEXT NOT NULL DEFAULT 'informational',
    "kind" TEXT NOT NULL DEFAULT 'blog',
    "area" TEXT,
    "source" TEXT NOT NULL DEFAULT 'seed',
    "status" TEXT NOT NULL DEFAULT 'idea',
    "statusChangedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "pinned" BOOLEAN NOT NULL DEFAULT false,
    "rankTrack" BOOLEAN NOT NULL DEFAULT false,
    "priority" DOUBLE PRECISION NOT NULL DEFAULT 0,
    "scoreParts" JSONB,
    "signals" JSONB,
    "targetPath" TEXT,
    "clicks28" INTEGER NOT NULL DEFAULT 0,
    "impressions28" INTEGER NOT NULL DEFAULT 0,
    "position28" DOUBLE PRECISION,
    "baselinePosition" DOUBLE PRECISION,
    "baselineImpressions" INTEGER,
    "baselineAt" TIMESTAMP(3),
    "bestPosition" DOUBLE PRECISION,
    "bestPositionAt" TIMESTAMP(3),
    "serpPosition" INTEGER,
    "mapPackPosition" INTEGER,
    "serpCheckedAt" TIMESTAMP(3),
    "history" JSONB,
    "lockedUntil" TIMESTAMP(3),
    "lockedBy" TEXT,
    "lastAssignedAt" TIMESTAMP(3),
    "publishedAt" TIMESTAMP(3),
    "notes" TEXT NOT NULL DEFAULT '',
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "SeoKeyword_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "SeoPage" (
    "id" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "path" TEXT NOT NULL,
    "kind" TEXT NOT NULL DEFAULT 'other',
    "title" TEXT,
    "h1" TEXT,
    "primaryKeyword" TEXT,
    "secondaryKeywords" JSONB,
    "cluster" TEXT,
    "contentType" TEXT,
    "wordCount" INTEGER,
    "source" TEXT NOT NULL DEFAULT 'crawl',
    "inSitemap" BOOLEAN NOT NULL DEFAULT false,
    "sitemapUrl" TEXT,
    "inPostsJson" BOOLEAN,
    "inlinks" INTEGER NOT NULL DEFAULT 0,
    "httpStatus" INTEGER,
    "redirectTo" TEXT,
    "canonical" TEXT,
    "canonicalOk" BOOLEAN,
    "noindex" BOOLEAN NOT NULL DEFAULT false,
    "contentHash" TEXT,
    "contentChangedAt" TIMESTAMP(3),
    "indexVerdict" TEXT,
    "coverageState" TEXT,
    "googleCanonical" TEXT,
    "lastCrawlTime" TIMESTAMP(3),
    "lastInspectedAt" TIMESTAMP(3),
    "indexedAt" TIMESTAMP(3),
    "clicks28" INTEGER NOT NULL DEFAULT 0,
    "impressions28" INTEGER NOT NULL DEFAULT 0,
    "position28" DOUBLE PRECISION,
    "publishedAt" TIMESTAMP(3),
    "refreshedAt" TIMESTAMP(3),
    "lastCheckedAt" TIMESTAMP(3),
    "excluded" BOOLEAN NOT NULL DEFAULT false,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "SeoPage_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "SeoSitemap" (
    "id" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "url" TEXT NOT NULL,
    "isIndex" BOOLEAN NOT NULL DEFAULT false,
    "parentUrl" TEXT,
    "urlCount" INTEGER NOT NULL DEFAULT 0,
    "contentHash" TEXT,
    "hashChangedAt" TIMESTAMP(3),
    "submittedHash" TEXT,
    "httpStatus" INTEGER,
    "lastFetchedAt" TIMESTAMP(3),
    "lastSubmittedAt" TIMESTAMP(3),
    "gscLastSubmitted" TIMESTAMP(3),
    "gscLastDownloaded" TIMESTAMP(3),
    "gscIsPending" BOOLEAN,
    "gscErrors" INTEGER,
    "gscWarnings" INTEGER,
    "gscSubmittedUrls" INTEGER,
    "lastError" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "SeoSitemap_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "SeoAssignment" (
    "id" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "keywordId" TEXT NOT NULL,
    "keywordText" TEXT NOT NULL,
    "cluster" TEXT,
    "mode" TEXT NOT NULL,
    "contentType" TEXT,
    "status" TEXT NOT NULL DEFAULT 'reserved',
    "brief" JSONB NOT NULL,
    "targetPath" TEXT,
    "reservedBy" TEXT,
    "expiresAt" TIMESTAMP(3) NOT NULL,
    "publishedPath" TEXT,
    "publishedAt" TIMESTAMP(3),
    "skipReason" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "SeoAssignment_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "SeoProgressReport" (
    "id" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "periodStart" TIMESTAMP(3) NOT NULL,
    "periodEnd" TIMESTAMP(3) NOT NULL,
    "metrics" JSONB NOT NULL,
    "narrative" TEXT NOT NULL,
    "nextFocus" TEXT NOT NULL DEFAULT '',
    "author" TEXT NOT NULL DEFAULT 'content',
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "SeoProgressReport_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "SeoKeyword_userId_status_idx" ON "SeoKeyword"("userId", "status");

-- CreateIndex
CREATE INDEX "SeoKeyword_userId_cluster_idx" ON "SeoKeyword"("userId", "cluster");

-- CreateIndex
CREATE UNIQUE INDEX "SeoKeyword_userId_matchKey_key" ON "SeoKeyword"("userId", "matchKey");

-- CreateIndex
CREATE INDEX "SeoPage_userId_kind_idx" ON "SeoPage"("userId", "kind");

-- CreateIndex
CREATE UNIQUE INDEX "SeoPage_userId_path_key" ON "SeoPage"("userId", "path");

-- CreateIndex
CREATE UNIQUE INDEX "SeoSitemap_userId_url_key" ON "SeoSitemap"("userId", "url");

-- CreateIndex
CREATE INDEX "SeoAssignment_userId_status_idx" ON "SeoAssignment"("userId", "status");

-- CreateIndex
CREATE INDEX "SeoAssignment_userId_createdAt_idx" ON "SeoAssignment"("userId", "createdAt");

-- CreateIndex
CREATE INDEX "SeoProgressReport_userId_createdAt_idx" ON "SeoProgressReport"("userId", "createdAt");

