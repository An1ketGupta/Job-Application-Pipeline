import { describe, expect, it, vi } from 'vitest';
import {
  ApplicationPlanSchema,
  ApplicationTargetSchema,
  JobSchema,
  detectAtsPlatform,
  atsUrlIdentity,
  matchesAtsTarget,
} from '@careerlift/domain';
import {
  GreenhouseAdapter,
  LeverAdapter,
  AshbyAdapter,
} from './ats-adapters.js';
import {
  DeterministicResolver,
  CompositeApplicationResolver,
} from './resolver.js';

const job = (url: string, provider?: string) =>
  JobSchema.parse({
    id: 'job',
    externalId: 'posting',
    source: 'CAREERLIFT',
    company: 'Company',
    title: 'Engineer',
    requirements: [],
    application: { url, ...(provider ? { provider } : {}) },
  });
const adapters = [
  {
    adapter: new GreenhouseAdapter(),
    url: 'https://boards.greenhouse.io/acme/jobs/123',
    canonical: 'https://job-boards.greenhouse.io/acme/jobs/123',
  },
  {
    adapter: new LeverAdapter(),
    url: 'https://jobs.lever.co/acme/posting',
    canonical: 'https://jobs.lever.co/acme/posting/apply',
  },
  {
    adapter: new AshbyAdapter(),
    url: 'https://jobs.ashbyhq.com/acme/posting',
    canonical: 'https://jobs.ashbyhq.com/acme/posting/application',
  },
];
describe.each(adapters)(
  '$adapter.platform knowledge adapter',
  ({ adapter, url, canonical }) => {
    it('normalizes a hosted application entry point and untrusted job metadata', () => {
      const target = adapter.resolve(
        job(`${url}?token=SECRET&redirect=https://evil.example/#credentials`),
      )!;
      expect(target).toMatchObject({
        platform: adapter.platform,
        adapterVersion: 1,
        canonicalUrl: canonical,
        company: 'Company',
        role: 'Engineer',
        metadataSource: 'JOB_UNTRUSTED',
        externalJobId: adapter.platform === 'GREENHOUSE' ? '123' : 'posting',
        boardToken: 'acme',
        entryPoint: { url: canonical },
        inspectionHints: { formIsDynamic: true },
      });
      expect(target.capabilities).toMatchObject({
        supportsResumeUpload: true,
        supportsFileUpload: true,
        supportsCoverLetter: true,
        supportsDynamicQuestions: true,
        supportsKnownSuccessSignals: false,
      });
      expect(JSON.stringify(target)).not.toContain('SECRET');
      expect(ApplicationTargetSchema.parse(target)).toEqual(target);
      expect(adapter.resolve(job(canonical))).toEqual(target);
      expect(Object.keys(adapter)).not.toContain('execute');
    });
    it('feeds the existing browser plan without authority fields', () => {
      const plan = new DeterministicResolver().resolve(job(url));
      expect(plan).toMatchObject({
        applicationType: 'EXTERNAL_ATS',
        executor: 'BROWSER',
        provider: adapter.platform,
        requiresHumanReview: false,
        destination: { url: canonical, target: { platform: adapter.platform } },
      });
      expect(matchesAtsTarget(plan.destination.target!, canonical)).toBe(true);
      expect(
        matchesAtsTarget(
          plan.destination.target!,
          `${canonical}?redirect=evil`,
        ),
      ).toBe(false);
      for (const key of [
        'submitted',
        'confirmed',
        'cookies',
        'tokens',
        'securityContext',
        'executionFlow',
      ])
        expect(
          ApplicationTargetSchema.safeParse({
            ...plan.destination.target,
            [key]: true,
          }).success,
        ).toBe(false);
      expect(
        ApplicationPlanSchema.safeParse({ ...plan, provider: 'WORKDAY' })
          .success,
      ).toBe(false);
    });
    it.each(['http:', 'javascript:', 'file:', 'blob:', 'data:', 'custom:'])(
      'refuses unsafe scheme %s',
      (scheme) => {
        expect(adapter.supports(url.replace('https:', scheme))).toBe(false);
        expect(() =>
          adapter.resolve(job(url.replace('https:', scheme))),
        ).toThrow();
      },
    );
    it.each(['.evil.example', '.localhost', '.internal', '.'])(
      'rejects lookalike host suffix %s',
      (suffix) => {
        const forged = new URL(url);
        forged.hostname += suffix;
        expect(detectAtsPlatform(forged.href)).toBeUndefined();
        expect(
          new DeterministicResolver().resolve(job(forged.href)),
        ).toMatchObject({
          executor: 'HUMAN',
          destination: {
            unsupportedReason: 'UNSUPPORTED_APPLICATION_PLATFORM',
          },
        });
      },
    );
    it('rejects credentials, unapproved ports, board-only paths and mismatched metadata', () => {
      const credential = new URL(url);
      credential.username = 'password';
      expect(adapter.supports(credential.href)).toBe(false);
      const port = new URL(url);
      port.port = '444';
      expect(adapter.supports(port.href)).toBe(false);
      const board = new URL(url);
      board.pathname = '/acme';
      expect(adapter.resolve(job(board.href))).toBeUndefined();
      const target = adapter.resolve(job(url))!;
      expect(
        ApplicationTargetSchema.safeParse({ ...target, externalJobId: 'other' })
          .success,
      ).toBe(false);
    });
    it('cannot suppress sensitive review or let a model invent authority', async () => {
      const sensitive = {
        ...job(url),
        requirements: ['Visa sponsorship question required'],
      };
      const plan = new DeterministicResolver().resolve(sensitive);
      expect(plan).toMatchObject({
        executor: 'HUMAN',
        requiresHumanReview: true,
        provider: adapter.platform,
        destination: { target: { platform: adapter.platform } },
      });
      const llm = {
        resolve: vi.fn(async () => ({
          ...plan,
          executor: 'BROWSER' as const,
          requiresHumanReview: false,
        })),
      };
      expect(
        await new CompositeApplicationResolver(undefined, llm).resolve(
          sensitive,
        ),
      ).toEqual(plan);
      expect(llm.resolve).not.toHaveBeenCalled();
    });
  },
);
describe('ATS registry and resolver boundaries', () => {
  it.each([
    'https://greenhouse.io/acme/jobs/1',
    'https://www.lever.co/acme/posting',
    'https://api.ashbyhq.com/acme/posting',
    'https://evil.jobs.lever.co/acme/posting',
    'https://127.0.0.1/apply',
    'https://169.254.169.254/latest/meta-data',
    'https://[::1]/',
    'https://metadata.google.internal/',
    'https://tenant.myworkdayjobs.com/job/1',
  ])('keeps unsupported %s out of the browser pipeline', (url) => {
    const plan = new DeterministicResolver().resolve(job(url, 'GREENHOUSE'));
    expect(plan).toMatchObject({
      requiresHumanReview: true,
      executor: 'HUMAN',
      destination: { unsupportedReason: 'UNSUPPORTED_APPLICATION_PLATFORM' },
    });
    expect(plan.destination.target).toBeUndefined();
  });
  it.each([
    'not a url',
    'javascript:alert(1)',
    'data:text/html,x',
    'file:///etc/passwd',
  ])('rejects malformed/unsafe input %s', (url) =>
    expect(() => new DeterministicResolver().resolve(job(url))).toThrow(),
  );
  it('preserves Greenhouse embed identifiers without tracking data', () => {
    expect(
      atsUrlIdentity(
        'https://boards.greenhouse.io/embed/job_app?for=acme&gh_jid=123&tokenSecret=SECRET',
      ),
    ).toMatchObject({
      boardToken: 'acme',
      externalJobId: '123',
      canonicalUrl:
        'https://job-boards.greenhouse.io/embed/job_app?for=acme&token=123',
    });
    expect(
      atsUrlIdentity(
        'https://boards.greenhouse.io/embed/job_app?for=acme&token=123&gh_jid=456',
      ),
    ).toBeUndefined();
    expect(
      atsUrlIdentity(
        'https://boards.greenhouse.io/embed/job_app?for=acme&for=evil&token=123',
      ),
    ).toBeUndefined();
  });
  it.each([
    'https://jobs.eu.lever.co/acme/posting',
    'https://job-boards.eu.greenhouse.io/acme/jobs/123',
  ])('supports regional host %s', (url) =>
    expect(new DeterministicResolver().resolve(job(url)).executor).toBe(
      'BROWSER',
    ),
  );
  it('does not permit structured provider spoofing or model support fabrication', async () => {
    expect(
      new DeterministicResolver().resolve(job(adapters[0]!.url, 'LEVER')),
    ).toMatchObject({ executor: 'HUMAN', requiresHumanReview: true });
    const unknown = job('https://unknown.example/apply', 'ASHBY');
    const llm = {
      resolve: vi.fn(async () =>
        new DeterministicResolver().resolve(job(adapters[2]!.url)),
      ),
    };
    const plan = await new CompositeApplicationResolver(undefined, llm).resolve(
      unknown,
    );
    expect(plan.executor).toBe('HUMAN');
    expect(llm.resolve).not.toHaveBeenCalled();
    expect(() => new DeterministicResolver('https://jobs.lever.co')).toThrow();
    expect(
      new DeterministicResolver('https://127.0.0.1:444').resolve(
        job('https://127.0.0.1:444/apply'),
      ).executor,
    ).toBe('BROWSER');
    expect(
      new DeterministicResolver('https://127.0.0.1:444').resolve(
        job('https://127.0.0.1:445/apply'),
      ).executor,
    ).toBe('HUMAN');
  });
});
