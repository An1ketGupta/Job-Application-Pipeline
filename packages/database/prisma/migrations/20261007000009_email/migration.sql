CREATE TYPE "EmailMessageState" AS ENUM ('DRAFT', 'QUEUED', 'SENDING', 'SENT', 'FAILED', 'UNKNOWN', 'CANCELLED');
CREATE TABLE "EmailAccount" (
  "id" TEXT NOT NULL, "userId" TEXT NOT NULL, "address" TEXT NOT NULL,
  "encryptedRefreshToken" TEXT, "connected" BOOLEAN NOT NULL DEFAULT true,
  "version" INTEGER NOT NULL DEFAULT 1, "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" TIMESTAMP(3) NOT NULL, CONSTRAINT "EmailAccount_pkey" PRIMARY KEY ("id")
);
CREATE UNIQUE INDEX "EmailAccount_userId_key" ON "EmailAccount"("userId");
ALTER TABLE "EmailAccount" ADD CONSTRAINT "EmailAccount_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;
CREATE TABLE "EmailPreferences" (
  "userId" TEXT NOT NULL, "data" JSONB NOT NULL, "updatedAt" TIMESTAMP(3) NOT NULL,
  CONSTRAINT "EmailPreferences_pkey" PRIMARY KEY ("userId")
);
ALTER TABLE "EmailPreferences" ADD CONSTRAINT "EmailPreferences_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;
CREATE TABLE "EmailOAuthState" (
  "hash" TEXT NOT NULL, "userId" TEXT NOT NULL, "verifier" TEXT NOT NULL, "expiresAt" TIMESTAMP(3) NOT NULL,
  CONSTRAINT "EmailOAuthState_pkey" PRIMARY KEY ("hash")
);
CREATE INDEX "EmailOAuthState_expiresAt_idx" ON "EmailOAuthState"("expiresAt");
ALTER TABLE "EmailOAuthState" ADD CONSTRAINT "EmailOAuthState_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;
CREATE TABLE "EmailMessage" (
  "id" TEXT NOT NULL, "userId" TEXT NOT NULL, "applicationId" TEXT, "planId" TEXT, "purpose" TEXT NOT NULL,
  "state" "EmailMessageState" NOT NULL DEFAULT 'DRAFT', "revision" INTEGER NOT NULL DEFAULT 1,
  "accountVersion" INTEGER NOT NULL, "from" TEXT NOT NULL, "to" TEXT NOT NULL, "subject" TEXT NOT NULL, "senderName" TEXT NOT NULL DEFAULT '',
  "body" TEXT NOT NULL, "attachments" JSONB NOT NULL DEFAULT '[]', "runId" TEXT, "providerMessageId" TEXT,
  "errorCode" TEXT, "queuedAt" TIMESTAMP(3), "startedAt" TIMESTAMP(3), "sentAt" TIMESTAMP(3),
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP, "updatedAt" TIMESTAMP(3) NOT NULL,
  CONSTRAINT "EmailMessage_pkey" PRIMARY KEY ("id")
);
CREATE UNIQUE INDEX "EmailMessage_applicationId_key" ON "EmailMessage"("applicationId");
CREATE INDEX "EmailMessage_state_updatedAt_idx" ON "EmailMessage"("state", "updatedAt");
CREATE INDEX "EmailMessage_userId_createdAt_idx" ON "EmailMessage"("userId", "createdAt");
ALTER TABLE "EmailMessage" ADD CONSTRAINT "EmailMessage_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "EmailMessage" ADD CONSTRAINT "EmailMessage_applicationId_fkey" FOREIGN KEY ("applicationId") REFERENCES "Application"("id") ON DELETE CASCADE ON UPDATE CASCADE;
