import { randomUUID } from 'node:crypto';
import { describe, expect, it, beforeAll, afterAll } from 'vitest';
import { QueueEvents, Worker } from 'bullmq';
import { PrismaClient } from '@careerlift/database';
import { DeterministicResolver } from '@careerlift/application-resolver';
import { createApp } from './app.js';
import { createToken } from './auth.js';
import {
  createApplicationQueue,
  createRedisConnection,
  QUEUE_NAME,
} from '../../worker/src/queue.js';
import { createResolutionProcessor } from '../../worker/src/processor.js';

const databaseUrl = process.env.INTEGRATION_DATABASE_URL;
const redisUrl = process.env.INTEGRATION_REDIS_URL;
if (databaseUrl && !/\/careerlift_test(?:\?|$)/.test(databaseUrl)) {
  throw new Error('Integration tests require careerlift_test');
}

if (databaseUrl && redisUrl) {
  describe('Jobs Discovery & Ingestion to Resolution Pipeline Integration', () => {
    const authSecret = 'integration-jobs-auth-secret';
    const db = new PrismaClient({ datasourceUrl: databaseUrl });
    const producerConnection = createRedisConnection(redisUrl);
    const workerConnection = createRedisConnection(redisUrl);
    const eventsConnection = createRedisConnection(redisUrl);
    const queue = createApplicationQueue(producerConnection);
    const events = new QueueEvents(QUEUE_NAME, {
      connection: eventsConnection,
    });
    const worker = new Worker(
      QUEUE_NAME,
      createResolutionProcessor(db, new DeterministicResolver()),
      { connection: workerConnection },
    );

    const app = createApp({
      db,
      queue,
      authSecret,
    });

    const userSuffix = randomUUID();
    let testUserId: string;
    let userToken: string;
    let targetJobId: string;
    let createdApplicationId: string;

    beforeAll(async () => {
      await events.waitUntilReady();
      await worker.waitUntilReady();

      const user = await db.user.create({
        data: { email: `test-jobs-${userSuffix}@example.com` },
      });
      testUserId = user.id;
      userToken = `Bearer ${createToken(testUserId, authSecret, 3600)}`;
    });

    afterAll(async () => {
      if (createdApplicationId) {
        await db.applicationEvent.deleteMany({
          where: { applicationId: createdApplicationId },
        });
        await db.applicationPlan.deleteMany({
          where: { applicationId: createdApplicationId },
        });
        await db.application.deleteMany({
          where: { id: createdApplicationId },
        });
      }
      if (testUserId) {
        await db.user.deleteMany({ where: { id: testUserId } });
      }

      await app.close();
      await worker.close();
      await events.close();
      await queue.close();
      await producerConnection.quit();
      await workerConnection.quit();
      await eventsConnection.quit();
      await db.$disconnect();
    });

    it('executes full Sync -> Persist -> Browse -> Filter -> Open -> Apply -> Resolve flow', async () => {
      // 1. Sync Jobs from CareerLift
      const syncRes1 = await app.inject({
        method: 'POST',
        url: '/api/v1/jobs/sync',
        headers: { authorization: userToken },
      });
      expect(syncRes1.statusCode).toBe(200);
      const syncData1 = syncRes1.json();
      expect(syncData1.synced).toBeGreaterThanOrEqual(10);
      expect(syncData1.lastSyncedAt).toBeDefined();

      // 2. Idempotent repeated Sync
      const syncRes2 = await app.inject({
        method: 'POST',
        url: '/api/v1/jobs/sync',
        headers: { authorization: userToken },
      });
      expect(syncRes2.statusCode).toBe(200);
      const syncData2 = syncRes2.json();
      expect(syncData2.synced).toBe(syncData1.synced);

      // 3. Browse / Fetch Jobs
      const listRes = await app.inject({
        method: 'GET',
        url: '/api/v1/jobs?limit=5',
        headers: { authorization: userToken },
      });
      expect(listRes.statusCode).toBe(200);
      const listData = listRes.json();
      expect(listData.jobs.length).toBeLessThanOrEqual(5);
      expect(listData.pagination.total).toBeGreaterThanOrEqual(10);

      // Find an ATS job (Greenhouse or Lever) to apply to
      const allJobsRes = await app.inject({
        method: 'GET',
        url: '/api/v1/jobs?limit=50',
        headers: { authorization: userToken },
      });
      type JobItem = {
        id: string;
        company: string;
        application?: { type?: string; provider?: string };
      };
      const allJobs = allJobsRes.json().jobs as JobItem[];
      const greenhouseJob = allJobs.find(
        (j: JobItem) =>
          j.application?.type === 'EXTERNAL_ATS' ||
          j.application?.provider === 'GREENHOUSE',
      );
      expect(greenhouseJob).toBeDefined();
      targetJobId = greenhouseJob!.id;

      // 4. Test Filtering & Search
      const searchRes = await app.inject({
        method: 'GET',
        url: `/api/v1/jobs?search=${encodeURIComponent(greenhouseJob!.company)}`,
        headers: { authorization: userToken },
      });
      expect(searchRes.statusCode).toBe(200);
      const searchData = searchRes.json();
      expect(
        (searchData.jobs as JobItem[]).some(
          (j: JobItem) => j.id === targetJobId,
        ),
      ).toBe(true);

      // 5. Open Single Job Details
      const jobDetailRes = await app.inject({
        method: 'GET',
        url: `/api/v1/jobs/${encodeURIComponent(targetJobId)}`,
        headers: { authorization: userToken },
      });
      expect(jobDetailRes.statusCode).toBe(200);
      const jobDetail = jobDetailRes.json().job;
      expect(jobDetail.id).toBe(targetJobId);
      expect(jobDetail.applicationStatus).toBeNull();

      // 6. Create Application (Apply)
      const applyRes1 = await app.inject({
        method: 'POST',
        url: `/api/v1/jobs/${encodeURIComponent(targetJobId)}/applications`,
        headers: { authorization: userToken },
      });
      expect(applyRes1.statusCode).toBe(201);
      const applyData1 = applyRes1.json();
      expect(applyData1.isExisting).toBe(false);
      expect(applyData1.application.state).toBe('DISCOVERED');
      createdApplicationId = applyData1.application.id;

      // 7. Wait for worker resolution
      const queuedJobs = await queue.getJobs([
        'waiting',
        'active',
        'completed',
      ]);
      const resolutionJob = queuedJobs.find(
        (item) => item.data.applicationId === createdApplicationId,
      );
      if (resolutionJob) {
        await resolutionJob.waitUntilFinished(events, 15000);
      }

      // Check persisted state in database
      const persistedApplication = await db.application.findUniqueOrThrow({
        where: { id: createdApplicationId },
        include: { plan: true, events: true },
      });
      expect(['RESOLVED', 'HUMAN_REQUIRED']).toContain(
        persistedApplication.state,
      );
      expect(persistedApplication.plan).toBeDefined();

      // 8. Re-check Job details to verify updated application state
      const updatedJobRes = await app.inject({
        method: 'GET',
        url: `/api/v1/jobs/${encodeURIComponent(targetJobId)}`,
        headers: { authorization: userToken },
      });
      expect(updatedJobRes.statusCode).toBe(200);
      const updatedJobStatus = updatedJobRes.json().job.applicationStatus;
      expect(updatedJobStatus.hasApplication).toBe(true);
      expect(updatedJobStatus.applicationId).toBe(createdApplicationId);

      // 9. Prevent Duplicate Application
      const duplicateApplyRes = await app.inject({
        method: 'POST',
        url: `/api/v1/jobs/${encodeURIComponent(targetJobId)}/applications`,
        headers: { authorization: userToken },
      });
      expect(duplicateApplyRes.statusCode).toBe(200);
      const duplicateData = duplicateApplyRes.json();
      expect(duplicateData.isExisting).toBe(true);
      expect(duplicateData.application.id).toBe(createdApplicationId);

      // 10. Fetch Application Details
      const appDetailRes = await app.inject({
        method: 'GET',
        url: `/api/v1/applications/${encodeURIComponent(createdApplicationId)}`,
        headers: { authorization: userToken },
      });
      expect(appDetailRes.statusCode).toBe(200);
      const appDetail = appDetailRes.json().application;
      expect(appDetail.id).toBe(createdApplicationId);
      expect(appDetail.plan).toBeDefined();
    });
  });
} else {
  describe.skip('Jobs Pipeline Integration', () => {
    it('requires INTEGRATION_DATABASE_URL and INTEGRATION_REDIS_URL', () => {});
  });
}
