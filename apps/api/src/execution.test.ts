import { createHmac } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import type { PrismaClient } from '@careerlift/database';
import type { Queue } from 'bullmq';
import { createApp } from './app.js';
import { executionFixture } from '../../../tests/support/execution-fixture.js';

const secret = 'phase4-api-test';
const token = (sub = 'owner') => {
  const head = Buffer.from(
    JSON.stringify({ alg: 'HS256', typ: 'JWT' }),
  ).toString('base64url');
  const body = Buffer.from(
    JSON.stringify({ sub, exp: Math.floor(Date.now() / 1000) + 3600 }),
  ).toString('base64url');
  return `Bearer ${head}.${body}.${createHmac('sha256', secret).update(`${head}.${body}`).digest('base64url')}`;
};
describe('authenticated execution API', () => {
  it('checks ownership, relationships, preparation, explicit mode, and immutable existing runs', async () => {
    const fixture = await executionFixture();
    const input = fixture.input;
    let source = {
      id: input.applicationId,
      userId: 'owner',
      jobId: input.jobId,
      state: 'RESOLVED',
      plan: {
        ...input.plan,
        id: input.applicationPlanId,
        applicationId: input.applicationId,
      },
      inspection: {
        id: input.inspectionId,
        applicationId: input.applicationId,
        applicationPlanId: input.applicationPlanId,
        state: 'COMPLETED',
        result: input.inspection,
      },
      preparation: {
        id: input.preparationId,
        applicationId: input.applicationId,
        inspectionId: input.inspectionId,
        version: 1,
        state: 'COMPLETED',
        updatedAt: new Date(input.preparationUpdatedAt),
        result: input.preparedApplication,
      },
      user: { documents: input.documents },
    };
    let record: Record<string, unknown> | null = null;
    const calls: {
      name: string;
      data: unknown;
      options: { attempts: number; jobId: string };
    }[] = [];
    const db = {
      application: {
        findFirst: async ({
          where,
        }: {
          where: { userId: string; id: string };
        }) =>
          where.userId === 'owner' && where.id === 'application'
            ? source
            : null,
      },
      applicationExecution: {
        findUnique: async () => record,
        findFirst: async ({
          where,
        }: {
          where: { id?: string; applicationId: string };
        }) =>
          record &&
          (!where.id || where.id === record.id) &&
          where.applicationId === record.applicationId
            ? record
            : null,
        upsert: async ({ create }: { create: Record<string, unknown> }) => {
          record ??= {
            ...create,
            state: 'PENDING',
            generation: 1,
            result: null,
            errorCode: null,
          };
          return record;
        },
      },
    } as unknown as PrismaClient;
    const app = createApp({
      db,
      queue: {
        add: async (
          name: string,
          data: unknown,
          options: { attempts: number; jobId: string },
        ) => {
          calls.push({ name, data, options });
        },
      } as unknown as Queue,
      authSecret: secret,
      executionFixtureOrigin: fixture.origin,
    });
    const post = (
      body: Record<string, unknown>,
      path = '/api/v1/applications/application/execute',
      owner = 'owner',
    ) =>
      app.inject({
        method: 'POST',
        url: path,
        headers: { authorization: token(owner) },
        payload: body,
      });
    try {
      expect(
        (
          await app.inject({
            method: 'POST',
            url: '/api/v1/applications/application/execute',
            payload: { mode: 'TEST_FIXTURE' },
          })
        ).statusCode,
      ).toBe(401);
      expect(
        (await post({ mode: 'TEST_FIXTURE' }, undefined, 'stranger'))
          .statusCode,
      ).toBe(404);
      expect(
        (
          await post(
            { mode: 'TEST_FIXTURE' },
            '/api/v1/applications/other/execute',
          )
        ).statusCode,
      ).toBe(404);
      expect((await post({})).statusCode).toBe(400);
      expect((await post({ mode: 'REAL_EXECUTION' })).statusCode).toBe(409);
      const original = structuredClone(source);
      for (const change of [
        () => {
          source.inspection.state = 'FAILED';
        },
        () => {
          source.preparation.state = 'HUMAN_REQUIRED';
        },
        () => {
          source.inspection.applicationPlanId = 'wrong-plan';
        },
        () => {
          source.preparation.inspectionId = 'wrong-inspection';
        },
        () => {
          source.preparation.result.applicationId = 'wrong-application';
        },
        () => {
          source.preparation.result.inspectionId = 'wrong-inspection';
        },
        () => {
          source.preparation.result.preparedAt = '2020-01-01T00:00:00.000Z';
        },
        () => {
          source.inspection.result.finalUrl = 'https://169.254.169.254/latest';
        },
        () => {
          source.plan.executor = 'EMAIL' as never;
        },
        () => {
          source.preparation.result.fields = [];
        },
      ]) {
        source = structuredClone(original);
        change();
        expect((await post({ mode: 'TEST_FIXTURE' })).statusCode).toBe(409);
      }
      source = structuredClone(original);
      expect(calls).toHaveLength(0);
      expect((await post({ mode: 'TEST_FIXTURE' })).statusCode).toBe(202);
      expect((await post({ mode: 'TEST_FIXTURE' })).statusCode).toBe(202);
      expect(calls).toHaveLength(1);
      expect(calls[0]!.name).toBe('EXECUTE_APPLICATION');
      expect(calls[0]!.options.attempts).toBe(1);
      expect(
        (
          await app.inject({
            method: 'GET',
            url: '/api/v1/applications/application/execution',
            headers: { authorization: token('stranger') },
          })
        ).statusCode,
      ).toBe(404);
      expect(
        (
          await app.inject({
            method: 'GET',
            url: '/api/v1/applications/application/execution',
            headers: { authorization: token() },
          })
        ).json().status,
      ).toBe('PENDING');
      record!.state = 'SUBMISSION_UNKNOWN';
      expect(
        (
          await post(
            { executionId: record!.id },
            '/api/v1/applications/application/execution/resume',
          )
        ).statusCode,
      ).toBe(409);
      expect(
        (
          await post(
            { executionId: 'other-execution' },
            '/api/v1/applications/application/execution/resume',
          )
        ).statusCode,
      ).toBe(404);
      expect((await post({ mode: 'TEST_FIXTURE' })).json().status).toBe(
        'SUBMISSION_UNKNOWN',
      );
      expect(calls).toHaveLength(1);
    } finally {
      await app.close();
      await fixture.close();
    }
  }, 30000);
});
