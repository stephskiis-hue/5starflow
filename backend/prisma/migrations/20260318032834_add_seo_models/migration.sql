-- CreateTable
CREATE TABLE "SeoAudit" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "siteUrl" TEXT NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'running',
    "performanceScore" INTEGER,
    "lcp" REAL,
    "cls" REAL,
    "fid" REAL,
    "keywordsJson" TEXT,
    "competitorJson" TEXT,
    "insightJson" TEXT,
    "runAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP
);

-- CreateTable
CREATE TABLE "SeoProposal" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "auditId" TEXT NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'pending',
    "title" TEXT NOT NULL,
    "summaryJson" TEXT NOT NULL,
    "respondedAt" DATETIME,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP
);

-- CreateTable
CREATE TABLE "SeoChange" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "proposalId" TEXT NOT NULL,
    "filePath" TEXT NOT NULL,
    "oldContent" TEXT NOT NULL,
    "newContent" TEXT NOT NULL,
    "description" TEXT NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'pending',
    "appliedAt" DATETIME,
    "errorMsg" TEXT,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP
);

-- CreateTable
CREATE TABLE "SeoSettings" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "siteUrl" TEXT NOT NULL DEFAULT '',
    "competitorUrls" TEXT NOT NULL DEFAULT '[]',
    "deployType" TEXT NOT NULL DEFAULT 'none',
    "deployHost" TEXT,
    "deployPort" INTEGER,
    "deployUser" TEXT,
    "deployPass" TEXT,
    "deployPath" TEXT,
    "deployBranch" TEXT NOT NULL DEFAULT 'main',
    "googleAccessToken" TEXT,
    "googleRefreshToken" TEXT,
    "googleTokenExpiry" DATETIME,
    "siteProperty" TEXT,
    "auditEnabled" BOOLEAN NOT NULL DEFAULT true,
    "updatedAt" DATETIME NOT NULL,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP
);
