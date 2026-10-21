-- CreateTable
CREATE TABLE "WfpSetting" (
    "key" TEXT NOT NULL,
    "value" TEXT NOT NULL,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "WfpSetting_pkey" PRIMARY KEY ("key")
);

-- CreateTable
CREATE TABLE "WfpKeyword" (
    "id" TEXT NOT NULL,
    "keyword" TEXT NOT NULL,
    "matchKey" TEXT NOT NULL,
    "service" TEXT,
    "intent" TEXT NOT NULL DEFAULT 'informational',
    "source" TEXT NOT NULL DEFAULT 'owner',
    "status" TEXT NOT NULL DEFAULT 'idea',
    "statusChangedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "priority" DOUBLE PRECISION NOT NULL DEFAULT 0,
    "why" TEXT,
    "recommended" BOOLEAN NOT NULL DEFAULT false,
    "recommendedAt" TIMESTAMP(3),
    "dismissedUntil" TIMESTAMP(3),
    "clicks28" INTEGER NOT NULL DEFAULT 0,
    "impressions28" INTEGER NOT NULL DEFAULT 0,
    "position28" DOUBLE PRECISION,
    "prevImpressions28" INTEGER,
    "prevPosition28" DOUBLE PRECISION,
    "topPage" TEXT,
    "rankTrack" BOOLEAN NOT NULL DEFAULT false,
    "serpPosition" INTEGER,
    "mapPackPosition" INTEGER,
    "serpCheckedAt" TIMESTAMP(3),
    "serpTop" JSONB,
    "signals" JSONB,
    "history" JSONB,
    "focus" BOOLEAN NOT NULL DEFAULT false,
    "focusStatus" TEXT,
    "focusGoal" INTEGER NOT NULL DEFAULT 3,
    "focusSince" TIMESTAMP(3),
    "supportsId" TEXT,
    "postId" TEXT,
    "targetUrl" TEXT,
    "publishedAt" TIMESTAMP(3),
    "refreshedAt" TIMESTAMP(3),
    "notes" TEXT NOT NULL DEFAULT '',
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "WfpKeyword_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "WfpQuery" (
    "query" TEXT NOT NULL,
    "page" TEXT NOT NULL,
    "clicks" INTEGER NOT NULL,
    "impressions" INTEGER NOT NULL,
    "position" DOUBLE PRECISION NOT NULL,
    "prevImpressions" INTEGER NOT NULL DEFAULT 0,
    "prevPosition" DOUBLE PRECISION,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "WfpQuery_pkey" PRIMARY KEY ("query","page")
);

-- CreateTable
CREATE TABLE "WfpDaily" (
    "date" DATE NOT NULL,
    "clicks" INTEGER NOT NULL,
    "impressions" INTEGER NOT NULL,
    "ctr" DOUBLE PRECISION NOT NULL,
    "position" DOUBLE PRECISION NOT NULL,

    CONSTRAINT "WfpDaily_pkey" PRIMARY KEY ("date")
);

-- CreateTable
CREATE TABLE "WfpPost" (
    "id" TEXT NOT NULL,
    "keywordId" TEXT,
    "keyword" TEXT,
    "mode" TEXT NOT NULL DEFAULT 'new',
    "slug" TEXT NOT NULL,
    "title" TEXT NOT NULL,
    "metaDescription" TEXT NOT NULL DEFAULT '',
    "excerpt" TEXT NOT NULL DEFAULT '',
    "category" TEXT NOT NULL DEFAULT '',
    "readTime" INTEGER NOT NULL DEFAULT 5,
    "imageQuery" TEXT,
    "html" TEXT NOT NULL,
    "sources" JSONB,
    "status" TEXT NOT NULL DEFAULT 'draft',
    "url" TEXT,
    "error" TEXT,
    "log" TEXT,
    "publishedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "WfpPost_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "WfpRun" (
    "id" TEXT NOT NULL,
    "job" TEXT NOT NULL,
    "trigger" TEXT NOT NULL DEFAULT 'schedule',
    "status" TEXT NOT NULL DEFAULT 'running',
    "summary" TEXT,
    "detail" JSONB,
    "error" TEXT,
    "startedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "finishedAt" TIMESTAMP(3),

    CONSTRAINT "WfpRun_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "WfpNote" (
    "id" TEXT NOT NULL,
    "author" TEXT NOT NULL DEFAULT 'owner',
    "kind" TEXT NOT NULL DEFAULT 'note',
    "title" TEXT NOT NULL DEFAULT '',
    "body" TEXT NOT NULL,
    "done" BOOLEAN NOT NULL DEFAULT false,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "WfpNote_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "WfpKeyword_matchKey_key" ON "WfpKeyword"("matchKey");

-- CreateIndex
CREATE INDEX "WfpKeyword_status_idx" ON "WfpKeyword"("status");

-- CreateIndex
CREATE INDEX "WfpKeyword_supportsId_idx" ON "WfpKeyword"("supportsId");

-- CreateIndex
CREATE INDEX "WfpPost_status_idx" ON "WfpPost"("status");

-- CreateIndex
CREATE INDEX "WfpPost_slug_idx" ON "WfpPost"("slug");

-- CreateIndex
CREATE INDEX "WfpRun_job_startedAt_idx" ON "WfpRun"("job", "startedAt");

-- CreateIndex
CREATE INDEX "WfpNote_kind_createdAt_idx" ON "WfpNote"("kind", "createdAt");
