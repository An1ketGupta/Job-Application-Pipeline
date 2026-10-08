import type { Queue } from 'bullmq';
import type { PrismaClient } from '@careerlift/database';
import {
  ApplicationSchemaSchema,
  canPrepareInspection,
} from '@careerlift/domain';
import { logger } from '@careerlift/logging';

// Preparation uses the shared candidate-answer engine. This schedules no browser writes.
export async function requestGreenhousePreparation(
  db: PrismaClient,
  queue: Queue,
  applicationId: string,
) {
  const application = await db.application.findUnique({
    where: { id: applicationId },
    include: {
      plan: true,
      inspection: true,
      preparation: true,
      executions: { select: { id: true } },
    },
  });
  if (
    !application ||
    !['RESOLVED', 'READY'].includes(application.state) ||
    application.plan?.requiresHumanReview ||
    application.plan?.provider !== 'GREENHOUSE' ||
    !application.inspection ||
    application.executions.length
  )
    return;
  const schema = ApplicationSchemaSchema.safeParse(
    application.inspection.result,
  );
  if (
    !schema.success ||
    schema.data.platform !== 'GREENHOUSE' ||
    schema.data.authentication.required ||
    schema.data.platformDiscrepancy ||
    schema.data.inspectionId !== application.inspection.id ||
    schema.data.applicationPlanId !==
      application.inspection.applicationPlanId ||
    !canPrepareInspection(application.inspection.state, schema.data)
  )
    return;
  if (
    application.preparation &&
    (application.preparation.state !== 'PENDING' ||
      application.preparation.inspectionId !== application.inspection.id)
  )
    return;
  const preparation = await db.applicationPreparation.upsert({
    where: { applicationId },
    create: {
      applicationId,
      inspectionId: application.inspection.id,
      state: 'PENDING',
    },
    update: {},
  });
  // Human decisions and completed snapshots are never reset by recovery.
  if (
    preparation.state !== 'PENDING' ||
    preparation.inspectionId !== application.inspection.id
  )
    return;
  await queue.add(
    'PREPARE_APPLICATION',
    {
      applicationId,
      requestId: `greenhouse-preparation-${preparation.id}-${preparation.version}`,
    },
    {
      jobId: `prepare-greenhouse-${preparation.id}-${preparation.version}`,
      attempts: 2,
      backoff: { type: 'exponential', delay: 1000 },
      removeOnComplete: true,
      removeOnFail: true,
    },
  );
}

export async function recoverGreenhousePreparations(
  db: PrismaClient,
  queue: Queue,
) {
  let cursor: string | undefined;
  for (;;) {
    const applications = await db.application.findMany({
      where: {
        state: { in: ['RESOLVED', 'READY'] },
        plan: { is: { provider: 'GREENHOUSE', requiresHumanReview: false } },
        inspection: { is: { state: { in: ['COMPLETED', 'HUMAN_REQUIRED'] } } },
        executions: { none: {} },
        OR: [
          { preparation: { is: null } },
          { preparation: { is: { state: 'PENDING' } } },
        ],
      },
      select: { id: true },
      orderBy: { id: 'asc' },
      take: 100,
      ...(cursor ? { cursor: { id: cursor }, skip: 1 } : {}),
    });
    for (const application of applications) {
      try {
        await requestGreenhousePreparation(db, queue, application.id);
      } catch {
        logger.error(
          {
            event: 'greenhouse.preparation_queue_failed',
            applicationId: application.id,
          },
          'Greenhouse answer preparation will be retried by recovery',
        );
      }
    }
    if (applications.length < 100) return;
    cursor = applications.at(-1)!.id;
  }
}
