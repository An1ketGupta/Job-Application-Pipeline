import { z } from 'zod';

export const VerificationStateSchema = z.enum([
  'NOT_REQUIRED',
  'PENDING',
  'VERIFYING',
  'CONFIRMED',
  'REJECTED',
  'UNKNOWN',
  'HUMAN_REQUIRED',
  'FAILED',
]);
export type VerificationState = z.infer<typeof VerificationStateSchema>;
const transitions: Record<VerificationState, readonly VerificationState[]> = {
  NOT_REQUIRED: [],
  PENDING: ['VERIFYING'],
  VERIFYING: ['CONFIRMED', 'REJECTED', 'UNKNOWN', 'FAILED', 'PENDING'],
  UNKNOWN: ['HUMAN_REQUIRED'],
  HUMAN_REQUIRED: ['PENDING', 'CONFIRMED', 'REJECTED'],
  FAILED: ['PENDING', 'HUMAN_REQUIRED'],
  CONFIRMED: ['PENDING'],
  REJECTED: ['PENDING'],
};
export function assertVerificationTransition(
  from: VerificationState,
  to: VerificationState,
) {
  if (!transitions[from].includes(to))
    throw new Error('INVALID_VERIFICATION_TRANSITION');
}
export const EvidenceTypeSchema = z.enum([
  'HTTP_SUCCESS',
  'HTTP_RESPONSE',
  'HTTP_REDIRECT',
  'CONFIRMATION_PAGE',
  'CONFIRMATION_IDENTIFIER',
  'RECEIPT',
  'APPLICATION_ID',
  'STATUS_PAGE',
  'USER_CONFIRMED',
  'USER_CONFIRMED_REJECTED',
  'EXTERNAL_LOOKUP',
]);
export const EvidenceStrengthSchema = z.enum([
  'STRONG',
  'MEDIUM',
  'WEAK',
  'NONE',
]);
const id = z.string().min(1).max(200);
const fingerprint = z.string().regex(/^[a-f0-9]{64}$/);
export const VerificationContextSchema = z
  .object({
    userId: id,
    executionId: id,
    applicationId: id,
    jobId: id,
    company: z.string().max(500),
    jobTitle: z.string().max(500),
    platform: id,
    mode: z.enum(['TEST_FIXTURE', 'REAL_EXECUTION']),
    destination: z.string().url(),
    mutationId: id,
    stepId: id,
    requestFingerprint: fingerprint,
    documentDigests: z.array(fingerprint),
    submissionStartedAt: z.string().datetime(),
    mutationOutcome: z.enum([
      'AUTHORIZED',
      'DISPATCHING',
      'FORWARDED',
      'UNKNOWN',
      'REJECTED',
    ]),
    responseReceivedAt: z.string().datetime().optional(),
    responseStatus: z.number().int().min(100).max(599).optional(),
    responseFingerprint: fingerprint.optional(),
    providerOutcome: z.enum(['CONFIRMED', 'REJECTED']).optional(),
    // Legacy execution metadata only: always unverified, never acceptance proof.
    fixtureReceipt: z.enum(['CONFIRMED', 'REJECTED']).optional(),
  })
  .strict();
export type VerificationContext = z.infer<typeof VerificationContextSchema>;
export const VerificationEvidenceSchema = z
  .object({
    type: EvidenceTypeSchema,
    strength: EvidenceStrengthSchema,
    source: z.enum([
      'MUTATION_LEDGER',
      'LOCAL_FIXTURE',
      'GENERIC',
      'USER',
      'PROVIDER_RESPONSE',
    ]),
    capturedAt: z.string().datetime(),
    // Every observation, including weak evidence, carries the original identity.
    userId: id,
    executionId: id,
    applicationId: id,
    jobId: id,
    mutationId: id,
    requestFingerprint: fingerprint,
    submissionStartedAt: z.string().datetime(),
    pageUrl: z.string().url().optional(),
    httpStatus: z.number().int().min(100).max(599).optional(),
    responseFingerprint: fingerprint.optional(),
    confirmationFingerprint: fingerprint.optional(),
    externalApplicationId: z
      .string()
      .regex(/^[A-Za-z0-9_-]{1,200}$/)
      .optional(),
    receiptId: z
      .string()
      .regex(/^[A-Za-z0-9_-]{1,200}$/)
      .optional(),
    outcome: z.enum(['CONFIRMED', 'REJECTED', 'UNKNOWN']),
    evidenceOrigin: z.literal('SERVER_STATUS').optional(),
    serverIssuedAt: z.string().datetime().optional(),
    inspectionComplete: z.boolean().optional(),
    securityGeneration: z.number().int().nonnegative().optional(),
    verificationIssue: id.optional(),
  })
  .strict();
export type VerificationEvidence = z.infer<typeof VerificationEvidenceSchema>;
export function evidenceIdentity(context: VerificationContext) {
  const {
    userId,
    executionId,
    applicationId,
    jobId,
    mutationId,
    requestFingerprint,
    submissionStartedAt,
  } = context;
  return {
    userId,
    executionId,
    applicationId,
    jobId,
    mutationId,
    requestFingerprint,
    submissionStartedAt,
  };
}
export function assertEvidenceBinding(
  context: VerificationContext,
  evidence: VerificationEvidence,
) {
  for (const [key, value] of Object.entries(evidenceIdentity(context)))
    if (evidence[key as keyof VerificationEvidence] !== value)
      throw new Error('VERIFICATION_IDENTITY_MISMATCH');
  if (Date.parse(evidence.capturedAt) < Date.parse(context.submissionStartedAt))
    throw new Error('STALE_VERIFICATION_EVIDENCE');
  if (
    evidence.pageUrl &&
    new URL(evidence.pageUrl).origin !== new URL(context.destination).origin
  )
    throw new Error('VERIFICATION_DESTINATION_MISMATCH');
  if (
    evidence.strength === 'STRONG' &&
    !(
      (evidence.source === 'LOCAL_FIXTURE' &&
        context.mode === 'TEST_FIXTURE' &&
        evidence.type === 'STATUS_PAGE') ||
      (evidence.source === 'USER' &&
        ['USER_CONFIRMED', 'USER_CONFIRMED_REJECTED'].includes(
          evidence.type,
        )) ||
      (evidence.source === 'PROVIDER_RESPONSE' &&
        context.platform === 'ASHBY' &&
        evidence.type === 'HTTP_RESPONSE' &&
        context.mutationOutcome === 'FORWARDED' &&
        context.responseStatus === 200 &&
        !!context.responseFingerprint &&
        evidence.responseFingerprint === context.responseFingerprint &&
        evidence.httpStatus === 200 &&
        !!context.providerOutcome &&
        evidence.outcome === context.providerOutcome)
    )
  )
    throw new Error('UNSUPPORTED_STRONG_EVIDENCE');
  if (evidence.strength === 'STRONG' && evidence.source === 'LOCAL_FIXTURE') {
    const statusTarget = `${new URL(context.destination).origin}/careerlift/status/${encodeURIComponent(context.mutationId)}`;
    if (
      !evidence.receiptId ||
      evidence.receiptId === context.mutationId ||
      evidence.receiptId === `receipt-${context.mutationId}` ||
      evidence.evidenceOrigin !== 'SERVER_STATUS' ||
      !evidence.serverIssuedAt ||
      Date.parse(evidence.serverIssuedAt) <
        Date.parse(context.submissionStartedAt) ||
      Date.parse(evidence.serverIssuedAt) > Date.parse(evidence.capturedAt) ||
      evidence.inspectionComplete !== true ||
      evidence.securityGeneration === undefined ||
      evidence.verificationIssue !== undefined ||
      evidence.httpStatus !== 200 ||
      !evidence.confirmationFingerprint ||
      evidence.pageUrl !== statusTarget
    )
      throw new Error('UNBOUND_CONFIRMATION_IDENTIFIER');
  }
  if (
    evidence.source === 'USER' &&
    evidence.strength === 'STRONG' &&
    evidence.outcome !==
      (evidence.type === 'USER_CONFIRMED' ? 'CONFIRMED' : 'REJECTED')
  )
    throw new Error('HUMAN_EVIDENCE_OUTCOME_MISMATCH');
}
export function reconcileEvidence(
  context: VerificationContext,
  evidence: VerificationEvidence[],
) {
  const outcomes = new Set<string>();
  const statusOutcomes = new Set<string>();
  for (const raw of evidence) {
    const item = VerificationEvidenceSchema.parse(raw);
    assertEvidenceBinding(context, item);
    if (item.strength === 'STRONG' && item.outcome !== 'UNKNOWN')
      outcomes.add(item.outcome);
    if (
      item.source === 'LOCAL_FIXTURE' &&
      item.type === 'STATUS_PAGE' &&
      item.evidenceOrigin === 'SERVER_STATUS' &&
      item.outcome !== 'UNKNOWN'
    )
      statusOutcomes.add(item.outcome);
  }
  if (
    outcomes.size > 1 ||
    statusOutcomes.size > 1 ||
    (outcomes.has('CONFIRMED') &&
      evidence.some(
        (item) =>
          item.source === 'LOCAL_FIXTURE' &&
          item.type === 'STATUS_PAGE' &&
          item.strength === 'MEDIUM' &&
          item.outcome === 'UNKNOWN',
      ))
  )
    return { state: 'HUMAN_REQUIRED' as const, reason: 'CONFLICTING_EVIDENCE' };
  // A later complete read can recover an earlier failed inspection. An unsafe
  // new observation must veto an older receipt retained across refreshes.
  const lastCompleteRead = Math.max(
    -Infinity,
    ...evidence
      .filter(
        (item) =>
          item.strength === 'STRONG' &&
          (item.source === 'USER' ||
            (item.source === 'LOCAL_FIXTURE' &&
              item.type === 'STATUS_PAGE' &&
              item.inspectionComplete === true)),
      )
      .map((item) => Date.parse(item.capturedAt)),
  );
  const issue = evidence.find(
    (item) =>
      item.verificationIssue && Date.parse(item.capturedAt) >= lastCompleteRead,
  )?.verificationIssue;
  if (issue) return { state: 'HUMAN_REQUIRED' as const, reason: issue };
  if (outcomes.has('CONFIRMED'))
    return { state: 'CONFIRMED' as const, reason: 'ACCEPTANCE_CONFIRMED' };
  if (outcomes.has('REJECTED'))
    return { state: 'REJECTED' as const, reason: 'REJECTION_CONFIRMED' };
  return {
    state: 'HUMAN_REQUIRED' as const,
    reason: 'SUBMISSION_OUTCOME_UNCERTAIN',
  };
}
export type VerificationResult = {
  evidence: VerificationEvidence[];
  reason: string;
  infrastructureFailure?: boolean;
};
export interface SubmissionVerifier {
  supports(context: VerificationContext): boolean;
  verify(
    context: VerificationContext,
    signal: AbortSignal,
  ): Promise<VerificationResult>;
}
