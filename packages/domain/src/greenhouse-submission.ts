import { z } from 'zod';
import { atsUrlIdentity } from './ats.js';

// Definition only. Verification tokens and applicant values stay in the live session.
export const GreenhouseSubmissionSchema = z
  .object({
    boardToken: z.string().min(1).max(200),
    jobId: z.string().regex(/^\d{1,30}$/),
    submitUrl: z.string().url(),
    confirmationUrl: z.string().url(),
    requiresBrowserAssistance: z.literal(true),
    unsupportedFeatures: z.array(z.string()).max(30),
    fields: z
      .array(
        z
          .object({
            fieldId: z.string().min(1),
            name: z.string().min(1).max(200),
            label: z.string().max(1000),
            type: z.enum(['TEXT', 'SELECT', 'FILE']),
            required: z.boolean(),
            options: z
              .array(
                z.object({ label: z.string(), value: z.string() }).strict(),
              )
              .max(100),
          })
          .strict(),
      )
      .min(1)
      .max(300),
  })
  .strict()
  .superRefine((s, ctx) => {
    const target = atsUrlIdentity(s.submitUrl);
    if (
      target?.platform !== 'GREENHOUSE' ||
      target.boardToken !== s.boardToken ||
      target.externalJobId !== s.jobId ||
      new URL(s.submitUrl).search ||
      new URL(s.submitUrl).hash ||
      s.confirmationUrl !== `${target.canonicalUrl}/confirmation`
    )
      ctx.addIssue({
        code: 'custom',
        message: 'Greenhouse submission identity mismatch',
      });
    for (const ids of [
      s.fields.map((f) => f.fieldId),
      s.fields.map((f) => f.name),
    ])
      if (new Set(ids).size !== ids.length)
        ctx.addIssue({
          code: 'custom',
          message: 'Greenhouse field bindings must be unique',
        });
    for (const f of s.fields) {
      if (
        !/^[a-zA-Z0-9_]+$/.test(f.name) ||
        new Set(f.options.map((o) => o.label)).size !== f.options.length ||
        new Set(f.options.map((o) => o.value)).size !== f.options.length
      )
        ctx.addIssue({
          code: 'custom',
          message: 'Ambiguous Greenhouse field definition',
        });
    }
  });
export type GreenhouseSubmission = z.infer<typeof GreenhouseSubmissionSchema>;

export function greenhouseSubmissionBlocker(
  s: GreenhouseSubmission,
  assisted = false,
): string | null {
  if (s.unsupportedFeatures.length) return 'GREENHOUSE_UNSUPPORTED_FORM';
  if (!assisted) return 'GREENHOUSE_BROWSER_ASSISTANCE_REQUIRED';
  return null;
}
