import { z } from 'zod';
import { UrlSyntaxSchema } from './destination.js';
import { ApplicationTypeSchema } from './schemas.js';
import { ExecutionFlowSchema } from './execution-flow.js';
import { AshbySubmissionSchema } from './ashby-submission.js';
import { GreenhouseSubmissionSchema } from './greenhouse-submission.js';

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
    questionLabel: ShortText.optional(),
    questionRequired: z.boolean().optional(),
    description: ShortText.optional(),
    choiceGroup: z
      .object({ id: ShortText, label: ShortText, required: z.boolean() })
      .strict()
      .optional(),
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
    phoneFormat: z.literal('INTERNATIONAL').optional(),
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
    ashbySubmission: AshbySubmissionSchema.optional(),
    greenhouseSubmission: GreenhouseSubmissionSchema.optional(),
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
        formParserVersion: z.number().int().positive().optional(),
      })
      .strict(),
  })
  .strict();
export type ApplicationSchema = z.infer<typeof ApplicationSchemaSchema>;
export type InspectionState = z.infer<typeof InspectionStateSchema>;
export type ApplicationField = z.infer<typeof ApplicationFieldSchema>;

// Keep physical controls intact for DOM identity checks. Preparation and review
// consume one logical field per question, with the group's allowed labels.
export function applicationAnswerFields(
  fields: ApplicationField[],
): ApplicationField[] {
  const seen = new Set<string>();
  return fields.flatMap((field) => {
    if (!field.choiceGroup)
      return [
        {
          ...field,
          label: field.questionLabel ?? field.label,
          required: field.questionRequired ?? field.required,
        },
      ];
    const key = `${field.formId ?? ''}:${field.type}:${field.choiceGroup.id}`;
    if (seen.has(key)) return [];
    seen.add(key);
    const members = fields.filter(
      (f) =>
        f.type === field.type &&
        f.formId === field.formId &&
        f.choiceGroup?.id === field.choiceGroup!.id,
    );
    return [
      {
        ...field,
        label: field.choiceGroup.label,
        required: field.choiceGroup.required,
        options: members
          .filter((f) => !f.disabled && !f.readonly)
          .map((f) => f.label),
      },
    ];
  });
}

export function selectedChoiceLabels(value: string): string[] | undefined {
  try {
    const parsed: unknown = JSON.parse(value);
    return Array.isArray(parsed) &&
      parsed.every((v) => typeof v === 'string') &&
      new Set(parsed).size === parsed.length
      ? parsed
      : undefined;
  } catch {
    return undefined;
  }
}

export function expandApplicationAnswerValues(
  fields: ApplicationField[],
  values: Map<string, string | null>,
) {
  const expanded = new Map(values);
  for (const field of applicationAnswerFields(fields).filter(
    (f) => f.choiceGroup,
  )) {
    const value = values.get(field.id);
    const selected =
      value == null
        ? []
        : field.type === 'CHECKBOX'
          ? (selectedChoiceLabels(value) ?? [])
          : [value];
    for (const member of fields.filter(
      (f) =>
        f.type === field.type &&
        f.formId === field.formId &&
        f.choiceGroup?.id === field.choiceGroup!.id,
    )) {
      expanded.set(
        member.id,
        field.type === 'CHECKBOX'
          ? selected.includes(member.label)
            ? 'true'
            : 'false'
          : selected.includes(member.label)
            ? (member.optionValue ?? member.label)
            : null,
      );
    }
  }
  return expanded;
}

// Only an empty discovery result can be retried. A fresh inspection must still
// pass every security check; this never clears a security or answer review.
export function canRetryEmptyInspection(inspection: {
  id: string;
  applicationPlanId: string;
  state: string;
  errorCode: string | null;
  result: unknown;
}): boolean {
  const parsed = ApplicationSchemaSchema.safeParse(inspection.result);
  return (
    inspection.state === 'HUMAN_REQUIRED' &&
    (!inspection.errorCode ||
      inspection.errorCode === 'FORM_FIELDS_NOT_FOUND') &&
    parsed.success &&
    parsed.data.inspectionId === inspection.id &&
    parsed.data.applicationPlanId === inspection.applicationPlanId &&
    parsed.data.fields.length === 0 &&
    parsed.data.humanReview.required &&
    parsed.data.humanReview.reasons.length === 1 &&
    parsed.data.humanReview.reasons[0] === 'INTERACTIVE_DISCOVERY_REQUIRED'
  );
}

export function canRepairChoiceInspection(inspection: {
  id: string;
  applicationPlanId: string;
  state: string;
  errorCode: string | null;
  result: unknown;
}): boolean {
  const parsed = ApplicationSchemaSchema.safeParse(inspection.result);
  return (
    parsed.success &&
    inspection.state === 'COMPLETED' &&
    !inspection.errorCode &&
    parsed.data.inspectionId === inspection.id &&
    parsed.data.applicationPlanId === inspection.applicationPlanId &&
    !parsed.data.humanReview.required &&
    !parsed.data.authentication.required &&
    (parsed.data.inspectionMetadata.formParserVersion ?? 1) < 2 &&
    parsed.data.fields.some((f) => ['RADIO', 'CHECKBOX'].includes(f.type)) &&
    !parsed.data.fields.some((f) => f.choiceGroup)
  );
}

export function canRepairSubmissionInspection(inspection: {
  id: string;
  applicationPlanId: string;
  state: string;
  errorCode: string | null;
  result: unknown;
}): boolean {
  const parsed = ApplicationSchemaSchema.safeParse(inspection.result);
  return (
    parsed.success &&
    inspection.state === 'COMPLETED' &&
    !inspection.errorCode &&
    parsed.data.inspectionId === inspection.id &&
    parsed.data.applicationPlanId === inspection.applicationPlanId &&
    parsed.data.platform === 'ASHBY' &&
    !parsed.data.ashbySubmission &&
    !parsed.data.executionFlow &&
    !parsed.data.authentication.required &&
    !parsed.data.humanReview.required
  );
}

// Retry old Greenhouse parser outcomes through the complete network/security
// inspection again. This never turns a prior failure into successful inspection.
export function canRepairGreenhouseInspection(
  inspection: {
    id: string;
    applicationPlanId: string;
    state: string;
    errorCode: string | null;
    result: unknown;
  },
  provider: string | null | undefined,
): boolean {
  if (provider !== 'GREENHOUSE') return false;
  const parsed = ApplicationSchemaSchema.safeParse(inspection.result);
  if (parsed.success)
    return (
      inspection.state === 'COMPLETED' &&
      parsed.data.inspectionId === inspection.id &&
      parsed.data.applicationPlanId === inspection.applicationPlanId &&
      parsed.data.platform === 'GREENHOUSE' &&
      (parsed.data.inspectionMetadata.formParserVersion ?? 1) < 5
    );
  return (
    inspection.result == null &&
    inspection.state === 'HUMAN_REQUIRED' &&
    ['MUTATING_REQUEST_BLOCKED', 'UNEXPECTED_NAVIGATION'].includes(
      inspection.errorCode ?? '',
    )
  );
}

export const inspectionTransitions: Record<
  InspectionState,
  readonly InspectionState[]
> = {
  PENDING: ['RUNNING', 'FAILED'],
  RUNNING: ['COMPLETED', 'HUMAN_REQUIRED', 'FAILED'],
  // Reinspection is guarded by canRepairChoiceInspection and lifecycle checks.
  COMPLETED: ['PENDING'],
  // Only a guarded worker may clear a sensitive-question-only review after
  // preparation validates explicit candidate answers. Security gates stay closed.
  // PENDING is restricted by canRetryEmptyInspection and API ownership/lifecycle guards.
  HUMAN_REQUIRED: ['COMPLETED', 'PENDING'],
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
