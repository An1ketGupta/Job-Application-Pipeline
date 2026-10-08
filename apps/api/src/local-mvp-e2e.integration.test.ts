import { randomUUID } from 'node:crypto';
import { spawn } from 'node:child_process';
import { resolve } from 'node:path';
import { mkdir, writeFile } from 'node:fs/promises';
import { describe, expect, it } from 'vitest';
import { chromium } from 'playwright';
import { Queue, Worker } from 'bullmq';
import { PrismaClient } from '@careerlift/database';
import {
  PreparedApplicationSchema,
  type ApplicationExecutor,
  type SupportedAts,
} from '@careerlift/domain';
import {
  ApplicationInspector,
  BrowserSessionManager,
  BrowserApplicationExecutor,
  LocalFixtureSubmissionVerifier,
  DestinationPolicy,
} from '@careerlift/browser';
import { createApp } from './app.js';
import { createToken } from './auth.js';
import { createResolutionProcessor } from '../../worker/src/processor.js';
import { createInspectionProcessor } from '../../worker/src/inspection-processor.js';
import { createPreparationProcessor } from '../../worker/src/preparation-processor.js';
import { createExecutionProcessor } from '../../worker/src/execution-processor.js';
import { createVerificationProcessor } from '../../worker/src/verification-processor.js';
import { createRedisConnection } from '../../worker/src/queue.js';
import { executionFixture } from '../../../tests/support/execution-fixture.js';
import { fixtureVerificationContext } from '../../../tests/support/verification-fixture.js';
import {
  atsFixtureHtml,
  atsSourceUrls,
  LocalAtsFixtureResolver,
} from '../../../tests/support/ats-fixture.js';

const databaseUrl = process.env.INTEGRATION_DATABASE_URL,
  redisUrl = process.env.INTEGRATION_REDIS_URL;
if (databaseUrl && !/\/careerlift_test(?:\?|$)/.test(databaseUrl))
  throw new Error('ATS E2E requires careerlift_test');
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
  throw new Error('Timed out waiting for ATS lifecycle state');
}
suite('Phase 10 controlled ATS browser/API/DB/Redis lifecycle', () => {
  it.each([
    'GREENHOUSE',
    'LEVER',
    'ASHBY',
    'UNKNOWN',
    'CAPTCHA',
    'AUTHENTICATION',
  ] as const)(
    'runs %s through review, execution and independent verification',
    async (scenario) => {
      const platform: SupportedAts = [
        'UNKNOWN',
        'CAPTCHA',
        'AUTHENTICATION',
      ].includes(scenario)
        ? 'ASHBY'
        : (scenario as SupportedAts);
      const suffix = randomUUID(),
        email = `phase10-${platform}-${suffix}@example.com`,
        externalId = `phase10-${platform}-${suffix}`,
        jobId = `careerlift:${externalId}`;
      const title = `Phase 10 ${scenario} Engineer`,
        secret = 'phase10-isolated';
      const fixture = await executionFixture();
      fixture.setHtml(
        await atsFixtureHtml(
          platform,
          scenario === 'CAPTCHA'
            ? 'captcha'
            : scenario === 'AUTHENTICATION'
              ? 'authentication'
              : 'questions',
        ),
      );
      if (scenario === 'UNKNOWN')
        fixture.setStatusHtml('<h1>Application received successfully</h1>');
      const mapping = new Map([
        [`${fixture.origin}/apply`, atsSourceUrls[platform]],
      ]);
      const resolver = new LocalAtsFixtureResolver(mapping);
      const db = new PrismaClient({ datasourceUrl: databaseUrl! });
      const producer = createRedisConnection(redisUrl!),
        consumer = createRedisConnection(redisUrl!);
      const queue = new Queue(`phase10-${suffix}`, { connection: producer });
      const executor = new BrowserApplicationExecutor({
        documents: fixture.storage,
        fixtureOrigin: fixture.origin,
        fixtureTargets: mapping,
      });
      // The private fixture server receives correlation before dispatch and creates
      // acceptance evidence only after an actual guarded POST. It is not an ATS verifier.
      const observedExecutor: ApplicationExecutor = {
        canHandle: (plan) => executor.canHandle(plan),
        execute: (input, observer) =>
          executor.execute(input, {
            ...observer,
            persist: async (result) => {
              await observer?.persist(result);
              if (
                !fixture.submissions.length &&
                result.mutations?.some(
                  (m) =>
                    m.action === 'FINAL_SUBMIT' &&
                    ['AUTHORIZED', 'DISPATCHING'].includes(m.outcome),
                )
              )
                fixture.bindStatusIdentity(
                  fixtureVerificationContext(input, result),
                );
            },
          }),
      };
      const resolution = createResolutionProcessor(db, resolver),
        inspection = createInspectionProcessor(
          db,
          new ApplicationInspector(
            new BrowserSessionManager(true, fixture.policy, true),
            mapping,
          ),
        ),
        preparation = createPreparationProcessor(db),
        execution = createExecutionProcessor(db, observedExecutor),
        verification = createVerificationProcessor(db, [
          new LocalFixtureSubmissionVerifier(fixture.origin, fixture.sessions),
        ]);
      const worker = new Worker(
        queue.name,
        (task) =>
          task.name === 'RESOLVE_APPLICATION'
            ? resolution(task)
            : task.name === 'INSPECT_APPLICATION'
              ? inspection(task)
              : task.name === 'PREPARE_APPLICATION'
                ? preparation(task)
                : task.name === 'EXECUTE_APPLICATION'
                  ? execution(task)
                  : verification(task),
        { connection: consumer },
      );
      const app = createApp({
        db,
        queue,
        resolver,
        // Exact local fixture remains eligible; supported public host resolving
        // to loopback must stop before queueing any browser inspection.
        policy: new DestinationPolicy(fixture.origin, async () => [
          '127.0.0.1',
        ]),
        executionFixtureOrigin: fixture.origin,
        documentRoot: fixture.directory,
        authSecret: secret,
        source: {
          fetchJobs: async () => [
            {
              id: externalId,
              company: `Phase 10 ${platform} Company`,
              role: title,
              requirements: [],
              application: {
                type: 'ats',
                provider: platform.toLowerCase(),
                url: `${fixture.origin}/apply`,
              },
            },
            {
              id: externalId + '-blocked',
              company: 'Blocked Destination',
              role: 'Phase 10 Blocked ATS',
              requirements: [],
              application: {
                type: 'ats',
                provider: 'lever',
                url: atsSourceUrls.LEVER,
              },
            },
            {
              id: externalId + '-unsupported',
              company: 'Unsupported Company',
              role: 'Phase 10 Unsupported Role',
              requirements: [],
              application: {
                type: 'ats',
                provider: 'workday',
                url: 'https://unsupported.example/apply?token=PRIVATE_SENTINEL',
              },
            },
          ],
        },
      });
      let web: ReturnType<typeof spawn> | undefined,
        browser: Awaited<ReturnType<typeof chromium.launch>> | undefined,
        ownerId: string | undefined,
        otherId: string | undefined;
      const evidence = resolve('docs/phase-10-evidence'),
        steps: string[] = [],
        errors: string[] = [];
      let logs = '';
      await mkdir(evidence, { recursive: true });
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
            '4160',
          ],
          {
            cwd: resolve('apps/web'),
            env: {
              ...process.env,
              NEXT_PUBLIC_API_URL: apiOrigin,
              CAREERLIFT_WEB_DIST_DIR: '.next/phase10-e2e',
              NEXT_TELEMETRY_DISABLED: '1',
            },
            windowsHide: true,
            stdio: ['ignore', 'pipe', 'pipe'],
          },
        );
        web.stdout?.on('data', (d) => {
          logs = (logs + String(d)).slice(-12000);
        });
        web.stderr?.on('data', (d) => {
          logs = (logs + String(d)).slice(-12000);
        });
        await eventually(
          async () => {
            try {
              return (await fetch('http://127.0.0.1:4160/profile')).ok;
            } catch {
              return false;
            }
          },
          Boolean,
          90000,
        );
        browser = await chromium.launch({ headless: true });
        const page = await browser.newPage({
          viewport: { width: 1280, height: 900 },
        });
        page.on('pageerror', (e) => errors.push(e.message));
        const consoleErrors: string[] = [];
        page.on('console', (event) => {
          if (
            event.type() === 'error' &&
            !event.text().includes('Failed to load resource')
          )
            consoleErrors.push(event.text());
        });
        await page.goto('http://127.0.0.1:4160/');
        await page
          .getByRole('heading', { name: 'Start with a local account' })
          .waitFor();
        await page.getByRole('button', { name: 'Log in', exact: true }).click();
        expect(await page.getByRole('dialog').isVisible()).toBe(true);
        expect(
          await page
            .getByLabel('User Email', { exact: true })
            .evaluate((node) => node === document.activeElement),
        ).toBe(true);
        await page.getByLabel('User Email', { exact: true }).press('Escape');
        expect(await page.getByRole('dialog').isVisible()).toBe(false);
        await page.getByRole('button', { name: 'Log in', exact: true }).click();
        await page.getByLabel('User Email', { exact: true }).fill(email);
        await page
          .getByRole('button', { name: 'Log in with email', exact: true })
          .click();
        await page.getByText(email, { exact: true }).waitFor();
        ownerId = (await db.user.findUniqueOrThrow({ where: { email } })).id;
        const bearer = await page.evaluate(() =>
          localStorage.getItem('careerlift_auth_token'),
        );
        const headers = { authorization: `Bearer ${bearer}` };
        const command = (url: string, payload?: unknown) =>
          app.inject({
            method: 'POST',
            url,
            headers,
            ...(payload ? { payload } : {}),
          });
        steps.push('Logged in through the existing UI');
        await page
          .getByRole('navigation', { name: 'Main navigation' })
          .getByRole('link', { name: 'Profile', exact: true })
          .click();
        await page.getByLabel('First name', { exact: true }).fill('Ada');
        await page
          .getByLabel('Application email', { exact: true })
          .fill('ada.phase10@example.com');
        await page.getByLabel('Phone', { exact: true }).fill('+919876543210');
        await page
          .getByRole('button', { name: 'Save profile', exact: true })
          .click();
        await page
          .getByText(
            'Profile saved. Future preparation uses your updated information.',
          )
          .waitFor();
        await page
          .getByRole('navigation', { name: 'Main navigation' })
          .getByRole('link', { name: 'Documents', exact: true })
          .click();
        await page.getByLabel('Document file', { exact: true }).setInputFiles({
          name: 'phase10-resume.pdf',
          mimeType: 'application/pdf',
          buffer: fixture.pdf,
        });
        await page
          .getByRole('button', { name: 'Upload document', exact: true })
          .click();
        await page
          .getByRole('heading', { name: 'phase10-resume.pdf', exact: true })
          .waitFor();
        steps.push('Saved profile and uploaded a validated owned resume');
        await page
          .getByRole('navigation', { name: 'Main navigation' })
          .getByRole('link', { name: 'Jobs', exact: true })
          .click();
        await page
          .getByRole('button', { name: 'Sync Jobs', exact: true })
          .click();
        await page.getByLabel('Search Jobs', { exact: true }).fill(title);
        await page
          .getByLabel('Application Platform', { exact: true })
          .selectOption(platform);
        await page.getByRole('link', { name: title, exact: true }).click();
        await page
          .getByRole('button', { name: 'Apply Now', exact: true })
          .waitFor();
        const secondContext = await browser.newContext();
        const secondPage = await secondContext.newPage();
        await secondPage.goto('http://127.0.0.1:4160/');
        await secondPage
          .getByRole('button', { name: 'Log in', exact: true })
          .click();
        await secondPage.getByLabel('User Email', { exact: true }).fill(email);
        await secondPage
          .getByRole('button', { name: 'Log in with email', exact: true })
          .click();
        await secondPage.getByText(email, { exact: true }).waitFor();
        await secondPage.goto(
          `http://127.0.0.1:4160/jobs/${encodeURIComponent(jobId)}`,
        );
        await secondPage
          .getByRole('button', { name: 'Apply Now', exact: true })
          .waitFor();
        const concurrent = await Promise.all([
          secondPage
            .getByRole('button', { name: 'Apply Now', exact: true })
            .click(),
          page.getByRole('button', { name: 'Apply Now', exact: true }).click(),
          ...Array.from({ length: 6 }, () =>
            command(`/api/v1/jobs/${encodeURIComponent(jobId)}/applications`),
          ),
        ]);
        await page.waitForURL(/\/applications\//);
        const applicationId = page.url().split('/').pop()!;
        await secondPage.waitForURL(/\/applications\//);
        expect(secondPage.url().split('/').pop()).toBe(applicationId);
        await secondContext.close();
        const repeatedApply = await command(
          `/api/v1/jobs/${encodeURIComponent(jobId)}/applications`,
        );
        expect(repeatedApply.json().application.id).toBe(applicationId);
        expect(
          concurrent
            .slice(2)
            .every(
              (r) =>
                r && 'statusCode' in r && [200, 201].includes(r.statusCode),
            ),
        ).toBe(true);
        expect(
          await db.application.count({ where: { userId: ownerId, jobId } }),
        ).toBe(1);
        await eventually(
          () =>
            db.application.findUniqueOrThrow({ where: { id: applicationId } }),
          (a) => a.state === 'RESOLVED',
        );
        await page
          .getByRole('button', { name: 'Refresh', exact: true })
          .click();
        await page
          .getByText(
            platform === 'GREENHOUSE'
              ? 'Greenhouse'
              : platform === 'LEVER'
                ? 'Lever'
                : 'Ashby',
            { exact: true },
          )
          .waitFor();
        steps.push(
          `${platform} detected, versioned target persisted, concurrent Apply requests reused one application`,
        );
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
        if (scenario === 'CAPTCHA' || scenario === 'AUTHENTICATION') {
          await page
            .getByRole('link', {
              name: 'Review required information',
              exact: true,
            })
            .click();
          await page
            .getByText(
              scenario === 'CAPTCHA'
                ? 'A CAPTCHA prevents the agent from continuing.'
                : 'The application platform requires authentication or security review.',
              { exact: true },
            )
            .waitFor();
          expect(
            await page
              .getByRole('button', { name: 'Save answer and recheck' })
              .count(),
          ).toBe(0);
          expect(
            (
              await command(`/api/v1/applications/${applicationId}/execute`, {
                mode: 'TEST_FIXTURE',
              })
            ).statusCode,
          ).toBe(409);
          expect(
            (await command(`/api/v1/applications/${applicationId}/prepare`))
              .statusCode,
          ).toBe(409);
          expect(fixture.submissions).toHaveLength(0);
          expect(fixture.nextMutations).toHaveLength(0);
          expect(
            await db.applicationExecution.count({ where: { applicationId } }),
          ).toBe(0);
          await page.setViewportSize({ width: 375, height: 812 });
          expect(
            await page.evaluate(
              () => document.documentElement.scrollWidth <= window.innerWidth,
            ),
          ).toBe(true);
          await page.screenshot({
            path: resolve(evidence, `${scenario.toLowerCase()}-mobile.png`),
            fullPage: true,
          });
          steps.push(
            `${scenario}: Inspection stopped automation; no bypass, execution or submission; mobile review is usable`,
          );
          await writeFile(
            resolve(evidence, `${scenario.toLowerCase()}-flow.txt`),
            steps.join('\n') + '\n',
          );
          expect(errors).toEqual([]);
          return;
        }
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
        expect(
          (
            await command(`/api/v1/applications/${applicationId}/execute`, {
              mode: 'TEST_FIXTURE',
            })
          ).statusCode,
        ).toBe(409);
        expect(fixture.submissions).toHaveLength(0);
        await page
          .getByRole('button', { name: 'Refresh', exact: true })
          .click();
        await page
          .getByRole('link', {
            name: 'Review required information',
            exact: true,
          })
          .click();
        for (const [question, answer] of [
          ['Which office code do you prefer?', 'LON'],
          ['Will you now or in the future require sponsorship?', 'No'],
        ] as const) {
          const region = page.getByRole('region', {
            name: question,
            exact: true,
          });
          const field = region.getByLabel('Your answer', { exact: true });
          if (answer === 'No') await field.selectOption(answer);
          else await field.fill(answer!);
          await region
            .getByLabel('I confirm this decision for this application.')
            .check();
          await region
            .getByRole('button', {
              name: 'Save answer and recheck',
              exact: true,
            })
            .click();
          await eventually(
            () =>
              db.applicationPreparation.findUniqueOrThrow({
                where: { applicationId },
              }),
            (p) =>
              answer === 'No'
                ? p.state === 'COMPLETED'
                : p.state === 'HUMAN_REQUIRED' &&
                  JSON.stringify(p.reviewDecisions).includes('LON'),
          );
          await page
            .getByRole('button', { name: 'Refresh reviews', exact: true })
            .click();
        }
        const prepared = await db.applicationPreparation.findUniqueOrThrow({
          where: { applicationId },
        });
        expect(
          PreparedApplicationSchema.parse(prepared.result).questions.every(
            (q) => q.source === 'USER_VERIFIED',
          ),
        ).toBe(true);
        expect(
          await db.applicationExecution.count({ where: { applicationId } }),
        ).toBe(0);
        steps.push(
          'Custom and sensitive questions required explicit durable review; preparation resumed through the existing worker',
        );
        await page.screenshot({
          path: resolve(evidence, `${scenario.toLowerCase()}-review.png`),
          fullPage: true,
        });
        await page
          .getByRole('link', { name: 'Return to application', exact: true })
          .click();
        await page
          .getByRole('button', { name: 'Refresh', exact: true })
          .click();
        await page
          .getByLabel('I authorize one controlled TEST_FIXTURE submission.', {
            exact: true,
          })
          .check();
        const executeResponse = page.waitForResponse(
          (response) =>
            response.url().endsWith(`/applications/${applicationId}/execute`) &&
            response.request().method() === 'POST',
        );
        await page
          .getByRole('button', { name: 'Execute TEST_FIXTURE', exact: true })
          .click();
        const start = await executeResponse;
        expect(start.status()).toBe(202);
        const executionId = (await start.json()).executionId as string;
        await eventually(
          () =>
            db.applicationExecution.findUniqueOrThrow({
              where: { id: executionId },
            }),
          (e) => e.state === 'SUBMISSION_UNKNOWN' && e.runId === null,
        );
        expect(fixture.submissions).toHaveLength(1);
        expect(fixture.submissions[0]!.toString()).toContain('LON');
        const repeat = await command(
          `/api/v1/applications/${applicationId}/execute`,
          { mode: 'TEST_FIXTURE' },
        );
        expect(repeat.json().executionId).toBe(executionId);
        expect(fixture.submissions).toHaveLength(1);
        await page
          .getByRole('button', { name: 'Refresh', exact: true })
          .click();
        await page
          .getByRole('heading', {
            name: 'Submission outcome unknown',
            exact: true,
          })
          .waitFor();
        expect(
          await page
            .getByRole('button', { name: 'Execute TEST_FIXTURE', exact: true })
            .count(),
        ).toBe(0);
        const checkResponse = page.waitForResponse(
          (response) =>
            response
              .url()
              .endsWith(`/executions/${executionId}/verification/check`) &&
            response.request().method() === 'POST',
        );
        await page
          .getByRole('button', {
            name: 'Check independent verification',
            exact: true,
          })
          .click();
        expect((await checkResponse).status()).toBe(202);
        if (scenario === 'UNKNOWN') {
          await eventually(
            () =>
              db.submissionVerification.findUniqueOrThrow({
                where: { executionId },
              }),
            (v) => v.state === 'HUMAN_REQUIRED',
          );
          const execution = await db.applicationExecution.findUniqueOrThrow({
            where: { id: executionId },
          });
          expect(execution.state).toBe('SUBMISSION_UNKNOWN');
          expect(
            (
              await db.application.findUniqueOrThrow({
                where: { id: applicationId },
              })
            ).state,
          ).toBe('HUMAN_REQUIRED');
          expect(
            (
              await command(`/api/v1/applications/${applicationId}/execute`, {
                mode: 'TEST_FIXTURE',
              })
            ).statusCode,
          ).toBe(409);
          expect(fixture.submissions).toHaveLength(1);
          await page
            .getByRole('button', { name: 'Refresh', exact: true })
            .click();
          await page
            .getByRole('heading', {
              name: 'Submission outcome unknown',
              exact: true,
            })
            .waitFor();
          expect(
            await page
              .getByRole('button', {
                name: /submit again|execute test_fixture/i,
              })
              .count(),
          ).toBe(0);
          await page
            .getByRole('button', {
              name: 'Record acceptance confirmed by me',
              exact: true,
            })
            .waitFor();
          expect(
            await page
              .getByRole('button', {
                name: 'Record acceptance confirmed by me',
                exact: true,
              })
              .isDisabled(),
          ).toBe(true);
          const record = await db.submissionVerification.findUniqueOrThrow({
            where: { executionId },
          });
          expect(
            await db.verificationEvidence.count({
              where: { verificationId: record.id, strength: 'STRONG' },
            }),
          ).toBe(0);
          await page.setViewportSize({ width: 375, height: 812 });
          expect(
            await page.evaluate(
              () => document.documentElement.scrollWidth <= window.innerWidth,
            ),
          ).toBe(true);
          await page.screenshot({
            path: resolve(evidence, 'unknown-mobile.png'),
            fullPage: true,
          });
          steps.push(
            'E: One guarded POST; success-looking text failed independent verification; outcome stayed unknown; no resubmission or enabled decision without explicit confirmation',
          );
          await writeFile(
            resolve(evidence, 'unknown-flow.txt'),
            steps.join('\n') + '\n',
          );
          expect(errors).toEqual([]);
          return;
        }
        await eventually(
          () =>
            db.submissionVerification.findUniqueOrThrow({
              where: { executionId },
            }),
          (v) => v.state === 'CONFIRMED',
        );
        expect(
          (
            await db.application.findUniqueOrThrow({
              where: { id: applicationId },
            })
          ).state,
        ).toBe('SUBMITTED');
        steps.push(
          'Existing executor passed the final barrier and submitted once; independent server receipt verification confirmed acceptance',
        );
        await page
          .getByRole('button', { name: 'Refresh', exact: true })
          .click();
        await page
          .getByText(
            'Acceptance confirmed by the verification service or an explicit human decision.',
          )
          .waitFor();
        await page.screenshot({
          path: resolve(evidence, `${scenario.toLowerCase()}-verified.png`),
          fullPage: true,
        });
        expect(
          (
            await command(`/api/v1/applications/${applicationId}/execute`, {
              mode: 'REAL_EXECUTION',
            })
          ).statusCode,
        ).toBe(409);
        otherId = (
          await db.user.create({
            data: { email: `phase10-other-${suffix}@example.com` },
          })
        ).id;
        const outsider = {
          authorization: `Bearer ${createToken(otherId, secret, 3600)}`,
        };
        for (const url of [
          `/api/v1/applications/${applicationId}`,
          `/api/v1/human-review/${applicationId}`,
          `/api/v1/executions/${executionId}/verification`,
        ])
          expect(
            (await app.inject({ url, headers: outsider })).statusCode,
          ).toBe(404);
        const detail = await app.inject({
          url: `/api/v1/applications/${applicationId}`,
          headers,
        });
        expect(detail.json().application.plan.platform).toBe(platform);
        for (const hidden of [
          'fixtureSourceUrl',
          'hiddenFields',
          'valueDigest',
          'dispatchIdentity',
          'requestFingerprint',
          'storageRef',
          'cookies',
          'adapterVersion',
        ])
          expect(detail.body).not.toContain(hidden);
        const events = await db.applicationEvent.findMany({
          where: { applicationId },
        });
        expect(JSON.stringify(events.map((e) => e.data))).toContain(
          'ATS_DETECTED',
        );
        expect(JSON.stringify(events.map((e) => e.data))).toContain(
          'ATS_EXECUTION_STARTED',
        );
        steps.push(
          'Workspace reflected platform, stages and verification safely; ownership and real-execution gates refused unsafe access',
        );
        const ownedDocument = await db.userDocument.findFirstOrThrow({
          where: { userId: ownerId },
        });
        for (const url of [
          `/api/v1/documents/${ownedDocument.id}/content`,
          '/api/v1/documents',
          '/api/v1/profile',
          '/api/v1/verified-answers',
          '/api/v1/human-review',
          `/api/v1/applications/${applicationId}`,
          `/api/v1/applications/${applicationId}/preparation`,
          `/api/v1/applications/${applicationId}/execution`,
        ])
          expect((await app.inject({ url })).statusCode).toBe(401);
        expect(
          (
            await app.inject({
              url: `/api/v1/documents/${ownedDocument.id}/content`,
              headers: outsider,
            })
          ).statusCode,
        ).toBe(404);
        expect(
          (
            await app.inject({
              method: 'PATCH',
              url: `/api/v1/documents/${ownedDocument.id}`,
              headers: outsider,
              payload: { revision: ownedDocument.revision, name: 'other.pdf' },
            })
          ).statusCode,
        ).toBe(404);
        const timeline = detail
          .json()
          .application.timeline.map((event: { label: string }) => event.label);
        for (const label of [
          'Application created',
          'Application destination resolved',
          'Human review decision saved',
          'Submission outcome unknown',
          'Submission verified',
        ])
          expect(timeline).toContain(label);
        expect(
          (
            await app.inject({
              url: `/api/v1/applications/${applicationId}/preparation`,
              headers,
            })
          ).body,
        ).not.toContain('storageRef');
        await page
          .getByRole('navigation', { name: 'Main navigation' })
          .getByRole('link', { name: 'Applications', exact: true })
          .click();
        await page
          .getByText('Test submission verified', { exact: true })
          .waitFor();
        for (const width of [768, 375]) {
          await page.setViewportSize({ width, height: 900 });
          for (const path of [
            `/applications/${applicationId}`,
            `/review/${applicationId}`,
            '/profile',
            '/documents',
            '/verified-answers',
            '/jobs',
          ]) {
            await page.goto(`http://127.0.0.1:4160${path}`);
            await page.locator('main h1').waitFor();
            expect(
              await page.evaluate(
                () => document.documentElement.scrollWidth <= window.innerWidth,
              ),
              `${path} at ${width}px`,
            ).toBe(true);
            expect(
              await page
                .getByRole('navigation', { name: 'Main navigation' })
                .getByRole('link', { name: 'Jobs', exact: true })
                .isVisible(),
            ).toBe(true);
            if (width === 375)
              await page.screenshot({
                path: resolve(
                  evidence,
                  `${scenario.toLowerCase()}-${path.split('/')[1]}-mobile.png`,
                ),
                fullPage: true,
              });
          }
        }
        await page.setViewportSize({ width: 1280, height: 900 });
        steps.push(
          'G/H: Ownership denied cross-user applications, reviews and documents; timeline and Applications reflect verification; all major pages fit tablet/mobile viewports',
        );
        if (scenario === 'ASHBY') {
          await page
            .getByRole('navigation', { name: 'Main navigation' })
            .getByRole('link', { name: 'Jobs', exact: true })
            .click();
          await page
            .getByRole('link', {
              name: 'Phase 10 Unsupported Role',
              exact: true,
            })
            .click();
          await page
            .getByRole('button', { name: 'Apply Now', exact: true })
            .click();
          await page.waitForURL(/\/applications\//);
          const unsupportedId = page.url().split('/').pop()!;
          await eventually(
            () =>
              db.application.findUniqueOrThrow({
                where: { id: unsupportedId },
              }),
            (a) => a.state === 'HUMAN_REQUIRED',
          );
          await page
            .getByRole('button', { name: 'Refresh', exact: true })
            .click();
          await page.getByText('Unsupported', { exact: true }).waitFor();
          await page
            .getByText(
              'This application platform is unsupported. Apply manually on the employer site; browser automation is unavailable.',
            )
            .waitFor();
          expect(
            (await command(`/api/v1/applications/${unsupportedId}/inspect`))
              .statusCode,
          ).toBe(409);
          expect(
            (
              await command(`/api/v1/applications/${unsupportedId}/execute`, {
                mode: 'TEST_FIXTURE',
              })
            ).statusCode,
          ).toBe(409);
          expect(
            await db.applicationExecution.count({
              where: { applicationId: unsupportedId },
            }),
          ).toBe(0);
          const view = await app.inject({
            url: `/api/v1/applications/${unsupportedId}`,
            headers,
          });
          expect(view.body).not.toContain('PRIVATE_SENTINEL');
          await page.screenshot({
            path: resolve(evidence, 'unsupported.png'),
            fullPage: true,
          });
          steps.push(
            'Unsupported-platform UI Apply created HUMAN_REQUIRED with manual guidance, no inspection, execution or submission',
          );
          const blockedStart = await command(
            `/api/v1/jobs/${encodeURIComponent(jobId + '-blocked')}/applications`,
          );
          expect(blockedStart.statusCode).toBe(201);
          const blockedId = blockedStart.json().application.id;
          await eventually(
            () =>
              db.applicationPlan.findUnique({
                where: { applicationId: blockedId },
              }),
            (plan) => plan != null,
          );
          expect(
            (await command(`/api/v1/applications/${blockedId}/inspect`)).json()
              .error,
          ).toBe('UNSAFE_DESTINATION');
          const blockedInspection =
            await db.applicationInspection.findUniqueOrThrow({
              where: { applicationId: blockedId },
            });
          expect(blockedInspection).toMatchObject({
            state: 'HUMAN_REQUIRED',
            errorCode: 'UNSAFE_DESTINATION',
            result: null,
          });
          const blockedReview = await app.inject({
            url: `/api/v1/human-review/${blockedId}`,
            headers,
          });
          expect(blockedReview.statusCode).toBe(200);
          expect(blockedReview.body).toContain('UNSAFE_DESTINATION');
          expect(blockedReview.body).toContain('network security validation');
          expect(
            (
              await command(`/api/v1/applications/${blockedId}/execute`, {
                mode: 'TEST_FIXTURE',
              })
            ).statusCode,
          ).toBe(409);
          expect(
            await db.applicationExecution.count({
              where: { applicationId: blockedId },
            }),
          ).toBe(0);
          expect(fixture.submissions).toHaveLength(1);
          steps.push(
            'Private-DNS supported ATS created durable HUMAN_REQUIRED inspection, explicit security guidance and no execution',
          );
        }
        await page
          .getByRole('button', { name: 'Log out', exact: true })
          .click();
        await page
          .getByRole('button', { name: 'Log in', exact: true })
          .waitFor();
        await page.reload();
        await page
          .getByRole('button', { name: 'Log in', exact: true })
          .waitFor();
        expect(
          await page.evaluate(() =>
            localStorage.getItem('careerlift_auth_token'),
          ),
        ).toBeNull();
        steps.push(
          'Logout remains logged out after reload; no implicit demo identity',
        );
        expect(errors).toEqual([]);
        expect(consoleErrors).toEqual([]);
        await writeFile(
          resolve(evidence, `${scenario.toLowerCase()}-flow.txt`),
          steps.join('\n') + '\n',
        );
      } catch (error) {
        await writeFile(
          resolve(evidence, `${scenario.toLowerCase()}-failure.txt`),
          [...steps, String(error), logs].join('\n'),
        );
        throw error;
      } finally {
        await browser?.close();
        if (web?.pid) {
          if (process.platform === 'win32')
            await new Promise<void>((done) => {
              spawn('taskkill', ['/pid', String(web!.pid), '/T', '/F'], {
                windowsHide: true,
                stdio: 'ignore',
              }).on('exit', () => done());
            });
          else web.kill('SIGTERM');
        }
        await worker.close();
        await executor.close();
        await queue.obliterate({ force: true });
        await queue.close();
        await producer.quit();
        await consumer.quit();
        await app.close();
        if (ownerId) {
          const where = { application: { userId: ownerId } };
          await db.applicationExecution.deleteMany({ where });
          await db.applicationPreparation.deleteMany({ where });
          await db.applicationInspection.deleteMany({ where });
          await db.applicationPlan.deleteMany({ where });
          await db.applicationEvent.deleteMany({
            where: { OR: [{ actorId: ownerId }, where] },
          });
          await db.application.deleteMany({ where: { userId: ownerId } });
          await db.userDocument.deleteMany({ where: { userId: ownerId } });
          await db.verifiedAnswer.deleteMany({ where: { userId: ownerId } });
          await db.applicationProfile.deleteMany({
            where: { userId: ownerId },
          });
          await db.user.deleteMany({ where: { id: ownerId } });
        }
        if (otherId) await db.user.deleteMany({ where: { id: otherId } });
        await db.job.deleteMany({
          where: {
            id: { in: [jobId, jobId + '-unsupported', jobId + '-blocked'] },
          },
        });
        await db.$disconnect();
        await fixture.close();
      }
    },
    240000,
  );
});
