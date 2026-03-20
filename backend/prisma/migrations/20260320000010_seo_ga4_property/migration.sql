-- AlterTable: add ga4PropertyId to SeoSettings (was in schema but missing migration)
ALTER TABLE "SeoSettings" ADD COLUMN IF NOT EXISTS "ga4PropertyId" TEXT;
