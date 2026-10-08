import { createHmac } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import type { PrismaClient } from '@careerlift/database';
import type { Queue } from 'bullmq';
import { createApp } from './app.js';

const secret = 'preparation-test-secret';
const token = (sub: string) => {
  const head = Buffer.from(
    JSON.stringify({ alg: 'HS256', typ: 'JWT' }),
  ).toString('base64url');
  const body = Buffer.from(
    JSON.stringify({ sub, exp: Math.floor(Date.now() / 1000) + 3600 }),
  ).toString('base64url');
  return `Bearer ${head}.${body}.${createHmac('sha256', secret).update(`${head}.${body}`).digest('base64url')}`;
};
const schema = {
  inspectionId: 'inspection',
  applicationPlanId: 'plan',
  sourceUrl: 'https://example.com/apply',
  finalUrl: 'https://example.com/apply',
  redirectChain: [],
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
  confidence: 0.9,
  inspectionMetadata: {
    inspectedAt: new Date().toISOString(),
    durationMs: 1,
    visibleTextExcerpt: 'Apply',
    fieldCount: 0,
  },
};

describe('preparation API', () => {
  it('authenticates, checks ownership and inspection eligibility', async () => {
    let state = 'COMPLETED';
    let exists = true;
    let hasInspection = true;
    let result: unknown = schema;
    const db = {
      application: {
        findFirst: async ({ where }: { where: { userId: string } }) =>
          where.userId === 'owner' && exists
            ? {
                id: 'app',
                state: 'RESOLVED',
                executions: [],
                inspection: hasInspection
                  ? { id: 'inspection', state, result }
                  : null,
                preparation: null,
              }
            : null,
      },
    } as unknown as PrismaClient;
    const app = createApp({
      db,
      queue: { add: async () => {} } as unknown as Queue,
      authSecret: secret,
    });
    try {
      const url = '/api/v1/applications/app/prepare';
      expect((await app.inject({ method: 'POST', url })).statusCode).toBe(401);
      expect(
        (
          await app.inject({
            method: 'POST',
            url,
            headers: { authorization: token('stranger') },
          })
        ).statusCode,
      ).toBe(404);
      exists = false;
      expect(
        (
          await app.inject({
            method: 'POST',
            url,
            headers: { authorization: token('owner') },
          })
        ).statusCode,
      ).toBe(404);
      exists = true;
      hasInspection = false;
      expect(
        (
          await app.inject({
            method: 'POST',
            url,
            headers: { authorization: token('owner') },
          })
        ).statusCode,
      ).toBe(409);
      hasInspection = true;
      for (const ineligible of ['FAILED', 'HUMAN_REQUIRED', 'PENDING']) {
        state = ineligible;
        expect(
          (
            await app.inject({
              method: 'POST',
              url,
              headers: { authorization: token('owner') },
            })
          ).statusCode,
        ).toBe(409);
      }
      state = 'COMPLETED';
      result = null;
      expect(
        (
          await app.inject({
            method: 'POST',
            url,
            headers: { authorization: token('owner') },
          })
        ).statusCode,
      ).toBe(409);
    } finally {
      await app.close();
    }
  });
  it('queues once and returns existing terminal preparation', async () => {
    let preparation: { id: string; state: string; result: unknown } | null =
      null;
    const added: string[] = [];
    const db = {
      application: {
        findFirst: async () => ({
          id: 'app',
          state: 'RESOLVED',
          executions: [],
          inspection: { id: 'inspection', state: 'COMPLETED', result: schema },
          preparation,
        }),
      },
      applicationPreparation: {
        upsert: async () => {
          preparation = { id: 'prep', state: 'PENDING', result: null };
          return preparation;
        },
      },
    } as unknown as PrismaClient;
    const app = createApp({
      db,
      queue: {
        add: async (name: string) => {
          added.push(name);
        },
      } as unknown as Queue,
      authSecret: secret,
    });
    try {
      const url = '/api/v1/applications/app/prepare';
      expect(
        (
          await app.inject({
            method: 'POST',
            url,
            headers: { authorization: token('owner') },
          })
        ).statusCode,
      ).toBe(202);
      expect(added).toEqual(['PREPARE_APPLICATION']);
      preparation = {
        id: 'prep',
        state: 'COMPLETED',
        result: {
          version: 1,
          applicationId: 'app',
          inspectionId: 'inspection',
          jobId: 'job',
          fields: [],
          questions: [],
          documents: [],
          humanReviewItems: [],
          overallStatus: 'COMPLETED',
          overallConfidence: 1,
          preparedAt: new Date().toISOString(),
        },
      };
      expect(
        (
          await app.inject({
            method: 'POST',
            url,
            headers: { authorization: token('owner') },
          })
        ).json().status,
      ).toBe('COMPLETED');
      expect(added).toHaveLength(1);
      expect(
        (
          await app.inject({
            method: 'GET',
            url: '/api/v1/applications/app/preparation',
            headers: { authorization: token('owner') },
          })
        ).json().result.applicationId,
      ).toBe('app');
    } finally {
      await app.close();
    }
  });
});
