-- AlterTable
ALTER TABLE "WfpKeyword" ADD COLUMN     "refreshAsked" TIMESTAMP(3),
ADD COLUMN     "refreshReason" TEXT;

-- AlterTable
ALTER TABLE "WfpPost" ADD COLUMN     "faq" JSONB;
