-- CreateTable
CREATE TABLE "RainMessage" (
    "id"           TEXT NOT NULL,
    "rescheduleId" TEXT NOT NULL,
    "visitId"      TEXT NOT NULL,
    "clientId"     TEXT NOT NULL,
    "clientName"   TEXT NOT NULL,
    "channel"      TEXT NOT NULL,
    "status"       TEXT NOT NULL DEFAULT 'sent',
    "messageSid"   TEXT,
    "error"        TEXT,
    "sentAt"       TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "userId"       TEXT,

    CONSTRAINT "RainMessage_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "RainMessage_rescheduleId_idx" ON "RainMessage"("rescheduleId");

-- CreateIndex
CREATE INDEX "RainMessage_userId_idx" ON "RainMessage"("userId");
