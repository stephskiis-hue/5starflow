-- AlterTable
ALTER TABLE "JobberAccount" ADD COLUMN "userId" TEXT;

-- RedefineTables
PRAGMA defer_foreign_keys=ON;
PRAGMA foreign_keys=OFF;
CREATE TABLE "new_SeoSettings" (
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
    "deepAnalysis" BOOLEAN NOT NULL DEFAULT false,
    "updatedAt" DATETIME NOT NULL,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP
);
INSERT INTO "new_SeoSettings" ("auditEnabled", "competitorUrls", "createdAt", "deployBranch", "deployHost", "deployPass", "deployPath", "deployPort", "deployType", "deployUser", "googleAccessToken", "googleRefreshToken", "googleTokenExpiry", "id", "siteProperty", "siteUrl", "updatedAt") SELECT "auditEnabled", "competitorUrls", "createdAt", "deployBranch", "deployHost", "deployPass", "deployPath", "deployPort", "deployType", "deployUser", "googleAccessToken", "googleRefreshToken", "googleTokenExpiry", "id", "siteProperty", "siteUrl", "updatedAt" FROM "SeoSettings";
DROP TABLE "SeoSettings";
ALTER TABLE "new_SeoSettings" RENAME TO "SeoSettings";
PRAGMA foreign_keys=ON;
PRAGMA defer_foreign_keys=OFF;

-- CreateIndex
CREATE INDEX "JobberAccount_userId_idx" ON "JobberAccount"("userId");
