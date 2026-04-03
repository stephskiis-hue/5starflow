-- Add opt-out tracking to CachedJobberClient
-- When a client texts STOP, optedOut=true and they are skipped on all future campaigns

ALTER TABLE "CachedJobberClient" ADD COLUMN "optedOut" BOOLEAN NOT NULL DEFAULT false;
ALTER TABLE "CachedJobberClient" ADD COLUMN "optedOutAt" TIMESTAMP(3);
