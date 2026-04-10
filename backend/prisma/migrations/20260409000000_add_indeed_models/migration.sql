-- CreateTable
CREATE TABLE "IndeedJobPosting" (
    "id" TEXT NOT NULL,
    "userId" TEXT,
    "title" TEXT NOT NULL,
    "location" TEXT NOT NULL DEFAULT '',
    "jobType" TEXT NOT NULL DEFAULT 'full-time',
    "indeedUrl" TEXT,
    "isActive" BOOLEAN NOT NULL DEFAULT true,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "IndeedJobPosting_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "IndeedApplicant" (
    "id" TEXT NOT NULL,
    "userId" TEXT,
    "jobPostingId" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "email" TEXT,
    "phone" TEXT,
    "resumeUrl" TEXT,
    "experienceYears" DOUBLE PRECISION,
    "experienceSummary" TEXT,
    "source" TEXT NOT NULL DEFAULT 'manual',
    "status" TEXT NOT NULL DEFAULT 'new',
    "appliedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "IndeedApplicant_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "IndeedNote" (
    "id" TEXT NOT NULL,
    "userId" TEXT,
    "applicantId" TEXT NOT NULL,
    "content" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "IndeedNote_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "IndeedSettings" (
    "id" TEXT NOT NULL,
    "userId" TEXT,
    "webhookSecret" TEXT,
    "indeedEmployerUrl" TEXT,
    "notifyEmail" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "IndeedSettings_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "IndeedEmailLog" (
    "id" TEXT NOT NULL,
    "userId" TEXT,
    "messageId" TEXT NOT NULL,
    "parsed" BOOLEAN NOT NULL DEFAULT false,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "IndeedEmailLog_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "IndeedJobPosting_userId_idx" ON "IndeedJobPosting"("userId");

-- CreateIndex
CREATE UNIQUE INDEX "IndeedApplicant_email_jobPostingId_key" ON "IndeedApplicant"("email", "jobPostingId");

-- CreateIndex
CREATE INDEX "IndeedApplicant_userId_idx" ON "IndeedApplicant"("userId");

-- CreateIndex
CREATE INDEX "IndeedApplicant_jobPostingId_idx" ON "IndeedApplicant"("jobPostingId");

-- CreateIndex
CREATE INDEX "IndeedApplicant_status_idx" ON "IndeedApplicant"("status");

-- CreateIndex
CREATE INDEX "IndeedNote_applicantId_idx" ON "IndeedNote"("applicantId");

-- CreateIndex
CREATE INDEX "IndeedNote_userId_idx" ON "IndeedNote"("userId");

-- CreateIndex
CREATE UNIQUE INDEX "IndeedSettings_userId_key" ON "IndeedSettings"("userId");

-- CreateIndex
CREATE UNIQUE INDEX "IndeedEmailLog_messageId_key" ON "IndeedEmailLog"("messageId");

-- CreateIndex
CREATE INDEX "IndeedEmailLog_userId_idx" ON "IndeedEmailLog"("userId");
