import { describe, expect, it, vi } from 'vitest';
import type { PrismaClient } from '@careerlift/database';
import type { Queue } from 'bullmq';
import {
  ApplicationSchemaSchema,
  canRetryEmptyInspection,
  canRepairChoiceInspection,
} from '@careerlift/domain';
import { createApp } from './app.js';
import { createToken } from './auth.js';

const schema = ApplicationSchemaSchema.parse({
  inspectionId: 'inspection',
  applicationPlanId: 'plan',
  sourceUrl: 'https://jobs.ashbyhq.com/fixture/posting/application',
  finalUrl: 'https://jobs.ashbyhq.com/fixture/posting/application',
  finalHostname: 'jobs.ashbyhq.com',
  redirectChain: [],
  plannedApplicationType: 'EXTERNAL_ATS',
  platform: 'ASHBY',
  platformDiscrepancy: false,
  title: 'Application',
  fields: [],
  forms: [],
  documents: [],
  questions: [],
  authentication: { required: false },
  confidence: 1,
  humanReview: { required: true, reasons: ['INTERACTIVE_DISCOVERY_REQUIRED'] },
  inspectionMetadata: {
    inspectedAt: new Date().toISOString(),
    durationMs: 1,
    visibleTextExcerpt: 'PRIVATE_SENTINEL',
    fieldCount: 0,
  },
});
const date = new Date();
const inspection = {
  id: 'inspection',
  applicationPlanId: 'plan',
  state: 'HUMAN_REQUIRED',
  errorCode: null,
  result: schema,
  startedAt: date,
  completedAt: date,
  updatedAt: date,
};
const record = {
  id: 'application',
  jobId: 'job',
  state: 'RESOLVED',
  createdAt: date,
  updatedAt: date,
  job: {
    id: 'job',
    title: 'Audiobook Specialists',
    company: 'ElevenLabs',
    location: 'Remote',
    employmentType: null,
    source: 'TEST',
  },
  plan: {
    id: 'plan',
    applicationType: 'EXTERNAL_ATS',
    provider: 'ASHBY',
    destination: { url: schema.sourceUrl },
    requirements: [],
    actions: [],
    executor: 'BROWSER',
    confidence: 1,
    requiresHumanReview: false,
    reasoning: [],
    resolvedBy: 'deterministic',
    createdAt: date,
  },
  inspection,
  preparation: null,
  executions: [],
  events: [],
};
const secret = 'inspection-retry-test';
const headers = { authorization: `Bearer ${createToken('owner', secret)}` };
const policy = {
  validateNavigation: () => {},
  validateRequest: () => {},
  validateAddress: async () => {},
  validateConnectedAddress: () => {},
};

describe('empty inspection recovery', () => {
  it('rebuilds an old choice inspection and invalidates its stale preparation atomically', async () => {
    const oldSchema = {
      ...schema,
      fields: [
        {
          id: 'field-1',
          label: 'English',
          type: 'CHECKBOX',
          required: false,
          visible: true,
          disabled: false,
          readonly: false,
          options: [],
          source: 'DOM',
        },
      ],
      humanReview: { required: false, reasons: [] },
    };
    const old = {
      ...record,
      inspection: { ...inspection, state: 'COMPLETED', result: oldSchema },
      preparation: {
        id: 'preparation',
        state: 'HUMAN_REQUIRED',
        version: 1,
        result: null,
        updatedAt: date,
        startedAt: date,
        completedAt: date,
        errorCode: null,
      },
    };
    expect(canRepairChoiceInspection(old.inspection)).toBe(true);
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
      db: {
        application: { findFirst: async () => old },
        ...tx,
        $transaction: async (fn: (client: typeof tx) => unknown) => fn(tx),
      } as unknown as PrismaClient,
      queue: { add } as unknown as Queue,
    });
    try {
      const detail = await app.inject({
        url: '/api/v1/applications/application',
        headers,
      });
      expect(detail.json().application.inspectionRetryAllowed).toBe(true);
      const result = await app.inject({
        method: 'POST',
        url: '/api/v1/applications/application/inspect',
        headers,
      });
      expect(result.statusCode, result.body).toBe(202);
      expect(preparationUpdate).toHaveBeenCalledWith(
        expect.objectContaining({
          where: { id: 'preparation', version: 1, state: 'HUMAN_REQUIRED' },
          data: expect.objectContaining({
            state: 'FAILED',
            errorCode: 'FORM_REINSPECTION_REQUIRED',
            reviewDecisions: [],
          }),
        }),
      );
      expect(add).toHaveBeenCalledTimes(1);
      expect(
        canRepairChoiceInspection({
          ...old.inspection,
          result: {
            ...oldSchema,
            inspectionMetadata: {
              ...oldSchema.inspectionMetadata,
              formParserVersion: 2,
            },
          },
        }),
      ).toBe(false);
      expect(
        canRepairChoiceInspection({
          ...old.inspection,
          state: 'HUMAN_REQUIRED',
        }),
      ).toBe(false);
    } finally {
      await app.close();
    }
  });
  it('requeues historical empty discoveries and exposes a specific safe message and retry control', async () => {
    const updateMany = vi.fn(async () => ({ count: 1 }));
    const add = vi.fn();
    const app = createApp({
      authSecret: secret,
      policy,
      db: {
        application: { findFirst: async () => record },
        applicationInspection: { updateMany },
      } as unknown as PrismaClient,
      queue: { add } as unknown as Queue,
    });
    try {
      const detail = await app.inject({
        url: '/api/v1/applications/application',
        headers,
      });
      expect(detail.statusCode, detail.body).toBe(200);
      expect(detail.json().application.inspectionRetryAllowed).toBe(true);
      expect(detail.json().application.inspection.issue).toContain(
        'No application fields were detected',
      );
      expect(detail.body).not.toContain('PRIVATE_SENTINEL');
      expect(detail.body).not.toContain('INTERACTIVE_DISCOVERY_REQUIRED');
      const retry = await app.inject({
        method: 'POST',
        url: '/api/v1/applications/application/inspect',
        headers,
      });
      expect(retry.statusCode, retry.body).toBe(202);
      expect(updateMany).toHaveBeenCalledWith(
        expect.objectContaining({
          where: expect.objectContaining({
            state: 'HUMAN_REQUIRED',
            result: { equals: schema },
            application: expect.objectContaining({
              preparation: { is: null },
              executions: { none: {} },
            }),
          }),
          data: expect.objectContaining({ state: 'PENDING' }),
        }),
      );
      expect(add).toHaveBeenCalledWith(
        'INSPECT_APPLICATION',
        expect.objectContaining({ applicationId: 'application' }),
        expect.anything(),
      );
    } finally {
      await app.close();
    }
  });
  it.each([
    'CAPTCHA',
    'AUTHENTICATION_REQUIRED',
    'UNEXPECTED_NAVIGATION',
    'SENSITIVE_QUESTION',
    'PLATFORM_MISMATCH',
    'UNSUPPORTED_INTERACTION',
  ] as const)('never retries %s review', async (reason) => {
    const guarded = {
      ...inspection,
      result: {
        ...schema,
        humanReview: {
          required: true,
          reasons: ['INTERACTIVE_DISCOVERY_REQUIRED', reason],
        },
      },
    };
    expect(canRetryEmptyInspection(guarded)).toBe(false);
    const add = vi.fn(),
      updateMany = vi.fn();
    const app = createApp({
      authSecret: secret,
      policy,
      db: {
        application: {
          findFirst: async () => ({ ...record, inspection: guarded }),
        },
        applicationInspection: { updateMany },
      } as unknown as PrismaClient,
      queue: { add } as unknown as Queue,
    });
    try {
      const retry = await app.inject({
        method: 'POST',
        url: '/api/v1/applications/application/inspect',
        headers,
      });
      expect(retry.statusCode).toBe(200);
      expect(retry.json().status).toBe('HUMAN_REQUIRED');
      expect(updateMany).not.toHaveBeenCalled();
      expect(add).not.toHaveBeenCalled();
    } finally {
      await app.close();
    }
  });
  it.each([
    { preparation: { state: 'COMPLETED' } },
    { executions: [{ state: 'SUBMISSION_UNKNOWN' }] },
    { state: 'SUBMITTED' },
    { inspection: { ...inspection, errorCode: 'UNSAFE_DESTINATION' } },
    { inspection: { ...inspection, applicationPlanId: 'another-plan' } },
  ])(
    'does not reset a guarded or downstream application: %j',
    async (overrides) => {
      const add = vi.fn(),
        updateMany = vi.fn();
      const app = createApp({
        authSecret: secret,
        policy,
        db: {
          application: { findFirst: async () => ({ ...record, ...overrides }) },
          applicationInspection: { updateMany },
        } as unknown as PrismaClient,
        queue: { add } as unknown as Queue,
      });
      try {
        const retry = await app.inject({
          method: 'POST',
          url: '/api/v1/applications/application/inspect',
          headers,
        });
        expect(retry.statusCode).toBe(200);
        expect(updateMany).not.toHaveBeenCalled();
        expect(add).not.toHaveBeenCalled();
      } finally {
        await app.close();
      }
    },
  );
  it('does not enqueue when the persisted result changes before claiming a retry', async () => {
    const add = vi.fn();
    const app = createApp({
      authSecret: secret,
      policy,
      db: {
        application: { findFirst: async () => record },
        applicationInspection: { updateMany: async () => ({ count: 0 }) },
      } as unknown as PrismaClient,
      queue: { add } as unknown as Queue,
    });
    try {
      const retry = await app.inject({
        method: 'POST',
        url: '/api/v1/applications/application/inspect',
        headers,
      });
      expect(retry.statusCode).toBe(409);
      expect(add).not.toHaveBeenCalled();
    } finally {
      await app.close();
    }
  });
});
