import { describe, expect, it, vi } from 'vitest';
import { Prisma, type PrismaClient } from '@careerlift/database';
import type { Queue } from 'bullmq';
import { createApp } from './app.js';
import { createToken } from './auth.js';
import { greenhouseInput } from '../../../packages/browser/src/test-support/greenhouse-fixture.js';

const secret = 'greenhouse-test',
  headers = { authorization: `Bearer ${createToken('owner', secret)}` };
const policy = {
  validateNavigation: () => {},
  validateRequest: () => {},
  validateAddress: async () => {},
  validateConnectedAddress: () => {},
};
const date = new Date();
function row() {
  const input = greenhouseInput('https://127.0.0.1:1234');
  return {
    id: 'application',
    jobId: 'job',
    state: 'RESOLVED',
    createdAt: date,
    updatedAt: date,
    job: {
      id: 'job',
      company: 'Fixture',
      title: 'Intern',
      source: 'TEST',
      location: null,
      employmentType: null,
    },
    plan: { ...input.plan, id: 'plan', createdAt: date },
    inspection: {
      id: 'inspection',
      applicationPlanId: 'plan',
      state: 'COMPLETED',
      errorCode: null,
      result: input.inspection,
      startedAt: date,
      completedAt: date,
      updatedAt: date,
    },
    preparation: {
      id: 'preparation',
      state: 'COMPLETED',
      result: input.preparedApplication,
      errorCode: null,
      version: 1,
      updatedAt: date,
      startedAt: date,
      completedAt: date,
    },
    executions: [],
    events: [],
  };
}
describe('Greenhouse application API', () => {
  it.each(['missing', 'PENDING', 'RUNNING'])(
    'shows preparation recovery or progress before manual answers for %s preparation',
    async (state) => {
      const record = row();
      record.inspection.state = 'HUMAN_REQUIRED';
      record.inspection.result.humanReview = {
        required: true,
        reasons: ['SENSITIVE_QUESTION'],
      };
      const application = {
        ...record,
        preparation:
          state === 'missing'
            ? null
            : { ...record.preparation, state, result: null },
      };
      const app = createApp({
        authSecret: secret,
        db: {
          user: { findUnique: async () => ({ id: 'owner' }) },
          application: { findFirst: async () => application },
        } as unknown as PrismaClient,
      });
      try {
        const response = await app.inject({
          url: '/api/v1/human-review/application',
          headers,
        });
        expect(response.statusCode, response.body).toBe(200);
        const review = response.json().review;
        expect(review.canStartPreparation).toBe(state === 'missing');
        expect(review.items).toEqual([]);
        expect(review.blockers).toHaveLength(state === 'missing' ? 1 : 0);
        if (state === 'missing')
          expect(review.blockers[0].recommendation).toContain(
            'Questions needing your input will appear here',
          );
      } finally {
        await app.close();
      }
    },
  );
  it('provides exact Greenhouse questions and dropdown choices for rejected AI answers in portal review', async () => {
    const record = row();
    record.inspection.state = 'HUMAN_REQUIRED';
    record.inspection.result.humanReview = {
      required: true,
      reasons: ['SENSITIVE_QUESTION'],
    };
    record.preparation.state = 'HUMAN_REQUIRED';
    record.preparation.result.overallStatus = 'HUMAN_REQUIRED';
    const question = record.preparation.result.questions[0]!;
    Object.assign(question, {
      answer: 'Yes',
      source: 'LLM_GENERATED',
      confidence: 0.6,
      requiresHumanReview: true,
      reason: 'Gemini confidence 60% is below the 75% threshold.',
    });
    record.preparation.result.humanReviewItems = [
      {
        requirementId: 'q1',
        category: 'CUSTOM_QUESTION',
        reason: question.reason!,
      },
    ];
    const app = createApp({
      authSecret: secret,
      db: {
        user: { findUnique: async () => ({ id: 'owner' }) },
        application: { findFirst: async () => record },
      } as unknown as PrismaClient,
    });
    try {
      const response = await app.inject({
        url: '/api/v1/human-review/application',
        headers,
      });
      expect(response.statusCode, response.body).toBe(200);
      const review = response.json().review;
      expect(review.blockers).toEqual([]);
      expect(review.items).toEqual([
        expect.objectContaining({
          question: 'Are you available for the internship?',
          options: ['Yes', 'No'],
          fieldType: 'SELECT',
          confidence: 0.6,
          reason: question.reason,
          actions: ['ANSWER', 'CONFIRM', 'REJECT'],
        }),
      ]);
    } finally {
      await app.close();
    }
  });
  it.each([true, false])(
    'shows assisted readiness with enabled=%s and never schedules automatic submission',
    async (enabled) => {
      const record = row();
      const app = createApp({
        authSecret: secret,
        allowRealExecution: true,
        autoSubmit: true,
        greenhouseBrowserAssisted: enabled,
        db: {
          application: { findFirst: async () => record },
        } as unknown as PrismaClient,
      });
      try {
        const response = await app.inject({
          url: '/api/v1/applications/application',
          headers,
        });
        expect(response.statusCode, response.body).toBe(200);
        const view = response.json().application;
        expect(view.executionReadiness.state).toBe(
          enabled ? 'READY' : 'BLOCKED',
        );
        expect(view.executionReadiness.browserAssisted).toBe(enabled);
        if (enabled) {
          expect(view.executionReadiness.automatic).toBe(false);
          expect(view.executionModes).toEqual(['REAL_EXECUTION']);
        } else expect(view.executionModes).toEqual([]);
      } finally {
        await app.close();
      }
    },
  );
  it('retries the old analytics failure through the worker and invalidates stale preparation atomically', async () => {
    const record = row();
    record.inspection.state = 'HUMAN_REQUIRED';
    record.inspection.errorCode = 'MUTATING_REQUEST_BLOCKED' as never;
    record.inspection.result = null as never;
    record.preparation.state = 'HUMAN_REQUIRED';
    const updateMany = vi.fn(async () => ({ count: 1 })),
      preparationUpdate = vi.fn(async () => ({ count: 1 })),
      add = vi.fn();
    const tx = {
      applicationInspection: { updateMany },
      applicationPreparation: { updateMany: preparationUpdate },
    };
    const app = createApp({
      authSecret: secret,
      policy,
      queue: { add } as unknown as Queue,
      db: {
        application: { findFirst: async () => record },
        ...tx,
        $transaction: async (fn: (tx: unknown) => unknown) => fn(tx),
      } as unknown as PrismaClient,
    });
    try {
      const response = await app.inject({
        method: 'POST',
        url: '/api/v1/applications/application/inspect',
        headers,
      });
      expect(response.statusCode, response.body).toBe(202);
      expect(updateMany).toHaveBeenCalledWith(
        expect.objectContaining({
          where: expect.objectContaining({
            state: 'HUMAN_REQUIRED',
            errorCode: 'MUTATING_REQUEST_BLOCKED',
            result: { equals: Prisma.DbNull },
          }),
        }),
      );
      expect(preparationUpdate).toHaveBeenCalledTimes(1);
      expect(add).toHaveBeenCalledTimes(1);
    } finally {
      await app.close();
    }
  });
});
