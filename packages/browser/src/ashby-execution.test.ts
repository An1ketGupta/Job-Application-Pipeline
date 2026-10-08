import { describe, expect, it, vi } from 'vitest';
import {
  reconcileEvidence,
  canTransitionExecution,
  type ExecutionState,
  type ExecutionResult,
  type VerificationContext,
} from '@careerlift/domain';
import { BrowserApplicationExecutor } from './executor.js';
import { AshbySubmissionVerifier } from './verifier.js';
import { ashbyFixture } from './test-support/ashby-fixture.js';
import { BrowserSessionManager, type BrowserSession } from './session.js';
import { ASHBY_QUERIES } from './ashby-form.js';
import { ashbyNativeMutation } from './ashby-assisted.js';
import { inspectSecurityControls } from './security-controls.js';
import type { CDPSession, Page } from 'playwright';

describe('Ashby submission adapter', () => {
  it('allows only the expected Google challenge frames and still detects employer authentication controls', async () => {
    const iframe = {
      backendNodeId: 2,
      nodeName: 'IFRAME',
      nodeValue: '',
      attributes: ['src', 'https://www.google.com/recaptcha/api2/anchor'],
    };
    const root = {
      backendNodeId: 1,
      nodeName: '#document',
      nodeValue: '',
      children: [iframe],
    };
    const cdp = { send: async () => ({ root }) } as unknown as CDPSession;
    const page = {} as Page;
    expect((await inspectSecurityControls(page, cdp)).complete).toBe(false);
    expect(
      (await inspectSecurityControls(page, cdp, { allowRecaptchaFrames: true }))
        .complete,
    ).toBe(true);
    iframe.attributes[1] = 'https://attacker.example/recaptcha/api2/anchor';
    expect(
      (await inspectSecurityControls(page, cdp, { allowRecaptchaFrames: true }))
        .complete,
    ).toBe(false);
    iframe.attributes[1] = 'https://www.google.com:8443/recaptcha/api2/anchor';
    expect(
      (await inspectSecurityControls(page, cdp, { allowRecaptchaFrames: true }))
        .complete,
    ).toBe(false);
    iframe.attributes[1] = 'https://www.google.com/recaptcha/api2/anchor';
    root.children.push({
      backendNodeId: 3,
      nodeName: 'INPUT',
      nodeValue: '',
      attributes: ['type', 'password'],
    });
    expect(
      (await inspectSecurityControls(page, cdp, { allowRecaptchaFrames: true }))
        .authentication,
    ).toBe(true);
  });
  it.each([
    'accepted',
    'rejected',
    'dropped',
    'session-closed',
    'expired-token',
    'changed-input',
    'prefilled',
    'unapproved-answer',
    'dispatch-revoked',
  ])(
    'assists a CAPTCHA-enabled native form and handles %s without replay',
    async (scenario) => {
      const f = await ashbyFixture({
        native: true,
        prefilled: scenario === 'prefilled',
      });
      f.setCaptcha(true);
      f.input.inspection.ashbySubmission!.requiresCaptcha = true;
      if (scenario === 'rejected') f.setOutcome('FormRender');
      if (scenario === 'dropped') f.setDrop();
      let session: BrowserSession | undefined;
      const executor = new BrowserApplicationExecutor({
        documents: f.storage,
        fixtureOrigin: f.origin,
        ashbyBrowserAssisted: true,
        assistedSessions: (policy) => {
          const manager = new BrowserSessionManager(true, policy, true);
          return {
            create: async (...args) => {
              session = await manager.create(...args);
              return session;
            },
          };
        },
      });
      const progress: ExecutionResult[] = [];
      let state: ExecutionState = 'PREPARING';
      let revoked = false;
      const observer = {
        persist: async (result: ExecutionResult) => {
          expect(
            state === result.status ||
              canTransitionExecution(state, result.status),
            `${state} -> ${result.status}`,
          ).toBe(true);
          state = result.status;
          progress.push(structuredClone(result));
        },
        authorizeDispatch: async () => {
          if (revoked) throw new Error('Dispatch lease revoked');
        },
      };
      const finals = () =>
        f.calls.filter(
          (c) => c.operation === 'ApiSubmitSingleApplicationFormAction',
        );
      try {
        let paused = await executor.execute(f.input, observer);
        expect(paused.status, JSON.stringify(paused)).toBe(
          'PAUSED_HUMAN_REQUIRED',
        );
        expect(f.values).toEqual({ name: 'Ada', email: 'ada@example.com' });
        expect(await session!.page.locator('#name').inputValue()).toBe('Ada');
        expect(
          await session!.page
            .locator('#resume')
            .evaluate((node: HTMLInputElement) => node.files?.[0]?.name),
        ).toBe('resume.pdf');
        expect(finals()).toHaveLength(0);
        // Continuing before human verification sends nothing and retains the browser.
        state = 'PREPARING';
        paused = await executor.execute(
          { ...f.input, previousResult: paused },
          observer,
        );
        expect(paused.status).toBe('PAUSED_HUMAN_REQUIRED');
        expect(finals()).toHaveLength(0);
        if (scenario === 'session-closed') {
          await session!.close();
          state = 'PREPARING';
          paused = await executor.execute(
            { ...f.input, previousResult: paused },
            observer,
          );
          expect(paused.status, JSON.stringify(paused)).toBe(
            'PAUSED_HUMAN_REQUIRED',
          );
          expect(paused.error).toBe('ASHBY_SESSION_REOPENED');
          expect(finals()).toHaveLength(0);
        }
        if (scenario === 'changed-input') {
          const changed = structuredClone(f.input);
          changed.preparedApplication.fields[0]!.value = 'Changed';
          await expect(
            executor.execute({ ...changed, previousResult: paused }, observer),
          ).rejects.toThrow('Prepared application changed');
          expect(finals()).toHaveLength(0);
          return;
        }
        if (scenario === 'unapproved-answer') {
          await session!.page.locator('#name').fill('Unapproved');
          await Promise.all([
            session!.page.waitForEvent('requestfailed', {
              predicate: (request) => request.url().includes('ApiSetFormValue'),
            }),
            session!.page.locator('#name').blur(),
          ]);
          state = 'PREPARING';
          const blocked = await executor.execute(
            { ...f.input, previousResult: paused },
            observer,
          );
          expect(blocked.status).toBe('BLOCKED');
          expect(finals()).toHaveLength(0);
          expect(f.values.name).toBe('Ada');
          return;
        }
        await session!.page.locator('#fixture-human-step').click();
        await session!.page
          .getByRole('button', { name: 'Submit Application', exact: true })
          .click();
        await session!.page.locator('#native-submit-result').waitFor();
        expect(finals()).toHaveLength(0); // Native click only hands verification back to CareerLift.
        if (scenario === 'expired-token') {
          const now = Date.now;
          vi.spyOn(Date, 'now').mockImplementation(() => now() + 91000);
          state = 'PREPARING';
          paused = await executor.execute(
            { ...f.input, previousResult: paused },
            observer,
          );
          vi.restoreAllMocks();
          expect(paused.status).toBe('PAUSED_HUMAN_REQUIRED');
          expect(finals()).toHaveLength(0);
          return;
        }
        state = 'PREPARING';
        revoked = scenario === 'dispatch-revoked';
        const finished = await executor.execute(
          { ...f.input, previousResult: paused },
          observer,
        );
        expect(finished.status, JSON.stringify(finished)).toBe(
          'SUBMISSION_UNKNOWN',
        );
        if (scenario === 'dispatch-revoked') {
          expect(finals()).toHaveLength(0);
          expect(
            finished.mutations!.find((m) => m.action === 'FINAL_SUBMIT')
              ?.outcome,
          ).toBe('REJECTED');
          expect(finished.checkpoint?.resumable).toBe(false);
          return;
        }
        expect(finals()).toHaveLength(1);
        expect(finals()[0]!.variables.recaptchaToken).toBe(
          'fixture-human-token',
        );
        expect(finals()[0]!.variables.deviceFingerprint).toBe(
          'fixture-browser-context',
        );
        const final = finished.mutations!.find(
          (m) => m.action === 'FINAL_SUBMIT',
        )!;
        expect(final.outcome).toBe(
          scenario === 'dropped' ? 'UNKNOWN' : 'FORWARDED',
        );
        if (scenario !== 'dropped')
          expect(final.providerOutcome).toBe(
            scenario === 'rejected' ? 'REJECTED' : 'CONFIRMED',
          );
        expect(JSON.stringify(progress)).not.toContain('fixture-human-token');
        expect(finished.checkpoint?.resumable).toBe(false);
        // A repeated continuation cannot dispatch again.
        state = 'PREPARING';
        await executor.execute(
          { ...f.input, previousResult: finished },
          observer,
        );
        expect(finals()).toHaveLength(1);
      } finally {
        vi.restoreAllMocks();
        await executor.close();
        await f.close();
      }
    },
    45000,
  );
  it('rejects a mutation hidden behind a valid operation name', () => {
    const variables = {
      organizationHostedJobsPageName: 'fixture',
      formRenderIdentifier: 'render',
      path: 'name',
      value: 'Ada',
      formDefinitionIdentifier: 'definition',
    };
    expect(
      ashbyNativeMutation(
        Buffer.from(
          JSON.stringify({
            operationName: 'ApiSetFormValue',
            query: ASHBY_QUERIES.setValue,
            variables,
          }),
        ),
        'application/json',
      ).root,
    ).toBe('setFormValue');
    expect(() =>
      ashbyNativeMutation(
        Buffer.from(
          JSON.stringify({
            operationName: 'ApiSetFormValue',
            query: ASHBY_QUERIES.setValue.replace(
              '{id formErrors',
              ' @skip(if:true){id formErrors',
            ),
            variables,
          }),
        ),
        'application/json',
      ),
    ).toThrow('Mutation identity is not approved');
  });
  it.each(['FormSubmitSuccess', 'FormRender'])(
    'saves answers, uploads approved bytes, submits once and verifies %s',
    async (outcome) => {
      const f = await ashbyFixture();
      f.setOutcome(outcome);
      const executor = new BrowserApplicationExecutor({
        documents: f.storage,
        fixtureOrigin: f.origin,
      });
      const progress: ExecutionResult[] = [];
      const authorizeDispatch = vi.fn(async () => {});
      try {
        const result = await executor.execute(f.input, {
          persist: async (r) => {
            progress.push(structuredClone(r));
          },
          authorizeDispatch,
        });
        expect(result.status, JSON.stringify(result)).toBe(
          'SUBMISSION_UNKNOWN',
        );
        expect(f.values).toEqual({ name: 'Ada', email: 'ada@example.com' });
        expect(
          f.calls.find((c) => c.operation === 'Upload')!.body.toString(),
        ).toContain('%PDF-1.7');
        expect(
          f.calls.filter(
            (c) => c.operation === 'ApiSubmitSingleApplicationFormAction',
          ),
        ).toHaveLength(1);
        const final = result.mutations!.find(
          (m) => m.action === 'FINAL_SUBMIT',
        )!;
        expect(final.outcome).toBe('FORWARDED');
        expect(final.providerOutcome).toBe(
          outcome === 'FormSubmitSuccess' ? 'CONFIRMED' : 'REJECTED',
        );
        expect(
          progress
            .find((r) => r.status === 'SUBMITTING')!
            .mutations?.some((m) => m.action === 'FINAL_SUBMIT'),
        ).toBeFalsy();
        expect(authorizeDispatch).toHaveBeenCalledTimes(f.calls.length);
        expect(JSON.stringify(result)).not.toContain('ada@example.com');
        expect(JSON.stringify(result)).not.toContain('%PDF');
        const context: VerificationContext = {
          userId: 'owner',
          applicationId: 'application',
          executionId: 'execution',
          jobId: 'job',
          company: 'Fixture',
          jobTitle: 'Engineer',
          platform: 'ASHBY',
          mode: 'TEST_FIXTURE',
          destination: final.destination,
          mutationId: final.mutationId,
          stepId: final.stepId,
          requestFingerprint: final.requestDigest,
          documentDigests: final.documentDigests,
          submissionStartedAt: final.startedAt,
          mutationOutcome: final.outcome,
          responseStatus: final.responseStatus!,
          responseFingerprint: final.responseFingerprint!,
          responseReceivedAt: final.responseReceivedAt!,
          providerOutcome: final.providerOutcome!,
        };
        const verification = await new AshbySubmissionVerifier().verify(
          context,
          new AbortController().signal,
        );
        expect(reconcileEvidence(context, verification.evidence).state).toBe(
          final.providerOutcome,
        );
        expect(() =>
          reconcileEvidence(
            { ...context, responseFingerprint: '0'.repeat(64) },
            verification.evidence,
          ),
        ).toThrow('UNSUPPORTED_STRONG_EVIDENCE');
        const generic = await new AshbySubmissionVerifier().verify(
          { ...context, providerOutcome: undefined },
          new AbortController().signal,
        );
        expect(reconcileEvidence(context, generic.evidence).state).toBe(
          'HUMAN_REQUIRED',
        );
      } finally {
        await executor.close();
        await f.close();
      }
    },
    30000,
  );
  it.each([
    'dry-run',
    'captcha',
    'changed-form',
    'dispatch-revoked',
    'dropped-response',
  ])(
    'handles %s without duplicate submission',
    async (scenario) => {
      const f = await ashbyFixture();
      const executor = new BrowserApplicationExecutor({
        documents: f.storage,
        fixtureOrigin: f.origin,
      });
      if (scenario === 'dry-run') f.input.mode = 'DRY_RUN';
      if (scenario === 'captcha') {
        f.input.inspection.ashbySubmission!.requiresCaptcha = true;
        f.setCaptcha(true);
      }
      if (scenario === 'changed-form') f.setChanged();
      if (scenario === 'dropped-response') f.setDrop();
      try {
        const result = await executor.execute(f.input, {
          persist: async () => {},
          authorizeDispatch: async () => {
            if (scenario === 'dispatch-revoked')
              throw new Error('Lease revoked');
          },
        });
        const finals = f.calls.filter(
          (c) => c.operation === 'ApiSubmitSingleApplicationFormAction',
        );
        if (scenario === 'dropped-response') {
          expect(result.status).toBe('SUBMISSION_UNKNOWN');
          expect(finals).toHaveLength(1);
        } else if (scenario === 'dry-run') {
          expect(result.status, JSON.stringify(result)).toBe(
            'DRY_RUN_COMPLETED',
          );
          expect(f.calls).toHaveLength(0);
        } else {
          expect(result.status, JSON.stringify(result)).toBe('BLOCKED');
          expect(f.calls).toHaveLength(0);
        }
      } finally {
        await executor.close();
        await f.close();
      }
    },
    30000,
  );
});
