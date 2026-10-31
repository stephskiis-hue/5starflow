-- AlterTable
ALTER TABLE "EtransferReceipt" ADD COLUMN     "evidence" JSONB,
ADD COLUMN     "outcome" TEXT,
ADD COLUMN     "outcomeAt" TIMESTAMP(3),
ADD COLUMN     "outcomeCheckedAt" TIMESTAMP(3);
