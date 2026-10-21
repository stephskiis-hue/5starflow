-- CreateTable
CREATE TABLE "SiteJob" (
    "id" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "invoiceId" TEXT NOT NULL,
    "cluster" TEXT NOT NULL,
    "fsa" TEXT,
    "area" TEXT,
    "doneAt" TIMESTAMP(3) NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "SiteJob_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "SiteJob_userId_doneAt_idx" ON "SiteJob"("userId", "doneAt");

-- CreateIndex
CREATE UNIQUE INDEX "SiteJob_userId_invoiceId_key" ON "SiteJob"("userId", "invoiceId");
