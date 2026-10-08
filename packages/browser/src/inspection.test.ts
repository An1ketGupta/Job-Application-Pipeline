import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import {
  ApplicationPlanSchema,
  ApplicationSchemaSchema,
} from '@careerlift/domain';
import { ApplicationInspector } from './inspector.js';
import { BrowserSessionManager } from './session.js';
import { DestinationPolicy, validateRedirectChain } from './policy.js';
import { detectPlatform } from './platform.js';
import { classifyPage, type RawPageRepresentation } from './extract.js';

const plan = ApplicationPlanSchema.parse({
  jobId: 'job-1',
  applicationType: 'EXTERNAL_ATS',
  provider: 'GREENHOUSE',
  destination: { url: 'https://fixture.example/apply' },
  requirements: [],
  actions: [],
  executor: 'BROWSER',
  confidence: 0.9,
  requiresHumanReview: false,
  reasoning: ['fixture'],
  resolvedBy: 'deterministic',
});

const fixture = (name: string) =>
  readFileSync(
    new URL(`../../../tests/fixtures/inspection/${name}.html`, import.meta.url),
    'utf8',
  );
const generic = fixture('generic');

class FixtureSessions extends BrowserSessionManager {
  observation:
    | {
        values: string[];
        checked: boolean[];
        files: number[];
        submitted: boolean;
        clicked: boolean;
        events: number;
      }
    | undefined;
  constructor(
    private readonly html: string,
    private readonly redirect?: string,
  ) {
    super(true, new DestinationPolicy(undefined, async () => ['8.8.8.8']));
  }
  override async create() {
    const session = await super.create();
    await session.page.addInitScript(() => {
      (window as unknown as { inspectionEvents: number }).inspectionEvents = 0;
      for (const event of ['input', 'change', 'click', 'submit'])
        document.addEventListener(
          event,
          () => {
            (window as unknown as { inspectionEvents: number })
              .inspectionEvents++;
          },
          true,
        );
    });
    await session.page.route('https://fixture.example/**', async (route) => {
      if (this.redirect && route.request().url().endsWith('/apply'))
        await route.fulfill({
          status: 302,
          headers: { location: this.redirect },
        });
      else
        await route.fulfill({
          status: 200,
          contentType: 'text/html',
          body: this.html,
        });
    });
    return {
      ...session,
      close: async () => {
        this.observation = await session.page
          .evaluate(() => ({
            values: Array.from(
              document.querySelectorAll<HTMLInputElement | HTMLTextAreaElement>(
                'input:not([type=file]):not([type=checkbox]),textarea',
              ),
            ).map((input) => input.value),
            checked: Array.from(
              document.querySelectorAll<HTMLInputElement>(
                'input[type=checkbox]',
              ),
            ).map((input) => input.checked),
            files: Array.from(
              document.querySelectorAll<HTMLInputElement>('input[type=file]'),
            ).map((input) => input.files?.length ?? 0),
            submitted: Boolean(
              (window as unknown as { submitted?: boolean }).submitted,
            ),
            clicked: Boolean(
              (window as unknown as { clicked?: boolean }).clicked,
            ),
            events: (window as unknown as { inspectionEvents: number })
              .inspectionEvents,
          }))
          .catch(() => undefined);
        await session.close();
      },
    };
  }
}

describe('inspection policy and deterministic analysis', () => {
  it.each([
    'javascript:alert(1)',
    'file:///x',
    'data:text/html,a',
    'blob:https://x/a',
    'about:blank',
    'chrome://settings',
    'custom://x',
  ])('rejects %s', (url) => {
    expect(() => new DestinationPolicy().validateNavigation(url)).toThrow();
  });
  it('accepts HTTPS and rejects an unsafe redirect', () => {
    const policy = new DestinationPolicy();
    expect(() =>
      policy.validateNavigation('https://example.com/apply'),
    ).not.toThrow();
    expect(() =>
      validateRedirectChain(
        ['https://example.com/apply', 'http://localhost/admin'],
        policy,
      ),
    ).toThrow();
    expect(() =>
      policy.validateRequest('https://example.com/post', 'POST'),
    ).toThrow();
  });
  it.each([
    'https://127.0.0.1/',
    'https://10.1.2.3/',
    'https://172.16.0.1/',
    'https://192.168.1.1/',
    'https://169.254.169.254/latest/meta-data/',
    'https://[::1]/',
    'https://[fc00::1]/',
    'https://metadata.google.internal/',
    'https://localhost/',
  ])('blocks private destination %s', (url) => {
    const policy = new DestinationPolicy();
    expect(() => policy.validateNavigation(url)).toThrow();
    expect(() => policy.validateRequest(url, 'GET')).toThrow();
  });
  it('rejects DNS answers containing private addresses and rebinding on a later lookup', async () => {
    let count = 0;
    const policy = new DestinationPolicy(undefined, async () =>
      ++count === 1 ? ['8.8.8.8'] : ['8.8.8.8', '169.254.169.254'],
    );
    await expect(
      policy.validateAddress('https://example.com/'),
    ).resolves.toBeUndefined();
    await expect(
      policy.validateAddress('https://example.com/'),
    ).rejects.toMatchObject({
      code: 'UNSAFE_DESTINATION',
    });
    expect(() =>
      policy.validateConnectedAddress('https://example.com/', '10.0.0.1'),
    ).toThrow();
  });
  it.each([
    ['https://boards.greenhouse.io/job', 'GREENHOUSE'],
    ['https://jobs.lever.co/x', 'LEVER'],
    ['https://x.myworkdayjobs.com/a', 'WORKDAY'],
    ['https://jobs.ashbyhq.com/a', 'ASHBY'],
    ['https://jobs.smartrecruiters.com/a', 'SMARTRECRUITERS'],
    ['https://jobs.icims.com/a', 'ICIMS'],
    ['https://forms.google.com/a', 'GOOGLE_FORM'],
    ['https://docs.google.com/forms/d/e/test/viewform', 'GOOGLE_FORM'],
    ['https://docs.google.com/document/d/a', 'GOOGLE_DOC'],
    ['https://linkedin.com/jobs/a', 'LINKEDIN'],
  ] as const)('detects %s', (url, expected) =>
    expect(detectPlatform(url, '', false).platform).toBe(expected),
  );
  it('refuses DOM branding as platform identity and recognizes unknown pages', () => {
    expect(
      detectPlatform(
        'https://company.example/apply',
        '<div class="lever-application">',
        true,
      ).platform,
    ).toBe('GENERIC_PORTAL');
    expect(
      detectPlatform('https://company.example/a', '', false).platform,
    ).toBe('UNKNOWN');
  });
  it('classifies CAPTCHA and authentication walls', () => {
    const raw: RawPageRepresentation = {
      title: 'Verify you are human',
      visibleText: '',
      signature: '',
      fields: [],
      forms: [],
      links: [],
      buttons: [],
    };
    expect(classifyPage(raw).humanReview.reasons).toContain('CAPTCHA');
    expect(
      classifyPage({
        ...raw,
        title: 'Sign in to apply',
        fields: [
          {
            id: 'f',
            label: 'Password',
            name: 'password',
            type: 'TEXT',
            required: true,
            visible: true,
            disabled: false,
            readonly: false,
            options: [],
            source: 'DOM',
          },
        ],
      }).humanReview.reasons,
    ).toContain('AUTHENTICATION_REQUIRED');
  });
  it('validates schema shape', () =>
    expect(
      ApplicationSchemaSchema.safeParse({ platform: 'GREENHOUSE' }).success,
    ).toBe(false));
});

describe('read-only Playwright fixture inspection', () => {
  it('extracts fields, questions and documents without mutating the page', async () => {
    const sessions = new FixtureSessions(generic);
    const outcome = await new ApplicationInspector(sessions).inspect(
      plan,
      'plan-1',
    );
    expect(outcome.status).toBe('HUMAN_REQUIRED');
    expect(outcome.schema?.title).toBe('Engineer Application');
    expect(outcome.schema?.fields.map((f) => f.type)).toContain('EMAIL');
    expect(outcome.schema?.documents[0]).toMatchObject({
      type: 'RESUME',
      required: true,
      acceptedFileTypes: ['.pdf', '.docx'],
    });
    expect(
      outcome.schema?.questions.some(
        (q) => q.semanticType === 'SPONSORSHIP' && q.humanReviewRequired,
      ),
    ).toBe(true);
    expect(outcome.schema?.forms[0]?.submitControls).toContain('Submit');
    expect(outcome.schema?.platformDiscrepancy).toBe(true);
    expect(sessions.observation).toMatchObject({
      checked: [false],
      files: [0],
      submitted: false,
      clicked: false,
      events: 0,
    });
    expect(
      sessions.observation?.values.every(
        (value) => value === '' || value === 'Choose',
      ),
    ).toBe(true);
  }, 30000);
  it('returns human-required for challenge, login and interactive discovery', async () => {
    for (const [html, reason] of [
      ['<title>Captcha</title><div>Verify you are human</div>', 'CAPTCHA'],
      [
        '<title>Sign in to apply</title><input name="password" type="password">',
        'AUTHENTICATION_REQUIRED',
      ],
      [
        '<title>Job</title><button>Apply now</button>',
        'INTERACTIVE_DISCOVERY_REQUIRED',
      ],
    ]) {
      const outcome = await new ApplicationInspector(
        new FixtureSessions(html),
      ).inspect(plan, 'plan-1');
      expect(outcome.status).toBe('HUMAN_REQUIRED');
      expect(outcome.schema?.humanReview.reasons).toContain(reason);
    }
  }, 60000);
  it.each([
    ['greenhouse', 'GENERIC_PORTAL'],
    ['lever', 'GENERIC_PORTAL'],
    ['workday', 'GENERIC_PORTAL'],
    ['google-form', 'GENERIC_PORTAL'],
  ] as const)(
    'does not trust %s branding from a local HTML fixture',
    async (name, platform) => {
      const outcome = await new ApplicationInspector(
        new FixtureSessions(fixture(name)),
      ).inspect(plan, 'plan-1');
      expect(outcome.schema?.platform).toBe(platform);
    },
    30000,
  );
  it('handles local sensitive, CAPTCHA, login, and unknown fixtures', async () => {
    for (const [name, reason] of [
      ['sensitive', 'SENSITIVE_QUESTION'],
      ['captcha', 'CAPTCHA'],
      ['login', 'AUTHENTICATION_REQUIRED'],
      ['unknown', 'INTERACTIVE_DISCOVERY_REQUIRED'],
    ]) {
      const outcome = await new ApplicationInspector(
        new FixtureSessions(fixture(name)),
      ).inspect(plan, 'plan-1');
      expect(outcome.schema?.humanReview.reasons).toContain(reason);
    }
  }, 60000);
  it('blocks unsafe redirects', async () => {
    const outcome = await new ApplicationInspector(
      new FixtureSessions(generic, 'http://localhost/admin'),
    ).inspect(plan, 'plan-1');
    expect(outcome.status).toBe('FAILED');
    expect(outcome.errorCode).toBe('UNSAFE_DESTINATION');
  }, 30000);
  it.each([404, 500])(
    'fails on HTTP %i without producing a schema',
    async (status) => {
      class ErrorSessions extends FixtureSessions {
        override async create() {
          const session = await super.create();
          await session.page.route('https://fixture.example/**', (route) =>
            route.fulfill({ status, body: generic, contentType: 'text/html' }),
          );
          return session;
        }
      }
      const outcome = await new ApplicationInspector(
        new ErrorSessions(generic),
      ).inspect(plan, 'plan-1');
      expect(outcome).toMatchObject({
        status: 'FAILED',
        errorCode: 'HTTP_ERROR',
      });
      expect(outcome.schema).toBeUndefined();
    },
    30000,
  );
});
