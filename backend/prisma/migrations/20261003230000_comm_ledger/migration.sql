-- CreateTable
CREATE TABLE "CommMessage" (
    "id" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "channel" TEXT NOT NULL DEFAULT 'sms',
    "direction" TEXT NOT NULL,
    "phone" TEXT,
    "phoneKey" TEXT,
    "email" TEXT,
    "jobberClientId" TEXT,
    "clientName" TEXT,
    "body" TEXT NOT NULL DEFAULT '',
    "source" TEXT NOT NULL DEFAULT 'system',
    "sourceId" TEXT,
    "providerId" TEXT,
    "status" TEXT,
    "at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "CommMessage_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "CommMessage_userId_phoneKey_at_idx" ON "CommMessage"("userId", "phoneKey", "at");

-- CreateIndex
CREATE INDEX "CommMessage_userId_direction_at_idx" ON "CommMessage"("userId", "direction", "at");

-- CreateIndex
CREATE UNIQUE INDEX "CommMessage_userId_channel_direction_providerId_key" ON "CommMessage"("userId", "channel", "direction", "providerId");

