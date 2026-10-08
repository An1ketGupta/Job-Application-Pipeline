import { describe, expect, it } from 'vitest';
import type { PrismaClient } from '@careerlift/database';
import type { Queue } from 'bullmq';
import { createHmac } from 'node:crypto';
import { createApp } from './app.js';
import { createToken } from './auth.js';

describe('resolution API', () => {
  const resolutionSecret = 'resolution-unit-secret';
  const authorization = `Bearer ${createToken('owner', resolutionSecret)}`;
  it('rejects unauthenticated resolution requests', async () => {
    const app = createApp({ authSecret: resolutionSecret });
    try {
      expect(
        (
          await app.inject({
            method: 'POST',
            url: '/api/v1/application-resolve',
            payload: {},
          })
        ).statusCode,
      ).toBe(401);
    } finally {
      await app.close();
    }
  });
  it('resolves a normalized job without external services', async () => {
    const app = createApp({ authSecret: resolutionSecret });
    const response = await app.inject({
      method: 'POST',
      url: '/api/v1/application-resolve',
      headers: { authorization },
      payload: {
        job: {
          id: 'job-1',
          externalId: '1',
          source: 'CAREERLIFT',
          company: 'Example',
          title: 'Engineer',
          requirements: ['Resume required'],
          application: { email: 'careers@example.com' },
        },
      },
    });
    expect(response.statusCode).toBe(200);
    expect(response.json()).toMatchObject({
      jobId: 'job-1',
      applicationType: 'EMAIL',
      executor: 'EMAIL',
      requiresHumanReview: false,
    });
    expect(response.json()).not.toHaveProperty('reasoning');
    expect(response.json()).not.toHaveProperty('destination.target');
    await app.close();
  });
  it('rejects malformed jobs', async () => {
    const app = createApp({ authSecret: resolutionSecret });
    const response = await app.inject({
      method: 'POST',
      url: '/api/v1/application-resolve',
      headers: { authorization },
      payload: { job: { title: 'Incomplete' } },
    });
    expect(response.statusCode).toBe(400);
    expect(response.json()).toMatchObject({ error: 'INVALID_JOB' });
    await app.close();
  });
  it('returns a public resolution summary without query secrets or internal reasoning', async () => {
    const app = createApp({ authSecret: resolutionSecret });
    try {
      const response = await app.inject({
        method: 'POST',
        url: '/api/v1/application-resolve',
        headers: { authorization },
        payload: {
          job: {
            id: 'query-job',
            externalId: 'query-job',
            source: 'CAREERLIFT',
            company: 'Example',
            title: 'Engineer',
            requirements: [],
            application: {
              url: 'https://example.com/apply?session_token=private-sentinel#secret',
            },
          },
        },
      });
      expect(response.statusCode).toBe(200);
      expect(response.json().destination.url).toBe('https://example.com/apply');
      expect(response.body).not.toContain('private-sentinel');
      expect(response.json()).not.toHaveProperty('reasoning');
      expect(response.json()).not.toHaveProperty('actions');
    } finally {
      await app.close();
    }
  });
  it('rejects unsafe application destinations', async () => {
    const app = createApp({ authSecret: resolutionSecret });
    const response = await app.inject({
      method: 'POST',
      url: '/api/v1/application-resolve',
      headers: { authorization },
      payload: {
        job: {
          id: 'bad-url',
          externalId: 'bad-url',
          source: 'CAREERLIFT',
          company: 'Example',
          title: 'Engineer',
          requirements: [],
          application: { url: 'javascript:alert(1)' },
        },
      },
    });
    expect(response.statusCode).toBe(400);
    await app.close();
  });
});

describe('inspection API', () => {
  const secret = 'unit-test-secret';
  const token = (sub: string) => {
    const header = Buffer.from(
      JSON.stringify({ alg: 'HS256', typ: 'JWT' }),
    ).toString('base64url');
    const body = Buffer.from(
      JSON.stringify({ sub, exp: Math.floor(Date.now() / 1000) + 3600 }),
    ).toString('base64url');
    const signature = createHmac('sha256', secret)
      .update(`${header}.${body}`)
      .digest('base64url');
    return `Bearer ${header}.${body}.${signature}`;
  };
  it('queues inspection for a persisted plan and returns its status', async () => {
    const added: { name: string; data: unknown }[] = [];
    let created = false;
    const db = {
      application: {
        findFirst: async () => ({
          id: 'app-1',
          userId: 'user-1',
          jobId: 'job-1',
          state: 'RESOLVED',
          plan: {
            id: 'plan-1',
            applicationType: 'DIRECT_PORTAL',
            provider: null,
            destination: { url: 'https://example.com/apply' },
            requirements: [],
            actions: [],
            executor: 'BROWSER',
            confidence: 0.8,
            requiresHumanReview: false,
            reasoning: ['test'],
            resolvedBy: 'deterministic',
          },
          inspection: created
            ? {
                id: 'inspection-1',
                state: 'PENDING',
                errorCode: null,
                result: null,
              }
            : null,
        }),
      },
      applicationInspection: {
        upsert: async () => {
          created = true;
          return { id: 'inspection-1', state: 'PENDING' };
        },
        findUnique: async () => ({
          id: 'inspection-1',
          state: 'PENDING',
          errorCode: null,
          result: null,
        }),
      },
    } as unknown as PrismaClient;
    const queue = {
      add: async (name: string, data: unknown) => {
        added.push({ name, data });
      },
    } as unknown as Queue;
    const app = createApp({
      db,
      queue,
      authSecret: secret,
      policy: {
        validateNavigation: () => {},
        validateRequest: () => {},
        validateAddress: async () => {},
        validateConnectedAddress: () => {},
      },
    });
    try {
      const response = await app.inject({
        method: 'POST',
        url: '/api/v1/applications/app-1/inspect',
        headers: { authorization: token('user-1') },
      });
      expect(response.statusCode).toBe(202);
      expect(response.json()).toEqual({
        inspectionId: 'inspection-1',
        status: 'PENDING',
      });
      expect(added).toMatchObject([
        { name: 'INSPECT_APPLICATION', data: { applicationId: 'app-1' } },
      ]);
      const status = await app.inject({
        method: 'GET',
        url: '/api/v1/applications/app-1/inspection',
        headers: { authorization: token('user-1') },
      });
      expect(status.json()).toMatchObject({ status: 'PENDING', schema: null });
    } finally {
      await app.close();
    }
  });
  it('requires a verified caller and checks ownership for both routes', async () => {
    const db = {
      application: {
        findFirst: async ({ where }: { where: { userId: string } }) =>
          where.userId === 'owner'
            ? { id: 'app-1', plan: null, inspection: null }
            : null,
      },
    } as unknown as PrismaClient;
    const app = createApp({
      db,
      queue: { add: async () => {} } as unknown as Queue,
      authSecret: secret,
    });
    try {
      for (const method of ['POST', 'GET'] as const) {
        const url = `/api/v1/applications/app-1/${method === 'POST' ? 'inspect' : 'inspection'}`;
        expect((await app.inject({ method, url })).statusCode).toBe(401);
        expect(
          (
            await app.inject({
              method,
              url,
              headers: { authorization: token('stranger') },
            })
          ).statusCode,
        ).toBe(404);
      }
    } finally {
      await app.close();
    }
  });
  it('rejects an ineligible plan before creating or enqueueing an inspection', async () => {
    let enqueued = 0;
    const db = {
      application: {
        findFirst: async () => ({
          id: 'app-1',
          jobId: 'job-1',
          state: 'RESOLVED',
          plan: {
            id: 'plan-1',
            applicationType: 'EMAIL',
            destination: { email: 'jobs@example.com' },
            requirements: [],
            actions: [],
            executor: 'EMAIL',
            confidence: 0.8,
            requiresHumanReview: false,
            reasoning: ['test'],
            resolvedBy: 'deterministic',
          },
          inspection: null,
        }),
      },
      applicationInspection: {
        upsert: async () => {
          throw new Error('must not create inspection');
        },
      },
    } as unknown as PrismaClient;
    const app = createApp({
      db,
      queue: {
        add: async () => {
          enqueued++;
        },
      } as unknown as Queue,
      authSecret: secret,
    });
    try {
      const response = await app.inject({
        method: 'POST',
        url: '/api/v1/applications/app-1/inspect',
        headers: { authorization: token('user-1') },
      });
      expect(response.statusCode).toBe(409);
      expect(enqueued).toBe(0);
    } finally {
      await app.close();
    }
  });
  it('marks a failed enqueue recoverably instead of leaving PENDING', async () => {
    const updates: unknown[] = [];
    const db = {
      application: {
        findFirst: async () => ({
          id: 'app-1',
          jobId: 'job-1',
          state: 'RESOLVED',
          plan: {
            id: 'plan-1',
            applicationType: 'DIRECT_PORTAL',
            provider: null,
            destination: { url: 'https://example.com/apply' },
            requirements: [],
            actions: [],
            executor: 'BROWSER',
            confidence: 0.8,
            requiresHumanReview: false,
            reasoning: ['test'],
            resolvedBy: 'deterministic',
          },
          inspection: null,
        }),
      },
      applicationInspection: {
        upsert: async () => ({ id: 'inspection-1', state: 'PENDING' }),
        updateMany: async (args: unknown) => {
          updates.push(args);
          return { count: 1 };
        },
      },
    } as unknown as PrismaClient;
    const app = createApp({
      db,
      authSecret: secret,
      policy: {
        validateNavigation: () => {},
        validateRequest: () => {},
        validateAddress: async () => {},
        validateConnectedAddress: () => {},
      },
      queue: {
        add: async () => {
          throw new Error('redis unavailable');
        },
      } as unknown as Queue,
    });
    try {
      const response = await app.inject({
        method: 'POST',
        url: '/api/v1/applications/app-1/inspect',
        headers: { authorization: token('user-1') },
      });
      expect(response.statusCode).toBe(503);
      expect(updates).toMatchObject([
        {
          where: { id: 'inspection-1', state: 'PENDING' },
          data: { state: 'FAILED', errorCode: 'QUEUE_UNAVAILABLE' },
        },
      ]);
    } finally {
      await app.close();
    }
  });
});
