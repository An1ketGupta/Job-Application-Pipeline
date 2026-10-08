-- CreateSchema
CREATE SCHEMA IF NOT EXISTS "public";

-- CreateEnum
CREATE TYPE "ApplicationState" AS ENUM ('DISCOVERED', 'ANALYZING', 'RESOLVED', 'READY', 'EXECUTING', 'VERIFYING', 'SUBMITTED', 'FAILED', 'BLOCKED', 'HUMAN_REQUIRED');

-- CreateEnum
CREATE TYPE "ApplicationEventType" AS ENUM ('JOB_DISCOVERED', 'APPLICATION_ANALYSIS_STARTED', 'APPLICATION_RESOLVED', 'APPLICATION_RESOLUTION_FAILED', 'HUMAN_REVIEW_REQUIRED', 'APPLICATION_EXECUTION_STARTED', 'APPLICATION_SUBMITTED', 'APPLICATION_FAILED');

-- CreateTable
CREATE TABLE "User" (
    "id" TEXT NOT NULL,
    "email" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "User_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Job" (
    "id" TEXT NOT NULL,
    "externalId" TEXT NOT NULL,
    "source" TEXT NOT NULL,
    "company" TEXT NOT NULL,
    "title" TEXT NOT NULL,
    "location" TEXT,
    "employmentType" TEXT,
    "description" TEXT,
    "requirements" JSONB NOT NULL,
    "applicationInfo" JSONB,
    "sourceUrl" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "Job_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Application" (
    "id" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "jobId" TEXT NOT NULL,
    "state" "ApplicationState" NOT NULL DEFAULT 'DISCOVERED',
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "Application_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "ApplicationPlan" (
    "id" TEXT NOT NULL,
    "applicationId" TEXT NOT NULL,
    "applicationType" TEXT NOT NULL,
    "provider" TEXT,
    "destination" JSONB NOT NULL,
    "requirements" JSONB NOT NULL,
    "actions" JSONB NOT NULL,
    "executor" TEXT NOT NULL,
    "confidence" DOUBLE PRECISION NOT NULL,
    "requiresHumanReview" BOOLEAN NOT NULL,
    "reasoning" JSONB NOT NULL,
    "resolvedBy" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "ApplicationPlan_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "ApplicationEvent" (
    "id" TEXT NOT NULL,
    "applicationId" TEXT NOT NULL,
    "type" "ApplicationEventType" NOT NULL,
    "status" "ApplicationState" NOT NULL,
    "requestId" TEXT,
    "jobId" TEXT NOT NULL,
    "message" TEXT,
    "errorCode" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "ApplicationEvent_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "User_email_key" ON "User"("email");

-- CreateIndex
CREATE UNIQUE INDEX "Job_source_externalId_key" ON "Job"("source", "externalId");

-- CreateIndex
CREATE INDEX "Application_userId_state_idx" ON "Application"("userId", "state");

-- CreateIndex
CREATE UNIQUE INDEX "ApplicationPlan_applicationId_key" ON "ApplicationPlan"("applicationId");

-- CreateIndex
CREATE INDEX "ApplicationEvent_applicationId_createdAt_idx" ON "ApplicationEvent"("applicationId", "createdAt");

-- AddForeignKey
ALTER TABLE "Application" ADD CONSTRAINT "Application_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Application" ADD CONSTRAINT "Application_jobId_fkey" FOREIGN KEY ("jobId") REFERENCES "Job"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ApplicationPlan" ADD CONSTRAINT "ApplicationPlan_applicationId_fkey" FOREIGN KEY ("applicationId") REFERENCES "Application"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ApplicationEvent" ADD CONSTRAINT "ApplicationEvent_applicationId_fkey" FOREIGN KEY ("applicationId") REFERENCES "Application"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
