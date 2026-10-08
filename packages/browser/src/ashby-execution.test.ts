import { describe, expect, it, vi } from 'vitest';
import {
  reconcileEvidence,
  type ExecutionResult,
  type VerificationContext,
} from '@careerlift/domain';
import { BrowserApplicationExecutor } from './executor.js';
import { AshbySubmissionVerifier } from './verifier.js';
import { ashbyFixture } from './test-support/ashby-fixture.js';

describe('Ashby submission adapter', () => {
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
