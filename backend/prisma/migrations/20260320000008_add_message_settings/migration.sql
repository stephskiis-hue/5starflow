-- CreateTable
CREATE TABLE "MessageSettings" (
    "id"              TEXT NOT NULL,
    "userId"          TEXT NOT NULL,
    "businessName"    TEXT NOT NULL DEFAULT 'My Business',
    "tagline"         TEXT NOT NULL DEFAULT '',
    "logoUrl"         TEXT NOT NULL DEFAULT '',
    "reviewLink"      TEXT NOT NULL DEFAULT '',
    "buttonColor"     TEXT NOT NULL DEFAULT '#1b5e20',
    "emailSubject"    TEXT NOT NULL DEFAULT 'Could you do us a small favor?',
    "emailBody"       TEXT NOT NULL DEFAULT 'We hope you''re loving the results! We''d love to hear what you think.',
    "emailCustomHtml" TEXT NOT NULL DEFAULT '',
    "smsBody"         TEXT NOT NULL DEFAULT '',
    "updatedAt"       TIMESTAMP(3) NOT NULL,
    CONSTRAINT "MessageSettings_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "MessageSettings_userId_key" ON "MessageSettings"("userId");
