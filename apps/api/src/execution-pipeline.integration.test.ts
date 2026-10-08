import { createHmac, randomUUID } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { QueueEvents, Worker } from 'bullmq';
import {
  PrismaClient,
  executionApplicationInclude,
  executionInputFromApplication,
  executionInputHash,
} from '@careerlift/database';
import {
  ExecutionResultSchema,
  PreparationEngine,
  type ApplicationExecutor,
  type ExecutionResult,
} from '@careerlift/domain';
import { BrowserApplicationExecutor } from '@careerlift/browser';
import { createApp } from './app.js';
import {
  createExecutionProcessor,
  failStaleExecutions,
} from '../../worker/src/execution-processor.js';
import {
  createApplicationQueue,
  createRedisConnection,
  QUEUE_NAME,
} from '../../worker/src/queue.js';
import {
  executionFixture,
  fixtureHtml,
} from '../../../tests/support/execution-fixture.js';

const databaseUrl = process.env.INTEGRATION_DATABASE_URL,
  redisUrl = process.env.INTEGRATION_REDIS_URL;
if (databaseUrl && !/\/careerlift_test(?:\?|$)/.test(databaseUrl))
  throw new Error('Integration tests require careerlift_test');

const suite = databaseUrl && redisUrl ? describe : describe.skip;
suite(
  'Phase 4 API → PostgreSQL → BullMQ → worker → real Playwright → local HTTPS fixture',
  () => {
    it.each([
      'success',
      'failure',
      'unknown',
      'resume',
      'answer-tamper',
      'job-tamper',
      'file-tamper',
      'stale-dispatch',
    ] as const)(
      'persists %s and fences duplicate, concurrent, stale, and retried workers',
      async (outcome) => {
        const fixture = await executionFixture();
        if (outcome === 'failure' || outcome === 'unknown')
          fixture.setOutcome(outcome);
        if (outcome === 'resume') fixture.setHtml(await fixtureHtml('captcha'));
        if (['answer-tamper', 'job-tamper', 'file-tamper'].includes(outcome)) {
          const tampering =
            outcome === 'answer-tamper'
              ? "payload.set('first', 'Mallory');"
              : outcome === 'job-tamper'
                ? "payload.set('jobId', 'OTHER_JOB_B');"
                : `payload.set('resume', new File([new Uint8Array(${fixture.pdf.length}).fill(65)], 'resume.pdf', {type:'application/pdf'}));`;
          fixture.setHtml(
            (await fixtureHtml('simple'))
              .replace(
                'const response = await fetch',
                `const payload = new FormData(event.target); ${tampering} const response = await fetch`,
              )
              .replace('body: new FormData(event.target),', 'body: payload,'),
          );
        }
        const suffix = randomUUID(),
          db = new PrismaClient({ datasourceUrl: databaseUrl! });
        const producer = createRedisConnection(redisUrl!),
          consumer = createRedisConnection(redisUrl!),
          eventConnection = createRedisConnection(redisUrl!);
        const queue = createApplicationQueue(producer),
          events = new QueueEvents(QUEUE_NAME, { connection: eventConnection });
        const executor = new BrowserApplicationExecutor({
          documents: fixture.storage,
          fixtureOrigin: fixture.origin,
          sessions: fixture.sessions,
          receiptTimeoutMs: 800,
        });
        let signalStarted!: () => void, release!: () => void;
        const started = new Promise<void>((resolve) => {
          signalStarted = resolve;
        });
        const gate = new Promise<void>((resolve) => {
          release = resolve;
        });
        let calls = 0;
        // Pause after the durable claim to deliberately deliver overlapping worker jobs.
        // All browser execution uses the real executor; no browser implementation is mocked.
        const gated: ApplicationExecutor = {
          canHandle: (plan) => executor.canHandle(plan),
          execute: async (input, observer) => {
            calls++;
            if (calls === 1) {
              signalStarted();
              await gate;
            }
            if (outcome === 'stale-dispatch') {
              return executor.execute(input, {
                persist: observer!.persist,
                authorizeDispatch: async () => {
                  // A real concurrent writer changes the row after durable request authorization.
                  await db.applicationPreparation.update({
                    where: { applicationId: input.applicationId },
                    data: { version: { increment: 1 } },
                  });
                  await observer!.authorizeDispatch!();
                },
              });
            }
            return executor.execute(input, observer);
          },
        };
        const processor = createExecutionProcessor(db, gated);
        const worker = new Worker(QUEUE_NAME, processor, {
          connection: consumer,
          autorun: false,
          concurrency: 2,
        });
        const secret = 'phase4-integration';
        const app = createApp({
          db,
          queue,
          authSecret: secret,
          executionFixtureOrigin: fixture.origin,
        });
        let userId: string | undefined,
          jobId: string | undefined,
          applicationId: string | undefined;
        try {
          await events.waitUntilReady();
          const user = await db.user.create({
            data: {
              email: `execution-${suffix}@example.com`,
              documents: { create: fixture.document },
            },
          });
          userId = user.id;
          const job = await db.job.create({
            data: {
              id: `execution-${suffix}`,
              externalId: suffix,
              source: 'INTEGRATION_TEST',
              company: 'Example',
              title: 'Engineer',
              requirements: [],
            },
          });
          jobId = job.id;
          const application = await db.application.create({
            data: { userId: user.id, jobId: job.id, state: 'RESOLVED' },
          });
          applicationId = application.id;
          const plan = fixture.input.plan;
          const savedPlan = await db.applicationPlan.create({
            data: {
              applicationId: application.id,
              applicationType: plan.applicationType,
              destination: plan.destination,
              requirements: plan.requirements,
              actions: plan.actions,
              executor: plan.executor,
              confidence: plan.confidence,
              requiresHumanReview: plan.requiresHumanReview,
              reasoning: plan.reasoning,
              resolvedBy: plan.resolvedBy,
            },
          });
          const inspection = await db.applicationInspection.create({
            data: {
              applicationId: application.id,
              applicationPlanId: savedPlan.id,
              state: 'COMPLETED',
            },
          });
          const schema = {
            ...fixture.input.inspection,
            inspectionId: inspection.id,
            applicationPlanId: savedPlan.id,
          };
          await db.applicationInspection.update({
            where: { id: inspection.id },
            data: { result: schema },
          });
          const prepared = await new PreparationEngine().prepare({
            applicationId: application.id,
            inspectionId: inspection.id,
            schema,
            job: {
              id: job.id,
              externalId: suffix,
              source: 'INTEGRATION_TEST',
              company: 'Example',
              title: 'Engineer',
              requirements: [],
            },
            email: user.email,
            profile: {
              firstName: 'Ada',
              education: [],
              experience: [],
              projects: [],
              skills: [],
              achievements: [],
              certifications: [],
            },
            documents: [fixture.document],
            verifiedAnswers: [],
          });
          expect(prepared.overallStatus).toBe('COMPLETED');
          await db.applicationPreparation.create({
            data: {
              applicationId: application.id,
              inspectionId: inspection.id,
              state: 'COMPLETED',
              result: prepared,
            },
          });
          const authorizationFor = (sub: string) => {
            const head = Buffer.from(
              JSON.stringify({ alg: 'HS256', typ: 'JWT' }),
            ).toString('base64url');
            const body = Buffer.from(
              JSON.stringify({
                sub,
                exp: Math.floor(Date.now() / 1000) + 3600,
              }),
            ).toString('base64url');
            return `Bearer ${head}.${body}.${createHmac('sha256', secret).update(`${head}.${body}`).digest('base64url')}`;
          };
          const headers = { authorization: authorizationFor(user.id) },
            url = `/api/v1/applications/${application.id}/execute`;
          expect(
            (
              await app.inject({
                method: 'POST',
                url,
                payload: { mode: 'TEST_FIXTURE' },
              })
            ).statusCode,
          ).toBe(401);
          expect(
            (
              await app.inject({
                method: 'POST',
                url,
                headers: { authorization: authorizationFor('stranger') },
                payload: { mode: 'TEST_FIXTURE' },
              })
            ).statusCode,
          ).toBe(404);
          const [first, duplicateRequest] = await Promise.all([
            app.inject({
              method: 'POST',
              url,
              headers,
              payload: { mode: 'TEST_FIXTURE' },
            }),
            app.inject({
              method: 'POST',
              url,
              headers,
              payload: { mode: 'TEST_FIXTURE' },
            }),
          ]);
          expect(first.statusCode).toBe(202);
          expect(duplicateRequest.statusCode).toBe(202);
          expect(first.json().executionId).toBe(
            duplicateRequest.json().executionId,
          );
          const queued = (await queue.getJobs(['waiting'])).find(
            (t) =>
              t.name === 'EXECUTE_APPLICATION' &&
              t.data.applicationId === application.id,
          )!;
          expect(queued).toBeDefined();
          expect(queued.opts.attempts).toBe(1);
          void worker.run();
          await started;
          const overlap = await queue.add('EXECUTE_APPLICATION', queued.data, {
            jobId: `overlap-${suffix}`,
            attempts: 3,
            removeOnComplete: true,
          });
          await overlap.waitUntilFinished(events, 30000);
          expect(calls).toBe(1);
          expect(fixture.submissions).toHaveLength(0);
          release();
          if (outcome === 'stale-dispatch')
            await expect(
              queued.waitUntilFinished(events, 30000),
            ).rejects.toThrow();
          else await queued.waitUntilFinished(events, 30000);
          let response = await app.inject({
            method: 'GET',
            url: `/api/v1/applications/${application.id}/execution`,
            headers,
          });
          expect(response.json().result).not.toHaveProperty('checkpoint');
          expect(response.json().result).not.toHaveProperty('mutations');
          let result = ExecutionResultSchema.parse(
            (
              await db.applicationExecution.findUniqueOrThrow({
                where: { id: response.json().executionId },
              })
            ).result,
          );
          if (outcome === 'resume') {
            expect(result.status).toBe('PAUSED_HUMAN_REQUIRED');
            expect(result.checkpoint?.resumable).toBe(true);
            fixture.setHtml(await fixtureHtml('simple'));
            await fixture
              .getSession()!
              .page.reload({ waitUntil: 'domcontentloaded' });
            const resumed = await app.inject({
              method: 'POST',
              url: `/api/v1/applications/${application.id}/execution/resume`,
              headers,
              payload: { executionId: result.executionId },
            });
            expect(resumed.statusCode, resumed.body).toBe(202);
            const saved = await db.applicationExecution.findUniqueOrThrow({
              where: { id: result.executionId },
            });
            const resumeTask = await queue.getJob(
              `execute-${saved.id}-${saved.generation}`,
            );
            if (resumeTask) await resumeTask.waitUntilFinished(events, 30000);
            // Poll a bounded result because an extremely fast completed task may have been removed.
            for (let i = 0; i < 30; i++) {
              response = await app.inject({
                method: 'GET',
                url: `/api/v1/applications/${application.id}/execution`,
                headers,
              });
              if (response.json().status === 'SUBMITTED') break;
              await new Promise((resolve) => setTimeout(resolve, 50));
            }
            result = ExecutionResultSchema.parse(
              (
                await db.applicationExecution.findUniqueOrThrow({
                  where: { id: response.json().executionId },
                })
              ).result,
            );
            expect(
              result.steps.filter((s) => s.type === 'NAVIGATE'),
            ).toHaveLength(1);
          }
          expect(result.status, JSON.stringify(result)).toBe(
            outcome === 'unknown' ||
              outcome.endsWith('tamper') ||
              outcome === 'stale-dispatch'
              ? 'SUBMISSION_UNKNOWN'
              : outcome === 'failure'
                ? 'FAILED'
                : 'SUBMITTED',
          );
          const expectedSubmissions =
            outcome.endsWith('tamper') || outcome === 'stale-dispatch' ? 0 : 1;
          expect(fixture.submissions).toHaveLength(expectedSubmissions);
          if (expectedSubmissions) {
            expect(fixture.submissions[0]!.toString()).toContain('Ada');
            expect(fixture.submissions[0]!.toString()).toContain(user.email);
            expect(fixture.submissions[0]!.includes(fixture.pdf)).toBe(true);
          }
          expect(result.mutations).toHaveLength(1);
          expect(result.mutations![0]!.action).toBe('FINAL_SUBMIT');
          expect(result.mutations![0]!.outcome).toBe(
            outcome.endsWith('tamper')
              ? 'REJECTED'
              : outcome === 'unknown' || outcome === 'stale-dispatch'
                ? 'UNKNOWN'
                : 'FORWARDED',
          );
          const saved = await db.applicationExecution.findUniqueOrThrow({
            where: { id: result.executionId },
          });
          expect(saved.state).toBe(result.status);
          expect(ExecutionResultSchema.parse(saved.result)).toEqual(result);
          expect(
            result.steps.some(
              (s) =>
                s.type === 'PRE_SUBMIT_VALIDATION' && s.status === 'COMPLETED',
            ),
          ).toBe(true);
          expect(
            result.steps.some(
              (s) => s.type === 'UPLOAD_DOCUMENT' && s.status === 'COMPLETED',
            ),
          ).toBe(true);
          const afterCalls = calls;
          const retried = await queue.add(
            'EXECUTE_APPLICATION',
            { ...queued.data, generation: saved.generation },
            { jobId: `retry-${suffix}`, attempts: 3, removeOnComplete: true },
          );
          await retried.waitUntilFinished(events, 30000);
          expect(calls).toBe(afterCalls);
          expect(fixture.submissions).toHaveLength(expectedSubmissions);
          expect(
            (
              await db.applicationExecution.updateMany({
                where: {
                  id: saved.id,
                  state: 'RUNNING',
                  runId: 'stale-worker',
                },
                data: { state: 'FAILED' },
              })
            ).count,
          ).toBe(0);
          expect(
            (
              await app.inject({
                method: 'GET',
                url: `/api/v1/applications/${application.id}/execution`,
                headers: { authorization: authorizationFor('stranger') },
              })
            ).statusCode,
          ).toBe(404);
          expect(
            (
              await app.inject({
                method: 'POST',
                url: `/api/v1/applications/${application.id}/execution/resume`,
                headers,
                payload: { executionId: saved.id },
              })
            ).statusCode,
          ).toBe(409);
          // A crash after SUBMITTING remains unsafe even if it never produced a final result.
          if (outcome === 'unknown') {
            const current = await db.application.findUniqueOrThrow({
              where: { id: application.id },
              include: executionApplicationInclude,
            });
            const crashId = randomUUID();
            const crashInput = executionInputFromApplication(current, {
              id: crashId,
              mode: 'DRY_RUN',
              preparationVersion: 1,
            });
            const crashResult: ExecutionResult = {
              ...result,
              executionId: crashId,
              mode: 'DRY_RUN',
              status: 'SUBMITTING',
              completedAt: undefined,
            } as ExecutionResult;
            delete crashResult.completedAt;
            await db.applicationExecution.create({
              data: {
                id: crashId,
                applicationId: application.id,
                applicationPlanId: savedPlan.id,
                inspectionId: inspection.id,
                preparationId: current.preparation!.id,
                preparationVersion: 1,
                inputHash: executionInputHash(crashInput),
                mode: 'DRY_RUN',
                state: 'SUBMITTING',
                runId: 'dead-worker',
                result: crashResult,
                updatedAt: new Date(0),
              },
            });
            expect(
              await failStaleExecutions(db, new Date(Date.now() - 1000)),
            ).toBe(1);
            expect(
              (
                await db.applicationExecution.findUniqueOrThrow({
                  where: { id: crashId },
                })
              ).state,
            ).toBe('SUBMISSION_UNKNOWN');
            await processor({
              name: 'EXECUTE_APPLICATION',
              data: {
                applicationId: application.id,
                executionId: crashId,
                generation: 1,
                requestId: suffix,
              },
            } as never);
            expect(fixture.submissions).toHaveLength(1);
          }
        } finally {
          release?.();
          await app.close();
          await worker.close();
          await executor.close();
          await events.close();
          await producer.quit();
          await consumer.quit();
          await eventConnection.quit();
          if (applicationId) {
            await db.applicationExecution.deleteMany({
              where: { applicationId },
            });
            await db.applicationEvent.deleteMany({ where: { applicationId } });
            await db.applicationPreparation.deleteMany({
              where: { applicationId },
            });
            await db.applicationInspection.deleteMany({
              where: { applicationId },
            });
            await db.applicationPlan.deleteMany({ where: { applicationId } });
            await db.application.delete({ where: { id: applicationId } });
          }
          if (jobId) await db.job.delete({ where: { id: jobId } });
          if (userId) {
            await db.userDocument.deleteMany({ where: { userId } });
            await db.user.delete({ where: { id: userId } });
          }
          await db.$disconnect();
          await fixture.close();
        }
      },
      60000,
    );
  },
);
