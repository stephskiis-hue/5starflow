-- Campaign Management System (v2)
-- Creates normalized tables for consent-aware multi-channel campaigns.

CREATE TABLE "clients" (
    "id" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "jobberAccountId" TEXT NOT NULL,
    "jobberClientId" TEXT NOT NULL,
    "fullName" TEXT NOT NULL,
    "primaryPhone" TEXT,
    "primaryEmail" TEXT,
    "smsAllowedFlag" BOOLEAN,
    "smsConsentStatus" TEXT,
    "emailConsentStatus" TEXT,
    "isSmsEligible" BOOLEAN NOT NULL DEFAULT false,
    "isEmailEligible" BOOLEAN NOT NULL DEFAULT false,
    "tags" JSONB NOT NULL DEFAULT '[]'::jsonb,
    "optedOut" BOOLEAN NOT NULL DEFAULT false,
    "optedOutAt" TIMESTAMP(3),
    "syncedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "clients_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "clients_jobberAccountId_jobberClientId_key" ON "clients"("jobberAccountId", "jobberClientId");
CREATE INDEX "clients_userId_idx" ON "clients"("userId");
CREATE INDEX "clients_jobberAccountId_idx" ON "clients"("jobberAccountId");
CREATE INDEX "clients_tags_gin_idx" ON "clients" USING GIN ("tags");

ALTER TABLE "clients"
ADD CONSTRAINT "clients_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;

ALTER TABLE "clients"
ADD CONSTRAINT "clients_jobberAccountId_fkey" FOREIGN KEY ("jobberAccountId") REFERENCES "JobberAccount"("id") ON DELETE CASCADE ON UPDATE CASCADE;

CREATE TABLE "campaigns" (
    "id" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "jobberAccountId" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "type" TEXT NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'draft',
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "campaigns_pkey" PRIMARY KEY ("id"),
    CONSTRAINT "campaigns_type_check" CHECK ("type" IN ('SMS','EMAIL')),
    CONSTRAINT "campaigns_status_check" CHECK ("status" IN ('draft','active','paused','complete','failed'))
);

CREATE UNIQUE INDEX "campaigns_jobberAccountId_name_type_key" ON "campaigns"("jobberAccountId", "name", "type");
CREATE INDEX "campaigns_userId_idx" ON "campaigns"("userId");
CREATE INDEX "campaigns_jobberAccountId_idx" ON "campaigns"("jobberAccountId");

ALTER TABLE "campaigns"
ADD CONSTRAINT "campaigns_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;

ALTER TABLE "campaigns"
ADD CONSTRAINT "campaigns_jobberAccountId_fkey" FOREIGN KEY ("jobberAccountId") REFERENCES "JobberAccount"("id") ON DELETE CASCADE ON UPDATE CASCADE;

CREATE TABLE "campaign_members" (
    "campaignId" TEXT NOT NULL,
    "clientId" TEXT NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'pending',
    "channelOverride" TEXT,
    "isRemoved" BOOLEAN NOT NULL DEFAULT false,
    "sentAt" TIMESTAMP(3),
    "lastError" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "campaign_members_pkey" PRIMARY KEY ("campaignId","clientId"),
    CONSTRAINT "campaign_members_status_check" CHECK ("status" IN ('pending','sent','failed','skipped')),
    CONSTRAINT "campaign_members_override_check" CHECK ("channelOverride" IS NULL OR "channelOverride" IN ('SMS','EMAIL'))
);

CREATE INDEX "campaign_members_campaignId_status_idx" ON "campaign_members"("campaignId","status");

ALTER TABLE "campaign_members"
ADD CONSTRAINT "campaign_members_campaignId_fkey" FOREIGN KEY ("campaignId") REFERENCES "campaigns"("id") ON DELETE CASCADE ON UPDATE CASCADE;

ALTER TABLE "campaign_members"
ADD CONSTRAINT "campaign_members_clientId_fkey" FOREIGN KEY ("clientId") REFERENCES "clients"("id") ON DELETE CASCADE ON UPDATE CASCADE;

