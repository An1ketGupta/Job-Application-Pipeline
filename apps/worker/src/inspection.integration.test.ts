import { randomUUID } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { PrismaClient } from '@careerlift/database';
import {
  ApplicationPlanSchema,
  ApplicationSchemaSchema,
} from '@careerlift/domain';
import type { ApplicationInspector } from '@careerlift/browser';
import type { Job as QueueJob } from 'bullmq';
import {
  createInspectionProcessor,
  failStaleInspections,
} from './inspection-processor.js';

const databaseUrl = process.env.INTEGRATION_DATABASE_URL;
if (databaseUrl && !/\/careerlift_test(?:\?|$)/.test(databaseUrl))
  throw new Error('Integration tests require careerlift_test');

if (databaseUrl)
  describe('inspection persistence', () => {
    it('persists one schema and returns it on duplicate delivery', async () => {
      const db = new PrismaClient({ datasourceUrl: databaseUrl });
      const suffix = randomUUID();
      const jobId = `inspect-job-${suffix}`;
      const user = await db.user.create({
        data: { email: `inspection-${suffix}@example.com` },
      });
      const job = await db.job.create({
        data: {
          id: jobId,
          externalId: suffix,
          source: 'INTEGRATION_TEST',
          company: 'Example',
          title: 'Engineer',
          requirements: [],
        },
      });
      const application = await db.application.create({
        data: { userId: user.id, jobId: job.id, state: 'RESOLVED' },
      });
      const plan = ApplicationPlanSchema.parse({
        jobId,
        applicationType: 'DIRECT_PORTAL',
        destination: { url: 'https://example.com/apply' },
        requirements: [],
        actions: [],
        executor: 'BROWSER',
        confidence: 0.8,
        requiresHumanReview: false,
        reasoning: ['fixture'],
        resolvedBy: 'deterministic',
      });
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
      await db.applicationInspection.create({
        data: {
          applicationId: application.id,
          applicationPlanId: savedPlan.id,
          state: 'PENDING',
        },
      });
      let inspectCalls = 0;
      let releaseInspection!: () => void;
      const inspectionGate = new Promise<void>((resolve) => {
        releaseInspection = resolve;
      });
      let signalStarted!: () => void;
      const inspectionStarted = new Promise<void>((resolve) => {
        signalStarted = resolve;
      });
      const inspector = {
        inspect: async (
          _plan: typeof plan,
          planId: string,
          inspectionId: string,
        ) => {
          void _plan;
          inspectCalls++;
          signalStarted();
          await inspectionGate;
          const schema = ApplicationSchemaSchema.parse({
            inspectionId,
            applicationPlanId: planId,
            sourceUrl: 'https://example.com/apply',
            finalUrl: 'https://example.com/apply',
            redirectChain: ['https://example.com/apply'],
            finalHostname: 'example.com',
            plannedApplicationType: 'DIRECT_PORTAL',
            platform: 'GENERIC_PORTAL',
            platformDiscrepancy: false,
            title: 'Apply',
            fields: [],
            questions: [],
            documents: [],
            forms: [],
            authentication: { required: false },
            humanReview: { required: false, reasons: [] },
            confidence: 0.5,
            inspectionMetadata: {
              inspectedAt: new Date().toISOString(),
              durationMs: 5,
              visibleTextExcerpt: 'Apply',
              fieldCount: 0,
            },
          });
          return { status: 'COMPLETED' as const, schema };
        },
      } as ApplicationInspector;
      try {
        const process = createInspectionProcessor(db, inspector);
        const task = {
          name: 'INSPECT_APPLICATION',
          data: { applicationId: application.id, requestId: suffix },
        } as QueueJob;
        const first = process(task);
        await inspectionStarted;
        const running = await db.applicationInspection.findUniqueOrThrow({
          where: { applicationId: application.id },
        });
        expect(running.state).toBe('RUNNING');
        await Promise.all([process(task), process(task)]);
        expect(inspectCalls).toBe(1);
        releaseInspection();
        await first;
        await process(task);
        expect(
          (
            await db.applicationInspection.updateMany({
              where: { id: running.id, state: 'RUNNING', runId: running.runId },
              data: { state: 'FAILED', errorCode: 'STALE_WORKER' },
            })
          ).count,
        ).toBe(0);
        const saved = await db.applicationInspection.findUniqueOrThrow({
          where: { applicationId: application.id },
        });
        expect(saved.state).toBe('COMPLETED');
        expect(
          await failStaleInspections(db, new Date(Date.now() + 60_000)),
        ).toBe(0);
        expect(saved.applicationPlanId).toBe(savedPlan.id);
        expect(ApplicationSchemaSchema.parse(saved.result).title).toBe('Apply');
        expect(inspectCalls).toBe(1);
        expect(
          await db.applicationEvent.count({
            where: { applicationId: application.id },
          }),
        ).toBe(2);
      } finally {
        await db.applicationEvent.deleteMany({
          where: { applicationId: application.id },
        });
        await db.applicationInspection.deleteMany({
          where: { applicationId: application.id },
        });
        await db.applicationPlan.delete({ where: { id: savedPlan.id } });
        await db.application.delete({ where: { id: application.id } });
        await db.job.delete({ where: { id: job.id } });
        await db.user.delete({ where: { id: user.id } });
        await db.$disconnect();
      }
    });
  });
else
  describe.skip('inspection persistence', () => {
    it('requires INTEGRATION_DATABASE_URL', () => {});
  });
