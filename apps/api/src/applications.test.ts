import { describe, expect, it, vi } from 'vitest';
import type { PrismaClient } from '@careerlift/database';
import { createApp } from './app.js';
import { createToken } from './auth.js';

const secret = 'workspace-test-secret';
const headers = {
  authorization: `Bearer ${createToken('owner', secret, 3600)}`,
};
const row = {
  id: 'app-1',
  state: 'RESOLVED',
  createdAt: new Date('2026-10-06T10:00:00Z'),
  updatedAt: new Date('2026-10-06T11:00:00Z'),
  job: {
    id: 'job-1',
    title: 'Engineer',
    company: 'Acme',
    location: 'Remote',
    employmentType: null,
    source: 'CAREERLIFT',
  },
  plan: null,
  inspection: null,
  preparation: null,
  executions: [],
  events: [],
};
describe('Application workspace read API', () => {
  it('authenticates all reads, returns unavailable safely, and rejects mutations', async () => {
    const app = createApp({ authSecret: secret });
    try {
      for (const url of [
        '/api/v1/applications',
        '/api/v1/applications/app-1',
      ]) {
        expect((await app.inject({ url })).statusCode).toBe(401);
        expect((await app.inject({ url, headers })).statusCode).toBe(503);
      }
      expect(
        (
          await app.inject({
            method: 'PATCH',
            url: '/api/v1/applications/app-1',
            headers,
            payload: { state: 'SUBMITTED' },
          })
        ).statusCode,
      ).toBe(404);
    } finally {
      await app.close();
    }
  });
  it('validates bounded queries before reading data', async () => {
    const findMany = vi.fn();
    const app = createApp({
      authSecret: secret,
      db: { application: { findMany } } as unknown as PrismaClient,
    });
    try {
      for (const query of [
        'limit=51',
        'page=0',
        'page=1.5',
        'status=CONFIRMED',
        'verification=SUBMITTED',
        'sort=arbitrary',
        'search=' + 'x'.repeat(201),
        'userId=stranger',
      ]) {
        expect(
          (await app.inject({ url: '/api/v1/applications?' + query, headers }))
            .statusCode,
        ).toBe(400);
      }
      expect(findMany).not.toHaveBeenCalled();
    } finally {
      await app.close();
    }
  });
  it('scopes details to the owner and projects a safe bounded timeline', async () => {
    const findFirst = vi.fn(
      async ({ where }: { where: { id: string; userId: string } }) =>
        where.userId === 'owner' && where.id === 'app-1'
          ? {
              ...row,
              userId: 'owner',
              token: 'TOKEN_SENTINEL',
              events: [
                {
                  id: 'event',
                  type: 'APPLICATION_RESOLVED',
                  createdAt: row.updatedAt,
                  message: 'PASSWORD_SENTINEL',
                  requestId: 'COOKIE_SENTINEL',
                },
              ],
            }
          : null,
    );
    const app = createApp({
      authSecret: secret,
      db: { application: { findFirst } } as unknown as PrismaClient,
    });
    try {
      const response = await app.inject({
        url: '/api/v1/applications/app-1',
        headers,
      });
      expect(response.statusCode).toBe(200);
      expect(response.headers['cache-control']).toBe('no-store');
      expect(
        response
          .json()
          .application.timeline.map((e: { label: string }) => e.label),
      ).toEqual(['Application created', 'Application destination resolved']);
      for (const secret of [
        'TOKEN_SENTINEL',
        'PASSWORD_SENTINEL',
        'COOKIE_SENTINEL',
        'userId',
        'requestId',
      ])
        expect(response.body).not.toContain(secret);
      const stranger = {
        authorization: `Bearer ${createToken('stranger', secret, 3600)}`,
      };
      for (const [id, h] of [
        ['app-1', stranger],
        ['missing', headers],
      ] as const) {
        const r = await app.inject({
          url: `/api/v1/applications/${id}`,
          headers: h,
        });
        expect(r.statusCode).toBe(404);
        expect(r.json()).toEqual({ error: 'APPLICATION_NOT_FOUND' });
      }
    } finally {
      await app.close();
    }
  });
  it('hides infrastructure errors and malformed persisted states', async () => {
    for (const record of [null, { ...row, state: 'INVALID_STATE' }]) {
      const app = createApp({
        authSecret: secret,
        db: {
          application: {
            findFirst: async () => {
              if (!record) throw new Error('postgres://secret@internal');
              return record;
            },
          },
        } as unknown as PrismaClient,
      });
      try {
        const r = await app.inject({
          url: '/api/v1/applications/app-1',
          headers,
        });
        expect(r.statusCode).toBe(503);
        expect(r.body).not.toContain('postgres');
        expect(r.body).not.toContain('INVALID_STATE');
      } finally {
        await app.close();
      }
    }
  });
  it('keeps execution and verification separate, excludes raw artifacts, and bounds history', async () => {
    const makeExecution = (
      mode: string,
      state: string,
      verificationState: string,
    ) => ({
      mode,
      state,
      startedAt: row.createdAt,
      completedAt: row.updatedAt,
      updatedAt: row.updatedAt,
      errorCode: 'SECRET_INTERNAL_ERROR',
      result: { cookies: 'COOKIE_SENTINEL' },
      verification: {
        state: verificationState,
        establishedState: null,
        updatedAt: row.updatedAt,
        context: { accessToken: 'TOKEN_SENTINEL' },
        mutationId: 'PRIVATE_MUTATION',
        reason: 'PASSWORD_SENTINEL',
        _count: { evidence: 1, attempts: 2 },
        events: [
          {
            id: 'confirmed',
            type: 'VERIFICATION_CONFIRMED',
            createdAt: row.updatedAt,
          },
        ],
        evidence: [{ data: { rawDOM: 'DOM_SENTINEL' } }],
      },
    });
    const app = createApp({
      authSecret: secret,
      db: {
        application: {
          findFirst: async () => ({
            ...row,
            state: 'EXECUTING',
            executions: [
              makeExecution('DRY_RUN', 'DRY_RUN_COMPLETED', 'NOT_REQUIRED'),
              makeExecution('REAL_EXECUTION', 'SUBMITTED', 'UNKNOWN'),
            ],
            events: Array.from({ length: 101 }, (_, i) => ({
              id: `event-${i}`,
              type: 'APPLICATION_RESOLVED',
              createdAt: row.createdAt,
              message: 'PASSWORD_SENTINEL',
            })),
          }),
        },
      } as unknown as PrismaClient,
    });
    try {
      const response = await app.inject({
        url: '/api/v1/applications/app-1',
        headers,
      });
      expect(response.statusCode, response.body).toBe(200);
      const value = response.json().application;
      expect(value.state).toBe('EXECUTING');
      expect(value.execution.mode).toBe('REAL_EXECUTION');
      expect(value.execution.verification.state).toBe('UNKNOWN');
      expect(value.active).toBe(false);
      expect(value.timelineTruncated).toBe(true);
      expect(value.timeline.length).toBeLessThanOrEqual(250);
      expect(value.execution.verification.evidenceCount).toBe(1);
      for (const text of [
        'COOKIE_SENTINEL',
        'TOKEN_SENTINEL',
        'PRIVATE_MUTATION',
        'PASSWORD_SENTINEL',
        'DOM_SENTINEL',
        'SECRET_INTERNAL_ERROR',
      ])
        expect(response.body).not.toContain(text);
    } finally {
      await app.close();
    }
  });
});
