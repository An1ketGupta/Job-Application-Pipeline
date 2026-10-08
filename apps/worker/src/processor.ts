import { UnrecoverableError, type Job as QueueJob } from 'bullmq';
import { z } from 'zod';
import {
  ApplicationPlanSchema,
  canTransition,
  type ApplicationPlan,
  type ApplicationState,
} from '@careerlift/domain';
import { type PrismaClient } from '@careerlift/database';
import { type ApplicationResolverStrategy } from '@careerlift/application-resolver';
import { logger } from '@careerlift/logging';
import { ResolveJobDataSchema } from './queue.js';

export class PermanentResolutionError extends UnrecoverableError {
  constructor(message: string) {
    super(message);
    this.name = 'PermanentResolutionError';
  }
}

type Db = PrismaClient;
type Resolver = ApplicationResolverStrategy;

export function createResolutionProcessor(db: Db, resolver: Resolver) {
  return async (task: QueueJob): Promise<ApplicationPlan | undefined> => {
    let applicationId: string | undefined;
    let requestId: string | undefined;
    let jobId: string | undefined;
    try {
      if (task.name !== 'RESOLVE_APPLICATION')
        throw new PermanentResolutionError('Unsupported queue task');
      const parsed = ResolveJobDataSchema.safeParse(task.data);
      if (!parsed.success)
        throw new PermanentResolutionError('Invalid resolution payload');
      ({ applicationId, requestId } = parsed.data);
      jobId = parsed.data.job.id;
      const application = await db.application.findUnique({
        where: { id: applicationId },
        include: { plan: true },
      });
      if (!application || application.jobId !== jobId)
        throw new PermanentResolutionError('Application and job do not match');
      if (
        application.state === 'RESOLVED' ||
        application.state === 'HUMAN_REQUIRED'
      ) {
        if (!application.plan)
          throw new Error('Final state lacks persisted plan');
        return ApplicationPlanSchema.parse({
          jobId,
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
      }
      if (
        !canTransition(application.state, 'ANALYZING') &&
        application.state !== 'ANALYZING'
      )
        throw new PermanentResolutionError(
          `Illegal transition ${application.state} to ANALYZING`,
        );
      if (application.state !== 'ANALYZING') {
        await db.$transaction(async (tx) => {
          const changed = await tx.application.updateMany({
            where: { id: applicationId!, state: application.state },
            data: { state: 'ANALYZING' },
          });
          if (changed.count !== 1)
            throw new Error('Concurrent state transition');
          await tx.applicationEvent.createMany({
            data: [
              {
                applicationId: applicationId!,
                jobId: jobId!,
                requestId: requestId!,
                attempt: task.attemptsMade,
                type: 'APPLICATION_ANALYSIS_STARTED',
                status: 'ANALYZING',
              },
            ],
            skipDuplicates: true,
          });
        });
      }
      const plan = ApplicationPlanSchema.parse(
        await resolver.resolve(parsed.data.job),
      );
      if (plan.jobId !== jobId)
        throw new PermanentResolutionError('Plan job ID mismatch');
      const state: ApplicationState =
        plan.requiresHumanReview || plan.executor === 'NONE'
          ? 'HUMAN_REQUIRED'
          : 'RESOLVED';
      await db.$transaction(async (tx) => {
        const changed = await tx.application.updateMany({
          where: { id: applicationId!, state: 'ANALYZING' },
          data: { state },
        });
        if (changed.count !== 1) throw new Error('Concurrent state transition');
        const data = {
          applicationType: plan.applicationType,
          provider: plan.provider ?? null,
          destination: plan.destination,
          requirements: plan.requirements,
          actions: plan.actions,
          executor: plan.executor,
          confidence: plan.confidence,
          requiresHumanReview: plan.requiresHumanReview,
          reasoning: plan.reasoning,
          resolvedBy: plan.resolvedBy,
        };
        await tx.applicationPlan.upsert({
          where: { applicationId: applicationId! },
          create: { applicationId: applicationId!, ...data },
          update: data,
        });
        await tx.applicationEvent.createMany({
          data: [
            {
              applicationId: applicationId!,
              jobId: jobId!,
              requestId: requestId!,
              attempt: task.attemptsMade,
              type:
                state === 'RESOLVED'
                  ? 'APPLICATION_RESOLVED'
                  : 'HUMAN_REVIEW_REQUIRED',
              status: state,
              message: plan.reasoning.join('; '),
              data: plan.destination.target
                ? {
                    atsEvents: ['ATS_DETECTED', 'APPLICATION_TARGET_RESOLVED'],
                    platform: plan.destination.target.platform,
                    adapterVersion: plan.destination.target.adapterVersion,
                  }
                : plan.destination.unsupportedReason
                  ? {
                      atsEvents: [
                        'ATS_UNSUPPORTED',
                        'ATS_REQUIRES_HUMAN_REVIEW',
                      ],
                      code: plan.destination.unsupportedReason,
                    }
                  : {},
            },
          ],
          skipDuplicates: true,
        });
      });
      logger.info(
        {
          event: 'application.resolved',
          applicationId,
          jobId,
          requestId,
          status: state,
        },
        'Resolution persisted',
      );
      return plan;
    } catch (error) {
      // Invalid payloads may still carry a valid application ID. Never mutate an
      // unrelated application, and never regress an already completed state.
      const raw = z
        .object({
          applicationId: z.string().min(1),
          requestId: z.string().min(1).optional(),
        })
        .passthrough()
        .safeParse(task.data);
      applicationId ??= raw.success ? raw.data.applicationId : undefined;
      requestId ??= raw.success ? raw.data.requestId : undefined;
      if (applicationId) {
        try {
          const application = await db.application.findUnique({
            where: { id: applicationId },
          });
          if (
            application &&
            (!jobId || application.jobId === jobId) &&
            canTransition(application.state, 'FAILED')
          ) {
            await db.$transaction(async (tx) => {
              const changed = await tx.application.updateMany({
                where: { id: applicationId!, state: application.state },
                data: { state: 'FAILED' },
              });
              if (changed.count === 1)
                await tx.applicationEvent.createMany({
                  data: [
                    {
                      applicationId: applicationId!,
                      jobId: application.jobId,
                      requestId: requestId ?? null,
                      attempt: task.attemptsMade,
                      type: 'APPLICATION_RESOLUTION_FAILED',
                      status: 'FAILED',
                      errorCode:
                        error instanceof PermanentResolutionError
                          ? 'INVALID_RESOLUTION_JOB'
                          : 'APPLICATION_RESOLUTION_ERROR',
                    },
                  ],
                  skipDuplicates: true,
                });
            });
          }
        } catch (failureError) {
          logger.error(
            {
              event: 'application.failure_persistence_failed',
              applicationId,
              error: failureError,
            },
            'Could not persist failure state',
          );
        }
      }
      logger.error(
        {
          event: 'application.resolution_failed',
          applicationId,
          jobId,
          requestId,
          error,
        },
        'Resolution failed',
      );
      throw error;
    }
  };
}
