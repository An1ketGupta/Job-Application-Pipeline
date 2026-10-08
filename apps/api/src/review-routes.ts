import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { Prisma, saveReviewedAnswer } from '@careerlift/database';
import {
  applicationAnswerFields,
  ApplicationSchemaSchema,
  PreparedApplicationSchema,
  ReviewDecisionSchema,
  UserDocumentSchema,
  validFieldValue,
  documentMatches,
  canPrepareInspection,
  classifyQuestion,
  type ReviewDecision,
} from '@careerlift/domain';
import { LocalDocumentStorage } from '@careerlift/browser';
import { resolveDocumentRoot } from '@careerlift/config';
import { selectedExecutionFilter } from './application-routes.js';
import { executionBlocker } from './safe-stage-views.js';
import {
  candidateBoundary,
  CandidateError,
  type CandidateDependencies,
} from './candidate-http.js';

const query = z
  .object({
    applicationId: z.string().min(1).max(200).optional(),
    page: z.coerce.number().int().min(1).max(10000).default(1),
  })
  .strict();
const params = z.object({ id: z.string().min(1).max(200) }).strict();
const decisionBody = z
  .object({
    requirementId: z.string().min(1).max(300),
    version: z.number().int().positive(),
    key: z.string().uuid(),
    action: z.enum(['ANSWER', 'CONFIRM', 'SELECT_DOCUMENT', 'REJECT']),
    value: z.string().trim().min(1).max(10000).optional(),
    documentId: z.string().min(1).max(200).optional(),
    userConfirmed: z.literal(true),
  })
  .strict();
const include = {
  job: true,
  inspection: true,
  preparation: true,
  plan: true,
  executions: { include: { verification: true } },
} as const;
type Row = Prisma.ApplicationGetPayload<{ include: typeof include }>;

function reviewProjection(row: Row, aiConfigured = false) {
  const execution = ['REAL_EXECUTION', 'TEST_FIXTURE', 'DRY_RUN']
    .map((mode) => row.executions.find((e) => e.mode === mode))
    .find(Boolean);
  const prepared = PreparedApplicationSchema.safeParse(row.preparation?.result);
  const inspection = ApplicationSchemaSchema.safeParse(row.inspection?.result);
  const decisions = ReviewDecisionSchema.array().safeParse(
    row.preparation?.reviewDecisions ?? [],
  );
  const canReview =
    row.preparation?.state === 'HUMAN_REQUIRED' &&
    inspection.success &&
    !!row.inspection &&
    canPrepareInspection(row.inspection.state, inspection.data) &&
    ['RESOLVED', 'READY'].includes(row.state) &&
    !row.executions.length;
  const unsupported = z
    .object({
      unsupportedReason: z.literal('UNSUPPORTED_APPLICATION_PLATFORM'),
    })
    .passthrough()
    .safeParse(row.plan?.destination).success;
  const pending =
    prepared.success &&
    prepared.data.applicationId === row.id &&
    inspection.success &&
    prepared.data.inspectionId === inspection.data.inspectionId
      ? prepared.data.humanReviewItems.map((item) => {
          const question = inspection.data.questions.find(
            (q) => q.id === item.requirementId,
          );
          const field = applicationAnswerFields(inspection.data.fields).find(
            (f) => f.id === (question?.fieldId ?? item.requirementId),
          );
          const document = inspection.data.documents.find(
            (d) => d.fieldId === item.requirementId,
          );
          const answer = question
            ? prepared.data.questions.find((q) => q.questionId === question.id)
            : undefined;
          const preparedField = prepared.data.fields.find(
            (f) => f.fieldId === item.requirementId,
          );
          const latest = decisions.success
            ? [...decisions.data]
                .reverse()
                .find((d) => d.requirementId === item.requirementId)
            : undefined;
          const proposedAnswer =
            latest?.action === 'REJECT'
              ? null
              : (answer?.answer ?? preparedField?.value ?? null);
          const sensitive = [
            'WORK_AUTHORIZATION',
            'SPONSORSHIP',
            'SALARY',
            'NOTICE_PERIOD',
            'SECURITY_CLEARANCE',
            'LEGAL_DECLARATION',
            'OTHER_SENSITIVE',
          ].includes(item.category);
          const type = document
            ? 'DOCUMENT_SELECTION'
            : sensitive
              ? 'SENSITIVE_QUESTION'
              : item.reason === 'Conflicting verified answers'
                ? 'CONFLICTING_ANSWERS'
                : preparedField?.semanticType === 'UNKNOWN'
                  ? 'AMBIGUOUS_QUESTION'
                  : question
                    ? 'MISSING_VERIFIED_ANSWER'
                    : 'MISSING_PROFILE_INFORMATION';
          const reason =
            latest?.action === 'REJECT'
              ? 'You rejected the proposed answer. A replacement is needed.'
              : item.reason &&
                  (answer?.source === 'LLM_GENERATED' ||
                    preparedField?.source === 'LLM_GENERATED')
                ? item.reason
                : document
                  ? 'Select an active document that satisfies this application’s requirements.'
                  : sensitive
                    ? 'This question needs an explicit answer from you.'
                    : type === 'CONFLICTING_ANSWERS'
                      ? 'Saved answers conflict. Choose an answer for this application.'
                      : 'A required answer is missing or does not satisfy this application’s constraints.';
          return {
            requirementId: item.requirementId,
            type,
            category: item.category,
            question:
              document?.label ??
              question?.text ??
              field?.label ??
              'Required application information',
            reason,
            proposedAnswer,
            source: answer?.source ?? preparedField?.source ?? null,
            confidence: answer?.confidence ?? preparedField?.confidence ?? null,
            options: field?.options ?? [],
            maxLength: field?.maxLength ?? 10000,
            minLength: field?.minLength ?? 1,
            fieldType: field?.type ?? 'TEXT',
            required: field?.required ?? true,
            description: field?.description ?? null,
            multiple: field?.type === 'CHECKBOX' && Boolean(field.choiceGroup),
            documentType: document?.type ?? null,
            acceptedFileTypes: document?.acceptedFileTypes ?? [],
            status: latest?.action === 'REJECT' ? 'REJECTED' : 'PENDING',
            priority: sensitive ? 'HIGH' : 'NORMAL',
            actions: canReview
              ? document
                ? ['SELECT_DOCUMENT']
                : proposedAnswer
                  ? ['ANSWER', 'CONFIRM', 'REJECT']
                  : ['ANSWER']
              : [],
          };
        })
      : [];
  const blockers: { type: string; reason: string; recommendation: string }[] =
    [];
  if (row.inspection?.state === 'HUMAN_REQUIRED') {
    const reasons = inspection.success
      ? inspection.data.humanReview.reasons
      : row.inspection.errorCode &&
          [
            'UNEXPECTED_NAVIGATION',
            'UNSAFE_DESTINATION',
            'AUTHENTICATION_OR_SECURITY_CHALLENGE',
            'MUTATING_REQUEST_BLOCKED',
            'SECURITY_INSPECTION_INCOMPLETE',
          ].includes(row.inspection.errorCode)
        ? [row.inspection.errorCode]
        : [];
    for (const type of reasons.length ? reasons : ['OTHER_EXECUTION_BLOCKER']) {
      if (
        type === 'SENSITIVE_QUESTION' &&
        inspection.success &&
        canPrepareInspection(row.inspection.state, inspection.data) &&
        pending.length
      )
        continue;
      blockers.push({
        type,
        reason:
          type === 'CAPTCHA'
            ? 'A CAPTCHA prevents the agent from continuing.'
            : type === 'AUTHENTICATION_REQUIRED' ||
                type === 'AUTHENTICATION_OR_SECURITY_CHALLENGE'
              ? 'The application platform requires authentication or security review.'
              : type === 'UNSAFE_DESTINATION'
                ? 'The application destination failed network security validation.'
                : type === 'SENSITIVE_QUESTION'
                  ? 'Sensitive questions need explicit candidate answers.'
                  : type === 'UNEXPECTED_NAVIGATION' ||
                      type === 'PLATFORM_MISMATCH'
                    ? 'The application destination changed unexpectedly.'
                    : type === 'UNSUPPORTED_INTERACTION' ||
                        type === 'MUTATING_REQUEST_BLOCKED'
                      ? 'This application flow requires an interaction the agent cannot safely automate.'
                      : 'Inspection requires human attention.',
        recommendation:
          type === 'SENSITIVE_QUESTION'
            ? 'Return to the application and prepare its required information, then answer the review items here.'
            : 'Return to the application. Candidate answers cannot clear this security or inspection gate.',
      });
    }
  }
  if (row.state === 'HUMAN_REQUIRED' || row.plan?.requiresHumanReview)
    blockers.push({
      type: unsupported
        ? 'UNSUPPORTED_APPLICATION_PLATFORM'
        : 'APPLICATION_BLOCKER',
      reason: unsupported
        ? 'This application platform is unsupported.'
        : 'The application destination or plan requires human review.',
      recommendation: unsupported
        ? 'Apply manually on the employer site. CareerLift cannot automate this platform.'
        : 'Review the job and application destination. Automated execution remains blocked.',
    });
  if (
    execution &&
    ['PAUSED_HUMAN_REQUIRED', 'BLOCKED'].includes(execution.state)
  )
    blockers.push({
      ...executionBlocker(execution.result),
      recommendation:
        'Return to the application. Automation has stopped for a safety check; candidate answers cannot clear this gate.',
    });
  if (
    execution?.verification &&
    ['HUMAN_REQUIRED', 'UNKNOWN'].includes(execution.verification.state)
  )
    blockers.push({
      type: 'SUBMISSION_VERIFICATION',
      reason: 'The submission outcome needs independent confirmation.',
      recommendation:
        'Review the submission status on the application. No repeat submission will be started.',
    });
  return {
    applicationId: row.id,
    job: { id: row.job.id, title: row.job.title, company: row.job.company },
    preparationStatus: row.preparation?.state ?? null,
    version: row.preparation?.version ?? 0,
    blocked: pending.length > 0 || blockers.length > 0,
    canResumePreparation: canReview,
    canRecheckWithAi: canReview && aiConfigured,
    items: pending,
    blockers,
    history: decisions.success
      ? decisions.data.map((d) => ({
          requirementId: d.requirementId,
          action: d.action,
          status: d.action === 'REJECT' ? 'REJECTED' : 'RESOLVED',
          decidedAt: d.decidedAt,
        }))
      : [],
  };
}

export function registerReviewRoutes(
  root: FastifyInstance,
  dependencies: CandidateDependencies,
) {
  root.register(
    async (app) => {
      const owner = candidateBoundary(app, dependencies);
      const db = dependencies.db!;
      const storage = new LocalDocumentStorage(
        dependencies.documentRoot ?? resolveDocumentRoot(),
      );
      app.get('/human-review', async (request) => {
        const parsed = query.safeParse(request.query);
        if (!parsed.success) throw new CandidateError('INVALID_QUERY', 400);
        const where: Prisma.ApplicationWhereInput = {
          userId: owner(request),
          ...(parsed.data.applicationId
            ? { id: parsed.data.applicationId }
            : {
                OR: [
                  { state: 'HUMAN_REQUIRED' },
                  { plan: { requiresHumanReview: true } },
                  { inspection: { state: 'HUMAN_REQUIRED' } },
                  {
                    preparation: {
                      state: { in: ['HUMAN_REQUIRED', 'PENDING', 'RUNNING'] },
                    },
                  },
                  selectedExecutionFilter({
                    OR: [
                      {
                        state: { in: ['PAUSED_HUMAN_REQUIRED', 'BLOCKED'] },
                      },
                      {
                        verification: {
                          state: { in: ['HUMAN_REQUIRED', 'UNKNOWN'] },
                        },
                      },
                    ],
                  }),
                ],
              }),
        };
        const [rows, total] = await Promise.all([
          db.application.findMany({
            where,
            include,
            orderBy: [{ updatedAt: 'desc' }, { id: 'asc' }],
            take: 20,
            skip: (parsed.data.page - 1) * 20,
          }),
          db.application.count({ where }),
        ]);
        return {
          reviews: rows.map((row) =>
            reviewProjection(row, !!dependencies.answerProvider),
          ),
          pagination: {
            page: parsed.data.page,
            total,
            totalPages: Math.ceil(total / 20),
          },
        };
      });
      app.get('/human-review/:id', async (request) => {
        const p = params.safeParse(request.params);
        if (!p.success) throw new CandidateError('INVALID_APPLICATION_ID', 400);
        const row = await db.application.findFirst({
          where: { id: p.data.id, userId: owner(request) },
          include,
        });
        if (!row) throw new CandidateError('REVIEW_NOT_FOUND', 404);
        return { review: reviewProjection(row, !!dependencies.answerProvider) };
      });
      app.post('/human-review/:id/recheck', async (request) => {
        const p = params.safeParse(request.params);
        const body = z
          .object({
            version: z.number().int().positive(),
            key: z.string().uuid(),
          })
          .strict()
          .safeParse(request.body);
        if (!p.success || !body.success)
          throw new CandidateError('INVALID_REVIEW_ACTION', 400);
        if (!dependencies.answerProvider || !dependencies.queue)
          throw new CandidateError('ANSWER_PROVIDER_UNAVAILABLE', 503);
        const userId = owner(request),
          key = body.data.key;
        const outcome = await db.$transaction(
          async (tx) => {
            const row = await tx.application.findFirst({
              where: { id: p.data.id, userId },
              include,
            });
            if (!row?.preparation)
              throw new CandidateError('REVIEW_NOT_FOUND', 404);
            const replay = await tx.applicationEvent.findFirst({
              where: {
                applicationId: row.id,
                requestId: key,
                type: 'PREPARATION_SNAPSHOT',
                data: { path: ['workflow'], equals: 'ANSWER_RECHECK' },
              },
            });
            if (replay)
              return {
                id: row.preparation.id,
                version: row.preparation.version,
                state: row.preparation.state,
              };
            if (
              row.preparation.version !== body.data.version ||
              !reviewProjection(row).canResumePreparation
            )
              throw new CandidateError('STALE_REVIEW', 409);
            const changed = await tx.applicationPreparation.updateMany({
              where: {
                id: row.preparation.id,
                state: 'HUMAN_REQUIRED',
                version: body.data.version,
              },
              data: {
                state: 'PENDING',
                version: { increment: 1 },
                runId: null,
                errorCode: null,
                startedAt: null,
                completedAt: null,
              },
            });
            if (!changed.count)
              throw new CandidateError('CONCURRENT_REVIEW', 409);
            await tx.applicationEvent.create({
              data: {
                applicationId: row.id,
                actorId: userId,
                requestId: key,
                type: 'PREPARATION_SNAPSHOT',
                data: {
                  workflow: 'ANSWER_RECHECK',
                  preparationVersion: body.data.version + 1,
                },
              },
            });
            return {
              id: row.preparation.id,
              version: body.data.version + 1,
              state: 'PENDING',
            };
          },
          { isolationLevel: Prisma.TransactionIsolationLevel.Serializable },
        );
        if (outcome.state === 'PENDING') {
          try {
            await dependencies.queue.add(
              'PREPARE_APPLICATION',
              { applicationId: p.data.id, requestId: key },
              {
                jobId: `prepare-ai-${outcome.id}-${outcome.version}`,
                attempts: 2,
                removeOnComplete: true,
                removeOnFail: true,
              },
            );
          } catch {
            await db.applicationPreparation.updateMany({
              where: {
                id: outcome.id,
                version: outcome.version,
                state: 'PENDING',
              },
              data: {
                state: 'FAILED',
                errorCode: 'QUEUE_UNAVAILABLE',
                completedAt: new Date(),
              },
            });
            throw new CandidateError('QUEUE_UNAVAILABLE', 503);
          }
        }
        return { preparationStatus: outcome.state, version: outcome.version };
      });
      for (const reject of [false, true])
        app.post(
          `/human-review/:id/${reject ? 'reject' : 'resolve'}`,
          async (request) => {
            const p = params.safeParse(request.params);
            const b = decisionBody.safeParse(request.body);
            if (
              !p.success ||
              !b.success ||
              reject !== (b.data.action === 'REJECT')
            )
              throw new CandidateError('INVALID_REVIEW_ACTION', 400);
            const body = b.data,
              userId = owner(request);
            if (body.action === 'CONFIRM' && body.value !== undefined)
              throw new CandidateError('INVALID_REVIEW_ACTION', 400);
            if (!reject && !dependencies.queue)
              throw new CandidateError('PREPARATION_UNAVAILABLE', 503);
            const outcome = await db.$transaction(
              async (tx) => {
                const row = await tx.application.findFirst({
                  where: { id: p.data.id, userId },
                  include,
                });
                if (!row || !row.preparation)
                  throw new CandidateError('REVIEW_NOT_FOUND', 404);
                const decisions = ReviewDecisionSchema.array().parse(
                  row.preparation.reviewDecisions,
                );
                const replay = decisions.find((d) => d.key === body.key);
                if (replay) {
                  if (
                    replay.requirementId !== body.requirementId ||
                    replay.action !== body.action ||
                    (replay.value !== body.value &&
                      body.action !== 'CONFIRM') ||
                    replay.documentId !== body.documentId
                  )
                    throw new CandidateError('IDEMPOTENCY_CONFLICT', 409);
                  return {
                    applicationId: row.id,
                    preparationId: row.preparation.id,
                    version: row.preparation.version,
                    preparationStatus: row.preparation.state,
                    replayed: true,
                  };
                }
                if (row.preparation.version !== body.version)
                  throw new CandidateError(
                    'STALE_REVIEW',
                    409,
                    'Review changed. Refresh before answering.',
                  );
                if (!reviewProjection(row).canResumePreparation)
                  throw new CandidateError('REVIEW_NOT_ACTIONABLE', 409);
                const prepared = PreparedApplicationSchema.parse(
                  row.preparation.result,
                );
                const inspection = ApplicationSchemaSchema.parse(
                  row.inspection!.result,
                );
                if (
                  prepared.applicationId !== row.id ||
                  prepared.inspectionId !== row.inspection!.id ||
                  inspection.inspectionId !== row.inspection!.id ||
                  inspection.applicationPlanId !== row.plan?.id
                )
                  throw new CandidateError('INVALID_REVIEW', 409);
                if (
                  !prepared.humanReviewItems.some(
                    (i) => i.requirementId === body.requirementId,
                  )
                )
                  throw new CandidateError('REVIEW_ITEM_NOT_FOUND', 404);
                const question = inspection.questions.find(
                  (q) => q.id === body.requirementId,
                );
                const field = applicationAnswerFields(inspection.fields).find(
                  (f) => f.id === (question?.fieldId ?? body.requirementId),
                );
                const requirement = inspection.documents.find(
                  (d) => d.fieldId === body.requirementId,
                );
                let value = body.value;
                if (requirement) {
                  if (
                    body.action !== 'SELECT_DOCUMENT' ||
                    !body.documentId ||
                    body.value
                  )
                    throw new CandidateError(
                      'DOCUMENT_SELECTION_REQUIRED',
                      400,
                    );
                  const selected = await tx.userDocument.findFirst({
                    where: { id: body.documentId, userId, archivedAt: null },
                  });
                  if (!selected)
                    throw new CandidateError('DOCUMENT_NOT_FOUND', 404);
                  const document = UserDocumentSchema.parse({
                    id: selected.id,
                    type: selected.type,
                    name: selected.name,
                    mimeType: selected.mimeType,
                    size: selected.size,
                    storageRef: selected.storageRef,
                    metadata: selected.metadata,
                  });
                  if (!documentMatches(document, requirement))
                    throw new CandidateError('DOCUMENT_TYPE_NOT_ALLOWED', 400);
                  try {
                    await storage.resolve(
                      document,
                      requirement.acceptedFileTypes,
                    );
                  } catch {
                    throw new CandidateError('DOCUMENT_UNAVAILABLE', 409);
                  }
                } else {
                  if (
                    !field ||
                    body.action === 'SELECT_DOCUMENT' ||
                    body.documentId
                  )
                    throw new CandidateError('INVALID_REVIEW_ACTION', 400);
                  if (body.action === 'CONFIRM') {
                    value =
                      (question
                        ? prepared.questions.find(
                            (q) => q.questionId === question.id,
                          )?.answer
                        : prepared.fields.find(
                            (f) => f.fieldId === body.requirementId,
                          )?.value) ?? undefined;
                    if (!value)
                      throw new CandidateError('NO_PROPOSED_ANSWER', 400);
                  }
                  if (!reject && !validFieldValue(value, field))
                    throw new CandidateError(
                      'INVALID_ANSWER',
                      400,
                      'Choose an allowed answer and satisfy the field’s format and length requirements.',
                    );
                  if (reject && body.value)
                    throw new CandidateError('INVALID_REVIEW_ACTION', 400);
                }
                const decision: ReviewDecision = {
                  requirementId: body.requirementId,
                  action: body.action,
                  ...(value ? { value } : {}),
                  ...(body.documentId ? { documentId: body.documentId } : {}),
                  key: body.key,
                  actorId: userId,
                  decidedAt: new Date().toISOString(),
                };
                const changed = await tx.applicationPreparation.updateMany({
                  where: {
                    id: row.preparation.id,
                    state: 'HUMAN_REQUIRED',
                    version: body.version,
                  },
                  data: {
                    reviewDecisions: [
                      ...decisions,
                      decision,
                    ] as unknown as Prisma.InputJsonValue,
                    version: { increment: 1 },
                    ...(reject
                      ? {}
                      : {
                          state: 'PENDING',
                          runId: null,
                          errorCode: null,
                          startedAt: null,
                          completedAt: null,
                        }),
                  },
                });
                if (!changed.count)
                  throw new CandidateError('CONCURRENT_REVIEW', 409);
                if (!reject && !requirement && value && field) {
                  const text = question?.text ?? field.label;
                  const category = classifyQuestion(
                    text,
                    question?.semanticType ?? field.semanticType,
                    question?.sensitivity,
                  );
                  await saveReviewedAnswer(tx, userId, text, value, category);
                }
                await tx.applicationEvent.create({
                  data: {
                    applicationId: row.id,
                    jobId: row.jobId,
                    actorId: userId,
                    requestId: body.key,
                    type: reject
                      ? 'HUMAN_REVIEW_REJECTED'
                      : 'HUMAN_REVIEW_RESOLVED',
                    status: row.state,
                    data: {
                      decision,
                      preparationVersion: body.version,
                    } as unknown as Prisma.InputJsonValue,
                  },
                });
                return {
                  applicationId: row.id,
                  preparationId: row.preparation.id,
                  version: body.version + 1,
                  preparationStatus: reject ? 'HUMAN_REQUIRED' : 'PENDING',
                  replayed: false,
                };
              },
              { isolationLevel: Prisma.TransactionIsolationLevel.Serializable },
            );
            if (!reject && outcome.preparationStatus === 'PENDING') {
              try {
                await dependencies.queue!.add(
                  'PREPARE_APPLICATION',
                  { applicationId: outcome.applicationId, requestId: body.key },
                  {
                    jobId: `prepare-review-${outcome.preparationId}-${outcome.version}`,
                    attempts: 2,
                    removeOnComplete: true,
                    removeOnFail: true,
                  },
                );
              } catch {
                await db.applicationPreparation.updateMany({
                  where: {
                    id: outcome.preparationId,
                    version: outcome.version,
                    state: 'PENDING',
                  },
                  data: {
                    state: 'FAILED',
                    errorCode: 'QUEUE_UNAVAILABLE',
                    completedAt: new Date(),
                  },
                });
                throw new CandidateError(
                  'QUEUE_UNAVAILABLE',
                  503,
                  'Your decision was saved. Return to the application and retry preparation when the worker queue is available.',
                );
              }
            }
            return {
              applicationId: outcome.applicationId,
              version: outcome.version,
              preparationStatus: outcome.preparationStatus,
              replayed: outcome.replayed,
            };
          },
        );
    },
    { prefix: '/api/v1' },
  );
}
