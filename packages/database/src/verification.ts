import { createHash } from 'node:crypto';
import {
  ApplicationSchemaSchema,
  PreparedApplicationSchema,
  VerificationContextSchema,
  VerificationEvidenceSchema,
  assertEvidenceBinding,
  assertVerificationTransition,
  evidenceIdentity,
  reconcileEvidence,
  type VerificationContext,
  type VerificationEvidence,
  type ExecutionResult,
} from '@careerlift/domain';
import { Prisma, type PrismaClient } from '@prisma/client';
import { executionResultFromRecord } from './execution.js';

export type VerificationTransaction = Prisma.TransactionClient;
export const verificationInclude = {
  attempts: { orderBy: { startedAt: 'asc' as const } },
  evidence: { orderBy: { capturedAt: 'asc' as const } },
  events: { orderBy: { createdAt: 'asc' as const } },
} as const;
export async function auditVerification(
  tx: VerificationTransaction,
  verificationId: string,
  key: string,
  type: string,
  data: Prisma.InputJsonValue,
  actorId?: string,
) {
  await tx.verificationAuditEvent.createMany({
    data: [
      { verificationId, key, type, data, ...(actorId ? { actorId } : {}) },
    ],
    skipDuplicates: true,
  });
}
export async function storeEvidence(
  tx: VerificationTransaction,
  verificationId: string,
  context: VerificationContext,
  raw: VerificationEvidence[],
  attemptId?: string,
) {
  for (const value of raw) {
    const item = VerificationEvidenceSchema.parse(value);
    assertEvidenceBinding(context, item);
    // Observation time is not evidence identity; rereading the same receipt deduplicates.
    const fingerprint = createHash('sha256')
      .update(JSON.stringify({ ...item, capturedAt: undefined }))
      .digest('hex');
    await tx.verificationEvidence.createMany({
      data: [
        {
          verificationId,
          ...(attemptId ? { attemptId } : {}),
          fingerprint,
          type: item.type,
          strength: item.strength,
          capturedAt: new Date(item.capturedAt),
          data: item,
        },
      ],
      skipDuplicates: true,
    });
  }
}

export async function ensureSubmissionVerification(
  db: PrismaClient,
  executionId: string,
) {
  return db.$transaction(async (tx) => {
    const existing = await tx.submissionVerification.findUnique({
      where: { executionId },
    });
    if (existing) return existing;
    const execution = await tx.applicationExecution.findUniqueOrThrow({
      where: { id: executionId },
      include: {
        application: {
          include: {
            job: true,
            plan: true,
            inspection: true,
            preparation: true,
          },
        },
      },
    });
    if (
      execution.runId !== null ||
      !execution.completedAt ||
      ![
        'SUBMITTED',
        'SUBMISSION_UNKNOWN',
        'FAILED',
        'BLOCKED',
        'DRY_RUN_COMPLETED',
      ].includes(execution.state)
    )
      throw new Error('EXECUTION_NOT_READY_FOR_VERIFICATION');
    let result: ExecutionResult | undefined;
    let invalidResult = false;
    try {
      result = executionResultFromRecord(execution);
    } catch {
      invalidResult = true;
    }
    const final =
      result?.mutations?.filter(
        (m) => m.action === 'FINAL_SUBMIT' && m.outcome !== 'REJECTED',
      ) ?? [];
    const required =
      invalidResult ||
      execution.state === 'SUBMISSION_UNKNOWN' ||
      final.length > 0 ||
      execution.state === 'SUBMITTED';
    let context: VerificationContext | undefined;
    let reason: string | undefined;
    if (required) {
      try {
        const application = execution.application;
        const schema = ApplicationSchemaSchema.parse(
          application.inspection?.result,
        );
        const prepared = PreparedApplicationSchema.parse(
          application.preparation?.result,
        );
        const mutation = final.length === 1 ? final[0]! : undefined;
        if (
          !mutation ||
          mutation.executionId !== executionId ||
          mutation.method !== 'POST' ||
          !result?.steps.some(
            (step) => step.stepId === mutation.stepId && step.type === 'SUBMIT',
          ) ||
          application.plan?.id !== execution.applicationPlanId ||
          application.inspection?.id !== execution.inspectionId ||
          application.preparation?.id !== execution.preparationId ||
          prepared.applicationId !== application.id ||
          prepared.jobId !== application.jobId ||
          prepared.inspectionId !== execution.inspectionId ||
          schema.applicationPlanId !== execution.applicationPlanId ||
          schema.inspectionId !== execution.inspectionId ||
          schema.platform !== result.metadata.platform ||
          application.inspection.applicationPlanId !==
            execution.applicationPlanId ||
          application.preparation.inspectionId !== execution.inspectionId ||
          !schema.executionFlow?.pages.some(
            (p) =>
              p.action === 'SUBMIT' &&
              `${new URL(p.control.actionUrl).origin}${new URL(p.control.actionUrl).pathname}` ===
                mutation.destination,
          )
        )
          throw new Error('SUBMISSION_ARTIFACT_IDENTITY_MISMATCH');
        context = VerificationContextSchema.parse({
          userId: application.userId,
          executionId,
          applicationId: application.id,
          jobId: application.jobId,
          company: application.job.company,
          jobTitle: application.job.title,
          platform: schema.platform,
          mode: execution.mode,
          destination: mutation.destination,
          mutationId: mutation.mutationId,
          stepId: mutation.stepId,
          requestFingerprint: mutation.requestDigest,
          documentDigests: mutation.documentDigests,
          submissionStartedAt: mutation.startedAt,
          mutationOutcome: mutation.outcome,
          ...(mutation.responseReceivedAt
            ? { responseReceivedAt: mutation.responseReceivedAt }
            : {}),
          ...(mutation.responseStatus
            ? { responseStatus: mutation.responseStatus }
            : {}),
          ...(mutation.responseFingerprint
            ? { responseFingerprint: mutation.responseFingerprint }
            : {}),
        });
      } catch {
        reason = 'MISSING_OR_MISMATCHED_SUBMISSION_ARTIFACTS';
      }
    }
    const record = await tx.submissionVerification.upsert({
      where: { executionId },
      update: {},
      create: {
        executionId,
        mutationId: context?.mutationId ?? 'NO_VERIFIABLE_FINAL_MUTATION',
        context: context ?? {},
        state: !required
          ? 'NOT_REQUIRED'
          : context
            ? 'PENDING'
            : 'HUMAN_REQUIRED',
        ...(reason ? { reason } : {}),
      },
    });
    if (required) {
      const identity = {
        executionId,
        applicationId: execution.applicationId,
        jobId: execution.application.jobId,
        mutationId: context?.mutationId ?? null,
        requestFingerprint: context?.requestFingerprint ?? null,
      };
      if (context)
        await auditVerification(
          tx,
          record.id,
          'submission-attempt',
          'SUBMISSION_ATTEMPTED',
          identity,
        );
      if (context?.responseReceivedAt)
        await auditVerification(
          tx,
          record.id,
          'submission-response',
          'SUBMISSION_RESPONSE_RECEIVED',
          { ...identity, httpStatus: context.responseStatus ?? null },
        );
      if (execution.state === 'SUBMISSION_UNKNOWN')
        await auditVerification(
          tx,
          record.id,
          'submission-unknown',
          'SUBMISSION_UNKNOWN',
          identity,
        );
      if (!context)
        await auditVerification(
          tx,
          record.id,
          'missing-artifacts',
          'HUMAN_REVIEW_REQUIRED',
          { ...identity, reason: reason! },
        );
      if (!context)
        await tx.application.update({
          where: { id: execution.applicationId },
          data: { state: 'HUMAN_REQUIRED' },
        });
    }
    return record;
  });
}

export async function assertVerificationContextCurrent(
  tx: VerificationTransaction,
  context: VerificationContext,
) {
  const execution = await tx.applicationExecution.findFirst({
    where: {
      id: context.executionId,
      applicationId: context.applicationId,
      application: { userId: context.userId, jobId: context.jobId },
    },
  });
  if (!execution) throw new Error('VERIFICATION_IDENTITY_MISMATCH');
  const result = executionResultFromRecord(execution);
  const matches =
    result?.mutations?.filter((m) => m.mutationId === context.mutationId) ?? [];
  const mutation = matches[0];
  if (
    matches.length !== 1 ||
    !mutation ||
    mutation.executionId !== context.executionId ||
    mutation.action !== 'FINAL_SUBMIT' ||
    mutation.method !== 'POST' ||
    mutation.outcome !== context.mutationOutcome ||
    mutation.responseReceivedAt !== context.responseReceivedAt ||
    mutation.responseStatus !== context.responseStatus ||
    mutation.responseFingerprint !== context.responseFingerprint ||
    mutation.requestDigest !== context.requestFingerprint ||
    mutation.destination !== context.destination ||
    mutation.startedAt !== context.submissionStartedAt ||
    mutation.stepId !== context.stepId ||
    JSON.stringify(mutation.documentDigests) !==
      JSON.stringify(context.documentDigests) ||
    execution.mode !== context.mode
  )
    throw new Error('VERIFICATION_LEDGER_MISMATCH');
}

export async function refreshVerification(
  db: PrismaClient,
  executionId: string,
  userId: string,
) {
  return db.$transaction(async (tx) => {
    const record = await tx.submissionVerification.findFirst({
      where: { executionId, execution: { application: { userId } } },
    });
    if (!record) throw new Error('VERIFICATION_NOT_FOUND');
    assertVerificationTransition(record.state, 'PENDING');
    // Explicit refresh is required for a terminal outcome. Preserve established evidence.
    const changed = await tx.submissionVerification.updateMany({
      where: {
        id: record.id,
        generation: record.generation,
        state: record.state,
      },
      data: {
        state: 'PENDING',
        generation: { increment: 1 },
        infrastructureFailures: 0,
        runId: null,
        leaseUntil: null,
      },
    });
    if (changed.count !== 1) throw new Error('CONCURRENT_VERIFICATION');
    await auditVerification(
      tx,
      record.id,
      `refresh-${record.generation + 1}`,
      'RECOVERY_STARTED',
      { action: 'REFRESH_VERIFICATION', executionId },
      userId,
    );
    return tx.submissionVerification.findUniqueOrThrow({
      where: { id: record.id },
    });
  });
}

export async function humanVerification(
  db: PrismaClient,
  executionId: string,
  userId: string,
  outcome: 'CONFIRMED' | 'REJECTED',
) {
  return db.$transaction(async (tx) => {
    const record = await tx.submissionVerification.findFirst({
      where: { executionId, execution: { application: { userId } } },
    });
    if (!record) throw new Error('VERIFICATION_NOT_FOUND');
    if (record.state !== 'HUMAN_REQUIRED')
      throw new Error('HUMAN_REVIEW_NOT_ACTIVE');
    assertVerificationTransition(record.state, outcome);
    const context = VerificationContextSchema.parse(record.context);
    if (
      context.executionId !== executionId ||
      context.userId !== userId ||
      context.mutationId !== record.mutationId
    )
      throw new Error('VERIFICATION_IDENTITY_MISMATCH');
    await assertVerificationContextCurrent(tx, context);
    const existing = await tx.verificationEvidence.findMany({
      where: { verificationId: record.id },
    });
    if (
      existing.some(
        (e) =>
          e.strength === 'STRONG' &&
          VerificationEvidenceSchema.parse(e.data).outcome !== outcome,
      )
    )
      throw new Error('CONFLICTING_EVIDENCE_REQUIRES_INVESTIGATION');
    const changed = await tx.submissionVerification.updateMany({
      where: {
        id: record.id,
        state: 'HUMAN_REQUIRED',
        generation: record.generation,
      },
      data: {
        state: outcome,
        establishedState: outcome,
        reason: `HUMAN_${outcome}`,
        runId: null,
        leaseUntil: null,
      },
    });
    if (changed.count !== 1) throw new Error('CONCURRENT_VERIFICATION');
    await storeEvidence(tx, record.id, context, [
      {
        ...evidenceIdentity(context),
        type:
          outcome === 'CONFIRMED'
            ? 'USER_CONFIRMED'
            : 'USER_CONFIRMED_REJECTED',
        source: 'USER',
        strength: 'STRONG',
        capturedAt: new Date().toISOString(),
        outcome,
      },
    ]);
    await auditVerification(
      tx,
      record.id,
      `human-${record.generation}`,
      `HUMAN_${outcome}`,
      { executionId, outcome },
      userId,
    );
    await tx.application.update({
      where: { id: context.applicationId },
      data: { state: outcome === 'CONFIRMED' ? 'SUBMITTED' : 'FAILED' },
    });
    return tx.submissionVerification.findUniqueOrThrow({
      where: { id: record.id },
    });
  });
}

export async function evidenceDecision(
  tx: VerificationTransaction,
  id: string,
  context: VerificationContext,
) {
  const all = await tx.verificationEvidence.findMany({
    where: { verificationId: id },
  });
  return reconcileEvidence(
    context,
    all.map((e) => VerificationEvidenceSchema.parse(e.data)),
  );
}
