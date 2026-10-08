import { z } from 'zod';

export const EmailConnectionFailureSchema = z.enum([
  'EMAIL_OAUTH_STATE_INVALID',
  'EMAIL_ACCESS_DENIED',
  'EMAIL_ACCOUNT_MISMATCH',
  'EMAIL_ACCOUNT_UNVERIFIED',
  'EMAIL_PERMISSION_REQUIRED',
  'EMAIL_RECONNECT_REQUIRED',
  'EMAIL_AUTH_UNAVAILABLE',
  'EMAIL_SENDING_IN_PROGRESS',
  'EMAIL_CONNECTION_FAILED',
]);

export const EmailAddressSchema = z
  .string()
  .trim()
  .max(254)
  .email()
  .refine((v) => !/[\r\n]/.test(v));
export const ResumeJobTitlesSchema = z
  .array(z.string().trim().min(2).max(150))
  .max(30)
  .default([]);
export const EmailStateSchema = z.enum([
  'DRAFT',
  'QUEUED',
  'SENDING',
  'SENT',
  'FAILED',
  'UNKNOWN',
  'CANCELLED',
]);
export const EmailAttachmentSchema = z
  .object({
    id: z.string().min(1).max(200),
    revision: z.number().int().positive(),
    name: z.string().min(1).max(154),
    mimeType: z.enum(['application/pdf', 'text/plain']),
    size: z
      .number()
      .int()
      .positive()
      .max(10 * 1024 * 1024),
    contentDigest: z.string().regex(/^[a-f0-9]{64}$/),
  })
  .strict();
export const EmailDraftInputSchema = z
  .object({
    revision: z.number().int().nonnegative(),
    subject: z
      .string()
      .trim()
      .min(1)
      .max(250)
      .refine((v) => !/[\r\n]/.test(v)),
    body: z.string().trim().min(1).max(20000),
    documentIds: z
      .array(z.string().min(1).max(200))
      .max(5)
      .refine((v) => new Set(v).size === v.length),
  })
  .strict();
export const EmailPreferencesSchema = z
  .object({
    senderName: z
      .string()
      .trim()
      .max(150)
      .refine((v) => !/[\r\n]/.test(v))
      .default(''),
    signature: z.string().trim().max(2000).default(''),
    subjectTemplate: z
      .string()
      .trim()
      .min(1)
      .max(250)
      .refine((v) => !/[\r\n]/.test(v))
      .default('Application for {{jobTitle}} — {{fullName}}'),
    bodyTemplate: z
      .string()
      .trim()
      .min(1)
      .max(15000)
      .default(
        'Dear Hiring Team,\n\nI would like to apply for the {{jobTitle}} position at {{company}}.\n\n{{profileSummary}}\n\nThank you for considering my application.\n\n{{signature}}',
      ),
    requireResume: z.boolean().default(true),
    personalizationInstructions: z
      .string()
      .trim()
      .max(2000)
      .default(
        'Preserve my template structure and personalize it using relevant facts from my profile.',
      ),
  })
  .strict();
export type EmailPreferences = z.infer<typeof EmailPreferencesSchema>;
export const EmailSummarySchema = z
  .object({
    state: EmailStateSchema,
    updatedAt: z.string().datetime(),
    sentAt: z.string().datetime().nullable(),
  })
  .strict();
export const EmailMessageViewSchema = z
  .object({
    id: z.string(),
    applicationId: z.string().nullable(),
    purpose: z.enum(['APPLICATION', 'TEST']),
    state: EmailStateSchema,
    revision: z.number().int().positive(),
    from: EmailAddressSchema,
    to: EmailAddressSchema,
    subject: z.string(),
    body: z.string(),
    attachments: z.array(EmailAttachmentSchema),
    updatedAt: z.string().datetime(),
    sentAt: z.string().datetime().nullable(),
    errorCode: z.string().nullable(),
  })
  .strict();
export type EmailMessageView = z.infer<typeof EmailMessageViewSchema>;
export type EmailAttachment = z.infer<typeof EmailAttachmentSchema>;
export function renderEmailTemplate(
  template: string,
  values: Record<string, string>,
) {
  return template.replace(
    /\{\{(\w+)\}\}/g,
    (_match, key: string) => values[key] ?? '',
  );
}
const ignored = new Set([
  'and',
  'or',
  'the',
  'a',
  'an',
  'at',
  'for',
  'intern',
  'internship',
  'junior',
  'senior',
  'lead',
  'principal',
  'associate',
  'entry',
  'level',
  'remote',
  'onsite',
  'hybrid',
  'trainee',
]);
function titleTokens(title: string) {
  const tokens = new Set(
    title
      .toLowerCase()
      .replace(/full[ -]?stack/g, 'fullstack')
      .replace(/front[ -]?end/g, 'frontend')
      .replace(/back[ -]?end/g, 'backend')
      .replace(/artificial intelligence/g, 'ai')
      .replace(/machine learning/g, 'ml')
      .replace(/node[ .]?js/g, 'nodejs')
      .replace(/next[ .]?js/g, 'nextjs')
      .replace(/quality assurance/g, 'qa')
      .replace(/developer/g, 'engineer')
      .replace(/sde/g, 'software engineer')
      .match(/[a-z0-9+#]+/g)
      ?.filter((v) => !ignored.has(v)) ?? [],
  );
  if (
    ['react', 'vue', 'angular', 'nextjs', 'frontend', 'ui'].some((t) =>
      tokens.has(t),
    )
  )
    tokens.add('frontend');
  if (
    ['nodejs', 'express', 'django', 'nestjs', 'backend'].some((t) =>
      tokens.has(t),
    )
  )
    tokens.add('backend');
  if (tokens.has('fullstack')) {
    tokens.add('frontend');
    tokens.add('backend');
  }
  if (
    tokens.has('ai') ||
    tokens.has('ml') ||
    (tokens.has('data') && tokens.has('scientist'))
  )
    tokens.add('machinelearning');
  if (['qa', 'sdet', 'tester'].some((t) => tokens.has(t))) tokens.add('qa');
  if (['devops', 'sre'].some((t) => tokens.has(t))) tokens.add('devops');
  return tokens;
}
export function rankResumes(
  jobTitle: string,
  documents: Array<{
    id: string;
    name: string;
    type: string;
    isDefault: boolean;
    jobTitles?: string[];
  }>,
) {
  const target = titleTokens(jobTitle),
    weight = (t: string) => (['engineer', 'software'].includes(t) ? 1 : 3);
  return documents
    .filter((d) => d.type === 'RESUME')
    .map((document) => {
      const matches = (document.jobTitles ?? [])
        .map((title) => {
          const tokens = titleTokens(title);
          const intersection = [...tokens].filter((t) => target.has(t));
          return {
            title,
            score:
              intersection.reduce((sum, t) => sum + weight(t), 0) /
              Math.max(
                1,
                [...new Set([...tokens, ...target])].reduce(
                  (sum, t) => sum + weight(t),
                  0,
                ),
              ),
          };
        })
        .sort((a, b) => b.score - a.score);
      const best = matches[0];
      return {
        id: document.id,
        name: document.name,
        score: best?.score ?? 0,
        isDefault: document.isDefault,
        reason:
          best && best.score > 0
            ? `Matches target title “${best.title}”`
            : document.isDefault
              ? 'Default resume; no matching target title'
              : 'No matching target title',
      };
    })
    .sort(
      (a, b) =>
        b.score - a.score ||
        Number(b.isDefault) - Number(a.isDefault) ||
        a.name.localeCompare(b.name),
    );
}
