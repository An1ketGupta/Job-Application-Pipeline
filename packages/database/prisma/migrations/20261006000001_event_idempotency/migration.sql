ALTER TABLE "ApplicationEvent" ADD COLUMN "attempt" INTEGER NOT NULL DEFAULT 0;
CREATE UNIQUE INDEX "ApplicationEvent_applicationId_requestId_type_attempt_key"
ON "ApplicationEvent"("applicationId", "requestId", "type", "attempt");
