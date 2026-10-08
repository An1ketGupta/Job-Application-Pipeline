import { z } from 'zod';
import { ApplicationTargetSchema } from './ats.js';
import {
  ApplicationDestinationUrlSchema,
  UrlSyntaxSchema,
} from './destination.js';

export const applicationTypes = [
  'DIRECT_PORTAL',
  'EMAIL',
  'GOOGLE_FORM',
  'GOOGLE_DOC',
  'EXTERNAL_ATS',
  'LINKEDIN',
  'UNKNOWN',
  'HUMAN_REQUIRED',
] as const;
export const atsProviders = [
  'GREENHOUSE',
  'LEVER',
  'WORKDAY',
  'ASHBY',
  'SMARTRECRUITERS',
  'ICIMS',
  'OTHER',
  'UNKNOWN',
] as const;
export const requirementTypes = [
  'RESUME',
  'COVER_LETTER',
  'EMAIL',
  'PHONE',
  'LINKEDIN',
  'GITHUB',
  'PORTFOLIO',
  'EDUCATION',
  'WORK_EXPERIENCE',
  'SHORT_ANSWER',
  'LONG_ANSWER',
  'SALARY_EXPECTATION',
  'WORK_AUTHORIZATION',
  'SPONSORSHIP',
  'LOCATION',
  'NOTICE_PERIOD',
  'CUSTOM',
] as const;

export const ApplicationTypeSchema = z.enum(applicationTypes);
export const AtsProviderSchema = z.enum(atsProviders);
export const RequirementTypeSchema = z.enum(requirementTypes);
export const RequirementStatusSchema = z.enum([
  'required',
  'optional',
  'unknown',
  'human_required',
]);
export const ApplicationStateSchema = z.enum([
  'DISCOVERED',
  'ANALYZING',
  'RESOLVED',
  'READY',
  'EXECUTING',
  'VERIFYING',
  'SUBMITTED',
  'FAILED',
  'BLOCKED',
  'HUMAN_REQUIRED',
]);
export const ApplicationEventTypeSchema = z.enum([
  'JOB_DISCOVERED',
  'APPLICATION_ANALYSIS_STARTED',
  'APPLICATION_RESOLVED',
  'APPLICATION_RESOLUTION_FAILED',
  'HUMAN_REVIEW_REQUIRED',
  'APPLICATION_EXECUTION_STARTED',
  'APPLICATION_SUBMITTED',
  'APPLICATION_FAILED',
  'APPLICATION_INSPECTION_STARTED',
  'APPLICATION_INSPECTED',
  'APPLICATION_INSPECTION_FAILED',
]);

export const ApplicationInfoSchema = z
  .object({
    type: ApplicationTypeSchema.optional(),
    url: ApplicationDestinationUrlSchema.optional(),
    email: z.string().email().optional(),
    source: z.string().optional(),
    provider: AtsProviderSchema.optional(),
    reportedMethod: z.string().min(1).optional(),
    unrecognizedMethod: z.string().min(1).optional(),
    requiresHumanReview: z.boolean().optional(),
    structuredRequirements: z
      .array(
        z
          .object({
            type: RequirementTypeSchema,
            status: RequirementStatusSchema,
            label: z.string().min(1),
            source: z.literal('structured'),
          })
          .strict(),
      )
      .optional(),
  })
  .strict();

export const JobSchema = z
  .object({
    id: z.string().min(1),
    externalId: z.string().min(1),
    source: z.string().min(1),
    company: z.string().min(1),
    title: z.string().min(1),
    location: z.string().optional(),
    employmentType: z.string().optional(),
    description: z.string().optional(),
    requirements: z.array(z.string()).default([]),
    application: ApplicationInfoSchema.optional(),
    sourceUrl: UrlSyntaxSchema.optional(),
    createdAt: z.string().datetime().optional(),
    updatedAt: z.string().datetime().optional(),
  })
  .strict();

export const ApplicationRequirementSchema = z
  .object({
    type: RequirementTypeSchema,
    status: RequirementStatusSchema,
    label: z.string().min(1),
    source: z.enum(['structured', 'description', 'inferred', 'llm']),
  })
  .strict();

export const PlanActionSchema = z
  .object({
    type: z.enum([
      'PREPARE_DOCUMENT',
      'COLLECT_INFORMATION',
      'REVIEW_DESTINATION',
      'HAND_OFF',
    ]),
    description: z.string().min(1),
    requirementType: RequirementTypeSchema.optional(),
  })
  .strict();

export const ApplicationPlanSchema = z
  .object({
    jobId: z.string().min(1),
    applicationType: ApplicationTypeSchema,
    provider: AtsProviderSchema.optional(),
    destination: z
      .object({
        url: ApplicationDestinationUrlSchema.optional(),
        email: z.string().email().optional(),
        target: ApplicationTargetSchema.optional(),
        unsupportedReason: z
          .literal('UNSUPPORTED_APPLICATION_PLATFORM')
          .optional(),
      })
      .strict(),
    requirements: z.array(ApplicationRequirementSchema),
    actions: z.array(PlanActionSchema),
    executor: z.enum([
      'EMAIL',
      'BROWSER',
      'GOOGLE_FORM',
      'GOOGLE_DOC',
      'LINKEDIN',
      'HUMAN',
      'NONE',
    ]),
    confidence: z.number().min(0).max(1),
    requiresHumanReview: z.boolean(),
    reasoning: z.array(z.string().min(1)),
    resolvedBy: z.enum(['deterministic', 'llm']),
  })
  .strict()
  .superRefine((plan, context) => {
    const target = plan.destination.target;
    if (
      (target &&
        (target.canonicalUrl !== plan.destination.url ||
          plan.provider !== target.platform)) ||
      (plan.destination.unsupportedReason &&
        (!plan.requiresHumanReview || plan.executor !== 'HUMAN'))
    )
      context.addIssue({
        code: 'custom',
        message: 'Application target does not match plan',
      });
    const mapping: Record<
      z.infer<typeof ApplicationTypeSchema>,
      readonly string[]
    > = {
      EMAIL: ['EMAIL'],
      GOOGLE_FORM: ['GOOGLE_FORM'],
      GOOGLE_DOC: ['GOOGLE_DOC'],
      DIRECT_PORTAL: ['BROWSER'],
      EXTERNAL_ATS: ['BROWSER'],
      LINKEDIN: ['LINKEDIN'],
      UNKNOWN: ['NONE', 'HUMAN'],
      HUMAN_REQUIRED: ['HUMAN'],
    };
    if (!mapping[plan.applicationType].includes(plan.executor))
      context.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['executor'],
        message: 'Executor is incompatible with application type',
      });
    if (plan.requiresHumanReview && plan.executor !== 'HUMAN')
      context.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['executor'],
        message: 'Human review requires HUMAN executor',
      });
    const sensitive = plan.requirements.some(
      (requirement) =>
        requirement.status === 'human_required' ||
        ['SALARY_EXPECTATION', 'WORK_AUTHORIZATION', 'SPONSORSHIP'].includes(
          requirement.type,
        ),
    );
    const missingDestination =
      (plan.applicationType === 'EMAIL' && !plan.destination.email) ||
      ([
        'DIRECT_PORTAL',
        'GOOGLE_FORM',
        'GOOGLE_DOC',
        'EXTERNAL_ATS',
        'LINKEDIN',
      ].includes(plan.applicationType) &&
        !plan.destination.url);
    if (
      !plan.requiresHumanReview &&
      (plan.applicationType === 'HUMAN_REQUIRED' ||
        sensitive ||
        missingDestination)
    ) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['requiresHumanReview'],
        message:
          'Unresolved, sensitive, or destinationless plans require human review',
      });
    }
    if (missingDestination)
      context.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['destination'],
        message: 'Application type requires a destination',
      });
    if (plan.applicationType === 'EMAIL' && plan.destination.url)
      context.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['destination', 'url'],
        message: 'EMAIL plans cannot contain a URL',
      });
    if (
      plan.applicationType === 'UNKNOWN' &&
      plan.executor === 'HUMAN' &&
      !plan.requiresHumanReview
    )
      context.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['requiresHumanReview'],
        message: 'HUMAN executor requires review',
      });
  });

export type Job = z.infer<typeof JobSchema>;
export type ApplicationPlan = z.infer<typeof ApplicationPlanSchema>;
export type ApplicationRequirement = z.infer<
  typeof ApplicationRequirementSchema
>;
export type ApplicationState = z.infer<typeof ApplicationStateSchema>;
export type ApplicationEventType = z.infer<typeof ApplicationEventTypeSchema>;
