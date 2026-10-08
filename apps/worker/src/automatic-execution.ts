import { randomUUID } from 'node:crypto';
import type { Queue } from 'bullmq';
import {
  executionApplicationInclude,
  executionInputFromApplication,
  executionInputHash,
  type PrismaClient,
} from '@careerlift/database';
import { validateExecutionTarget } from '@careerlift/browser';
import { logger } from '@careerlift/logging';

// The unique application/mode key and deterministic queue ID survive duplicate
// preparation callbacks and recovery. A final/uncertain attempt is never replayed.
export async function requestAutomaticExecution(
  db: PrismaClient,
  queue: Queue,
  applicationId: string,
) {
  if (process.env.VITEST || process.env.NODE_ENV === 'test') return;
  const application = await db.application.findUnique({
    where: { id: applicationId },
    include: { ...executionApplicationInclude, executions: true },
  });
  if (
    !application ||
    !['RESOLVED', 'READY'].includes(application.state) ||
    application.preparation?.state !== 'COMPLETED' ||
    application.inspection?.state !== 'COMPLETED'
  )
    return;
  if (
    application.executions.some(
      (e) => e.mode !== 'DRY_RUN' && e.state !== 'PENDING',
    )
  )
    return;
  const existing = application.executions.find(
    (e) => e.mode === 'REAL_EXECUTION',
  );
  if (application.executions.some((e) => e.mode === 'TEST_FIXTURE')) return;
  const id = existing?.id ?? randomUUID();
  let input;
  try {
    input = executionInputFromApplication(application, {
      id,
      mode: 'REAL_EXECUTION',
      preparationVersion: application.preparation.version,
    });
    if (!input.plan.destination.target) return;
    await validateExecutionTarget(input, {});
  } catch {
    // Availability is independently computed from the same artifacts for the UI.
    logger.info(
      { event: 'execution.auto_blocked', applicationId },
      'Automatic submission requires additional action',
    );
    return;
  }
  const hash = executionInputHash(input);
  const execution = await db.applicationExecution.upsert({
    where: { applicationId_mode: { applicationId, mode: 'REAL_EXECUTION' } },
    update: {},
    create: {
      id,
      applicationId,
      applicationPlanId: input.applicationPlanId,
      inspectionId: input.inspectionId,
      preparationId: input.preparationId,
      preparationVersion: input.preparationVersion,
      inputHash: hash,
      mode: 'REAL_EXECUTION',
    },
  });
  if (execution.state !== 'PENDING' || execution.inputHash !== hash) return;
  await queue.add(
    'EXECUTE_APPLICATION',
    {
      applicationId,
      executionId: execution.id,
      generation: execution.generation,
      requestId: `automatic-${execution.id}`,
    },
    {
      jobId: `execute-${execution.id}-${execution.generation}`,
      attempts: 1,
      removeOnComplete: true,
      removeOnFail: true,
    },
  );
}

export async function recoverAutomaticExecutions(
  db: PrismaClient,
  queue: Queue,
  since: Date,
) {
  if (process.env.VITEST || process.env.NODE_ENV === 'test') return;
  let cursor: string | undefined;
  for (;;) {
    const applications = await db.application.findMany({
      where: {
        state: { in: ['RESOLVED', 'READY'] },
        preparation: {
          is: { state: 'COMPLETED', completedAt: { gte: since } },
        },
        inspection: { is: { state: 'COMPLETED' } },
        executions: {
          none: { mode: { not: 'DRY_RUN' }, state: { not: 'PENDING' } },
        },
      },
      select: { id: true },
      take: 100,
      orderBy: { id: 'asc' },
      ...(cursor ? { cursor: { id: cursor }, skip: 1 } : {}),
    });
    for (const app of applications)
      await requestAutomaticExecution(db, queue, app.id);
    if (applications.length < 100) return;
    cursor = applications.at(-1)!.id;
  }
}
