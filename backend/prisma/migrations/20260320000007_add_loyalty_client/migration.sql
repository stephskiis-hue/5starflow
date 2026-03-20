-- LoyaltyClient: tracks client points, referral slugs, and multiplier flags.
CREATE TABLE "LoyaltyClient" (
    "id"                   TEXT NOT NULL,
    "userId"               TEXT NOT NULL,
    "jobberClientId"       TEXT NOT NULL,
    "displayName"          TEXT NOT NULL,
    "totalPoints"          INTEGER NOT NULL DEFAULT 0,
    "referralSlug"         TEXT NOT NULL,
    "hasPendingMultiplier" BOOLEAN NOT NULL DEFAULT false,
    "optedOut"             BOOLEAN NOT NULL DEFAULT false,
    "createdAt"            TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt"            TIMESTAMP(3) NOT NULL,
    CONSTRAINT "LoyaltyClient_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "LoyaltyClient_referralSlug_key"          ON "LoyaltyClient"("referralSlug");
CREATE UNIQUE INDEX "LoyaltyClient_userId_jobberClientId_key" ON "LoyaltyClient"("userId", "jobberClientId");
CREATE INDEX        "LoyaltyClient_userId_idx"                ON "LoyaltyClient"("userId");
