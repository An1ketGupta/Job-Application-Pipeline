import { randomUUID } from 'node:crypto';
import { UnrecoverableError, type Job, type Queue } from 'bullmq';
import {
  VerificationContextSchema,
  VerificationEvidenceSchema,
  assertEvidenceBinding,
  assertVerificationTransition,
  type SubmissionVerifier,
  type VerificationResult,
} from '@careerlift/domain';
import {
  auditVerification,
  assertVerificationContextCurrent,
  ensureSubmissionVerification,
  storeEvidence,
  evidenceDecision,
  type PrismaClient,
} from '@careerlift/database';
import { GenericSubmissionVerifier } from '@careerlift/browser';
import { logger } from '@careerlift/logging';
import { VerifyJobDataSchema, enqueueVerification } from './queue.js';

export function createVerificationProcessor(
  db: PrismaClient,
  verifiers: SubmissionVerifier[] = [],
  timeoutMs = 8000,
) {
  if (!Number.isInteger(timeoutMs) || timeoutMs < 1 || timeoutMs > 15000)
    throw new Error('INVALID_VERIFICATION_TIMEOUT');
  return async (task: Job) => {
    if (task.name !== 'VERIFY_SUBMISSION')
      throw new UnrecoverableError('Unsupported verification job');
    const payload = VerifyJobDataSchema.safeParse(task.data);
    if (!payload.success)
      throw new UnrecoverableError('Invalid verification payload');
    const { executionId, applicationId, userId, generation } = payload.data;
    const record = await db.submissionVerification.findFirst({
      where: {
        executionId,
        generation,
        execution: { applicationId, application: { userId } },
      },
    });
    if (!record)
      throw new UnrecoverableError(
        'Verification identity mismatch or stale generation',
      );
    if (record.state !== 'PENDING') return;
    const context = VerificationContextSchema.safeParse(record.context);
    let verifier: SubmissionVerifier = new GenericSubmissionVerifier();
    try {
      if (context.success)
        verifier = verifiers.find((v) => v.supports(context.data)) ?? verifier;
    } catch {
      /* An unusable strategy fails closed through the conservative verifier. */
    }
    const strategy = verifier.constructor.name,
      runId = randomUUID();
    const startedAt = new Date(),
      leaseUntil = new Date(Date.now() + timeoutMs + 10000);
    const claimed = await db.$transaction(async (tx) => {
      assertVerificationTransition(record.state, 'VERIFYING');
      const changed = await tx.submissionVerification.updateMany({
        where: { id: record.id, state: 'PENDING', generation },
        data: { state: 'VERIFYING', runId, leaseUntil },
      });
      if (changed.count !== 1) return false;
      await tx.verificationAttempt.create({
        data: {
          id: runId,
          verificationId: record.id,
          generation,
          strategy,
          startedAt,
          target: context.success ? context.data.destination : null,
        },
      });
      await auditVerification(
        tx,
        record.id,
        `start-${runId}`,
        'VERIFICATION_STARTED',
        { executionId, generation, strategy },
      );
      return true;
    });
    if (!claimed) return;
    const controller = new AbortController();
    let timer: ReturnType<typeof setTimeout> | undefined;
    let observation: VerificationResult;
    try {
      if (!context.success) throw new Error('INVALID_VERIFICATION_CONTEXT');
      if (
        context.data.executionId !== executionId ||
        context.data.applicationId !== applicationId ||
        context.data.userId !== userId ||
        context.data.mutationId !== record.mutationId
      )
        throw new Error('VERIFICATION_IDENTITY_MISMATCH');
      await assertVerificationContextCurrent(db, context.data);
      observation = await Promise.race([
        verifier.verify(context.data, controller.signal),
        new Promise<VerificationResult>((resolve) => {
          timer = setTimeout(() => {
            controller.abort();
            resolve({ evidence: [], reason: 'VERIFICATION_TIMEOUT' });
          }, timeoutMs);
        }),
      ]);
      for (const value of observation.evidence) {
        const item = VerificationEvidenceSchema.parse(value);
        assertEvidenceBinding(context.data, item);
        if (item.source === 'USER')
          throw new Error('HUMAN_EVIDENCE_REQUIRES_AUTHENTICATED_ACTION');
      }
    } catch {
      // Invalid binding is uncertainty, never evidence of external rejection.
      observation = {
        evidence: [],
        reason: 'VERIFICATION_CONTEXT_OR_INFRASTRUCTURE_FAILURE',
      };
    } finally {
      if (timer) clearTimeout(timer);
    }
    const finished = await db.$transaction(async (tx) => {
      const lease = await tx.submissionVerification.findFirst({
        where: {
          id: record.id,
          state: 'VERIFYING',
          generation,
          runId,
          leaseUntil: { gt: new Date() },
        },
      });
      if (!lease) return undefined;
      let decision: {
        state: 'CONFIRMED' | 'REJECTED' | 'HUMAN_REQUIRED';
        reason: string;
      } = { state: 'HUMAN_REQUIRED', reason: observation.reason };
      if (context.success) {
        // Recheck ownership and original ledger again at the commit boundary.
        try {
          await assertVerificationContextCurrent(tx, context.data);
        } catch {
          observation = {
            evidence: [],
            reason: 'VERIFICATION_IDENTITY_MISMATCH',
          };
        }
        if (observation.reason !== 'VERIFICATION_IDENTITY_MISMATCH') {
          await storeEvidence(
            tx,
            record.id,
            context.data,
            observation.evidence,
            runId,
          );
          decision = await evidenceDecision(tx, record.id, context.data);
          if (
            decision.state === 'HUMAN_REQUIRED' &&
            decision.reason !== 'CONFLICTING_EVIDENCE'
          )
            decision.reason = observation.reason;
        } else decision.reason = observation.reason;
      }
      const retryInfrastructure =
        observation.infrastructureFailure &&
        lease.infrastructureFailures < 1 &&
        decision.state === 'HUMAN_REQUIRED';
      const state = retryInfrastructure ? 'PENDING' : decision.state;
      if (state === 'HUMAN_REQUIRED') {
        assertVerificationTransition('VERIFYING', 'UNKNOWN');
        assertVerificationTransition('UNKNOWN', 'HUMAN_REQUIRED');
        await auditVerification(
          tx,
          record.id,
          `unknown-${runId}`,
          'VERIFICATION_UNKNOWN',
          { executionId, reason: decision.reason },
        );
      } else assertVerificationTransition('VERIFYING', state);
      const changed = await tx.submissionVerification.updateMany({
        where: {
          id: record.id,
          state: 'VERIFYING',
          generation,
          runId,
          leaseUntil: { gt: new Date() },
        },
        data: {
          state,
          reason: decision.reason,
          runId: null,
          leaseUntil: null,
          ...(retryInfrastructure ? { generation: { increment: 1 } } : {}),
          ...(observation.infrastructureFailure
            ? { infrastructureFailures: { increment: 1 } }
            : {}),
          ...(state === 'CONFIRMED' || state === 'REJECTED'
            ? { establishedState: state }
            : {}),
        },
      });
      if (changed.count !== 1) throw new Error('VERIFICATION_LEASE_LOST');
      await tx.verificationAttempt.update({
        where: { id: runId },
        data: {
          completedAt: new Date(),
          result: retryInfrastructure ? 'FAILED' : state,
          errorCode:
            state === 'HUMAN_REQUIRED' || retryInfrastructure
              ? decision.reason
              : null,
        },
      });
      await auditVerification(
        tx,
        record.id,
        `completed-${runId}`,
        'VERIFICATION_COMPLETED',
        {
          executionId,
          state,
          reason: decision.reason,
          durationMs: Date.now() - startedAt.getTime(),
          strategy,
          ...(context.success &&
          ['GREENHOUSE', 'LEVER', 'ASHBY'].includes(context.data.platform)
            ? {
                atsEvent: 'ATS_VERIFICATION_COMPLETED',
                platform: context.data.platform,
              }
            : {}),
        },
      );
      if (state !== 'PENDING') {
        await auditVerification(
          tx,
          record.id,
          `outcome-${runId}`,
          state === 'HUMAN_REQUIRED'
            ? 'HUMAN_REVIEW_REQUIRED'
            : `VERIFICATION_${state}`,
          { executionId, state, reason: decision.reason },
        );
        await auditVerification(
          tx,
          record.id,
          `recovered-${runId}`,
          'RECOVERY_COMPLETED',
          { executionId, state },
        );
        await tx.application.update({
          where: { id: applicationId },
          data: {
            state:
              state === 'CONFIRMED'
                ? 'SUBMITTED'
                : state === 'REJECTED'
                  ? 'FAILED'
                  : 'HUMAN_REQUIRED',
          },
        });
      }
      return { state, reason: decision.reason };
    });
    logger.info(
      {
        event: 'submission.verification',
        executionId,
        applicationId,
        strategy,
        platform: context.success ? context.data.platform : 'UNKNOWN',
        state: finished?.state,
        reason: finished?.reason ?? observation.reason,
        durationMs: Date.now() - startedAt.getTime(),
        generation,
      },
      'Submission verification finished',
    );
    return finished?.state;
  };
}

export async function recoverExpiredVerifications(
  db: PrismaClient,
  now = new Date(),
) {
  const expired = await db.submissionVerification.findMany({
    where: { state: 'VERIFYING', leaseUntil: { lte: now } },
    take: 100,
  });
  let count = 0;
  for (const record of expired) {
    count += await db.$transaction(async (tx) => {
      const retry = record.infrastructureFailures < 1;
      const context = VerificationContextSchema.safeParse(record.context);
      const established =
        !retry && context.success
          ? await evidenceDecision(tx, record.id, context.data)
          : undefined;
      const state = retry
        ? 'PENDING'
        : (established?.state ?? 'HUMAN_REQUIRED');
      if (state === 'HUMAN_REQUIRED') {
        assertVerificationTransition('VERIFYING', 'UNKNOWN');
        assertVerificationTransition('UNKNOWN', 'HUMAN_REQUIRED');
      } else assertVerificationTransition('VERIFYING', state);
      const changed = await tx.submissionVerification.updateMany({
        where: {
          id: record.id,
          state: 'VERIFYING',
          generation: record.generation,
          runId: record.runId,
          leaseUntil: { lte: now },
        },
        data: {
          state,
          runId: null,
          leaseUntil: null,
          generation: { increment: 1 },
          infrastructureFailures: { increment: 1 },
          reason: 'VERIFICATION_WORKER_EXPIRED',
        },
      });
      if (!changed.count) return 0;
      if (record.runId)
        await tx.verificationAttempt.updateMany({
          where: {
            id: record.runId,
            verificationId: record.id,
            completedAt: null,
          },
          data: {
            completedAt: now,
            result: 'FAILED',
            errorCode: 'VERIFICATION_WORKER_EXPIRED',
          },
        });
      await auditVerification(
        tx,
        record.id,
        `expired-${record.generation}`,
        'RECOVERY_STARTED',
        {
          executionId: record.executionId,
          reason: 'VERIFICATION_WORKER_EXPIRED',
          state,
        },
      );
      if (!retry) {
        await auditVerification(
          tx,
          record.id,
          `expired-human-${record.generation}`,
          state === 'HUMAN_REQUIRED'
            ? 'HUMAN_REVIEW_REQUIRED'
            : `VERIFICATION_${state}`,
          { reason: 'VERIFICATION_INFRASTRUCTURE_EXHAUSTED' },
        );
        await tx.application.updateMany({
          where: { executions: { some: { id: record.executionId } } },
          data: {
            state:
              state === 'CONFIRMED'
                ? 'SUBMITTED'
                : state === 'REJECTED'
                  ? 'FAILED'
                  : 'HUMAN_REQUIRED',
          },
        });
      }
      return 1;
    });
  }
  return count;
}

// Database-backed scheduling repairs the DB/Redis enqueue gap after crashes.
// This scanner only schedules checks; it cannot call the application executor.
export async function reconcileSubmissions(db: PrismaClient, queue: Queue) {
  await recoverExpiredVerifications(db);
  const executions = await db.applicationExecution.findMany({
    where: {
      state: {
        in: [
          'SUBMITTED',
          'SUBMISSION_UNKNOWN',
          'FAILED',
          'BLOCKED',
          'DRY_RUN_COMPLETED',
        ],
      },
      runId: null,
      completedAt: { not: null },
      verification: { is: null },
    },
    take: 100,
  });
  for (const execution of executions)
    await ensureSubmissionVerification(db, execution.id);
  const pending = await db.submissionVerification.findMany({
    where: { state: 'PENDING' },
    include: { execution: { include: { application: true } } },
    take: 100,
  });
  for (const record of pending)
    await enqueueVerification(queue, {
      executionId: record.executionId,
      applicationId: record.execution.applicationId,
      userId: record.execution.application.userId,
      generation: record.generation,
    });
}
