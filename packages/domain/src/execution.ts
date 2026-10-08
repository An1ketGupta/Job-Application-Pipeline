import { z } from 'zod';
import { isAcceptedAiAnswer } from './answer-pipeline.js';
import { matchesAtsTarget } from './ats.js';
import { ApplicationPlanSchema, type ApplicationPlan } from './schemas.js';
import {
  ApplicationSchemaSchema,
  applicationAnswerFields,
  expandApplicationAnswerValues,
} from './inspection.js';
import { validFieldValue } from './preparation-engine.js';
import {
  PreparedApplicationSchema,
  UserDocumentSchema,
} from './preparation.js';

export const ExecutionModeSchema = z.enum([
  'DRY_RUN',
  'TEST_FIXTURE',
  'REAL_EXECUTION',
]);
export const ExecutionStateSchema = z.enum([
  'PENDING',
  'PREPARING',
  'RUNNING',
  'PAUSED_HUMAN_REQUIRED',
  'SUBMITTING',
  'SUBMITTED',
  'SUBMISSION_UNKNOWN',
  'DRY_RUN_COMPLETED',
  'FAILED',
  'BLOCKED',
]);
export type ExecutionState = z.infer<typeof ExecutionStateSchema>;
export const executionTransitions: Record<
  ExecutionState,
  readonly ExecutionState[]
> = {
  PENDING: ['PREPARING', 'BLOCKED', 'FAILED'],
  PREPARING: ['RUNNING', 'BLOCKED', 'FAILED', 'PAUSED_HUMAN_REQUIRED'],
  RUNNING: [
    'PAUSED_HUMAN_REQUIRED',
    'SUBMITTING',
    'DRY_RUN_COMPLETED',
    'FAILED',
    'BLOCKED',
    'SUBMISSION_UNKNOWN',
  ],
  PAUSED_HUMAN_REQUIRED: ['PENDING', 'BLOCKED'],
  SUBMITTING: ['SUBMITTED', 'FAILED', 'SUBMISSION_UNKNOWN'],
  SUBMITTED: [],
  SUBMISSION_UNKNOWN: [],
  DRY_RUN_COMPLETED: [],
  FAILED: [],
  BLOCKED: [],
};
export const canTransitionExecution = (
  from: ExecutionState,
  to: ExecutionState,
) => executionTransitions[from].includes(to);
export const ExecutionStepSchema = z
  .object({
    stepId: z.string().min(1),
    type: z.enum([
      'NAVIGATE',
      'VALIDATE_PAGE',
      'FILL_FIELD',
      'SELECT_OPTION',
      'CHECK_OPTION',
      'UPLOAD_DOCUMENT',
      'NAVIGATE_NEXT',
      'HUMAN_REVIEW',
      'PRE_SUBMIT_VALIDATION',
      'SUBMIT',
      'VERIFY_SUBMISSION',
    ]),
    targetRef: z.string().min(1),
    status: z.enum([
      'RUNNING',
      'COMPLETED',
      'SIMULATED',
      'FAILED',
      'HUMAN_REQUIRED',
    ]),
    attempt: z.number().int().positive(),
    startedAt: z.string().datetime(),
    completedAt: z.string().datetime().optional(),
    error: z
      .string()
      .regex(/^[A-Z_]+$/)
      .optional(),
  })
  .strict();
export type ExecutionStep = z.infer<typeof ExecutionStepSchema>;
export const ExecutionCheckpointSchema = z
  .object({
    sessionId: z.string().min(1),
    pageIndex: z.number().int().nonnegative(),
    nextFieldIndex: z.number().int().nonnegative(),
    appliedFieldIds: z.array(z.string()),
    unsafeActionStarted: z.boolean(),
    resumable: z.boolean(),
    reviewRequirement: z
      .object({
        reason: z.string(),
        pageUrl: z.string(),
        fingerprint: z.string(),
        checkpoint: z.string(),
        id: z.string().optional(),
        type: z.enum(['SECURITY_CONTROL', 'FLOW_CONTROL']).optional(),
        createdAt: z.string().datetime().optional(),
        status: z.enum(['ACTIVE', 'RESOLVED']).optional(),
        resolvedAt: z.string().datetime().optional(),
        resolution: z
          .enum(['TRUSTED_CONTROL_REMOVAL', 'TRUSTED_DOCUMENT_TRANSITION'])
          .optional(),
        documentBackendNodeId: z.number().int().optional(),
        surroundingDomDigest: z.string().optional(),
        controls: z
          .array(
            z
              .object({
                backendNodeId: z.number().int(),
                structuralDigest: z.string(),
                locationDigest: z.string(),
              })
              .strict(),
          )
          .optional(),
      })
      .strict()
      .optional(),
    documentIdentities: z
      .array(
        z
          .object({
            fieldId: z.string(),
            documentId: z.string(),
            sha256: z.string().regex(/^[a-f0-9]{64}$/),
            name: z.string(),
            mimeType: z.string(),
            size: z.number().int().nonnegative(),
          })
          .strict(),
      )
      .optional(),
  })
  .strict();
export type ExecutionCheckpoint = z.infer<typeof ExecutionCheckpointSchema>;
export const ExecutionResultSchema = z
  .object({
    applicationId: z.string().min(1),
    executionId: z.string().min(1),
    mode: ExecutionModeSchema,
    status: ExecutionStateSchema,
    startedAt: z.string().datetime(),
    completedAt: z.string().datetime().optional(),
    steps: z.array(ExecutionStepSchema).max(2000),
    submittedAt: z.string().datetime().optional(),
    confirmation: z
      .object({
        identifier: z.string().min(1).max(200),
        source: z.literal('LOCAL_FIXTURE'),
      })
      .strict()
      .optional(),
    humanReviewItems: z.array(
      z
        .object({
          reason: z.string().regex(/^[A-Z_]+$/),
          targetRef: z.string().min(1),
          stepId: z.string().min(1),
          safeContinuationPoint: z.string().min(1),
        })
        .strict(),
    ),
    error: z
      .string()
      .regex(/^[A-Z_]+$/)
      .optional(),
    checkpoint: ExecutionCheckpointSchema.optional(),
    mutations: z
      .array(
        z
          .object({
            mutationId: z.string(),
            executionId: z.string(),
            stepId: z.string(),
            action: z.enum(['NEXT', 'FINAL_SUBMIT']),
            destination: z.string(),
            method: z.string(),
            requestDigest: z.string(),
            documentDigests: z.array(z.string()),
            startedAt: z.string().datetime(),
            completedAt: z.string().datetime().optional(),
            responseReceivedAt: z.string().datetime().optional(),
            responseStatus: z.number().int().min(100).max(599).optional(),
            providerOutcome: z.enum(['CONFIRMED', 'REJECTED']).optional(),
            responseFingerprint: z
              .string()
              .regex(/^[a-f0-9]{64}$/)
              .optional(),
            outcome: z.enum([
              'AUTHORIZED',
              'REJECTED',
              'DISPATCHING',
              'FORWARDED',
              'UNKNOWN',
            ]),
          })
          .strict(),
      )
      .optional(),
    metadata: z
      .object({ platform: z.string(), durationMs: z.number().nonnegative() })
      .strict(),
  })
  .strict()
  .superRefine((result, ctx) => {
    if (
      result.status === 'SUBMITTED' &&
      (!result.confirmation ||
        !result.submittedAt ||
        result.mode !== 'TEST_FIXTURE')
    )
      ctx.addIssue({
        code: 'custom',
        message:
          'Submission requires a fixture receipt; real verification is Phase 5',
      });
    if (
      result.status === 'PAUSED_HUMAN_REQUIRED' &&
      !result.humanReviewItems.length
    )
      ctx.addIssue({
        code: 'custom',
        message: 'Paused execution requires review items',
      });
    if (result.status === 'SUBMISSION_UNKNOWN' && result.checkpoint?.resumable)
      ctx.addIssue({
        code: 'custom',
        message: 'Unknown outcomes cannot resume',
      });
  });
export type ExecutionResult = z.infer<typeof ExecutionResultSchema>;
export const ExecutionInputSchema = z
  .object({
    applicationId: z.string().min(1),
    executionId: z.string().min(1),
    jobId: z.string().min(1),
    ownerId: z.string().min(1).optional(),
    eligibilityState: z.enum(['RESOLVED', 'READY']).optional(),
    dispatchIdentity: z
      .object({
        userId: z.string().min(1),
        runId: z.string().min(1),
        generation: z.number().int().positive(),
      })
      .strict()
      .optional(),
    applicationPlanId: z.string().min(1),
    inspectionId: z.string().min(1),
    preparationId: z.string().min(1),
    preparationVersion: z.number().int().positive(),
    currentPreparationVersion: z.number().int().positive(),
    preparationUpdatedAt: z.string().datetime(),
    inspectionState: z.literal('COMPLETED'),
    preparationState: z.literal('COMPLETED'),
    plan: ApplicationPlanSchema,
    inspection: ApplicationSchemaSchema,
    preparedApplication: PreparedApplicationSchema,
    documents: z.array(UserDocumentSchema),
    mode: ExecutionModeSchema,
    previousResult: ExecutionResultSchema.optional(),
  })
  .strict()
  .superRefine((input, ctx) => {
    const { plan, inspection: schema, preparedApplication: prepared } = input;
    if (
      input.mode === 'REAL_EXECUTION' &&
      plan.destination.target?.fixtureSourceUrl
    )
      ctx.addIssue({
        code: 'custom',
        message: 'Fixture targets cannot execute on real platforms',
      });
    const target = plan.destination.target;
    if (
      target &&
      (schema.platform !== target.platform ||
        (!target.fixtureSourceUrl &&
          !matchesAtsTarget(target, schema.finalUrl)))
    )
      ctx.addIssue({
        code: 'custom',
        message: 'Inspected ATS target mismatch',
      });
    if (
      input.dispatchIdentity &&
      input.ownerId &&
      input.dispatchIdentity.userId !== input.ownerId
    )
      ctx.addIssue({ code: 'custom', message: 'Dispatch owner mismatch' });
    if (plan.executor !== 'BROWSER' || plan.requiresHumanReview)
      ctx.addIssue({ code: 'custom', message: 'Browser executor required' });
    if (
      prepared.applicationId !== input.applicationId ||
      prepared.jobId !== input.jobId ||
      plan.jobId !== input.jobId ||
      schema.inspectionId !== input.inspectionId ||
      prepared.inspectionId !== input.inspectionId ||
      schema.applicationPlanId !== input.applicationPlanId ||
      schema.sourceUrl !== plan.destination.url ||
      schema.plannedApplicationType !== plan.applicationType ||
      schema.finalHostname !== new URL(schema.finalUrl).hostname
    )
      ctx.addIssue({ code: 'custom', message: 'Execution identity mismatch' });
    if (
      input.preparationVersion !== input.currentPreparationVersion ||
      Date.parse(prepared.preparedAt) <
        Date.parse(schema.inspectionMetadata.inspectedAt)
    )
      ctx.addIssue({ code: 'custom', message: 'Stale preparation' });
    if (
      schema.platformDiscrepancy ||
      ['GOOGLE_FORM', 'GOOGLE_DOC', 'LINKEDIN', 'UNKNOWN'].includes(
        schema.platform,
      )
    )
      ctx.addIssue({
        code: 'custom',
        message: 'Unsupported or changed platform',
      });
    if (
      prepared.overallStatus !== 'COMPLETED' ||
      prepared.humanReviewItems.length ||
      [...prepared.fields, ...prepared.questions, ...prepared.documents].some(
        (f) => f.requiresHumanReview,
      ) ||
      schema.authentication.required ||
      schema.humanReview.required
    )
      ctx.addIssue({ code: 'custom', message: 'Unresolved human review' });
    for (const ids of [
      schema.fields.map((f) => f.id),
      schema.questions.map((q) => q.id),
      prepared.fields.map((f) => f.fieldId),
      prepared.questions.map((q) => q.questionId),
      prepared.documents.map((d) => d.requirementId),
      input.documents.map((d) => d.id),
    ])
      if (new Set(ids).size !== ids.length)
        ctx.addIssue({ code: 'custom', message: 'Duplicate identity' });
    const values = new Map<string, string | null>();
    for (const field of prepared.fields) {
      if (
        !schema.fields.some(
          (f) => f.id === field.fieldId && f.type !== 'FILE',
        ) ||
        values.has(field.fieldId)
      )
        ctx.addIssue({ code: 'custom', message: 'Wrong prepared field' });
      if (
        [
          'SALARY_EXPECTATION',
          'SPONSORSHIP',
          'WORK_AUTHORIZATION',
          'NOTICE_PERIOD',
        ].includes(field.semanticType) &&
        field.value !== null &&
        field.source !== 'USER_VERIFIED' &&
        !isAcceptedAiAnswer(field)
      )
        ctx.addIssue({ code: 'custom', message: 'Unverified sensitive field' });
      values.set(field.fieldId, field.value);
    }
    for (const question of prepared.questions) {
      const expected = schema.questions.find(
        (q) => q.id === question.questionId,
      );
      if (
        !expected ||
        values.has(expected.fieldId) ||
        (expected.sensitivity !== 'NONE' &&
          question.answer !== null &&
          question.source !== 'USER_VERIFIED' &&
          !isAcceptedAiAnswer(question))
      )
        ctx.addIssue({
          code: 'custom',
          message: 'Wrong or unverified prepared question',
        });
      if (expected) values.set(expected.fieldId, question.answer);
    }
    for (const document of prepared.documents) {
      const expected = schema.documents.find(
        (d) => d.fieldId === document.requirementId,
      );
      const stored = input.documents.find((d) => d.id === document.documentId);
      if (
        !expected ||
        (document.documentId &&
          (!stored ||
            stored.type !== expected.type ||
            stored.type !== document.documentType))
      )
        ctx.addIssue({ code: 'custom', message: 'Wrong prepared document' });
    }
    for (const question of schema.questions) {
      if (
        !schema.fields.some(
          (f) => f.id === question.fieldId && f.type === question.type,
        ) ||
        (question.required &&
          !prepared.questions.some(
            (q) => q.questionId === question.id && q.answer?.trim(),
          ))
      )
        ctx.addIssue({
          code: 'custom',
          message: 'Missing required question or invalid reference',
        });
    }
    for (const document of schema.documents) {
      if (
        !schema.fields.some(
          (f) => f.id === document.fieldId && f.type === 'FILE',
        ) ||
        (document.required &&
          !prepared.documents.some(
            (d) => d.requirementId === document.fieldId && d.documentId,
          ))
      )
        ctx.addIssue({
          code: 'custom',
          message: 'Missing required document or invalid reference',
        });
    }
    for (const field of applicationAnswerFields(schema.fields)) {
      if (
        field.choiceGroup &&
        values.get(field.id) != null &&
        !validFieldValue(values.get(field.id), field)
      )
        ctx.addIssue({
          code: 'custom',
          message: 'Invalid choice group answer',
        });
      if (field.choiceGroup) {
        if (field.required && !validFieldValue(values.get(field.id), field))
          ctx.addIssue({
            code: 'custom',
            message: 'Missing mandatory choice group answer',
          });
        continue;
      }
      const radioGroup =
        field.type === 'RADIO'
          ? schema.fields.filter(
              (f) =>
                f.type === 'RADIO' &&
                (field.name
                  ? f.name === field.name && f.formId === field.formId
                  : f.id === field.id),
            )
          : [];
      const radioAnswers = radioGroup.filter((f) => values.get(f.id) != null);
      if (field.type === 'RADIO' && radioAnswers.length > 1)
        ctx.addIssue({ code: 'custom', message: 'Conflicting radio answers' });
      if (
        field.required &&
        (field.type === 'FILE'
          ? !prepared.documents.some(
              (d) => d.requirementId === field.id && d.documentId,
            )
          : field.type === 'RADIO'
            ? radioAnswers.length !== 1
            : !values.get(field.id)?.trim())
      )
        ctx.addIssue({ code: 'custom', message: 'Missing mandatory value' });
    }
    const flow = schema.executionFlow;
    if (flow) {
      const ids = flow.pages.flatMap((p) => p.fieldIds);
      if (
        new Set(ids).size !== ids.length ||
        ids.some((id) => !schema.fields.some((f) => f.id === id)) ||
        schema.fields.some((f) => f.required && !ids.includes(f.id)) ||
        flow.pages[0]?.url !== schema.finalUrl ||
        flow.pages.some(
          (p, i) =>
            p.action !== (i === flow.pages.length - 1 ? 'SUBMIT' : 'NEXT') ||
            (i < flow.pages.length - 1 &&
              p.expectedUrl !== flow.pages[i + 1]?.url),
        )
      )
        ctx.addIssue({ code: 'custom', message: 'Invalid explicit flow' });
      if (
        flow.pages.some(
          (p) =>
            !schema.forms.some(
              (f) =>
                f.id === p.control.formId &&
                (f.actionUrl ?? schema.finalUrl) === p.control.actionUrl &&
                f.method === p.control.method,
            ),
        )
      )
        ctx.addIssue({
          code: 'custom',
          message: 'Flow form identity mismatch',
        });
      if (
        flow.pages.some(
          (p) => p.action === 'SUBMIT' && p.control.method !== 'POST',
        )
      )
        ctx.addIssue({
          code: 'custom',
          message: 'Final submission requires a non-replayed POST transport',
        });
      if (
        [...values].some(
          ([id, value]) => value !== null && !ids.includes(id),
        ) ||
        prepared.documents.some(
          (d) => d.documentId && !ids.includes(d.requirementId),
        )
      )
        ctx.addIssue({
          code: 'custom',
          message: 'Prepared instruction missing from flow',
        });
    }
    if (
      input.previousResult &&
      (input.previousResult.applicationId !== input.applicationId ||
        input.previousResult.executionId !== input.executionId ||
        input.previousResult.mode !== input.mode ||
        input.previousResult.status !== 'PAUSED_HUMAN_REQUIRED' ||
        !input.previousResult.checkpoint?.resumable ||
        input.previousResult.checkpoint.unsafeActionStarted)
    )
      ctx.addIssue({ code: 'custom', message: 'Unsafe resume' });
  });
export type ExecutionInput = z.infer<typeof ExecutionInputSchema>;
export function preparedValues(
  input: ExecutionInput,
): Map<string, string | null> {
  const values = new Map(
    input.preparedApplication.fields.map((f) => [f.fieldId, f.value]),
  );
  for (const q of input.preparedApplication.questions) {
    const fieldId = input.inspection.questions.find(
      (s) => s.id === q.questionId,
    )?.fieldId;
    if (fieldId) values.set(fieldId, q.answer);
  }
  return expandApplicationAnswerValues(input.inspection.fields, values);
}
export interface ExecutionObserver {
  // Must durably commit before returning, especially SUBMITTING and unsafe checkpoints.
  persist(result: ExecutionResult): Promise<void>;
  // Runs at the request transport boundary; production supplies an input/lease freshness check.
  authorizeDispatch?(): Promise<void>;
}
export interface ApplicationExecutor {
  canHandle(plan: ApplicationPlan): boolean;
  execute(
    input: ExecutionInput,
    observer?: ExecutionObserver,
  ): Promise<ExecutionResult>;
}
export interface DocumentStorage {
  resolve(
    document: z.infer<typeof UserDocumentSchema>,
    acceptedFileTypes: string[],
  ): Promise<{ name: string; mimeType: string; buffer: Uint8Array }>;
}
