-- Full PostgreSQL schema for 5StarFlow backend

CREATE TABLE "JobberAccount" (
    "id"           TEXT NOT NULL,
    "accountId"    TEXT NOT NULL,
    "userId"       TEXT,
    "accessToken"  TEXT NOT NULL,
    "refreshToken" TEXT NOT NULL,
    "expiresAt"    TIMESTAMP(3) NOT NULL,
    "webhookId"    TEXT,
    "createdAt"    TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt"    TIMESTAMP(3) NOT NULL,
    CONSTRAINT "JobberAccount_pkey" PRIMARY KEY ("id")
);
CREATE UNIQUE INDEX "JobberAccount_accountId_key" ON "JobberAccount"("accountId");
CREATE INDEX "JobberAccount_userId_idx" ON "JobberAccount"("userId");

CREATE TABLE "TokenRefreshLog" (
    "id"        TEXT NOT NULL,
    "accountId" TEXT NOT NULL,
    "success"   BOOLEAN NOT NULL,
    "message"   TEXT NOT NULL,
    "trigger"   TEXT NOT NULL DEFAULT 'scheduler',
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "TokenRefreshLog_pkey" PRIMARY KEY ("id")
);

CREATE TABLE "ReviewSent" (
    "id"        TEXT NOT NULL,
    "clientId"  TEXT NOT NULL,
    "invoiceId" TEXT NOT NULL,
    "sentAt"    TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "ReviewSent_pkey" PRIMARY KEY ("id")
);
CREATE UNIQUE INDEX "ReviewSent_clientId_key" ON "ReviewSent"("clientId");

CREATE TABLE "User" (
    "id"           TEXT NOT NULL,
    "email"        TEXT NOT NULL,
    "passwordHash" TEXT NOT NULL,
    "isActive"     BOOLEAN NOT NULL DEFAULT true,
    "createdAt"    TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "User_pkey" PRIMARY KEY ("id")
);
CREATE UNIQUE INDEX "User_email_key" ON "User"("email");

CREATE TABLE "PendingReview" (
    "id"          TEXT NOT NULL,
    "invoiceId"   TEXT NOT NULL,
    "clientId"    TEXT NOT NULL,
    "clientName"  TEXT NOT NULL,
    "firstName"   TEXT NOT NULL,
    "phone"       TEXT,
    "smsAllowed"  BOOLEAN NOT NULL DEFAULT false,
    "email"       TEXT,
    "scheduledAt" TIMESTAMP(3) NOT NULL,
    "processed"   BOOLEAN NOT NULL DEFAULT false,
    "cancelled"   BOOLEAN NOT NULL DEFAULT false,
    "createdAt"   TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "PendingReview_pkey" PRIMARY KEY ("id")
);
CREATE UNIQUE INDEX "PendingReview_invoiceId_key" ON "PendingReview"("invoiceId");

CREATE TABLE "WeatherCheck" (
    "id"              TEXT NOT NULL,
    "date"            TEXT NOT NULL,
    "rainExpected"    BOOLEAN NOT NULL,
    "maxPrecipProb"   DOUBLE PRECISION NOT NULL,
    "forecastSummary" TEXT NOT NULL,
    "checkedAt"       TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "WeatherCheck_pkey" PRIMARY KEY ("id")
);

CREATE TABLE "RainReschedule" (
    "id"           TEXT NOT NULL,
    "originalDay"  TEXT NOT NULL,
    "originalDate" TEXT NOT NULL,
    "newDate"      TEXT NOT NULL,
    "clientCount"  INTEGER NOT NULL,
    "smsCount"     INTEGER NOT NULL DEFAULT 0,
    "emailCount"   INTEGER NOT NULL DEFAULT 0,
    "message"      TEXT NOT NULL,
    "notifiedAt"   TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "RainReschedule_pkey" PRIMARY KEY ("id")
);

CREATE TABLE "WeatherSettings" (
    "id"                     TEXT NOT NULL,
    "city"                   TEXT NOT NULL DEFAULT 'Winnipeg',
    "rainThreshold"          DOUBLE PRECISION NOT NULL DEFAULT 0.4,
    "businessStartHour"      INTEGER NOT NULL DEFAULT 7,
    "businessEndHour"        INTEGER NOT NULL DEFAULT 18,
    "preferredRescheduleDay" TEXT NOT NULL DEFAULT '',
    "checkEnabled"           BOOLEAN NOT NULL DEFAULT true,
    CONSTRAINT "WeatherSettings_pkey" PRIMARY KEY ("id")
);

CREATE TABLE "SeoAudit" (
    "id"               TEXT NOT NULL,
    "siteUrl"          TEXT NOT NULL,
    "status"           TEXT NOT NULL DEFAULT 'running',
    "performanceScore" INTEGER,
    "lcp"              DOUBLE PRECISION,
    "cls"              DOUBLE PRECISION,
    "fid"              DOUBLE PRECISION,
    "keywordsJson"     TEXT,
    "competitorJson"   TEXT,
    "insightJson"      TEXT,
    "runAt"            TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "SeoAudit_pkey" PRIMARY KEY ("id")
);

CREATE TABLE "SeoProposal" (
    "id"          TEXT NOT NULL,
    "auditId"     TEXT NOT NULL,
    "status"      TEXT NOT NULL DEFAULT 'pending',
    "title"       TEXT NOT NULL,
    "summaryJson" TEXT NOT NULL,
    "respondedAt" TIMESTAMP(3),
    "createdAt"   TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "SeoProposal_pkey" PRIMARY KEY ("id")
);

CREATE TABLE "SeoChange" (
    "id"          TEXT NOT NULL,
    "proposalId"  TEXT NOT NULL,
    "filePath"    TEXT NOT NULL,
    "oldContent"  TEXT NOT NULL,
    "newContent"  TEXT NOT NULL,
    "description" TEXT NOT NULL,
    "status"      TEXT NOT NULL DEFAULT 'pending',
    "appliedAt"   TIMESTAMP(3),
    "errorMsg"    TEXT,
    "createdAt"   TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "SeoChange_pkey" PRIMARY KEY ("id")
);

CREATE TABLE "FtpConfig" (
    "id"                TEXT NOT NULL,
    "host"              TEXT NOT NULL,
    "user"              TEXT NOT NULL,
    "encryptedPassword" TEXT NOT NULL,
    "rootPath"          TEXT NOT NULL DEFAULT '/public_html',
    "port"              INTEGER NOT NULL DEFAULT 21,
    "createdAt"         TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt"         TIMESTAMP(3) NOT NULL,
    CONSTRAINT "FtpConfig_pkey" PRIMARY KEY ("id")
);

CREATE TABLE "AuditIgnore" (
    "id"        TEXT NOT NULL,
    "pattern"   TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "AuditIgnore_pkey" PRIMARY KEY ("id")
);
CREATE UNIQUE INDEX "AuditIgnore_pattern_key" ON "AuditIgnore"("pattern");

CREATE TABLE "AuditPage" (
    "id"              TEXT NOT NULL,
    "path"            TEXT NOT NULL,
    "filename"        TEXT NOT NULL,
    "status"          TEXT NOT NULL DEFAULT 'discovered',
    "localContent"    TEXT,
    "lastPulled"      TIMESTAMP(3),
    "lastPushed"      TIMESTAMP(3),
    "auditScore"      INTEGER,
    "seoScore"        INTEGER,
    "perfScore"       INTEGER,
    "auditIssuesJson" TEXT,
    "pageUrl"         TEXT,
    "createdAt"       TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt"       TIMESTAMP(3) NOT NULL,
    CONSTRAINT "AuditPage_pkey" PRIMARY KEY ("id")
);
CREATE UNIQUE INDEX "AuditPage_path_key" ON "AuditPage"("path");

CREATE TABLE "SeoSettings" (
    "id"                 TEXT NOT NULL,
    "siteUrl"            TEXT NOT NULL DEFAULT '',
    "competitorUrls"     TEXT NOT NULL DEFAULT '[]',
    "deployType"         TEXT NOT NULL DEFAULT 'none',
    "deployHost"         TEXT,
    "deployPort"         INTEGER,
    "deployUser"         TEXT,
    "deployPass"         TEXT,
    "deployPath"         TEXT,
    "deployBranch"       TEXT NOT NULL DEFAULT 'main',
    "googleAccessToken"  TEXT,
    "googleRefreshToken" TEXT,
    "googleTokenExpiry"  TIMESTAMP(3),
    "siteProperty"       TEXT,
    "auditEnabled"       BOOLEAN NOT NULL DEFAULT true,
    "deepAnalysis"       BOOLEAN NOT NULL DEFAULT false,
    "updatedAt"          TIMESTAMP(3) NOT NULL,
    "createdAt"          TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "SeoSettings_pkey" PRIMARY KEY ("id")
);
