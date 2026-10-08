import { afterEach, describe, expect, it, vi } from 'vitest';
import type { PrismaClient } from '@careerlift/database';
import type { Queue } from 'bullmq';
import { ashbyInput } from '../../../packages/browser/src/test-support/ashby-fixture.js';
import { requestAutomaticExecution } from './automatic-execution.js';
vi.mock('@careerlift/browser', async (importOriginal) => {
  const original = await importOriginal<typeof import('@careerlift/browser')>();
  return { ...original, validateExecutionTarget: vi.fn(async () => {}) };
});
afterEach(() => vi.unstubAllEnvs());
describe('automatic submission scheduling', () => {
  it('uses one persisted identity and repairs enqueue failures without creating another attempt', async () => {
    vi.stubEnv('VITEST', '');
    vi.stubEnv('NODE_ENV', 'development');
    const input = ashbyInput('https://127.0.0.1:43443');
    delete input.plan.destination.target!.fixtureSourceUrl;
    const real = 'https://jobs.ashbyhq.com/fixture/posting/application';
    input.plan.destination.url = real;
    input.plan.destination.target!.canonicalUrl = real;
    input.plan.destination.target!.entryPoint.url = real;
    input.inspection.sourceUrl = real;
    input.inspection.finalUrl = real;
    input.inspection.finalHostname = 'jobs.ashbyhq.com';
    input.inspection.redirectChain = [real];
    const at = new Date(input.preparationUpdatedAt);
    let records: Record<string, unknown>[] = [];
    const application = {
      id: 'application',
      userId: 'owner',
      jobId: 'job',
      state: 'RESOLVED',
      plan: { ...input.plan, id: 'plan', applicationId: 'application' },
      inspection: {
        id: 'inspection',
        applicationId: 'application',
        applicationPlanId: 'plan',
        state: 'COMPLETED',
        result: input.inspection,
      },
      preparation: {
        id: 'preparation',
        applicationId: 'application',
        inspectionId: 'inspection',
        version: 1,
        state: 'COMPLETED',
        updatedAt: at,
        result: input.preparedApplication,
      },
      user: { documents: input.documents },
      get executions() {
        return records;
      },
    };
    const db = {
      application: { findUnique: async () => application },
      applicationExecution: {
        upsert: async ({ create }: { create: Record<string, unknown> }) => {
          if (!records.length)
            records = [{ ...create, state: 'PENDING', generation: 1 }];
          return records[0];
        },
      },
    } as unknown as PrismaClient;
    const add = vi
        .fn()
        .mockRejectedValueOnce(new Error('Queue offline'))
        .mockResolvedValue(undefined),
      queue = { add } as unknown as Queue;
    await expect(
      requestAutomaticExecution(db, queue, 'application'),
    ).rejects.toThrow('Queue offline');
    expect(records).toHaveLength(1);
    const identity = records[0]!.id;
    await requestAutomaticExecution(db, queue, 'application');
    expect(records).toHaveLength(1);
    expect(records[0]!.id).toBe(identity);
    expect(add.mock.calls[0]![2].jobId).toBe(add.mock.calls[1]![2].jobId);
    records[0]!.state = 'SUBMISSION_UNKNOWN';
    await requestAutomaticExecution(db, queue, 'application');
    expect(add).toHaveBeenCalledTimes(2);
    records = [];
    application.preparation.state = 'HUMAN_REQUIRED';
    await requestAutomaticExecution(db, queue, 'application');
    expect(records).toHaveLength(0);
  });
});
