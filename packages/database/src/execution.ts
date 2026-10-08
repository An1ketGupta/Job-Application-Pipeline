import { createHash } from 'node:crypto';
import {
  ExecutionInputSchema,
  ExecutionResultSchema,
  type ExecutionInput,
} from '@careerlift/domain';
import type { Prisma } from '@prisma/client';

export const executionApplicationInclude = {
  plan: true,
  inspection: true,
  preparation: true,
  user: { include: { documents: true } },
} as const;
export type ExecutionApplication = Prisma.ApplicationGetPayload<{
  include: typeof executionApplicationInclude;
}>;
export function executionInputFromApplication(
  application: ExecutionApplication,
  execution: {
    id: string;
    mode: unknown;
    preparationVersion: number;
  },
  previousResult?: unknown,
): ExecutionInput {
  const { plan, inspection, preparation } = application;
  if (
    !plan ||
    !inspection ||
    !preparation ||
    plan.applicationId !== application.id ||
    inspection.applicationId !== application.id ||
    preparation.applicationId !== application.id ||
    inspection.applicationPlanId !== plan.id ||
    preparation.inspectionId !== inspection.id
  )
    throw new Error('EXECUTION_RELATIONSHIP_MISMATCH');
  return ExecutionInputSchema.parse({
    applicationId: application.id,
    ownerId: application.userId,
    eligibilityState: application.state,
    executionId: execution.id,
    jobId: application.jobId,
    applicationPlanId: plan.id,
    inspectionId: inspection.id,
    preparationId: preparation.id,
    preparationVersion: execution.preparationVersion,
    currentPreparationVersion: preparation.version,
    preparationUpdatedAt: preparation.updatedAt.toISOString(),
    inspectionState: inspection.state,
    preparationState: preparation.state,
    plan: {
      jobId: application.jobId,
      applicationType: plan.applicationType,
      provider: plan.provider ?? undefined,
      destination: plan.destination,
      requirements: plan.requirements,
      actions: plan.actions,
      executor: plan.executor,
      confidence: plan.confidence,
      requiresHumanReview: plan.requiresHumanReview,
      reasoning: plan.reasoning,
      resolvedBy: plan.resolvedBy,
    },
    inspection: inspection.result,
    preparedApplication: preparation.result,
    documents: [...application.user.documents]
      .filter((d) => !d.archivedAt)
      .sort((a, b) => a.id.localeCompare(b.id))
      .map((d) => ({
        id: d.id,
        type: d.type,
        name: d.name,
        storageRef: d.storageRef,
        mimeType: d.mimeType,
        size: d.size,
        metadata: d.metadata,
      })),
    mode: execution.mode,
    ...(previousResult ? { previousResult } : {}),
  });
}
export const executionInputHash = (input: ExecutionInput) =>
  createHash('sha256')
    .update(
      JSON.stringify({
        ...input,
        previousResult: undefined,
        dispatchIdentity: undefined,
      }),
    )
    .digest('hex');
export function executionResultFromRecord(record: {
  id: string;
  applicationId: string;
  mode: string;
  result: unknown;
}) {
  if (!record.result) return undefined;
  const result = ExecutionResultSchema.parse(record.result);
  if (
    result.applicationId !== record.applicationId ||
    result.executionId !== record.id ||
    result.mode !== record.mode
  )
    throw new Error('EXECUTION_RESULT_IDENTITY_MISMATCH');
  return result;
}
