import { createHmac, randomUUID } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { QueueEvents, Worker } from 'bullmq';
import { PrismaClient } from '@careerlift/database';
import {
  ApplicationSchemaSchema,
  MockAnswerGenerationProvider,
  PreparedApplicationSchema,
} from '@careerlift/domain';
import { createApp } from './app.js';
import {
  createApplicationQueue,
  createRedisConnection,
  QUEUE_NAME,
} from '../../worker/src/queue.js';
import { createPreparationProcessor } from '../../worker/src/preparation-processor.js';

const databaseUrl = process.env.INTEGRATION_DATABASE_URL;
const redisUrl = process.env.INTEGRATION_REDIS_URL;
if (databaseUrl && !/\/careerlift_test(?:\?|$)/.test(databaseUrl))
  throw new Error('Integration tests require careerlift_test');

if (databaseUrl && redisUrl)
  describe('Phase 3 API to BullMQ to worker to PostgreSQL', () => {
    it('persists and retrieves a prepared application; duplicate jobs cannot overwrite it', async () => {
      const suffix = randomUUID();
      const db = new PrismaClient({ datasourceUrl: databaseUrl });
      const producer = createRedisConnection(redisUrl),
        consumer = createRedisConnection(redisUrl),
        eventsConnection = createRedisConnection(redisUrl);
      const queue = createApplicationQueue(producer),
        events = new QueueEvents(QUEUE_NAME, { connection: eventsConnection });
      const worker = new Worker(
        QUEUE_NAME,
        createPreparationProcessor(db, new MockAnswerGenerationProvider()),
        { connection: consumer, autorun: false },
      );
      const secret = 'phase-3-pipeline';
      const app = createApp({ db, queue, authSecret: secret });
      let userId: string | undefined,
        jobId: string | undefined,
        applicationId: string | undefined;
      try {
        await events.waitUntilReady();
        const user = await db.user.create({
          data: {
            email: `phase3-${suffix}@example.com`,
            profile: {
              create: {
                data: {
                  firstName: 'Ada',
                  lastName: 'Lovelace',
                  projects: [
                    {
                      id: 'sports',
                      category: 'PROJECT',
                      text: 'Built SportsTalk with Node.js and PostgreSQL.',
                      tags: ['Node.js'],
                    },
                  ],
                },
              },
            },
            verifiedAnswers: {
              create: {
                category: 'SPONSORSHIP',
                value: 'No',
                source: 'USER_VERIFIED',
              },
            },
            documents: {
              create: {
                type: 'RESUME',
                name: 'resume.pdf',
                storageRef: `object://resume/${suffix}`,
                mimeType: 'application/pdf',
                size: 100,
              },
            },
          },
        });
        userId = user.id;
        const job = await db.job.create({
          data: {
            id: `phase3-${suffix}`,
            externalId: suffix,
            source: 'INTEGRATION_TEST',
            company: 'Example',
            title: 'Backend Engineer',
            description: 'Build Node.js services',
            requirements: ['Node.js'],
          },
        });
        jobId = job.id;
        const application = await db.application.create({
          data: { userId: user.id, jobId: job.id, state: 'RESOLVED' },
        });
        applicationId = application.id;
        const plan = await db.applicationPlan.create({
          data: {
            applicationId: application.id,
            applicationType: 'DIRECT_PORTAL',
            destination: { url: 'https://example.com/apply' },
            requirements: [],
            actions: [],
            executor: 'BROWSER',
            confidence: 0.9,
            requiresHumanReview: false,
            reasoning: ['test'],
            resolvedBy: 'deterministic',
          },
        });
        const inspection = await db.applicationInspection.create({
          data: {
            applicationId: application.id,
            applicationPlanId: plan.id,
            state: 'COMPLETED',
          },
        });
        const field = (id: string, label: string, type = 'TEXT') => ({
          id,
          label,
          type,
          required: true,
          visible: true,
          disabled: false,
          readonly: false,
          options: [],
          source: 'DOM',
        });
        const schema = ApplicationSchemaSchema.parse({
          inspectionId: inspection.id,
          applicationPlanId: plan.id,
          sourceUrl: 'https://example.com/apply',
          finalUrl: 'https://example.com/apply',
          redirectChain: [],
          finalHostname: 'example.com',
          plannedApplicationType: 'DIRECT_PORTAL',
          platform: 'GENERIC_PORTAL',
          platformDiscrepancy: false,
          title: 'Apply',
          fields: [
            field('first', 'First Name'),
            field('last', 'Last Name'),
            field('email', 'Email', 'EMAIL'),
            field('resume', 'Resume', 'FILE'),
            field('motivation', 'Why do you want to work here?', 'TEXTAREA'),
            field('project', 'Describe a challenging project.', 'TEXTAREA'),
            field('sponsorship', 'Will you require sponsorship?'),
            field('salary', 'Expected salary?'),
          ],
          questions: [
            {
              id: 'motivation',
              fieldId: 'motivation',
              text: 'Why do you want to work here?',
              type: 'TEXTAREA',
              required: true,
              sensitivity: 'NONE',
              semanticType: 'CUSTOM_QUESTION',
              answerSource: 'UNRESOLVED',
              humanReviewRequired: false,
            },
            {
              id: 'project',
              fieldId: 'project',
              text: 'Describe a challenging project.',
              type: 'TEXTAREA',
              required: true,
              sensitivity: 'NONE',
              semanticType: 'CUSTOM_QUESTION',
              answerSource: 'UNRESOLVED',
              humanReviewRequired: false,
            },
            {
              id: 'sponsorship',
              fieldId: 'sponsorship',
              text: 'Will you require sponsorship?',
              type: 'TEXT',
              required: true,
              sensitivity: 'CONSEQUENTIAL',
              semanticType: 'SPONSORSHIP',
              answerSource: 'UNRESOLVED',
              humanReviewRequired: true,
            },
            {
              id: 'salary',
              fieldId: 'salary',
              text: 'Expected salary?',
              type: 'TEXT',
              required: true,
              sensitivity: 'CONSEQUENTIAL',
              semanticType: 'SALARY_EXPECTATION',
              answerSource: 'UNRESOLVED',
              humanReviewRequired: true,
            },
          ],
          documents: [
            {
              type: 'RESUME',
              label: 'Resume',
              required: true,
              fieldId: 'resume',
              acceptedFileTypes: ['.pdf'],
              humanReviewRequired: false,
            },
          ],
          forms: [],
          authentication: { required: false },
          humanReview: { required: false, reasons: [] },
          confidence: 0.9,
          inspectionMetadata: {
            inspectedAt: new Date().toISOString(),
            durationMs: 1,
            visibleTextExcerpt: 'Apply',
            fieldCount: 8,
          },
        });
        await db.applicationInspection.update({
          where: { id: inspection.id },
          data: { result: schema },
        });
        const head = Buffer.from(
            JSON.stringify({ alg: 'HS256', typ: 'JWT' }),
          ).toString('base64url'),
          body = Buffer.from(
            JSON.stringify({
              sub: user.id,
              exp: Math.floor(Date.now() / 1000) + 3600,
            }),
          ).toString('base64url');
        const authorization = `Bearer ${head}.${body}.${createHmac('sha256', secret).update(`${head}.${body}`).digest('base64url')}`;
        const started = await app.inject({
          method: 'POST',
          url: `/api/v1/applications/${application.id}/prepare`,
          headers: { authorization },
        });
        expect(started.statusCode).toBe(202);
        const queued = (await queue.getJobs(['waiting'])).find(
          (task) =>
            task.name === 'PREPARE_APPLICATION' &&
            task.data.applicationId === application.id,
        );
        expect(queued).toBeDefined();
        void worker.run();
        await queued!.waitUntilFinished(events, 30000);
        const response = await app.inject({
          method: 'GET',
          url: `/api/v1/applications/${application.id}/preparation`,
          headers: { authorization },
        });
        expect(response.statusCode).toBe(200);
        expect(response.json().result.overallStatus).toBe('HUMAN_REQUIRED');
        expect(response.body).not.toContain('storageRef');
        const internal = await db.applicationPreparation.findUniqueOrThrow({
          where: { applicationId: application.id },
        });
        const result = PreparedApplicationSchema.parse(internal.result);
        expect(result.fields.find((f) => f.fieldId === 'first')?.value).toBe(
          'Ada',
        );
        expect(
          result.questions.find((q) => q.questionId === 'project')?.evidenceIds,
        ).toContain('sports');
        expect(
          result.questions.find((q) => q.questionId === 'sponsorship')?.source,
        ).toBe('USER_VERIFIED');
        expect(
          result.questions.find((q) => q.questionId === 'salary')
            ?.requiresHumanReview,
        ).toBe(true);
        expect(result.documents[0]?.documentId).toBeTruthy();
        expect(result.overallStatus).toBe('HUMAN_REQUIRED');
        const saved = await db.applicationPreparation.findUniqueOrThrow({
          where: { applicationId: application.id },
        });
        expect(
          PreparedApplicationSchema.parse(saved.result).applicationId,
        ).toBe(application.id);
        await createPreparationProcessor(
          db,
          new MockAnswerGenerationProvider(),
        )({
          name: 'PREPARE_APPLICATION',
          data: { applicationId: application.id, requestId: suffix },
        } as never);
        expect(
          (
            await db.applicationPreparation.findUniqueOrThrow({
              where: { applicationId: application.id },
            })
          ).result,
        ).toEqual(saved.result);
        expect(
          (
            await db.applicationPreparation.updateMany({
              where: { id: saved.id, state: 'RUNNING', runId: 'stale-worker' },
              data: { state: 'FAILED', errorCode: 'STALE_RESULT' },
            })
          ).count,
        ).toBe(0);
        // Re-arm this test record to exercise overlapping deliveries of one run.
        await db.applicationPreparation.update({
          where: { id: saved.id },
          data: { state: 'PENDING', result: { test: true } },
        });
        let signalStarted!: () => void;
        let release!: () => void;
        const startedGeneration = new Promise<void>((resolve) => {
          signalStarted = resolve;
        });
        const gate = new Promise<void>((resolve) => {
          release = resolve;
        });
        let calls = 0;
        const mock = new MockAnswerGenerationProvider();
        const concurrent = createPreparationProcessor(db, {
          name: 'gated-mock',
          generateAnswer: async (input) => {
            calls++;
            signalStarted();
            await gate;
            return mock.generateAnswer(input);
          },
        });
        const duplicateTask = {
          name: 'PREPARE_APPLICATION',
          data: { applicationId: application.id, requestId: suffix },
        } as never;
        const firstRun = concurrent(duplicateTask);
        await startedGeneration;
        expect(await concurrent(duplicateTask)).toBeUndefined();
        expect(calls).toBe(1);
        release();
        await firstRun;
        expect(
          (
            await db.applicationPreparation.findUniqueOrThrow({
              where: { id: saved.id },
            })
          ).state,
        ).toBe('HUMAN_REQUIRED');
      } finally {
        await app.close();
        await worker.close();
        await events.close();
        await queue.close();
        await producer.quit();
        await consumer.quit();
        await eventsConnection.quit();
        if (applicationId) {
          await db.applicationEvent.deleteMany({ where: { applicationId } });
          await db.applicationPreparation.deleteMany({
            where: { applicationId },
          });
          await db.applicationInspection.deleteMany({
            where: { applicationId },
          });
          await db.applicationPlan.deleteMany({ where: { applicationId } });
          await db.application.deleteMany({ where: { id: applicationId } });
        }
        if (jobId) await db.job.deleteMany({ where: { id: jobId } });
        if (userId) {
          await db.verifiedAnswer.deleteMany({ where: { userId } });
          await db.userDocument.deleteMany({ where: { userId } });
          await db.applicationProfile.deleteMany({ where: { userId } });
          await db.user.deleteMany({ where: { id: userId } });
        }
        await db.$disconnect();
      }
    }, 60000);
  });
else
  describe.skip('Phase 3 API to BullMQ to worker to PostgreSQL', () => {
    it('requires integration database and Redis URLs', () => {});
  });
