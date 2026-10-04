-- Optional Twilio Messaging Service (MG...) per user.
--
-- A single long code carries ~1 SMS segment/second, so a large campaign is
-- handed to Twilio in minutes and then drains for half an hour, with any later
-- message queued behind it. A Messaging Service spreads the same traffic across
-- a pool of senders and manages the queue on Twilio's side.
--
-- Nullable: when unset, sends continue to use fromNumber exactly as before.

-- AlterTable
ALTER TABLE "TwilioCredential" ADD COLUMN "messagingServiceSid" TEXT;
