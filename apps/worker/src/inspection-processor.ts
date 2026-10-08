import { randomUUID } from 'node:crypto';
import { UnrecoverableError, type Job as QueueJob } from 'bullmq';
import {
  ApplicationPlanSchema,
  ApplicationSchemaSchema,
} from '@careerlift/domain';
import { Prisma, type PrismaClient } from '@careerlift/database';
import {
  ApplicationInspector,
  type InspectionOutcome,
} from '@careerlift/browser';
import { logger } from '@careerlift/logging';
import { InspectJobDataSchema } from './queue.js';

export function createInspectionProcessor(
  db: PrismaClient,
  inspector = new ApplicationInspector(),
) {
  return async (task: QueueJob) => {
    if (task.name !== 'INSPECT_APPLICATION')
      throw new UnrecoverableError('Unsupported inspection job');
    const payload = InspectJobDataSchema.safeParse(task.data);
    if (!payload.success)
      throw new UnrecoverableError('Invalid inspection payload');
    const { applicationId, requestId } = payload.data;
    const application = await db.application.findUnique({
      where: { id: applicationId },
      include: { plan: true, inspection: true },
    });
    if (!application?.plan || !application.inspection)
      throw new UnrecoverableError('Application plan or inspection missing');
    const plan = ApplicationPlanSchema.safeParse({
      jobId: application.jobId,
      applicationType: application.plan.applicationType,
      provider: application.plan.provider ?? undefined,
      destination: application.plan.destination,
      requirements: application.plan.requirements,
      actions: application.plan.actions,
      executor: application.plan.executor,
      confidence: application.plan.confidence,
      requiresHumanReview: application.plan.requiresHumanReview,
      reasoning: application.plan.reasoning,
      resolvedBy: application.plan.resolvedBy,
    });
    const runId = randomUUID();
    // Only one delivery may claim PENDING. A duplicate RUNNING delivery does no work.
    const claimed = await db.applicationInspection.updateMany({
      where: { id: application.inspection.id, state: 'PENDING' },
      data: {
        state: 'RUNNING',
        runId,
        startedAt: new Date(),
        completedAt: null,
        result: Prisma.DbNull,
        finalUrl: null,
        errorCode: null,
      },
    });
    if (claimed.count !== 1) {
      const current = await db.applicationInspection.findUniqueOrThrow({
        where: { id: application.inspection.id },
      });
      return current.result
        ? ApplicationSchemaSchema.parse(current.result)
        : undefined;
    }
    try {
      await db.applicationEvent.createMany({
        data: [
          {
            applicationId,
            jobId: application.jobId,
            requestId,
            attempt: 0,
            type: 'APPLICATION_INSPECTION_STARTED',
            data:
              plan.success && plan.data.destination.target
                ? {
                    atsEvent: 'ATS_INSPECTION_STARTED',
                    platform: plan.data.destination.target.platform,
                  }
                : {},
            status: application.state,
          },
        ],
        skipDuplicates: true,
      });
      const outcome: InspectionOutcome = plan.success
        ? await inspector.inspect(
            plan.data,
            application.plan.id,
            application.inspection.id,
          )
        : { status: 'FAILED' as const, errorCode: 'INVALID_PLAN' };
      const changed = await db.$transaction(async (tx) => {
        const updated = await tx.applicationInspection.updateMany({
          where: { id: application.inspection!.id, state: 'RUNNING', runId },
          data: {
            state: outcome.status,
            result: outcome.schema ?? Prisma.DbNull,
            finalUrl: outcome.schema?.finalUrl ?? null,
            errorCode: outcome.errorCode ?? null,
            completedAt: new Date(),
            runId: null,
          },
        });
        if (updated.count !== 1) return false;
        await tx.applicationEvent.createMany({
          data: [
            {
              applicationId,
              jobId: application.jobId,
              requestId,
              attempt: 0,
              type:
                outcome.status === 'FAILED'
                  ? 'APPLICATION_INSPECTION_FAILED'
                  : 'APPLICATION_INSPECTED',
              status: application.state,
              errorCode: outcome.errorCode ?? null,
              data:
                plan.success && plan.data.destination.target
                  ? {
                      atsEvent:
                        outcome.status === 'HUMAN_REQUIRED'
                          ? 'ATS_REQUIRES_HUMAN_REVIEW'
                          : outcome.status === 'COMPLETED'
                            ? 'ATS_INSPECTION_COMPLETED'
                            : 'ATS_INSPECTION_FAILED',
                      platform: plan.data.destination.target.platform,
                    }
                  : {},
              message:
                outcome.status === 'HUMAN_REQUIRED'
                  ? (outcome.schema?.humanReview.reasons.join(', ') ?? null)
                  : null,
            },
          ],
          skipDuplicates: true,
        });
        return true;
      });
      if (changed)
        logger.info(
          {
            event: 'application.inspected',
            applicationId,
            status: outcome.status,
            errorCode: outcome.errorCode,
          },
          'Inspection persisted',
        );
      return changed ? outcome.schema : undefined;
    } catch (error) {
      // A processor failure is terminal for this run. A new API request may requeue FAILED.
      await db.applicationInspection.updateMany({
        where: { id: application.inspection.id, state: 'RUNNING', runId },
        data: {
          state: 'FAILED',
          result: Prisma.DbNull,
          finalUrl: null,
          errorCode: 'WORKER_FAILURE',
          completedAt: new Date(),
          runId: null,
        },
      });
      throw error;
    }
  };
}

export async function failStaleInspections(
  db: PrismaClient,
  olderThan: Date,
): Promise<number> {
  const running = await db.applicationInspection.updateMany({
    where: { state: 'RUNNING', startedAt: { lt: olderThan } },
    data: {
      state: 'FAILED',
      result: Prisma.DbNull,
      finalUrl: null,
      errorCode: 'INSPECTION_WORKER_EXPIRED',
      completedAt: new Date(),
      runId: null,
    },
  });
  const pending = await db.applicationInspection.updateMany({
    where: { state: 'PENDING', updatedAt: { lt: olderThan } },
    data: {
      state: 'FAILED',
      result: Prisma.DbNull,
      finalUrl: null,
      errorCode: 'INSPECTION_QUEUE_EXPIRED',
      completedAt: new Date(),
      runId: null,
    },
  });
  return running.count + pending.count;
}
