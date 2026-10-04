-- DropIndex
DROP INDEX "AuditIgnore_pattern_key";

-- DropIndex
DROP INDEX "AuditPage_path_key";

-- AlterTable
ALTER TABLE "OperatorProposal" ADD COLUMN     "createdBy" TEXT,
ADD COLUMN     "dedupKey" TEXT,
ADD COLUMN     "routineSlug" TEXT,
ADD COLUMN     "runId" TEXT;

-- CreateTable
CREATE TABLE "Routine" (
    "id" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "slug" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "kind" TEXT NOT NULL,
    "agent" TEXT NOT NULL DEFAULT 'system',
    "category" TEXT NOT NULL DEFAULT 'operations',
    "purpose" TEXT NOT NULL DEFAULT '',
    "trigger" TEXT NOT NULL DEFAULT 'schedule',
    "schedule" TEXT,
    "timezone" TEXT NOT NULL DEFAULT 'America/Winnipeg',
    "enabled" BOOLEAN NOT NULL DEFAULT true,
    "expectedEveryMinutes" INTEGER,
    "approvalRequired" BOOLEAN NOT NULL DEFAULT false,
    "learningEnabled" BOOLEAN NOT NULL DEFAULT true,
    "researchEnabled" BOOLEAN NOT NULL DEFAULT false,
    "autonomy" TEXT NOT NULL DEFAULT 'approve',
    "externalId" TEXT,
    "config" JSONB,
    "lastRunAt" TIMESTAMP(3),
    "lastStatus" TEXT,
    "lastSummary" TEXT,
    "lastError" TEXT,
    "nextRunAt" TIMESTAMP(3),
    "consecutiveFailures" INTEGER NOT NULL DEFAULT 0,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "Routine_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "RoutineRun" (
    "id" TEXT NOT NULL,
    "routineId" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'running',
    "trigger" TEXT NOT NULL DEFAULT 'schedule',
    "source" TEXT NOT NULL DEFAULT 'backend',
    "startedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "finishedAt" TIMESTAMP(3),
    "durationMs" INTEGER,
    "summary" TEXT,
    "itemsFound" INTEGER,
    "requiresAttention" INTEGER,
    "result" JSONB,
    "errorClass" TEXT,
    "error" TEXT,

    CONSTRAINT "RoutineRun_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Task" (
    "id" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "dedupKey" TEXT NOT NULL,
    "title" TEXT NOT NULL,
    "reason" TEXT NOT NULL DEFAULT '',
    "source" TEXT NOT NULL DEFAULT 'system',
    "customerName" TEXT,
    "customerKey" TEXT,
    "context" JSONB,
    "whatHappened" TEXT NOT NULL DEFAULT '',
    "whatNeeds" TEXT NOT NULL DEFAULT '',
    "recommended" TEXT NOT NULL DEFAULT '',
    "proposedResponse" TEXT NOT NULL DEFAULT '',
    "urgency" TEXT NOT NULL DEFAULT 'normal',
    "status" TEXT NOT NULL DEFAULT 'NEW',
    "agent" TEXT,
    "routineSlug" TEXT,
    "timesFlagged" INTEGER NOT NULL DEFAULT 1,
    "firstFlaggedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "lastFlaggedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "dueAt" TIMESTAMP(3),
    "completedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "Task_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Memory" (
    "id" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "scope" TEXT NOT NULL,
    "key" TEXT NOT NULL,
    "value" TEXT NOT NULL,
    "confidence" DOUBLE PRECISION NOT NULL DEFAULT 0.8,
    "source" TEXT,
    "agent" TEXT,
    "hits" INTEGER NOT NULL DEFAULT 0,
    "lastUsedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "Memory_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "AgentActivity" (
    "id" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "agent" TEXT NOT NULL,
    "routineSlug" TEXT,
    "runId" TEXT,
    "action" TEXT NOT NULL,
    "summary" TEXT NOT NULL,
    "source" TEXT,
    "result" TEXT,
    "tool" TEXT,
    "approval" TEXT,
    "learning" TEXT,
    "customerRef" TEXT,
    "error" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "AgentActivity_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "Routine_userId_agent_idx" ON "Routine"("userId", "agent");

-- CreateIndex
CREATE UNIQUE INDEX "Routine_userId_slug_key" ON "Routine"("userId", "slug");

-- CreateIndex
CREATE INDEX "RoutineRun_routineId_startedAt_idx" ON "RoutineRun"("routineId", "startedAt");

-- CreateIndex
CREATE INDEX "RoutineRun_userId_startedAt_idx" ON "RoutineRun"("userId", "startedAt");

-- CreateIndex
CREATE INDEX "RoutineRun_userId_status_idx" ON "RoutineRun"("userId", "status");

-- CreateIndex
CREATE INDEX "Task_userId_status_idx" ON "Task"("userId", "status");

-- CreateIndex
CREATE INDEX "Task_userId_urgency_status_idx" ON "Task"("userId", "urgency", "status");

-- CreateIndex
CREATE UNIQUE INDEX "Task_userId_dedupKey_key" ON "Task"("userId", "dedupKey");

-- CreateIndex
CREATE INDEX "Memory_userId_scope_idx" ON "Memory"("userId", "scope");

-- CreateIndex
CREATE UNIQUE INDEX "Memory_userId_scope_key_key" ON "Memory"("userId", "scope", "key");

-- CreateIndex
CREATE INDEX "AgentActivity_userId_createdAt_idx" ON "AgentActivity"("userId", "createdAt");

-- CreateIndex
CREATE INDEX "AgentActivity_userId_agent_createdAt_idx" ON "AgentActivity"("userId", "agent", "createdAt");

-- CreateIndex
CREATE UNIQUE INDEX "OperatorProposal_userId_dedupKey_key" ON "OperatorProposal"("userId", "dedupKey");

-- AddForeignKey
ALTER TABLE "RoutineRun" ADD CONSTRAINT "RoutineRun_routineId_fkey" FOREIGN KEY ("routineId") REFERENCES "Routine"("id") ON DELETE CASCADE ON UPDATE CASCADE;

