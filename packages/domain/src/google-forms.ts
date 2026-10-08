import { z } from 'zod';
import {
  DocumentTypeSchema,
  GeneratedAnswerSchema,
  questionKey,
  type ApplicationProfile,
  type UserDocument,
  type VerifiedAnswer,
} from './preparation.js';
import {
  classifyField,
  classifyQuestion,
  KeywordEvidenceRetriever,
  profileValue,
  type AnswerGenerationProvider,
} from './preparation-engine.js';
import type { Job } from './schemas.js';
import {
  resolveCandidateAnswers,
  type ResumeContext,
} from './answer-pipeline.js';

export const GoogleFormStateSchema = z.enum([
  'PENDING',
  'RUNNING',
  'REVIEW',
  'BROWSER_REQUIRED',
  'SUBMITTING',
  'SUBMITTED',
  'UNKNOWN',
  'FAILED',
  'BLOCKED',
]);
export const GoogleFormValueSchema = z.union([
  z.string().max(10000),
  z.array(z.string().max(1000)).max(100),
  z.null(),
]);
export const GoogleFormQuestionSchema = z
  .object({
    id: z.string().min(1).max(300),
    label: z.string().trim().min(1).max(2000),
    kind: z.enum([
      'TEXT',
      'PARAGRAPH',
      'RADIO',
      'CHECKBOX',
      'SELECT',
      'DATE',
      'TIME',
      'DATETIME',
      'NUMBER',
      'FILE',
      'UNSUPPORTED',
    ]),
    required: z.boolean(),
    options: z.array(z.string().max(1000)).max(100).default([]),
    groupId: z.string().max(300).optional(),
    row: z.string().max(1000).optional(),
    minLength: z.number().int().nonnegative().optional(),
    maxLength: z.number().int().positive().optional(),
    documentType: DocumentTypeSchema.optional(),
    accept: z.array(z.string().max(100)).max(30).default([]),
  })
  .strict();
export type GoogleFormQuestion = z.infer<typeof GoogleFormQuestionSchema>;
export type GoogleFormValue = z.infer<typeof GoogleFormValueSchema>;
export const GoogleFormAnswerSchema = z
  .object({
    id: z.string(),
    value: GoogleFormValueSchema,
    source: z.enum([
      'PROFILE',
      'VERIFIED',
      'AI',
      'REVIEW',
      'DOCUMENT',
      'SKIPPED',
    ]),
    documentId: z.string().nullable().default(null),
    evidenceIds: z.array(z.string()).default([]),
    review: z.string().nullable(),
    confidence: z.number().min(0).max(1).optional(),
  })
  .strict();
export type GoogleFormAnswer = z.infer<typeof GoogleFormAnswerSchema>;
export const GoogleFormSnapshotSchema = z
  .object({
    title: z.string().max(1000),
    url: z.string().url(),
    fingerprint: z.string(),
    page: z.number().int().nonnegative(),
    questions: z.array(GoogleFormQuestionSchema).max(300),
    answers: z.array(GoogleFormAnswerSchema).max(300),
    decisions: z.record(GoogleFormValueSchema).default({}),
    inputDigest: z.string(),
    completedPages: z
      .array(
        z
          .object({
            fingerprint: z.string(),
            questionCount: z.number().int(),
            reviewedCount: z.number().int(),
            // Older checkpoints have only counts and cannot replay prior sections.
            snapshot: z
              .object({
                questions: z.array(GoogleFormQuestionSchema).max(300),
                answers: z.array(GoogleFormAnswerSchema).max(300),
                decisions: z.record(GoogleFormValueSchema),
              })
              .strict()
              .optional(),
          })
          .strict(),
      )
      .max(100)
      .default([]),
  })
  .strict();
export type GoogleFormSnapshot = z.infer<typeof GoogleFormSnapshotSchema>;
export const GoogleFormSummarySchema = z
  .object({
    state: GoogleFormStateSchema,
    version: z.number().int(),
    page: z.number().int(),
    title: z.string(),
    issue: z.string().nullable(),
    updatedAt: z.string().datetime(),
    submittedAt: z.string().datetime().nullable(),
    test: z.boolean(),
  })
  .strict();
export const GoogleFormReviewSchema = z
  .object({
    question: GoogleFormQuestionSchema,
    answer: GoogleFormAnswerSchema,
  })
  .strict();
export const GoogleFormViewSchema = z
  .object({
    enabled: z.boolean(),
    expectedAccount: z.string().email(),
    run: GoogleFormSummarySchema.nullable(),
    reviews: z.array(GoogleFormReviewSchema).max(300),
    documents: z
      .array(
        z
          .object({ id: z.string(), name: z.string(), type: z.string() })
          .strict(),
      )
      .max(500),
  })
  .strict();
export type GoogleFormView = z.infer<typeof GoogleFormViewSchema>;

export function googleFormIdentity(
  value: unknown,
): { url: string; id: string; short: boolean } | undefined {
  if (typeof value !== 'string') return;
  try {
    const url = new URL(value);
    if (url.protocol !== 'https:' || url.username || url.password || url.port)
      return;
    const match =
      url.hostname === 'docs.google.com'
        ? url.pathname.match(
            /^\/forms\/(?:u\/\d+\/)?d\/(?:e\/)?([\w-]{5,300})\/(?:viewform|formResponse)\/?$/,
          )
        : url.hostname === 'forms.gle'
          ? url.pathname.match(/^\/([\w-]{5,100})\/?$/)
          : null;
    if (!match?.[1]) return;
    url.hash = '';
    url.search = '';
    url.pathname = url.pathname.replace(/formResponse\/?$/, 'viewform');
    return { url: url.href, id: match[1], short: url.hostname === 'forms.gle' };
  } catch {
    return;
  }
}

const consequential = new Set([
  'WORK_AUTHORIZATION',
  'SPONSORSHIP',
  'SALARY',
  'NOTICE_PERIOD',
  'SECURITY_CLEARANCE',
  'LEGAL_DECLARATION',
  'OTHER_SENSITIVE',
]);
export function googleQuestionPolicy(question: GoogleFormQuestion) {
  const category = classifyQuestion(question.label);
  return {
    category,
    sensitive:
      consequential.has(category) ||
      /religion|date of birth|\b(age|sex|caste|marital|medical|criminal)\b|declare|declaration|\bstipend\b/i.test(
        question.label,
      ),
    consent:
      /\b(consent|agree|agreement|accept|permission|privacy|terms|subscribe)\b/i.test(
        question.label,
      ),
  };
}
export function validGoogleAnswer(
  question: GoogleFormQuestion,
  value: GoogleFormValue,
): boolean {
  if (
    value === null ||
    value === '' ||
    (Array.isArray(value) && value.length === 0)
  )
    return !question.required;
  if (question.kind === 'UNSUPPORTED' || question.kind === 'FILE') return false;
  if (question.kind === 'CHECKBOX')
    return (
      Array.isArray(value) &&
      new Set(value).size === value.length &&
      value.every((v) => question.options.includes(v))
    );
  if (typeof value !== 'string' || !value.trim()) return false;
  if (question.options.length && !question.options.includes(value))
    return false;
  if (
    (question.minLength !== undefined && value.length < question.minLength) ||
    (question.maxLength !== undefined && value.length > question.maxLength)
  )
    return false;
  if (question.kind === 'NUMBER' && !/^-?\d+(\.\d+)?$/.test(value))
    return false;
  if (question.kind === 'TIME' && !/^([01]\d|2[0-3]):[0-5]\d$/.test(value))
    return false;
  if (
    question.kind === 'DATE' &&
    (!/^\d{4}-\d{2}-\d{2}$/.test(value) ||
      Number.isNaN(Date.parse(value)) ||
      !new Date(value).toISOString().startsWith(value))
  )
    return false;
  if (
    question.kind === 'DATETIME' &&
    (!/^\d{4}-\d{2}-\d{2}T([01]\d|2[0-3]):[0-5]\d$/.test(value) ||
      !validGoogleAnswer(
        {
          ...question,
          kind: 'DATE',
          options: [],
          minLength: undefined,
          maxLength: undefined,
        },
        value.slice(0, 10),
      ))
  )
    return false;
  if (
    /\be-?mail\b/i.test(question.label) &&
    !z.string().email().safeParse(value).success
  )
    return false;
  return true;
}
function valueFor(
  question: GoogleFormQuestion,
  value: string,
): GoogleFormValue {
  if (question.kind !== 'CHECKBOX') return value;
  if (question.options.includes(value)) return [value];
  try {
    return z.array(z.string()).parse(JSON.parse(value));
  } catch {
    return null;
  }
}
export function googleDocumentCandidates(
  question: GoogleFormQuestion,
  documents: UserDocument[],
) {
  return documents.filter(
    (d) =>
      d.type === (question.documentType ?? 'OTHER') &&
      (!question.accept.length ||
        question.accept.some(
          (a) =>
            a === d.mimeType || d.name.toLowerCase().endsWith(a.toLowerCase()),
        )),
  );
}
export async function prepareGoogleQuestions(input: {
  questions: GoogleFormQuestion[];
  profile: ApplicationProfile;
  email: string;
  job: Job;
  documents: UserDocument[];
  verified: VerifiedAnswer[];
  decisions?: Record<string, GoogleFormValue>;
  provider?: AnswerGenerationProvider | undefined;
  resumeContext?: ResumeContext;
  confidenceThreshold?: number;
}): Promise<GoogleFormAnswer[]> {
  const answers: GoogleFormAnswer[] = [];
  const retriever = new KeywordEvidenceRetriever();
  for (const question of input.questions) {
    const policy = googleQuestionPolicy(question);
    const saved = input.verified.filter(
      (a) =>
        (a.questionKey || questionKey(a.question ?? '')) ===
        questionKey(question.label),
    );
    const decision =
      input.decisions && Object.hasOwn(input.decisions, question.id)
        ? input.decisions[question.id]
        : undefined;
    const answer: GoogleFormAnswer = {
      id: question.id,
      value: null,
      source: 'SKIPPED',
      documentId: null,
      evidenceIds: [],
      review: null,
    };
    if (question.kind === 'UNSUPPORTED') {
      answer.review =
        'This question uses an unsupported control. Complete it manually in the browser.';
      answers.push(answer);
      continue;
    }
    if (question.kind === 'FILE') {
      if (decision === null && !question.required) {
        answers.push(answer);
        continue;
      }
      const matches = googleDocumentCandidates(question, input.documents);
      const normalize = (v: string) =>
        v
          .toLowerCase()
          .replace(/[^a-z0-9]+/g, ' ')
          .trim();
      const titled = matches.filter(
        (d) =>
          d.type === 'RESUME' &&
          Array.isArray(d.metadata.jobTitles) &&
          d.metadata.jobTitles.some(
            (t) =>
              typeof t === 'string' &&
              normalize(t) === normalize(input.job.title),
          ),
      );
      const defaults = matches.filter((d) => d.metadata.isDefault === true);
      const chosen =
        typeof decision === 'string'
          ? matches.filter((d) => d.id === decision)
          : titled.length
            ? titled
            : defaults;
      if (chosen.length === 1) {
        answer.documentId = chosen[0]!.id;
        answer.source = decision === undefined ? 'DOCUMENT' : 'REVIEW';
      } else if (question.required || matches.length > 0)
        answer.review =
          chosen.length > 1
            ? 'More than one document matches. Select the document for this application.'
            : 'Select a matching document or upload the missing document in Documents.';
      answers.push(answer);
      continue;
    }
    if (decision !== undefined) {
      answer.value = decision;
      answer.source = 'REVIEW';
    } else if (saved.length === 1) {
      answer.value = valueFor(question, saved[0]!.value);
      answer.source = 'VERIFIED';
    } else if (saved.length > 1) {
      answer.review =
        'Conflicting verified answers. Choose an answer for this application.';
      answers.push(answer);
      continue;
    } else if (!policy.sensitive && !policy.consent) {
      const field = {
        id: question.id,
        label: question.label,
        type: 'TEXT' as const,
        required: question.required,
        options: [],
        visible: true,
        disabled: false,
        readonly: false,
        source: 'DOM' as const,
      };
      const semantic = classifyField(field).semanticType;
      const profile = profileValue(semantic, input.profile, input.email);
      if (profile) {
        answer.value = valueFor(question, profile);
        answer.source = 'PROFILE';
      } else if (
        ['TEXT', 'PARAGRAPH'].includes(question.kind) &&
        input.provider &&
        !input.provider.generateAnswers
      ) {
        const evidence = retriever.retrieve(
          question.label,
          policy.category,
          input.profile,
          input.job,
        );
        if (evidence.length) {
          try {
            const generated = GeneratedAnswerSchema.parse(
              await input.provider.generateAnswer({
                question: question.label,
                category: policy.category,
                job: input.job,
                evidence,
                ...(question.maxLength
                  ? { maxLength: question.maxLength }
                  : {}),
              }),
            );
            if (
              !generated.requiresHumanReview &&
              generated.category === policy.category &&
              generated.evidenceIds.length &&
              generated.evidenceIds.every((id) =>
                evidence.some((e) => e.id === id),
              )
            ) {
              answer.value = generated.answer;
              answer.source = 'AI';
              answer.evidenceIds = generated.evidenceIds;
            }
          } catch {
            /* Missing evidence and provider errors are reviewable, never invented answers. */
          }
        }
      }
    }
    if (policy.sensitive && decision === undefined && saved.length !== 1)
      answer.review =
        'Review this consequential or demographic answer for this application, even if previously verified.';
    else if (policy.consent && decision === undefined && saved.length !== 1)
      answer.review =
        'Choose a consent preference explicitly before continuing.';
    else if (!validGoogleAnswer(question, answer.value))
      answer.review =
        'Provide an answer that satisfies the required field and its options or validation rules.';
    else if (answer.value === null) answer.source = 'SKIPPED';
    answers.push(answer);
  }
  if (input.provider?.generateAnswers) {
    const unresolved = answers.filter((answer) => {
      const question = input.questions.find((q) => q.id === answer.id)!;
      return (
        answer.review &&
        !['FILE', 'UNSUPPORTED'].includes(question.kind) &&
        !Object.hasOwn(input.decisions ?? {}, question.id) &&
        input.verified.filter(
          (saved) =>
            (saved.questionKey || questionKey(saved.question ?? '')) ===
            questionKey(question.label),
        ).length <= 1
      );
    });
    const requests = unresolved.map((answer) => {
      const question = input.questions.find((q) => q.id === answer.id)!;
      return {
        id: question.id,
        question: question.label,
        category: googleQuestionPolicy(question).category,
        fieldType: question.kind,
        options: question.options,
        ...(question.minLength !== undefined
          ? { minLength: question.minLength }
          : {}),
        ...(question.maxLength !== undefined
          ? { maxLength: question.maxLength }
          : {}),
      };
    });
    const results = await resolveCandidateAnswers(
      {
        questions: requests,
        profile: input.profile,
        email: input.email,
        job: input.job,
        verifiedAnswers: input.verified,
        resume: input.resumeContext ?? {
          documentId: null,
          name: null,
          text: '',
          status: 'MISSING',
        },
      },
      input.provider,
      input.confidenceThreshold ?? 0.75,
      (request, value) => {
        const question = input.questions.find((q) => q.id === request.id)!;
        return validGoogleAnswer(question, valueFor(question, value));
      },
    );
    for (const result of results) {
      const answer = answers.find((a) => a.id === result.id)!;
      const question = input.questions.find((q) => q.id === result.id)!;
      answer.value = result.answer ? valueFor(question, result.answer) : null;
      answer.source = result.answer ? 'AI' : 'SKIPPED';
      answer.evidenceIds = result.evidenceIds;
      answer.confidence = result.confidence;
      answer.review = result.requiresHumanReview ? result.reason : null;
    }
  }
  return answers;
}
