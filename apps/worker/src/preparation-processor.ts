import { randomUUID } from 'node:crypto';
import { UnrecoverableError, type Job as QueueJob } from 'bullmq';
import { Prisma, type PrismaClient } from '@careerlift/database';
import {
  ApplicationProfileSchema,
  ApplicationSchemaSchema,
  JobSchema,
  PreparedApplicationSchema,
  PreparationEngine,
  UserDocumentSchema,
  VerifiedAnswerSchema,
  ReviewDecisionSchema,
  canPrepareInspection,
  canTransitionInspection,
  type AnswerGenerationProvider,
  isAcceptedAiAnswer,
} from '@careerlift/domain';
import {
  LocalDocumentStorage,
  selectApplicationResume,
  extractResumeContext,
} from '@careerlift/browser';
import { resolveDocumentRoot } from '@careerlift/config';
import { logger } from '@careerlift/logging';
import { PrepareJobDataSchema } from './queue.js';

export function createPreparationProcessor(
  db: PrismaClient,
  provider?: AnswerGenerationProvider,
  options: {
    confidenceThreshold?: number;
    documentRoot?: string;
    onPrepared?: (applicationId: string) => Promise<void>;
  } = {},
) {
  return async (task: QueueJob) => {
    if (task.name !== 'PREPARE_APPLICATION')
      throw new UnrecoverableError('Unsupported preparation job');
    const payload = PrepareJobDataSchema.safeParse(task.data);
    if (!payload.success)
      throw new UnrecoverableError('Invalid preparation payload');
    const { applicationId } = payload.data;
    const application = await db.application.findUnique({
      where: { id: applicationId },
      include: {
        inspection: true,
        preparation: true,
        job: true,
        executions: { select: { id: true } },
        user: {
          include: { profile: true, documents: true, verifiedAnswers: true },
        },
      },
    });
    if (
      !application?.preparation ||
      !['RESOLVED', 'READY'].includes(application.state) ||
      application.executions.length > 0 ||
      !application.inspection ||
      !['COMPLETED', 'HUMAN_REQUIRED'].includes(application.inspection.state) ||
      !application.inspection.result
    )
      throw new UnrecoverableError(
        'Completed inspection or preparation missing',
      );
    const runId = randomUUID();
    const claimed = await db.applicationPreparation.updateMany({
      where: { id: application.preparation.id, state: 'PENDING' },
      data: {
        state: 'RUNNING',
        runId,
        startedAt: new Date(),
        completedAt: null,
        result: Prisma.DbNull,
        errorCode: null,
      },
    });
    if (claimed.count !== 1) {
      const current = await db.applicationPreparation.findUniqueOrThrow({
        where: { id: application.preparation.id },
      });
      return current.result
        ? PreparedApplicationSchema.parse(current.result)
        : undefined;
    }
    try {
      const schema = ApplicationSchemaSchema.parse(
        application.inspection.result,
      );
      if (!canPrepareInspection(application.inspection.state, schema))
        throw new UnrecoverableError(
          'Inspection security gate requires human intervention',
        );
      if (
        schema.inspectionId !== application.inspection.id ||
        schema.applicationPlanId !== application.inspection.applicationPlanId
      )
        throw new UnrecoverableError('Inspection schema identity mismatch');
      const job = JobSchema.parse({
        id: application.job.id,
        externalId: application.job.externalId,
        source: application.job.source,
        company: application.job.company,
        title: application.job.title,
        location: application.job.location ?? undefined,
        employmentType: application.job.employmentType ?? undefined,
        description: application.job.description ?? undefined,
        requirements: application.job.requirements,
        application: application.job.applicationInfo ?? undefined,
        sourceUrl: application.job.sourceUrl ?? undefined,
      });
      const profile = ApplicationProfileSchema.parse(
        application.user.profile?.data ?? {},
      );
      const documents = application.user.documents
        .filter((d) => !d.archivedAt)
        .map((d) =>
          UserDocumentSchema.parse({
            id: d.id,
            type: d.type,
            name: d.name,
            storageRef: d.storageRef,
            mimeType: d.mimeType,
            size: d.size,
            metadata: {
              ...(d.metadata as Record<string, unknown>),
              isDefault: d.isDefault,
            },
          }),
        );
      const verifiedAnswers = application.user.verifiedAnswers
        .filter((a) => a.active !== false && a.source === 'USER_VERIFIED')
        .map((a) =>
          VerifiedAnswerSchema.parse({
            id: a.id,
            category: a.category,
            question: a.question ?? '',
            questionKey: a.questionKey ?? '',
            value: a.value,
            source: a.source,
            verifiedAt: a.verifiedAt.toISOString(),
          }),
        );
      const reviewDecisions = ReviewDecisionSchema.array().parse(
        application.preparation.reviewDecisions ?? [],
      );
      const selectedResume = selectApplicationResume(
        documents,
        schema,
        reviewDecisions,
      );
      const resumeContext = provider?.generateAnswers
        ? await extractResumeContext(
            new LocalDocumentStorage(
              options.documentRoot ?? resolveDocumentRoot(),
            ),
            selectedResume,
          )
        : undefined;
      if (
        resumeContext &&
        !selectedResume &&
        documents.filter((d) => d.type === 'RESUME').length > 1
      )
        resumeContext.status = 'AMBIGUOUS';
      const snapshot = {
        profile,
        profileRevision: application.user.profile?.revision ?? 0,
        email: application.user.email,
        inspection: schema,
        documents,
        verifiedAnswers,
        reviewDecisions,
        capturedAt: new Date().toISOString(),
        ...(resumeContext ? { resumeContext } : {}),
      } as unknown as Prisma.InputJsonValue;
      const result = await new PreparationEngine(
        provider,
        undefined,
        options.confidenceThreshold ?? 0.75,
      ).prepare({
        applicationId,
        inspectionId: application.inspection.id,
        schema,
        job,
        email: application.user.email,
        profile,
        documents,
        verifiedAnswers,
        reviewDecisions,
        ...(resumeContext ? { resumeContext } : {}),
      });
      const updated = await db.$transaction(async (tx) => {
        const updated = await tx.applicationPreparation.updateMany({
          where: { id: application.preparation!.id, state: 'RUNNING', runId },
          data: {
            state: result.overallStatus,
            result: result as Prisma.InputJsonValue,
            inputSnapshot: snapshot,
            completedAt: new Date(),
            runId: null,
          },
        });
        if (updated.count) {
          if (
            application.inspection!.state === 'HUMAN_REQUIRED' &&
            result.overallStatus === 'COMPLETED'
          ) {
            if (
              !canTransitionInspection(
                application.inspection!.state,
                'COMPLETED',
              )
            )
              throw new UnrecoverableError(
                'Invalid inspection review transition',
              );
            if (
              !schema.questions
                .filter((q) => q.humanReviewRequired)
                .every((q) =>
                  result.questions.some(
                    (a) =>
                      a.questionId === q.id &&
                      (a.source === 'USER_VERIFIED' || isAcceptedAiAnswer(a)) &&
                      a.answer &&
                      !a.requiresHumanReview,
                  ),
                )
            )
              throw new UnrecoverableError(
                'Sensitive inspection review is unresolved',
              );
            const reviewedSchema = ApplicationSchemaSchema.parse({
              ...schema,
              questions: schema.questions.map((q) => ({
                ...q,
                humanReviewRequired: false,
              })),
              humanReview: { required: false, reasons: [] },
            });
            const inspected = await tx.applicationInspection.updateMany({
              where: {
                id: application.inspection!.id,
                state: 'HUMAN_REQUIRED',
                updatedAt: application.inspection!.updatedAt,
              },
              data: { state: 'COMPLETED', result: reviewedSchema },
            });
            if (!inspected.count)
              throw new UnrecoverableError('Concurrent inspection review');
            await tx.applicationEvent.create({
              data: {
                applicationId,
                jobId: application.jobId,
                actorId: application.userId,
                type: 'HUMAN_REVIEW_RESOLVED',
                status: application.state,
                data: {
                  stage: 'SENSITIVE_INSPECTION',
                  preparationVersion: application.preparation!.version,
                },
              },
            });
          }
          await tx.applicationEvent.create({
            data: {
              applicationId,
              jobId: application.jobId,
              type: 'PREPARATION_SNAPSHOT',
              status: application.state,
              requestId: `preparation-${application.preparation!.id}-${runId}`,
              data: {
                version: application.preparation!.version,
                input: snapshot,
                result,
              } as unknown as Prisma.InputJsonValue,
            },
          });
          if (result.humanReviewItems.length)
            await tx.applicationEvent.create({
              data: {
                applicationId,
                jobId: application.jobId,
                type: 'HUMAN_REVIEW_REQUIRED',
                status: application.state,
                requestId: `preparation-review-${runId}`,
                data: { count: result.humanReviewItems.length },
              },
            });
        }
        return updated;
      });
      if (updated.count)
        logger.info(
          {
            event: 'application.prepared',
            applicationId,
            status: result.overallStatus,
            humanReviewCount: result.humanReviewItems.length,
          },
          'Preparation persisted',
        );
      if (updated.count && result.overallStatus === 'COMPLETED') {
        try {
          await options.onPrepared?.(applicationId);
        } catch {
          logger.error(
            { event: 'execution.auto_queue_failed', applicationId },
            'Automatic submission will be retried by recovery',
          );
        }
      }
      return updated.count ? result : undefined;
    } catch (error) {
      await db.applicationPreparation.updateMany({
        where: { id: application.preparation.id, state: 'RUNNING', runId },
        data: {
          state: 'FAILED',
          result: Prisma.DbNull,
          errorCode: 'PREPARATION_FAILURE',
          completedAt: new Date(),
          runId: null,
        },
      });
      throw error;
    }
  };
}

export async function failStalePreparations(
  db: PrismaClient,
  olderThan: Date,
): Promise<number> {
  const running = await db.applicationPreparation.updateMany({
    where: { state: 'RUNNING', startedAt: { lt: olderThan } },
    data: {
      state: 'FAILED',
      errorCode: 'PREPARATION_WORKER_EXPIRED',
      result: Prisma.DbNull,
      runId: null,
      completedAt: new Date(),
    },
  });
  const pending = await db.applicationPreparation.updateMany({
    where: { state: 'PENDING', updatedAt: { lt: olderThan } },
    data: {
      state: 'FAILED',
      errorCode: 'PREPARATION_QUEUE_EXPIRED',
      result: Prisma.DbNull,
      runId: null,
      completedAt: new Date(),
    },
  });
  return running.count + pending.count;
}
