-- SMS Marketing System

CREATE TABLE "MarketingTemplate" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "userId" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "body" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL
);

CREATE TABLE "AudienceList" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "userId" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL
);

CREATE TABLE "AudienceContact" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "audienceListId" TEXT NOT NULL,
    "jobberClientId" TEXT NOT NULL,
    "clientName" TEXT NOT NULL,
    "firstName" TEXT NOT NULL,
    "phone" TEXT,
    "smsAllowed" BOOLEAN NOT NULL DEFAULT false,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "AudienceContact_audienceListId_fkey" FOREIGN KEY ("audienceListId") REFERENCES "AudienceList"("id") ON DELETE CASCADE ON UPDATE CASCADE
);

CREATE TABLE "MarketingCampaign" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "userId" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "templateId" TEXT NOT NULL,
    "audienceListId" TEXT NOT NULL,
    "messageBody" TEXT NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'pending',
    "totalRecipients" INTEGER NOT NULL DEFAULT 0,
    "sentCount" INTEGER NOT NULL DEFAULT 0,
    "failedCount" INTEGER NOT NULL DEFAULT 0,
    "skippedCount" INTEGER NOT NULL DEFAULT 0,
    "startedAt" TIMESTAMP(3),
    "completedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP
);

CREATE TABLE "MarketingMessage" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "campaignId" TEXT NOT NULL,
    "jobberClientId" TEXT NOT NULL,
    "clientName" TEXT NOT NULL,
    "firstName" TEXT NOT NULL,
    "phone" TEXT,
    "status" TEXT NOT NULL DEFAULT 'pending',
    "messageSid" TEXT,
    "error" TEXT,
    "sentAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "MarketingMessage_campaignId_fkey" FOREIGN KEY ("campaignId") REFERENCES "MarketingCampaign"("id") ON DELETE CASCADE ON UPDATE CASCADE
);

-- Indexes
CREATE INDEX "MarketingTemplate_userId_idx" ON "MarketingTemplate"("userId");
CREATE INDEX "AudienceList_userId_idx" ON "AudienceList"("userId");
CREATE INDEX "AudienceContact_audienceListId_idx" ON "AudienceContact"("audienceListId");
CREATE UNIQUE INDEX "AudienceContact_audienceListId_jobberClientId_key" ON "AudienceContact"("audienceListId", "jobberClientId");
CREATE INDEX "MarketingCampaign_userId_idx" ON "MarketingCampaign"("userId");
CREATE INDEX "MarketingMessage_campaignId_idx" ON "MarketingMessage"("campaignId");
CREATE INDEX "MarketingMessage_messageSid_idx" ON "MarketingMessage"("messageSid");
