import { randomUUID, createHmac } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { QueueEvents, Worker } from 'bullmq';
import { PrismaClient } from '@careerlift/database';
import {
  ApplicationPlanSchema,
  ApplicationSchemaSchema,
} from '@careerlift/domain';
import {
  ApplicationInspector,
  BrowserSessionManager,
  DestinationPolicy,
} from '@careerlift/browser';
import { createApp } from './app.js';
import {
  createApplicationQueue,
  createRedisConnection,
  QUEUE_NAME,
} from '../../worker/src/queue.js';
import { createInspectionProcessor } from '../../worker/src/inspection-processor.js';

const databaseUrl = process.env.INTEGRATION_DATABASE_URL;
const redisUrl = process.env.INTEGRATION_REDIS_URL;
if (databaseUrl && !/\/careerlift_test(?:\?|$)/.test(databaseUrl))
  throw new Error('Integration tests require careerlift_test');

if (databaseUrl && redisUrl)
  describe('API to PostgreSQL to BullMQ to Playwright inspection', () => {
    it('persists a real browser fixture result through the full pipeline', async () => {
      const suffix = randomUUID();
      const db = new PrismaClient({ datasourceUrl: databaseUrl });
      const producer = createRedisConnection(redisUrl);
      const consumer = createRedisConnection(redisUrl);
      const eventConnection = createRedisConnection(redisUrl);
      const queue = createApplicationQueue(producer);
      const events = new QueueEvents(QUEUE_NAME, {
        connection: eventConnection,
      });
      const policy = new DestinationPolicy(undefined, async () => ['8.8.8.8']);
      const fixture = readFileSync(
        new URL(
          '../../../tests/fixtures/inspection/generic.html',
          import.meta.url,
        ),
        'utf8',
      );
      class FixtureSessions extends BrowserSessionManager {
        constructor() {
          super(true, policy);
        }
        override async create() {
          const session = await super.create();
          await session.page.route('https://fixture.example/**', (route) =>
            route.fulfill({
              status: 200,
              contentType: 'text/html',
              body: fixture,
            }),
          );
          return session;
        }
      }
      const worker = new Worker(
        QUEUE_NAME,
        createInspectionProcessor(
          db,
          new ApplicationInspector(new FixtureSessions()),
        ),
        { connection: consumer, autorun: false },
      );
      const secret = 'pipeline-test-secret';
      const app = createApp({ db, queue, authSecret: secret, policy });
      const head = Buffer.from(
        JSON.stringify({ alg: 'HS256', typ: 'JWT' }),
      ).toString('base64url');
      let userId: string | undefined;
      let jobId: string | undefined;
      let applicationId: string | undefined;
      try {
        await events.waitUntilReady();
        const user = await db.user.create({
          data: { email: `pipeline-${suffix}@example.com` },
        });
        userId = user.id;
        const job = await db.job.create({
          data: {
            id: `pipeline-${suffix}`,
            externalId: suffix,
            source: 'INTEGRATION_TEST',
            company: 'Example',
            title: 'Engineer',
            requirements: [],
          },
        });
        jobId = job.id;
        const application = await db.application.create({
          data: {
            userId: user.id,
            jobId: job.id,
            state: 'RESOLVED',
          },
        });
        applicationId = application.id;
        const plan = ApplicationPlanSchema.parse({
          jobId: job.id,
          applicationType: 'DIRECT_PORTAL',
          destination: { url: 'https://fixture.example/apply' },
          requirements: [],
          actions: [],
          executor: 'BROWSER',
          confidence: 0.8,
          requiresHumanReview: false,
          reasoning: ['fixture'],
          resolvedBy: 'deterministic',
        });
        await db.applicationPlan.create({
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
        const body = Buffer.from(
          JSON.stringify({
            sub: user.id,
            exp: Math.floor(Date.now() / 1000) + 3600,
          }),
        ).toString('base64url');
        const signature = createHmac('sha256', secret)
          .update(`${head}.${body}`)
          .digest('base64url');
        const authorization = `Bearer ${head}.${body}.${signature}`;
        const started = await app.inject({
          method: 'POST',
          url: `/api/v1/applications/${application.id}/inspect`,
          headers: { authorization },
        });
        expect(started.statusCode).toBe(202);
        const queued = (await queue.getJobs(['waiting'])).find(
          (task) => task.data.applicationId === application.id,
        );
        expect(queued).toBeDefined();
        void worker.run();
        await queued!.waitUntilFinished(events, 30000);
        const response = await app.inject({
          method: 'GET',
          url: `/api/v1/applications/${application.id}/inspection`,
          headers: { authorization },
        });
        expect(response.statusCode).toBe(200);
        expect(response.json().status).toBe('HUMAN_REQUIRED');
        const schema = response.json().schema;
        expect(schema.title).toBe('Engineer Application');
        expect(schema.fields.length).toBeGreaterThan(0);
        expect(response.body).not.toContain('inspectionMetadata');
        expect(response.body).not.toContain('executionFlow');
        const saved = await db.applicationInspection.findUniqueOrThrow({
          where: { applicationId: application.id },
        });
        expect(saved.state).toBe('HUMAN_REQUIRED');
        expect(ApplicationSchemaSchema.parse(saved.result).inspectionId).toBe(
          saved.id,
        );
      } finally {
        await app.close();
        await worker.close();
        await events.close();
        await producer.quit();
        await consumer.quit();
        await eventConnection.quit();
        if (applicationId) {
          await db.applicationEvent.deleteMany({ where: { applicationId } });
          await db.applicationInspection.deleteMany({
            where: { applicationId },
          });
          await db.applicationPlan.deleteMany({ where: { applicationId } });
          await db.application.delete({ where: { id: applicationId } });
        }
        if (jobId) await db.job.delete({ where: { id: jobId } });
        if (userId) await db.user.delete({ where: { id: userId } });
        await db.$disconnect();
      }
    }, 60000);
  });
else
  describe.skip('API to PostgreSQL to BullMQ to Playwright inspection', () => {
    it('requires integration database and Redis URLs', () => {});
  });
