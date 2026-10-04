-- Separate Twilio's delivery lifecycle from our dispatch lifecycle.
--
-- Background: the dispatcher used to mark a row status='sent' the moment
-- twilio.messages.create() returned a SID. That only means Twilio ACCEPTED the
-- request (Twilio's own term for that state is "queued") — it says nothing about
-- whether a handset ever received it. Meanwhile the status callback wrote
-- Twilio's raw MessageStatus into the same column, clobbering our state machine.
--
-- Now: status = our dispatch state, deliveryStatus = Twilio's delivery state.

-- AlterTable
ALTER TABLE "MarketingMessage" ADD COLUMN "segments" INTEGER NOT NULL DEFAULT 1;
ALTER TABLE "MarketingMessage" ADD COLUMN "encoding" TEXT;
ALTER TABLE "MarketingMessage" ADD COLUMN "deliveryStatus" TEXT;
ALTER TABLE "MarketingMessage" ADD COLUMN "deliveredAt" TIMESTAMP(3);
ALTER TABLE "MarketingMessage" ADD COLUMN "carrierErrorCode" TEXT;

-- Backfill: rows the old status callback had already overwritten with a raw
-- Twilio MessageStatus. Move that value into deliveryStatus, then restore the
-- dispatch status to what it actually was ("queued" — handed to Twilio).
UPDATE "MarketingMessage"
   SET "deliveryStatus" = "status",
       "deliveredAt"    = CASE WHEN "status" = 'delivered' THEN COALESCE("sentAt", "lastAttemptAt") ELSE NULL END,
       "status"         = CASE WHEN "status" = 'undelivered' THEN 'failed' ELSE 'queued' END
 WHERE "status" IN ('queued', 'sending', 'delivered', 'undelivered');

-- Legacy rows that our own dispatcher marked 'sent' mean "accepted by Twilio".
-- Rename them to 'queued' so the word "sent" stops implying delivery.
UPDATE "MarketingMessage" SET "status" = 'queued' WHERE "status" = 'sent';

-- CreateIndex
CREATE INDEX "MarketingMessage_campaignId_deliveryStatus_idx" ON "MarketingMessage"("campaignId", "deliveryStatus");
