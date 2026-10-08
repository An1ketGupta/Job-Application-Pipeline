import { randomUUID } from 'node:crypto';
import { mkdtemp, rm, mkdir } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  beforeAll,
  afterAll,
  beforeEach,
  describe,
  expect,
  it,
  vi,
} from 'vitest';
import { Queue, Worker } from 'bullmq';
import { PrismaClient } from '@careerlift/database';
import { LocalDocumentStorage } from '@careerlift/browser';
import {
  encryptSecret,
  EmailProviderError,
  GmailProvider,
  type GmailConfig,
  type EmailProvider,
} from '@careerlift/email';
import { createApp } from './app.js';
import { createToken } from './auth.js';
import { createRedisConnection } from '../../worker/src/queue.js';
import {
  createEmailProcessor,
  recoverStaleEmails,
} from '../../worker/src/email-processor.js';
import { chromium } from 'playwright';

const databaseUrl = process.env.INTEGRATION_DATABASE_URL;
const redisUrl = process.env.INTEGRATION_REDIS_URL;
if (databaseUrl && !/\/careerlift_test(?:\?|$)/.test(databaseUrl))
  throw new Error('Email tests require careerlift_test');
const suite = databaseUrl && redisUrl ? describe : describe.skip;
suite('Email automation with PostgreSQL and BullMQ', () => {
  const suffix = randomUUID(),
    owner = `email-owner-${suffix}`,
    stranger = `email-stranger-${suffix}`,
    jobId = `email-job-${suffix}`;
  const secret = 'email-integration-secret';
  const config: GmailConfig = {
    clientId: 'test.apps.googleusercontent.com',
    clientSecret: 'CLIENT_SECRET_SENTINEL',
    redirectUri: 'http://localhost:3001/api/v1/email/oauth/callback',
    webOrigin: 'http://localhost:3000',
    encryptionKey: Buffer.alloc(32, 9).toString('base64'),
    allowSend: true,
    expectedSender: 'candidate@gmail.com',
  };
  const db = new PrismaClient({ datasourceUrl: databaseUrl! });
  const connection = createRedisConnection(redisUrl!);
  const queue = new Queue(`email-test-${suffix}`, { connection });
  let root: string, applicationId: string, resumeId: string;
  let app: ReturnType<typeof createApp>;
  const headers = (userId = owner) => ({
    authorization: `Bearer ${createToken(userId, secret, 3600)}`,
  });
  const url = (path = '') =>
    `/api/v1/email/applications/${applicationId}${path}`;
  const inject = (
    method: 'GET' | 'POST' | 'PUT',
    path: string,
    payload?: unknown,
    userId = owner,
  ) =>
    app.inject({
      method,
      url: path,
      headers: {
        ...headers(userId),
        ...(payload === undefined
          ? {}
          : { 'content-type': 'application/json' }),
      },
      ...(payload === undefined ? {} : { payload: JSON.stringify(payload) }),
    });
  const draft = () =>
    inject('PUT', url(), {
      revision: 0,
      subject: 'Application for AI Intern',
      body: 'Dear Hiring Team,\nPlease consider my application.\nAniket',
      documentIds: [resumeId],
    });
  const approve = (revision = 1) =>
    inject('POST', url('/send'), { revision, userConfirmed: true });
  beforeAll(async () => {
    root = await mkdtemp(join(tmpdir(), 'careerlift-email-'));
    await db.user.createMany({
      data: [
        { id: owner, email: `${owner}@example.com` },
        { id: stranger, email: `${stranger}@example.com` },
      ],
    });
    await db.job.create({
      data: {
        id: jobId,
        externalId: suffix,
        source: 'LOCAL_TEST',
        title: 'AI Intern',
        company: 'Test Company',
        description: 'Apply by email with your resume.',
        requirements: [],
      },
    });
    const application = await db.application.create({
      data: {
        userId: owner,
        jobId,
        state: 'RESOLVED',
        plan: {
          create: {
            applicationType: 'EMAIL',
            executor: 'EMAIL',
            destination: { email: 'jobs@example.com' },
            requirements: [],
            actions: [],
            confidence: 1,
            requiresHumanReview: false,
            reasoning: ['Controlled email fixture'],
            resolvedBy: 'deterministic',
          },
        },
      },
    });
    applicationId = application.id;
    await db.applicationProfile.create({
      data: {
        userId: owner,
        data: {
          fullName: 'Aniket',
          summary: 'Builds TypeScript applications.',
        },
      },
    });
    await db.emailAccount.create({
      data: {
        userId: owner,
        address: 'candidate@gmail.com',
        encryptedRefreshToken: encryptSecret(
          'REFRESH_SENTINEL',
          config.encryptionKey,
          owner,
        ),
      },
    });
    app = createApp({
      db,
      queue,
      authSecret: secret,
      documentRoot: root,
      gmail: config,
      emailDraftGenerator: {
        generate: async () => ({
          subject: 'Personalized application',
          body: 'Personalized text for review.',
          warnings: [],
        }),
      },
    });
    const upload = await inject('POST', '/api/v1/documents', {
      name: 'AI-Resume.pdf',
      type: 'RESUME',
      content: Buffer.from('%PDF-fixture-resume').toString('base64'),
      jobTitles: ['AI Engineer', 'Machine Learning Intern'],
    });
    expect(upload.statusCode, upload.body).toBe(201);
    resumeId = upload.json().document.id;
  });
  beforeEach(async () => {
    await queue.drain();
    await db.applicationEvent.deleteMany({ where: { applicationId } });
    await db.verifiedAnswer.deleteMany({ where: { userId: owner } });
    await db.emailMessage.deleteMany({ where: { userId: owner } });
    await db.userDocument.update({
      where: { id: resumeId },
      data: { archivedAt: null, revision: 1 },
    });
    await db.emailAccount.update({
      where: { userId: owner },
      data: {
        connected: true,
        version: 1,
        encryptedRefreshToken: encryptSecret(
          'REFRESH_SENTINEL',
          config.encryptionKey,
          owner,
        ),
      },
    });
    await db.applicationPlan.update({
      where: { applicationId },
      data: { requiresHumanReview: false },
    });
  });
  afterAll(async () => {
    vi.restoreAllMocks();
    await app?.close();
    await queue.obliterate({ force: true });
    await queue.close();
    await connection.quit();
    await db.applicationEvent.deleteMany({
      where: { OR: [{ applicationId }, { actorId: owner }] },
    });
    await db.applicationPlan.deleteMany({ where: { applicationId } });
    await db.application.deleteMany({ where: { id: applicationId } });
    await db.userDocument.deleteMany({
      where: { userId: { in: [owner, stranger] } },
    });
    await db.applicationProfile.deleteMany({ where: { userId: owner } });
    await db.verifiedAnswer.deleteMany({ where: { userId: owner } });
    await db.user.deleteMany({ where: { id: { in: [owner, stranger] } } });
    await db.job.deleteMany({ where: { id: jobId } });
    await db.$disconnect();
    if (root) await rm(root, { recursive: true, force: true });
  });
  it('runs requested email answers through the shared threshold, blocks unresolved sending and immediately saves reviewed answers', async () => {
    const pipelineApp = createApp({
      db,
      queue,
      authSecret: secret,
      documentRoot: root,
      gmail: config,
      answerConfidenceThreshold: 0.75,
      answerProvider: {
        name: 'controlled',
        generateAnswer: async () => {
          throw new Error('No single calls');
        },
        discoverQuestions: async () => [
          {
            id: 'skill',
            question: 'Describe your technical background',
            category: 'TECHNICAL_EXPERIENCE',
            fieldType: 'TEXT',
            options: [],
          },
          {
            id: 'salary',
            question: 'What is your expected salary?',
            category: 'SALARY',
            fieldType: 'TEXT',
            options: [],
          },
        ],
        generateAnswers: async (batch) => ({
          answers: batch.questions.map((question) => ({
            id: question.id,
            answer:
              question.id === 'skill'
                ? 'Builds TypeScript applications.'
                : '100000',
            confidence: question.id === 'skill' ? 0.9 : 0.74,
            supportedBySavedInformation: true,
            conflictingInformation: false,
            requiresHumanReview: false,
            evidence:
              question.id === 'skill'
                ? [{ evidenceId: 'profile:summary', quote: 'TypeScript' }]
                : [
                    {
                      evidenceId: `resume:${batch.resume.documentId}:0`,
                      quote: '100000',
                    },
                  ],
            explanation: 'Uses explicitly saved candidate information.',
          })),
        }),
      },
    });
    const call = (
      method: 'POST' | 'PUT' | 'GET',
      path: string,
      payload?: object,
      userId = owner,
    ) =>
      pipelineApp.inject({
        method,
        url: path,
        headers: headers(userId),
        ...(payload ? { payload } : {}),
      });
    try {
      const uploaded = await call('POST', '/api/v1/documents', {
        name: 'selected.txt',
        type: 'RESUME',
        content: Buffer.from(
          'Builds TypeScript applications. Expected salary: 100000.',
        ).toString('base64'),
      });
      const selected = uploaded.json().document.id;
      expect(
        (await call('POST', url('/answers'), { resumeId: selected }, stranger))
          .statusCode,
      ).toBe(404);
      const response = await call('POST', url('/answers'), {
        resumeId: selected,
      });
      expect(response.statusCode, response.body).toBe(200);
      const stage = response.json().stage;
      expect(
        stage.answers.find((answer: { id: string }) => answer.id === 'skill')
          .requiresHumanReview,
      ).toBe(false);
      expect(
        stage.answers.find((answer: { id: string }) => answer.id === 'salary')
          .requiresHumanReview,
      ).toBe(true);
      expect(await db.verifiedAnswer.count({ where: { userId: owner } })).toBe(
        0,
      );
      const firstDraft = await call('PUT', url(), {
        revision: 0,
        subject: 'Application',
        body: 'Please consider my application.',
        documentIds: [selected],
      });
      expect(firstDraft.statusCode, firstDraft.body).toBe(200);
      expect(
        (
          await call('POST', url('/send'), { revision: 1, userConfirmed: true })
        ).json().error,
      ).toBe('EMAIL_ANSWERS_REQUIRE_REVIEW');
      expect(await queue.getWaitingCount()).toBe(0);
      if (process.env.EMAIL_UI_URL) {
        const browser = await chromium.launch({ headless: true });
        try {
          const context = await browser.newContext({
            viewport: { width: 1280, height: 900 },
          });
          await context.route('**/api/v1/**', async (route) => {
            const request = route.request(),
              target = new URL(request.url());
            const result = await pipelineApp.inject({
              method: request.method() as 'GET' | 'POST' | 'PUT' | 'PATCH',
              url: target.pathname + target.search,
              headers: request.headers(),
              ...(request.postData() ? { payload: request.postData()! } : {}),
            });
            await route.fulfill({
              status: result.statusCode,
              headers: {
                'Content-Type': 'application/json',
                'Access-Control-Allow-Origin': '*',
                'Access-Control-Allow-Headers': 'Authorization, Content-Type',
              },
              body: result.body,
            });
          });
          const page = await context.newPage();
          const pageErrors: string[] = [];
          page.on('pageerror', (error) => pageErrors.push(error.message));
          await page.addInitScript(
            ({ token, user }) => {
              localStorage.setItem('careerlift_auth_token', token);
              localStorage.setItem(
                'careerlift_auth_user',
                JSON.stringify(user),
              );
            },
            {
              token: createToken(owner, secret),
              user: { id: owner, email: `${owner}@example.com` },
            },
          );
          await page.goto(
            `${process.env.EMAIL_UI_URL}/applications/${applicationId}`,
          );
          await page
            .getByText('Gemini confidence: 74%', { exact: true })
            .waitFor();
          await page
            .getByRole('textbox', { name: 'Your answer', exact: true })
            .fill('110000');
          const evidence = join(
            process.cwd(),
            'docs',
            'answer-pipeline-evidence',
          );
          await mkdir(evidence, { recursive: true });
          await page
            .locator('[aria-labelledby="email-composer-heading"]')
            .screenshot({ path: join(evidence, 'email-review-desktop.png') });
          await page.setViewportSize({ width: 390, height: 844 });
          await page
            .locator('[aria-labelledby="email-composer-heading"]')
            .screenshot({ path: join(evidence, 'email-review-mobile.png') });
          expect(pageErrors).toEqual([]);
        } finally {
          await browser.close();
        }
      }
      const review = await call('POST', url('/answers/review'), {
        stageId: stage.id,
        questionId: 'salary',
        value: '110000',
        userConfirmed: true,
      });
      expect(review.statusCode, review.body).toBe(200);
      expect(
        await db.verifiedAnswer.findFirst({
          where: { userId: owner, category: 'SALARY' },
        }),
      ).toMatchObject({
        value: '110000',
        source: 'USER_VERIFIED',
        active: true,
      });
      expect(
        (
          await call('POST', url('/answers/review'), {
            stageId: stage.id,
            questionId: 'salary',
            value: '120000',
            userConfirmed: true,
          })
        ).statusCode,
      ).toBe(409);
      const finalDraft = await call('PUT', url(), {
        revision: 1,
        subject: 'Application',
        body: 'Please consider my application.',
        documentIds: [selected],
      });
      expect(finalDraft.statusCode, finalDraft.body).toBe(200);
      expect(finalDraft.json().message.body).toContain('110000');
      expect(finalDraft.json().message.body).toContain(
        'Builds TypeScript applications.',
      );
      const send = await call('POST', url('/send'), {
        revision: 2,
        userConfirmed: true,
      });
      expect(send.statusCode, send.body).toBe(200);
      expect(send.json().message.state).toBe('QUEUED');
    } finally {
      await pipelineApp.close();
      await db.userDocument.deleteMany({
        where: { userId: owner, name: 'selected.txt' },
      });
    }
  });
  it('enforces authentication and ownership and never exposes credentials or document storage references', async () => {
    expect(
      (await app.inject({ url: '/api/v1/email/settings' })).statusCode,
    ).toBe(401);
    expect((await inject('GET', url(), undefined, stranger)).statusCode).toBe(
      404,
    );
    const settings = await inject('GET', '/api/v1/email/settings');
    expect(settings.statusCode, settings.body).toBe(200);
    for (const sentinel of [
      'REFRESH_SENTINEL',
      'CLIENT_SECRET_SENTINEL',
      'encryptedRefreshToken',
      'encryptionKey',
    ])
      expect(settings.body).not.toContain(sentinel);
    const read = await inject('GET', url());
    expect(read.json().resumeRecommendation.id).toBe(resumeId);
    expect(read.body).not.toContain('storageRef');
  });
  it('persists resume target titles and keeps personalization separate from saving or sending', async () => {
    const docs = await inject('GET', '/api/v1/documents');
    expect(docs.json().documents[0].jobTitles).toEqual([
      'AI Engineer',
      'Machine Learning Intern',
    ]);
    const generated = await inject('POST', url('/personalize'), {
      resumeId,
      profileSharingConfirmed: true,
    });
    expect(generated.statusCode, generated.body).toBe(200);
    expect(generated.json().subject).toBe('Personalized application');
    expect(await db.emailMessage.count({ where: { userId: owner } })).toBe(0);
    expect(await queue.getWaitingCount()).toBe(0);
  });
  it('requires an explicit approval of the latest saved revision and prevents recipient overrides', async () => {
    expect((await draft()).statusCode).toBe(200);
    expect(
      (await inject('POST', url('/send'), { revision: 1 })).statusCode,
    ).toBe(400);
    expect((await approve(2)).statusCode).toBe(409);
    expect(
      (
        await inject('PUT', url(), {
          revision: 1,
          subject: 'Application',
          body: 'Hello',
          documentIds: [resumeId],
          to: 'attacker@example.com',
        })
      ).statusCode,
    ).toBe(400);
    await db.applicationPlan.update({
      where: { applicationId },
      data: { requiresHumanReview: true },
    });
    expect((await approve()).statusCode).toBe(409);
    expect(await queue.getWaitingCount()).toBe(0);
  });
  it('blocks archived or changed resumes and account changes before sending', async () => {
    await draft();
    await db.userDocument.update({
      where: { id: resumeId },
      data: { revision: 2 },
    });
    expect((await approve()).statusCode).toBe(409);
    await db.userDocument.update({
      where: { id: resumeId },
      data: { revision: 1, archivedAt: new Date() },
    });
    expect((await approve()).statusCode).toBe(409);
    await db.userDocument.update({
      where: { id: resumeId },
      data: { archivedAt: null },
    });
    await db.emailAccount.update({
      where: { userId: owner },
      data: { version: 2 },
    });
    expect((await approve()).json().error).toBe('EMAIL_ACCOUNT_CHANGED');
    expect(await queue.getWaitingCount()).toBe(0);
  });
  it('queues concurrent approval clicks once and executes an actual BullMQ job once', async () => {
    await draft();
    const responses = await Promise.all([approve(), approve()]);
    expect(responses.map((r) => r.statusCode)).toEqual([200, 200]);
    expect(await queue.getWaitingCount()).toBe(1);
    const send = vi.fn(async () => 'gmail-message-fixture');
    const provider: EmailProvider = {
      accessToken: async () => 'fixture-access',
      send,
    };
    const process = createEmailProcessor(
      db,
      provider,
      config,
      new LocalDocumentStorage(root),
    );
    const worker = new Worker(queue.name, process, { connection });
    try {
      await vi.waitFor(
        async () =>
          expect(
            (
              await db.emailMessage.findUniqueOrThrow({
                where: { applicationId },
              })
            ).state,
          ).toBe('SENT'),
        { timeout: 10000 },
      );
      const record = await db.emailMessage.findUniqueOrThrow({
        where: { applicationId },
      });
      await process({
        data: { messageId: record.id, revision: record.revision },
      });
      expect(send).toHaveBeenCalledTimes(1);
      const sent = send.mock.calls[0] as unknown as [
        string,
        { attachments: Array<{ name: string; buffer: Buffer }> },
      ];
      expect(sent[1].attachments[0]?.name).toBe('AI-Resume.pdf');
      expect(sent[1].attachments[0]?.buffer.toString()).toBe(
        '%PDF-fixture-resume',
      );
      expect((await approve()).json().message.state).toBe('SENT');
      const summary = await inject(
        'GET',
        `/api/v1/applications/${applicationId}`,
      );
      expect(summary.json().application.email.state).toBe('SENT');
      expect(summary.json().application.state).toBe('RESOLVED');
      expect(summary.json().application.execution).toBeNull();
    } finally {
      await worker.close();
    }
  });
  it('locks unknown send outcomes and refuses all attempts to send them again', async () => {
    await draft();
    await approve();
    const record = await db.emailMessage.findUniqueOrThrow({
      where: { applicationId },
    });
    const send = vi.fn(async () => {
      throw new EmailProviderError('EMAIL_SEND_UNKNOWN', true);
    });
    const process = createEmailProcessor(
      db,
      { accessToken: async () => 'token', send },
      config,
      new LocalDocumentStorage(root),
    );
    const task = { data: { messageId: record.id, revision: record.revision } };
    await Promise.all([process(task), process(task)]);
    expect(
      (await db.emailMessage.findUniqueOrThrow({ where: { applicationId } }))
        .state,
    ).toBe('UNKNOWN');
    expect((await draft()).statusCode).toBe(409);
    expect((await approve()).json().message.state).toBe('UNKNOWN');
    await process(task);
    expect(send).toHaveBeenCalledTimes(1);
  });
  it('cancels queued jobs and refuses stale attachments in worker preflight', async () => {
    await draft();
    await approve();
    const record = await db.emailMessage.findUniqueOrThrow({
      where: { applicationId },
    });
    const send = vi.fn(async () => 'message');
    const process = createEmailProcessor(
      db,
      { accessToken: async () => 'token', send },
      config,
      new LocalDocumentStorage(root),
    );
    expect(
      (
        await inject('POST', url('/cancel'), {
          revision: 1,
          userConfirmed: true,
        })
      ).statusCode,
    ).toBe(200);
    await process({ data: { messageId: record.id, revision: 1 } });
    expect(send).not.toHaveBeenCalled();
    await db.emailMessage.update({
      where: { id: record.id },
      data: { state: 'QUEUED' },
    });
    await db.userDocument.update({
      where: { id: resumeId },
      data: { revision: 2 },
    });
    await process({ data: { messageId: record.id, revision: 1 } });
    expect(send).not.toHaveBeenCalled();
    expect(
      (await db.emailMessage.findUniqueOrThrow({ where: { applicationId } }))
        .state,
    ).toBe('FAILED');
  });
  it('blocks disconnect during sending and cancels queued email when disconnected', async () => {
    const revoke = vi
      .spyOn(GmailProvider.prototype, 'revoke')
      .mockResolvedValue();
    await draft();
    await approve();
    const record = await db.emailMessage.findUniqueOrThrow({
      where: { applicationId },
    });
    let release!: () => void;
    let sending!: () => void;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const started = new Promise<void>((resolve) => {
      sending = resolve;
    });
    const send = vi.fn(async () => {
      sending();
      await gate;
      return 'gmail-fixture';
    });
    const process = createEmailProcessor(
      db,
      { accessToken: async () => 'token', send },
      config,
      new LocalDocumentStorage(root),
    );
    const completion = process({
      data: { messageId: record.id, revision: record.revision },
    });
    await started;
    try {
      expect(
        (await inject('POST', '/api/v1/email/disconnect')).statusCode,
      ).toBe(409);
      expect(
        (await db.emailAccount.findUniqueOrThrow({ where: { userId: owner } }))
          .connected,
      ).toBe(true);
    } finally {
      release();
      await completion;
    }
    expect(send).toHaveBeenCalledTimes(1);
    await db.emailMessage.update({
      where: { id: record.id },
      data: { state: 'QUEUED' },
    });
    expect((await inject('POST', '/api/v1/email/disconnect')).statusCode).toBe(
      200,
    );
    await process({
      data: { messageId: record.id, revision: record.revision },
    });
    expect(send).toHaveBeenCalledTimes(1);
    expect(
      (await db.emailMessage.findUniqueOrThrow({ where: { id: record.id } }))
        .state,
    ).toBe('CANCELLED');
    expect(revoke).toHaveBeenCalledTimes(1);
    revoke.mockRestore();
  });
  it('expires single-use OAuth state and binds the connected sender to the configured Gmail address', async () => {
    const connected = await inject('POST', '/api/v1/email/connect');
    const state = new URL(connected.json().url).searchParams.get('state')!;
    const exchange = vi
      .spyOn(GmailProvider.prototype, 'exchange')
      .mockResolvedValue({
        address: 'candidate@gmail.com',
        refreshToken: 'new-refresh',
      });
    const callback = `/api/v1/email/oauth/callback?state=${encodeURIComponent(state)}&code=fixture-code`;
    expect((await app.inject({ url: callback })).headers.location).toBe(
      'http://localhost:3000/email?connection=connected',
    );
    expect((await app.inject({ url: callback })).headers.location).toBe(
      'http://localhost:3000/email?connection=failed&reason=EMAIL_OAUTH_STATE_INVALID',
    );
    expect(exchange).toHaveBeenCalledTimes(1);
    const next = new URL(
      (await inject('POST', '/api/v1/email/connect')).json().url,
    ).searchParams.get('state')!;
    exchange.mockResolvedValue({
      address: 'other@gmail.com',
      refreshToken: 'other-refresh',
    });
    expect(
      (
        await app.inject({
          url: `/api/v1/email/oauth/callback?state=${next}&code=wrong-account`,
        })
      ).headers.location,
    ).toContain('reason=EMAIL_ACCOUNT_MISMATCH');
    expect(
      (await db.emailAccount.findUniqueOrThrow({ where: { userId: owner } }))
        .address,
    ).toBe('candidate@gmail.com');
    const expired = new URL(
      (await inject('POST', '/api/v1/email/connect')).json().url,
    ).searchParams.get('state')!;
    await db.emailOAuthState.updateMany({
      where: { userId: owner },
      data: { expiresAt: new Date(0) },
    });
    expect(
      (
        await app.inject({
          url: `/api/v1/email/oauth/callback?state=${expired}&code=expired-code`,
        })
      ).headers.location,
    ).toContain('reason=EMAIL_OAUTH_STATE_INVALID');
    expect(exchange).toHaveBeenCalledTimes(2);
    exchange.mockRestore();
  });
  it('allows Gmail connection while sending is disabled and exposes only safe callback reasons', async () => {
    const disabled = createApp({
      db,
      authSecret: secret,
      gmail: { ...config, allowSend: false },
    });
    const exchange = vi.spyOn(GmailProvider.prototype, 'exchange');
    const callback = async () => {
      const result = await disabled.inject({
        method: 'POST',
        url: '/api/v1/email/connect',
        headers: headers(),
      });
      const state = new URL(result.json().url).searchParams.get('state')!;
      return disabled.inject({
        url: `/api/v1/email/oauth/callback?state=${state}&code=fixture-code`,
      });
    };
    try {
      exchange.mockResolvedValue({
        address: 'candidate@gmail.com',
        refreshToken: 'fixture-refresh',
      });
      expect((await callback()).headers.location).toContain(
        'connection=connected',
      );
      exchange.mockRejectedValue(
        new EmailProviderError('EMAIL_PERMISSION_REQUIRED'),
      );
      expect((await callback()).headers.location).toContain(
        'reason=EMAIL_PERMISSION_REQUIRED',
      );
      exchange.mockRejectedValue(new Error('PRIVATE_CALLBACK_ERROR_SENTINEL'));
      const failed = await callback();
      expect(failed.headers.location).toContain(
        'reason=EMAIL_CONNECTION_FAILED',
      );
      expect(failed.headers.location).not.toContain(
        'PRIVATE_CALLBACK_ERROR_SENTINEL',
      );
    } finally {
      exchange.mockRestore();
      await disabled.close();
    }
  });
  it('recovers interrupted sends as unknown while failing jobs that never reached sending', async () => {
    await draft();
    await db.emailMessage.update({
      where: { applicationId },
      data: { state: 'SENDING', updatedAt: new Date(0), runId: 'crashed' },
    });
    await recoverStaleEmails(db);
    expect(
      (await db.emailMessage.findUniqueOrThrow({ where: { applicationId } }))
        .state,
    ).toBe('UNKNOWN');
    await db.emailMessage.update({
      where: { applicationId },
      data: { state: 'QUEUED', updatedAt: new Date(0) },
    });
    await recoverStaleEmails(db);
    expect(
      (await db.emailMessage.findUniqueOrThrow({ where: { applicationId } }))
        .state,
    ).toBe('FAILED');
  });
  it.skipIf(!process.env.EMAIL_UI_URL)(
    'verifies profile template, resume labels, personalized preview, approval, and sent status through the UI',
    async () => {
      const browser = await chromium.launch({ headless: true });
      const context = await browser.newContext({
        viewport: { width: 1280, height: 900 },
      });
      const page = await context.newPage();
      const pageErrors: string[] = [];
      page.on('pageerror', (error) => pageErrors.push(error.message));
      await context.route('**/api/v1/**', async (route) => {
        const request = route.request(),
          target = new URL(request.url());
        const result = await app.inject({
          method: request.method() as 'GET' | 'POST' | 'PUT' | 'PATCH',
          url: target.pathname + target.search,
          headers: request.headers(),
          ...(request.postData() ? { payload: request.postData()! } : {}),
        });
        await route.fulfill({
          status: result.statusCode,
          headers: {
            'Content-Type': 'application/json',
            'Access-Control-Allow-Origin': '*',
            'Access-Control-Allow-Headers': 'Authorization, Content-Type',
          },
          body: result.body,
        });
      });
      const base = process.env.EMAIL_UI_URL!;
      try {
        await page.goto(`${base}/profile`);
        await page.getByRole('button', { name: 'Log in', exact: true }).click();
        await page
          .getByLabel('User Email', { exact: true })
          .fill(`${owner}@example.com`);
        await page
          .getByRole('button', { name: 'Log in with email', exact: true })
          .click();
        await page
          .getByRole('heading', {
            name: 'Application email template',
            exact: true,
          })
          .waitFor();
        await page.goto(
          `${base}/email?connection=failed&reason=EMAIL_ACCOUNT_MISMATCH`,
        );
        await page
          .getByText(
            'The Gmail account selected does not match the configured application sender',
            { exact: false },
          )
          .waitFor();
        await page
          .getByRole('alert')
          .filter({ hasText: 'candidate@gmail.com' })
          .waitFor();
        await page.goto(`${base}/profile`);
        await page
          .getByRole('heading', {
            name: 'Application email template',
            exact: true,
          })
          .waitFor();
        await page
          .getByLabel('Subject template', { exact: true })
          .fill('Application: {{jobTitle}}');
        await page
          .getByLabel('Email body template', { exact: true })
          .fill(
            'Dear Hiring Team,\n\nI am applying for {{jobTitle}} at {{company}}.\n\n{{profileSummary}}\n\n{{signature}}',
          );
        await page
          .getByRole('button', { name: 'Save email template', exact: true })
          .click();
        await page
          .getByText('Email template saved.', { exact: true })
          .waitFor();
        expect(
          (
            await db.emailPreferences.findUniqueOrThrow({
              where: { userId: owner },
            })
          ).data,
        ).toMatchObject({ subjectTemplate: 'Application: {{jobTitle}}' });
        await page.goto(`${base}/documents`);
        await page
          .getByRole('heading', { name: 'Documents', exact: true })
          .waitFor();
        await page
          .getByLabel('Target job titles (separate with commas)', {
            exact: true,
          })
          .fill('Backend Engineer, Node.js Developer');
        await page.getByLabel('Document file', { exact: true }).setInputFiles({
          name: 'Backend-Resume.pdf',
          mimeType: 'application/pdf',
          buffer: Buffer.from('%PDF-backend-fixture'),
        });
        await page
          .getByRole('button', { name: 'Upload document', exact: true })
          .click();
        await page
          .getByRole('heading', { name: 'Backend-Resume.pdf', exact: true })
          .waitFor();
        await page.goto(`${base}/applications/${applicationId}`);
        await page
          .getByRole('heading', { name: 'Application email', exact: true })
          .waitFor();
        expect(
          await page
            .getByRole('button', { name: 'Inspect application', exact: true })
            .count(),
        ).toBe(0);
        expect(
          await page.getByLabel('AI-Resume.pdf', { exact: false }).isChecked(),
        ).toBe(true);
        expect(
          await page
            .getByLabel('Backend-Resume.pdf', { exact: false })
            .isChecked(),
        ).toBe(false);
        await page
          .getByRole('button', { name: 'Personalize with Gemini', exact: true })
          .click();
        await vi.waitFor(async () =>
          expect(
            await page.getByLabel('Subject', { exact: true }).inputValue(),
          ).toBe('Personalized application'),
        );
        await page
          .getByRole('button', { name: 'Save draft for review', exact: true })
          .click();
        const approveButton = page.getByRole('button', {
          name: 'Approve and send application email',
          exact: true,
        });
        await approveButton.waitFor();
        expect(await approveButton.isEnabled()).toBe(false);
        const approvalBox = page.getByLabel(
          'I reviewed the saved recipient, subject, email body, and attachments and approve sending this application.',
          { exact: true },
        );
        await approvalBox.check();
        expect(await approveButton.isEnabled()).toBe(true);
        await page
          .getByLabel('Email body', { exact: true })
          .fill('Changed draft requires another save and approval.');
        expect(await approveButton.isEnabled()).toBe(false);
        await page
          .getByRole('button', { name: 'Save draft for review', exact: true })
          .click();
        await vi.waitFor(async () =>
          expect(
            (
              await db.emailMessage.findUniqueOrThrow({
                where: { applicationId },
              })
            ).revision,
          ).toBe(2),
        );
        await approvalBox.check();
        await approveButton.click();
        await page
          .getByText('Email queued. Waiting for the worker.', { exact: true })
          .waitFor();
        const message = await db.emailMessage.findUniqueOrThrow({
          where: { applicationId },
        });
        const provider: EmailProvider = {
          accessToken: async () => 'fixture',
          send: async () => 'ui-fixture-message',
        };
        await createEmailProcessor(
          db,
          provider,
          config,
          new LocalDocumentStorage(root),
        )({ data: { messageId: message.id, revision: message.revision } });
        await page
          .getByRole('button', { name: 'Refresh email status', exact: true })
          .click();
        await page
          .getByText('Application email sent', { exact: false })
          .first()
          .waitFor();
        await mkdir('docs/email-evidence', { recursive: true });
        await page.screenshot({
          path: 'docs/email-evidence/email-application-desktop.png',
          fullPage: true,
        });
        await page.setViewportSize({ width: 390, height: 844 });
        await page.screenshot({
          path: 'docs/email-evidence/email-application-mobile.png',
          fullPage: true,
        });
        expect(
          await page.evaluate(
            () => document.documentElement.scrollWidth <= window.innerWidth,
          ),
        ).toBe(true);
        expect(pageErrors).toEqual([]);
      } finally {
        await context.close();
        await browser.close();
      }
    },
    60000,
  );
});
