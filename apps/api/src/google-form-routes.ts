import type { FastifyInstance } from 'fastify';
import type { Queue } from 'bullmq';
import { z } from 'zod';
import {
  Prisma,
  type PrismaClient,
  saveReviewedAnswer,
  googleCandidateInput,
  googleCandidateInclude,
} from '@careerlift/database';
import {
  GoogleFormSnapshotSchema,
  GoogleFormSummarySchema,
  googleFormIdentity,
  validGoogleAnswer,
  googleDocumentCandidates,
  UserDocumentSchema,
} from '@careerlift/domain';
import { authenticateBearer } from './auth.js';

export type GoogleFormDependencies = {
  db?: PrismaClient;
  queue?: Queue;
  authSecret?: string;
  googleFormsEnabled?: boolean;
  googleFormsAccount?: string;
  googleFormsFixtureOrigin?: string;
};
export const googleFormRunSelect = {
  state: true,
  version: true,
  page: true,
  snapshot: true,
  errorCode: true,
  updatedAt: true,
  submittedAt: true,
  test: true,
} as const;
export function googleFormError(error: unknown) {
  return error instanceof Error &&
    /^(GOOGLE_FORMS_[A-Z_]+|APPLICATION_NOT_FOUND)$/.test(error.message)
    ? error.message
    : 'GOOGLE_FORMS_UNAVAILABLE';
}
export function googleFormsDestination(
  dependencies: GoogleFormDependencies,
  value: unknown,
) {
  if (googleFormIdentity(value)) return true;
  try {
    return (
      typeof value === 'string' &&
      Boolean(dependencies.googleFormsFixtureOrigin) &&
      new URL(value).origin === dependencies.googleFormsFixtureOrigin
    );
  } catch {
    return false;
  }
}
export function googleFormSummary(row: {
  state: string;
  version: number;
  page: number;
  snapshot: unknown;
  errorCode: string | null;
  updatedAt: Date;
  submittedAt: Date | null;
  test: boolean;
}) {
  const snapshot = GoogleFormSnapshotSchema.safeParse(row.snapshot);
  const explanations: Record<string, string> = {
    GOOGLE_FORMS_SESSION_LOST:
      'The browser session was lost. Restart to restore saved answers and re-inspect the form.',
    GOOGLE_FORMS_REPLAY_UNAVAILABLE:
      'This older run did not save earlier section answers. Restart to inspect the form again using your current profile and verified answers.',
    GOOGLE_FORMS_UNEXPECTED_HOST:
      'The form requested an unsupported network host. Saved answers are retained; restart to retry, or inspect the open browser.',
    GOOGLE_FORMS_SECTION_DID_NOT_ADVANCE:
      'The form did not advance. Inspect any validation message in the visible browser, then continue.',
    GOOGLE_FORMS_ACCOUNT_MISMATCH:
      'Switch to the configured Google account in the visible browser.',
    GOOGLE_FORMS_AUTHENTICATION_REQUIRED:
      'Connect your Google account or sign in in the visible browser, then continue.',
    GOOGLE_FORMS_CAPTCHA:
      'Complete the security challenge yourself in the visible browser, then continue.',
    GOOGLE_FORMS_FORM_CHANGED:
      'The form changed. Start again to inspect it and review the new questions.',
    GOOGLE_FORMS_INPUT_CHANGED:
      'Your profile, answers, documents, or Google session changed. Start again to prepare current information.',
    GOOGLE_FORMS_VALIDATION_FAILED:
      'A form validation rule was not satisfied. Inspect the field in the visible browser.',
    GOOGLE_FORMS_AI_UNAVAILABLE:
      'AI answer generation is unavailable. Provide the missing answers or check the configured provider.',
    GOOGLE_FORMS_QUEUE_UNAVAILABLE:
      'The worker queue is unavailable. Start again when it is running.',
    GOOGLE_FORMS_DOCUMENT_REAPPROVAL_REQUIRED:
      'Re-upload the selected document to establish its content identity.',
    GOOGLE_FORMS_UPLOAD_REQUIRES_BROWSER:
      'This upload control needs action in the visible browser. Complete it there, then continue.',
    GOOGLE_FORMS_UPLOAD_NOT_CONFIRMED:
      'The document upload was not confirmed. Complete or inspect it in the visible browser, then continue.',
    GOOGLE_FORMS_UNAPPROVED_MUTATION:
      'Google requested a write this workflow could not authorize. Automation stopped before granting submission authority.',
    GOOGLE_FORMS_UNAPPROVED_VALUE:
      'The form submission fields could not be matched to the prepared answers. Nothing was sent. Re-inspect and restart the form.',
    GOOGLE_FORMS_UNEXPECTED_FORM_FIELD:
      'The form has an unsupported submission field. Nothing was sent. Re-inspect and restart after the form handler is updated.',
    GOOGLE_FORMS_SUBMISSION_NOT_DISPATCHED:
      'The submission was blocked before any response was sent. Re-inspect and restart the form.',
    GOOGLE_FORMS_OUTCOME_UNKNOWN:
      'Submission was attempted, but acceptance could not be established. Check the employer form manually; automatic resubmission is blocked.',
  };
  return GoogleFormSummarySchema.parse({
    state: row.state,
    version: row.version,
    page: row.page,
    title: snapshot.success ? snapshot.data.title : '',
    issue: row.errorCode
      ? (explanations[row.errorCode] ??
        'The Google Forms workflow stopped. Inspect the visible browser or restart before submission.')
      : null,
    updatedAt: row.updatedAt.toISOString(),
    submittedAt: row.submittedAt?.toISOString() ?? null,
    test: row.test,
  });
}
export async function enqueueGoogleForm(
  queue: Queue,
  run: { id: string; version: number },
) {
  await queue.add(
    'GOOGLE_FORM_APPLICATION',
    { runId: run.id, version: run.version },
    {
      jobId: `google-form-${run.id}-${run.version}`,
      attempts: 1,
      removeOnComplete: true,
      removeOnFail: true,
    },
  );
}
export async function startGoogleForm(
  dependencies: GoogleFormDependencies,
  applicationId: string,
  userId: string,
) {
  const { db, queue } = dependencies;
  if (!dependencies.googleFormsEnabled || !db || !queue)
    throw new Error('GOOGLE_FORMS_UNAVAILABLE');
  const run = await db.$transaction(
    async (tx) => {
      const application = await tx.application.findFirst({
        where: { id: applicationId, userId },
        include: { job: true, googleFormRun: true, executions: true },
      });
      if (!application) throw new Error('APPLICATION_NOT_FOUND');
      const info = application.job.applicationInfo as { url?: string } | null;
      const fixture =
        dependencies.googleFormsFixtureOrigin &&
        info?.url &&
        new URL(info.url).origin === dependencies.googleFormsFixtureOrigin;
      if (!googleFormIdentity(info?.url) && !fixture)
        throw new Error('GOOGLE_FORMS_DESTINATION_REQUIRED');
      if (
        application.state === 'SUBMITTED' ||
        application.executions.some(
          (e) =>
            e.mode === 'REAL_EXECUTION' &&
            ['SUBMITTING', 'SUBMITTED', 'SUBMISSION_UNKNOWN'].includes(e.state),
        ) ||
        application.googleFormRun?.submitStartedAt
      )
        throw new Error('GOOGLE_FORMS_RESUBMISSION_BLOCKED');
      const previous = application.googleFormRun;
      if (previous && !['FAILED', 'BLOCKED'].includes(previous.state))
        return previous;
      const updated = previous
        ? await tx.googleFormRun.update({
            where: { id: previous.id },
            data: {
              state: 'PENDING',
              version: { increment: 1 },
              runId: null,
              ...([
                'GOOGLE_FORMS_FORM_CHANGED',
                'GOOGLE_FORMS_INPUT_CHANGED',
                'GOOGLE_FORMS_REPLAY_UNAVAILABLE',
              ].includes(previous.errorCode ?? '')
                ? { snapshot: Prisma.DbNull, page: 0 }
                : {}),
              errorCode: null,
            },
          })
        : await tx.googleFormRun.create({
            data: { applicationId, userId, test: Boolean(fixture) },
          });
      await tx.application.update({
        where: { id: applicationId },
        data: { state: 'RESOLVED' },
      });
      await tx.applicationEvent.create({
        data: {
          applicationId,
          jobId: application.jobId,
          actorId: userId,
          type: 'APPLICATION_ANALYSIS_STARTED',
          data: {
            workflow: 'GOOGLE_FORM',
            runId: updated.id,
            version: updated.version,
          },
          status: 'RESOLVED',
        },
      });
      return updated;
    },
    { isolationLevel: 'Serializable' },
  );
  if (run.state === 'PENDING') {
    try {
      await enqueueGoogleForm(queue, run);
    } catch {
      await db.googleFormRun.updateMany({
        where: { id: run.id, state: 'PENDING', version: run.version },
        data: { state: 'FAILED', errorCode: 'GOOGLE_FORMS_QUEUE_UNAVAILABLE' },
      });
      throw new Error('GOOGLE_FORMS_QUEUE_UNAVAILABLE');
    }
  }
  return run;
}
export function registerGoogleFormRoutes(
  app: FastifyInstance,
  dependencies: GoogleFormDependencies,
) {
  const account =
    dependencies.googleFormsAccount ?? 'guptaaniket600.ag@gmail.com';
  const params = z.object({ id: z.string().min(1).max(200) });
  const decision = z
    .object({
      version: z.number().int().positive(),
      questionId: z.string().min(1).max(300),
      value: z.union([
        z.string().max(10000),
        z.array(z.string().max(1000)).max(100),
        z.null(),
      ]),
      userConfirmed: z.literal(true),
    })
    .strict();
  const resumeBody = z
    .object({ version: z.number().int().positive() })
    .strict();
  const caller = (header: string | undefined) =>
    authenticateBearer(header, dependencies.authSecret);
  app.get('/api/v1/google-forms/reviews', async (request, reply) => {
    const userId = caller(request.headers.authorization);
    if (!userId) return reply.code(401).send({ error: 'UNAUTHENTICATED' });
    if (!dependencies.db)
      return reply.code(503).send({ error: 'DATABASE_UNAVAILABLE' });
    const query = z
      .object({ page: z.coerce.number().int().min(1).max(10000).default(1) })
      .strict()
      .safeParse(request.query);
    if (!query.success)
      return reply.code(400).send({ error: 'INVALID_REQUEST' });
    const rows = await dependencies.db.googleFormRun.findMany({
      where: {
        userId,
        state: {
          in: ['REVIEW', 'BROWSER_REQUIRED', 'UNKNOWN', 'BLOCKED', 'FAILED'],
        },
      },
      include: {
        application: {
          select: { job: { select: { company: true, title: true } } },
        },
      },
      take: 21,
      skip: (query.data.page - 1) * 20,
      orderBy: { updatedAt: 'desc' },
    });
    return {
      reviews: rows.slice(0, 20).map((row) => ({
        applicationId: row.applicationId,
        job: row.application.job,
        run: googleFormSummary(row),
      })),
      hasMore: rows.length > 20,
    };
  });
  app.get('/api/v1/google-forms/session', async (request, reply) => {
    const userId = caller(request.headers.authorization);
    if (!userId) return reply.code(401).send({ error: 'UNAUTHENTICATED' });
    const session = await dependencies.db?.googleFormSession.findUnique({
      where: { userId },
    });
    return {
      enabled: dependencies.googleFormsEnabled === true,
      expectedAccount: account,
      state: session?.state ?? 'DISCONNECTED',
      issue:
        session?.errorCode === 'GOOGLE_FORMS_ACCOUNT_MISMATCH'
          ? `The dedicated browser is signed in as a different account. Sign in as ${account} and confirm again.`
          : session?.errorCode === 'GOOGLE_FORMS_AUTHENTICATION_REQUIRED'
            ? `The dedicated browser is not signed in. Sign in as ${account} in that window, then confirm again.`
            : session?.errorCode
              ? 'The Google sign-in window could not be verified. Restart sign-in and try again.'
              : null,
    };
  });
  app.post('/api/v1/google-forms/session', async (request, reply) => {
    const userId = caller(request.headers.authorization);
    if (!userId) return reply.code(401).send({ error: 'UNAUTHENTICATED' });
    const body = z
      .object({ action: z.enum(['connect', 'confirm', 'disconnect']) })
      .strict()
      .safeParse(request.body);
    if (!body.success)
      return reply.code(400).send({ error: 'INVALID_REQUEST' });
    const { db, queue } = dependencies;
    if (!dependencies.googleFormsEnabled || !db || !queue)
      return reply.code(503).send({ error: 'GOOGLE_FORMS_UNAVAILABLE' });
    const current = await db.googleFormSession.findUnique({
      where: { userId },
    });
    if (body.data.action === 'confirm' && current?.state !== 'CONNECTING')
      return reply.code(409).send({ error: 'GOOGLE_FORMS_CONNECT_FIRST' });
    const session =
      body.data.action === 'confirm'
        ? current!
        : await db.googleFormSession.upsert({
            where: { userId },
            create: {
              userId,
              account,
              state:
                body.data.action === 'connect' ? 'CONNECTING' : 'DISCONNECTED',
            },
            update: {
              state:
                body.data.action === 'connect' ? 'CONNECTING' : 'DISCONNECTED',
              encryptedState: null,
              account,
              generation: { increment: 1 },
              errorCode: null,
            },
          });
    try {
      await queue.add(
        'GOOGLE_FORM_SESSION',
        { userId, generation: session.generation, action: body.data.action },
        { attempts: 1, removeOnComplete: true, removeOnFail: true },
      );
    } catch {
      await db.googleFormSession.updateMany({
        where: { userId, generation: session.generation },
        data: {
          state: 'DISCONNECTED',
          encryptedState: null,
          errorCode: 'GOOGLE_FORMS_QUEUE_UNAVAILABLE',
        },
      });
      return reply.code(503).send({ error: 'GOOGLE_FORMS_QUEUE_UNAVAILABLE' });
    }
    return reply.code(202).send({ state: session.state });
  });
  app.get('/api/v1/applications/:id/google-form', async (request, reply) => {
    const userId = caller(request.headers.authorization),
      parsed = params.safeParse(request.params);
    if (!userId) return reply.code(401).send({ error: 'UNAUTHENTICATED' });
    if (!parsed.success)
      return reply.code(400).send({ error: 'INVALID_REQUEST' });
    if (!dependencies.db)
      return reply.code(503).send({ error: 'DATABASE_UNAVAILABLE' });
    const application = await dependencies.db.application.findFirst({
      where: { id: parsed.data.id, userId },
      include: { googleFormRun: true },
    });
    if (!application)
      return reply.code(404).send({ error: 'APPLICATION_NOT_FOUND' });
    const documents = await dependencies.db.userDocument.findMany({
      where: { userId, archivedAt: null },
      select: { id: true, name: true, type: true },
      take: 500,
    });
    const snapshot = GoogleFormSnapshotSchema.safeParse(
      application.googleFormRun?.snapshot,
    );
    return {
      enabled: dependencies.googleFormsEnabled === true,
      expectedAccount: account,
      run: application.googleFormRun
        ? googleFormSummary(application.googleFormRun)
        : null,
      reviews: snapshot.success
        ? snapshot.data.answers
            .filter((a) => a.review)
            .map((answer) => ({
              question: snapshot.data.questions.find((q) => q.id === answer.id),
              answer,
            }))
        : [],
      documents,
    };
  });
  app.post(
    '/api/v1/applications/:id/google-form/start',
    async (request, reply) => {
      const userId = caller(request.headers.authorization),
        parsed = params.safeParse(request.params);
      if (!userId) return reply.code(401).send({ error: 'UNAUTHENTICATED' });
      if (!parsed.success)
        return reply.code(400).send({ error: 'INVALID_REQUEST' });
      try {
        const run = await startGoogleForm(dependencies, parsed.data.id, userId);
        return reply.code(202).send({ run: googleFormSummary(run) });
      } catch (error) {
        const code = googleFormError(error);
        return reply
          .code(code === 'APPLICATION_NOT_FOUND' ? 404 : 409)
          .send({ error: code });
      }
    },
  );
  for (const operation of ['review', 'resume'] as const)
    app.post(
      `/api/v1/applications/:id/google-form/${operation}`,
      async (request, reply) => {
        const userId = caller(request.headers.authorization),
          parsed = params.safeParse(request.params),
          body = (operation === 'review' ? decision : resumeBody).safeParse(
            request.body,
          );
        if (!userId) return reply.code(401).send({ error: 'UNAUTHENTICATED' });
        if (!parsed.success || !body.success)
          return reply.code(400).send({ error: 'INVALID_REQUEST' });
        const { db, queue } = dependencies;
        if (!dependencies.googleFormsEnabled || !db || !queue)
          return reply.code(503).send({ error: 'GOOGLE_FORMS_UNAVAILABLE' });
        const run = await db.googleFormRun.findFirst({
          where: { applicationId: parsed.data.id, userId },
        });
        if (!run)
          return reply.code(404).send({ error: 'APPLICATION_NOT_FOUND' });
        if (
          run.version !== body.data.version ||
          run.submitStartedAt ||
          run.state !== (operation === 'review' ? 'REVIEW' : 'BROWSER_REQUIRED')
        )
          return reply.code(409).send({ error: 'GOOGLE_FORMS_STALE_REVIEW' });
        const snapshot = GoogleFormSnapshotSchema.safeParse(run.snapshot);
        if (operation === 'review') {
          const input = body.data as z.infer<typeof decision>;
          if (!snapshot.success)
            return reply
              .code(409)
              .send({ error: 'GOOGLE_FORMS_SNAPSHOT_MISSING' });
          const question = snapshot.data.questions.find(
              (q) => q.id === input.questionId,
            ),
            answer = snapshot.data.answers.find(
              (a) => a.id === input.questionId,
            );
          if (!question || !answer?.review || question.kind === 'UNSUPPORTED')
            return reply
              .code(409)
              .send({ error: 'GOOGLE_FORMS_INVALID_REVIEW' });
          if (question.kind === 'FILE') {
            const records = await db.userDocument.findMany({
              where: { userId, archivedAt: null },
            });
            const documents = records.map((d) =>
              UserDocumentSchema.parse({
                id: d.id,
                name: d.name,
                type: d.type,
                storageRef: d.storageRef,
                mimeType: d.mimeType,
                size: d.size,
                metadata: d.metadata,
              }),
            );
            if (
              input.value !== null &&
              (typeof input.value !== 'string' ||
                !googleDocumentCandidates(question, documents).some(
                  (d) => d.id === input.value,
                ))
            )
              return reply
                .code(400)
                .send({ error: 'GOOGLE_FORMS_INVALID_DOCUMENT' });
            if (question.required && !input.value)
              return reply
                .code(400)
                .send({ error: 'GOOGLE_FORMS_INVALID_DOCUMENT' });
            answer.documentId =
              typeof input.value === 'string' ? input.value : null;
          } else if (!validGoogleAnswer(question, input.value))
            return reply
              .code(400)
              .send({ error: 'GOOGLE_FORMS_INVALID_ANSWER' });
          else answer.value = input.value;
          snapshot.data.decisions[input.questionId] = input.value;
          answer.source = 'REVIEW';
          answer.review = null;
        }
        const pending =
          operation === 'resume' ||
          (snapshot.success && snapshot.data.answers.every((a) => !a.review));
        const changed = await db.$transaction(async (tx) => {
          const changed = await tx.googleFormRun.updateMany({
            where: {
              id: run.id,
              userId,
              version: run.version,
              state: run.state,
              submitStartedAt: null,
            },
            data: {
              state: pending ? 'PENDING' : 'REVIEW',
              version: { increment: 1 },
              ...(snapshot.success
                ? { snapshot: snapshot.data as Prisma.InputJsonValue }
                : {}),
              errorCode: null,
            },
          });
          if (changed.count !== 1) return changed;
          if (operation === 'review' && snapshot.success) {
            const input = body.data as z.infer<typeof decision>;
            const question = snapshot.data.questions.find(
              (q) => q.id === input.questionId,
            )!;
            if (question.kind !== 'FILE' && input.value !== null) {
              const before = await tx.application.findFirstOrThrow({
                where: { id: run.applicationId, userId },
                include: googleCandidateInclude,
              });
              const unchanged =
                googleCandidateInput(before).inputDigest ===
                snapshot.data.inputDigest;
              await saveReviewedAnswer(
                tx,
                userId,
                question.label,
                Array.isArray(input.value)
                  ? JSON.stringify(input.value)
                  : input.value,
              );
              if (unchanged) {
                const current = await tx.application.findFirstOrThrow({
                  where: { id: run.applicationId, userId },
                  include: googleCandidateInclude,
                });
                snapshot.data.inputDigest =
                  googleCandidateInput(current).inputDigest;
                await tx.googleFormRun.update({
                  where: { id: run.id },
                  data: { snapshot: snapshot.data as Prisma.InputJsonValue },
                });
              }
            }
          }
          return changed;
        });
        if (changed.count !== 1)
          return reply.code(409).send({ error: 'GOOGLE_FORMS_STALE_REVIEW' });
        await db.applicationEvent.create({
          data: {
            applicationId: run.applicationId,
            actorId: userId,
            type: 'HUMAN_REVIEW_RESOLVED',
            data: {
              workflow: 'GOOGLE_FORM',
              version: run.version + 1,
              operation,
            },
            status: 'RESOLVED',
          },
        });
        if (pending) {
          try {
            await enqueueGoogleForm(queue, {
              id: run.id,
              version: run.version + 1,
            });
          } catch {
            await db.googleFormRun.updateMany({
              where: { id: run.id, state: 'PENDING', version: run.version + 1 },
              data: {
                state: 'FAILED',
                errorCode: 'GOOGLE_FORMS_QUEUE_UNAVAILABLE',
              },
            });
            return reply
              .code(503)
              .send({ error: 'GOOGLE_FORMS_QUEUE_UNAVAILABLE' });
          }
        }
        return reply.code(202).send({
          state: pending ? 'PENDING' : 'REVIEW',
          version: run.version + 1,
        });
      },
    );
}
