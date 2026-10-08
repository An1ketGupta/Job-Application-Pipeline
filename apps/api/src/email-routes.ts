import { randomBytes, randomUUID } from 'node:crypto';
import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { Prisma, saveReviewedAnswer } from '@careerlift/database';
import {
  ApplicationProfileSchema,
  EmailAddressSchema,
  EmailAttachmentSchema,
  EmailDraftInputSchema,
  EmailMessageViewSchema,
  EmailPreferencesSchema,
  EmailConnectionFailureSchema,
  renderEmailTemplate,
  rankResumes,
  ResumeJobTitlesSchema,
  UserDocumentSchema,
  validFieldValue,
  type EmailAnswerStage,
} from '@careerlift/domain';
import {
  LocalDocumentStorage,
  extractResumeContext,
} from '@careerlift/browser';
import {
  emailAnswerContext,
  prepareEmailAnswerStage,
  latestEmailAnswerStage,
  storeEmailAnswerStage,
} from './email-answer-stage.js';
import { resolveDocumentRoot } from '@careerlift/config';
import {
  GmailProvider,
  decryptSecret,
  encryptSecret,
  hashOAuthState,
  oauthAuthorization,
  type GmailConfig,
  type EmailDraftGenerator,
  EmailPersonalizationError,
  EmailProviderError,
} from '@careerlift/email';
import {
  candidateBoundary,
  CandidateError,
  type CandidateDependencies,
} from './candidate-http.js';

export type EmailDependencies = CandidateDependencies & {
  gmail?: GmailConfig;
  emailDraftGenerator?: EmailDraftGenerator;
  emailDefaultSenderName?: string;
  emailExpectedSender?: string;
  emailTestRecipient?: string;
};
const editable = ['DRAFT', 'FAILED', 'CANCELLED'] as const;
const params = z.object({ id: z.string().min(1).max(200) });
const approval = z
  .object({
    revision: z.number().int().positive(),
    userConfirmed: z.literal(true),
  })
  .strict();
function withCandidateAnswers(body: string, stage: EmailAnswerStage | null) {
  const entries =
    stage?.questions.flatMap((question) => {
      const answer = stage.answers.find((item) => item.id === question.id);
      return answer?.answer && !answer.requiresHumanReview
        ? [
            question.id === 'email-instructions-review'
              ? answer.answer
              : `${question.question}\n${answer.answer}`,
          ]
        : [];
    }) ?? [];
  if (!entries.length) return body;
  const missing = entries.filter((entry) => !body.includes(entry));
  const result = missing.length
    ? `${body.trim()}\n\nApplication answers:\n${missing.join('\n\n')}`
    : body;
  if (result.length > 20000)
    throw new CandidateError(
      'EMAIL_ANSWER_TEXT_TOO_LONG',
      400,
      'Shorten the email or its application answers before saving.',
    );
  return result;
}
const addressFrom = (destination: unknown) =>
  EmailAddressSchema.safeParse(
    (destination as { email?: unknown } | null)?.email,
  );
export function emailMessageView(row: Prisma.EmailMessageGetPayload<object>) {
  return EmailMessageViewSchema.parse({
    id: row.id,
    applicationId: row.applicationId,
    purpose: row.purpose,
    state: row.state,
    revision: row.revision,
    from: row.from,
    to: row.to,
    subject: row.subject,
    body: row.body,
    attachments: row.attachments,
    updatedAt: row.updatedAt.toISOString(),
    sentAt: row.sentAt?.toISOString() ?? null,
    errorCode: row.errorCode,
  });
}
function parse<T extends z.ZodTypeAny>(schema: T, value: unknown): z.output<T> {
  const result = schema.safeParse(value);
  if (!result.success) throw new CandidateError('VALIDATION_ERROR', 400);
  return result.data;
}
export function registerEmailRoutes(
  root: FastifyInstance,
  dependencies: EmailDependencies,
) {
  const config = dependencies.gmail;
  // OAuth callbacks carry short-lived codes. Suppress automatic request URL logging.
  root.get(
    '/api/v1/email/oauth/callback',
    { logLevel: 'silent' },
    async (request, reply) => {
      if (!config || !dependencies.db)
        return reply.code(503).send({ error: 'EMAIL_NOT_CONFIGURED' });
      const query = z
        .object({
          state: z.string().min(20).max(200),
          code: z.string().max(4000).optional(),
          error: z.string().max(200).optional(),
        })
        .safeParse(request.query);
      const failure = (code = 'EMAIL_CONNECTION_FAILED') => {
        const reason = EmailConnectionFailureSchema.catch(
          'EMAIL_CONNECTION_FAILED',
        ).parse(code);
        return reply.redirect(
          `${config.webOrigin}/email?connection=failed&reason=${reason}`,
        );
      };
      if (!query.success) return failure('EMAIL_OAUTH_STATE_INVALID');
      const hash = hashOAuthState(query.data.state);
      const state = await dependencies.db.emailOAuthState.findUnique({
        where: { hash },
      });
      if (!state || state.expiresAt <= new Date())
        return failure('EMAIL_OAUTH_STATE_INVALID');
      const consumed = await dependencies.db.emailOAuthState.deleteMany({
        where: { hash, expiresAt: { gt: new Date() } },
      });
      if (!consumed.count || (!query.data.code && !query.data.error))
        return failure('EMAIL_OAUTH_STATE_INVALID');
      if (query.data.error)
        return failure(
          query.data.error === 'access_denied'
            ? 'EMAIL_ACCESS_DENIED'
            : 'EMAIL_CONNECTION_FAILED',
        );
      try {
        const connection = await new GmailProvider(config).exchange(
          query.data.code!,
          state.verifier,
        );
        if (
          config.expectedSender &&
          connection.address.toLowerCase() !==
            config.expectedSender.toLowerCase()
        )
          return failure('EMAIL_ACCOUNT_MISMATCH');
        const encryptedRefreshToken = encryptSecret(
          connection.refreshToken,
          config.encryptionKey,
          state.userId,
        );
        await dependencies.db.$transaction(async (tx) => {
          await tx.$queryRaw`SELECT pg_advisory_xact_lock(hashtextextended(${`email:${state.userId}`}, 0))::text`;
          if (
            await tx.emailMessage.count({
              where: { userId: state.userId, state: 'SENDING' },
            })
          )
            throw new CandidateError('EMAIL_SENDING_IN_PROGRESS', 409);
          await tx.emailAccount.upsert({
            where: { userId: state.userId },
            create: {
              userId: state.userId,
              address: connection.address,
              encryptedRefreshToken,
            },
            update: {
              address: connection.address,
              encryptedRefreshToken,
              connected: true,
              version: { increment: 1 },
            },
          });
        });
        return reply.redirect(`${config.webOrigin}/email?connection=connected`);
      } catch (error) {
        return failure(
          error instanceof EmailProviderError || error instanceof CandidateError
            ? error.code
            : 'EMAIL_CONNECTION_FAILED',
        );
      }
    },
  );
  root.register(
    async (app) => {
      const owner = candidateBoundary(app, dependencies);
      const db = dependencies.db!;
      const storage = new LocalDocumentStorage(
        dependencies.documentRoot ?? resolveDocumentRoot(),
      );
      const answerStageFor = (
        userId: string,
        id: string,
        resumeId: string | null,
      ) =>
        dependencies.answerProvider
          ? prepareEmailAnswerStage(
              db,
              id,
              userId,
              resumeId,
              storage,
              dependencies.answerProvider,
              dependencies.answerConfidenceThreshold ?? 0.75,
            )
          : Promise.resolve(null);
      const accountFor = async (userId: string) => {
        const account = await db.emailAccount.findUnique({ where: { userId } });
        if (!account?.connected || !account.encryptedRefreshToken)
          throw new CandidateError('EMAIL_RECONNECT_REQUIRED', 409);
        return account;
      };
      const preferencesFor = async (userId: string) => {
        const saved = await db.emailPreferences.findUnique({
          where: { userId },
        });
        return EmailPreferencesSchema.parse(
          saved?.data ?? {
            senderName:
              dependencies.emailDefaultSenderName ??
              config?.defaultSenderName ??
              '',
          },
        );
      };
      const applicationFor = async (userId: string, id: string) => {
        const row = await db.application.findFirst({
          where: { id, userId },
          include: { plan: true, job: true, emailMessage: true },
        });
        if (!row) throw new CandidateError('APPLICATION_NOT_FOUND', 404);
        const to = addressFrom(row.plan?.destination);
        if (
          row.plan?.applicationType !== 'EMAIL' ||
          row.plan.executor !== 'EMAIL' ||
          !to.success
        )
          throw new CandidateError('EMAIL_APPLICATION_REQUIRED', 409);
        return { ...row, recipient: to.data };
      };
      const assertApplicationReady = (
        row: Awaited<ReturnType<typeof applicationFor>>,
      ) => {
        if (
          !['RESOLVED', 'READY'].includes(row.state) ||
          row.plan?.requiresHumanReview
        )
          throw new CandidateError('EMAIL_REVIEW_REQUIRED', 409);
      };
      const attachmentsFor = async (userId: string, ids: string[]) => {
        const rows = await db.userDocument.findMany({
          where: { userId, id: { in: ids }, archivedAt: null },
        });
        if (rows.length !== ids.length)
          throw new CandidateError('DOCUMENT_UNAVAILABLE', 409);
        if (rows.reduce((sum, row) => sum + row.size, 0) > 15 * 1024 * 1024)
          throw new CandidateError('EMAIL_ATTACHMENTS_TOO_LARGE', 400);
        for (const row of rows) {
          try {
            await storage.resolve(
              {
                ...row,
                type: row.type as 'RESUME',
                metadata: row.metadata as Record<string, unknown>,
              },
              [],
            );
          } catch {
            throw new CandidateError('DOCUMENT_UNAVAILABLE', 409);
          }
        }
        return ids.map((id) => {
          const row = rows.find((d) => d.id === id)!;
          return EmailAttachmentSchema.parse({
            id: row.id,
            revision: row.revision,
            name: row.name,
            mimeType: row.mimeType,
            size: row.size,
            contentDigest: (row.metadata as { contentDigest?: string })
              .contentDigest,
          });
        });
      };
      const queueMessage = async (
        userId: string,
        id: string,
        revision: number,
      ) => {
        if (!config?.allowSend)
          throw new CandidateError('EMAIL_SENDING_DISABLED', 409);
        if (!dependencies.queue)
          throw new CandidateError('QUEUE_UNAVAILABLE', 503);
        const account = await accountFor(userId);
        const message = await db.$transaction(async (tx) => {
          // Serialize daily-limit and approval checks per account, including concurrent clicks.
          await tx.$queryRaw`SELECT pg_advisory_xact_lock(hashtextextended(${`email:${userId}`}, 0))::text`;
          const row = await tx.emailMessage.findFirst({
            where: { id, userId },
          });
          if (!row) throw new CandidateError('EMAIL_MESSAGE_NOT_FOUND', 404);
          if (row.revision !== revision)
            throw new CandidateError('CONCURRENT_UPDATE', 409);
          if (['QUEUED', 'SENDING', 'SENT', 'UNKNOWN'].includes(row.state))
            return row;
          if (row.state !== 'DRAFT')
            throw new CandidateError('EMAIL_DRAFT_REQUIRED', 409);
          if (
            row.accountVersion !== account.version ||
            row.from !== account.address
          )
            throw new CandidateError('EMAIL_ACCOUNT_CHANGED', 409);
          if (row.applicationId) {
            const application = await applicationFor(userId, row.applicationId);
            assertApplicationReady(application);
            if (
              application.plan?.id !== row.planId ||
              application.recipient !== row.to
            )
              throw new CandidateError('EMAIL_DRAFT_STALE', 409);
            const pref = await preferencesFor(userId);
            const snapshot = z
              .array(EmailAttachmentSchema)
              .parse(row.attachments);
            const current = await attachmentsFor(
              userId,
              snapshot.map((a) => a.id),
            );
            if (JSON.stringify(current) !== JSON.stringify(snapshot))
              throw new CandidateError('EMAIL_DRAFT_STALE', 409);
            if (
              pref.requireResume &&
              !(await tx.userDocument.count({
                where: {
                  userId,
                  id: { in: snapshot.map((a) => a.id) },
                  type: 'RESUME',
                  archivedAt: null,
                },
              }))
            )
              throw new CandidateError('EMAIL_RESUME_REQUIRED', 409);
          }
          const since = new Date(Date.now() - 24 * 60 * 60 * 1000);
          if (
            (await tx.emailMessage.count({
              where: {
                userId,
                queuedAt: { gte: since },
                state: { in: ['QUEUED', 'SENDING', 'SENT', 'UNKNOWN'] },
              },
            })) >= 20
          )
            throw new CandidateError('EMAIL_DAILY_LIMIT', 409);
          const changed = await tx.emailMessage.updateMany({
            where: { id, userId, revision, state: 'DRAFT' },
            data: { state: 'QUEUED', queuedAt: new Date(), errorCode: null },
          });
          if (!changed.count)
            throw new CandidateError('CONCURRENT_UPDATE', 409);
          return tx.emailMessage.findUniqueOrThrow({ where: { id } });
        });
        if (message.state === 'QUEUED') {
          try {
            await dependencies.queue.add(
              'SEND_EMAIL_APPLICATION',
              { messageId: message.id, revision: message.revision },
              {
                jobId: `email-${message.id}-${message.revision}`,
                attempts: 1,
                removeOnComplete: 100,
                removeOnFail: 100,
              },
            );
          } catch {
            const changed = await db.emailMessage.updateMany({
              where: { id, userId, revision, state: 'QUEUED' },
              data: { state: 'FAILED', errorCode: 'QUEUE_UNAVAILABLE' },
            });
            if (changed.count)
              throw new CandidateError('QUEUE_UNAVAILABLE', 503);
          }
        }
        return emailMessageView(
          await db.emailMessage.findUniqueOrThrow({ where: { id } }),
        );
      };
      app.get('/settings', async (request) => {
        const userId = owner(request);
        const account = await db.emailAccount.findUnique({ where: { userId } });
        return {
          configured: !!config,
          sendingEnabled: config?.allowSend ?? false,
          expectedSender:
            dependencies.emailExpectedSender ?? config?.expectedSender ?? null,
          testRecipient:
            dependencies.emailTestRecipient ?? config?.expectedSender ?? '',
          personalizationConfigured: !!dependencies.emailDraftGenerator,
          account: account
            ? {
                address: account.address,
                connected: account.connected,
                updatedAt: account.updatedAt.toISOString(),
              }
            : null,
          preferences: await preferencesFor(userId),
          testMessages: (
            await db.emailMessage.findMany({
              where: { userId, purpose: 'TEST' },
              orderBy: { createdAt: 'desc' },
              take: 5,
            })
          ).map(emailMessageView),
        };
      });
      app.put('/settings', async (request) => {
        const userId = owner(request),
          data = parse(EmailPreferencesSchema, request.body);
        await db.emailPreferences.upsert({
          where: { userId },
          create: { userId, data },
          update: { data },
        });
        return { preferences: data };
      });
      app.post('/connect', async (request) => {
        if (!config) throw new CandidateError('EMAIL_NOT_CONFIGURED', 409);
        const userId = owner(request),
          state = randomBytes(32).toString('base64url'),
          verifier = randomBytes(48).toString('base64url');
        await db.emailOAuthState.deleteMany({
          where: { OR: [{ expiresAt: { lt: new Date() } }, { userId }] },
        });
        await db.emailOAuthState.create({
          data: {
            hash: hashOAuthState(state),
            userId,
            verifier,
            expiresAt: new Date(Date.now() + 10 * 60 * 1000),
          },
        });
        return { url: oauthAuthorization(config, state, verifier) };
      });
      app.post('/disconnect', async (request) => {
        const userId = owner(request);
        const account = await db.$transaction(async (tx) => {
          await tx.$queryRaw`SELECT pg_advisory_xact_lock(hashtextextended(${`email:${userId}`}, 0))::text`;
          if (
            await tx.emailMessage.count({ where: { userId, state: 'SENDING' } })
          )
            throw new CandidateError('EMAIL_SENDING_IN_PROGRESS', 409);
          const previous = await tx.emailAccount.findUnique({
            where: { userId },
          });
          await tx.emailAccount.updateMany({
            where: { userId },
            data: {
              connected: false,
              encryptedRefreshToken: null,
              version: { increment: 1 },
            },
          });
          await tx.emailMessage.updateMany({
            where: { userId, state: 'QUEUED' },
            data: { state: 'CANCELLED' },
          });
          await tx.emailOAuthState.deleteMany({ where: { userId } });
          return previous;
        });
        if (config && account?.encryptedRefreshToken) {
          try {
            await new GmailProvider(config).revoke(
              decryptSecret(
                account.encryptedRefreshToken,
                config.encryptionKey,
                userId,
              ),
            );
          } catch {
            /* Local credentials have already been removed. */
          }
        }
        return { disconnected: true };
      });
      app.post('/test', async (request) => {
        const userId = owner(request);
        const body = parse(
          z
            .object({
              to: EmailAddressSchema,
              key: z.string().uuid(),
              userConfirmed: z.literal(true),
            })
            .strict(),
          request.body,
        );
        const account = await accountFor(userId);
        const id = `test-${userId}-${body.key}`;
        const pref = await preferencesFor(userId);
        const message = await db.emailMessage.upsert({
          where: { id },
          update: {},
          create: {
            id,
            userId,
            purpose: 'TEST',
            from: account.address,
            to: body.to,
            senderName: pref.senderName,
            accountVersion: account.version,
            subject: 'CareerLift email connection test',
            body: 'Your CareerLift Gmail connection is working. This is a test email; no job application was submitted.',
          },
        });
        if (message.to !== body.to)
          throw new CandidateError('CONCURRENT_UPDATE', 409);
        return { message: await queueMessage(userId, id, message.revision) };
      });
      app.get('/applications/:id', async (request) => {
        const userId = owner(request),
          { id } = parse(params, request.params);
        const row = await applicationFor(userId, id);
        const profileRow = await db.applicationProfile.findUnique({
          where: { userId },
        });
        const profile = ApplicationProfileSchema.safeParse(
          profileRow?.data ?? {},
        );
        const pref = await preferencesFor(userId);
        const fullName = profile.success
          ? profile.data.fullName ||
            [profile.data.firstName, profile.data.lastName]
              .filter(Boolean)
              .join(' ') ||
            pref.senderName
          : pref.senderName;
        const values = {
          fullName,
          jobTitle: row.job.title,
          company: row.job.company,
          profileSummary: profile.success ? (profile.data.summary ?? '') : '',
          signature: pref.signature || fullName,
        };
        const rawDocuments = await db.userDocument.findMany({
          where: { userId, archivedAt: null },
          orderBy: [{ isDefault: 'desc' }, { name: 'asc' }],
          select: {
            id: true,
            name: true,
            type: true,
            isDefault: true,
            size: true,
            metadata: true,
          },
        });
        const documents = rawDocuments.map(({ metadata, ...doc }) => ({
          ...doc,
          jobTitles: ResumeJobTitlesSchema.catch([]).parse(
            (metadata as { jobTitles?: unknown }).jobTitles,
          ),
        }));
        const resumes = rankResumes(row.job.title, documents);
        const recommended = resumes.find((r) => r.score > 0 || r.isDefault);
        return {
          recipient: row.recipient,
          description: row.job.description,
          documents,
          requireResume: pref.requireResume,
          resumeRecommendation: recommended ?? null,
          resumeRanking: resumes,
          suggestion: {
            subject: renderEmailTemplate(pref.subjectTemplate, values)
              .replace(/[\r\n]/g, ' ')
              .slice(0, 250),
            body: renderEmailTemplate(pref.bodyTemplate, values),
          },
          message: row.emailMessage ? emailMessageView(row.emailMessage) : null,
          answerPipelineConfigured: !!dependencies.answerProvider,
          answerStage: await latestEmailAnswerStage(db, id),
        };
      });
      app.put('/applications/:id', async (request) => {
        const userId = owner(request),
          { id } = parse(params, request.params),
          body = parse(EmailDraftInputSchema, request.body);
        const row = await applicationFor(userId, id);
        assertApplicationReady(row);
        const account = await accountFor(userId),
          pref = await preferencesFor(userId);
        const attachments = await attachmentsFor(userId, body.documentIds);
        const selectedResume = await db.userDocument.findFirst({
          where: {
            userId,
            id: { in: body.documentIds },
            type: 'RESUME',
            archivedAt: null,
          },
        });
        const answerStage = await answerStageFor(
          userId,
          id,
          selectedResume?.id ?? null,
        );
        const data = {
          planId: row.plan!.id,
          accountVersion: account.version,
          from: account.address,
          to: row.recipient,
          senderName: pref.senderName,
          subject: body.subject,
          body: withCandidateAnswers(body.body, answerStage),
          attachments,
          state: 'DRAFT' as const,
          errorCode: null,
          runId: null,
          queuedAt: null,
          startedAt: null,
        };
        let saved;
        if (!row.emailMessage) {
          if (body.revision !== 0)
            throw new CandidateError('CONCURRENT_UPDATE', 409);
          saved = await db.emailMessage.create({
            data: {
              ...data,
              userId,
              applicationId: id,
              purpose: 'APPLICATION',
            },
          });
        } else {
          const changed = await db.emailMessage.updateMany({
            where: {
              id: row.emailMessage.id,
              userId,
              revision: body.revision,
              state: { in: [...editable] },
            },
            data: { ...data, revision: { increment: 1 } },
          });
          if (!changed.count)
            throw new CandidateError('EMAIL_DRAFT_LOCKED', 409);
          saved = await db.emailMessage.findUniqueOrThrow({
            where: { id: row.emailMessage.id },
          });
        }
        return { message: emailMessageView(saved) };
      });
      app.post('/applications/:id/personalize', async (request) => {
        const userId = owner(request),
          { id } = parse(params, request.params);
        const body = parse(
          z
            .object({
              profileSharingConfirmed: z.literal(true),
              resumeId: z.string().min(1).max(200).nullable(),
            })
            .strict(),
          request.body,
        );
        if (!dependencies.emailDraftGenerator)
          throw new CandidateError('EMAIL_AI_NOT_CONFIGURED', 409);
        const row = await applicationFor(userId, id);
        assertApplicationReady(row);
        if (
          row.emailMessage &&
          !editable.includes(
            row.emailMessage.state as (typeof editable)[number],
          )
        )
          throw new CandidateError('EMAIL_DRAFT_LOCKED', 409);
        const profile = await db.applicationProfile.findUnique({
          where: { userId },
        });
        const data = ApplicationProfileSchema.safeParse(profile?.data);
        if (!data.success)
          throw new CandidateError('EMAIL_PROFILE_REQUIRED', 409);
        const resume = body.resumeId
          ? await db.userDocument.findFirst({
              where: {
                id: body.resumeId,
                userId,
                type: 'RESUME',
                archivedAt: null,
              },
            })
          : null;
        if (body.resumeId && !resume)
          throw new CandidateError('DOCUMENT_UNAVAILABLE', 409);
        const answerStage = await answerStageFor(userId, id, body.resumeId);
        const resumeContext = await extractResumeContext(
          storage,
          resume
            ? UserDocumentSchema.parse({
                id: resume.id,
                name: resume.name,
                type: resume.type,
                mimeType: resume.mimeType,
                size: resume.size,
                storageRef: resume.storageRef,
                metadata: resume.metadata,
              })
            : undefined,
        );
        try {
          const generated = await dependencies.emailDraftGenerator.generate({
            preferences: await preferencesFor(userId),
            profile: data.data,
            job: {
              title: row.job.title,
              company: row.job.company,
              description: row.job.description,
            },
            resume: resume
              ? {
                  name: resume.name,
                  jobTitles: ResumeJobTitlesSchema.catch([]).parse(
                    (resume.metadata as { jobTitles?: unknown }).jobTitles,
                  ),
                }
              : null,
            ...(answerStage
              ? {
                  candidateAnswers: answerStage.questions.flatMap(
                    (question) => {
                      const answer = answerStage.answers.find(
                        (item) => item.id === question.id,
                      );
                      return answer?.answer && !answer.requiresHumanReview
                        ? [
                            {
                              question: question.question,
                              answer: answer.answer,
                            },
                          ]
                        : [];
                    },
                  ),
                  resumeText: resumeContext.text,
                }
              : {}),
          });
          return {
            ...generated,
            body: withCandidateAnswers(generated.body, answerStage),
            warnings: [
              ...generated.warnings,
              ...(answerStage?.answers
                .filter((answer) => answer.requiresHumanReview)
                .map((answer) => answer.reason) ?? []),
            ],
            answerStage,
          };
        } catch (error) {
          if (error instanceof EmailPersonalizationError)
            throw new CandidateError(error.code, 503);
          throw new CandidateError('EMAIL_PERSONALIZATION_UNAVAILABLE', 503);
        }
      });
      app.post('/applications/:id/answers', async (request) => {
        const userId = owner(request),
          { id } = parse(params, request.params);
        const body = parse(
          z
            .object({ resumeId: z.string().min(1).max(200).nullable() })
            .strict(),
          request.body,
        );
        const row = await applicationFor(userId, id);
        assertApplicationReady(row);
        if (
          row.emailMessage &&
          !editable.includes(
            row.emailMessage.state as (typeof editable)[number],
          )
        )
          throw new CandidateError('EMAIL_DRAFT_LOCKED', 409);
        return { stage: await answerStageFor(userId, id, body.resumeId) };
      });
      app.post('/applications/:id/answers/review', async (request) => {
        const userId = owner(request),
          { id } = parse(params, request.params);
        const body = parse(
          z
            .object({
              stageId: z.string().uuid(),
              questionId: z.string().min(1),
              value: z.string().trim().min(1).max(10000),
              userConfirmed: z.literal(true),
            })
            .strict(),
          request.body,
        );
        const row = await applicationFor(userId, id);
        assertApplicationReady(row);
        if (
          row.emailMessage &&
          !editable.includes(
            row.emailMessage.state as (typeof editable)[number],
          )
        )
          throw new CandidateError('EMAIL_DRAFT_LOCKED', 409);
        const stage = await db.$transaction(async (tx) => {
          await tx.$queryRaw`SELECT pg_advisory_xact_lock(hashtextextended(${`email-answers:${id}`}, 0))::text`;
          const current = await latestEmailAnswerStage(tx, id);
          if (!current || current.id !== body.stageId)
            throw new CandidateError('STALE_REVIEW', 409);
          const question = current.questions.find(
              (q) => q.id === body.questionId,
            ),
            answer = current.answers.find((a) => a.id === body.questionId);
          if (
            !question ||
            !answer?.requiresHumanReview ||
            !validFieldValue(body.value)
          )
            throw new CandidateError('INVALID_ANSWER', 400);
          await saveReviewedAnswer(
            tx,
            userId,
            question.question,
            body.value,
            question.category,
          );
          answer.answer = body.value;
          answer.confidence = 1;
          answer.requiresHumanReview = false;
          answer.reason = 'Uses your verified answer.';
          delete answer.approval;
          current.inputHash = (
            await emailAnswerContext(
              tx,
              id,
              userId,
              current.resumeId,
              dependencies.answerConfidenceThreshold ?? 0.75,
            )
          ).inputHash;
          current.id = randomUUID();
          await storeEmailAnswerStage(tx, id, userId, current);
          return current;
        });
        return { stage };
      });
      app.post('/applications/:id/send', async (request) => {
        const userId = owner(request),
          { id } = parse(params, request.params),
          body = parse(approval, request.body);
        const row = await applicationFor(userId, id);
        if (!row.emailMessage)
          throw new CandidateError('EMAIL_DRAFT_REQUIRED', 409);
        const attachments = EmailAttachmentSchema.array().parse(
          row.emailMessage.attachments,
        );
        const selectedResume = await db.userDocument.findFirst({
          where: {
            userId,
            id: { in: attachments.map((doc) => doc.id) },
            type: 'RESUME',
            archivedAt: null,
          },
        });
        const stage = await answerStageFor(
          userId,
          id,
          selectedResume?.id ?? null,
        );
        if (stage?.answers.some((answer) => answer.requiresHumanReview))
          throw new CandidateError(
            'EMAIL_ANSWERS_REQUIRE_REVIEW',
            409,
            'Review the candidate answers before sending this email.',
          );
        if (
          withCandidateAnswers(row.emailMessage.body, stage) !==
          row.emailMessage.body
        )
          throw new CandidateError(
            'EMAIL_ANSWERS_MISSING_FROM_DRAFT',
            409,
            'Save the draft again to include the required application answers.',
          );
        return {
          message: await queueMessage(
            userId,
            row.emailMessage.id,
            body.revision,
          ),
        };
      });
      app.post('/applications/:id/cancel', async (request) => {
        const userId = owner(request),
          { id } = parse(params, request.params),
          body = parse(approval, request.body);
        const row = await applicationFor(userId, id);
        if (!row.emailMessage)
          throw new CandidateError('EMAIL_DRAFT_REQUIRED', 409);
        const changed = await db.emailMessage.updateMany({
          where: {
            id: row.emailMessage.id,
            userId,
            revision: body.revision,
            state: 'QUEUED',
          },
          data: { state: 'CANCELLED' },
        });
        if (!changed.count) throw new CandidateError('EMAIL_DRAFT_LOCKED', 409);
        return {
          message: emailMessageView(
            await db.emailMessage.findUniqueOrThrow({
              where: { id: row.emailMessage.id },
            }),
          ),
        };
      });
    },
    { prefix: '/api/v1/email' },
  );
}
