import { describe, expect, it } from 'vitest';
import {
  VerificationContextSchema,
  assertVerificationTransition,
  assertEvidenceBinding,
  evidenceIdentity,
  reconcileEvidence,
  type VerificationEvidence,
} from './verification.js';

const context = VerificationContextSchema.parse({
  userId: 'user-a',
  executionId: 'execution-a',
  applicationId: 'application-a',
  jobId: 'job-a',
  company: 'Example',
  jobTitle: 'Engineer',
  platform: 'GENERIC',
  mode: 'TEST_FIXTURE',
  destination: 'https://example.com/submit',
  mutationId: 'mutation-a',
  stepId: 'step-a',
  requestFingerprint: 'a'.repeat(64),
  documentDigests: ['b'.repeat(64)],
  submissionStartedAt: '2026-10-06T10:00:00.000Z',
  mutationOutcome: 'UNKNOWN',
});
const evidence = (
  outcome: VerificationEvidence['outcome'] = 'CONFIRMED',
): VerificationEvidence => ({
  ...evidenceIdentity(context),
  type: 'STATUS_PAGE',
  source: 'LOCAL_FIXTURE',
  strength: 'STRONG',
  capturedAt: '2026-10-06T10:01:00.000Z',
  outcome,
  receiptId: 'external-server-receipt-01',
  evidenceOrigin: 'SERVER_STATUS',
  serverIssuedAt: '2026-10-06T10:00:01.000Z',
  inspectionComplete: true,
  securityGeneration: 1,
  httpStatus: 200,
  pageUrl: `https://example.com/careerlift/status/${context.mutationId}`,
  confirmationFingerprint: 'c'.repeat(64),
});
describe('durable verification invariants', () => {
  it.each([
    ['PENDING', 'VERIFYING'],
    ['VERIFYING', 'CONFIRMED'],
    ['VERIFYING', 'REJECTED'],
    ['VERIFYING', 'UNKNOWN'],
    ['UNKNOWN', 'HUMAN_REQUIRED'],
    ['HUMAN_REQUIRED', 'CONFIRMED'],
    ['HUMAN_REQUIRED', 'REJECTED'],
    ['CONFIRMED', 'PENDING'],
  ] as const)('allows guarded %s → %s', (from, to) =>
    expect(() => assertVerificationTransition(from, to)).not.toThrow(),
  );
  it.each([
    ['CONFIRMED', 'UNKNOWN'],
    ['REJECTED', 'CONFIRMED'],
    ['PENDING', 'CONFIRMED'],
    ['NOT_REQUIRED', 'VERIFYING'],
  ] as const)('refuses %s → %s', (from, to) =>
    expect(() => assertVerificationTransition(from, to)).toThrow(
      'INVALID_VERIFICATION_TRANSITION',
    ),
  );
  it.each([
    'userId',
    'executionId',
    'applicationId',
    'jobId',
    'mutationId',
    'requestFingerprint',
    'submissionStartedAt',
  ] as const)('rejects evidence bound to another %s', (field) =>
    expect(() =>
      assertEvidenceBinding(context, { ...evidence(), [field]: 'wrong' }),
    ).toThrow('IDENTITY_MISMATCH'),
  );
  it('refuses stale evidence, unsafe origins and unsupported strong evidence', () => {
    expect(() =>
      assertEvidenceBinding(context, {
        ...evidence(),
        capturedAt: '2026-10-05T00:00:00.000Z',
      }),
    ).toThrow('STALE');
    expect(() =>
      assertEvidenceBinding(context, {
        ...evidence(),
        pageUrl: 'https://evil.example/status',
      }),
    ).toThrow('DESTINATION');
    expect(() =>
      assertEvidenceBinding(context, {
        ...evidence(),
        source: 'GENERIC',
        type: 'HTTP_SUCCESS',
      }),
    ).toThrow('UNSUPPORTED_STRONG');
    expect(() =>
      assertEvidenceBinding({ ...context, mode: 'REAL_EXECUTION' }, evidence()),
    ).toThrow('UNSUPPORTED_STRONG');
  });
  it('generic HTTP 200, redirects and text are never acceptance', () => {
    for (const type of [
      'HTTP_SUCCESS',
      'HTTP_REDIRECT',
      'CONFIRMATION_PAGE',
    ] as const)
      expect(
        reconcileEvidence(context, [
          {
            ...evidence(),
            type,
            strength: 'WEAK',
            source: 'GENERIC',
            httpStatus: 200,
          },
        ]).state,
      ).toBe('HUMAN_REQUIRED');
  });
  it('accepts explicit human confirmation/rejection as bound evidence', () => {
    expect(
      reconcileEvidence(context, [
        { ...evidence(), type: 'USER_CONFIRMED', source: 'USER' },
      ]).state,
    ).toBe('CONFIRMED');
    expect(
      reconcileEvidence(context, [
        {
          ...evidence('REJECTED'),
          type: 'USER_CONFIRMED_REJECTED',
          source: 'USER',
        },
      ]).state,
    ).toBe('REJECTED');
  });
  it('refuses missing or incorrect durable receipt identifiers and inconsistent human evidence', () => {
    expect(() =>
      assertEvidenceBinding(context, {
        ...evidence(),
        receiptId: `receipt-${context.mutationId}`,
      }),
    ).toThrow('UNBOUND_CONFIRMATION_IDENTIFIER');
    expect(() =>
      assertEvidenceBinding(context, { ...evidence(), type: 'RECEIPT' }),
    ).toThrow('UNSUPPORTED_STRONG_EVIDENCE');
    expect(() =>
      assertEvidenceBinding(context, {
        ...evidence('REJECTED'),
        source: 'USER',
        type: 'USER_CONFIRMED',
      }),
    ).toThrow('HUMAN_EVIDENCE_OUTCOME_MISMATCH');
  });
  it('preserves stronger evidence and escalates conflicts, including authoritative absence', () => {
    expect(
      reconcileEvidence(context, [
        evidence(),
        { ...evidence('UNKNOWN'), strength: 'WEAK' },
      ]).state,
    ).toBe('CONFIRMED');
    expect(
      reconcileEvidence(context, [evidence(), evidence('REJECTED')]),
    ).toEqual({ state: 'HUMAN_REQUIRED', reason: 'CONFLICTING_EVIDENCE' });
    expect(
      reconcileEvidence(context, [
        evidence(),
        { ...evidence('UNKNOWN'), strength: 'MEDIUM' },
      ]).reason,
    ).toBe('CONFLICTING_EVIDENCE');
    expect(
      reconcileEvidence(context, [
        { ...evidence('UNKNOWN'), strength: 'MEDIUM' },
      ]).state,
    ).toBe('HUMAN_REQUIRED');
  });
  it.each([
    'evidenceOrigin',
    'serverIssuedAt',
    'receiptId',
    'inspectionComplete',
    'securityGeneration',
    'httpStatus',
    'confirmationFingerprint',
    'pageUrl',
  ] as const)(
    'requires %s before storing strong server status evidence',
    (field) => {
      const item = evidence();
      delete item[field];
      expect(() => assertEvidenceBinding(context, item)).toThrow(
        'UNBOUND_CONFIRMATION_IDENTIFIER',
      );
    },
  );
  it('local execution receipt cannot be stored as strong even with a matching forwarded context', () => {
    expect(() =>
      reconcileEvidence(
        {
          ...context,
          mutationOutcome: 'FORWARDED',
          fixtureReceipt: 'CONFIRMED',
        },
        [
          {
            ...evidence(),
            type: 'RECEIPT',
            receiptId: context.mutationId,
          },
        ],
      ),
    ).toThrow('UNSUPPORTED_STRONG_EVIDENCE');
  });
  it('a failed new observation vetoes an old confirmation; a later complete read can recover', () => {
    const issue: VerificationEvidence = {
      ...evidenceIdentity(context),
      type: 'EXTERNAL_LOOKUP',
      strength: 'NONE',
      source: 'LOCAL_FIXTURE',
      outcome: 'UNKNOWN',
      capturedAt: '2026-10-06T10:02:00.000Z',
      verificationIssue: 'UNSAFE_DESTINATION',
    };
    expect(reconcileEvidence(context, [evidence(), issue]).state).toBe(
      'HUMAN_REQUIRED',
    );
    expect(
      reconcileEvidence(context, [
        issue,
        { ...evidence(), capturedAt: '2026-10-06T10:03:00.000Z' },
      ]).state,
    ).toBe('CONFIRMED');
    expect(
      reconcileEvidence(context, [
        evidence(),
        issue,
        {
          ...evidence(),
          strength: 'WEAK',
          capturedAt: '2026-10-06T10:04:00.000Z',
        },
      ]).state,
    ).toBe('HUMAN_REQUIRED');
  });
});
