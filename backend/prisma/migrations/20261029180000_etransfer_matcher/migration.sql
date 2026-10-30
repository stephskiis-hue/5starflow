-- AlterTable
ALTER TABLE "GmailCredential" ADD COLUMN     "scopes" TEXT;

-- CreateTable
CREATE TABLE "EtransferReceipt" (
    "id" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "gmailMessageId" TEXT NOT NULL,
    "referenceNumber" TEXT NOT NULL,
    "senderName" TEXT NOT NULL,
    "senderNameNorm" TEXT NOT NULL,
    "amountCents" INTEGER NOT NULL,
    "sentDate" TIMESTAMP(3),
    "receivedAt" TIMESTAMP(3) NOT NULL,
    "message" TEXT,
    "senderBank" TEXT,
    "kind" TEXT NOT NULL,
    "authOk" BOOLEAN NOT NULL DEFAULT false,
    "status" TEXT NOT NULL DEFAULT 'new',
    "matchKind" TEXT,
    "reason" TEXT,
    "jobberInvoiceId" TEXT,
    "invoiceNumber" TEXT,
    "invoiceIds" JSONB,
    "jobberClientId" TEXT,
    "clientName" TEXT,
    "jobberWebUri" TEXT,
    "candidates" JSONB,
    "proposalIds" JSONB,
    "queuedAt" TIMESTAMP(3),
    "recordAttempts" INTEGER NOT NULL DEFAULT 0,
    "recordClaimedAt" TIMESTAMP(3),
    "markedAt" TIMESTAMP(3),
    "verifiedAt" TIMESTAMP(3),
    "notifiedAt" TIMESTAMP(3),
    "backfill" BOOLEAN NOT NULL DEFAULT false,
    "backfillVerdict" TEXT,
    "error" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "EtransferReceipt_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "PayerAlias" (
    "id" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "payerNameNorm" TEXT NOT NULL,
    "jobberClientId" TEXT NOT NULL,
    "clientName" TEXT NOT NULL DEFAULT '',
    "source" TEXT NOT NULL DEFAULT 'owner_confirmed',
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "PayerAlias_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "EtransferReceipt_userId_status_idx" ON "EtransferReceipt"("userId", "status");

-- CreateIndex
CREATE INDEX "EtransferReceipt_userId_receivedAt_idx" ON "EtransferReceipt"("userId", "receivedAt");

-- CreateIndex
CREATE UNIQUE INDEX "EtransferReceipt_userId_referenceNumber_key" ON "EtransferReceipt"("userId", "referenceNumber");

-- CreateIndex
CREATE UNIQUE INDEX "EtransferReceipt_userId_gmailMessageId_key" ON "EtransferReceipt"("userId", "gmailMessageId");

-- CreateIndex
CREATE UNIQUE INDEX "PayerAlias_userId_payerNameNorm_key" ON "PayerAlias"("userId", "payerNameNorm");

