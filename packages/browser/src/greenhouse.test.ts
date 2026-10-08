import { describe, expect, it } from 'vitest';
import {
  ApplicationFieldSchema,
  validFieldValue,
  canRepairGreenhouseInspection,
  greenhouseSubmissionBlocker,
} from '@careerlift/domain';
import { ApplicationInspector } from './inspector.js';
import { BrowserApplicationExecutor } from './executor.js';
import { BrowserSessionManager, type BrowserSession } from './session.js';
import { DestinationPolicy } from './policy.js';
import {
  greenhouseFixture,
  greenhouseSource,
  greenhousePosting,
} from './test-support/greenhouse-fixture.js';
import {
  parseGreenhouseLoader,
  isGreenhouseFrame,
  isGreenhouseTelemetry,
} from './greenhouse-form.js';
import { validateGreenhousePayload } from './greenhouse-payload.js';

describe('Greenhouse pipeline', () => {
  it.each(['known-frame', 'unknown-frame', 'main-navigation'])(
    'keeps navigation checks for %s',
    async (scenario) => {
      const fixture = await greenhouseFixture();
      const mainUrl = fixture.input.inspection.finalUrl;
      const frameUrl = `${fixture.origin}/allowed-frame`;
      const session = await new BrowserSessionManager(
        true,
        new DestinationPolicy(fixture.origin),
        true,
      ).create(
        (url) => {
          if (url !== mainUrl)
            throw new Error('Unexpected application navigation');
        },
        undefined,
        (url) => url === frameUrl,
      );
      try {
        await session.page.goto(mainUrl);
        await session.securityCheck();
        if (scenario === 'main-navigation')
          await session.page.goto(frameUrl).catch(() => {});
        else {
          const target =
            scenario === 'known-frame'
              ? frameUrl
              : `${fixture.origin}/unapproved-frame`;
          await session.page.evaluate(
            (url) =>
              new Promise<void>((resolve) => {
                const frame = document.createElement('iframe');
                frame.onload = () => resolve();
                frame.onerror = () => resolve();
                frame.src = url;
                document.body.append(frame);
              }),
            target,
          );
        }
        if (scenario === 'known-frame')
          await expect(session.securityCheck()).resolves.toBeUndefined();
        else await expect(session.securityCheck()).rejects.toThrow();
      } finally {
        await session.close();
        await fixture.close();
      }
    },
    30000,
  );
  it('blocks telemetry without a fatal inspection error while rejecting other POST requests', async () => {
    const fixture = await greenhouseFixture();
    const session = await new BrowserSessionManager(
      true,
      new DestinationPolicy(fixture.origin),
      true,
    ).create(undefined, (url, method) =>
      isGreenhouseTelemetry(greenhouseSource, url, method)
        ? 'BLOCK_OPTIONAL'
        : false,
    );
    try {
      await session.page.goto(fixture.input.inspection.finalUrl);
      await session.page.evaluate(async () => {
        await fetch(
          'https://c.spl.greenhouse.io/com.snowplowanalytics.snowplow/tp2',
          { method: 'POST', body: '{}', mode: 'no-cors' },
        ).catch(() => {});
      });
      await expect(session.securityCheck()).resolves.toBeUndefined();
      await session.page.evaluate(async (url) => {
        await fetch(url, { method: 'POST', body: 'unapproved' }).catch(
          () => {},
        );
      }, `${fixture.origin}/unapproved-submit`);
      await expect(session.securityCheck()).rejects.toThrow();
      expect(fixture.calls).toHaveLength(0);
    } finally {
      await session.close();
      await fixture.close();
    }
  }, 30000);
  it('requires a confirmed country calling code during phone preparation', () => {
    const field = ApplicationFieldSchema.parse({
      id: 'phone',
      label: 'Phone',
      type: 'PHONE',
      required: true,
      visible: true,
      disabled: false,
      readonly: false,
      source: 'DOM',
      phoneFormat: 'INTERNATIONAL',
    });
    expect(validFieldValue('9876543210', field)).toBe(false);
    expect(validFieldValue('+91 (987) 654-3210', field)).toBe(true);
    expect(validFieldValue('+00 9876543210', field)).toBe(false);
  });
  it('binds metadata to the exact job and never evaluates embedded code', () => {
    const script = (p: unknown) =>
      `window.__remixContext = ${JSON.stringify({ state: { loaderData: { posting: p } } })};`;
    expect(
      parseGreenhouseLoader([script(greenhousePosting())], greenhouseSource)
        ?.jobPostId,
    ).toBe('123');
    expect(
      parseGreenhouseLoader(
        [script({ ...greenhousePosting(), jobPostId: '999' })],
        greenhouseSource,
      ),
    ).toBeUndefined();
    expect(
      parseGreenhouseLoader(
        [
          script({
            ...greenhousePosting(),
            submitPath: 'https://attacker.example/submit',
          }),
        ],
        greenhouseSource,
      ),
    ).toBeUndefined();
    expect(
      parseGreenhouseLoader(
        ['window.__remixContext = (()=>{throw new Error()})();'],
        greenhouseSource,
      ),
    ).toBeUndefined();
  });
  it('recognizes only known analytics and frames', () => {
    expect(
      isGreenhouseTelemetry(
        greenhouseSource,
        'https://c.spl.greenhouse.io/com.snowplowanalytics.snowplow/tp2',
        'POST',
      ),
    ).toBe(true);
    expect(
      isGreenhouseTelemetry(
        greenhouseSource,
        'https://c.spl.greenhouse.io/application',
        'POST',
      ),
    ).toBe(false);
    expect(
      isGreenhouseTelemetry(
        'https://attacker.example',
        'https://c.spl.greenhouse.io/com.snowplowanalytics.snowplow/tp2',
        'POST',
      ),
    ).toBe(false);
    expect(
      isGreenhouseFrame(
        greenhouseSource,
        'https://www.recaptcha.net/recaptcha/enterprise/anchor?k=test',
      ),
    ).toBe(true);
    expect(
      isGreenhouseFrame(
        greenhouseSource,
        'https://attacker.example/recaptcha/enterprise/anchor',
      ),
    ).toBe(false);
    expect(
      isGreenhouseFrame(
        greenhouseSource,
        'https://www.google.com:8443/recaptcha/enterprise/anchor',
      ),
    ).toBe(false);
  });
  it('recovers old blocked inspection through a new inspection without clearing security outcomes', () => {
    const old = {
      id: 'inspection',
      applicationPlanId: 'plan',
      state: 'HUMAN_REQUIRED',
      errorCode: 'MUTATING_REQUEST_BLOCKED',
      result: null,
    };
    expect(canRepairGreenhouseInspection(old, 'GREENHOUSE')).toBe(true);
    expect(canRepairGreenhouseInspection(old, 'ASHBY')).toBe(false);
    expect(
      canRepairGreenhouseInspection(
        { ...old, errorCode: 'UNSAFE_DESTINATION' },
        'GREENHOUSE',
      ),
    ).toBe(false);
  });
  it('rejects unapproved values, extra applicant data, and mismatched verification identity', () => {
    const expected = { email: 'ada@example.com' };
    const validate = (input: unknown) =>
      validateGreenhousePayload(
        Buffer.from(JSON.stringify(input)),
        'application/json',
        expected,
        'fingerprint',
      );
    expect(
      validate({
        job_application: expected,
        fingerprint: 'fingerprint',
        'g-recaptcha-enterprise-token': 'token',
      }),
    ).toBeTruthy();
    expect(() =>
      validate({
        job_application: { email: 'other@example.com' },
        fingerprint: 'fingerprint',
      }),
    ).toThrow();
    expect(() =>
      validate({
        job_application: { ...expected, private_note: 'unapproved' },
        fingerprint: 'fingerprint',
      }),
    ).toThrow();
    expect(() =>
      validate({ job_application: expected, fingerprint: 'different' }),
    ).toThrow();
  });
  it('inspects dropdown options and required resume without clicking or submitting', async () => {
    const f = await greenhouseFixture();
    try {
      const inspector = new ApplicationInspector(
        new BrowserSessionManager(true, new DestinationPolicy(f.origin), true),
        new Map([[f.input.plan.destination.url!, greenhouseSource]]),
      );
      const outcome = await inspector.inspect(
        f.input.plan,
        'plan',
        'inspection',
      );
      expect(outcome.status, JSON.stringify(outcome)).toBe('COMPLETED');
      expect(outcome.schema?.documents).toEqual([
        expect.objectContaining({
          type: 'RESUME',
          required: true,
          label: 'Resume/CV',
        }),
      ]);
      expect(
        outcome.schema?.fields.find((f) => f.domId === 'question_1')?.options,
      ).toEqual(['Yes', 'No']);
      expect(outcome.schema?.fields.some((f) => !f.domId && f.required)).toBe(
        false,
      );
      expect(f.calls).toHaveLength(0);
    } finally {
      await f.close();
    }
  }, 30000);
  it.each([
    'accepted',
    'rejected',
    'dropped',
    'changed-form',
    'unapproved-answer',
    'dispatch-revoked',
    'closed-session',
    'dry-run',
  ])(
    'handles %s with one authorized dispatch and no replay',
    async (scenario) => {
      const f = await greenhouseFixture({
        changed: scenario === 'changed-form',
        malicious: scenario === 'unapproved-answer',
        drop: scenario === 'dropped',
        reject: scenario === 'rejected',
      });
      let session: BrowserSession | undefined;
      const executor = new BrowserApplicationExecutor({
        documents: f.storage,
        fixtureOrigin: f.origin,
        greenhouseBrowserAssisted: true,
        assistedHeadless: true,
        assistedSessions: (policy) => ({
          create: async (...args) => {
            session = await new BrowserSessionManager(
              true,
              policy,
              true,
            ).create(...args);
            return session;
          },
        }),
      });
      const observer = {
        persist: async () => {},
        authorizeDispatch: async () => {},
      };
      try {
        if (scenario === 'dry-run') f.input.mode = 'DRY_RUN';
        const first = await executor.execute(f.input, observer);
        if (scenario === 'changed-form') {
          expect(first.error).toBe('GREENHOUSE_FORM_CHANGED');
          expect(f.calls).toHaveLength(0);
          return;
        }
        if (scenario === 'dry-run') {
          expect(first.status, JSON.stringify(first)).toBe('DRY_RUN_COMPLETED');
          expect(f.calls).toHaveLength(0);
          return;
        }
        expect(first.status, JSON.stringify(first)).toBe(
          'PAUSED_HUMAN_REQUIRED',
        );
        expect(await session!.page.locator('#country').inputValue()).toBe(
          'India +91',
        );
        expect(f.calls.filter((c) => c.path.endsWith('/submit'))).toHaveLength(
          0,
        );
        if (scenario === 'closed-session') {
          await session!.close();
          const reopened = await executor.execute(
            { ...f.input, previousResult: first },
            observer,
          );
          expect(reopened.status, JSON.stringify(reopened)).toBe(
            'PAUSED_HUMAN_REQUIRED',
          );
          expect(reopened.error).toBe('GREENHOUSE_SESSION_REOPENED');
          return;
        }
        await session!.page.locator('#submit').click();
        if (scenario !== 'unapproved-answer')
          await session!.page.waitForFunction(
            () => document.body.dataset.captured === 'true',
          );
        else await session!.page.waitForTimeout(100);
        const nextObserver = {
          ...observer,
          authorizeDispatch: async () => {
            if (scenario === 'dispatch-revoked')
              throw new Error('Lease revoked');
          },
        };
        const result = await executor.execute(
          { ...f.input, previousResult: first },
          nextObserver,
        );
        const submits = f.calls.filter((c) => c.path.endsWith('/submit'));
        if (['dispatch-revoked', 'unapproved-answer'].includes(scenario)) {
          expect(result.status, JSON.stringify(result)).toBe('BLOCKED');
          expect(submits).toHaveLength(0);
        } else {
          expect(result.status, JSON.stringify(result)).toBe(
            'SUBMISSION_UNKNOWN',
          );
          expect(submits).toHaveLength(1);
          expect(result.checkpoint?.resumable).toBe(false);
        }
        const replay = await executor.execute(f.input, observer);
        expect(replay.status).toBe(result.status);
        expect(f.calls.filter((c) => c.path.endsWith('/submit'))).toHaveLength(
          submits.length,
        );
        expect(
          greenhouseSubmissionBlocker(
            f.input.inspection.greenhouseSubmission!,
            true,
          ),
        ).toBeNull();
      } finally {
        await executor.close();
        await f.close();
      }
    },
    30000,
  );
});
