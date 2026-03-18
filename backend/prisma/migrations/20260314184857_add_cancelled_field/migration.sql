-- RedefineTables
PRAGMA defer_foreign_keys=ON;
PRAGMA foreign_keys=OFF;
CREATE TABLE "new_PendingReview" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "invoiceId" TEXT NOT NULL,
    "clientId" TEXT NOT NULL,
    "clientName" TEXT NOT NULL,
    "firstName" TEXT NOT NULL,
    "phone" TEXT,
    "smsAllowed" BOOLEAN NOT NULL DEFAULT false,
    "email" TEXT,
    "scheduledAt" DATETIME NOT NULL,
    "processed" BOOLEAN NOT NULL DEFAULT false,
    "cancelled" BOOLEAN NOT NULL DEFAULT false,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP
);
INSERT INTO "new_PendingReview" ("clientId", "clientName", "createdAt", "email", "firstName", "id", "invoiceId", "phone", "processed", "scheduledAt", "smsAllowed") SELECT "clientId", "clientName", "createdAt", "email", "firstName", "id", "invoiceId", "phone", "processed", "scheduledAt", "smsAllowed" FROM "PendingReview";
DROP TABLE "PendingReview";
ALTER TABLE "new_PendingReview" RENAME TO "PendingReview";
CREATE UNIQUE INDEX "PendingReview_invoiceId_key" ON "PendingReview"("invoiceId");
PRAGMA foreign_keys=ON;
PRAGMA defer_foreign_keys=OFF;
