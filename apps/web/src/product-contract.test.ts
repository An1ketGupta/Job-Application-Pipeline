import { afterEach, describe, expect, it, vi } from 'vitest';
import { request, ApiError } from './lib/api';
import { applicationHeadline } from './lib/application-presentation';
import type { ApplicationSummary } from './lib/types';
afterEach(() => vi.unstubAllGlobals());
describe('Phase 10 product contracts', () => {
  it('discards untrusted server error messages', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn().mockResolvedValue(
        new Response(
          JSON.stringify({
            error: 'UNEXPECTED_DB_ERROR',
            message: 'Prisma C:\\private token=PRIVATE_SENTINEL',
            stack: 'PRIVATE_SENTINEL',
          }),
          { status: 500 },
        ),
      ),
    );
    try {
      await request('/api/v1/jobs');
      throw new Error('Expected API failure');
    } catch (error) {
      expect(error).toBeInstanceOf(ApiError);
      expect((error as Error).message).not.toContain('PRIVATE_SENTINEL');
      expect((error as Error).message).toContain('temporarily unavailable');
    }
  });
  it('labels unknown submission before a generic review requirement', () => {
    expect(
      applicationHeadline({
        state: 'HUMAN_REQUIRED',
        humanReviewRequired: true,
        execution: {
          mode: 'TEST_FIXTURE',
          state: 'SUBMISSION_UNKNOWN',
          verification: { state: 'HUMAN_REQUIRED' },
        },
      } as ApplicationSummary),
    ).toBe('Submission outcome unknown');
  });
});
