import { z } from 'zod';
import { UrlSyntaxSchema } from './destination.js';
import { ApplicationTypeSchema } from './schemas.js';
import { ExecutionFlowSchema } from './execution-flow.js';

export const InspectionStateSchema = z.enum([
  'PENDING',
  'RUNNING',
  'COMPLETED',
  'HUMAN_REQUIRED',
  'FAILED',
]);
export const PlatformSchema = z.enum([
  'GREENHOUSE',
  'LEVER',
  'WORKDAY',
  'ASHBY',
  'SMARTRECRUITERS',
  'ICIMS',
  'GOOGLE_FORM',
  'GOOGLE_DOC',
  'LINKEDIN',
  'GENERIC_PORTAL',
  'UNKNOWN',
]);
export const FieldTypeSchema = z.enum([
  'TEXT',
  'EMAIL',
  'PHONE',
  'URL',
  'NUMBER',
  'DATE',
  'TEXTAREA',
  'SELECT',
  'RADIO',
  'CHECKBOX',
  'FILE',
  'UNKNOWN',
]);
export const SemanticTypeSchema = z.enum([
  'FIRST_NAME',
  'LAST_NAME',
  'FULL_NAME',
  'EMAIL',
  'PHONE',
  'ADDRESS',
  'CITY',
  'STATE',
  'COUNTRY',
  'LINKEDIN',
  'GITHUB',
  'PORTFOLIO',
  'RESUME',
  'COVER_LETTER',
  'EDUCATION',
  'DEGREE',
  'COLLEGE',
  'CGPA',
  'GRADUATION_DATE',
  'WORK_EXPERIENCE',
  'PROJECT_EXPERIENCE',
  'SKILLS',
  'SALARY_EXPECTATION',
  'NOTICE_PERIOD',
  'WORK_AUTHORIZATION',
  'SPONSORSHIP',
  'LOCATION',
  'CUSTOM_QUESTION',
  'UNKNOWN',
]);
export const ReviewReasonSchema = z.enum([
  'CAPTCHA',
  'AUTHENTICATION_REQUIRED',
  'INTERACTIVE_DISCOVERY_REQUIRED',
  'SENSITIVE_QUESTION',
  'UNEXPECTED_NAVIGATION',
  'PLATFORM_MISMATCH',
  'UNSUPPORTED_INTERACTION',
]);
const ShortText = z.string().max(1000);
export const ApplicationFieldSchema = z
  .object({
    id: z.string().min(1),
    domId: ShortText.optional(),
    name: ShortText.optional(),
    label: ShortText,
    type: FieldTypeSchema,
    required: z.boolean(),
    visible: z.boolean(),
    disabled: z.boolean(),
    readonly: z.boolean(),
    placeholder: ShortText.optional(),
    ariaLabel: ShortText.optional(),
    ariaDescribedBy: ShortText.optional(),
    options: z.array(ShortText).max(100).default([]),
    selectOptions: z
      .array(
        z
          .object({ label: ShortText, value: ShortText, disabled: z.boolean() })
          .strict(),
      )
      .max(100)
      .optional(),
    htmlType: ShortText.optional(),
    checkboxValue: ShortText.optional(),
    optionValue: ShortText.optional(),
    formId: z.string().optional(),
    selector: ShortText.optional(),
    source: z.enum(['DOM', 'ARIA']),
    semanticType: SemanticTypeSchema.optional(),
    minLength: z.number().int().nonnegative().optional(),
    maxLength: z.number().int().positive().optional(),
  })
  .strict();
export const ApplicationQuestionSchema = z
  .object({
    id: z.string(),
    text: ShortText,
    fieldId: z.string(),
    type: FieldTypeSchema,
    required: z.boolean(),
    sensitivity: z.enum(['NONE', 'CONSEQUENTIAL', 'DEMOGRAPHIC']),
    semanticType: SemanticTypeSchema,
    answerSource: z.literal('UNRESOLVED'),
    humanReviewRequired: z.boolean(),
  })
  .strict();
export const DocumentRequirementSchema = z
  .object({
    type: z.enum([
      'RESUME',
      'COVER_LETTER',
      'PORTFOLIO',
      'TRANSCRIPT',
      'OTHER',
    ]),
    label: ShortText,
    required: z.boolean(),
    fieldId: z.string(),
    acceptedFileTypes: z.array(ShortText).max(30),
    humanReviewRequired: z.boolean(),
  })
  .strict();
export const InspectedFormSchema = z
  .object({
    id: z.string(),
    actionUrl: UrlSyntaxSchema.optional(),
    method: z.enum(['GET', 'POST', 'OTHER']),
    label: ShortText.optional(),
    fieldIds: z.array(z.string()).max(300),
    submitControls: z.array(ShortText).max(30),
    hiddenFields: z
      .array(
        z
          .object({
            name: ShortText,
            valueDigest: z.string().regex(/^[a-f0-9]{64}$/),
          })
          .strict(),
      )
      .max(100)
      .optional(),
  })
  .strict();
export const ApplicationSchemaSchema = z
  .object({
    inspectionId: z.string().min(1),
    applicationPlanId: z.string().min(1),
    sourceUrl: UrlSyntaxSchema,
    finalUrl: UrlSyntaxSchema,
    redirectChain: z.array(UrlSyntaxSchema).max(20),
    finalHostname: z.string().min(1),
    plannedApplicationType: ApplicationTypeSchema,
    platform: PlatformSchema,
    platformDiscrepancy: z.boolean(),
    title: ShortText,
    fields: z.array(ApplicationFieldSchema).max(300),
    questions: z.array(ApplicationQuestionSchema).max(300),
    documents: z.array(DocumentRequirementSchema).max(100),
    forms: z.array(InspectedFormSchema).max(100),
    executionFlow: ExecutionFlowSchema.optional(),
    authentication: z.object({ required: z.boolean() }).strict(),
    humanReview: z
      .object({ required: z.boolean(), reasons: z.array(ReviewReasonSchema) })
      .strict(),
    confidence: z.number().min(0).max(1),
    inspectionMetadata: z
      .object({
        inspectedAt: z.string().datetime(),
        durationMs: z.number().nonnegative(),
        visibleTextExcerpt: z.string().max(4000),
        fieldCount: z.number().int().nonnegative(),
      })
      .strict(),
  })
  .strict();
export type ApplicationSchema = z.infer<typeof ApplicationSchemaSchema>;
export type InspectionState = z.infer<typeof InspectionStateSchema>;
export type ApplicationField = z.infer<typeof ApplicationFieldSchema>;

export const inspectionTransitions: Record<
  InspectionState,
  readonly InspectionState[]
> = {
  PENDING: ['RUNNING', 'FAILED'],
  RUNNING: ['COMPLETED', 'HUMAN_REQUIRED', 'FAILED'],
  COMPLETED: [],
  // Only a guarded worker may clear a sensitive-question-only review after
  // preparation validates explicit candidate answers. Security gates stay closed.
  HUMAN_REQUIRED: ['COMPLETED'],
  FAILED: ['PENDING'],
};

export function canTransitionInspection(
  from: InspectionState,
  to: InspectionState,
): boolean {
  return inspectionTransitions[from].includes(to);
}

export interface ApplicationSemanticAnalyzer {
  analyze(schema: ApplicationSchema): Promise<ApplicationSchema>;
}
