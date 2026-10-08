import { describe, expect, it } from 'vitest';
import { candidateSchema } from '../../../tests/support/candidate-fixture.js';
import {
  safeInspection,
  safeExecution,
  safeVerification,
  executionBlocker,
} from './safe-stage-views.js';
describe('Phase 8 safe stage projections', () => {
  it('exposes candidate requirements without raw inspection URLs, selectors, hidden-field digests or excerpts', () => {
    const schema = candidateSchema();
    schema.fields[0]!.selector = '#SECRET_SELECTOR';
    schema.inspectionMetadata.visibleTextExcerpt = 'SECRET_CDP_DATA';
    schema.finalUrl = 'https://example.com/apply?token=SECRET_TOKEN';
    schema.forms = [
      {
        id: 'form',
        method: 'POST',
        fieldIds: [],
        submitControls: [],
        hiddenFields: [{ name: 'csrf', valueDigest: 'a'.repeat(64) }],
      },
    ];
    const view = JSON.stringify(safeInspection(schema));
    for (const secret of [
      'SECRET_SELECTOR',
      'SECRET_CDP_DATA',
      'SECRET_TOKEN',
      'hiddenFields',
      'executionFlow',
      'inspectionMetadata',
    ])
      expect(view).not.toContain(secret);
    expect(view).toContain('Will you require sponsorship?');
    expect(safeInspection({ invalid: true })).toBeNull();
  });
  it('projects paused execution reasons without checkpoint, session, DOM or security identities', () => {
    const result = {
      applicationId: 'app',
      executionId: 'execution',
      mode: 'DRY_RUN',
      status: 'PAUSED_HUMAN_REQUIRED',
      startedAt: new Date().toISOString(),
      steps: [],
      humanReviewItems: [
        {
          reason: 'CAPTCHA',
          targetRef: 'SECRET_TARGET',
          stepId: 'SECRET_STEP',
          safeContinuationPoint: 'SECRET_POINT',
        },
      ],
      checkpoint: {
        sessionId: 'SECRET_SESSION',
        pageIndex: 0,
        nextFieldIndex: 0,
        appliedFieldIds: [],
        unsafeActionStarted: false,
        resumable: true,
      },
      metadata: { platform: 'GENERIC', durationMs: 1 },
    };
    const view = safeExecution(result);
    expect(view?.canResume).toBe(true);
    expect(JSON.stringify(view)).not.toContain('SECRET');
    expect(view).not.toHaveProperty('checkpoint');
    expect(executionBlocker(result).type).toBe('CAPTCHA');
    expect(
      safeExecution({
        ...result,
        checkpoint: { ...result.checkpoint, unsafeActionStarted: true },
      })?.canResume,
    ).toBe(false);
    expect(safeExecution({ invalid: true })).toBeNull();
  });
  it('omits verification contexts, evidence payloads, lease/run IDs, and security generations', () => {
    const record = {
      id: 'verification',
      state: 'HUMAN_REQUIRED',
      establishedState: null,
      createdAt: new Date(),
      updatedAt: new Date(),
      context: { dispatchIdentity: 'SECRET_CONTEXT' },
      evidence: [{ data: 'SECRET_EVIDENCE' }],
      runId: 'SECRET_RUN',
      generation: 2,
    };
    const view = safeVerification(record);
    expect(view.state).toBe('HUMAN_REQUIRED');
    for (const key of [
      'context',
      'evidence',
      'generation',
      'runId',
      'leaseUntil',
    ])
      expect(view).not.toHaveProperty(key);
    expect(JSON.stringify(view)).not.toContain('SECRET');
  });
});
