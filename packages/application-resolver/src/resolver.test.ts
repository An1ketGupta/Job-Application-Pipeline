import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import {
  ApplicationPlanSchema,
  InvalidExternalDataError,
} from '@careerlift/domain';
import { CareerLiftJobAdapter } from '@careerlift/validation';
import {
  CompositeApplicationResolver,
  DeterministicResolver,
} from './resolver.js';

const fixturePath = fileURLToPath(
  new URL('../../../tests/fixtures/careerlift-jobs.json', import.meta.url),
);
const raw: unknown[] = JSON.parse(
  readFileSync(fixturePath, 'utf8'),
) as unknown[];
const adapter = new CareerLiftJobAdapter();
const cases = [
  ['EMAIL', 'EMAIL', undefined, false],
  ['HUMAN_REQUIRED', 'HUMAN', undefined, true],
  ['GOOGLE_FORM', 'GOOGLE_FORM', undefined, false],
  ['GOOGLE_DOC', 'GOOGLE_DOC', undefined, false],
  ['EXTERNAL_ATS', 'BROWSER', 'GREENHOUSE', false],
  ['EXTERNAL_ATS', 'BROWSER', 'LEVER', false],
  ['HUMAN_REQUIRED', 'HUMAN', undefined, true],
  ['UNKNOWN', 'HUMAN', undefined, true],
  ['UNKNOWN', 'HUMAN', undefined, true],
  ['HUMAN_REQUIRED', 'HUMAN', undefined, true],
] as const;

describe('CareerLift fixture resolution', () => {
  const resolver = new DeterministicResolver();
  it.each(cases.map((expected, index) => [index, ...expected]))(
    'resolves fixture %i into a complete plan',
    (index, type, executor, provider, review) => {
      const job = adapter.parse(raw[index]);
      const plan = resolver.resolve(job);
      expect(ApplicationPlanSchema.parse(plan)).toEqual(plan);
      expect(plan).toMatchObject({
        jobId: job.id,
        applicationType: type,
        executor,
        requiresHumanReview: review,
        resolvedBy: 'deterministic',
      });
      expect(plan.provider).toBe(provider);
      expect(plan.destination).toMatchObject({
        ...(job.application?.url
          ? {
              url: plan.destination.target?.canonicalUrl ?? job.application.url,
            }
          : {}),
        ...(job.application?.email ? { email: job.application.email } : {}),
      });
      expect(plan.actions.length).toBeGreaterThan(0);
      expect(plan.reasoning.length).toBeGreaterThan(0);
      expect(plan.confidence).toBeGreaterThanOrEqual(0);
      expect(plan.confidence).toBeLessThanOrEqual(1);
    },
  );
  it('extracts required and optional documents', () => {
    const plan = resolver.resolve(adapter.parse(raw[0]));
    expect(plan.requirements).toEqual([
      {
        type: 'RESUME',
        status: 'required',
        label: 'Resume',
        source: 'description',
      },
      {
        type: 'COVER_LETTER',
        status: 'optional',
        label: 'Cover letter',
        source: 'description',
      },
    ]);
  });
  it('keeps structured requirement status and defaults missing details', () => {
    const job = adapter.parse({
      id: 'structured',
      company: 'Example',
      role: 'Role',
      application: {
        email: 'jobs@example.com',
        requirements: [
          { type: 'RESUME', status: 'required' },
          { type: 'PORTFOLIO' },
        ],
      },
    });
    expect(resolver.resolve(job).requirements).toEqual([
      {
        type: 'RESUME',
        status: 'required',
        label: 'resume',
        source: 'structured',
      },
      {
        type: 'PORTFOLIO',
        status: 'unknown',
        label: 'portfolio',
        source: 'structured',
      },
    ]);
  });
  it('preserves source method and review signals in normalized fields', () => {
    const job = adapter.parse({
      id: 'source-fields',
      company: 'Example',
      role: 'Role',
      application: {
        type: 'novel_method',
        email: 'jobs@example.com',
        requiresHumanReview: true,
        requirements: [{ type: 'RESUME', status: 'required' }],
      },
    });
    expect(job.application).toMatchObject({
      source: 'careerlift-fixture',
      reportedMethod: 'novel_method',
      unrecognizedMethod: 'novel_method',
      requiresHumanReview: true,
      structuredRequirements: [
        { type: 'RESUME', status: 'required', source: 'structured' },
      ],
    });
    expect(resolver.resolve(job)).toMatchObject({
      applicationType: 'HUMAN_REQUIRED',
      executor: 'HUMAN',
    });
  });
  it('classifies sensitive questions without answering them', () => {
    const plan = resolver.resolve(adapter.parse(raw[9]));
    expect(plan.requirements.map((r) => r.type)).toContain('SPONSORSHIP');
    expect(JSON.stringify(plan)).not.toContain('yes');
  });
  it('routes conflicting structured type and destination to review', () => {
    const job = adapter.parse({
      id: 'conflict',
      company: 'Conflict',
      role: 'Role',
      application: { type: 'email', url: 'https://jobs.lever.co/org/job' },
    });
    expect(resolver.resolve(job)).toMatchObject({
      applicationType: 'HUMAN_REQUIRED',
      requiresHumanReview: true,
      executor: 'HUMAN',
    });
  });
  it('routes competing email and URL destinations to review', () => {
    const job = adapter.parse({
      id: 'two-destinations',
      company: 'Example',
      role: 'Role',
      application: {
        type: 'email',
        email: 'jobs@example.com',
        url: 'https://jobs.example.com/apply',
      },
    });
    expect(resolver.resolve(job)).toMatchObject({
      applicationType: 'HUMAN_REQUIRED',
      requiresHumanReview: true,
    });
  });
  it('routes a structured ATS type with an unsupported generic URL to review', () => {
    const job = adapter.parse({
      id: 'other-ats',
      company: 'Example',
      role: 'Role',
      application: {
        type: 'ats',
        provider: 'other',
        url: 'https://recruit.example.com/apply',
      },
    });
    expect(resolver.resolve(job)).toMatchObject({
      applicationType: 'HUMAN_REQUIRED',
      executor: 'HUMAN',
      requiresHumanReview: true,
      destination: { unsupportedReason: 'UNSUPPORTED_APPLICATION_PLATFORM' },
    });
  });
  it('does not trust lookalike destination hosts', () => {
    const job = adapter.parse({
      id: 'lookalike',
      company: 'Example',
      role: 'Role',
      application: { url: 'https://jobs.lever.co.evil.example/apply' },
    });
    expect(resolver.resolve(job).applicationType).toBe('HUMAN_REQUIRED');
  });
  it('rejects unsafe plans at the shared schema boundary', () => {
    const unknown = resolver.resolve(adapter.parse(raw[8]));
    expect(
      ApplicationPlanSchema.safeParse({
        ...unknown,
        requiresHumanReview: false,
      }).success,
    ).toBe(false);
  });
  it('rejects invalid external data', () => {
    expect(() => adapter.parse({ company: 'Example' })).toThrow(
      InvalidExternalDataError,
    );
  });
  it('uses the LLM only below threshold and validates its result', async () => {
    const job = adapter.parse(raw[8]);
    let calls = 0;
    const composite = new CompositeApplicationResolver(undefined, {
      resolve: () => {
        calls++;
        return { madeUp: true } as never;
      },
    });
    expect(await composite.resolve(job)).toMatchObject({
      applicationType: 'UNKNOWN',
      requiresHumanReview: true,
    });
    expect(calls).toBe(1);
    await composite.resolve(adapter.parse(raw[0]));
    expect(calls).toBe(1);
  });
});
