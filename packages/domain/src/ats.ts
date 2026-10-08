import { z } from 'zod';
import { ApplicationDestinationUrlSchema } from './destination.js';

export const SupportedAtsSchema = z.enum(['GREENHOUSE', 'LEVER', 'ASHBY']);
export type SupportedAts = z.infer<typeof SupportedAtsSchema>;
const hosts: Record<SupportedAts, readonly string[]> = {
  GREENHOUSE: [
    'boards.greenhouse.io',
    'job-boards.greenhouse.io',
    'job-boards.eu.greenhouse.io',
  ],
  LEVER: ['jobs.lever.co', 'jobs.eu.lever.co'],
  ASHBY: ['jobs.ashbyhq.com'],
};

// Identity only. Every network access still requires the existing DNS/SSRF policy.
export function detectAtsPlatform(value: string): SupportedAts | undefined {
  if (!ApplicationDestinationUrlSchema.safeParse(value).success)
    return undefined;
  const url = new URL(value);
  if (url.port || url.hostname.endsWith('.')) return undefined;
  return SupportedAtsSchema.options.find((p) =>
    hosts[p].includes(url.hostname),
  );
}

export function atsUrlIdentity(value: string) {
  const platform = detectAtsPlatform(value);
  if (!platform) return undefined;
  const url = new URL(value);
  const segment = '[a-zA-Z0-9_-]{1,200}';
  let boardToken: string | undefined;
  let externalJobId: string | undefined;
  if (platform === 'GREENHOUSE') {
    const path = url.pathname.match(
      new RegExp(`^/(${segment})/jobs/(\\d{1,30})/?$`),
    );
    if (path) {
      [, boardToken, externalJobId] = path;
      if (url.hostname === 'boards.greenhouse.io')
        url.hostname = 'job-boards.greenhouse.io';
      url.pathname = `/${boardToken}/jobs/${externalJobId}`;
      url.search = '';
    } else if (url.pathname === '/embed/job_app') {
      const boards = url.searchParams.getAll('for');
      const ids = url.searchParams.getAll('token');
      const ghIds = url.searchParams.getAll('gh_jid');
      if (boards.length !== 1 || ids.length + ghIds.length !== 1)
        return undefined;
      boardToken = boards[0];
      externalJobId = ids[0] ?? ghIds[0];
      if (
        !new RegExp(`^${segment}$`).test(boardToken ?? '') ||
        !/^\d{1,30}$/.test(externalJobId ?? '')
      )
        return undefined;
      if (url.hostname === 'boards.greenhouse.io')
        url.hostname = 'job-boards.greenhouse.io';
      url.search = '';
      url.searchParams.set('for', boardToken!);
      url.searchParams.set('token', externalJobId!);
    }
  } else {
    const suffix = platform === 'LEVER' ? 'apply' : 'application';
    const path = url.pathname.match(
      new RegExp(`^/(${segment})/(${segment})(?:/${suffix})?/?$`),
    );
    if (path) {
      [, boardToken, externalJobId] = path;
      url.pathname = `/${boardToken}/${externalJobId}/${suffix}`;
      url.search = '';
    }
  }
  if (!boardToken || !externalJobId) return undefined;
  url.hash = '';
  return { platform, boardToken, externalJobId, canonicalUrl: url.href };
}

export const ApplicationTargetSchema = z
  .object({
    platform: SupportedAtsSchema,
    adapterVersion: z.literal(1),
    canonicalUrl: ApplicationDestinationUrlSchema,
    boardToken: z.string().min(1).max(200),
    externalJobId: z.string().min(1).max(200),
    company: z.string().min(1).max(1000),
    role: z.string().min(1).max(1000),
    metadataSource: z.literal('JOB_UNTRUSTED'),
    entryPoint: z
      .object({
        url: ApplicationDestinationUrlSchema,
        kind: z.enum(['HOSTED_FORM', 'APPLICATION_ROUTE']),
      })
      .strict(),
    capabilities: z
      .object({
        supportsFileUpload: z.boolean(),
        supportsResumeUpload: z.boolean(),
        supportsCoverLetter: z.boolean(),
        supportsDynamicQuestions: z.boolean(),
        supportsMultiStepForms: z.boolean(),
        supportsKnownSuccessSignals: z.literal(false),
      })
      .strict(),
    inspectionHints: z
      .object({
        formIsDynamic: z.literal(true),
        navigation: z.enum(['HOSTED_FORM', 'APPLICATION_ROUTE']),
      })
      .strict(),
    // Test transport is descriptive, never a network capability. The inspector
    // must have the same exact server-configured mapping; real execution rejects it.
    fixtureSourceUrl: ApplicationDestinationUrlSchema.optional(),
  })
  .strict()
  .superRefine((target, ctx) => {
    const identity = atsUrlIdentity(
      target.fixtureSourceUrl ?? target.canonicalUrl,
    );
    const local = new URL(target.canonicalUrl);
    if (
      !identity ||
      identity.platform !== target.platform ||
      identity.boardToken !== target.boardToken ||
      identity.externalJobId !== target.externalJobId ||
      target.entryPoint.url !== target.canonicalUrl ||
      (!target.fixtureSourceUrl &&
        identity.canonicalUrl !== target.canonicalUrl) ||
      (target.fixtureSourceUrl &&
        (target.fixtureSourceUrl !== identity.canonicalUrl ||
          !['127.0.0.1', '[::1]'].includes(local.hostname) ||
          local.username ||
          local.password ||
          local.search ||
          local.hash))
    )
      ctx.addIssue({
        code: 'custom',
        message: 'Application target identity mismatch',
      });
  });
export type ApplicationTarget = z.infer<typeof ApplicationTargetSchema>;

export function matchesAtsTarget(
  target: ApplicationTarget,
  url: string,
): boolean {
  const identity = atsUrlIdentity(url);
  return Boolean(
    identity &&
    identity.platform === target.platform &&
    identity.boardToken === target.boardToken &&
    identity.externalJobId === target.externalJobId &&
    identity.canonicalUrl === target.canonicalUrl &&
    new URL(url).search === new URL(target.canonicalUrl).search &&
    new URL(url).origin === new URL(target.canonicalUrl).origin,
  );
}
