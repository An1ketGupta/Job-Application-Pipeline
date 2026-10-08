CREATE TYPE "InspectionState" AS ENUM ('PENDING', 'RUNNING', 'COMPLETED', 'HUMAN_REQUIRED', 'FAILED');
ALTER TYPE "ApplicationEventType" ADD VALUE 'APPLICATION_INSPECTION_STARTED';
ALTER TYPE "ApplicationEventType" ADD VALUE 'APPLICATION_INSPECTED';
ALTER TYPE "ApplicationEventType" ADD VALUE 'APPLICATION_INSPECTION_FAILED';
CREATE TABLE "ApplicationInspection" (
  "id" TEXT NOT NULL,
  "applicationId" TEXT NOT NULL,
  "applicationPlanId" TEXT NOT NULL,
  "state" "InspectionState" NOT NULL DEFAULT 'PENDING',
  "result" JSONB,
  "finalUrl" TEXT,
  "errorCode" TEXT,
  "startedAt" TIMESTAMP(3),
  "completedAt" TIMESTAMP(3),
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" TIMESTAMP(3) NOT NULL,
  CONSTRAINT "ApplicationInspection_pkey" PRIMARY KEY ("id")
);
CREATE UNIQUE INDEX "ApplicationInspection_applicationId_key" ON "ApplicationInspection"("applicationId");
CREATE UNIQUE INDEX "ApplicationInspection_applicationPlanId_key" ON "ApplicationInspection"("applicationPlanId");
ALTER TABLE "ApplicationInspection" ADD CONSTRAINT "ApplicationInspection_applicationId_fkey" FOREIGN KEY ("applicationId") REFERENCES "Application"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "ApplicationInspection" ADD CONSTRAINT "ApplicationInspection_applicationPlanId_fkey" FOREIGN KEY ("applicationPlanId") REFERENCES "ApplicationPlan"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
