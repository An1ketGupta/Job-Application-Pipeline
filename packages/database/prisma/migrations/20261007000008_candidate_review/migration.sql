ALTER TYPE "ApplicationEventType" ADD VALUE 'PROFILE_UPDATED';
ALTER TYPE "ApplicationEventType" ADD VALUE 'DOCUMENT_UPLOADED';
ALTER TYPE "ApplicationEventType" ADD VALUE 'DOCUMENT_UPDATED';
ALTER TYPE "ApplicationEventType" ADD VALUE 'DOCUMENT_ARCHIVED';
ALTER TYPE "ApplicationEventType" ADD VALUE 'VERIFIED_ANSWER_UPDATED';
ALTER TYPE "ApplicationEventType" ADD VALUE 'HUMAN_REVIEW_RESOLVED';
ALTER TYPE "ApplicationEventType" ADD VALUE 'HUMAN_REVIEW_REJECTED';
ALTER TYPE "ApplicationEventType" ADD VALUE 'PREPARATION_SNAPSHOT';
ALTER TABLE "ApplicationProfile" ADD COLUMN "revision" INTEGER NOT NULL DEFAULT 1;
DROP INDEX "VerifiedAnswer_userId_category_key";
ALTER TABLE "VerifiedAnswer"
  ADD COLUMN "question" TEXT NOT NULL DEFAULT '',
  ADD COLUMN "questionKey" TEXT NOT NULL DEFAULT '',
  ADD COLUMN "updatedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  ADD COLUMN "active" BOOLEAN NOT NULL DEFAULT true,
  ADD COLUMN "revision" INTEGER NOT NULL DEFAULT 1;
CREATE UNIQUE INDEX "VerifiedAnswer_userId_category_questionKey_key" ON "VerifiedAnswer"("userId", "category", "questionKey");
ALTER TABLE "UserDocument"
  ADD COLUMN "updatedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  ADD COLUMN "archivedAt" TIMESTAMP(3),
  ADD COLUMN "isDefault" BOOLEAN NOT NULL DEFAULT false,
  ADD COLUMN "revision" INTEGER NOT NULL DEFAULT 1;
CREATE UNIQUE INDEX "UserDocument_active_default_key" ON "UserDocument"("userId", "type") WHERE "isDefault" = true AND "archivedAt" IS NULL;
ALTER TABLE "ApplicationPreparation"
  ADD COLUMN "reviewDecisions" JSONB NOT NULL DEFAULT '[]',
  ADD COLUMN "inputSnapshot" JSONB;
ALTER TABLE "ApplicationEvent"
  ALTER COLUMN "applicationId" DROP NOT NULL,
  ALTER COLUMN "status" DROP NOT NULL,
  ALTER COLUMN "jobId" DROP NOT NULL,
  ADD COLUMN "actorId" TEXT,
  ADD COLUMN "data" JSONB NOT NULL DEFAULT '{}';
CREATE INDEX "ApplicationEvent_actorId_createdAt_idx" ON "ApplicationEvent"("actorId", "createdAt");
