import { z } from 'zod';
import { SemanticTypeSchema } from './inspection.js';

export const PreparationStateSchema = z.enum([
  'PENDING',
  'RUNNING',
  'COMPLETED',
  'HUMAN_REQUIRED',
  'FAILED',
]);
export type PreparationState = z.infer<typeof PreparationStateSchema>;
export const preparationTransitions: Record<
  PreparationState,
  readonly PreparationState[]
> = {
  PENDING: ['RUNNING', 'FAILED'],
  RUNNING: ['COMPLETED', 'HUMAN_REQUIRED', 'FAILED'],
  COMPLETED: [],
  HUMAN_REQUIRED: ['PENDING'],
  FAILED: ['PENDING'],
};
export const canTransitionPreparation = (
  from: PreparationState,
  to: PreparationState,
) => preparationTransitions[from].includes(to);

export const AnswerSourceSchema = z.enum([
  'USER_VERIFIED',
  'PROFILE',
  'DOCUMENT',
  'DETERMINISTIC_MATCH',
  'LLM_GENERATED',
  'HUMAN_REQUIRED',
]);
export const QuestionCategorySchema = z.enum([
  'MOTIVATION',
  'ROLE_MOTIVATION',
  'SELF_INTRODUCTION',
  'PROJECT_EXPERIENCE',
  'TECHNICAL_EXPERIENCE',
  'ACHIEVEMENT',
  'SELF_PITCH',
  'WORK_AUTHORIZATION',
  'SPONSORSHIP',
  'SALARY',
  'NOTICE_PERIOD',
  'SECURITY_CLEARANCE',
  'LEGAL_DECLARATION',
  'OTHER_SENSITIVE',
  'CUSTOM_QUESTION',
]);
export type QuestionCategory = z.infer<typeof QuestionCategorySchema>;
export const DocumentTypeSchema = z.enum([
  'RESUME',
  'COVER_LETTER',
  'PORTFOLIO',
  'TRANSCRIPT',
  'CERTIFICATE',
  'OTHER',
]);

const ShortProfileText = z.string().trim().max(300);
const ProfileDate = z.union([
  z.literal(''),
  z
    .string()
    .regex(/^\d{4}-\d{2}-\d{2}$/)
    .refine(
      (v) =>
        !Number.isNaN(Date.parse(v)) && new Date(v).toISOString().startsWith(v),
      'Invalid date',
    ),
]);
const ProfileLink = z.union([
  z.literal(''),
  z
    .string()
    .trim()
    .max(1000)
    .url()
    .refine(
      (v) =>
        /^https?:\/\//i.test(v) && !new URL(v).username && !new URL(v).password,
      'Use an HTTP or HTTPS URL without credentials',
    ),
]);
export const EvidenceSchema = z
  .object({
    id: z.string().trim().min(1).max(200),
    category: z.enum([
      'EXPERIENCE',
      'PROJECT',
      'EDUCATION',
      'SKILL',
      'ACHIEVEMENT',
      'CERTIFICATION',
    ]),
    text: z.string().trim().min(1).max(5000),
    tags: z.array(ShortProfileText).max(100).default([]),
    company: ShortProfileText.optional(),
    title: ShortProfileText.optional(),
    location: ShortProfileText.optional(),
    institution: ShortProfileText.optional(),
    degree: ShortProfileText.optional(),
    fieldOfStudy: ShortProfileText.optional(),
    startDate: ProfileDate.optional(),
    endDate: ProfileDate.optional(),
    description: z.string().trim().max(4000).optional(),
    achievements: z.array(z.string().trim().max(1000)).max(20).optional(),
  })
  .strict();
export const ApplicationProfileSchema = z
  .object({
    firstName: ShortProfileText.optional(),
    lastName: ShortProfileText.optional(),
    fullName: ShortProfileText.optional(),
    preferredName: ShortProfileText.optional(),
    email: z
      .union([z.literal(''), z.string().trim().max(300).email()])
      .optional(),
    phone: z.string().trim().max(50).optional(),
    location: ShortProfileText.optional(),
    headline: ShortProfileText.optional(),
    summary: z.string().trim().max(5000).optional(),
    yearsOfExperience: z.number().min(0).max(80).optional(),
    address: ShortProfileText.optional(),
    city: ShortProfileText.optional(),
    state: ShortProfileText.optional(),
    country: ShortProfileText.optional(),
    linkedin: ProfileLink.optional(),
    github: ProfileLink.optional(),
    portfolio: ProfileLink.optional(),
    website: ProfileLink.optional(),
    college: ShortProfileText.optional(),
    degree: ShortProfileText.optional(),
    cgpa: ShortProfileText.optional(),
    graduationDate: ShortProfileText.optional(),
    education: z.array(EvidenceSchema).max(100).default([]),
    experience: z.array(EvidenceSchema).max(100).default([]),
    projects: z.array(EvidenceSchema).max(100).default([]),
    skills: z.array(EvidenceSchema).max(200).default([]),
    achievements: z.array(EvidenceSchema).max(100).default([]),
    certifications: z.array(EvidenceSchema).max(100).default([]),
  })
  .strict()
  .superRefine((profile, context) => {
    for (const section of [
      'education',
      'experience',
      'projects',
      'skills',
      'achievements',
      'certifications',
    ] as const) {
      const ids = new Set<string>();
      for (const [index, item] of profile[section].entries()) {
        if (ids.has(item.id))
          context.addIssue({
            code: 'custom',
            path: [section, index, 'id'],
            message: 'Duplicate entry ID',
          });
        ids.add(item.id);
        if (item.startDate && item.endDate && item.endDate < item.startDate)
          context.addIssue({
            code: 'custom',
            path: [section, index, 'endDate'],
            message: 'End date must follow start date',
          });
      }
    }
  });
export type ApplicationProfile = z.infer<typeof ApplicationProfileSchema>;
export const VerifiedAnswerSchema = z
  .object({
    id: z.string().min(1),
    category: QuestionCategorySchema,
    question: z.string().max(4000).optional(),
    questionKey: z.string().max(4000).optional(),
    value: z.string().min(1),
    source: z.literal('USER_VERIFIED'),
    verifiedAt: z.string().datetime(),
  })
  .strict();
export type VerifiedAnswer = z.infer<typeof VerifiedAnswerSchema>;
export const questionKey = (question: string) =>
  question.trim().toLowerCase().replace(/\s+/g, ' ');
export const ReviewDecisionSchema = z
  .object({
    requirementId: z.string().min(1).max(300),
    action: z.enum(['ANSWER', 'CONFIRM', 'SELECT_DOCUMENT', 'REJECT']),
    value: z.string().trim().min(1).max(10000).optional(),
    documentId: z.string().min(1).max(200).optional(),
    key: z.string().uuid(),
    actorId: z.string().min(1),
    decidedAt: z.string().datetime(),
  })
  .strict();
export type ReviewDecision = z.infer<typeof ReviewDecisionSchema>;
export const UserDocumentSchema = z
  .object({
    id: z.string().min(1),
    type: DocumentTypeSchema,
    name: z.string().min(1),
    storageRef: z.string().min(1),
    mimeType: z.string().min(1),
    size: z.number().int().nonnegative(),
    metadata: z.record(z.unknown()).default({}),
  })
  .strict();
export type UserDocument = z.infer<typeof UserDocumentSchema>;
export type Evidence = z.infer<typeof EvidenceSchema>;

export const GeneratedAnswerSchema = z
  .object({
    answer: z.string().min(1).max(10000),
    category: QuestionCategorySchema,
    evidenceIds: z.array(z.string()),
    requiresHumanReview: z.boolean(),
    reasoningSummary: z.string().max(1000),
  })
  .strict();
export type GeneratedAnswer = z.infer<typeof GeneratedAnswerSchema>;
export const AiApprovalSchema = z
  .object({
    threshold: z.number().min(0).max(1),
    evidenceIds: z.array(z.string()).min(1),
  })
  .strict()
  .optional();
const preparedBase = {
  aiApproval: AiApprovalSchema,
  source: AnswerSourceSchema,
  confidence: z.number().min(0).max(1),
  requiresHumanReview: z.boolean(),
  reason: z.string().max(1000).optional(),
};
export const PreparedFieldSchema = z
  .object({
    fieldId: z.string().min(1),
    semanticType: SemanticTypeSchema,
    value: z.string().nullable(),
    classificationSource: z.enum(['SCHEMA', 'DETERMINISTIC', 'UNKNOWN']),
    ...preparedBase,
  })
  .strict();
export const PreparedQuestionSchema = z
  .object({
    questionId: z.string().min(1),
    category: QuestionCategorySchema,
    answer: z.string().nullable(),
    evidenceIds: z.array(z.string()),
    ...preparedBase,
  })
  .strict();
export const PreparedDocumentSchema = z
  .object({
    requirementId: z.string().min(1),
    documentId: z.string().nullable(),
    documentType: DocumentTypeSchema,
    selectionReason: z.string().max(1000),
    confidence: z.number().min(0).max(1),
    requiresHumanReview: z.boolean(),
  })
  .strict();
export const HumanReviewItemSchema = z
  .object({
    requirementId: z.string().min(1),
    reason: z.string().min(1),
    category: z.string().min(1),
  })
  .strict();
export const PreparedApplicationSchema = z
  .object({
    version: z.literal(1),
    applicationId: z.string().min(1),
    inspectionId: z.string().min(1),
    jobId: z.string().min(1),
    fields: z.array(PreparedFieldSchema),
    questions: z.array(PreparedQuestionSchema),
    documents: z.array(PreparedDocumentSchema),
    humanReviewItems: z.array(HumanReviewItemSchema),
    overallStatus: z.enum(['COMPLETED', 'HUMAN_REQUIRED']),
    overallConfidence: z.number().min(0).max(1),
    preparedAt: z.string().datetime(),
  })
  .strict()
  .superRefine((result, context) => {
    if (
      result.humanReviewItems.length > 0 !==
      (result.overallStatus === 'HUMAN_REQUIRED')
    )
      context.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['overallStatus'],
        message: 'Status must match human review items',
      });
    for (const [index, field] of result.fields.entries())
      if (
        field.requiresHumanReview &&
        !result.humanReviewItems.some(
          (item) => item.requirementId === field.fieldId,
        )
      )
        context.addIssue({
          code: z.ZodIssueCode.custom,
          path: ['fields', index],
          message: 'Required field review item missing',
        });
    for (const [index, question] of result.questions.entries())
      if (
        question.requiresHumanReview &&
        !result.humanReviewItems.some(
          (item) => item.requirementId === question.questionId,
        )
      )
        context.addIssue({
          code: z.ZodIssueCode.custom,
          path: ['questions', index],
          message: 'Required question review item missing',
        });
  });
export type PreparedApplication = z.infer<typeof PreparedApplicationSchema>;
