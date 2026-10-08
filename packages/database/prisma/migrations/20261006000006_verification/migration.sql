-- CreateEnum
CREATE TYPE "VerificationState" AS ENUM ('NOT_REQUIRED', 'PENDING', 'VERIFYING', 'CONFIRMED', 'REJECTED', 'UNKNOWN', 'HUMAN_REQUIRED', 'FAILED');

-- CreateEnum
CREATE TYPE "VerificationEvidenceType" AS ENUM ('HTTP_SUCCESS', 'HTTP_RESPONSE', 'HTTP_REDIRECT', 'CONFIRMATION_PAGE', 'CONFIRMATION_IDENTIFIER', 'RECEIPT', 'APPLICATION_ID', 'STATUS_PAGE', 'USER_CONFIRMED', 'USER_CONFIRMED_REJECTED', 'EXTERNAL_LOOKUP');

-- CreateEnum
CREATE TYPE "EvidenceStrength" AS ENUM ('STRONG', 'MEDIUM', 'WEAK', 'NONE');

-- CreateTable
CREATE TABLE "SubmissionVerification" (
    "id" TEXT NOT NULL,
    "executionId" TEXT NOT NULL,
    "mutationId" TEXT NOT NULL,
    "context" JSONB NOT NULL,
    "state" "VerificationState" NOT NULL DEFAULT 'PENDING',
    "establishedState" "VerificationState",
    "reason" TEXT,
    "generation" INTEGER NOT NULL DEFAULT 1,
    "runId" TEXT,
    "leaseUntil" TIMESTAMP(3),
    "infrastructureFailures" INTEGER NOT NULL DEFAULT 0,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "SubmissionVerification_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "VerificationAttempt" (
    "id" TEXT NOT NULL,
    "verificationId" TEXT NOT NULL,
    "generation" INTEGER NOT NULL,
    "strategy" TEXT NOT NULL,
    "target" TEXT,
    "startedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "completedAt" TIMESTAMP(3),
    "result" "VerificationState",
    "errorCode" TEXT,

    CONSTRAINT "VerificationAttempt_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "VerificationEvidence" (
    "id" TEXT NOT NULL,
    "verificationId" TEXT NOT NULL,
    "attemptId" TEXT,
    "fingerprint" TEXT NOT NULL,
    "type" "VerificationEvidenceType" NOT NULL,
    "strength" "EvidenceStrength" NOT NULL,
    "data" JSONB NOT NULL,
    "capturedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "VerificationEvidence_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "VerificationAuditEvent" (
    "id" TEXT NOT NULL,
    "verificationId" TEXT NOT NULL,
    "key" TEXT NOT NULL,
    "type" TEXT NOT NULL,
    "actorId" TEXT,
    "data" JSONB NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "VerificationAuditEvent_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "SubmissionVerification_executionId_key" ON "SubmissionVerification"("executionId");

-- CreateIndex
CREATE INDEX "SubmissionVerification_state_leaseUntil_idx" ON "SubmissionVerification"("state", "leaseUntil");

-- CreateIndex
CREATE INDEX "VerificationAttempt_verificationId_generation_idx" ON "VerificationAttempt"("verificationId", "generation");

-- CreateIndex
CREATE UNIQUE INDEX "VerificationAttempt_id_verificationId_key" ON "VerificationAttempt"("id", "verificationId");

-- CreateIndex
CREATE INDEX "VerificationEvidence_verificationId_capturedAt_idx" ON "VerificationEvidence"("verificationId", "capturedAt");

-- CreateIndex
CREATE UNIQUE INDEX "VerificationEvidence_verificationId_fingerprint_key" ON "VerificationEvidence"("verificationId", "fingerprint");

-- CreateIndex
CREATE INDEX "VerificationAuditEvent_verificationId_createdAt_idx" ON "VerificationAuditEvent"("verificationId", "createdAt");

-- CreateIndex
CREATE UNIQUE INDEX "VerificationAuditEvent_verificationId_key_key" ON "VerificationAuditEvent"("verificationId", "key");

-- AddForeignKey
ALTER TABLE "SubmissionVerification" ADD CONSTRAINT "SubmissionVerification_executionId_fkey" FOREIGN KEY ("executionId") REFERENCES "ApplicationExecution"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "VerificationAttempt" ADD CONSTRAINT "VerificationAttempt_verificationId_fkey" FOREIGN KEY ("verificationId") REFERENCES "SubmissionVerification"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "VerificationEvidence" ADD CONSTRAINT "VerificationEvidence_verificationId_fkey" FOREIGN KEY ("verificationId") REFERENCES "SubmissionVerification"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "VerificationEvidence" ADD CONSTRAINT "VerificationEvidence_attemptId_verificationId_fkey" FOREIGN KEY ("attemptId", "verificationId") REFERENCES "VerificationAttempt"("id", "verificationId") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "VerificationAuditEvent" ADD CONSTRAINT "VerificationAuditEvent_verificationId_fkey" FOREIGN KEY ("verificationId") REFERENCES "SubmissionVerification"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- Fences are durable and internally consistent, including after process loss.
ALTER TABLE "SubmissionVerification" ADD CONSTRAINT "verification_generation_positive" CHECK ("generation" > 0);
ALTER TABLE "SubmissionVerification" ADD CONSTRAINT "verification_failures_bounded" CHECK ("infrastructureFailures" BETWEEN 0 AND 2);
ALTER TABLE "SubmissionVerification" ADD CONSTRAINT "verification_lease_state" CHECK (
  ("state" = 'VERIFYING' AND "runId" IS NOT NULL AND "leaseUntil" IS NOT NULL) OR
  ("state" <> 'VERIFYING' AND "runId" IS NULL AND "leaseUntil" IS NULL)
);
ALTER TABLE "SubmissionVerification" ADD CONSTRAINT "verification_established_outcome" CHECK (
  "establishedState" IS NULL OR "establishedState" IN ('CONFIRMED', 'REJECTED')
);
ALTER TABLE "VerificationAttempt" ADD CONSTRAINT "verification_attempt_generation_positive" CHECK ("generation" > 0);
ALTER TABLE "VerificationAuditEvent" ADD CONSTRAINT "verification_audit_type" CHECK ("type" IN (
  'SUBMISSION_ATTEMPTED', 'SUBMISSION_RESPONSE_RECEIVED', 'SUBMISSION_UNKNOWN',
  'VERIFICATION_STARTED', 'VERIFICATION_COMPLETED', 'VERIFICATION_CONFIRMED',
  'VERIFICATION_REJECTED', 'VERIFICATION_UNKNOWN', 'HUMAN_REVIEW_REQUIRED',
  'HUMAN_CONFIRMED', 'HUMAN_REJECTED', 'RECOVERY_STARTED', 'RECOVERY_COMPLETED'
));
