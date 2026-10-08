CREATE TYPE "ExecutionState" AS ENUM ('PENDING', 'PREPARING', 'RUNNING', 'PAUSED_HUMAN_REQUIRED', 'SUBMITTING', 'SUBMITTED', 'SUBMISSION_UNKNOWN', 'DRY_RUN_COMPLETED', 'FAILED', 'BLOCKED');
CREATE TABLE "ApplicationExecution" (
  "id" TEXT NOT NULL,
  "applicationId" TEXT NOT NULL,
  "applicationPlanId" TEXT NOT NULL,
  "inspectionId" TEXT NOT NULL,
  "preparationId" TEXT NOT NULL,
  "preparationVersion" INTEGER NOT NULL,
  "inputHash" TEXT NOT NULL,
  "mode" TEXT NOT NULL,
  "state" "ExecutionState" NOT NULL DEFAULT 'PENDING',
  "result" JSONB,
  "runId" TEXT,
  "generation" INTEGER NOT NULL DEFAULT 1,
  "errorCode" TEXT,
  "startedAt" TIMESTAMP(3),
  "completedAt" TIMESTAMP(3),
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" TIMESTAMP(3) NOT NULL,
  CONSTRAINT "ApplicationExecution_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "ApplicationExecution_applicationId_fkey" FOREIGN KEY ("applicationId") REFERENCES "Application"("id") ON DELETE RESTRICT ON UPDATE CASCADE
);
CREATE UNIQUE INDEX "ApplicationExecution_applicationId_mode_key" ON "ApplicationExecution"("applicationId", "mode");
CREATE INDEX "ApplicationExecution_state_updatedAt_idx" ON "ApplicationExecution"("state", "updatedAt");
