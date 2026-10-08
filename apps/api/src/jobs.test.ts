import { describe, expect, it } from 'vitest';
import type { PrismaClient } from '@careerlift/database';
import type { Queue } from 'bullmq';
import { createApp } from './app.js';
import { createToken } from './auth.js';

// Convenience type for mock Prisma query args in test doubles
type W = { where: Record<string, unknown> };
type WCD = {
  where: Record<string, unknown>;
  create: Record<string, unknown>;
  update: Record<string, unknown>;
};
type D = { data: Record<string, unknown> };

describe('Jobs & Application API', () => {
  const secret = 'job-routes-test-secret';
  const token = (sub: string) => `Bearer ${createToken(sub, secret, 3600)}`;

  it('rejects unauthenticated requests to jobs endpoints', async () => {
    const app = createApp({ authSecret: secret });
    try {
      expect(
        (await app.inject({ method: 'POST', url: '/api/v1/jobs/sync' }))
          .statusCode,
      ).toBe(401);
      expect(
        (await app.inject({ method: 'GET', url: '/api/v1/jobs' })).statusCode,
      ).toBe(401);
      expect(
        (await app.inject({ method: 'GET', url: '/api/v1/jobs/job-1' }))
          .statusCode,
      ).toBe(401);
      expect(
        (
          await app.inject({
            method: 'POST',
            url: '/api/v1/jobs/job-1/applications',
          })
        ).statusCode,
      ).toBe(401);
      expect(
        (await app.inject({ method: 'GET', url: '/api/v1/applications/app-1' }))
          .statusCode,
      ).toBe(401);
    } finally {
      await app.close();
    }
  });

  it('syncs jobs from source idempotently', async () => {
    const storedJobs = new Map<string, Record<string, unknown>>();
    const db = {
      job: {
        upsert: async ({ where, create, update }: WCD) => {
          const whereKey = where['source_externalId'] as {
            source: string;
            externalId: string;
          };
          const key = `${whereKey.source}:${whereKey.externalId}`;
          if (storedJobs.has(key)) {
            const current = storedJobs.get(key);
            const updated = { ...current, ...update, updatedAt: new Date() };
            storedJobs.set(key, updated);
            return updated;
          }
          const created = { ...create, updatedAt: new Date() };
          storedJobs.set(key, created);
          return created;
        },
      },
    } as unknown as PrismaClient;

    const mockSource = {
      fetchJobs: async () => [
        {
          id: 'test-1',
          company: 'Test Co',
          role: 'Full Stack Engineer',
          location: 'Remote',
          employmentType: 'Full-time',
          description: 'Great role building web apps.',
          requirements: ['Resume required'],
          application: {
            type: 'ats',
            url: 'https://boards.greenhouse.io/test/jobs/1',
          },
        },
        {
          id: 'test-2',
          company: 'Acme',
          role: 'Product Designer',
          location: 'San Francisco, CA',
          employmentType: 'Contract',
          description: 'Design user journeys.',
          requirements: ['Portfolio optional'],
          application: { type: 'email', email: 'jobs@acme.com' },
        },
        {
          // Malformed job that should be gracefully skipped
          role: 'Missing Company',
        },
      ],
    };

    const app = createApp({
      db,
      authSecret: secret,
      source: mockSource,
    });

    try {
      // First sync
      const res1 = await app.inject({
        method: 'POST',
        url: '/api/v1/jobs/sync',
        headers: { authorization: token('user-1') },
      });
      expect(res1.statusCode).toBe(200);
      const data1 = res1.json() as { synced: number; total: number };
      expect(data1.synced).toBe(2);
      expect(data1.total).toBe(3);
      expect(storedJobs.size).toBe(2);

      // Second sync (idempotency check)
      const res2 = await app.inject({
        method: 'POST',
        url: '/api/v1/jobs/sync',
        headers: { authorization: token('user-1') },
      });
      expect(res2.statusCode).toBe(200);
      const data2 = res2.json() as { synced: number; total: number };
      expect(data2.synced).toBe(2);
      expect(storedJobs.size).toBe(2); // no duplicates created!
    } finally {
      await app.close();
    }
  });

  it('lists jobs with search, filtering, pagination, and caller application status', async () => {
    type JobRow = {
      id: string;
      externalId: string;
      source: string;
      company: string;
      title: string;
      location: string;
      employmentType: string;
      description: string;
      requirements: string[];
      applicationInfo: Record<string, unknown>;
      sourceUrl: null;
      createdAt: Date;
      updatedAt: Date;
    };

    const jobsList: JobRow[] = [
      {
        id: 'careerlift:job-1',
        externalId: 'job-1',
        source: 'CAREERLIFT',
        company: 'Cloud Corp',
        title: 'Backend Engineer',
        location: 'Remote',
        employmentType: 'Full-time',
        description: 'Distributed systems in Go and TypeScript.',
        requirements: ['Resume required'],
        applicationInfo: { provider: 'GREENHOUSE', type: 'EXTERNAL_ATS' },
        sourceUrl: null,
        createdAt: new Date('2026-10-01'),
        updatedAt: new Date('2026-10-01'),
      },
      {
        id: 'careerlift:job-2',
        externalId: 'job-2',
        source: 'CAREERLIFT',
        company: 'Design Co',
        title: 'UI Designer',
        location: 'New York, NY',
        employmentType: 'Contract',
        description: 'Visual interfaces and design systems.',
        requirements: [],
        applicationInfo: { type: 'GOOGLE_FORM' },
        sourceUrl: null,
        createdAt: new Date('2026-10-02'),
        updatedAt: new Date('2026-10-02'),
      },
      {
        id: 'careerlift:job-3',
        externalId: 'job-3',
        source: 'CAREERLIFT',
        company: 'Cloud Corp',
        title: 'Frontend Engineer',
        location: 'Remote',
        employmentType: 'Full-time',
        description: 'React and Tailwind engineering.',
        requirements: ['Resume required'],
        applicationInfo: { provider: 'LEVER', type: 'EXTERNAL_ATS' },
        sourceUrl: null,
        createdAt: new Date('2026-10-03'),
        updatedAt: new Date('2026-10-03'),
      },
    ];

    type AppRow = {
      id: string;
      userId: string;
      jobId: string;
      state: string;
      plan: { requiresHumanReview: boolean };
      preparation?: { state: string };
      updatedAt: Date;
    };

    const applications: AppRow[] = [
      {
        id: 'app-user1-job1',
        userId: 'user-1',
        jobId: 'careerlift:job-1',
        state: 'RESOLVED',
        plan: { requiresHumanReview: false },
        updatedAt: new Date('2026-10-05'),
      },
    ];

    const db = {
      job: {
        findMany: async ({ where }: W) => {
          let list = [...jobsList];
          const loc = where['location'] as { contains?: string } | undefined;
          if (loc?.contains === 'remote') {
            list = list.filter((j) =>
              j.location.toLowerCase().includes('remote'),
            );
          } else if (loc?.contains) {
            list = list.filter((j) =>
              j.location
                .toLowerCase()
                .includes((loc.contains as string).toLowerCase()),
            );
          }
          const andClauses = where['AND'] as
            Array<{ location?: { contains?: string } }> | undefined;
          for (const clause of andClauses ?? []) {
            if (clause.location?.contains) {
              const location = clause.location.contains.toLowerCase();
              list = list.filter((j) =>
                j.location.toLowerCase().includes(location),
              );
            }
          }
          const orClauses = where['OR'] as
            Array<{ title: { contains: string } }> | undefined;
          if (orClauses) {
            const query = orClauses[0]?.title.contains.toLowerCase() ?? '';
            list = list.filter(
              (j) =>
                j.title.toLowerCase().includes(query) ||
                j.company.toLowerCase().includes(query) ||
                j.description.toLowerCase().includes(query),
            );
          }
          return list;
        },
      },
      application: {
        findMany: async ({ where }: W) => {
          const userId = where['userId'] as string;
          const jobIdIn = (where['jobId'] as { in: string[] }).in;
          return applications.filter(
            (a) => a.userId === userId && jobIdIn.includes(a.jobId),
          );
        },
      },
    } as unknown as PrismaClient;

    const app = createApp({
      db,
      authSecret: secret,
    });

    try {
      // 1. General list
      const res1 = await app.inject({
        method: 'GET',
        url: '/api/v1/jobs',
        headers: { authorization: token('user-1') },
      });
      expect(res1.statusCode).toBe(200);
      const data1 = res1.json() as {
        jobs: Array<{
          id: string;
          location: string;
          applicationStatus: unknown;
        }>;
        pagination: { total: number };
      };
      expect(data1.jobs.length).toBe(3);
      expect(data1.pagination.total).toBe(3);
      // Verify job-1 shows caller's application status
      const job1 = data1.jobs.find((j) => j.id === 'careerlift:job-1');
      expect(job1?.applicationStatus).toEqual({
        hasApplication: true,
        applicationId: 'app-user1-job1',
        state: 'RESOLVED',
        requiresHumanReview: false,
        updatedAt: '2026-10-05T00:00:00.000Z',
      });
      // Verify job-2 has no application
      const job2 = data1.jobs.find((j) => j.id === 'careerlift:job-2');
      expect(job2?.applicationStatus).toBeNull();

      // 2. Remote filter
      const resRemote = await app.inject({
        method: 'GET',
        url: '/api/v1/jobs?remote=true',
        headers: { authorization: token('user-1') },
      });
      expect(resRemote.statusCode).toBe(200);
      const dataRemote = resRemote.json() as {
        jobs: Array<{ location: string }>;
      };
      expect(dataRemote.jobs.length).toBe(2);
      expect(dataRemote.jobs.every((j) => j.location.includes('Remote'))).toBe(
        true,
      );

      // 3. Platform filter
      const resPlatform = await app.inject({
        method: 'GET',
        url: '/api/v1/jobs?platform=GREENHOUSE',
        headers: { authorization: token('user-1') },
      });
      expect(resPlatform.statusCode).toBe(200);
      const dataPlatform = resPlatform.json() as {
        jobs: Array<{ id: string }>;
      };
      expect(dataPlatform.jobs.length).toBe(1);
      expect(dataPlatform.jobs[0]?.id).toBe('careerlift:job-1');

      // 4. Status filter: NOT_APPLIED
      const resNotApplied = await app.inject({
        method: 'GET',
        url: '/api/v1/jobs?status=NOT_APPLIED',
        headers: { authorization: token('user-1') },
      });
      expect(resNotApplied.statusCode).toBe(200);
      const dataNotApplied = resNotApplied.json() as {
        jobs: Array<{ id: string }>;
      };
      expect(dataNotApplied.jobs.length).toBe(2);
      expect(dataNotApplied.jobs.map((j) => j.id)).toEqual([
        'careerlift:job-2',
        'careerlift:job-3',
      ]);

      // 5. Status filter: APPLIED
      const resApplied = await app.inject({
        method: 'GET',
        url: '/api/v1/jobs?status=APPLIED',
        headers: { authorization: token('user-1') },
      });
      expect(resApplied.statusCode).toBe(200);
      const dataApplied = resApplied.json() as { jobs: Array<{ id: string }> };
      expect(dataApplied.jobs.length).toBe(1);
      expect(dataApplied.jobs[0]?.id).toBe('careerlift:job-1');

      // 6. Pagination bounded limit
      const resPaged = await app.inject({
        method: 'GET',
        url: '/api/v1/jobs?page=1&limit=2',
        headers: { authorization: token('user-1') },
      });
      expect(resPaged.statusCode).toBe(200);
      const dataPaged = resPaged.json() as {
        jobs: Array<unknown>;
        pagination: { totalPages: number };
      };
      expect(dataPaged.jobs.length).toBe(2);
      expect(dataPaged.pagination.totalPages).toBe(2);

      // Remote and location constraints both apply; neither replaces the other.
      const incompatibleLocation = await app.inject({
        method: 'GET',
        url: '/api/v1/jobs?remote=true&location=New%20York',
        headers: { authorization: token('user-1') },
      });
      expect(incompatibleLocation.json().jobs).toEqual([]);

      // Preparation review is authoritative even while application state is RESOLVED.
      applications[0]!.preparation = { state: 'HUMAN_REQUIRED' };
      const requiresReview = await app.inject({
        method: 'GET',
        url: '/api/v1/jobs?status=HUMAN_REQUIRED',
        headers: { authorization: token('user-1') },
      });
      expect(requiresReview.json().jobs).toHaveLength(1);
      expect(
        requiresReview.json().jobs[0].applicationStatus.requiresHumanReview,
      ).toBe(true);
    } finally {
      await app.close();
    }
  });

  it('returns single job details and 404 for unknown job', async () => {
    const db = {
      job: {
        findUnique: async ({ where }: W) => {
          if (where['id'] === 'careerlift:existing') {
            return {
              id: 'careerlift:existing',
              externalId: 'existing',
              source: 'CAREERLIFT',
              company: 'Target Corp',
              title: 'Staff Engineer',
              location: 'Remote',
              employmentType: 'Full-time',
              description: 'System architect role.',
              requirements: ['Resume required'],
              applicationInfo: { provider: 'GREENHOUSE' },
              sourceUrl: 'https://careers.targetcorp.example',
              createdAt: new Date('2026-10-01'),
              updatedAt: new Date('2026-10-01'),
            };
          }
          return null;
        },
      },
      application: {
        findFirst: async () => null,
      },
    } as unknown as PrismaClient;

    const app = createApp({ db, authSecret: secret });
    try {
      const okRes = await app.inject({
        method: 'GET',
        url: '/api/v1/jobs/careerlift:existing',
        headers: { authorization: token('user-1') },
      });
      expect(okRes.statusCode).toBe(200);
      expect((okRes.json() as { job: { title: string } }).job.title).toBe(
        'Staff Engineer',
      );

      const notFoundRes = await app.inject({
        method: 'GET',
        url: '/api/v1/jobs/nonexistent',
        headers: { authorization: token('user-1') },
      });
      expect(notFoundRes.statusCode).toBe(404);
      expect(notFoundRes.json()).toEqual({ error: 'JOB_NOT_FOUND' });
    } finally {
      await app.close();
    }
  });

  it('starts application and prevents duplicate application creation', async () => {
    type AppRow = {
      id: string;
      userId: string;
      jobId: string;
      state: string;
      plan: null;
      inspection: null;
    };
    const applications = new Map<string, AppRow>();
    const events: Record<string, unknown>[] = [];
    const enqueuedQueueJobs: { name: string; data: Record<string, unknown> }[] =
      [];

    const db = {
      $transaction: async (fn: (tx: unknown) => Promise<unknown>) => fn(db),
      $queryRaw: async () => [],
      job: {
        findUnique: async ({ where }: W) => {
          if (where['id'] === 'job-target') {
            return {
              id: 'job-target',
              externalId: 'target-1',
              source: 'CAREERLIFT',
              company: 'Acme',
              title: 'Software Engineer',
              location: 'Remote',
              employmentType: 'Full-time',
              description: 'Core developer',
              requirements: ['Resume required'],
              applicationInfo: {
                type: 'ats',
                url: 'https://boards.greenhouse.io/acme/1',
              },
              sourceUrl: null,
              createdAt: new Date(),
              updatedAt: new Date(),
            };
          }
          return null;
        },
      },
      user: {
        findUnique: async () => ({ id: 'user-1', email: 'user1@example.com' }),
      },
      application: {
        findFirst: async ({ where }: W) => {
          for (const app of applications.values()) {
            if (
              app.userId === where['userId'] &&
              app.jobId === where['jobId']
            ) {
              return app;
            }
          }
          return null;
        },
        create: async ({ data }: D) => {
          const app: AppRow = {
            id: 'app-new-1',
            userId: data['userId'] as string,
            jobId: data['jobId'] as string,
            state: data['state'] as string,
            plan: null,
            inspection: null,
          };
          applications.set(app.id, app);
          return app;
        },
      },
      applicationEvent: {
        create: async ({ data }: D) => {
          events.push(data);
          return data;
        },
      },
    } as unknown as PrismaClient;

    const queue = {
      add: async (name: string, data: Record<string, unknown>) => {
        enqueuedQueueJobs.push({ name, data });
      },
    } as unknown as Queue;

    const app = createApp({
      db,
      queue,
      authSecret: secret,
    });

    try {
      // 1. First apply -> creates application & enqueues resolution
      const firstApply = await app.inject({
        method: 'POST',
        url: '/api/v1/jobs/job-target/applications',
        headers: { authorization: token('user-1') },
      });
      expect(firstApply.statusCode).toBe(201);
      const firstData = firstApply.json() as {
        isExisting: boolean;
        application: { state: string };
      };
      expect(firstData.isExisting).toBe(false);
      expect(firstData.application.state).toBe('DISCOVERED');
      expect(enqueuedQueueJobs.length).toBe(1);
      expect(enqueuedQueueJobs[0]?.name).toBe('RESOLVE_APPLICATION');
      expect(enqueuedQueueJobs[0]?.data.applicationId).toBe('app-new-1');
      expect(events.length).toBe(1);
      expect(events[0]?.type).toBe('JOB_DISCOVERED');

      // 2. Second apply -> returns existing application without creating duplicate
      const secondApply = await app.inject({
        method: 'POST',
        url: '/api/v1/jobs/job-target/applications',
        headers: { authorization: token('user-1') },
      });
      expect(secondApply.statusCode).toBe(200);
      const secondData = secondApply.json() as {
        isExisting: boolean;
        application: { id: string };
      };
      expect(secondData.isExisting).toBe(true);
      expect(secondData.application.id).toBe('app-new-1');
      expect(enqueuedQueueJobs.length).toBe(1); // no extra queue job enqueued!
      expect(applications.size).toBe(1); // strictly one application!
    } finally {
      await app.close();
    }
  });

  it('enforces ownership isolation for application details', async () => {
    const db = {
      application: {
        findFirst: async ({ where }: W) => {
          if (where['id'] === 'app-user-1' && where['userId'] === 'user-1') {
            return {
              id: 'app-user-1',
              userId: 'user-1',
              jobId: 'job-1',
              state: 'RESOLVED',
              createdAt: new Date('2026-10-06T10:00:00Z'),
              updatedAt: new Date('2026-10-06T10:00:00Z'),
              job: {
                id: 'job-1',
                title: 'Engineer',
                company: 'Acme',
                location: null,
                employmentType: null,
                source: 'CAREERLIFT',
              },
              plan: {
                applicationType: 'DIRECT_PORTAL',
                provider: null,
                requiresHumanReview: false,
                createdAt: new Date('2026-10-06T10:00:00Z'),
              },
              inspection: null,
              preparation: null,
              executions: [],
              events: [],
            };
          }
          return null; // stranger rejected
        },
      },
    } as unknown as PrismaClient;

    const app = createApp({ db, authSecret: secret });
    try {
      // Owner can view
      const ownerRes = await app.inject({
        method: 'GET',
        url: '/api/v1/applications/app-user-1',
        headers: { authorization: token('user-1') },
      });
      expect(ownerRes.statusCode).toBe(200);
      expect(
        (ownerRes.json() as { application: { id: string } }).application.id,
      ).toBe('app-user-1');

      // Stranger gets 404
      const strangerRes = await app.inject({
        method: 'GET',
        url: '/api/v1/applications/app-user-1',
        headers: { authorization: token('stranger') },
      });
      expect(strangerRes.statusCode).toBe(404);
      expect(strangerRes.json()).toEqual({ error: 'APPLICATION_NOT_FOUND' });
    } finally {
      await app.close();
    }
  });

  it('provides auth login and session check', async () => {
    type UserRow = { id: string; email: string };
    const users = new Map<string, UserRow>();
    const db = {
      user: {
        findUnique: async ({ where }: W) => {
          if (where['email']) {
            for (const u of users.values()) {
              if (u.email === where['email']) return u;
            }
          }
          if (where['id']) return users.get(where['id'] as string) ?? null;
          return null;
        },
        upsert: async ({
          create: data,
        }: {
          create: Record<string, unknown>;
        }) => {
          const user: UserRow = {
            id: `user-${Date.now()}`,
            email: data['email'] as string,
          };
          users.set(user.id, user);
          return user;
        },
      },
    } as unknown as PrismaClient;

    const app = createApp({ db, authSecret: secret });
    try {
      const loginRes = await app.inject({
        method: 'POST',
        url: '/api/v1/auth/login',
        payload: { email: 'alice@example.com' },
      });
      expect(loginRes.statusCode).toBe(200);
      const { token: userToken, user } = loginRes.json() as {
        token: string;
        user: UserRow;
      };
      expect(user.email).toBe('alice@example.com');
      expect(typeof userToken).toBe('string');

      const meRes = await app.inject({
        method: 'GET',
        url: '/api/v1/auth/me',
        headers: { authorization: `Bearer ${userToken}` },
      });
      expect(meRes.statusCode).toBe(200);
      expect((meRes.json() as { user: UserRow }).user.email).toBe(
        'alice@example.com',
      );
    } finally {
      await app.close();
    }
  });
});
