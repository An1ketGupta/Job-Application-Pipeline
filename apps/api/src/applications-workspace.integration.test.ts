import { randomUUID } from 'node:crypto';
import { spawn } from 'node:child_process';
import { resolve } from 'node:path';
import { mkdir } from 'node:fs/promises';
import { beforeAll, afterAll, describe, expect, it } from 'vitest';
import { chromium } from 'playwright';
import { Queue, Worker } from 'bullmq';
import { PrismaClient } from '@careerlift/database';
import {
  ApplicationDetailsSchema,
  ApplicationsResponseSchema,
  type ApplicationExecutor,
} from '@careerlift/domain';
import {
  BrowserApplicationExecutor,
  LocalFixtureSubmissionVerifier,
} from '@careerlift/browser';
import { createApp } from './app.js';
import { createToken } from './auth.js';
import { createRedisConnection } from '../../worker/src/queue.js';
import { createResolutionProcessor } from '../../worker/src/processor.js';
import { createExecutionProcessor } from '../../worker/src/execution-processor.js';
import { createVerificationProcessor } from '../../worker/src/verification-processor.js';
import {
  executionFixture,
  remapApplication,
} from '../../../tests/support/execution-fixture.js';
import { fixtureVerificationContext } from '../../../tests/support/verification-fixture.js';

const databaseUrl = process.env.INTEGRATION_DATABASE_URL;
const redisUrl = process.env.INTEGRATION_REDIS_URL;
if (databaseUrl && !/\/careerlift_test(?:\?|$)/.test(databaseUrl))
  throw new Error('Workspace tests require careerlift_test');
const suite = databaseUrl && redisUrl ? describe : describe.skip;
const secret = 'phase7-isolated-tests';
const headers = (userId: string) => ({
  authorization: `Bearer ${createToken(userId, secret, 3600)}`,
});
async function eventually<T>(
  read: () => Promise<T>,
  done: (v: T) => boolean,
  timeout = 20000,
) {
  const end = Date.now() + timeout;
  while (Date.now() < end) {
    const value = await read();
    if (done(value)) return value;
    await new Promise((r) => setTimeout(r, 50));
  }
  throw new Error('Timed out waiting for recorded state');
}
async function cleanup(db: PrismaClient, userIds: string[], jobIds: string[]) {
  const where = { application: { userId: { in: userIds } } };
  await db.applicationExecution.deleteMany({ where });
  await db.applicationPreparation.deleteMany({ where });
  await db.applicationInspection.deleteMany({ where });
  await db.applicationPlan.deleteMany({ where });
  await db.applicationEvent.deleteMany({ where });
  await db.application.deleteMany({ where: { userId: { in: userIds } } });
  await db.userDocument.deleteMany({ where: { userId: { in: userIds } } });
  await db.user.deleteMany({ where: { id: { in: userIds } } });
  await db.job.deleteMany({ where: { id: { in: jobIds } } });
}
suite('Phase 7 PostgreSQL workspace API', () => {
  const db = new PrismaClient({ datasourceUrl: databaseUrl! });
  const app = createApp({ db, authSecret: secret });
  const suffix = randomUUID();
  const owner = `phase7-owner-${suffix}`,
    stranger = `phase7-other-${suffix}`,
    jobId = `phase7-job-${suffix}`;
  let firstId: string;
  beforeAll(async () => {
    await db.user.createMany({
      data: [
        { id: owner, email: owner + '@example.com' },
        { id: stranger, email: stranger + '@example.com' },
      ],
    });
    await db.job.create({
      data: {
        id: jobId,
        externalId: suffix,
        source: 'LOCAL_TEST',
        company: 'Acme Workspace',
        title: 'Backend Engineer',
        location: 'Remote Bangalore',
        requirements: [],
      },
    });
    for (let i = 0; i < 13; i++) {
      const at = new Date(Date.UTC(2026, 9, 7, 0, i));
      const row = await db.application.create({
        data: {
          userId: owner,
          jobId,
          state: i === 0 ? 'HUMAN_REQUIRED' : i === 1 ? 'FAILED' : 'RESOLVED',
          createdAt: at,
          updatedAt: new Date(at.getTime() + (13 - i) * 120000),
        },
      });
      if (i === 0) firstId = row.id;
    }
    await db.application.create({
      data: { userId: stranger, jobId, state: 'SUBMITTED' },
    });
  });
  afterAll(async () => {
    await app.close();
    await cleanup(db, [owner, stranger], [jobId]);
    await db.$disconnect();
  });
  it('lists only authenticated owner records with SQL pagination and stable sorting', async () => {
    expect((await app.inject({ url: '/api/v1/applications' })).statusCode).toBe(
      401,
    );
    for (const [sort, expected] of [
      ['oldest', 'HUMAN_REQUIRED'],
      ['newest', 'RESOLVED'],
      ['updated', 'HUMAN_REQUIRED'],
    ] as const) {
      const r = await app.inject({
        url: `/api/v1/applications?limit=5&sort=${sort}`,
        headers: headers(owner),
      });
      expect(r.statusCode, r.body).toBe(200);
      const data = ApplicationsResponseSchema.parse(r.json());
      expect(data.pagination).toEqual({
        page: 1,
        limit: 5,
        total: 13,
        totalPages: 3,
      });
      expect(data.applications).toHaveLength(5);
      expect(data.applications[0]?.state).toBe(expected);
      const second = ApplicationsResponseSchema.parse(
        (
          await app.inject({
            url: `/api/v1/applications?limit=5&page=2&sort=${sort}`,
            headers: headers(owner),
          })
        ).json(),
      );
      expect(
        second.applications.every(
          (a) => !data.applications.some((b) => a.id === b.id),
        ),
      ).toBe(true);
    }
    expect(
      (
        await app.inject({
          url: '/api/v1/applications?limit=51',
          headers: headers(owner),
        })
      ).statusCode,
    ).toBe(400);
  });
  it('composes title/company/location search, actual state and human-review filters', async () => {
    for (const search of ['backend', 'ACME workspace', 'bangalore']) {
      const r = await app.inject({
        url: `/api/v1/applications?search=${encodeURIComponent(search)}&status=HUMAN_REQUIRED&review=true`,
        headers: headers(owner),
      });
      expect(r.statusCode, r.body).toBe(200);
      expect(r.json().applications.map((a: { id: string }) => a.id)).toEqual([
        firstId,
      ]);
    }
    expect(
      (
        await app.inject({
          url: '/api/v1/applications?search=no-such-company',
          headers: headers(owner),
        })
      ).json().pagination.total,
    ).toBe(0);
    expect(
      (
        await app.inject({
          url: '/api/v1/applications?verification=CONFIRMED',
          headers: headers(owner),
        })
      ).json().pagination.total,
    ).toBe(0);
  });
  it('authorizes detail, embedded timeline and verification summary without existence leaks', async () => {
    const own = await app.inject({
      url: `/api/v1/applications/${firstId}`,
      headers: headers(owner),
    });
    expect(own.statusCode, own.body).toBe(200);
    const detail = ApplicationDetailsSchema.parse(own.json().application);
    expect(detail.humanReviewRequired).toBe(true);
    expect(detail.timeline[0]?.label).toBe('Application created');
    const denied = await app.inject({
      url: `/api/v1/applications/${firstId}`,
      headers: headers(stranger),
    });
    const missing = await app.inject({
      url: '/api/v1/applications/missing',
      headers: headers(stranger),
    });
    expect(denied.statusCode).toBe(404);
    expect(denied.body).toBe(missing.body);
    expect(own.body).not.toContain('userId');
    expect(own.body).not.toContain(owner);
  });
});

suite('Phase 7 real worker and browser workspace', () => {
  it('follows Job → Apply → list/detail → PREPARING → RUNNING → VERIFYING → CONFIRMED, then review and ownership', async () => {
    const fixture = await executionFixture();
    const db = new PrismaClient({ datasourceUrl: databaseUrl! });
    const suffix = randomUUID(),
      owner = `workspace-live-${suffix}`,
      other = `workspace-other-${suffix}`,
      jobId = `workspace:live:${suffix}`;
    const producer = createRedisConnection(redisUrl!),
      consumer = createRedisConnection(redisUrl!);
    const queue = new Queue(`phase7-${suffix}`, { connection: producer });
    let releasePreparing!: () => void,
      releaseRunning!: () => void,
      releaseVerifying!: () => void;
    const preparingGate = new Promise<void>((r) => (releasePreparing = r)),
      runningGate = new Promise<void>((r) => (releaseRunning = r)),
      verifyingGate = new Promise<void>((r) => (releaseVerifying = r));
    const baseExecutor = new BrowserApplicationExecutor({
      documents: fixture.storage,
      fixtureOrigin: fixture.origin,
      receiptTimeoutMs: 300,
    });
    let bound = false,
      runningHeld = false;
    const executor: ApplicationExecutor = {
      canHandle: (p) => baseExecutor.canHandle(p),
      execute: async (input, observer) => {
        await preparingGate;
        return baseExecutor.execute(input, {
          ...(observer?.authorizeDispatch
            ? { authorizeDispatch: () => observer.authorizeDispatch!() }
            : {}),
          persist: async (progress) => {
            await observer?.persist(progress);
            if (progress.status === 'RUNNING' && !runningHeld) {
              runningHeld = true;
              await runningGate;
            }
            if (
              !bound &&
              progress.mutations?.some(
                (m) =>
                  m.action === 'FINAL_SUBMIT' && m.outcome === 'DISPATCHING',
              )
            ) {
              bound = true;
              fixture.bindStatusIdentity(
                fixtureVerificationContext(input, progress),
              );
            }
          },
        });
      },
    };
    const baseVerifier = new LocalFixtureSubmissionVerifier(
      fixture.origin,
      fixture.sessions,
    );
    const execute = createExecutionProcessor(db, executor);
    const verify = createVerificationProcessor(
      db,
      [
        {
          supports: (c) => baseVerifier.supports(c),
          verify: async (c, s) => {
            await verifyingGate;
            return baseVerifier.verify(c, s);
          },
        },
      ],
      15000,
    );
    const resolveApplication = createResolutionProcessor(db, {
      resolve: (job) => ({ ...fixture.input.plan, jobId: job.id }),
    });
    const worker = new Worker(
      queue.name,
      (job) =>
        job.name === 'RESOLVE_APPLICATION'
          ? resolveApplication(job)
          : job.name === 'EXECUTE_APPLICATION'
            ? execute(job)
            : verify(job),
      { connection: consumer },
    );
    const app = createApp({
      db,
      queue,
      authSecret: secret,
      executionFixtureOrigin: fixture.origin,
    });
    let web: ReturnType<typeof spawn> | undefined;
    let browser: Awaited<ReturnType<typeof chromium.launch>> | undefined;
    let webLogs = '';
    try {
      await worker.waitUntilReady();
      await db.user.createMany({
        data: [
          { id: owner, email: owner + '@example.com' },
          { id: other, email: other + '@example.com' },
        ],
      });
      await db.userDocument.create({
        data: { ...fixture.document, userId: owner, id: `document-${suffix}` },
      });
      await db.job.create({
        data: {
          id: jobId,
          externalId: suffix,
          source: 'LOCAL_TEST',
          company: 'Workspace Live Company',
          title: 'Workspace Live Engineer',
          location: 'Remote',
          requirements: [],
        },
      });
      const apiOrigin = await app.listen({ host: '127.0.0.1', port: 0 });
      // Dedicated Next output and ports leave the user's running local server alone.
      web = spawn(
        process.execPath,
        [
          resolve('apps/web/node_modules/next/dist/bin/next'),
          'dev',
          '--hostname',
          '127.0.0.1',
          '--port',
          '4147',
        ],
        {
          cwd: resolve('apps/web'),
          env: {
            ...process.env,
            NEXT_PUBLIC_API_URL: apiOrigin,
            CAREERLIFT_WEB_DIST_DIR: '.next/phase7-e2e',
            NEXT_TELEMETRY_DISABLED: '1',
          },
          windowsHide: true,
          stdio: ['ignore', 'pipe', 'pipe'],
        },
      );
      web.stdout?.on('data', (d) => {
        webLogs = (webLogs + String(d)).slice(-8000);
      });
      web.stderr?.on('data', (d) => {
        webLogs = (webLogs + String(d)).slice(-8000);
      });
      await eventually(
        async () => {
          try {
            return (await fetch('http://127.0.0.1:4147/applications')).ok;
          } catch {
            return false;
          }
        },
        (v) => v,
        60000,
      ).catch(() => {
        throw new Error(webLogs);
      });
      browser = await chromium.launch({ headless: true });
      const context = await browser.newContext();
      const auth = {
        token: createToken(owner, secret, 3600),
        user: { id: owner, email: owner + '@example.com' },
      };
      await context.addInitScript((data) => {
        localStorage.setItem('careerlift_auth_token', data.token);
        localStorage.setItem('careerlift_auth_user', JSON.stringify(data.user));
      }, auth);
      const page = await context.newPage();
      await page.goto('http://127.0.0.1:4147/applications');
      await page
        .getByRole('heading', { name: 'No applications yet' })
        .waitFor();
      await page.getByRole('link', { name: 'Browse Jobs' }).click();
      await page.goto(
        `http://127.0.0.1:4147/jobs/${encodeURIComponent(jobId)}`,
      );
      await page
        .getByRole('button', { name: 'Apply Now', exact: true })
        .click();
      await page.waitForURL(/\/applications\/[^/?#]+$/);
      const applicationId = decodeURIComponent(
        new URL(page.url()).pathname.split('/').at(-1)!,
      );
      const application = await eventually(
        () =>
          db.application.findUniqueOrThrow({
            where: { id: applicationId },
            include: { plan: true },
          }),
        (a) => !!a.plan,
      );
      expect(application.state).toBe('RESOLVED');
      const inspection = await db.applicationInspection.create({
        data: {
          applicationId,
          applicationPlanId: application.plan!.id,
          state: 'COMPLETED',
          startedAt: new Date(),
          completedAt: new Date(),
        },
      });
      const preparation = await db.applicationPreparation.create({
        data: {
          applicationId,
          inspectionId: inspection.id,
          state: 'COMPLETED',
          startedAt: new Date(),
          completedAt: new Date(),
        },
      });
      const input = remapApplication(fixture.input, {
        applicationId,
        jobId,
        planId: application.plan!.id,
        inspectionId: inspection.id,
        preparationId: preparation.id,
        executionId: `execution-${suffix}`,
        preparationUpdatedAt: preparation.updatedAt.toISOString(),
      });
      input.ownerId = owner;
      input.preparedApplication.documents[0]!.documentId = `document-${suffix}`;
      await db.applicationInspection.update({
        where: { id: inspection.id },
        data: { result: input.inspection },
      });
      await db.applicationPreparation.update({
        where: { id: preparation.id },
        data: { result: input.preparedApplication },
      });
      await page.getByRole('link', { name: 'Back to Applications' }).click();
      await page
        .getByRole('link', { name: 'View Application', exact: true })
        .waitFor();
      await page.getByLabel('Search applications').fill('no-matching-company');
      await page
        .getByRole('heading', { name: 'No matching applications' })
        .waitFor();
      await page.getByRole('button', { name: 'Clear search' }).click();
      await page
        .getByRole('link', { name: 'View Application', exact: true })
        .waitFor();
      await page.getByLabel('Search applications').fill('Workspace');
      await page
        .getByLabel('Application state', { exact: true })
        .selectOption('RESOLVED');
      await page.getByLabel('Sort applications').selectOption('oldest');
      await page
        .getByRole('link', { name: 'View Application', exact: true })
        .click();
      await page.getByRole('heading', { name: 'Associated job' }).waitFor();
      await page
        .getByRole('heading', { name: 'Timeline', exact: true })
        .waitFor();
      const start = await app.inject({
        method: 'POST',
        url: `/api/v1/applications/${applicationId}/execute`,
        headers: headers(owner),
        payload: { mode: 'TEST_FIXTURE' },
      });
      expect(start.statusCode, start.body).toBe(202);
      const executionId = start.json().executionId as string;
      await page
        .getByText('Execution: Preparing', { exact: true })
        .waitFor({ timeout: 15000 });
      expect(
        (
          await db.applicationExecution.findUniqueOrThrow({
            where: { id: executionId },
          })
        ).state,
      ).toBe('PREPARING');
      releasePreparing();
      await page
        .getByText('Execution: Running', { exact: true })
        .waitFor({ timeout: 15000 });
      expect(
        (
          await db.applicationExecution.findUniqueOrThrow({
            where: { id: executionId },
          })
        ).state,
      ).toBe('RUNNING');
      releaseRunning();
      await eventually(
        () =>
          db.applicationExecution.findUniqueOrThrow({
            where: { id: executionId },
          }),
        (e) => e.runId === null && !!e.completedAt,
      );
      const check = await app.inject({
        method: 'POST',
        url: `/api/v1/executions/${executionId}/verification/check`,
        headers: headers(owner),
        payload: {},
      });
      expect(check.statusCode, check.body).toBe(202);
      await page
        .getByText('Verifying', { exact: true })
        .first()
        .waitFor({ timeout: 12000 });
      expect(
        (
          await db.submissionVerification.findUniqueOrThrow({
            where: { executionId },
          })
        ).state,
      ).toBe('VERIFYING');
      releaseVerifying();
      await page
        .getByText('Test submission verified', { exact: true })
        .waitFor({ timeout: 15000 });
      expect(
        (
          await db.application.findUniqueOrThrow({
            where: { id: applicationId },
          })
        ).state,
      ).toBe('SUBMITTED');
      expect(
        (
          await db.submissionVerification.findUniqueOrThrow({
            where: { executionId },
          })
        ).state,
      ).toBe('CONFIRMED');
      expect(fixture.submissions).toHaveLength(1);
      const detail = await app.inject({
        url: `/api/v1/applications/${applicationId}`,
        headers: headers(owner),
      });
      const safe = ApplicationDetailsSchema.parse(detail.json().application);
      expect(safe.active).toBe(false);
      expect(safe.execution?.verification?.evidenceCount).toBeGreaterThan(0);
      expect(safe.execution?.verification?.verifiedAt).toBeTruthy();
      for (const field of [
        'storageRef',
        'mutationId',
        'requestFingerprint',
        'runId',
        'generation',
        'context',
        'fingerprint',
        'target',
        'data-receipt',
      ])
        expect(detail.body).not.toContain('"' + field + '"');
      // No terminal polling, followed by a single read-only manual refresh.
      let reads = 0;
      page.on('request', (r) => {
        if (r.url() === `${apiOrigin}/api/v1/applications/${applicationId}`)
          reads++;
      });
      await new Promise((r) => setTimeout(r, 5500));
      expect(reads).toBe(0);
      await page.getByRole('button', { name: 'Refresh', exact: true }).click();
      await eventually(
        async () => reads,
        (r) => r === 1,
      );
      await mkdir('docs/phase-7-evidence', { recursive: true });
      await page.screenshot({
        path: 'docs/phase-7-evidence/detail-desktop.png',
        fullPage: true,
      });
      await page.getByRole('link', { name: 'View Job', exact: true }).click();
      await page
        .getByRole('heading', { name: 'Workspace Live Engineer', exact: true })
        .waitFor();
      await page
        .getByRole('link', { name: 'Applications', exact: true })
        .click();
      await page
        .getByLabel('Verification state', { exact: true })
        .selectOption('CONFIRMED');
      await page
        .getByRole('link', { name: 'View Application', exact: true })
        .waitFor();
      await page.reload();
      await page
        .getByRole('link', { name: 'View Application', exact: true })
        .waitFor();
      await page.screenshot({
        path: 'docs/phase-7-evidence/list-desktop.png',
        fullPage: true,
      });
      // Seed a review application; no fabricated successful execution outcome.
      const review = await db.application.create({
        data: { userId: owner, jobId, state: 'HUMAN_REQUIRED' },
      });
      await page
        .getByRole('button', { name: 'Clear filters', exact: true })
        .click();
      await page.getByLabel('Needs human review').check();
      await page
        .getByRole('link', { name: 'Review Application', exact: true })
        .click();
      await page
        .getByRole('heading', { name: 'Action required: human review' })
        .waitFor();
      await page
        .getByRole('link', { name: 'Open Review', exact: true })
        .click();
      expect(new URL(page.url()).hash).toBe('#review');
      await page.setViewportSize({ width: 390, height: 844 });
      await page.screenshot({
        path: 'docs/phase-7-evidence/review-mobile.png',
        fullPage: true,
      });
      expect(
        await page.evaluate(
          () => document.documentElement.scrollWidth <= window.innerWidth,
        ),
      ).toBe(true);
      const denied = await app.inject({
        url: `/api/v1/applications/${review.id}`,
        headers: headers(other),
      });
      expect(denied.statusCode).toBe(404);
      for (const path of [
        `/api/v1/applications/${applicationId}/execute`,
        `/api/v1/applications/${applicationId}/execution/resume`,
        `/api/v1/applications/${applicationId}/inspect`,
        `/api/v1/applications/${applicationId}/prepare`,
        `/api/v1/executions/${executionId}/verification/check`,
        `/api/v1/executions/${executionId}/verification/confirm`,
        `/api/v1/executions/${executionId}/verification/reject`,
      ]) {
        const r = await app.inject({
          method: 'POST',
          url: path,
          headers: headers(other),
          payload: path.endsWith('/execute')
            ? { mode: 'TEST_FIXTURE' }
            : path.endsWith('/execution/resume')
              ? { executionId }
              : path.endsWith('/confirm')
                ? { confirmed: true }
                : path.endsWith('/reject')
                  ? { rejected: true }
                  : {},
        });
        expect(r.statusCode, `${path}: ${r.body}`).toBe(404);
      }
      const otherContext = await browser.newContext();
      await otherContext.addInitScript(
        (data) => {
          localStorage.setItem('careerlift_auth_token', data.token);
          localStorage.setItem(
            'careerlift_auth_user',
            JSON.stringify(data.user),
          );
        },
        {
          token: createToken(other, secret, 3600),
          user: { id: other, email: other + '@example.com' },
        },
      );
      const otherPage = await otherContext.newPage();
      await otherPage.goto(
        `http://127.0.0.1:4147/applications/${applicationId}`,
      );
      await otherPage.locator('main').getByRole('alert').waitFor();
      expect(await otherPage.locator('main').innerText()).not.toContain(
        'Workspace Live Company',
      );
      await page.goto('http://127.0.0.1:4147/applications');
      await page.route('**/api/v1/applications?**', (route) =>
        route.fulfill({
          status: 503,
          contentType: 'application/json',
          body: JSON.stringify({ error: 'UNAVAILABLE' }),
        }),
      );
      await page.getByRole('button', { name: 'Refresh', exact: true }).click();
      await page.locator('main').getByRole('alert').waitFor();
      await page.unroute('**/api/v1/applications?**');
      await page
        .getByRole('alert')
        .getByRole('button', { name: 'Refresh' })
        .click();
      await page
        .getByRole('link', { name: 'View Application', exact: true })
        .waitFor();
      // Exercise pagination and persistent list controls against actual database rows.
      await db.application.createMany({
        data: Array.from({ length: 12 }, () => ({
          userId: owner,
          jobId,
          state: 'FAILED' as const,
        })),
      });
      await page.getByRole('button', { name: 'Refresh', exact: true }).click();
      await eventually(
        async () =>
          page.getByRole('button', { name: 'Next', exact: true }).isEnabled(),
        (v) => v,
      );
      await page.getByRole('button', { name: 'Next', exact: true }).click();
      await page.waitForURL(/page=2/);
      await eventually(
        async () => page.locator('main article').count(),
        (n) => n === 4,
      );
      await page.getByRole('button', { name: 'Previous', exact: true }).click();
      await page.waitForURL((url) => url.searchParams.get('page') === '1');
      await page.getByLabel('Sort applications').selectOption('oldest');
      await page.waitForURL(/sort=oldest/);
      await page
        .getByLabel('Application state', { exact: true })
        .selectOption('FAILED');
      await page.waitForURL(/status=FAILED/);
      await page.getByLabel('Search applications').fill('Workspace Live');
      await page.waitForURL(/search=Workspace\+Live/);
      await page.reload();
      await eventually(
        async () => page.getByLabel('Search applications').inputValue(),
        (v) => v === 'Workspace Live',
      );
      expect(
        await page
          .getByLabel('Application state', { exact: true })
          .inputValue(),
      ).toBe('FAILED');
      expect(await page.getByLabel('Sort applications').inputValue()).toBe(
        'oldest',
      );
      await context.close();
      await otherContext.close();
    } finally {
      releasePreparing();
      releaseRunning();
      releaseVerifying();
      await browser?.close();
      if (web?.pid) {
        if (process.platform === 'win32') {
          const { spawnSync } = await import('node:child_process');
          spawnSync('taskkill', ['/PID', String(web.pid), '/T', '/F'], {
            windowsHide: true,
          });
        } else web.kill();
      }
      await worker.close();
      await queue.obliterate({ force: true });
      await queue.close();
      await producer.quit();
      await consumer.quit();
      await app.close();
      await cleanup(db, [owner, other], [jobId]);
      await db.$disconnect();
      await fixture.close();
    }
  }, 180000);
});
