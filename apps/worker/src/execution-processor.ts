import { randomUUID } from 'node:crypto';
import { UnrecoverableError, type Job as QueueJob } from 'bullmq';
import {
  ExecutionResultSchema,
  canTransitionExecution,
  type ApplicationExecutor,
  type ExecutionResult,
  type ExecutionState,
} from '@careerlift/domain';
import {
  Prisma,
  executionApplicationInclude,
  executionInputFromApplication,
  executionInputHash,
  executionResultFromRecord,
  type PrismaClient,
} from '@careerlift/database';
import { logger } from '@careerlift/logging';
import { ExecuteJobDataSchema } from './queue.js';

export function createExecutionProcessor(
  db: PrismaClient,
  executor: ApplicationExecutor,
) {
  return async (task: QueueJob) => {
    if (task.name !== 'EXECUTE_APPLICATION')
      throw new UnrecoverableError('Unsupported execution job');
    const payload = ExecuteJobDataSchema.safeParse(task.data);
    if (!payload.success)
      throw new UnrecoverableError('Invalid execution payload');
    const { applicationId, executionId, generation, requestId } = payload.data;
    const record = await db.applicationExecution.findFirst({
      where: { id: executionId, applicationId, generation },
    });
    if (!record) throw new UnrecoverableError('Execution identity mismatch');
    if (record.state !== 'PENDING') return executionResultFromRecord(record);
    const runId = randomUUID();
    const claimed = await db.applicationExecution.updateMany({
      where: { id: executionId, state: 'PENDING', generation },
      data: {
        state: 'PREPARING',
        runId,
        startedAt: new Date(),
        completedAt: null,
        errorCode: null,
      },
    });
    if (claimed.count !== 1) return undefined;
    let current: ExecutionState = 'PREPARING';
    let heartbeatBusy = false;
    const heartbeat = setInterval(() => {
      if (heartbeatBusy) return;
      heartbeatBusy = true;
      void db.applicationExecution
        .updateMany({
          where: {
            id: executionId,
            runId,
            generation,
            state: { in: ['PREPARING', 'RUNNING', 'SUBMITTING'] },
          },
          data: { updatedAt: new Date() },
        })
        .catch(() =>
          logger.error(
            { event: 'execution.heartbeat_failed', executionId },
            'Execution heartbeat failed',
          ),
        )
        .finally(() => {
          heartbeatBusy = false;
        });
    }, 15000);
    try {
      const application = await db.application.findUniqueOrThrow({
        where: { id: applicationId },
        include: executionApplicationInclude,
      });
      if (!['RESOLVED', 'READY'].includes(application.state))
        throw new UnrecoverableError('Application is not executable');
      const previous = executionResultFromRecord(record);
      const input = executionInputFromApplication(
        application,
        record,
        previous,
      );
      if (
        input.applicationPlanId !== record.applicationPlanId ||
        input.inspectionId !== record.inspectionId ||
        input.preparationId !== record.preparationId ||
        executionInputHash(input) !== record.inputHash
      )
        throw new UnrecoverableError('Stale execution input');
      input.dispatchIdentity = {
        userId: application.userId,
        runId,
        generation,
      };
      await db.applicationEvent.createMany({
        data: [
          {
            applicationId,
            jobId: application.jobId,
            requestId,
            attempt: generation,
            type: 'APPLICATION_EXECUTION_STARTED',
            data: input.plan.destination.target
              ? {
                  atsEvent: 'ATS_EXECUTION_STARTED',
                  platform: input.plan.destination.target.platform,
                }
              : {},
            status: application.state,
          },
        ],
        skipDuplicates: true,
      });
      const observer = {
        authorizeDispatch: async () => {
          const fresh = await db.application.findUniqueOrThrow({
            where: { id: applicationId },
            include: executionApplicationInclude,
          });
          const lease = await db.applicationExecution.findFirst({
            where: {
              id: executionId,
              applicationId,
              runId,
              generation,
              state: current,
            },
          });
          if (
            !lease ||
            !['RUNNING', 'SUBMITTING'].includes(current) ||
            executionInputHash(executionInputFromApplication(fresh, record)) !==
              record.inputHash
          )
            throw new UnrecoverableError(
              'Dispatch lease or prepared input changed',
            );
        },
        persist: async (raw: ExecutionResult) => {
          const result = ExecutionResultSchema.parse(raw);
          if (
            result.applicationId !== applicationId ||
            result.executionId !== executionId ||
            result.mode !== record.mode ||
            (current !== result.status &&
              !canTransitionExecution(current, result.status))
          )
            throw new UnrecoverableError('Illegal execution transition');
          await db.$transaction(async (tx) => {
            // Freshness is rechecked before every browser action, including the submission barrier.
            const fresh = await tx.application.findUniqueOrThrow({
              where: { id: applicationId },
              include: executionApplicationInclude,
            });
            if (
              executionInputHash(
                executionInputFromApplication(fresh, record),
              ) !== record.inputHash
            )
              throw new UnrecoverableError('Execution input changed');
            const changed = await tx.applicationExecution.updateMany({
              where: { id: executionId, state: current, runId, generation },
              data: {
                state: result.status,
                result: result as Prisma.InputJsonValue,
                errorCode: result.error ?? null,
                completedAt: result.completedAt
                  ? new Date(result.completedAt)
                  : null,
              },
            });
            if (changed.count !== 1)
              throw new UnrecoverableError('Execution lease lost');
          });
          current = result.status;
          const latest = result.steps.at(-1);
          logger.info(
            {
              event: 'application.execution_progress',
              applicationId,
              executionId,
              stepId: latest?.stepId,
              stepType: latest?.type,
              stepStatus: latest?.status,
              status: result.status,
              durationMs: result.metadata.durationMs,
              platform: result.metadata.platform,
              errorCode: result.error,
              attempt: generation,
            },
            'Execution progress persisted',
          );
        },
      };
      const result = await executor.execute(input, observer);
      const validated = ExecutionResultSchema.parse(result);
      // An executor may return without an observer callback, but still cannot escape state guards.
      await observer.persist(validated);
      if (input.plan.destination.target)
        logger.info(
          {
            event: 'ATS_EXECUTION_COMPLETED',
            applicationId,
            executionId,
            platform: input.plan.destination.target.platform,
            status: validated.status,
          },
          'ATS execution stopped or completed through existing executor',
        );
      await db.applicationExecution.updateMany({
        where: { id: executionId, runId, generation, state: validated.status },
        data: { runId: null },
      });
      return validated;
    } catch (error) {
      logger.error(
        {
          event: 'execution.worker_failed',
          applicationId,
          executionId,
          errorType: error instanceof Error ? error.name : 'Unknown',
        },
        'Execution worker stopped; stored outcome requires inspection',
      );
      const latest = await db.applicationExecution.findUniqueOrThrow({
        where: { id: executionId },
      });
      const result = executionResultFromRecord(latest);
      const unsafe =
        latest.state === 'SUBMITTING' ||
        result?.checkpoint?.unsafeActionStarted;
      const state = unsafe
        ? 'SUBMISSION_UNKNOWN'
        : latest.state === 'PREPARING'
          ? 'BLOCKED'
          : 'FAILED';
      const errorCode = unsafe
        ? 'SUBMISSION_OUTCOME_UNKNOWN'
        : state === 'BLOCKED'
          ? 'EXECUTION_PREFLIGHT_FAILED'
          : 'EXECUTION_WORKER_FAILED';
      if (
        latest.runId === runId &&
        ['PREPARING', 'RUNNING', 'SUBMITTING'].includes(latest.state)
      ) {
        const failure = ExecutionResultSchema.parse({
          ...(result ?? {
            applicationId,
            executionId,
            mode: record.mode,
            startedAt: latest.startedAt!.toISOString(),
            steps: [],
            humanReviewItems: [],
            metadata: { platform: 'UNKNOWN', durationMs: 0 },
          }),
          status: state,
          ...(result?.mutations
            ? {
                mutations: result.mutations.map((m) =>
                  ['AUTHORIZED', 'DISPATCHING'].includes(m.outcome)
                    ? {
                        ...m,
                        outcome: 'UNKNOWN',
                        completedAt: new Date().toISOString(),
                      }
                    : m,
                ),
              }
            : {}),
          error: errorCode,
          completedAt: new Date().toISOString(),
          ...(result?.checkpoint
            ? { checkpoint: { ...result.checkpoint, resumable: false } }
            : {}),
        });
        await db.applicationExecution.updateMany({
          where: { id: executionId, state: latest.state, runId, generation },
          data: {
            state,
            errorCode,
            result: failure,
            runId: null,
            completedAt: new Date(),
          },
        });
      }
      // No BullMQ retry may replay external mutations, even when persistence failed.
      throw new UnrecoverableError(
        'Execution stopped; inspect stored outcome before any continuation',
      );
    } finally {
      clearInterval(heartbeat);
    }
  };
}

export async function failStaleExecutions(
  db: PrismaClient,
  olderThan: Date,
): Promise<number> {
  const records = await db.applicationExecution.findMany({
    where: {
      state: { in: ['PENDING', 'PREPARING', 'RUNNING', 'SUBMITTING'] },
      updatedAt: { lt: olderThan },
    },
  });
  let count = 0;
  for (const record of records) {
    const previous = executionResultFromRecord(record);
    const unsafe =
      record.state === 'SUBMITTING' ||
      previous?.checkpoint?.unsafeActionStarted;
    const state = unsafe ? 'SUBMISSION_UNKNOWN' : 'FAILED';
    const error = unsafe
      ? 'SUBMISSION_OUTCOME_UNKNOWN'
      : 'EXECUTION_WORKER_EXPIRED';
    const result = previous
      ? ExecutionResultSchema.parse({
          ...previous,
          status: state,
          ...(previous.mutations
            ? {
                mutations: previous.mutations.map((m) =>
                  ['AUTHORIZED', 'DISPATCHING'].includes(m.outcome)
                    ? {
                        ...m,
                        outcome: 'UNKNOWN',
                        completedAt: new Date().toISOString(),
                      }
                    : m,
                ),
              }
            : {}),
          error,
          completedAt: new Date().toISOString(),
          ...(previous.checkpoint
            ? { checkpoint: { ...previous.checkpoint, resumable: false } }
            : {}),
        })
      : undefined;
    const changed = await db.applicationExecution.updateMany({
      where: {
        id: record.id,
        state: record.state,
        runId: record.runId,
        generation: record.generation,
        updatedAt: record.updatedAt,
      },
      data: {
        state,
        result: result ?? Prisma.DbNull,
        errorCode: error,
        runId: null,
        completedAt: new Date(),
      },
    });
    count += changed.count;
  }
  return count;
}
