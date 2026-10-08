import { describe, expect, it, vi } from 'vitest';
import type { PrismaClient } from '@careerlift/database';
import type { Queue } from 'bullmq';
import { createApp } from './app.js';
import { createToken } from './auth.js';
import { ashbyInput } from '../../../packages/browser/src/test-support/ashby-fixture.js';
import { DestinationPolicy } from '@careerlift/browser';

describe('Ashby execution API and workspace', () => {
  it.each([false, true])(
    'exposes actual blockers, protects private preview and starts an idempotent run (assisted=%s)',
    async (assisted) => {
      const input = ashbyInput('https://127.0.0.1:43443'),
        at = new Date(input.preparationUpdatedAt);
      const source = {
        id: input.applicationId,
        userId: 'owner',
        jobId: 'job',
        state: 'RESOLVED',
        createdAt: at,
        updatedAt: at,
        job: {
          id: 'job',
          title: 'Engineer',
          company: 'Fixture',
          location: null,
          employmentType: null,
          source: 'TEST',
        },
        plan: {
          ...input.plan,
          id: 'plan',
          applicationId: input.applicationId,
          createdAt: at,
        },
        inspection: {
          id: 'inspection',
          applicationId: input.applicationId,
          applicationPlanId: 'plan',
          state: 'COMPLETED',
          result: input.inspection,
          errorCode: null,
          startedAt: at,
          completedAt: at,
          updatedAt: at,
        },
        preparation: {
          id: 'preparation',
          applicationId: input.applicationId,
          inspectionId: 'inspection',
          version: 1,
          state: 'COMPLETED',
          result: input.preparedApplication,
          errorCode: null,
          startedAt: at,
          completedAt: at,
          updatedAt: at,
        },
        user: { documents: input.documents },
        executions: [],
        events: [],
      };
      let record: Record<string, unknown> | null = null;
      const db = {
        application: {
          findFirst: vi.fn(
            async ({ where }: { where: { userId: string; id: string } }) =>
              where.userId === 'owner' && where.id === source.id
                ? source
                : null,
          ),
        },
        applicationExecution: {
          findUnique: vi.fn(async () => record),
          upsert: vi.fn(
            async ({ create }: { create: Record<string, unknown> }) => {
              record = {
                ...create,
                state: 'PENDING',
                generation: 1,
                result: null,
                errorCode: null,
              };
              return record;
            },
          ),
        },
      } as unknown as PrismaClient;
      const add = vi.fn<
          (name: string, data: unknown, options: unknown) => Promise<void>
        >(async () => {}),
        secret = 'ashby-api-fixture';
      const app = createApp({
        ashbyBrowserAssisted: assisted,
        db,
        queue: { add } as unknown as Queue,
        authSecret: secret,
        allowRealExecution: true,
        autoSubmit: true,
        autoSubmitSince: new Date(at.getTime() + 1000).toISOString(),
        policy: new DestinationPolicy('https://127.0.0.1:43443'),
        executionFixtureOrigin: 'https://127.0.0.1:43443',
      });
      const headers = {
        authorization: `Bearer ${createToken('owner', secret, 3600)}`,
      };
      try {
        expect(
          (
            await app.inject({
              url: `/api/v1/applications/${source.id}/submission-preview`,
            })
          ).statusCode,
        ).toBe(401);
        expect(
          (
            await app.inject({
              url: `/api/v1/applications/${source.id}/submission-preview`,
              headers: {
                authorization: `Bearer ${createToken('stranger', secret, 3600)}`,
              },
            })
          ).statusCode,
        ).toBe(404);
        const preview = await app.inject({
          url: `/api/v1/applications/${source.id}/submission-preview`,
          headers,
        });
        expect(preview.headers['cache-control']).toBe('no-store');
        expect(preview.json().answers[1].value).toBe('ada@example.com');
        input.inspection.ashbySubmission!.requiresCaptcha = true;
        let detail = (
          await app.inject({
            url: `/api/v1/applications/${source.id}`,
            headers,
          })
        ).json().application;
        expect(detail.executionReadiness.state).toBe(
          assisted ? 'READY' : 'BLOCKED',
        );
        expect(detail.executionReadiness.browserAssisted).toBe(assisted);
        expect(detail.executionReadiness.reason).toContain(
          assisted ? 'assisted browser' : 'reCAPTCHA',
        );
        expect(detail.active).toBe(false);
        expect(detail.executionReadiness.automatic).toBe(false);
        // Native fixture controls are disabled for a blocked provider flow.
        expect(detail.executionModes).toEqual(assisted ? ['TEST_FIXTURE'] : []);
        const post = () =>
          app.inject({
            method: 'POST',
            url: `/api/v1/applications/${source.id}/execute`,
            headers,
            payload: { mode: 'TEST_FIXTURE' },
          });
        if (!assisted) {
          expect((await post()).json().error).toBe('CAPTCHA');
          expect(add).not.toHaveBeenCalled();
        } else {
          // Browser assistance must still refuse surveys and unsupported controls.
          input.inspection.ashbySubmission!.surveyCount = 1;
          expect((await post()).json().error).toBe(
            'ASHBY_SURVEY_REVIEW_REQUIRED',
          );
          input.inspection.ashbySubmission!.surveyCount = 0;
          const originalType =
            input.inspection.ashbySubmission!.fields[0]!.type;
          input.inspection.ashbySubmission!.fields[0]!.type = 'Unsupported';
          expect((await post()).json().error).toBe('ASHBY_UNSUPPORTED_FIELD');
          input.inspection.ashbySubmission!.fields[0]!.type = originalType;
          expect(add).not.toHaveBeenCalled();
        }
        input.inspection.ashbySubmission!.requiresCaptcha = false;
        detail = (
          await app.inject({
            url: `/api/v1/applications/${source.id}`,
            headers,
          })
        ).json().application;
        expect(detail.executionReadiness.state).toBe('READY');
        expect(detail.active).toBe(false);
        expect((await post()).statusCode).toBe(202);
        expect((await post()).statusCode).toBe(202);
        expect(add).toHaveBeenCalledTimes(1);
        expect(add.mock.calls[0]![0]).toBe('EXECUTE_APPLICATION');
        // Real automation excludes local fixtures and applications prepared before activation.
        const real = 'https://jobs.ashbyhq.com/fixture/posting/application';
        input.inspection.finalUrl = real;
        detail = (
          await app.inject({
            url: `/api/v1/applications/${source.id}`,
            headers,
          })
        ).json().application;
        expect(detail.executionReadiness.automatic).toBe(false);
        expect(detail.active).toBe(false);
        source.preparation.completedAt = new Date(at.getTime() + 2000);
        detail = (
          await app.inject({
            url: `/api/v1/applications/${source.id}`,
            headers,
          })
        ).json().application;
        expect(detail.executionReadiness.automatic).toBe(true);
        expect(detail.active).toBe(true);
        if (assisted) {
          input.inspection.ashbySubmission!.requiresCaptcha = true;
          detail = (
            await app.inject({
              url: `/api/v1/applications/${source.id}`,
              headers,
            })
          ).json().application;
          expect(detail.executionReadiness.browserAssisted).toBe(true);
          expect(detail.executionReadiness.automatic).toBe(false);
          expect(detail.active).toBe(false);
        }
      } finally {
        await app.close();
      }
    },
  );
});
