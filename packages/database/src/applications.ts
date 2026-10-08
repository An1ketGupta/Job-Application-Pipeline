import type { PrismaClient } from '@prisma/client';

// Existing idempotency is per owner/job (stronger than owner/job/target).
// A transaction-scoped lock also protects concurrent first Apply requests.
// Existing rows, including unknown outcomes, are always reused unchanged.
export async function findOrCreateJobApplication(
  db: PrismaClient,
  userId: string,
  jobId: string,
) {
  return db.$transaction(async (tx) => {
    await tx.$queryRaw`SELECT pg_advisory_xact_lock(hashtextextended(${JSON.stringify([userId, jobId])}, 0))::text`;
    const existing = await tx.application.findFirst({
      where: { userId, jobId },
      include: { plan: true, inspection: true },
      orderBy: { createdAt: 'asc' },
    });
    if (existing) return { application: existing, isExisting: true };
    const application = await tx.application.create({
      data: { userId, jobId, state: 'DISCOVERED' },
      include: { plan: true, inspection: true },
    });
    await tx.applicationEvent.create({
      data: {
        applicationId: application.id,
        jobId,
        type: 'JOB_DISCOVERED',
        status: 'DISCOVERED',
      },
    });
    return { application, isExisting: false };
  });
}
