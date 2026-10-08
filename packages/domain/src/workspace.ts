import { z } from 'zod';
import { ApplicationStateSchema } from './schemas.js';
import { InspectionStateSchema } from './inspection.js';
import { PreparationStateSchema } from './preparation.js';
import { ExecutionModeSchema, ExecutionStateSchema } from './execution.js';
import { VerificationStateSchema } from './verification.js';
import { EmailSummarySchema } from './email.js';
import { GoogleFormSummarySchema } from './google-forms.js';

// Read models only: no transitions or mutations belong to the workspace contract.
const timestamp = z.string().datetime();
const stage = {
  startedAt: timestamp.nullable(),
  completedAt: timestamp.nullable(),
  updatedAt: timestamp,
  issue: z.string().nullable(),
};
export const WorkspaceVerificationSchema = z
  .object({
    state: VerificationStateSchema,
    establishedState: VerificationStateSchema.nullable(),
    updatedAt: timestamp,
    verifiedAt: timestamp.nullable(),
    evidenceCount: z.number().int().nonnegative(),
    attemptCount: z.number().int().nonnegative(),
    summary: z.string(),
  })
  .strict();
export const WorkspaceExecutionSchema = z
  .object({
    mode: ExecutionModeSchema,
    state: ExecutionStateSchema,
    ...stage,
    verification: WorkspaceVerificationSchema.nullable(),
  })
  .strict();
export const ApplicationSummarySchema = z
  .object({
    id: z.string().min(1),
    state: ApplicationStateSchema,
    createdAt: timestamp,
    updatedAt: timestamp,
    lastActivityAt: timestamp,
    job: z
      .object({
        id: z.string(),
        title: z.string(),
        company: z.string(),
        location: z.string().nullable(),
        employmentType: z.string().nullable(),
        source: z.string(),
      })
      .strict(),
    plan: z
      .object({
        applicationType: z.string(),
        provider: z.string().nullable(),
        platform: z
          .enum([
            'GREENHOUSE',
            'LEVER',
            'ASHBY',
            'GOOGLE_FORM',
            'UNSUPPORTED',
            'OTHER',
          ])
          .optional(),
        applicationUrl: z.string().url().nullable().optional(),
        applicationEmail: z.string().email().nullable().optional(),
        requiresHumanReview: z.boolean(),
        createdAt: timestamp,
      })
      .strict()
      .nullable(),
    inspection: z
      .object({ state: InspectionStateSchema, ...stage })
      .strict()
      .nullable(),
    preparation: z
      .object({ state: PreparationStateSchema, ...stage })
      .strict()
      .nullable(),
    execution: WorkspaceExecutionSchema.nullable(),
    email: EmailSummarySchema.nullable().optional(),
    googleForm: GoogleFormSummarySchema.nullable().optional(),
    humanReviewRequired: z.boolean(),
    reviewReasons: z.array(z.string()),
    active: z.boolean(),
    executionReadiness: z
      .object({
        state: z.enum([
          'READY',
          'BLOCKED',
          'DISABLED',
          'PREPARATION_REQUIRED',
          'REVIEW_REQUIRED',
          'STARTED',
        ]),
        reason: z.string().nullable(),
        automatic: z.boolean(),
        browserAssisted: z.boolean().optional(),
      })
      .strict()
      .optional(),
  })
  .strict();
export const WorkspaceTimelineEntrySchema = z
  .object({
    id: z.string(),
    label: z.string(),
    at: timestamp,
  })
  .strict();
export const ApplicationDetailsSchema = ApplicationSummarySchema.extend({
  executionModes: z.array(ExecutionModeSchema).max(3).optional(),
  preparationAllowed: z.boolean().optional(),
  inspectionRetryAllowed: z.boolean().optional(),
  executions: z.array(WorkspaceExecutionSchema).max(3),
  timeline: z.array(WorkspaceTimelineEntrySchema).max(250),
  timelineTruncated: z.boolean(),
  preparationSummary: z
    .object({
      fieldCount: z.number().int().nonnegative(),
      answerCount: z.number().int().nonnegative(),
      reviewCount: z.number().int().nonnegative(),
      documents: z.array(
        z.object({ type: z.string(), selected: z.boolean() }).strict(),
      ),
    })
    .strict()
    .nullable(),
}).strict();
export const ApplicationsResponseSchema = z
  .object({
    applications: z.array(ApplicationSummarySchema).max(50),
    pagination: z
      .object({
        page: z.number(),
        limit: z.number(),
        total: z.number(),
        totalPages: z.number(),
      })
      .strict(),
  })
  .strict();
export type ApplicationSummary = z.infer<typeof ApplicationSummarySchema>;
export type ApplicationDetails = z.infer<typeof ApplicationDetailsSchema>;
export type ApplicationsResponse = z.infer<typeof ApplicationsResponseSchema>;
