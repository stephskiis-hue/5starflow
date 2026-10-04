-- AlterTable
ALTER TABLE "ContentAsset" ADD COLUMN     "pairKey" TEXT,
ADD COLUMN     "private" BOOLEAN NOT NULL DEFAULT false,
ADD COLUMN     "quality" INTEGER;

