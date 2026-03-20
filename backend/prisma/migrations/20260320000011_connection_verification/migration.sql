CREATE TABLE "ConnectionVerification" (
    "id"         TEXT NOT NULL,
    "userId"     TEXT NOT NULL,
    "service"    TEXT NOT NULL,
    "verifiedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "ConnectionVerification_pkey" PRIMARY KEY ("id")
);
CREATE UNIQUE INDEX "ConnectionVerification_userId_service_key" ON "ConnectionVerification"("userId", "service");
