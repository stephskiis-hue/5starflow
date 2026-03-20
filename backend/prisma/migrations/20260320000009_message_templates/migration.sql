-- CreateTable
CREATE TABLE "MessageTemplate" (
    "id"        TEXT NOT NULL,
    "userId"    TEXT NOT NULL,
    "name"      TEXT NOT NULL,
    "type"      TEXT NOT NULL,
    "content"   TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "MessageTemplate_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "MessageTemplate_userId_type_idx" ON "MessageTemplate"("userId", "type");
