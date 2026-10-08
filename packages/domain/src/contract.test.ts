import { describe, expect, it } from 'vitest';
import {
  ApplicationDestinationUrlSchema,
  ApplicationPlanSchema,
  canTransition,
} from './index.js';

const base = {
  jobId: 'job-1',
  applicationType: 'EMAIL',
  destination: { email: 'jobs@example.com' },
  requirements: [],
  actions: [],
  executor: 'EMAIL',
  confidence: 0.9,
  requiresHumanReview: false,
  reasoning: ['test'],
  resolvedBy: 'deterministic',
};

describe('destination policy', () => {
  it.each([
    'javascript:alert(1)',
    'file:///tmp/a',
    'data:text/html,hi',
    'blob:https://example.com/id',
    'about:blank',
    'chrome://settings',
    'chrome-extension://abc/a',
    'custom://host/a',
    'http://example.com',
  ])('rejects %s', (url) => {
    expect(ApplicationDestinationUrlSchema.safeParse(url).success).toBe(false);
  });
  it('allows HTTPS with a host', () => {
    expect(
      ApplicationDestinationUrlSchema.safeParse('https://example.com/job/123')
        .success,
    ).toBe(true);
  });
});

describe('plan contract', () => {
  it.each([
    ['EMAIL', 'EMAIL', { email: 'jobs@example.com' }, true],
    ['EMAIL', 'BROWSER', { email: 'jobs@example.com' }, false],
    ['GOOGLE_FORM', 'GOOGLE_FORM', { url: 'https://example.com/form' }, true],
    ['GOOGLE_FORM', 'EMAIL', { url: 'https://example.com/form' }, false],
    ['GOOGLE_DOC', 'GOOGLE_DOC', { url: 'https://example.com/doc' }, true],
    ['DIRECT_PORTAL', 'BROWSER', { url: 'https://example.com/apply' }, true],
    ['EXTERNAL_ATS', 'BROWSER', { url: 'https://example.com/apply' }, true],
    ['EXTERNAL_ATS', 'EMAIL', { url: 'https://example.com/apply' }, false],
    ['LINKEDIN', 'LINKEDIN', { url: 'https://example.com/job' }, true],
    ['HUMAN_REQUIRED', 'HUMAN', {}, true],
    ['HUMAN_REQUIRED', 'BROWSER', {}, false],
    ['UNKNOWN', 'NONE', {}, true],
    ['UNKNOWN', 'EMAIL', {}, false],
  ] as const)(
    '%s with %s is valid: %s',
    (applicationType, executor, destination, valid) => {
      const requiresHumanReview = executor === 'HUMAN';
      expect(
        ApplicationPlanSchema.safeParse({
          ...base,
          applicationType,
          executor,
          destination,
          requiresHumanReview,
        }).success,
      ).toBe(valid);
    },
  );
  it.each([
    'EMAIL',
    'GOOGLE_FORM',
    'GOOGLE_DOC',
    'DIRECT_PORTAL',
    'EXTERNAL_ATS',
    'LINKEDIN',
  ] as const)('requires destination for %s', (applicationType) => {
    expect(
      ApplicationPlanSchema.safeParse({
        ...base,
        applicationType,
        destination: {},
      }).success,
    ).toBe(false);
  });
  it('rejects automatic execution for review', () => {
    expect(
      ApplicationPlanSchema.safeParse({ ...base, requiresHumanReview: true })
        .success,
    ).toBe(false);
  });
  it('rejects sensitive requirements without human review', () => {
    expect(
      ApplicationPlanSchema.safeParse({
        ...base,
        requirements: [
          {
            type: 'SPONSORSHIP',
            status: 'required',
            label: 'Visa',
            source: 'structured',
          },
        ],
      }).success,
    ).toBe(false);
  });
  it('rejects an unsafe plan URL', () => {
    expect(
      ApplicationPlanSchema.safeParse({
        ...base,
        applicationType: 'DIRECT_PORTAL',
        executor: 'BROWSER',
        destination: { url: 'javascript:alert(1)' },
      }).success,
    ).toBe(false);
  });
  it('rejects URL destination on email plan', () => {
    expect(
      ApplicationPlanSchema.safeParse({
        ...base,
        destination: { email: 'jobs@example.com', url: 'https://example.com' },
      }).success,
    ).toBe(false);
  });
});

describe('state transitions', () => {
  it.each([
    ['DISCOVERED', 'ANALYZING', true],
    ['DISCOVERED', 'FAILED', true],
    ['ANALYZING', 'RESOLVED', true],
    ['ANALYZING', 'HUMAN_REQUIRED', true],
    ['ANALYZING', 'FAILED', true],
    ['FAILED', 'ANALYZING', true],
    ['DISCOVERED', 'SUBMITTED', false],
    ['RESOLVED', 'ANALYZING', false],
    ['SUBMITTED', 'ANALYZING', false],
    ['FAILED', 'SUBMITTED', false],
    ['HUMAN_REQUIRED', 'SUBMITTED', false],
  ] as const)('%s to %s: %s', (from, to, valid) => {
    expect(canTransition(from, to)).toBe(valid);
  });
});
