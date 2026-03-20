-- CreateTable
CREATE TABLE "MessageSettings" (
    "id" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "smsTemplate" TEXT,
    "emailSubject" TEXT,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "MessageSettings_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "MessageSettings_userId_key" ON "MessageSettings"("userId");
