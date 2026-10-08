import { z } from 'zod';
import type { Page } from 'playwright';
import {
  atsUrlIdentity,
  GreenhouseSubmissionSchema,
  type GreenhouseSubmission,
} from '@careerlift/domain';
import type { RawPageRepresentation } from './extract.js';
import { InspectionError } from './policy.js';

const question = z.object({
  label: z.string().max(1000),
  required: z.boolean(),
  description: z.string().nullable().optional(),
  fields: z
    .array(
      z.object({
        name: z.string().min(1).max(200),
        type: z.string(),
        allowed_filetypes: z.array(z.string()).optional(),
        values: z
          .array(
            z.object({
              label: z.string(),
              value: z.union([z.string(), z.number()]),
            }),
          )
          .optional(),
      }),
    )
    .max(10),
});
const posting = z.object({
  jobPostId: z.string(),
  urlToken: z.string(),
  submitPath: z.string(),
  confirmationPath: z.string(),
  jobPost: z.object({
    fingerprint: z.string().optional(),
    questions: z.array(question).max(300),
    demographic_questions: z.unknown().optional(),
    data_compliance: z.unknown().optional(),
    eeoc_sections: z.unknown().optional(),
    education_config: z.record(z.unknown()).optional(),
    employment: z.string().nullable().optional(),
  }),
});
export type GreenhousePosting = z.infer<typeof posting>;

export function parseGreenhouseLoader(
  scripts: string[],
  sourceUrl: string,
): GreenhousePosting | undefined {
  const target = atsUrlIdentity(sourceUrl);
  if (target?.platform !== 'GREENHOUSE') return;
  for (const script of scripts) {
    const match = script.match(
      /^\s*window\.__remixContext\s*=\s*([\s\S]+);\s*$/,
    );
    if (!match || script.length > 2 * 1024 * 1024) continue;
    try {
      const input = JSON.parse(match[1]!);
      const routes = Object.values(input.state?.loaderData ?? {});
      for (const route of routes) {
        const result = posting.safeParse(route);
        if (!result.success) continue;
        const p = result.data;
        if (
          p.jobPostId !== target.externalJobId ||
          p.urlToken !== target.boardToken
        )
          continue;
        const submit = atsUrlIdentity(p.submitPath);
        if (
          submit?.platform !== 'GREENHOUSE' ||
          submit.boardToken !== target.boardToken ||
          submit.externalJobId !== target.externalJobId
        )
          continue;
        // The hosted site currently submits to the legacy hostname. No arbitrary destinations.
        if (
          ![
            'https://boards.greenhouse.io',
            new URL(target.canonicalUrl).origin,
          ].includes(new URL(p.submitPath).origin) ||
          new URL(p.submitPath).search ||
          new URL(p.submitPath).hash
        )
          continue;
        if (
          new URL(p.confirmationPath, sourceUrl).href !==
          `${target.canonicalUrl}/confirmation`
        )
          continue;
        return p;
      }
    } catch {
      /* Embedded metadata is data, never evaluated as JavaScript. */
    }
  }
}

export async function readGreenhousePosting(page: Page, sourceUrl: string) {
  const scripts = await page.evaluate(() =>
    Array.from(document.scripts)
      .filter(
        (s) =>
          !s.src && (s.textContent ?? '').includes('window.__remixContext'),
      )
      .map((s) => (s.textContent ?? '').slice(0, 2 * 1024 * 1024 + 1)),
  );
  return parseGreenhouseLoader(scripts, sourceUrl);
}

export function greenhousePostingFromHtml(html: string, sourceUrl: string) {
  if (html.length > 2 * 1024 * 1024) return;
  return parseGreenhouseLoader(
    Array.from(
      html.matchAll(/<script\b[^>]*>([\s\S]*?)<\/script>/gi),
      (m) => m[1]!,
    ),
    sourceUrl,
  );
}

export function isGreenhouseTelemetry(
  sourceUrl: string,
  requestUrl: string,
  method: string,
) {
  if (atsUrlIdentity(sourceUrl)?.platform !== 'GREENHOUSE' || method !== 'POST')
    return false;
  try {
    const u = new URL(requestUrl);
    return (
      u.origin === 'https://c.spl.greenhouse.io' &&
      u.pathname === '/com.snowplowanalytics.snowplow/tp2' &&
      !u.username &&
      !u.password &&
      !u.hash
    );
  } catch {
    return false;
  }
}
export function isGreenhouseFrame(sourceUrl: string, requestUrl: string) {
  if (atsUrlIdentity(sourceUrl)?.platform !== 'GREENHOUSE') return false;
  try {
    const u = new URL(requestUrl);
    return (
      u.protocol === 'https:' &&
      !u.username &&
      !u.password &&
      !u.hash &&
      ((['https://www.recaptcha.net', 'https://www.google.com'].includes(
        u.origin,
      ) &&
        /^\/recaptcha\/(enterprise|api2)\//.test(u.pathname)) ||
        (u.origin === 'https://content.googleapis.com' &&
          u.pathname === '/static/proxy.html'))
    );
  } catch {
    return false;
  }
}
export function isGreenhouseRecaptcha(requestUrl: string) {
  try {
    const u = new URL(requestUrl);
    return (
      ['https://www.recaptcha.net', 'https://www.google.com'].includes(
        u.origin,
      ) &&
      /^\/recaptcha\/(enterprise|api2)\//.test(u.pathname) &&
      !u.username &&
      !u.password &&
      !u.hash
    );
  } catch {
    return false;
  }
}

export function captureGreenhouseForm(
  raw: RawPageRepresentation,
  p: GreenhousePosting,
  sourceUrl: string,
): GreenhouseSubmission {
  const unsupported = new Set<string>();
  const bindings: GreenhouseSubmission['fields'] = [];
  const mapped = new Set<string>();
  for (const q of p.jobPost.questions) {
    // File and manual text are alternatives. Prefer the existing file workflow.
    const definitions = q.fields.some((f) => f.type === 'input_file')
      ? q.fields.filter((f) => f.type === 'input_file')
      : q.fields;
    for (const def of definitions) {
      const matches = raw.fields.filter(
        (f) => f.domId === def.name || f.name === def.name,
      );
      if (matches.length !== 1) {
        unsupported.add('FIELD_MAPPING');
        continue;
      }
      const f = matches[0]!;
      if (
        ![
          'input_text',
          'textarea',
          'input_file',
          'multi_value_single_select',
        ].includes(def.type)
      ) {
        unsupported.add('FIELD_TYPE');
        continue;
      }
      f.label = q.label;
      f.required = q.required;
      f.questionRequired = q.required;
      if (q.description)
        f.description = q.description.replace(/<[^>]*>/g, '').slice(0, 1000);
      if (def.name === 'email') f.type = 'EMAIL';
      if (def.name === 'phone') {
        f.type = 'PHONE';
        f.phoneFormat = 'INTERNATIONAL';
        f.description =
          'Include the country calling code, for example +91 for India.';
      }
      const options = (def.values ?? []).map((o) => ({
        label: o.label,
        value: String(o.value),
      }));
      if (options.length > 100) {
        unsupported.add('TOO_MANY_OPTIONS');
        continue;
      }
      if (def.type === 'multi_value_single_select') {
        f.type = 'SELECT';
        f.options = options.map((o) => o.label);
        f.selectOptions = options.map((o) => ({ ...o, disabled: false }));
        if (!options.length) unsupported.add('MISSING_OPTIONS');
      }
      if (def.type === 'input_file') {
        f.type = 'FILE';
        const accept =
          def.allowed_filetypes?.map((t) => `.${t}`).join(',') || f.accept;
        if (accept) f.accept = accept;
      }
      mapped.add(f.id);
      bindings.push({
        fieldId: f.id,
        name: def.name,
        label: q.label,
        type:
          f.type === 'FILE' ? 'FILE' : f.type === 'SELECT' ? 'SELECT' : 'TEXT',
        required: q.required,
        options,
      });
    }
  }
  // React Select adds anonymous, hidden required inputs that are not answers.
  const applicationForms = new Set(
    raw.fields
      .filter((f) => mapped.has(f.id))
      .map((f) => f.formId)
      .filter(Boolean),
  );
  raw.fields = raw.fields.filter(
    (f) =>
      mapped.has(f.id) ||
      (f.formId &&
        applicationForms.has(f.formId) &&
        (f.visible || Boolean(f.domId || f.name))),
  );
  for (const f of raw.fields) {
    if (f.domId === 'country') {
      f.required = false;
      f.label = 'Phone country';
      f.semanticType = 'COUNTRY';
    } else if (f.visible && !mapped.has(f.id))
      unsupported.add('UNMAPPED_FIELD');
  }
  for (const form of raw.forms)
    form.fieldIds = form.fieldIds.filter((id) =>
      raw.fields.some((f) => f.id === id),
    );
  const hasData = (v: unknown) =>
    Array.isArray(v)
      ? v.length > 0
      : Boolean(v && typeof v === 'object' && Object.keys(v).length);
  if (
    hasData(p.jobPost.demographic_questions) ||
    hasData(p.jobPost.data_compliance) ||
    hasData(p.jobPost.eeoc_sections)
  )
    unsupported.add('ADDITIONAL_SURVEY');
  if (
    Object.values(p.jobPost.education_config ?? {}).some(
      (v) => v === 'required' || v === 'optional',
    ) ||
    ['required', 'optional'].includes(p.jobPost.employment ?? '')
  )
    unsupported.add('EMPLOYMENT_EDUCATION');
  const target = atsUrlIdentity(sourceUrl)!;
  return GreenhouseSubmissionSchema.parse({
    boardToken: p.urlToken,
    jobId: p.jobPostId,
    submitUrl: p.submitPath,
    confirmationUrl: `${target.canonicalUrl}/confirmation`,
    requiresBrowserAssistance: true,
    unsupportedFeatures: [...unsupported],
    fields: bindings,
  });
}

export function sameGreenhouseDefinition(
  a: GreenhouseSubmission,
  b: GreenhouseSubmission,
) {
  const identity = (s: GreenhouseSubmission) =>
    JSON.stringify({
      ...s,
      fields: s.fields.map((f) => ({
        name: f.name,
        label: f.label,
        type: f.type,
        required: f.required,
        options: f.options,
      })),
    });
  return identity(a) === identity(b);
}

export function requireGreenhousePosting(
  p: GreenhousePosting | undefined,
): GreenhousePosting {
  if (!p)
    throw new InspectionError(
      'GREENHOUSE_METADATA_MISSING',
      'Greenhouse form metadata was not found',
    );
  return p;
}
