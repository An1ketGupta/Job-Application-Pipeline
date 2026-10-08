import { z } from 'zod';

// Provider metadata captured by inspection. No applicant values or session tokens.
export const AshbySubmissionSchema = z
  .object({
    formDefinitionId: z.string().min(1),
    actionId: z.string().min(1),
    requiresCaptcha: z.boolean(),
    surveyCount: z.number().int().nonnegative(),
    fields: z
      .array(
        z
          .object({
            path: z.string().min(1),
            title: z.string(),
            type: z.string().min(1),
            required: z.boolean(),
            fieldIds: z.array(z.string()).max(300),
            options: z
              .array(
                z.object({ label: z.string(), value: z.string() }).strict(),
              )
              .max(500),
          })
          .strict(),
      )
      .min(1)
      .max(300),
  })
  .strict()
  .superRefine((submission, ctx) => {
    const paths = submission.fields.map((f) => f.path),
      ids = submission.fields.flatMap((f) => f.fieldIds);
    if (
      new Set(paths).size !== paths.length ||
      new Set(ids).size !== ids.length
    )
      ctx.addIssue({
        code: 'custom',
        message: 'Provider field bindings must be unique',
      });
  });
export type AshbySubmission = z.infer<typeof AshbySubmissionSchema>;

export function ashbySubmissionBlocker(
  submission: AshbySubmission,
): string | null {
  if (submission.surveyCount) return 'ASHBY_SURVEY_REVIEW_REQUIRED';
  if (submission.requiresCaptcha) return 'CAPTCHA';
  if (
    submission.fields.some(
      (f) =>
        !f.fieldIds.length ||
        ![
          'String',
          'LongText',
          'Email',
          'Phone',
          'Number',
          'Boolean',
          'ValueSelect',
          'MultiValueSelect',
          'File',
        ].includes(f.type),
    )
  )
    return 'ASHBY_UNSUPPORTED_FIELD';
  return null;
}
