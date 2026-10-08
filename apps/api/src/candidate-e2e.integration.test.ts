import { randomUUID } from 'node:crypto';
import { spawn } from 'node:child_process';
import { resolve } from 'node:path';
import { mkdir, writeFile } from 'node:fs/promises';
import { describe, expect, it } from 'vitest';
import { chromium } from 'playwright';
import { Queue, Worker } from 'bullmq';
import { PrismaClient } from '@careerlift/database';
import { PreparedApplicationSchema } from '@careerlift/domain';
import {
  CompositeApplicationResolver,
  DeterministicResolver,
} from '@careerlift/application-resolver';
import {
  ApplicationInspector,
  BrowserSessionManager,
  DestinationPolicy,
} from '@careerlift/browser';
import { createApp } from './app.js';
import { createResolutionProcessor } from '../../worker/src/processor.js';
import { createInspectionProcessor } from '../../worker/src/inspection-processor.js';
import { createPreparationProcessor } from '../../worker/src/preparation-processor.js';
import { createRedisConnection } from '../../worker/src/queue.js';
import { executionFixture } from '../../../tests/support/execution-fixture.js';

const databaseUrl = process.env.INTEGRATION_DATABASE_URL,
  redisUrl = process.env.INTEGRATION_REDIS_URL;
if (databaseUrl && !/\/careerlift_test(?:\?|$)/.test(databaseUrl))
  throw new Error('Candidate E2E requires careerlift_test');
const suite = databaseUrl && redisUrl ? describe : describe.skip;
async function eventually<T>(
  read: () => Promise<T>,
  done: (value: T) => boolean,
  timeout = 30000,
) {
  const end = Date.now() + timeout;
  while (Date.now() < end) {
    const value = await read();
    if (done(value)) return value;
    await new Promise((r) => setTimeout(r, 100));
  }
  throw new Error('Timed out waiting for persisted workflow state');
}
suite(
  'Phase 8 real browser, API, PostgreSQL, Redis, inspection, preparation and human review',
  () => {
    it('runs the complete local candidate workflow and resumes preparation without automatically submitting', async () => {
      const suffix = randomUUID(),
        email = `phase8-browser-${suffix}@example.com`,
        externalId = `phase8-browser-${suffix}`,
        jobId = `careerlift:${externalId}`;
      const evidence = resolve('docs/phase-8-evidence');
      await mkdir(evidence, { recursive: true });
      const fixture = await executionFixture();
      fixture.setHtml(
        `<!doctype html><html><head><title>Phase 8 Candidate Application</title></head><body><h1>Candidate application</h1><form id="application-form" action="/submit" method="post"><label for="full">Full Name</label><input id="full" name="full" required><label for="email">Email</label><input id="email" name="email" type="email" required><label for="resume">Resume</label><input id="resume" name="resume" type="file" accept=".pdf" required><label for="react">Years of experience with React?</label><input id="react" name="react" type="number" required><label for="sponsor">Will you require sponsorship?</label><select id="sponsor" name="sponsor" required><option value="">Choose</option><option value="Yes">Yes</option><option value="No">No</option></select><button id="send" type="submit">Submit application</button></form></body></html>`,
      );
      const db = new PrismaClient({ datasourceUrl: databaseUrl! });
      const producer = createRedisConnection(redisUrl!),
        consumer = createRedisConnection(redisUrl!);
      const queueName = `phase8-${suffix}`,
        queue = new Queue(queueName, { connection: producer });
      const resolver = new CompositeApplicationResolver(
          new DeterministicResolver(fixture.origin),
        ),
        policy = new DestinationPolicy(fixture.origin);
      const resolveTask = createResolutionProcessor(db, resolver),
        inspectTask = createInspectionProcessor(
          db,
          new ApplicationInspector(
            new BrowserSessionManager(true, policy, true),
          ),
        ),
        prepareTask = createPreparationProcessor(db);
      const worker = new Worker(
        queueName,
        (task) =>
          task.name === 'INSPECT_APPLICATION'
            ? inspectTask(task)
            : task.name === 'PREPARE_APPLICATION'
              ? prepareTask(task)
              : resolveTask(task),
        { connection: consumer },
      );
      const app = createApp({
        db,
        queue,
        resolver,
        policy,
        authSecret: 'phase8-browser-isolated',
        documentRoot: fixture.directory,
        source: {
          fetchJobs: async () => [
            {
              id: externalId,
              company: 'Phase 8 Local Company',
              role: 'Phase 8 Candidate Engineer',
              location: 'Remote',
              requirements: [],
              application: { type: 'direct', url: `${fixture.origin}/apply` },
            },
          ],
        },
      });
      let web: ReturnType<typeof spawn> | undefined,
        browser: Awaited<ReturnType<typeof chromium.launch>> | undefined,
        ownerId: string | undefined,
        otherId: string | undefined;
      const errors: string[] = [],
        actions: string[] = [];
      let webLogs = '';
      const step = (value: string) => {
        actions.push(value);
      };
      try {
        await worker.waitUntilReady();
        const apiOrigin = await app.listen({ host: '127.0.0.1', port: 0 });
        web = spawn(
          process.execPath,
          [
            resolve('apps/web/node_modules/next/dist/bin/next'),
            'dev',
            '--hostname',
            '127.0.0.1',
            '--port',
            '4148',
          ],
          {
            cwd: resolve('apps/web'),
            env: {
              ...process.env,
              NEXT_PUBLIC_API_URL: apiOrigin,
              CAREERLIFT_WEB_DIST_DIR: '.next/phase8-e2e',
              NEXT_TELEMETRY_DISABLED: '1',
            },
            windowsHide: true,
            stdio: ['ignore', 'pipe', 'pipe'],
          },
        );
        web.stdout?.on('data', (d) => {
          webLogs = (webLogs + String(d)).slice(-12000);
        });
        web.stderr?.on('data', (d) => {
          webLogs = (webLogs + String(d)).slice(-12000);
        });
        await eventually(
          async () => {
            try {
              return (await fetch('http://127.0.0.1:4148/profile')).ok;
            } catch {
              return false;
            }
          },
          (v) => v,
          90000,
        );
        browser = await chromium.launch({ headless: true });
        const context = await browser.newContext({
          viewport: { width: 1280, height: 900 },
        });
        const page = await context.newPage();
        page.on('pageerror', (e) => errors.push(e.message));
        await page.goto('http://127.0.0.1:4148/profile');
        await page
          .getByRole('button', { name: 'Log in', exact: true })
          .waitFor();
        await page.getByRole('button', { name: 'Log in', exact: true }).click();
        await page.getByLabel('User Email', { exact: true }).fill(email);
        await page
          .getByRole('button', { name: 'Log in with email', exact: true })
          .click();
        await page.getByText(email, { exact: true }).waitFor();
        ownerId = (await db.user.findUniqueOrThrow({ where: { email } })).id;
        step('Login through existing local login UI with an isolated user');
        await page
          .getByLabel('Full name', { exact: true })
          .fill('Ada Phase Eight');
        await page.getByLabel('First name', { exact: true }).fill('Ada');
        await page.getByLabel('Last name', { exact: true }).fill('Eight');
        await page
          .getByLabel('Application email', { exact: true })
          .fill('ada.application@example.com');
        await page.getByLabel('Phone', { exact: true }).fill('+919876543210');
        await page
          .getByLabel('Headline', { exact: true })
          .fill('Frontend Engineer');
        await page
          .getByLabel('Professional summary', { exact: true })
          .fill('I build React and TypeScript applications.');
        await page.getByLabel('Years of experience', { exact: true }).fill('2');
        await page
          .getByLabel('Skills (one per line)', { exact: true })
          .fill('React\nTypeScript');
        await page
          .getByLabel('GitHub', { exact: true })
          .fill('https://github.com/ada');
        await page
          .getByRole('button', { name: 'Save profile', exact: true })
          .click();
        await page
          .getByText(
            'Profile saved. Future preparation uses your updated information.',
          )
          .waitFor();
        step(
          'Saved personal, professional, skills, links and application email',
        );
        await page
          .getByRole('button', { name: 'Add experience', exact: true })
          .click();
        await page.getByLabel('Company', { exact: true }).fill('Acme');
        await page
          .getByLabel('Title', { exact: true })
          .fill('Frontend Engineer');
        await page
          .getByLabel('Experience start date', { exact: true })
          .fill('2024-01-01');
        await page
          .getByLabel('Experience description', { exact: true })
          .fill('Built accessible React applications.');
        await page
          .getByLabel('Achievements (one per line)', { exact: true })
          .fill('Shipped customer dashboard');
        await page
          .getByRole('button', { name: 'Save experience', exact: true })
          .click();
        await page
          .getByText('Frontend Engineer · Acme', { exact: true })
          .waitFor();
        await page
          .getByRole('button', { name: 'Edit experience', exact: true })
          .click();
        await page
          .getByLabel('Title', { exact: true })
          .fill('Software Engineer');
        await page
          .getByRole('button', { name: 'Save experience', exact: true })
          .click();
        await page
          .getByText('Software Engineer · Acme', { exact: true })
          .waitFor();
        step(
          'Created and edited professional experience with achievements and dates',
        );
        await page
          .getByRole('button', { name: 'Add education', exact: true })
          .click();
        await page
          .getByLabel('Institution', { exact: true })
          .fill('Example University');
        await page.getByLabel('Degree', { exact: true }).fill('BSc');
        await page
          .getByLabel('Field of study', { exact: true })
          .fill('Computer Science');
        await page
          .getByLabel('Education start date', { exact: true })
          .fill('2020-01-01');
        await page
          .getByLabel('Education end date', { exact: true })
          .fill('2024-01-01');
        await page
          .getByRole('button', { name: 'Save education', exact: true })
          .click();
        await page
          .getByText('BSc · Example University', { exact: true })
          .waitFor();
        await page.screenshot({
          path: joinEvidence(evidence, 'profile-desktop.png'),
          fullPage: true,
        });
        step(
          'Created education; profile persisted in existing ApplicationProfile',
        );
        await page
          .getByRole('navigation', { name: 'Main navigation' })
          .getByRole('link', { name: 'Documents', exact: true })
          .click();
        await page.getByLabel('Document file', { exact: true }).setInputFiles({
          name: 'ada-resume.pdf',
          mimeType: 'application/pdf',
          buffer: Buffer.from('%PDF-1.7\nAda Candidate Resume\n%%EOF'),
        });
        await page
          .getByRole('button', { name: 'Upload document', exact: true })
          .click();
        await page
          .getByRole('heading', { name: 'ada-resume.pdf', exact: true })
          .waitFor();
        await page
          .getByRole('button', { name: 'Use by default', exact: true })
          .click();
        await page
          .getByRole('button', { name: 'Default document', exact: true })
          .waitFor();
        await page.getByRole('button', { name: 'Rename', exact: true }).click();
        await page
          .getByLabel('Document name', { exact: true })
          .fill('ada-default.pdf');
        await page
          .getByRole('button', { name: 'Save name', exact: true })
          .click();
        await page
          .getByRole('heading', { name: 'ada-default.pdf', exact: true })
          .waitFor();
        step(
          'Uploaded, selected a default, and renamed a resume through storage-backed APIs',
        );
        await page.screenshot({
          path: joinEvidence(evidence, 'documents-desktop.png'),
          fullPage: true,
        });
        await page
          .getByRole('link', { name: 'Back to Profile', exact: true })
          .click();
        await page
          .getByRole('navigation', { name: 'Main navigation' })
          .getByRole('link', { name: 'Verified Answers', exact: true })
          .click();
        await page
          .getByLabel('Question', { exact: true })
          .fill('Years of experience with React?');
        await page.getByLabel('Your answer', { exact: true }).fill('2');
        expect(
          await page
            .getByRole('button', {
              name: 'Create verified answer',
              exact: true,
            })
            .isDisabled(),
        ).toBe(true);
        await page
          .getByLabel(
            'I confirm this answer is accurate and authorize its use for this exact question.',
          )
          .check();
        await page
          .getByRole('button', { name: 'Create verified answer', exact: true })
          .click();
        await page
          .getByText('User verified · Active', { exact: true })
          .waitFor();
        step(
          'Explicitly confirmed a recurring technical answer; sponsorship left unanswered',
        );
        await page
          .getByRole('navigation', { name: 'Main navigation' })
          .getByRole('link', { name: 'Jobs', exact: true })
          .click();
        await page
          .getByRole('button', { name: 'Sync Jobs', exact: true })
          .click();
        await page
          .getByRole('link', {
            name: 'Phase 8 Candidate Engineer',
            exact: true,
          })
          .click();
        await page
          .getByRole('button', { name: 'Apply Now', exact: true })
          .click();
        await page.waitForURL(/\/applications\//);
        const applicationId = page.url().split('/').pop()!;
        step(
          'Synced a local CareerLift fixture job, opened it and created an application',
        );
        await eventually(
          () =>
            db.application.findUniqueOrThrow({ where: { id: applicationId } }),
          (a) => a.state === 'RESOLVED',
        );
        await page
          .getByRole('button', { name: 'Refresh', exact: true })
          .click();
        await page
          .getByRole('button', { name: 'Inspect application', exact: true })
          .waitFor();
        await page
          .getByRole('button', { name: 'Inspect application', exact: true })
          .click();
        await eventually(
          () =>
            db.applicationInspection.findUnique({ where: { applicationId } }),
          (i) => i?.state === 'HUMAN_REQUIRED',
        );
        await page
          .getByRole('button', { name: 'Refresh', exact: true })
          .click();
        await page
          .getByRole('button', {
            name: 'Prepare required information',
            exact: true,
          })
          .waitFor();
        await page
          .getByRole('button', {
            name: 'Prepare required information',
            exact: true,
          })
          .click();
        await eventually(
          () =>
            db.applicationPreparation.findUnique({ where: { applicationId } }),
          (p) => p?.state === 'HUMAN_REQUIRED',
        );
        await page
          .getByRole('button', { name: 'Refresh', exact: true })
          .click();
        await page
          .getByRole('heading', { name: 'Action required', exact: true })
          .waitFor();
        await page
          .getByRole('link', {
            name: 'Review required information',
            exact: true,
          })
          .click();
        await page
          .getByRole('heading', {
            name: 'Will you require sponsorship?',
            exact: true,
          })
          .waitFor();
        step(
          'Real read-only browser inspection identified sensitive sponsorship; preparation created durable human review',
        );
        await page.screenshot({
          path: joinEvidence(evidence, 'review-pending-desktop.png'),
          fullPage: true,
        });
        const reviewForm = page.getByRole('region', {
          name: 'Will you require sponsorship?',
          exact: true,
        });
        await reviewForm
          .getByLabel('Your answer', { exact: true })
          .selectOption('No');
        await reviewForm
          .getByLabel('I confirm this decision for this application.')
          .check();
        await reviewForm
          .getByRole('button', { name: 'Save answer and recheck', exact: true })
          .click();
        await eventually(
          () =>
            db.applicationPreparation.findUniqueOrThrow({
              where: { applicationId },
            }),
          (p) => p.state === 'COMPLETED',
        );
        await page
          .getByRole('button', { name: 'Refresh reviews', exact: true })
          .click();
        await page
          .getByText(
            'Required information has been reviewed. The application is available for the next permitted workflow step.',
          )
          .waitFor();
        const prepared = await db.applicationPreparation.findUniqueOrThrow({
          where: { applicationId },
        });
        const result = PreparedApplicationSchema.parse(prepared.result);
        expect(
          result.questions.every((q) => q.source === 'USER_VERIFIED'),
        ).toBe(true);
        expect(result.documents[0]?.documentId).toBeTruthy();
        expect(
          await db.applicationExecution.count({ where: { applicationId } }),
        ).toBe(0);
        expect(fixture.submissions).toHaveLength(0);
        step(
          'Explicit review resolution re-ran the existing BullMQ preparation worker and completed preparation without execution or submission',
        );
        await page
          .getByRole('link', { name: 'Return to application', exact: true })
          .click();
        await page
          .getByText('Human review decision saved', { exact: true })
          .first()
          .waitFor();
        await page
          .getByRole('navigation', { name: 'Main navigation' })
          .getByRole('link', { name: 'Applications', exact: true })
          .click();
        await page
          .getByRole('link', {
            name: 'Phase 8 Candidate Engineer',
            exact: true,
          })
          .waitFor();
        step(
          'Application Detail and Applications workspace reflected resolved review and its audit timeline',
        );
        await page.screenshot({
          path: joinEvidence(evidence, 'applications-completed-desktop.png'),
          fullPage: true,
        });
        await page.setViewportSize({ width: 390, height: 844 });
        await page
          .getByRole('navigation', { name: 'Main navigation' })
          .getByRole('link', { name: 'Profile', exact: true })
          .click();
        await page.getByLabel('Full name', { exact: true }).waitFor();
        await page.screenshot({
          path: joinEvidence(evidence, 'profile-mobile.png'),
          fullPage: true,
        });
        expect(
          await page.evaluate(
            () => document.documentElement.scrollWidth <= window.innerWidth,
          ),
        ).toBe(true);
        step('Verified mobile profile layout without horizontal overflow');
        await page.getByRole('button', { name: 'Switch', exact: true }).click();
        const otherEmail = `phase8-other-browser-${suffix}@example.com`;
        await page.getByLabel('User Email', { exact: true }).fill(otherEmail);
        await page
          .getByRole('button', { name: 'Log in with email', exact: true })
          .click();
        await page.getByText(otherEmail, { exact: true }).waitFor();
        otherId = (
          await db.user.findUniqueOrThrow({ where: { email: otherEmail } })
        ).id;
        await page
          .getByText('No experience added yet.', { exact: true })
          .waitFor();
        expect(
          await page.getByLabel('Full name', { exact: true }).inputValue(),
        ).toBe('');
        await page.goto(`http://127.0.0.1:4148/review/${applicationId}`);
        await page.getByText('No pending reviews', { exact: true }).waitFor();
        const token = await page.evaluate(() =>
          localStorage.getItem('careerlift_auth_token'),
        );
        const denied = await fetch(
          `${apiOrigin}/api/v1/human-review/${applicationId}`,
          { headers: { Authorization: `Bearer ${token}` } },
        );
        expect(denied.status).toBe(404);
        step(
          'Switched accounts and verified profile/review ownership isolation in UI and API',
        );
        expect(errors).toEqual([]);
        await writeFile(
          joinEvidence(evidence, 'local-e2e-flow.txt'),
          actions.join('\n') + '\nNo browser page errors. No submissions.\n',
        );
      } catch (error) {
        await writeFile(
          joinEvidence(evidence, 'local-e2e-failure.txt'),
          [...actions, String(error), webLogs].join('\n'),
        );
        throw error;
      } finally {
        await browser?.close();
        if (web?.pid) {
          if (process.platform === 'win32')
            await new Promise<void>((done) => {
              const kill = spawn(
                'taskkill',
                ['/pid', String(web!.pid), '/T', '/F'],
                { windowsHide: true, stdio: 'ignore' },
              );
              kill.on('exit', () => done());
            });
          else web.kill('SIGTERM');
        }
        await worker.close();
        await queue.obliterate({ force: true });
        await queue.close();
        await producer.quit();
        await consumer.quit();
        await app.close();
        const users = [ownerId, otherId].filter((id): id is string => !!id);
        const where = { application: { userId: { in: users } } };
        await db.applicationExecution.deleteMany({ where });
        await db.applicationPreparation.deleteMany({ where });
        await db.applicationInspection.deleteMany({ where });
        await db.applicationPlan.deleteMany({ where });
        await db.applicationEvent.deleteMany({
          where: {
            OR: [
              { actorId: { in: users } },
              { application: { userId: { in: users } } },
            ],
          },
        });
        await db.application.deleteMany({ where: { userId: { in: users } } });
        await db.userDocument.deleteMany({ where: { userId: { in: users } } });
        await db.verifiedAnswer.deleteMany({
          where: { userId: { in: users } },
        });
        await db.applicationProfile.deleteMany({
          where: { userId: { in: users } },
        });
        await db.user.deleteMany({ where: { id: { in: users } } });
        await db.job.deleteMany({ where: { id: jobId } });
        await db.$disconnect();
        await fixture.close();
      }
    }, 240000);
  },
);
function joinEvidence(folder: string, name: string) {
  return resolve(folder, name);
}
