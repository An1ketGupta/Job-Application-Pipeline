import { randomUUID } from 'node:crypto';
import { spawn } from 'node:child_process';
import { mkdir } from 'node:fs/promises';
import { resolve } from 'node:path';
import { chromium } from 'playwright';
import { afterAll, describe, expect, it, vi } from 'vitest';
import { GoogleFormsBrowser } from '@careerlift/browser';
import { Queue, Worker } from 'bullmq';
import { PrismaClient, Prisma } from '@careerlift/database';
import { createApp } from './app.js';
import { createToken } from './auth.js';
import {
  createGoogleFormProcessor,
  recoverGoogleFormRuns,
} from '../../worker/src/google-form-processor.js';
import { createRedisConnection } from '../../worker/src/queue.js';
import { googleFormsFixture } from '../../../tests/support/google-forms-fixture.js';

const databaseUrl = process.env.INTEGRATION_DATABASE_URL,
  redisUrl = process.env.INTEGRATION_REDIS_URL;
if (databaseUrl && !/\/careerlift_test(?:\?|$)/.test(databaseUrl))
  throw new Error('Google Forms tests require careerlift_test');
const suite = databaseUrl && redisUrl ? describe : describe.skip;
suite(
  'Google Forms API → PostgreSQL → BullMQ → worker → controlled Chromium form',
  () => {
    const db = new PrismaClient({ datasourceUrl: databaseUrl! });
    afterAll(async () => {
      await db.$disconnect();
    });
    it('renders the Apply, per-application review, account setup and confirmation flow on desktop and mobile', async () => {
      const test = await setup({ sections: true, sensitive: true });
      let web: ReturnType<typeof spawn> | undefined;
      let browser: Awaited<ReturnType<typeof chromium.launch>> | undefined;
      try {
        await db.application.delete({ where: { id: test.application.id } });
        const apiOrigin = await test.app.listen({ host: '127.0.0.1', port: 0 });
        web = spawn(
          process.execPath,
          [
            resolve('apps/web/node_modules/next/dist/bin/next'),
            'dev',
            '--hostname',
            '127.0.0.1',
            '--port',
            '4171',
          ],
          {
            cwd: resolve('apps/web'),
            env: {
              ...process.env,
              NEXT_PUBLIC_API_URL: apiOrigin,
              CAREERLIFT_WEB_DIST_DIR: '.next/google-forms-e2e',
              NEXT_TELEMETRY_DISABLED: '1',
            },
            windowsHide: true,
            stdio: ['ignore', 'pipe', 'pipe'],
          },
        );
        let logs = '';
        web.stdout?.on('data', (data) => {
          logs = (logs + String(data)).slice(-4000);
        });
        web.stderr?.on('data', (data) => {
          logs = (logs + String(data)).slice(-4000);
        });
        const deadline = Date.now() + 90000;
        let ready = false;
        while (Date.now() < deadline) {
          ready = await fetch('http://127.0.0.1:4171/')
            .then((response) => response.ok)
            .catch(() => false);
          if (ready) break;
          if (web.exitCode !== null)
            throw new Error(`Google Forms test web server exited: ${logs}`);
          await new Promise((resolve) => setTimeout(resolve, 250));
        }
        expect(ready, logs).toBe(true);
        browser = await chromium.launch({ headless: true });
        const page = await browser.newPage({
          viewport: { width: 1280, height: 900 },
        });
        const errors: string[] = [];
        page.on('pageerror', (error) => errors.push(error.message));
        await page.addInitScript(
          ({ token, user }) => {
            localStorage.setItem('careerlift_auth_token', token);
            localStorage.setItem('careerlift_auth_user', JSON.stringify(user));
          },
          {
            token: createToken(test.owner, test.secret),
            user: { id: test.owner, email: `${test.owner}@example.com` },
          },
        );
        await page.goto(`http://127.0.0.1:4171/jobs/${test.jobId}`);
        const apply = page.getByRole('button', { name: /^Apply/ });
        await apply.waitFor();
        expect(
          await db.googleFormRun.count({ where: { userId: test.owner } }),
        ).toBe(0);
        await apply.click();
        await page.waitForURL('**/applications/*');
        test.application.id = page.url().split('/applications/')[1]!;
        await test.waitFor('REVIEW');
        await page
          .getByRole('button', {
            name: 'Refresh Google Forms status',
            exact: true,
          })
          .click();
        const salary = page.getByLabel('Expected salary *', { exact: true });
        await salary.waitFor();
        expect(await salary.inputValue()).toBe('100000');
        expect(
          await page
            .getByText(
              'Controlled execution requires a configured local fixture.',
              { exact: false },
            )
            .count(),
        ).toBe(0);
        const evidence = resolve('docs/google-forms-evidence');
        await mkdir(evidence, { recursive: true });
        await page.screenshot({
          path: resolve(evidence, 'review-desktop.png'),
          fullPage: true,
        });
        await page.setViewportSize({ width: 390, height: 844 });
        expect(
          await page.evaluate(
            () => document.documentElement.scrollWidth <= window.innerWidth,
          ),
        ).toBe(true);
        await page.screenshot({
          path: resolve(evidence, 'review-mobile.png'),
          fullPage: true,
        });
        await salary.fill('115000');
        await page
          .getByRole('button', { name: 'Confirm answer', exact: true })
          .click();
        await test.waitFor('SUBMITTED');
        await page
          .getByRole('button', {
            name: 'Refresh Google Forms status',
            exact: true,
          })
          .click();
        await page
          .getByText(
            'The controlled test form recorded confirmation. This is not an employer submission.',
            { exact: true },
          )
          .waitFor();
        expect(test.submissions).toHaveLength(1);
        await page.screenshot({
          path: resolve(evidence, 'confirmed-mobile.png'),
          fullPage: true,
        });
        await page.goto('http://127.0.0.1:4171/settings');
        await page
          .getByRole('button', { name: 'Connect Google account', exact: true })
          .waitFor();
        await page
          .getByText('ada@example.com', { exact: false })
          .first()
          .waitFor();
        expect(
          await page.getByText('ada@example.com', { exact: false }).count(),
        ).toBeGreaterThan(0);
        expect(errors).toEqual([]);
      } finally {
        await browser?.close();
        if (web && web.exitCode === null) {
          web.kill();
          await new Promise<void>((resolve) => {
            web!.once('exit', () => resolve());
            const timer = setTimeout(resolve, 5000);
            timer.unref();
          });
        }
        // If Apply failed before navigation, clean up any owned application it created.
        const owned = await db.application.findFirst({
          where: { userId: test.owner, jobId: test.jobId },
        });
        if (owned) test.application.id = owned.id;
        await test.close();
      }
    }, 150000);
    async function setup(
      options: Parameters<typeof googleFormsFixture>[0] & {
        verifiedSalary?: boolean;
        answerConfidence?: number;
      } = {},
    ) {
      const fixture = await googleFormsFixture(options),
        suffix = randomUUID(),
        owner = `google-owner-${suffix}`,
        stranger = `google-other-${suffix}`,
        jobId = `google-job-${suffix}`;
      const producer = createRedisConnection(redisUrl!),
        consumer = createRedisConnection(redisUrl!);
      const queue = new Queue(`google-forms-${suffix}`, {
        connection: producer,
      });
      const processor = createGoogleFormProcessor(db, {
        enabled: true,
        account: 'ada@example.com',
        documents: fixture.storage,
        fixtureOrigin: fixture.origin,
        headless: true,
        ...(options.sensitive
          ? {
              provider: {
                name: 'controlled',
                generateAnswer: async () => {
                  throw new Error('No single answer calls');
                },
                generateAnswers: async (batch) => ({
                  answers: batch.questions.map((question) => ({
                    id: question.id,
                    answer: '100000',
                    confidence: options.answerConfidence ?? 0.74,
                    supportedBySavedInformation: true,
                    conflictingInformation: false,
                    requiresHumanReview: false,
                    evidence: [
                      { evidenceId: 'profile:summary', quote: '100000' },
                    ],
                    explanation: 'Explicit salary preference in saved summary.',
                  })),
                }),
              },
            }
          : {}),
      });
      const worker = new Worker(queue.name, (task) => processor.process(task), {
        connection: consumer,
      });
      worker.on('error', () => {});
      await db.user.createMany({
        data: [
          { id: owner, email: `${owner}@example.com` },
          { id: stranger, email: `${stranger}@example.com` },
        ],
      });
      await db.applicationProfile.create({
        data: {
          userId: owner,
          data: {
            fullName: 'Ada Lovelace',
            email: 'ada@example.com',
            summary: options.sensitive
              ? 'I build TypeScript services. Expected salary: 100000.'
              : 'I build TypeScript services.',
          },
        },
      });
      await db.job.create({
        data: {
          id: jobId,
          source: 'LOCAL_TEST',
          externalId: suffix,
          title: 'Software Engineer',
          company: 'Controlled Employer',
          requirements: [],
          applicationInfo: { type: 'GOOGLE_FORM', url: fixture.url },
        },
      });
      const application = await db.application.create({
        data: { userId: owner, jobId, state: 'RESOLVED' },
      });
      if (options?.upload)
        await db.userDocument.create({
          data: {
            id: fixture.document.id,
            userId: owner,
            type: 'RESUME',
            name: fixture.document.name,
            storageRef: fixture.document.storageRef,
            mimeType: fixture.document.mimeType,
            size: fixture.document.size,
            metadata: fixture.document.metadata as Prisma.InputJsonValue,
            isDefault: true,
          },
        });
      if (options.verifiedSalary)
        await db.verifiedAnswer.create({
          data: {
            userId: owner,
            question: 'Expected salary',
            questionKey: 'expected salary',
            category: 'SALARY',
            value: '100000',
          },
        });
      const secret = `secret-${suffix}`;
      const app = createApp({
        db,
        queue,
        authSecret: secret,
        googleFormsEnabled: true,
        googleFormsAccount: 'ada@example.com',
        googleFormsFixtureOrigin: fixture.origin,
      });
      const call = (
        method: 'GET' | 'POST',
        path: string,
        body?: object,
        actor = owner,
      ) =>
        app.inject({
          method,
          url: `/api/v1${path}`,
          headers: { authorization: `Bearer ${createToken(actor, secret)}` },
          ...(body ? { payload: body } : {}),
        });
      async function waitFor(state: string) {
        const deadline = Date.now() + 35000;
        let current;
        while (Date.now() < deadline) {
          current = await db.googleFormRun.findUnique({
            where: { applicationId: application.id },
          });
          if (current?.state === state) return current;
          if (
            current &&
            ['BLOCKED', 'FAILED', 'UNKNOWN'].includes(current.state) &&
            current.state !== state
          )
            throw new Error(
              `Unexpected ${current.state}: ${current.errorCode}`,
            );
          await new Promise((resolve) => setTimeout(resolve, 100));
        }
        throw new Error(
          `Expected ${state}, got ${current?.state}: ${current?.errorCode}`,
        );
      }
      return {
        ...fixture,
        owner,
        stranger,
        application,
        jobId,
        app,
        secret,
        call,
        queue,
        waitFor,
        loseBrowser: () => processor.close(),
        pauseWorker: () => worker.pause(),
        resumeWorker: () => worker.resume(),
        close: async () => {
          await worker.close();
          await processor.close();
          await app.close();
          await queue.obliterate({ force: true });
          await queue.close();
          await producer.quit();
          await consumer.quit();
          await db.applicationEvent.deleteMany({
            where: {
              OR: [{ applicationId: application.id }, { actorId: owner }],
            },
          });
          await db.applicationPlan.deleteMany({
            where: { applicationId: application.id },
          });
          await db.application.delete({ where: { id: application.id } });
          await db.userDocument.deleteMany({ where: { userId: owner } });
          await db.verifiedAnswer.deleteMany({ where: { userId: owner } });
          await db.applicationProfile.deleteMany({ where: { userId: owner } });
          await db.user.deleteMany({
            where: { id: { in: [owner, stranger] } },
          });
          await db.job.delete({ where: { id: jobId } });
          await fixture.close();
        },
      };
    }
    it('inspects every section, crosses an informational section, pauses on the third page and resumes through final submission', async () => {
      const test = await setup({
        sections: 4,
        emptySection: true,
        collectedEmail: true,
        googleProtocol: true,
        blurValidation: true,
      });
      try {
        await test.call(
          'POST',
          `/applications/${test.application.id}/google-form/start`,
        );
        const paused = await test.waitFor('REVIEW');
        expect(paused.page).toBe(2);
        expect(test.nextRequests).toHaveLength(2);
        expect(test.submissions).toHaveLength(0);
        const snapshot = paused.snapshot as {
          completedPages: { questionCount: number }[];
        };
        expect(
          snapshot.completedPages.map((page) => page.questionCount),
        ).toEqual([2, 0]);
        const response = await test.call(
          'POST',
          `/applications/${test.application.id}/google-form/review`,
          {
            version: paused.version,
            questionId: 'entry.302',
            value: 'Bachelor of Engineering',
            userConfirmed: true,
          },
        );
        expect(response.statusCode).toBe(202);
        const finished = await test.waitFor('SUBMITTED');
        expect(finished.page).toBe(3);
        expect(test.nextRequests).toHaveLength(3);
        expect(test.submissions).toHaveLength(1);
        const payload = new URLSearchParams(test.submissions[0]!.toString());
        expect(payload.get('entry.101')).toBe('Ada Lovelace');
        expect(payload.get('entry.302')).toBe('Bachelor of Engineering');
        expect(payload.get('emailAddress')).toBe('ada@example.com');
        expect(payload.get('pageHistory')).toBe('0,1,2,3');
      } finally {
        await test.close();
      }
    }, 60000);
    it('automatically uses supported sensitive answers at the shared threshold and exact verified answers', async () => {
      for (const options of [
        { answerConfidence: 0.75 },
        { verifiedSalary: true },
      ]) {
        const test = await setup({ sensitive: true, ...options });
        try {
          await test.call(
            'POST',
            `/applications/${test.application.id}/google-form/start`,
          );
          await test.waitFor('SUBMITTED');
          expect(test.submissions).toHaveLength(1);
          expect(test.submissions[0]?.toString()).toContain('100000');
        } finally {
          await test.close();
        }
      }
    }, 60000);
    it('pauses below the confidence threshold, preserves the earlier section, saves the verified answer and resumes', async () => {
      const test = await setup({ sections: true, sensitive: true });
      try {
        expect(
          await db.googleFormRun.count({
            where: { applicationId: test.application.id },
          }),
        ).toBe(0);
        expect(
          (await test.call('POST', `/jobs/${test.jobId}/applications`))
            .statusCode,
        ).toBe(200);
        const run = await test.waitFor('REVIEW');
        expect(run.page).toBe(1);
        expect(test.nextRequests).toHaveLength(1);
        expect(test.submissions).toHaveLength(0);
        const view = (
          await test.call(
            'GET',
            `/applications/${test.application.id}/google-form`,
          )
        ).json();
        expect(view.reviews[0].answer.value).toBe('100000');
        expect(view.reviews[0].answer.review).toContain('below');
        const path = `/applications/${test.application.id}/google-form/review`,
          body = {
            version: run.version,
            questionId: 'entry.303',
            value: '110000',
            userConfirmed: true,
          };
        expect(
          (await test.call('POST', path, body, test.stranger)).statusCode,
        ).toBe(404);
        expect(
          (
            await test.call('POST', path, {
              ...body,
              version: run.version + 100,
            })
          ).statusCode,
        ).toBe(409);
        expect(
          (await test.call('POST', path, { ...body, userConfirmed: false }))
            .statusCode,
        ).toBe(400);
        expect((await test.call('POST', path, body)).statusCode).toBe(202);
        expect(
          await db.verifiedAnswer.findFirst({
            where: { userId: test.owner, category: 'SALARY' },
          }),
        ).toMatchObject({ value: '110000', source: 'USER_VERIFIED' });
        const finished = await test.waitFor('SUBMITTED');
        expect(finished.test).toBe(true);
        expect(test.nextRequests).toHaveLength(1);
        expect(test.submissions).toHaveLength(1);
        expect(test.submissions[0]?.toString()).toContain('110000');
        expect(
          (
            await test.call(
              'POST',
              `/applications/${test.application.id}/google-form/start`,
            )
          ).statusCode,
        ).toBe(409);
        expect(
          (
            await db.application.findUniqueOrThrow({
              where: { id: test.application.id },
            })
          ).state,
        ).not.toBe('SUBMITTED');
        const safe = (
          await test.call('GET', `/applications/${test.application.id}`)
        ).json().application;
        expect(safe.googleForm.state).toBe('SUBMITTED');
        expect(safe.active).toBe(false);
      } finally {
        await test.close();
      }
    }, 60000);
    it('reopens a lost browser after review and restores answers, prior sections and document bytes', async () => {
      for (const sections of [false, true]) {
        const test = await setup({ sections, sensitive: true, upload: true });
        try {
          await test.call(
            'POST',
            `/applications/${test.application.id}/google-form/start`,
          );
          const run = await test.waitFor('REVIEW');
          expect(run.page).toBe(sections ? 1 : 0);
          await test.loseBrowser();
          // A replacement browser may need a security challenge before replay.
          const inspect = GoogleFormsBrowser.prototype.inspect;
          const interruption = sections
            ? vi
                .spyOn(GoogleFormsBrowser.prototype, 'inspect')
                .mockImplementationOnce(async function (
                  this: GoogleFormsBrowser,
                ) {
                  return { ...(await inspect.call(this)), challenge: true };
                })
            : undefined;
          expect(
            (
              await test.call(
                'POST',
                `/applications/${test.application.id}/google-form/review`,
                {
                  version: run.version,
                  questionId: 'entry.303',
                  value: '123456',
                  userConfirmed: true,
                },
              )
            ).statusCode,
          ).toBe(202);
          if (interruption) {
            const paused = await test.waitFor('BROWSER_REQUIRED');
            interruption.mockRestore();
            expect(
              (
                await test.call(
                  'POST',
                  `/applications/${test.application.id}/google-form/resume`,
                  { version: paused.version },
                )
              ).statusCode,
            ).toBe(202);
          }
          await test.waitFor('SUBMITTED');
          expect(test.nextRequests).toHaveLength(sections ? 2 : 0);
          expect(test.submissions).toHaveLength(1);
          const body = test.submissions[0]!.toString();
          expect(body).toContain('Ada Lovelace');
          expect(body).toContain('123456');
          expect(body).toContain('Controlled Google Forms fixture resume');
        } finally {
          await test.close();
        }
      }
    }, 90000);
    it('offers fresh inspection when an older lost browser has no section answer history', async () => {
      const test = await setup({ sections: true, sensitive: true });
      try {
        await test.call(
          'POST',
          `/applications/${test.application.id}/google-form/start`,
        );
        const run = await test.waitFor('REVIEW');
        const snapshot = run.snapshot as Prisma.JsonObject;
        snapshot.completedPages = (
          snapshot.completedPages as Prisma.JsonObject[]
        ).map(({ fingerprint, questionCount, reviewedCount }) => ({
          fingerprint: fingerprint!,
          questionCount: questionCount!,
          reviewedCount: reviewedCount!,
        }));
        await db.googleFormRun.update({
          where: { id: run.id },
          data: { snapshot: snapshot as Prisma.InputJsonValue },
        });
        await test.loseBrowser();
        await test.call(
          'POST',
          `/applications/${test.application.id}/google-form/review`,
          {
            version: run.version,
            questionId: 'entry.303',
            value: '145000',
            userConfirmed: true,
          },
        );
        expect((await test.waitFor('BLOCKED')).errorCode).toBe(
          'GOOGLE_FORMS_REPLAY_UNAVAILABLE',
        );
        expect(test.submissions).toHaveLength(0);
        expect(
          (
            await test.call(
              'POST',
              `/applications/${test.application.id}/google-form/start`,
            )
          ).statusCode,
        ).toBe(202);
        await test.waitFor('SUBMITTED');
        expect(test.submissions).toHaveLength(1);
        expect(test.submissions[0]!.toString()).toContain('145000');
      } finally {
        await test.close();
      }
    }, 45000);
    it('keeps confirmed decisions when restarting a blocked run', async () => {
      const test = await setup({ sensitive: true });
      try {
        await test.call(
          'POST',
          `/applications/${test.application.id}/google-form/start`,
        );
        const run = await test.waitFor('REVIEW');
        await test.pauseWorker();
        await test.call(
          'POST',
          `/applications/${test.application.id}/google-form/review`,
          {
            version: run.version,
            questionId: 'entry.303',
            value: '135790',
            userConfirmed: true,
          },
        );
        await db.googleFormRun.update({
          where: { id: run.id },
          data: { state: 'BLOCKED', errorCode: 'GOOGLE_FORMS_UNEXPECTED_HOST' },
        });
        await test.loseBrowser();
        expect(
          (
            await test.call(
              'POST',
              `/applications/${test.application.id}/google-form/start`,
            )
          ).statusCode,
        ).toBe(202);
        await test.resumeWorker();
        await test.waitFor('SUBMITTED');
        expect(test.submissions).toHaveLength(1);
        expect(test.submissions[0]!.toString()).toContain('135790');
      } finally {
        await test.resumeWorker();
        await test.close();
      }
    }, 45000);
    it('uses the default PDF and binds it to the actual submitted multipart body', async () => {
      const test = await setup({ upload: true });
      try {
        await test.call(
          'POST',
          `/applications/${test.application.id}/google-form/start`,
        );
        await test.waitFor('SUBMITTED');
        expect(test.submissions).toHaveLength(1);
        expect(test.submissions[0]?.toString()).toContain(
          'Controlled Google Forms fixture resume',
        );
      } finally {
        await test.close();
      }
    }, 60000);
    it('confirms a form whose submission timestamp is populated at click time', async () => {
      const test = await setup({
        controls:
          '<input type="hidden" name="submissionTimestamp" value="-1"><script>document.querySelector("form").addEventListener("submit",()=>{document.querySelector("[name=submissionTimestamp]").value=String(Date.now());});</script>',
      });
      try {
        await test.call(
          'POST',
          `/applications/${test.application.id}/google-form/start`,
        );
        const run = await test.waitFor('SUBMITTED');
        expect(run.submitStartedAt).not.toBeNull();
        expect(run.confirmation).toMatchObject({
          dispatchStarted: true,
          transportOutcome: 'FORWARDED',
          confirmed: true,
        });
        expect(test.submissions).toHaveLength(1);
      } finally {
        await test.close();
      }
    }, 45000);
    it('keeps preflight failures restartable without marking submission started', async () => {
      const test = await setup({
        controls:
          '<input type="hidden" name="unsupportedProtocol" value="fixture-value">',
      });
      try {
        await test.call(
          'POST',
          `/applications/${test.application.id}/google-form/start`,
        );
        const run = await test.waitFor('BLOCKED');
        expect(run.errorCode).toBe('GOOGLE_FORMS_UNEXPECTED_FORM_FIELD');
        expect(run.submitStartedAt).toBeNull();
        expect(run.confirmation).toMatchObject({
          dispatchStarted: false,
          errorCode: 'GOOGLE_FORMS_UNEXPECTED_FORM_FIELD',
        });
        expect(test.submissions).toHaveLength(0);
        expect(
          (
            await test.call(
              'POST',
              `/applications/${test.application.id}/google-form/start`,
            )
          ).statusCode,
        ).toBe(202);
        await test.waitFor('BLOCKED');
        expect(test.submissions).toHaveLength(0);
      } finally {
        await test.close();
      }
    }, 45000);
    it('keeps payload rejections before dispatch restartable', async () => {
      const test = await setup({
        controls: `<script>document.querySelector('form').addEventListener('submit',()=>{document.querySelector('[name="entry.101"]').value='Unapproved';});</script>`,
      });
      try {
        await test.call(
          'POST',
          `/applications/${test.application.id}/google-form/start`,
        );
        const run = await test.waitFor('BLOCKED');
        expect(run.errorCode).toBe('GOOGLE_FORMS_SUBMISSION_NOT_DISPATCHED');
        expect(run.submitStartedAt).toBeNull();
        expect(test.submissions).toHaveLength(0);
        expect(
          (
            await test.call(
              'POST',
              `/applications/${test.application.id}/google-form/start`,
            )
          ).statusCode,
        ).toBe(202);
        await test.waitFor('BLOCKED');
        expect(test.submissions).toHaveLength(0);
      } finally {
        await test.close();
      }
    }, 60000);
    it('recovers an expired pre-dispatch submitting worker as restartable', async () => {
      const test = await setup();
      try {
        const run = await db.googleFormRun.create({
          data: {
            applicationId: test.application.id,
            userId: test.owner,
            state: 'SUBMITTING',
            test: true,
            runId: 'lost-worker',
            updatedAt: new Date(Date.now() - 10 * 60 * 1000),
          },
        });
        await recoverGoogleFormRuns(db);
        const recovered = await db.googleFormRun.findUniqueOrThrow({
          where: { id: run.id },
        });
        expect(recovered.state).toBe('BLOCKED');
        expect(recovered.submitStartedAt).toBeNull();
        expect(
          (
            await test.call(
              'POST',
              `/applications/${test.application.id}/google-form/start`,
            )
          ).statusCode,
        ).toBe(202);
        await test.waitFor('SUBMITTED');
        expect(test.submissions).toHaveLength(1);
      } finally {
        await test.close();
      }
    }, 45000);
    it('blocks duplicate submissions and worker redelivery when acceptance is unknown', async () => {
      const test = await setup({ unknown: true });
      try {
        await test.call(
          'POST',
          `/applications/${test.application.id}/google-form/start`,
        );
        const run = await test.waitFor('UNKNOWN');
        expect(run.submitStartedAt).not.toBeNull();
        expect(test.submissions).toHaveLength(1);
        expect(
          (
            await test.call(
              'POST',
              `/applications/${test.application.id}/google-form/start`,
            )
          ).statusCode,
        ).toBe(409);
        await test.queue.add('GOOGLE_FORM_APPLICATION', {
          runId: run.id,
          version: run.version,
        });
        await new Promise((resolve) => setTimeout(resolve, 300));
        expect(test.submissions).toHaveLength(1);
        expect(
          (
            await test.call(
              'GET',
              `/applications/${test.application.id}/google-form`,
              undefined,
              test.stranger,
            )
          ).statusCode,
        ).toBe(404);
      } finally {
        await test.close();
      }
    }, 60000);
    it('refuses stale multi-section preparation when the profile changes during review', async () => {
      const test = await setup({ sections: true, sensitive: true });
      try {
        await test.call(
          'POST',
          `/applications/${test.application.id}/google-form/start`,
        );
        const run = await test.waitFor('REVIEW');
        await db.applicationProfile.update({
          where: { userId: test.owner },
          data: {
            revision: { increment: 1 },
            data: { fullName: 'Updated Candidate', email: 'ada@example.com' },
          },
        });
        await test.call(
          'POST',
          `/applications/${test.application.id}/google-form/review`,
          {
            version: run.version,
            questionId: 'entry.303',
            value: '120000',
            userConfirmed: true,
          },
        );
        expect((await test.waitFor('BLOCKED')).errorCode).toBe(
          'GOOGLE_FORMS_INPUT_CHANGED',
        );
        expect(test.submissions).toHaveLength(0);
        expect(
          (await test.call('GET', '/google-forms/reviews')).json().reviews,
        ).toHaveLength(1);
      } finally {
        await test.close();
      }
    }, 60000);
    it('recovers an expired submitting worker as unknown instead of retrying', async () => {
      const test = await setup();
      try {
        const run = await db.googleFormRun.create({
          data: {
            applicationId: test.application.id,
            userId: test.owner,
            state: 'SUBMITTING',
            submitStartedAt: new Date(),
            runId: 'lost-worker',
            updatedAt: new Date(Date.now() - 10 * 60 * 1000),
          },
        });
        await recoverGoogleFormRuns(db);
        expect(
          (await db.googleFormRun.findUniqueOrThrow({ where: { id: run.id } }))
            .state,
        ).toBe('UNKNOWN');
        expect(
          (
            await test.call(
              'POST',
              `/applications/${test.application.id}/google-form/start`,
            )
          ).statusCode,
        ).toBe(409);
        expect(test.submissions).toHaveLength(0);
      } finally {
        await test.close();
      }
    }, 30000);
  },
);
