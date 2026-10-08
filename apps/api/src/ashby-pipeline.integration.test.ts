import { randomUUID } from 'node:crypto';
import type { Queue } from 'bullmq';
import { resolve } from 'node:path';
import dotenv from 'dotenv';
import { describe, expect, it } from 'vitest';
import type { Job as QueueJob } from 'bullmq';
import {
  PrismaClient,
  Prisma,
  executionInputHash,
  executionInputFromApplication,
  executionApplicationInclude,
  ensureSubmissionVerification,
} from '@careerlift/database';
import {
  BrowserApplicationExecutor,
  AshbySubmissionVerifier,
  BrowserSessionManager,
  DestinationPolicy,
} from '@careerlift/browser';
import type { BrowserSession } from '../../../packages/browser/src/session.js';
import { createApp } from './app.js';
import { createToken } from './auth.js';
import { createExecutionProcessor } from '../../worker/src/execution-processor.js';
import { createVerificationProcessor } from '../../worker/src/verification-processor.js';
import { ashbyFixture } from '../../../packages/browser/src/test-support/ashby-fixture.js';
dotenv.config({ path: resolve(process.cwd(), '.env'), quiet: true });

describe('persisted Ashby pipeline', () => {
  it.each([false, true])(
    'claims a worker lease, reconciles its response and never resubmits (assisted=%s)',
    async (assisted) => {
      const f = await ashbyFixture({ native: assisted }),
        db = new PrismaClient(),
        key = `ashby-test-${randomUUID()}`;
      const input = f.input,
        at = new Date(input.preparationUpdatedAt);
      if (assisted) {
        f.setCaptcha(true);
        input.inspection.ashbySubmission!.requiresCaptcha = true;
      }
      let executor: BrowserApplicationExecutor | undefined;
      let session: BrowserSession | undefined;
      const ids = {
        user: `${key}-user`,
        job: `${key}-job`,
        app: `${key}-app`,
        plan: `${key}-plan`,
        inspection: `${key}-inspection`,
        preparation: `${key}-preparation`,
        execution: `${key}-execution`,
      };
      const json = (v: unknown) => v as Prisma.InputJsonValue;
      const plan = { ...input.plan, jobId: ids.job };
      const schema = {
        ...input.inspection,
        inspectionId: ids.inspection,
        applicationPlanId: ids.plan,
      };
      const prepared = {
        ...input.preparedApplication,
        applicationId: ids.app,
        inspectionId: ids.inspection,
        jobId: ids.job,
      };
      try {
        await db.user.create({
          data: { id: ids.user, email: `${key}@example.com` },
        });
        await db.job.create({
          data: {
            id: ids.job,
            externalId: key,
            source: key,
            company: 'Fixture',
            title: 'Engineer',
            requirements: [],
          },
        });
        await db.userDocument.create({
          data: {
            ...input.documents[0]!,
            id: `${key}-doc`,
            userId: ids.user,
            metadata: json(input.documents[0]!.metadata),
          },
        });
        prepared.documents = prepared.documents.map((d) => ({
          ...d,
          documentId: `${key}-doc`,
        }));
        await db.application.create({
          data: {
            id: ids.app,
            userId: ids.user,
            jobId: ids.job,
            state: 'RESOLVED',
          },
        });
        await db.applicationPlan.create({
          data: {
            id: ids.plan,
            applicationId: ids.app,
            applicationType: plan.applicationType,
            provider: 'ASHBY',
            destination: json(plan.destination),
            requirements: [],
            actions: [],
            executor: 'BROWSER',
            confidence: 1,
            requiresHumanReview: false,
            reasoning: [],
            resolvedBy: 'deterministic',
          },
        });
        await db.applicationInspection.create({
          data: {
            id: ids.inspection,
            applicationId: ids.app,
            applicationPlanId: ids.plan,
            state: 'COMPLETED',
            result: json(schema),
            startedAt: at,
            completedAt: at,
          },
        });
        await db.applicationPreparation.create({
          data: {
            id: ids.preparation,
            applicationId: ids.app,
            inspectionId: ids.inspection,
            state: 'COMPLETED',
            result: json(prepared),
            startedAt: at,
            completedAt: at,
          },
        });
        const application = await db.application.findUniqueOrThrow({
          where: { id: ids.app },
          include: executionApplicationInclude,
        });
        const runInput = executionInputFromApplication(application, {
          id: ids.execution,
          mode: 'TEST_FIXTURE',
          preparationVersion: application.preparation!.version,
        });
        await db.applicationExecution.create({
          data: {
            id: ids.execution,
            applicationId: ids.app,
            applicationPlanId: ids.plan,
            inspectionId: ids.inspection,
            preparationId: ids.preparation,
            preparationVersion: application.preparation!.version,
            inputHash: executionInputHash(runInput),
            mode: 'TEST_FIXTURE',
          },
        });
        executor = new BrowserApplicationExecutor({
          documents: f.storage,
          fixtureOrigin: f.origin,
          ashbyBrowserAssisted: assisted,
          assistedSessions: (policy) => {
            const manager = new BrowserSessionManager(true, policy, true);
            return {
              create: async (...args) => {
                session = await manager.create(...args);
                return session;
              },
            };
          },
        });
        const process = createExecutionProcessor(db, executor),
          task = {
            name: 'EXECUTE_APPLICATION',
            data: {
              applicationId: ids.app,
              executionId: ids.execution,
              generation: 1,
              requestId: key,
            },
          } as QueueJob;
        await process(task);
        await process(task);
        if (assisted) {
          const paused = await db.applicationExecution.findUniqueOrThrow({
            where: { id: ids.execution },
          });
          expect(paused.state, JSON.stringify(paused.result)).toBe(
            'PAUSED_HUMAN_REQUIRED',
          );
          expect(
            f.calls.some(
              (c) => c.operation === 'ApiSubmitSingleApplicationFormAction',
            ),
          ).toBe(false);
          await session!.page.locator('#fixture-human-step').click();
          await session!.page
            .getByRole('button', { name: 'Submit Application', exact: true })
            .click();
          await session!.page.locator('#native-submit-result').waitFor();
          const secret = 'ashby-assisted-fixture';
          const queued: unknown[] = [];
          const app = createApp({
            db,
            authSecret: secret,
            ashbyBrowserAssisted: true,
            policy: new DestinationPolicy(f.origin),
            executionFixtureOrigin: f.origin,
            queue: {
              add: async (...args: unknown[]) => {
                queued.push(args);
              },
            } as unknown as Queue,
          });
          try {
            const resumed = await app.inject({
              method: 'POST',
              url: `/api/v1/applications/${ids.app}/execution/resume`,
              headers: {
                authorization: `Bearer ${createToken(ids.user, secret, 3600)}`,
              },
              payload: { executionId: ids.execution },
            });
            expect(resumed.statusCode, resumed.body).toBe(202);
            expect(queued).toHaveLength(1);
          } finally {
            await app.close();
          }
          task.data.generation = 2;
          await process(task);
          await process(task);
        }
        expect(
          f.calls.filter(
            (c) => c.operation === 'ApiSubmitSingleApplicationFormAction',
          ),
        ).toHaveLength(1);
        const verification = await ensureSubmissionVerification(
          db,
          ids.execution,
        );
        expect(verification.state).toBe('PENDING');
        await createVerificationProcessor(db, [new AshbySubmissionVerifier()])({
          name: 'VERIFY_SUBMISSION',
          data: {
            executionId: ids.execution,
            applicationId: ids.app,
            userId: ids.user,
            generation: verification.generation,
          },
        } as QueueJob);
        expect(
          (
            await db.submissionVerification.findUniqueOrThrow({
              where: { executionId: ids.execution },
            })
          ).state,
        ).toBe('CONFIRMED');
        expect(
          (await db.application.findUniqueOrThrow({ where: { id: ids.app } }))
            .state,
        ).toBe('SUBMITTED');
        expect(
          (
            await db.applicationExecution.findUniqueOrThrow({
              where: { id: ids.execution },
            })
          ).runId,
        ).toBeNull();
      } finally {
        await executor?.close();
        const verifications = await db.submissionVerification.findMany({
          where: { executionId: ids.execution },
          select: { id: true },
        });
        const verificationIds = verifications.map((v) => v.id);
        await db.verificationAuditEvent.deleteMany({
          where: { verificationId: { in: verificationIds } },
        });
        await db.verificationEvidence.deleteMany({
          where: { verificationId: { in: verificationIds } },
        });
        await db.verificationAttempt.deleteMany({
          where: { verificationId: { in: verificationIds } },
        });
        await db.submissionVerification.deleteMany({
          where: { executionId: ids.execution },
        });
        await db.applicationExecution.deleteMany({
          where: { applicationId: ids.app },
        });
        await db.applicationEvent.deleteMany({
          where: { applicationId: ids.app },
        });
        await db.applicationPreparation.deleteMany({
          where: { applicationId: ids.app },
        });
        await db.applicationInspection.deleteMany({
          where: { applicationId: ids.app },
        });
        await db.applicationPlan.deleteMany({
          where: { applicationId: ids.app },
        });
        await db.application.deleteMany({ where: { id: ids.app } });
        await db.job.deleteMany({ where: { id: ids.job } });
        await db.userDocument.deleteMany({ where: { userId: ids.user } });
        await db.user.deleteMany({ where: { id: ids.user } });
        await db.$disconnect();
        await f.close();
      }
    },
    30000,
  );
});
