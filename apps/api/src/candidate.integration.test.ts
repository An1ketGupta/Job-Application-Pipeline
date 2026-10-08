import { randomUUID } from 'node:crypto';
import { mkdtemp, rm, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { beforeEach, afterEach, describe, expect, it } from 'vitest';
import type { Queue } from 'bullmq';
import { PrismaClient, Prisma } from '@careerlift/database';
import { PreparedApplicationSchema } from '@careerlift/domain';
import { createApp } from './app.js';
import { createToken } from './auth.js';
import { candidateSchema } from '../../../tests/support/candidate-fixture.js';
import { createPreparationProcessor } from '../../worker/src/preparation-processor.js';

const databaseUrl = process.env.INTEGRATION_DATABASE_URL;
if (databaseUrl && !/\/careerlift_test(?:\?|$)/.test(databaseUrl))
  throw new Error('Candidate tests require careerlift_test');
const suite = databaseUrl ? describe : describe.skip;
const secret = 'phase8-candidate-tests';
suite(
  'Phase 8 candidate APIs, ownership, and durable review integration',
  () => {
    const db = new PrismaClient({ datasourceUrl: databaseUrl! });
    let owner: string, stranger: string, folder: string, jobId: string;
    let queued: { name: string; data: { applicationId: string } }[] = [];
    let failQueue = false;
    let app: ReturnType<typeof createApp>;
    const headers = (id = owner) => ({
      authorization: `Bearer ${createToken(id, secret)}`,
    });
    const call = (
      method: 'GET' | 'POST' | 'PATCH' | 'DELETE',
      path: string,
      payload?: unknown,
      id = owner,
    ) =>
      app.inject({
        method,
        url: `/api/v1${path}`,
        headers: headers(id),
        ...(payload !== undefined
          ? { payload: payload as Record<string, unknown> }
          : {}),
      });
    beforeEach(async () => {
      const suffix = randomUUID();
      owner = `phase8-${suffix}`;
      stranger = `phase8-other-${suffix}`;
      jobId = `phase8-job-${suffix}`;
      folder = await mkdtemp(join(tmpdir(), 'careerlift-phase8-'));
      queued = [];
      failQueue = false;
      await db.user.createMany({
        data: [
          { id: owner, email: `${owner}@example.com` },
          { id: stranger, email: `${stranger}@example.com` },
        ],
      });
      await db.job.create({
        data: {
          id: jobId,
          source: 'LOCAL_TEST',
          externalId: suffix,
          company: 'Phase 8 Company',
          title: 'Phase 8 Engineer',
          requirements: [],
        },
      });
      app = createApp({
        db,
        authSecret: secret,
        documentRoot: folder,
        queue: {
          add: async (name: string, data: { applicationId: string }) => {
            if (failQueue) throw new Error('queue unavailable');
            queued.push({ name, data });
          },
        } as unknown as Queue,
      });
    });
    afterEach(async () => {
      await app.close();
      const where = { application: { userId: { in: [owner, stranger] } } };
      await db.applicationExecution.deleteMany({ where });
      await db.applicationPreparation.deleteMany({ where });
      await db.applicationInspection.deleteMany({ where });
      await db.applicationPlan.deleteMany({ where });
      await db.applicationEvent.deleteMany({
        where: {
          OR: [
            { actorId: { in: [owner, stranger] } },
            { application: { userId: { in: [owner, stranger] } } },
          ],
        },
      });
      await db.application.deleteMany({
        where: { userId: { in: [owner, stranger] } },
      });
      await db.userDocument.deleteMany({
        where: { userId: { in: [owner, stranger] } },
      });
      await db.verifiedAnswer.deleteMany({
        where: { userId: { in: [owner, stranger] } },
      });
      await db.applicationProfile.deleteMany({
        where: { userId: { in: [owner, stranger] } },
      });
      await db.user.deleteMany({ where: { id: { in: [owner, stranger] } } });
      await db.job.delete({ where: { id: jobId } });
      await rm(folder, { recursive: true, force: true });
    });
    async function upload(name = 'resume.pdf', type = 'RESUME') {
      const r = await call('POST', '/documents', {
        name,
        type,
        content: Buffer.from('%PDF-1.7\nPhase 8 Resume\n%%EOF').toString(
          'base64',
        ),
      });
      expect(r.statusCode, r.body).toBe(201);
      return r.json().document as {
        id: string;
        revision: number;
        name: string;
      };
    }
    async function seedProfile() {
      const r = await call('PATCH', '/profile', {
        revision: 0,
        data: { fullName: 'Ada Candidate', email: 'application@example.com' },
      });
      expect(r.statusCode, r.body).toBe(200);
      return r.json();
    }
    async function seedApplication(sensitiveGate = true) {
      const application = await db.application.create({
        data: { userId: owner, jobId, state: 'RESOLVED' },
      });
      const plan = await db.applicationPlan.create({
        data: {
          applicationId: application.id,
          applicationType: 'DIRECT_PORTAL',
          destination: { url: 'https://example.com/apply' },
          requirements: [],
          actions: [],
          executor: 'BROWSER',
          confidence: 0.95,
          requiresHumanReview: false,
          reasoning: ['local test'],
          resolvedBy: 'deterministic',
        },
      });
      const inspection = await db.applicationInspection.create({
        data: {
          applicationId: application.id,
          applicationPlanId: plan.id,
          state: sensitiveGate ? 'HUMAN_REQUIRED' : 'COMPLETED',
        },
      });
      await db.applicationInspection.update({
        where: { id: inspection.id },
        data: {
          result: candidateSchema(
            inspection.id,
            plan.id,
            'https://example.com',
            sensitiveGate,
          ),
        },
      });
      return application.id;
    }
    async function prepare(id: string) {
      const response = await call('POST', `/applications/${id}/prepare`);
      expect(response.statusCode, response.body).toBe(202);
      await runWorker(id);
      return db.applicationPreparation.findUniqueOrThrow({
        where: { applicationId: id },
      });
    }
    async function runWorker(id: string) {
      await createPreparationProcessor(db)({
        name: 'PREPARE_APPLICATION',
        data: { applicationId: id, requestId: randomUUID() },
      } as never);
    }
    async function answer(
      question = 'Years of experience with React?',
      value = '2',
    ) {
      const r = await call('POST', '/verified-answers', {
        question,
        value,
        userConfirmed: true,
      });
      expect(r.statusCode, r.body).toBe(201);
      return r.json().answer as { id: string; revision: number };
    }

    it('authenticates all candidate routes, creates/updates the single profile, prevents lost updates and client ownership', async () => {
      for (const path of [
        '/profile',
        '/documents',
        '/verified-answers',
        '/human-review',
      ])
        expect((await app.inject({ url: `/api/v1${path}` })).statusCode).toBe(
          401,
        );
      expect((await call('GET', '/profile')).json().revision).toBe(0);
      const profile = await seedProfile();
      expect(
        (await call('GET', '/profile', undefined, stranger)).json().data
          .fullName,
      ).toBeUndefined();
      expect(
        (
          await call('PATCH', '/profile', {
            revision: 1,
            userId: stranger,
            data: { fullName: 'stolen' },
          })
        ).statusCode,
      ).toBe(400);
      const updates = await Promise.all(
        ['Ada A', 'Ada B'].map((fullName) =>
          call('PATCH', '/profile', {
            revision: profile.revision,
            data: {
              ...profile.data,
              fullName,
              headline: 'Engineer',
              summary: 'React engineer',
              yearsOfExperience: 2,
              github: 'https://github.com/ada',
            },
          }),
        ),
      );
      expect(updates.map((r) => r.statusCode).sort()).toEqual([200, 409]);
      expect(
        await db.applicationProfile.count({ where: { userId: owner } }),
      ).toBe(1);
      expect(
        await db.applicationEvent.count({
          where: { actorId: owner, type: 'PROFILE_UPDATED' },
        }),
      ).toBe(2);
      for (const data of [
        { email: 'invalid' },
        { website: 'file:///etc/passwd' },
        { workAuthorization: 'LLM inferred' },
        { yearsOfExperience: -1 },
      ])
        expect(
          (await call('PATCH', '/profile', { revision: 2, data })).statusCode,
        ).toBe(400);
    });
    it.each(['experience', 'education'] as const)(
      'supports %s CRUD with validation, revision checks, and owner scoping',
      async (section) => {
        await seedProfile();
        const entry = {
          id: randomUUID(),
          category: section === 'experience' ? 'EXPERIENCE' : 'EDUCATION',
          text:
            section === 'experience' ? 'Engineer at Acme' : 'BSc at University',
          ...(section === 'experience'
            ? {
                company: 'Acme',
                title: 'Engineer',
                achievements: ['Built application UI'],
              }
            : {
                institution: 'University',
                degree: 'BSc',
                fieldOfStudy: 'Computer Science',
              }),
          startDate: '2022-01-01',
          endDate: '2024-01-01',
        };
        expect(
          (await call('POST', `/profile/${section}`, { revision: 1, entry }))
            .statusCode,
        ).toBe(200);
        expect(
          (await call('GET', `/profile/${section}`)).json().entries,
        ).toHaveLength(1);
        expect(
          (
            await call(
              'PATCH',
              `/profile/${section}/${entry.id}`,
              { revision: 0, entry },
              stranger,
            )
          ).statusCode,
        ).toBe(404);
        expect(
          (
            await call('PATCH', `/profile/${section}/${entry.id}`, {
              revision: 2,
              entry: { ...entry, text: 'Updated evidence' },
            })
          ).statusCode,
        ).toBe(200);
        expect(
          (
            await call('PATCH', `/profile/${section}/${entry.id}`, {
              revision: 3,
              entry: { ...entry, endDate: '2021-01-01' },
            })
          ).statusCode,
        ).toBe(400);
        expect(
          (
            await call(
              'DELETE',
              `/profile/${section}/${entry.id}`,
              { revision: 3 },
              stranger,
            )
          ).statusCode,
        ).toBe(404);
        expect(
          (
            await call('DELETE', `/profile/${section}/${entry.id}`, {
              revision: 3,
            })
          ).statusCode,
        ).toBe(200);
        expect(
          (await call('GET', `/profile/${section}`)).json().entries,
        ).toEqual([]);
      },
    );
    it('uploads validated bytes through existing storage, downloads safely, renames and archives with history retained', async () => {
      const doc = await upload();
      const listed = await call('GET', '/documents');
      expect(listed.body).not.toContain('storageRef');
      expect(listed.body).not.toContain(folder);
      expect(listed.body).not.toContain('contentDigest');
      expect(
        (await call('GET', '/documents', undefined, stranger)).json().documents,
      ).toEqual([]);
      for (const method of ['PATCH', 'DELETE', 'GET'] as const)
        expect(
          (
            await call(
              method,
              `/documents/${doc.id}${method === 'GET' ? '/content' : ''}`,
              method === 'GET'
                ? undefined
                : { revision: 1, name: 'stolen.pdf' },
              stranger,
            )
          ).statusCode,
        ).toBe(404);
      expect(
        (await call('GET', `/documents/${doc.id}/content`)).headers[
          'content-disposition'
        ],
      ).toContain('attachment');
      expect(
        (
          await call('PATCH', `/documents/${doc.id}`, {
            revision: 1,
            name: '../evil.pdf',
          })
        ).statusCode,
      ).toBe(400);
      expect(
        (
          await call('PATCH', `/documents/${doc.id}`, {
            revision: 1,
            name: 'resume.txt',
          })
        ).statusCode,
      ).toBe(400);
      expect(
        (
          await call('PATCH', `/documents/${doc.id}`, {
            revision: 1,
            name: 'renamed.pdf',
            isDefault: true,
          })
        ).statusCode,
      ).toBe(200);
      expect(
        (await call('DELETE', `/documents/${doc.id}`, { revision: 2 }))
          .statusCode,
      ).toBe(200);
      const stored = await db.userDocument.findUniqueOrThrow({
        where: { id: doc.id },
      });
      expect(stored.archivedAt).not.toBeNull();
      expect(stored.isDefault).toBe(false);
      expect(
        await readFile(
          join(folder, stored.storageRef.replace('local://', '')),
          'utf8',
        ),
      ).toContain('Phase 8 Resume');
      expect(
        (await call('GET', `/documents/${doc.id}/content`)).statusCode,
      ).toBe(404);
      expect(
        (
          await call('PATCH', `/documents/${doc.id}`, {
            revision: 3,
            isDefault: true,
          })
        ).statusCode,
      ).toBe(409);
      expect(
        (
          await call('PATCH', `/documents/${doc.id}`, {
            revision: 3,
            archived: false,
          })
        ).statusCode,
      ).toBe(200);
      expect(
        (await call('GET', `/documents/${doc.id}/content`)).statusCode,
      ).toBe(200);
    });
    it('rejects path traversal, spoofed types/content, client ownership/storage keys, malformed and oversized uploads', async () => {
      const good = {
        name: 'resume.pdf',
        type: 'RESUME',
        content: Buffer.from('%PDF-1.7\nvalid').toString('base64'),
      };
      for (const name of [
        '../resume.pdf',
        '..\\resume.pdf',
        'C:\\resume.pdf',
        'file:resume.pdf',
        'CON.pdf',
        'x.exe',
        'x.html',
        'x.pdf\r\nSet-Cookie: stolen',
      ])
        expect(
          (await call('POST', '/documents', { ...good, name })).statusCode,
        ).toBe(400);
      for (const changes of [
        { type: 'EXECUTABLE' },
        { userId: stranger },
        { storageRef: 'local://../../secrets' },
        { content: '' },
        { content: '%%%%' },
        { content: Buffer.from('executable').toString('base64') },
        {
          name: 'resume.txt',
          content: Buffer.from([0, 1, 2]).toString('base64'),
        },
      ])
        expect(
          (await call('POST', '/documents', { ...good, ...changes }))
            .statusCode,
        ).toBe(400);
      const huge = await call('POST', '/documents', {
        ...good,
        content: Buffer.alloc(10 * 1024 * 1024 + 1, 65).toString('base64'),
      });
      expect([400, 413]).toContain(huge.statusCode);
      expect(await db.userDocument.count({ where: { userId: owner } })).toBe(0);
    });
    it('keeps one default per type under concurrent selection and rejects stale document changes', async () => {
      const a = await upload('a.pdf'),
        b = await upload('b.pdf');
      const selected = await Promise.all(
        [a, b].map((d) =>
          call('PATCH', `/documents/${d.id}`, { revision: 1, isDefault: true }),
        ),
      );
      expect(selected.every((r) => [200, 409].includes(r.statusCode))).toBe(
        true,
      );
      expect(
        await db.userDocument.count({
          where: { userId: owner, isDefault: true, archivedAt: null },
        }),
      ).toBe(1);
      const current = await db.userDocument.findFirstOrThrow({
        where: { userId: owner, isDefault: true },
      });
      expect(
        (
          await call('PATCH', `/documents/${current.id}`, {
            revision: 1,
            name: 'stale.pdf',
          })
        ).statusCode,
      ).toBe(409);
    });
    it('requires explicit user verification, supports exact-question updates/deactivation and prevents cross-user answers', async () => {
      const body = {
        question: 'Are you authorized to work in the US?',
        value: 'Yes',
      };
      for (const extra of [
        {},
        { userConfirmed: false },
        { userConfirmed: true, source: 'LLM_GENERATED' },
        { userConfirmed: true, userId: stranger },
        { userConfirmed: true, category: 'OTHER_SENSITIVE' },
      ])
        expect(
          (await call('POST', '/verified-answers', { ...body, ...extra }))
            .statusCode,
        ).toBe(400);
      const a = await answer(body.question, body.value);
      const listed = await call('GET', '/verified-answers');
      expect(listed.json().answers[0].category).toBe('WORK_AUTHORIZATION');
      expect(listed.json().answers[0].verified).toBe(true);
      expect(listed.body).not.toContain('userId');
      expect(
        (await call('GET', '/verified-answers', undefined, stranger)).json()
          .answers,
      ).toEqual([]);
      expect(
        (
          await call(
            'PATCH',
            `/verified-answers/${a.id}`,
            { revision: 1, value: 'No', userConfirmed: true },
            stranger,
          )
        ).statusCode,
      ).toBe(404);
      expect(
        (
          await call('PATCH', `/verified-answers/${a.id}`, {
            revision: 1,
            value: 'No',
          })
        ).statusCode,
      ).toBe(400);
      expect(
        (
          await call('PATCH', `/verified-answers/${a.id}`, {
            revision: 1,
            value: 'No',
            userConfirmed: true,
          })
        ).statusCode,
      ).toBe(200);
      expect(
        (
          await call('PATCH', `/verified-answers/${a.id}`, {
            revision: 2,
            active: false,
          })
        ).statusCode,
      ).toBe(200);
      expect(
        (
          await call('PATCH', `/verified-answers/${a.id}`, {
            revision: 3,
            active: true,
          })
        ).statusCode,
      ).toBe(400);
      const react = await answer();
      const ts = await answer('Years of experience with TypeScript?', '3');
      expect(react.id).not.toBe(ts.id);
      expect(
        (
          await call('POST', '/verified-answers', {
            question: '  YEARS of experience with React? ',
            value: '4',
            userConfirmed: true,
          })
        ).statusCode,
      ).toBe(409);
    });
    it('runs profile/documents/answers through preparation, retrieves safe reviews, resolves idempotently and retains immutable snapshots', async () => {
      await seedProfile();
      const doc = await upload();
      await answer();
      const id = await seedApplication();
      const prep = await prepare(id);
      expect(prep.state).toBe('HUMAN_REQUIRED');
      const result = PreparedApplicationSchema.parse(prep.result);
      expect(result.documents[0]?.documentId).toBe(doc.id);
      expect(
        result.questions.find((q) => q.questionId === 'react')?.answer,
      ).toBe('2');
      const review = await call('GET', `/human-review/${id}`);
      expect(review.json().review.items).toHaveLength(1);
      expect(review.json().review.items[0].type).toBe('SENSITIVE_QUESTION');
      expect(review.json().review.canResumePreparation).toBe(true);
      for (const forbidden of [
        'inputSnapshot',
        'storageRef',
        'executionFlow',
        'runId',
        'contentDigest',
        'inspectionMetadata',
        'securitySnapshot',
      ])
        expect(review.body).not.toContain(forbidden);
      for (const path of [`/human-review/${id}`, `/applications/${id}`])
        expect((await call('GET', path, undefined, stranger)).statusCode).toBe(
          404,
        );
      expect(
        (await call('GET', '/human-review', undefined, stranger)).json()
          .reviews,
      ).toEqual([]);
      const decision = {
        requirementId: 'sponsorship',
        version: prep.version,
        key: randomUUID(),
        action: 'ANSWER',
        value: 'No',
        userConfirmed: true,
      };
      expect(
        (await call('POST', `/human-review/${id}/resolve`, decision, stranger))
          .statusCode,
      ).toBe(404);
      expect(
        (
          await call('POST', `/human-review/${id}/resolve`, {
            ...decision,
            value: 'Maybe',
          })
        ).statusCode,
      ).toBe(400);
      expect(
        (
          await call('POST', `/human-review/${id}/resolve`, {
            ...decision,
            userId: stranger,
          })
        ).statusCode,
      ).toBe(400);
      expect(
        (await call('POST', `/human-review/${id}/resolve`, decision))
          .statusCode,
      ).toBe(200);
      const savedImmediately = await db.verifiedAnswer.findFirst({
        where: { userId: owner, category: 'SPONSORSHIP' },
      });
      expect(savedImmediately).toMatchObject({
        value: 'No',
        source: 'USER_VERIFIED',
        active: true,
      });
      expect(
        (await call('POST', `/human-review/${id}/resolve`, decision)).json()
          .replayed,
      ).toBe(true);
      expect(
        (
          await call('POST', `/human-review/${id}/resolve`, {
            ...decision,
            value: 'Yes',
          })
        ).statusCode,
      ).toBe(409);
      expect(
        (
          await call('POST', `/human-review/${id}/resolve`, {
            ...decision,
            key: randomUUID(),
          })
        ).statusCode,
      ).toBe(409);
      await runWorker(id);
      const complete = await db.applicationPreparation.findUniqueOrThrow({
        where: { applicationId: id },
      });
      expect(complete.state).toBe('COMPLETED');
      expect(complete.version).toBe(2);
      expect(
        (
          await db.applicationInspection.findUniqueOrThrow({
            where: { applicationId: id },
          })
        ).state,
      ).toBe('COMPLETED');
      expect(
        PreparedApplicationSchema.parse(complete.result).questions[0]?.source,
      ).toBe('USER_VERIFIED');
      expect(queued.every((q) => q.name === 'PREPARE_APPLICATION')).toBe(true);
      expect(
        await db.applicationExecution.count({ where: { applicationId: id } }),
      ).toBe(0);
      const before = await db.applicationEvent.findMany({
        where: { applicationId: id, type: 'PREPARATION_SNAPSHOT' },
        orderBy: { createdAt: 'asc' },
      });
      expect(before).toHaveLength(2);
      expect(
        (
          await call('PATCH', '/profile', {
            revision: 1,
            data: { fullName: 'Changed Candidate' },
          })
        ).statusCode,
      ).toBe(200);
      expect(
        (
          await call('PATCH', `/documents/${doc.id}`, {
            revision: 1,
            name: 'changed.pdf',
          })
        ).statusCode,
      ).toBe(200);
      const after = await db.applicationPreparation.findUniqueOrThrow({
        where: { applicationId: id },
      });
      expect(after.result).toEqual(complete.result);
      expect(after.inputSnapshot).toEqual(complete.inputSnapshot);
      expect(
        await db.applicationEvent.findMany({
          where: { applicationId: id, type: 'PREPARATION_SNAPSHOT' },
          orderBy: { createdAt: 'asc' },
        }),
      ).toEqual(before);
      const detail = await call('GET', `/applications/${id}`);
      expect(detail.json().application.humanReviewRequired).toBe(false);
      expect(
        detail
          .json()
          .application.timeline.some(
            (e: { label: string }) => e.label === 'Human review decision saved',
          ),
      ).toBe(true);
      expect(
        (
          await call('POST', `/human-review/${id}/resolve`, {
            ...decision,
            key: randomUUID(),
            version: 2,
          })
        ).statusCode,
      ).toBe(409);
    });
    it('rechecks existing review items with Gemini and accepts supported sensitive answers without marking them user verified', async () => {
      await seedProfile();
      await call('PATCH', '/profile', {
        revision: 1,
        data: {
          fullName: 'Ada Candidate',
          email: 'application@example.com',
          summary: 'I do not require employer visa sponsorship.',
        },
      });
      await call('POST', '/documents', {
        name: 'selected.txt',
        type: 'RESUME',
        content: Buffer.from(
          'Ada Candidate. I do not require employer visa sponsorship.',
        ).toString('base64'),
      });
      await answer();
      const id = await seedApplication();
      const inspection = await db.applicationInspection.findUniqueOrThrow({
        where: { applicationId: id },
      });
      const schema = inspection.result as unknown as ReturnType<
        typeof candidateSchema
      >;
      schema.documents[0]!.acceptedFileTypes = ['.txt'];
      await db.applicationInspection.update({
        where: { id: inspection.id },
        data: { result: schema as unknown as Prisma.InputJsonValue },
      });
      const first = await prepare(id);
      expect(first.state).toBe('HUMAN_REQUIRED');
      let calls = 0;
      const provider = {
        name: 'controlled',
        generateAnswer: async () => {
          throw new Error('No single calls');
        },
        generateAnswers: async (
          batch: import('@careerlift/domain').AnswerBatchInput,
        ) => {
          calls++;
          expect(batch.resume.text).toContain('sponsorship');
          return {
            answers: batch.questions.map((question) => ({
              id: question.id,
              answer: 'No',
              confidence: 0.75,
              supportedBySavedInformation: true,
              conflictingInformation: false,
              requiresHumanReview: false,
              evidence: [
                {
                  evidenceId: 'profile:summary',
                  quote: 'do not require employer visa sponsorship',
                },
              ],
              explanation: 'Explicit saved candidate statement.',
            })),
          };
        },
      };
      const recheckApp = createApp({
        db,
        authSecret: secret,
        documentRoot: folder,
        answerProvider: provider,
        queue: { add: async () => {} } as unknown as Queue,
      });
      try {
        const payload = { version: first.version, key: randomUUID() };
        expect(
          (
            await recheckApp.inject({
              method: 'POST',
              url: `/api/v1/human-review/${id}/recheck`,
              headers: headers(stranger),
              payload,
            })
          ).statusCode,
        ).toBe(404);
        expect(
          (
            await recheckApp.inject({
              method: 'POST',
              url: `/api/v1/human-review/${id}/recheck`,
              headers: headers(),
              payload,
            })
          ).statusCode,
        ).toBe(200);
        expect(
          (
            await recheckApp.inject({
              method: 'POST',
              url: `/api/v1/human-review/${id}/recheck`,
              headers: headers(),
              payload,
            })
          ).statusCode,
        ).toBe(200);
        await createPreparationProcessor(db, provider, {
          confidenceThreshold: 0.75,
          documentRoot: folder,
        })({
          name: 'PREPARE_APPLICATION',
          data: { applicationId: id, requestId: randomUUID() },
        } as never);
        const result = await db.applicationPreparation.findUniqueOrThrow({
          where: { applicationId: id },
        });
        expect(result.state).toBe('COMPLETED');
        expect(result.version).toBe(first.version + 1);
        expect(calls).toBe(1);
        expect(
          PreparedApplicationSchema.parse(result.result).questions.find(
            (question) => question.questionId === 'sponsorship',
          ),
        ).toMatchObject({
          source: 'LLM_GENERATED',
          answer: 'No',
          confidence: 0.75,
          requiresHumanReview: false,
        });
        expect(
          (
            await db.applicationInspection.findUniqueOrThrow({
              where: { applicationId: id },
            })
          ).state,
        ).toBe('COMPLETED');
        expect(
          await db.verifiedAnswer.count({
            where: { userId: owner, category: 'SPONSORSHIP' },
          }),
        ).toBe(0);
      } finally {
        await recheckApp.close();
      }
    });
    it('confirms a proposal only with explicit consent and never accepts a client replacement under CONFIRM', async () => {
      await seedProfile();
      await upload();
      await answer();
      const id = await seedApplication(),
        prep = await prepare(id);
      const proposed = PreparedApplicationSchema.parse(prep.result);
      proposed.questions[0]!.answer = 'No';
      proposed.questions[0]!.source = 'LLM_GENERATED';
      await db.applicationPreparation.update({
        where: { id: prep.id },
        data: { result: proposed },
      });
      const body = {
        requirementId: 'sponsorship',
        version: prep.version,
        key: randomUUID(),
        action: 'CONFIRM',
        userConfirmed: true,
      };
      expect(
        (
          await call('POST', `/human-review/${id}/resolve`, {
            ...body,
            userConfirmed: false,
          })
        ).statusCode,
      ).toBe(400);
      expect(
        (
          await call('POST', `/human-review/${id}/resolve`, {
            ...body,
            value: 'Yes',
          })
        ).statusCode,
      ).toBe(400);
      expect(
        (await call('POST', `/human-review/${id}/resolve`, body)).statusCode,
      ).toBe(200);
      expect(
        (await call('POST', `/human-review/${id}/resolve`, body)).json()
          .replayed,
      ).toBe(true);
      await runWorker(id);
      const complete = await db.applicationPreparation.findUniqueOrThrow({
        where: { id: prep.id },
      });
      expect(complete.state).toBe('COMPLETED');
      expect(
        PreparedApplicationSchema.parse(complete.result).questions[0],
      ).toMatchObject({
        answer: 'No',
        source: 'USER_VERIFIED',
        requiresHumanReview: false,
      });
      expect(
        await db.verifiedAnswer.count({
          where: { userId: owner, category: 'SPONSORSHIP' },
        }),
      ).toBe(1);
    });
    it('ignores generated and deactivated stored answers during preparation', async () => {
      await seedProfile();
      await upload();
      const react = await answer(),
        sponsorship = await answer('Will you require sponsorship?', 'No');
      await db.verifiedAnswer.update({
        where: { id: sponsorship.id },
        data: { source: 'LLM_GENERATED' },
      });
      expect(
        (await call('GET', '/verified-answers'))
          .json()
          .answers.find((a: { id: string }) => a.id === sponsorship.id)
          .verified,
      ).toBe(false);
      expect(
        (
          await call('PATCH', `/verified-answers/${react.id}`, {
            revision: 1,
            active: false,
          })
        ).statusCode,
      ).toBe(200);
      const prep = await prepare(await seedApplication());
      const result = PreparedApplicationSchema.parse(prep.result);
      expect(prep.state).toBe('HUMAN_REQUIRED');
      expect(result.questions.every((q) => q.answer === null)).toBe(true);
      expect(result.humanReviewItems).toHaveLength(2);
    });
    it('uploads UTF-8 cover letters and restores archived documents without losing owned bytes', async () => {
      const content = Buffer.from('Dear hiring team,\nI would like to apply.');
      const uploaded = await call('POST', '/documents', {
        name: 'cover-letter.txt',
        type: 'COVER_LETTER',
        content: content.toString('base64'),
      });
      expect(uploaded.statusCode).toBe(201);
      const doc = uploaded.json().document;
      expect(doc.mimeType).toBe('text/plain');
      expect(
        (await call('DELETE', `/documents/${doc.id}`, { revision: 1 }))
          .statusCode,
      ).toBe(200);
      expect(
        (await call('GET', `/documents/${doc.id}/content`)).statusCode,
      ).toBe(404);
      expect(
        (
          await call('PATCH', `/documents/${doc.id}`, {
            revision: 2,
            archived: false,
          })
        ).statusCode,
      ).toBe(200);
      expect(
        (await call('GET', `/documents/${doc.id}/content`)).rawPayload,
      ).toEqual(content);
      expect(
        (
          await call('POST', '/documents', {
            name: 'bad.txt',
            type: 'OTHER',
            content: Buffer.from([0xff, 0x00]).toString('base64'),
          })
        ).statusCode,
      ).toBe(400);
    });
    it('supports explicit rejection and replacement while preserving pending review, audit and guarded version transitions', async () => {
      await seedProfile();
      await upload();
      await answer();
      const id = await seedApplication(false);
      const prep = await prepare(id);
      const proposed = PreparedApplicationSchema.parse(prep.result);
      proposed.questions[0]!.answer = 'Yes';
      proposed.questions[0]!.source = 'LLM_GENERATED';
      await db.applicationPreparation.update({
        where: { id: prep.id },
        data: { result: proposed },
      });
      const decision = {
        requirementId: 'sponsorship',
        version: 1,
        key: randomUUID(),
        action: 'REJECT',
        userConfirmed: true,
      };
      expect(
        (await call('POST', `/human-review/${id}/reject`, decision, stranger))
          .statusCode,
      ).toBe(404);
      expect(
        (await call('POST', `/human-review/${id}/reject`, decision)).statusCode,
      ).toBe(200);
      expect(
        (await call('POST', `/human-review/${id}/reject`, decision)).json()
          .replayed,
      ).toBe(true);
      expect(
        (await call('GET', `/human-review/${id}`)).json().review.items[0]
          .status,
      ).toBe('REJECTED');
      expect(
        (
          await db.applicationPreparation.findUniqueOrThrow({
            where: { id: prep.id },
          })
        ).state,
      ).toBe('HUMAN_REQUIRED');
      expect(
        (
          await call('POST', `/human-review/${id}/resolve`, {
            ...decision,
            key: randomUUID(),
            version: 2,
            action: 'ANSWER',
            value: 'No',
          })
        ).statusCode,
      ).toBe(200);
      await runWorker(id);
      expect(
        (
          await db.applicationPreparation.findUniqueOrThrow({
            where: { id: prep.id },
          })
        ).state,
      ).toBe('COMPLETED');
      expect(
        await db.applicationEvent.count({
          where: {
            applicationId: id,
            type: 'HUMAN_REVIEW_REJECTED',
            actorId: owner,
          },
        }),
      ).toBe(1);
    });
    it('validates document-selection reviews with ownership, type/content, archive, and explicit defaults', async () => {
      await seedProfile();
      await answer();
      await answer('Will you require sponsorship?', 'No');
      const a = await upload('a.pdf'),
        b = await upload('b.pdf');
      const id = await seedApplication(false),
        prep = await prepare(id);
      expect(
        PreparedApplicationSchema.parse(prep.result).documents[0]?.documentId,
      ).toBeNull();
      const decision = {
        requirementId: 'resume',
        version: 1,
        key: randomUUID(),
        action: 'SELECT_DOCUMENT',
        documentId: a.id,
        userConfirmed: true,
      };
      const foreign = await db.userDocument.create({
        data: {
          userId: stranger,
          type: 'RESUME',
          name: 'foreign.pdf',
          mimeType: 'application/pdf',
          size: 3,
          storageRef: 'local://foreign.pdf',
        },
      });
      expect(
        (
          await call('POST', `/human-review/${id}/resolve`, {
            ...decision,
            documentId: foreign.id,
          })
        ).statusCode,
      ).toBe(404);
      expect(
        (
          await call('PATCH', `/documents/${b.id}`, {
            revision: 1,
            archived: true,
          })
        ).statusCode,
      ).toBe(200);
      expect(
        (
          await call('POST', `/human-review/${id}/resolve`, {
            ...decision,
            documentId: b.id,
          })
        ).statusCode,
      ).toBe(404);
      expect(
        (await call('POST', `/human-review/${id}/resolve`, decision))
          .statusCode,
      ).toBe(200);
      await runWorker(id);
      expect(
        PreparedApplicationSchema.parse(
          (
            await db.applicationPreparation.findUniqueOrThrow({
              where: { id: prep.id },
            })
          ).result,
        ).documents[0]?.documentId,
      ).toBe(a.id);
    });
    it('preserves durable decisions through queue failure and permits existing preparation retry without submission', async () => {
      await seedProfile();
      await upload();
      await answer();
      const id = await seedApplication();
      const prep = await prepare(id);
      failQueue = true;
      const decision = {
        requirementId: 'sponsorship',
        version: 1,
        key: randomUUID(),
        action: 'ANSWER',
        value: 'No',
        userConfirmed: true,
      };
      expect(
        (await call('POST', `/human-review/${id}/resolve`, decision))
          .statusCode,
      ).toBe(503);
      const saved = await db.applicationPreparation.findUniqueOrThrow({
        where: { id: prep.id },
      });
      expect(saved.state).toBe('FAILED');
      expect(saved.reviewDecisions as Prisma.JsonArray).toHaveLength(1);
      failQueue = false;
      await prepare(id);
      expect(
        (
          await db.applicationPreparation.findUniqueOrThrow({
            where: { id: prep.id },
          })
        ).state,
      ).toBe('COMPLETED');
      expect(
        await db.applicationExecution.count({ where: { applicationId: id } }),
      ).toBe(0);
    });
    it.each([
      'CAPTCHA',
      'AUTHENTICATION_REQUIRED',
      'INTERACTIVE_DISCOVERY_REQUIRED',
    ] as const)(
      'cannot clear %s through candidate review or preparation',
      async (reason) => {
        const id = await seedApplication();
        const inspection = await db.applicationInspection.findUniqueOrThrow({
          where: { applicationId: id },
        });
        const schema = candidateSchema(
          inspection.id,
          inspection.applicationPlanId,
          'https://example.com',
          true,
        );
        schema.humanReview.reasons.push(reason);
        await db.applicationInspection.update({
          where: { id: inspection.id },
          data: { result: schema },
        });
        expect(
          (await call('POST', `/applications/${id}/prepare`)).statusCode,
        ).toBe(409);
        const review = await call('GET', `/human-review/${id}`);
        expect(
          review
            .json()
            .review.blockers.some((b: { type: string }) => b.type === reason),
        ).toBe(true);
        expect(
          (
            await call('POST', `/human-review/${id}/resolve`, {
              requirementId: reason,
              version: 1,
              key: randomUUID(),
              action: 'ANSWER',
              value: 'continue',
              userConfirmed: true,
            })
          ).statusCode,
        ).toBe(404);
        expect(
          (
            await db.applicationInspection.findUniqueOrThrow({
              where: { id: inspection.id },
            })
          ).state,
        ).toBe('HUMAN_REQUIRED');
      },
    );
  },
);
