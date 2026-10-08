CREATE TABLE "GoogleFormSession" (
  "userId" TEXT NOT NULL,
  "state" TEXT NOT NULL DEFAULT 'DISCONNECTED',
  "account" TEXT NOT NULL,
  "encryptedState" TEXT,
  "generation" INTEGER NOT NULL DEFAULT 1,
  "errorCode" TEXT,
  "updatedAt" TIMESTAMP(3) NOT NULL,
  CONSTRAINT "GoogleFormSession_pkey" PRIMARY KEY ("userId"),
  CONSTRAINT "GoogleFormSession_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE
);
CREATE TABLE "GoogleFormRun" (
  "id" TEXT NOT NULL,
  "applicationId" TEXT NOT NULL,
  "userId" TEXT NOT NULL,
  "state" TEXT NOT NULL DEFAULT 'PENDING',
  "version" INTEGER NOT NULL DEFAULT 1,
  "runId" TEXT,
  "page" INTEGER NOT NULL DEFAULT 0,
  "snapshot" JSONB,
  "submitStartedAt" TIMESTAMP(3),
  "submittedAt" TIMESTAMP(3),
  "confirmation" JSONB,
  "errorCode" TEXT,
  "test" BOOLEAN NOT NULL DEFAULT false,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" TIMESTAMP(3) NOT NULL,
  CONSTRAINT "GoogleFormRun_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "GoogleFormRun_applicationId_fkey" FOREIGN KEY ("applicationId") REFERENCES "Application"("id") ON DELETE CASCADE ON UPDATE CASCADE,
  CONSTRAINT "GoogleFormRun_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE
);
CREATE UNIQUE INDEX "GoogleFormRun_applicationId_key" ON "GoogleFormRun"("applicationId");
CREATE INDEX "GoogleFormRun_userId_state_idx" ON "GoogleFormRun"("userId", "state");
CREATE INDEX "GoogleFormRun_state_updatedAt_idx" ON "GoogleFormRun"("state", "updatedAt");
