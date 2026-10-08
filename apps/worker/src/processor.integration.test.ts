import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { QueueEvents, Worker } from 'bullmq';
import { PrismaClient } from '@careerlift/database';
import { DeterministicResolver } from '@careerlift/application-resolver';
import { ApplicationPlanSchema, type Job } from '@careerlift/domain';
import {
  createApplicationQueue,
  createRedisConnection,
  enqueueResolution,
  QUEUE_NAME,
} from './queue.js';
import { createResolutionProcessor } from './processor.js';

const databaseUrl = process.env.INTEGRATION_DATABASE_URL;
const redisUrl = process.env.INTEGRATION_REDIS_URL;
if (databaseUrl && !/\/careerlift_test(?:\?|$)/.test(databaseUrl))
  throw new Error('Integration tests require the careerlift_test database');

if (databaseUrl && redisUrl)
  describe('real PostgreSQL and Redis resolution flow', () => {
    const db = new PrismaClient({ datasourceUrl: databaseUrl! });
    const producerConnection = createRedisConnection(redisUrl!);
    const workerConnection = createRedisConnection(redisUrl!);
    const eventsConnection = createRedisConnection(redisUrl!);
    const queue = createApplicationQueue(producerConnection);
    const events = new QueueEvents(QUEUE_NAME, {
      connection: eventsConnection,
    });
    const worker = new Worker(
      QUEUE_NAME,
      createResolutionProcessor(db, new DeterministicResolver()),
      { connection: workerConnection },
    );
    const ids: { user?: string; job?: string; application?: string } = {};

    beforeAll(async () => {
      await events.waitUntilReady();
      await worker.waitUntilReady();
    });
    afterAll(async () => {
      await worker.close();
      await events.close();
      await queue.close();
      await producerConnection.quit();
      await workerConnection.quit();
      await eventsConnection.quit();
      if (ids.application) {
        await db.applicationEvent.deleteMany({
          where: { applicationId: ids.application },
        });
        await db.applicationPlan.deleteMany({
          where: { applicationId: ids.application },
        });
        await db.application.delete({ where: { id: ids.application } });
      }
      if (ids.job) await db.job.delete({ where: { id: ids.job } });
      if (ids.user) await db.user.delete({ where: { id: ids.user } });
      await db.$disconnect();
    });

    it('persists a plan and one set of events across duplicate delivery', async () => {
      const suffix = randomUUID();
      const job: Job = {
        id: `test-job-${suffix}`,
        externalId: suffix,
        source: 'INTEGRATION_TEST',
        company: 'Example',
        title: 'Engineer',
        requirements: ['Resume required'],
        application: { email: 'jobs@example.com' },
      };
      const user = await db.user.create({
        data: { email: `test-${suffix}@example.com` },
      });
      ids.user = user.id;
      await db.job.create({
        data: {
          id: job.id,
          externalId: job.externalId,
          source: job.source,
          company: job.company,
          title: job.title,
          requirements: job.requirements,
          applicationInfo: { email: 'jobs@example.com' },
        },
      });
      ids.job = job.id;
      const application = await db.application.create({
        data: { userId: user.id, jobId: job.id },
      });
      ids.application = application.id;
      const payload = { applicationId: application.id, job, requestId: suffix };
      await enqueueResolution(queue, payload);
      const queued = (
        await queue.getJobs(['waiting', 'active', 'completed'])
      ).find((item) => item.data.requestId === suffix);
      expect(queued).toBeDefined();
      await queued!.waitUntilFinished(events, 20000);
      const second = await queue.add('RESOLVE_APPLICATION', payload, {
        attempts: 3,
        backoff: { type: 'exponential', delay: 1000 },
      });
      await second.waitUntilFinished(events, 20000);
      const saved = await db.application.findUniqueOrThrow({
        where: { id: application.id },
        include: { plan: true, events: true },
      });
      expect(saved.state).toBe('RESOLVED');
      expect(
        ApplicationPlanSchema.parse({
          jobId: job.id,
          applicationType: saved.plan?.applicationType,
          destination: saved.plan?.destination,
          requirements: saved.plan?.requirements,
          actions: saved.plan?.actions,
          executor: saved.plan?.executor,
          confidence: saved.plan?.confidence,
          requiresHumanReview: saved.plan?.requiresHumanReview,
          reasoning: saved.plan?.reasoning,
          resolvedBy: saved.plan?.resolvedBy,
        }).executor,
      ).toBe('EMAIL');
      expect(saved.events.map((event) => event.type).sort()).toEqual([
        'APPLICATION_ANALYSIS_STARTED',
        'APPLICATION_RESOLVED',
      ]);
    });
  });
else
  describe.skip('real PostgreSQL and Redis resolution flow', () => {
    it('requires INTEGRATION_DATABASE_URL and INTEGRATION_REDIS_URL', () => {});
  });
