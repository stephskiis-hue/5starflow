-- Migration: add CachedJobberClient, InboundSMS tables
-- add notifyPhone to TwilioCredential
-- add replyBody, replyReceivedAt to MarketingMessage

-- CachedJobberClient: local mirror of Jobber clients, populated by background sync
CREATE TABLE "CachedJobberClient" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "userId" TEXT NOT NULL,
    "jobberClientId" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "firstName" TEXT NOT NULL,
    "phone" TEXT,
    "smsAllowed" BOOLEAN NOT NULL DEFAULT false,
    "tags" TEXT NOT NULL DEFAULT '[]',
    "syncedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP
);
CREATE UNIQUE INDEX "CachedJobberClient_userId_jobberClientId_key" ON "CachedJobberClient"("userId", "jobberClientId");
CREATE INDEX "CachedJobberClient_userId_idx" ON "CachedJobberClient"("userId");

-- InboundSMS: every message received on the Twilio marketing number
CREATE TABLE "InboundSMS" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "userId" TEXT NOT NULL,
    "from" TEXT NOT NULL,
    "body" TEXT NOT NULL,
    "messageSid" TEXT NOT NULL,
    "isResponse" BOOLEAN NOT NULL DEFAULT false,
    "response" TEXT,
    "clientName" TEXT,
    "jobberClientId" TEXT,
    "campaignId" TEXT,
    "notified" BOOLEAN NOT NULL DEFAULT false,
    "read" BOOLEAN NOT NULL DEFAULT false,
    "receivedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP
);
CREATE UNIQUE INDEX "InboundSMS_messageSid_key" ON "InboundSMS"("messageSid");
CREATE INDEX "InboundSMS_userId_idx" ON "InboundSMS"("userId");
CREATE INDEX "InboundSMS_from_idx" ON "InboundSMS"("from");

-- Add notifyPhone to TwilioCredential (admin's personal mobile for Y/N reply alerts)
ALTER TABLE "TwilioCredential" ADD COLUMN "notifyPhone" TEXT;

-- Add reply tracking fields to MarketingMessage
ALTER TABLE "MarketingMessage" ADD COLUMN "replyBody" TEXT;
ALTER TABLE "MarketingMessage" ADD COLUMN "replyReceivedAt" TIMESTAMP(3);
