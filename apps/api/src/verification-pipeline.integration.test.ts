import { createHmac, randomUUID } from 'node:crypto';
import { spawn } from 'node:child_process';
import { describe, expect, it } from 'vitest';
import { Queue, Worker } from 'bullmq';
import {
  PrismaClient,
  ensureSubmissionVerification,
  verificationInclude,
  executionInputHash,
  executionApplicationInclude,
  executionInputFromApplication,
} from '@careerlift/database';
import {
  VerificationContextSchema,
  evidenceIdentity,
  type VerificationResult,
  type ExecutionResult,
  type SubmissionVerifier,
} from '@careerlift/domain';
import {
  BrowserApplicationExecutor,
  LocalFixtureSubmissionVerifier,
} from '@careerlift/browser';
import {
  createExecutionProcessor,
  failStaleExecutions,
} from '../../worker/src/execution-processor.js';
import {
  createVerificationProcessor,
  reconcileSubmissions,
  recoverExpiredVerifications,
} from '../../worker/src/verification-processor.js';
import { createRedisConnection } from '../../worker/src/queue.js';
import { createApp } from './app.js';
import {
  executionFixture,
  fixtureHtml,
  remapApplication,
} from '../../../tests/support/execution-fixture.js';
import {
  fixtureStatusPage,
  fixtureVerificationContext,
} from '../../../tests/support/verification-fixture.js';

const databaseUrl = process.env.INTEGRATION_DATABASE_URL,
  redisUrl = process.env.INTEGRATION_REDIS_URL;
if (databaseUrl && !/\/careerlift_test(?:\?|$)/.test(databaseUrl))
  throw new Error('Verification tests require careerlift_test');
const suite = databaseUrl && redisUrl ? describe : describe.skip;
const secret = 'phase5-integration';
function token(sub: string) {
  const head = Buffer.from(
    JSON.stringify({ alg: 'HS256', typ: 'JWT' }),
  ).toString('base64url');
  const body = Buffer.from(
    JSON.stringify({ sub, exp: Math.floor(Date.now() / 1000) + 3600 }),
  ).toString('base64url');
  return `Bearer ${head}.${body}.${createHmac('sha256', secret).update(`${head}.${body}`).digest('base64url')}`;
}
async function eventually<T>(
  read: () => Promise<T>,
  done: (value: T) => boolean,
): Promise<T> {
  const deadline = Date.now() + 20000;
  while (Date.now() < deadline) {
    const value = await read();
    if (done(value)) return value;
    await new Promise((resolve) => setTimeout(resolve, 30));
  }
  throw new Error('Timed out waiting for durable state');
}
async function killAtCrashBoundary(args: string[]) {
  const child = spawn(
    process.execPath,
    ['tests/support/crash-worker.mjs', ...args],
    { windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] },
  );
  let stderr = '';
  child.stderr.on('data', (data) => {
    stderr = (stderr + String(data)).slice(-4000);
  });
  const exited = new Promise<void>((resolve) =>
    child.once('exit', () => resolve()),
  );
  try {
    await new Promise<void>((resolve, reject) => {
      const timer = setTimeout(
        () => reject(new Error(`Crash boundary timed out: ${stderr}`)),
        15000,
      );
      child.stdout.on('data', (data) => {
        if (String(data).includes('CRASH_BOUNDARY_READY')) {
          clearTimeout(timer);
          resolve();
        }
      });
      child.once('error', (error) => {
        clearTimeout(timer);
        reject(error);
      });
      child.once('exit', () => {
        clearTimeout(timer);
        reject(new Error(`Child exited before crash boundary: ${stderr}`));
      });
    });
  } finally {
    child.kill('SIGKILL');
    await exited;
  }
}

suite(
  'Phase 5 API → PostgreSQL → BullMQ → verification → evidence and recovery',
  () => {
    it.each([
      'accepted-lost',
      'absent',
      'generic-200',
      'wrong-job',
      'wrong-user',
      'wrong-execution',
      'wrong-identifier',
      'challenge',
      'rejected',
      'process-crash',
      'worker-crash',
      'duplicate',
      'timeout',
      'infrastructure',
      'human-confirm',
      'human-reject',
      'conflict',
      'monotonic',
      'cross-context',
      'queue-gap',
      'stale-worker',
      'missing-ledger',
    ] as const)(
      'safely reconciles %s with exactly one submission',
      async (scenario) => {
        const fixture = await executionFixture();
        fixture.setOutcome('unknown');
        if (scenario === 'generic-200') {
          fixture.setOutcome('success');
          fixture.setHtml(
            (await fixtureHtml('simple')).replace(
              ').hidden = false;',
              ').hidden = true;',
            ),
          );
        }
        const suffix = randomUUID(),
          db = new PrismaClient({ datasourceUrl: databaseUrl! });
        const producer = createRedisConnection(redisUrl!),
          consumer = createRedisConnection(redisUrl!),
          secondConsumer = createRedisConnection(redisUrl!);
        const queue = new Queue(`phase5-${suffix}`, { connection: producer });
        const executor = new BrowserApplicationExecutor({
          documents: fixture.storage,
          fixtureOrigin: fixture.origin,
          receiptTimeoutMs: 300,
        });
        const baseVerifier = new LocalFixtureSubmissionVerifier(
          fixture.origin,
          fixture.sessions,
        );
        let verifyCalls = 0;
        let releaseStale: ((result: VerificationResult) => void) | undefined;
        let staleTask: Promise<unknown> | undefined;
        const verifier: SubmissionVerifier = {
          supports: (context) => baseVerifier.supports(context),
          verify: async (context, signal) => {
            verifyCalls++;
            if (scenario === 'stale-worker' && verifyCalls === 1)
              return new Promise((resolve) => {
                releaseStale = resolve;
              });
            if (scenario === 'timeout') return new Promise(() => {});
            if (scenario === 'infrastructure')
              return {
                evidence: [],
                reason: 'BROWSER_LAUNCH_FAILED',
                infrastructureFailure: true,
              };
            if (scenario === 'duplicate')
              await new Promise((resolve) => setTimeout(resolve, 150));
            return baseVerifier.verify(context, signal);
          },
        };
        const execute = createExecutionProcessor(db, executor),
          verify = createVerificationProcessor(
            db,
            [verifier],
            scenario === 'timeout' ? 50 : 8000,
          );
        const worker = new Worker(
          queue.name,
          (job) =>
            job.name === 'EXECUTE_APPLICATION' ? execute(job) : verify(job),
          { connection: consumer, concurrency: 2 },
        );
        const secondWorker = new Worker(queue.name, verify, {
          connection: secondConsumer,
          autorun: false,
        });
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
          const user = await db.user.create({
            data: {
              email: `${suffix}@example.com`,
              documents: {
                create: { ...fixture.document, id: `doc-${suffix}` },
              },
            },
          });
          userId = user.id;
          const job = await db.job.create({
            data: {
              id: `job-${suffix}`,
              externalId: suffix,
              source: 'INTEGRATION_TEST',
              company: 'Example',
              title: 'Engineer',
              requirements: [],
            },
          });
          jobId = job.id;
          const application = await db.application.create({
            data: { userId, jobId, state: 'RESOLVED' },
          });
          applicationId = application.id;
          const plan = fixture.input.plan;
          const savedPlan = await db.applicationPlan.create({
            data: {
              applicationId,
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
              applicationId,
              applicationPlanId: savedPlan.id,
              state: 'COMPLETED',
            },
          });
          const preparation = await db.applicationPreparation.create({
            data: {
              applicationId,
              inspectionId: inspection.id,
              state: 'COMPLETED',
            },
          });
          const input = remapApplication(fixture.input, {
            applicationId,
            jobId,
            planId: savedPlan.id,
            inspectionId: inspection.id,
            preparationId: preparation.id,
            executionId: `exec-${suffix}`,
            preparationUpdatedAt: preparation.updatedAt.toISOString(),
          });
          input.ownerId = userId;
          input.eligibilityState = 'RESOLVED';
          input.documents[0]!.id = `doc-${suffix}`;
          input.preparedApplication.documents[0]!.documentId = `doc-${suffix}`;
          await db.applicationInspection.update({
            where: { id: inspection.id },
            data: { result: input.inspection },
          });
          const savedPreparation = await db.applicationPreparation.update({
            where: { id: preparation.id },
            data: { result: input.preparedApplication },
          });
          input.preparationUpdatedAt = savedPreparation.updatedAt.toISOString();
          const headers = { authorization: token(userId) };
          let executionId: string;
          if (scenario === 'process-crash') {
            executionId = input.executionId;
            await db.applicationExecution.create({
              data: {
                id: executionId,
                applicationId,
                applicationPlanId: savedPlan.id,
                inspectionId: inspection.id,
                preparationId: preparation.id,
                preparationVersion: 1,
                inputHash: executionInputHash(input),
                mode: 'TEST_FIXTURE',
              },
            });
            const source = await db.application.findUniqueOrThrow({
              where: { id: applicationId },
              include: executionApplicationInclude,
            });
            const seed = await db.applicationExecution.findUniqueOrThrow({
              where: { id: executionId },
            });
            await db.applicationExecution.update({
              where: { id: executionId },
              data: {
                inputHash: executionInputHash(
                  executionInputFromApplication(source, seed),
                ),
              },
            });
            await killAtCrashBoundary([
              'execution',
              executionId,
              applicationId,
              userId,
              fixture.origin,
              fixture.directory,
            ]);
            expect(
              (
                await db.applicationExecution.findUniqueOrThrow({
                  where: { id: executionId },
                })
              ).state,
            ).toBe('SUBMITTING');
            expect(fixture.submissions).toHaveLength(1);
            await db.applicationExecution.update({
              where: { id: executionId },
              data: { updatedAt: new Date(0) },
            });
            expect(
              await failStaleExecutions(db, new Date(Date.now() - 1000)),
            ).toBe(1);
            await execute({
              name: 'EXECUTE_APPLICATION',
              data: {
                executionId,
                applicationId,
                generation: 1,
                requestId: suffix,
              },
            } as never);
            expect(fixture.submissions).toHaveLength(1);
          } else {
            const started = await app.inject({
              method: 'POST',
              url: `/api/v1/applications/${applicationId}/execute`,
              headers,
              payload: { mode: 'TEST_FIXTURE' },
            });
            expect(started.statusCode, started.body).toBe(202);
            executionId = started.json().executionId as string;
          }
          const finishedExecution = await eventually(
            () =>
              db.applicationExecution.findUniqueOrThrow({
                where: { id: executionId },
              }),
            (row) =>
              row.state === 'SUBMISSION_UNKNOWN' &&
              row.runId === null &&
              row.completedAt !== null,
          );
          expect(fixture.submissions).toHaveLength(1);
          if (scenario === 'missing-ledger')
            await db.applicationExecution.update({
              where: { id: executionId },
              data: {
                result: {
                  ...(finishedExecution.result as unknown as ExecutionResult),
                  mutations: [],
                },
              },
            });
          let verification = await ensureSubmissionVerification(
            db,
            executionId,
          );
          const context =
            scenario === 'missing-ledger'
              ? fixtureVerificationContext(
                  { ...input, executionId },
                  finishedExecution.result as unknown as ExecutionResult,
                )
              : VerificationContextSchema.parse(verification.context);
          if (scenario === 'generic-200')
            expect(context.responseStatus).toBe(200);
          let statusPage = fixtureStatusPage(
            context,
            scenario === 'absent'
              ? 'UNKNOWN'
              : scenario === 'rejected'
                ? 'REJECTED'
                : 'CONFIRMED',
          );
          if (
            [
              'generic-200',
              'human-confirm',
              'human-reject',
              'queue-gap',
            ].includes(scenario)
          )
            statusPage = '<p>Thank you for applying</p>';
          if (scenario === 'wrong-job')
            statusPage = fixtureStatusPage({ ...context, jobId: 'job-b' });
          if (scenario === 'wrong-user')
            statusPage = fixtureStatusPage({ ...context, userId: 'user-b' });
          if (scenario === 'wrong-execution')
            statusPage = fixtureStatusPage({
              ...context,
              executionId: 'exec-b',
            });
          if (scenario === 'wrong-identifier')
            statusPage = statusPage.replace(
              /data-receipt="[^"]*"/,
              'data-receipt=""',
            );
          if (scenario === 'challenge')
            statusPage += '<div id="captcha">Verify you are human</div>';
          fixture.setStatusHtml(statusPage);
          const base = `/api/v1/executions/${executionId}/verification`;
          for (const [method, path, payload] of [
            ['GET', '', undefined],
            ['GET', '/evidence', undefined],
            ['POST', '/check', {}],
            ['POST', '/confirm', { confirmed: true }],
            ['POST', '/reject', { rejected: true }],
          ] as const) {
            expect(
              (
                await app.inject({
                  method,
                  url: base + path,
                  ...(payload ? { payload } : {}),
                })
              ).statusCode,
            ).toBe(401);
            expect(
              (
                await app.inject({
                  method,
                  url: base + path,
                  headers: { authorization: token('stranger') },
                  ...(payload ? { payload } : {}),
                })
              ).statusCode,
            ).toBe(404);
          }
          expect(
            (
              await app.inject({
                method: 'POST',
                url: `${base}/confirm`,
                headers,
                payload: { confirmed: true },
              })
            ).statusCode,
          ).toBe(409);
          if (scenario === 'cross-context') {
            await db.submissionVerification.update({
              where: { id: verification.id },
              data: { context: { ...context, userId: 'stranger' } },
            });
          }
          if (scenario === 'worker-crash') {
            await killAtCrashBoundary([
              'verification',
              executionId,
              applicationId,
              userId,
              fixture.origin,
              fixture.directory,
              '1',
            ]);
            expect(
              (
                await db.submissionVerification.findUniqueOrThrow({
                  where: { id: verification.id },
                })
              ).state,
            ).toBe('VERIFYING');
            expect(
              await recoverExpiredVerifications(
                db,
                new Date(Date.now() + 30000),
              ),
            ).toBe(1);
            await expect(
              verify({
                name: 'VERIFY_SUBMISSION',
                data: { executionId, applicationId, userId, generation: 1 },
              } as never),
            ).rejects.toThrow('stale generation');
            verification = await db.submissionVerification.findUniqueOrThrow({
              where: { id: verification.id },
            });
          }
          if (scenario === 'stale-worker') {
            staleTask = verify({
              name: 'VERIFY_SUBMISSION',
              data: {
                executionId,
                applicationId,
                userId,
                generation: verification.generation,
              },
            } as never);
            await eventually(
              () =>
                db.submissionVerification.findUniqueOrThrow({
                  where: { id: verification.id },
                }),
              (row) => row.state === 'VERIFYING' && !!releaseStale,
            );
            expect(
              await recoverExpiredVerifications(
                db,
                new Date(Date.now() + 30000),
              ),
            ).toBe(1);
            verification = await db.submissionVerification.findUniqueOrThrow({
              where: { id: verification.id },
            });
          }
          if (scenario === 'queue-gap') {
            const unavailableApp = createApp({
              db,
              authSecret: secret,
              queue: {
                add: async () => {
                  throw new Error('Redis down');
                },
              } as unknown as Queue,
            });
            try {
              expect(
                (
                  await unavailableApp.inject({
                    method: 'POST',
                    url: `${base}/check`,
                    headers,
                    payload: {},
                  })
                ).statusCode,
              ).toBe(503);
            } finally {
              await unavailableApp.close();
            }
            expect(
              (
                await db.submissionVerification.findUniqueOrThrow({
                  where: { id: verification.id },
                })
              ).state,
            ).toBe('PENDING');
            await reconcileSubmissions(db, queue);
          } else {
            if (scenario === 'duplicate') {
              void secondWorker.run();
              await Promise.all([
                queue.add(
                  'VERIFY_SUBMISSION',
                  {
                    executionId,
                    applicationId,
                    userId,
                    generation: verification.generation,
                  },
                  { jobId: 'duplicate-a' },
                ),
                queue.add(
                  'VERIFY_SUBMISSION',
                  {
                    executionId,
                    applicationId,
                    userId,
                    generation: verification.generation,
                  },
                  { jobId: 'duplicate-b' },
                ),
              ]);
            } else
              expect(
                (
                  await app.inject({
                    method: 'POST',
                    url: `${base}/check`,
                    headers,
                    payload: {},
                  })
                ).statusCode,
              ).toBe(202);
          }
          if (scenario === 'infrastructure') {
            await eventually(
              () =>
                db.submissionVerification.findUniqueOrThrow({
                  where: { id: verification.id },
                }),
              (row) => row.generation === 2 && row.state === 'PENDING',
            );
            await reconcileSubmissions(db, queue);
          }
          let result = await eventually(
            () =>
              db.submissionVerification.findUniqueOrThrow({
                where: { id: verification.id },
                include: verificationInclude,
              }),
            (row) =>
              ['CONFIRMED', 'REJECTED', 'HUMAN_REQUIRED'].includes(row.state),
          );
          const expected = [
            'accepted-lost',
            'process-crash',
            'worker-crash',
            'duplicate',
            'conflict',
            'monotonic',
            'stale-worker',
          ].includes(scenario)
            ? 'CONFIRMED'
            : scenario === 'rejected'
              ? 'REJECTED'
              : 'HUMAN_REQUIRED';
          expect(result.state, JSON.stringify(result)).toBe(expected);
          if (scenario === 'stale-worker') {
            releaseStale!({
              reason: 'LATE_REJECTED_RESULT',
              evidence: [
                {
                  ...evidenceIdentity(context),
                  type: 'STATUS_PAGE',
                  source: 'LOCAL_FIXTURE',
                  strength: 'STRONG',
                  capturedAt: new Date().toISOString(),
                  pageUrl: `${fixture.origin}/careerlift/status/${context.mutationId}`,
                  receiptId: randomUUID(),
                  evidenceOrigin: 'SERVER_STATUS',
                  serverIssuedAt: new Date().toISOString(),
                  inspectionComplete: true,
                  securityGeneration: 1,
                  httpStatus: 200,
                  confirmationFingerprint: 'f'.repeat(64),
                  outcome: 'REJECTED',
                },
              ],
            });
            await staleTask;
            result = await db.submissionVerification.findUniqueOrThrow({
              where: { id: result.id },
              include: verificationInclude,
            });
            expect(result.state).toBe('CONFIRMED');
            expect(result.attempts).toHaveLength(2);
            expect(
              result.evidence.some(
                (e) => (e.data as { outcome: string }).outcome === 'REJECTED',
              ),
            ).toBe(false);
          }
          if (scenario === 'duplicate') expect(verifyCalls).toBe(1);
          if (scenario === 'infrastructure') expect(verifyCalls).toBe(2);
          if (scenario === 'cross-context') expect(verifyCalls).toBe(0);
          const originalEvidenceCount = result.evidence.length;
          await verify({
            name: 'VERIFY_SUBMISSION',
            data: {
              executionId,
              applicationId,
              userId,
              generation: result.generation,
            },
          } as never);
          expect(
            await db.verificationEvidence.count({
              where: { verificationId: result.id },
            }),
          ).toBe(originalEvidenceCount);
          if (scenario === 'duplicate') {
            expect(result.attempts).toHaveLength(1);
            expect(
              (
                await app.inject({
                  method: 'POST',
                  url: `${base}/check`,
                  headers,
                  payload: {},
                })
              ).statusCode,
            ).toBe(202);
            result = await eventually(
              () =>
                db.submissionVerification.findUniqueOrThrow({
                  where: { id: result.id },
                  include: verificationInclude,
                }),
              (row) => row.generation === 2 && row.state === 'CONFIRMED',
            );
            expect(result.attempts).toHaveLength(2);
            expect(result.evidence).toHaveLength(originalEvidenceCount);
          }
          if (scenario === 'human-confirm' || scenario === 'human-reject') {
            const path = scenario === 'human-confirm' ? '/confirm' : '/reject';
            expect(
              (
                await app.inject({
                  method: 'POST',
                  url: base + path,
                  headers,
                  payload: {},
                })
              ).statusCode,
            ).toBe(400);
            const payload =
              scenario === 'human-confirm'
                ? { confirmed: true }
                : { rejected: true };
            const responses = await Promise.all([
              app.inject({
                method: 'POST',
                url: base + path,
                headers,
                payload,
              }),
              app.inject({
                method: 'POST',
                url: base + path,
                headers,
                payload,
              }),
            ]);
            expect(responses.map((r) => r.statusCode).sort()).toEqual([
              200, 409,
            ]);
            result = await db.submissionVerification.findUniqueOrThrow({
              where: { id: result.id },
              include: verificationInclude,
            });
            expect(result.state).toBe(
              scenario === 'human-confirm' ? 'CONFIRMED' : 'REJECTED',
            );
            expect(
              result.evidence.filter((e) =>
                e.type.startsWith('USER_CONFIRMED'),
              ),
            ).toHaveLength(1);
            expect(
              result.events.some(
                (event) =>
                  event.actorId === userId && event.type.startsWith('HUMAN_'),
              ),
            ).toBe(true);
          }
          if (scenario === 'conflict' || scenario === 'monotonic') {
            fixture.setStatusHtml(
              scenario === 'conflict'
                ? fixtureStatusPage(context, 'UNKNOWN')
                : '<p>Page temporarily unavailable</p>',
            );
            expect(
              (
                await app.inject({
                  method: 'POST',
                  url: `${base}/check`,
                  headers,
                  payload: {},
                })
              ).statusCode,
            ).toBe(202);
            result = await eventually(
              () =>
                db.submissionVerification.findUniqueOrThrow({
                  where: { id: result.id },
                  include: verificationInclude,
                }),
              (row) =>
                row.generation === 2 &&
                ['CONFIRMED', 'HUMAN_REQUIRED'].includes(row.state),
            );
            expect(result.state).toBe(
              scenario === 'conflict' ? 'HUMAN_REQUIRED' : 'CONFIRMED',
            );
            if (scenario === 'conflict') {
              expect(result.reason).toBe('CONFLICTING_EVIDENCE');
              expect(
                (
                  await app.inject({
                    method: 'POST',
                    url: `${base}/reject`,
                    headers,
                    payload: { rejected: true },
                  })
                ).statusCode,
              ).toBe(409);
            }
          }
          expect(
            (await app.inject({ method: 'GET', url: base, headers })).json()
              .verification.state,
          ).toBe(result.state);
          expect(
            (
              await app.inject({
                method: 'GET',
                url: `${base}/evidence`,
                headers,
              })
            ).json().evidenceCount,
          ).toBe(result.evidence.length);
          expect(
            result.events.some((e) => e.type === 'SUBMISSION_ATTEMPTED'),
          ).toBe(scenario !== 'missing-ledger');
          expect(
            result.events.some((e) => e.type === 'VERIFICATION_COMPLETED'),
          ).toBe(true);
          expect(JSON.stringify(result)).not.toContain('ada@example.com');
          expect(JSON.stringify(result)).not.toContain('%PDF');
          expect(
            (
              await app.inject({
                method: 'POST',
                url: `/api/v1/applications/${applicationId}/execution/resume`,
                headers,
                payload: { executionId },
              })
            ).statusCode,
          ).toBe(409);
          expect(fixture.submissions).toHaveLength(1);
          expect(fixture.nextMutations).toHaveLength(0);
          // Composite evidence/attempt FK cannot attach a foreign execution's attempt.
          await expect(
            db.verificationEvidence.create({
              data: {
                verificationId: result.id,
                attemptId: 'not-this-verification',
                fingerprint: randomUUID(),
                type: 'HTTP_SUCCESS',
                strength: 'WEAK',
                capturedAt: new Date(),
                data: {},
              },
            }),
          ).rejects.toThrow();
        } finally {
          releaseStale?.({ evidence: [], reason: 'TEST_CLEANUP' });
          await staleTask;
          await app.close();
          await worker.close();
          await secondWorker.close();
          await executor.close();
          await queue.close();
          await producer.quit();
          await consumer.quit();
          await secondConsumer.quit();
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
