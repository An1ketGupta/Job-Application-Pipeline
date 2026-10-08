import { describe, expect, it } from 'vitest';
import { canTransitionExecution, ExecutionResultSchema } from './execution.js';

describe('execution boundaries', () => {
  it('guards terminal states and the one-way submission barrier', () => {
    for (const terminal of [
      'SUBMITTED',
      'SUBMISSION_UNKNOWN',
      'DRY_RUN_COMPLETED',
      'FAILED',
      'BLOCKED',
    ] as const)
      for (const target of ['PENDING', 'RUNNING', 'SUBMITTING'] as const)
        expect(canTransitionExecution(terminal, target)).toBe(false);
    expect(canTransitionExecution('SUBMITTING', 'RUNNING')).toBe(false);
    expect(canTransitionExecution('SUBMITTING', 'SUBMISSION_UNKNOWN')).toBe(
      true,
    );
    expect(canTransitionExecution('PAUSED_HUMAN_REQUIRED', 'PENDING')).toBe(
      true,
    );
  });
  it('refuses a successful click as submission evidence', () => {
    const result = {
      applicationId: 'app',
      executionId: 'exec',
      mode: 'REAL_EXECUTION',
      status: 'SUBMITTED',
      startedAt: new Date().toISOString(),
      steps: [],
      humanReviewItems: [],
      metadata: { platform: 'GENERIC_PORTAL', durationMs: 1 },
    };
    expect(ExecutionResultSchema.safeParse(result).success).toBe(false);
    expect(
      ExecutionResultSchema.safeParse({ ...result, status: 'SUBMITTING' })
        .success,
    ).toBe(true);
    expect(
      ExecutionResultSchema.safeParse({
        ...result,
        status: 'SUBMISSION_UNKNOWN',
        checkpoint: {
          sessionId: 'session',
          pageIndex: 0,
          nextFieldIndex: 0,
          appliedFieldIds: [],
          resumable: true,
          unsafeActionStarted: true,
        },
      }).success,
    ).toBe(false);
  });
});
