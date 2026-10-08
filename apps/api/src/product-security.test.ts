import { describe, expect, it } from 'vitest';
import type { PrismaClient } from '@careerlift/database';
import { createApp } from './app.js';
import { createToken } from './auth.js';
import { publicUrl, publicJobApplication } from './public-views.js';
import { safePreparation } from './safe-stage-views.js';

describe('Phase 10 public response boundaries', () => {
  it('removes arbitrary URL query credentials and rejects unsafe destinations', () => {
    expect(
      publicUrl('https://example.com/apply?token=PRIVATE_SENTINEL#secret'),
    ).toBe('https://example.com/apply');
    expect(
      publicUrl(
        'https://job-boards.greenhouse.io/embed/job_app?for=acme&token=123&auth=PRIVATE_SENTINEL',
      ),
    ).toBe('https://job-boards.greenhouse.io/embed/job_app?for=acme&token=123');
    for (const url of [
      'https://user:password@example.com',
      'javascript:alert(1)',
      'file:///private',
      'http://example.com',
    ])
      expect(publicUrl(url)).toBeNull();
    expect(
      publicJobApplication({
        type: 'EXTERNAL_ATS',
        url: 'https://example.com?cookie=PRIVATE_SENTINEL',
        cookies: 'PRIVATE_SENTINEL',
        sessionId: 'PRIVATE_SENTINEL',
      }),
    ).toEqual({ type: 'EXTERNAL_ATS', url: 'https://example.com/' });
  });
  it('projects preparation counts without document paths or execution inputs', () => {
    const result = safePreparation({
      version: 1,
      applicationId: 'app',
      inspectionId: 'inspection',
      jobId: 'job',
      fields: [],
      questions: [],
      documents: [
        {
          requirementId: 'resume',
          documentType: 'RESUME',
          documentId: 'owned',
          selectionReason: 'PRIVATE_SENTINEL',
          confidence: 1,
          requiresHumanReview: false,
        },
      ],
      humanReviewItems: [],
      overallStatus: 'COMPLETED',
      overallConfidence: 1,
      preparedAt: new Date().toISOString(),
    });
    expect(result).not.toBeNull();
    expect(JSON.stringify(result)).not.toContain('PRIVATE_SENTINEL');
    expect(result?.documents).toEqual([{ type: 'RESUME', selected: true }]);
  });
  it('never sends database exceptions or local paths in default API errors', async () => {
    const db = {
      job: {
        findUnique: async () => {
          throw new Error(
            'Prisma C:\\private\\documents token=PRIVATE_SENTINEL',
          );
        },
      },
    } as unknown as PrismaClient;
    const app = createApp({ db, authSecret: 'local-test' });
    try {
      const response = await app.inject({
        url: '/api/v1/jobs/job',
        headers: {
          authorization: `Bearer ${createToken('owner', 'local-test')}`,
        },
      });
      expect(response.statusCode).toBe(503);
      expect(response.json().error).toBe('SERVICE_UNAVAILABLE');
      for (const value of ['Prisma', 'PRIVATE_SENTINEL', 'private', 'stack'])
        expect(response.body).not.toContain(value);
    } finally {
      await app.close();
    }
  });
  it('rejects malformed login instead of silently authenticating a demo identity', async () => {
    const app = createApp({ db: {} as PrismaClient });
    try {
      for (const payload of [
        { email: 'invalid' },
        { email: 'alice@example.com', userId: 'other' },
      ]) {
        const response = await app.inject({
          method: 'POST',
          url: '/api/v1/auth/login',
          payload,
        });
        expect(response.statusCode).toBe(400);
        expect(response.body).not.toContain('token');
      }
    } finally {
      await app.close();
    }
  });
});
