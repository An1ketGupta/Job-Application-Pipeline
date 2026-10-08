import Fastify, { type FastifyInstance } from 'fastify';
import { randomUUID } from 'node:crypto';
import { z } from 'zod';
import { CompositeApplicationResolver } from '@careerlift/application-resolver';
import {
  DestinationPolicy,
  type BrowserNetworkPolicy,
} from '@careerlift/browser';
import {
  JobSchema,
  ApplicationPlanSchema,
  ApplicationSchemaSchema,
  PreparedApplicationSchema,
  canPrepareInspection,
  type AnswerGenerationProvider,
} from '@careerlift/domain';
import { Prisma, type PrismaClient } from '@careerlift/database';
import type { Queue } from 'bullmq';
import { authenticateBearer } from './auth.js';
import { registerExecutionRoutes } from './execution-routes.js';
import { registerVerificationRoutes } from './verification-routes.js';

import { registerJobRoutes } from './job-routes.js';
import { registerApplicationRoutes } from './application-routes.js';
import { registerCandidateRoutes } from './candidate-routes.js';
import { registerReviewRoutes } from './review-routes.js';
import { safeInspection, safePreparation } from './safe-stage-views.js';
import { publicUrl } from './public-views.js';
import type { CareerLiftJobSource } from '@careerlift/validation';
import type { ApplicationResolverStrategy } from '@careerlift/application-resolver';
import { registerEmailRoutes } from './email-routes.js';
import type { GmailConfig, EmailDraftGenerator } from '@careerlift/email';
import {
  registerGoogleFormRoutes,
  type GoogleFormDependencies,
} from './google-form-routes.js';

const RequestSchema = z.object({ job: JobSchema }).strict();
type Dependencies = GoogleFormDependencies & {
  db?: PrismaClient;
  queue?: Queue;
  authSecret?: string;
  policy?: BrowserNetworkPolicy;
  executionFixtureOrigin?: string;
  allowRealExecution?: boolean;
  source?: CareerLiftJobSource;
  resolver?: ApplicationResolverStrategy;
  documentRoot?: string;
  gmail?: GmailConfig;
  emailDraftGenerator?: EmailDraftGenerator;
  answerProvider?: AnswerGenerationProvider;
  answerConfidenceThreshold?: number;
  emailDefaultSenderName?: string;
  emailExpectedSender?: string;
  emailTestRecipient?: string;
};

export function createApp(dependencies: Dependencies = {}): FastifyInstance {
  const app = Fastify({ logger: true });
  app.setErrorHandler((error, request, reply) => {
    const status = Number((error as { statusCode?: number }).statusCode);
    request.log.error(
      { event: 'request_failed', requestId: request.id },
      'Request failed',
    );
    return reply.code(status >= 400 && status < 500 ? status : 503).send({
      error:
        status >= 400 && status < 500
          ? 'INVALID_REQUEST'
          : 'SERVICE_UNAVAILABLE',
      message:
        status >= 400 && status < 500
          ? 'The request is invalid or too large.'
          : 'CareerLift is temporarily unavailable. Check the local services and try again.',
    });
  });
  app.addHook('onRequest', async (request, reply) => {
    reply.header('Cache-Control', 'no-store');
    reply.header('Access-Control-Allow-Origin', '*');
    reply.header(
      'Access-Control-Allow-Methods',
      'GET,HEAD,PUT,PATCH,POST,DELETE,OPTIONS',
    );
    reply.header(
      'Access-Control-Allow-Headers',
      'Content-Type, Authorization, X-Requested-With',
    );
    if (request.method === 'OPTIONS') {
      return reply.code(204).send();
    }
  });

  const resolver = dependencies.resolver ?? new CompositeApplicationResolver();
  const policy = dependencies.policy ?? new DestinationPolicy();
  registerExecutionRoutes(app, dependencies);
  registerVerificationRoutes(app, dependencies);
  registerJobRoutes(app, { ...dependencies, resolver });
  registerApplicationRoutes(app, dependencies);
  registerCandidateRoutes(app, dependencies);
  registerReviewRoutes(app, dependencies);
  registerEmailRoutes(app, dependencies);
  registerGoogleFormRoutes(app, dependencies);
  app.get('/health', async () => ({ status: 'ok' }));
  app.post('/api/v1/application-resolve', async (request, reply) => {
    if (
      !authenticateBearer(
        request.headers.authorization,
        dependencies.authSecret,
      )
    )
      return reply.code(401).send({ error: 'UNAUTHENTICATED' });
    const parsed = RequestSchema.safeParse(request.body);
    if (!parsed.success)
      return reply
        .code(400)
        .send({ error: 'INVALID_JOB', issues: parsed.error.issues });
    try {
      const plan = await resolver.resolve(parsed.data.job);
      request.log.info(
        {
          event: 'application.resolved',
          requestId: request.id,
          jobId: plan.jobId,
          applicationType: plan.applicationType,
          confidence: plan.confidence,
          status: plan.requiresHumanReview ? 'HUMAN_REQUIRED' : 'RESOLVED',
        },
        'Application resolved',
      );
      return {
        jobId: plan.jobId,
        applicationType: plan.applicationType,
        provider: plan.provider,
        destination: {
          ...(publicUrl(plan.destination.url)
            ? { url: publicUrl(plan.destination.url) }
            : {}),
          ...(plan.destination.email ? { email: plan.destination.email } : {}),
        },
        executor: plan.executor,
        requiresHumanReview: plan.requiresHumanReview,
      };
    } catch (error) {
      request.log.error(
        { event: 'application.resolution_failed', error },
        'Application resolution failed',
      );
      return reply.code(500).send({ error: 'APPLICATION_RESOLUTION_ERROR' });
    }
  });

  const paramsSchema = z.object({ id: z.string().min(1) });
  app.post('/api/v1/applications/:id/inspect', async (request, reply) => {
    const caller = authenticateBearer(
      request.headers.authorization,
      dependencies.authSecret,
    );
    if (!caller) return reply.code(401).send({ error: 'UNAUTHENTICATED' });
    const params = paramsSchema.safeParse(request.params);
    if (!params.success)
      return reply.code(400).send({ error: 'INVALID_APPLICATION_ID' });
    if (!dependencies.db || !dependencies.queue)
      return reply.code(503).send({ error: 'INSPECTION_UNAVAILABLE' });
    const db = dependencies.db;
    const application = await db.application.findFirst({
      where: { id: params.data.id, userId: caller },
      include: { plan: true, inspection: true },
    });
    if (!application)
      return reply.code(404).send({ error: 'APPLICATION_NOT_FOUND' });
    if (!application.plan)
      return reply.code(409).send({ error: 'PLAN_NOT_FOUND' });
    if (
      application.inspection &&
      ['COMPLETED', 'HUMAN_REQUIRED'].includes(application.inspection.state)
    )
      return {
        inspectionId: application.inspection.id,
        status: application.inspection.state,
        schema: safeInspection(application.inspection.result),
      };
    if (!['RESOLVED', 'READY'].includes(application.state))
      return reply.code(409).send({ error: 'APPLICATION_NOT_INSPECTABLE' });
    const plan = ApplicationPlanSchema.safeParse({
      jobId: application.jobId,
      applicationType: application.plan.applicationType,
      provider: application.plan.provider ?? undefined,
      destination: application.plan.destination,
      requirements: application.plan.requirements,
      actions: application.plan.actions,
      executor: application.plan.executor,
      confidence: application.plan.confidence,
      requiresHumanReview: application.plan.requiresHumanReview,
      reasoning: application.plan.reasoning,
      resolvedBy: application.plan.resolvedBy,
    });
    if (!plan.success) return reply.code(409).send({ error: 'INVALID_PLAN' });
    if (
      !plan.data.destination.url ||
      ![
        'DIRECT_PORTAL',
        'EXTERNAL_ATS',
        'GOOGLE_FORM',
        'GOOGLE_DOC',
        'LINKEDIN',
      ].includes(plan.data.applicationType)
    )
      return reply.code(409).send({ error: 'UNSUPPORTED_PLAN_TYPE' });
    try {
      policy.validateNavigation(plan.data.destination.url);
      await policy.validateAddress(plan.data.destination.url);
    } catch {
      if (plan.data.destination.target) {
        // Security failures on a supported ATS are durable inspection review
        // gates. An existing in-flight/completed run is never overwritten.
        await db.$transaction(async (tx) => {
          await tx.applicationInspection.upsert({
            where: { applicationId: application.id },
            create: {
              applicationId: application.id,
              applicationPlanId: application.plan!.id,
              state: 'HUMAN_REQUIRED',
              errorCode: 'UNSAFE_DESTINATION',
              completedAt: new Date(),
            },
            update: {},
          });
          await tx.applicationEvent.createMany({
            data: [
              {
                applicationId: application.id,
                jobId: application.jobId,
                requestId: request.id,
                type: 'HUMAN_REVIEW_REQUIRED',
                status: application.state,
                errorCode: 'UNSAFE_DESTINATION',
                data: {
                  atsEvent: 'ATS_REQUIRES_HUMAN_REVIEW',
                  platform: plan.data.destination.target!.platform,
                },
              },
            ],
            skipDuplicates: true,
          });
        });
      }
      return reply.code(409).send({ error: 'UNSAFE_DESTINATION' });
    }
    let inspection = application.inspection;
    if (!inspection) {
      inspection = await db.applicationInspection.upsert({
        where: { applicationId: application.id },
        create: {
          applicationId: application.id,
          applicationPlanId: application.plan.id,
          state: 'PENDING',
        },
        update: {},
      });
    }
    if (inspection.state === 'RUNNING')
      return reply
        .code(202)
        .send({ inspectionId: inspection.id, status: 'RUNNING' });
    if (inspection.state === 'FAILED') {
      await db.applicationInspection.updateMany({
        where: { id: inspection.id, state: 'FAILED' },
        data: {
          state: 'PENDING',
          errorCode: null,
          result: Prisma.DbNull,
          finalUrl: null,
          startedAt: null,
          completedAt: null,
          runId: null,
        },
      });
    }
    try {
      await dependencies.queue.add(
        'INSPECT_APPLICATION',
        { applicationId: application.id, requestId: request.id },
        {
          jobId: `inspect-${inspection.id}-${randomUUID()}`,
          attempts: 2,
          backoff: { type: 'exponential', delay: 1000 },
          removeOnComplete: true,
          removeOnFail: true,
        },
      );
    } catch (error) {
      await db.applicationInspection.updateMany({
        where: { id: inspection.id, state: 'PENDING' },
        data: {
          state: 'FAILED',
          errorCode: 'QUEUE_UNAVAILABLE',
          completedAt: new Date(),
          result: Prisma.DbNull,
          finalUrl: null,
        },
      });
      request.log.error({ error }, 'Inspection queue unavailable');
      return reply.code(503).send({ error: 'QUEUE_UNAVAILABLE' });
    }
    return reply
      .code(202)
      .send({ inspectionId: inspection.id, status: 'PENDING' });
  });

  app.get('/api/v1/applications/:id/inspection', async (request, reply) => {
    const caller = authenticateBearer(
      request.headers.authorization,
      dependencies.authSecret,
    );
    if (!caller) return reply.code(401).send({ error: 'UNAUTHENTICATED' });
    const params = paramsSchema.safeParse(request.params);
    if (!params.success)
      return reply.code(400).send({ error: 'INVALID_APPLICATION_ID' });
    if (!dependencies.db)
      return reply.code(503).send({ error: 'INSPECTION_UNAVAILABLE' });
    const application = await dependencies.db.application.findFirst({
      where: { id: params.data.id, userId: caller },
      include: { inspection: true },
    });
    if (!application)
      return reply.code(404).send({ error: 'APPLICATION_NOT_FOUND' });
    const inspection = application.inspection;
    if (!inspection)
      return reply.code(404).send({ error: 'INSPECTION_NOT_FOUND' });
    return {
      inspectionId: inspection.id,
      status: inspection.state,
      errorCode: inspection.errorCode,
      schema: safeInspection(inspection.result),
    };
  });
  app.post('/api/v1/applications/:id/prepare', async (request, reply) => {
    const caller = authenticateBearer(
      request.headers.authorization,
      dependencies.authSecret,
    );
    if (!caller) return reply.code(401).send({ error: 'UNAUTHENTICATED' });
    const params = paramsSchema.safeParse(request.params);
    if (!params.success)
      return reply.code(400).send({ error: 'INVALID_APPLICATION_ID' });
    if (!dependencies.db || !dependencies.queue)
      return reply.code(503).send({ error: 'PREPARATION_UNAVAILABLE' });
    const db = dependencies.db;
    const application = await db.application.findFirst({
      where: { id: params.data.id, userId: caller },
      include: {
        inspection: true,
        preparation: true,
        executions: { select: { id: true } },
      },
    });
    if (!application)
      return reply.code(404).send({ error: 'APPLICATION_NOT_FOUND' });
    if (!application.inspection)
      return reply.code(409).send({ error: 'INSPECTION_NOT_FOUND' });
    const inspected = ApplicationSchemaSchema.safeParse(
      application.inspection.result,
    );
    if (
      !inspected.success ||
      inspected.data.inspectionId !== application.inspection.id
    )
      return reply.code(409).send({ error: 'INVALID_APPLICATION_SCHEMA' });
    if (!canPrepareInspection(application.inspection.state, inspected.data))
      return reply.code(409).send({ error: 'INSPECTION_NOT_COMPLETED' });
    if (
      !['RESOLVED', 'READY'].includes(application.state) ||
      application.executions.length > 0
    )
      return reply.code(409).send({ error: 'APPLICATION_NOT_PREPARABLE' });
    let preparation = application.preparation;
    if (!preparation)
      preparation = await db.applicationPreparation.upsert({
        where: { applicationId: application.id },
        create: {
          applicationId: application.id,
          inspectionId: application.inspection.id,
          state: 'PENDING',
        },
        update: {},
      });
    if (
      preparation.state === 'COMPLETED' ||
      preparation.state === 'HUMAN_REQUIRED'
    )
      return {
        preparationId: preparation.id,
        status: preparation.state,
        result: preparation.result
          ? PreparedApplicationSchema.parse(preparation.result)
          : null,
      };
    if (preparation.state === 'RUNNING')
      return reply
        .code(202)
        .send({ preparationId: preparation.id, status: 'RUNNING' });
    if (preparation.state === 'FAILED') {
      const changed = await db.applicationPreparation.updateMany({
        where: { id: preparation.id, state: 'FAILED' },
        data: {
          state: 'PENDING',
          result: Prisma.DbNull,
          errorCode: null,
          runId: null,
          startedAt: null,
          completedAt: null,
        },
      });
      if (!changed.count)
        return reply
          .code(202)
          .send({ preparationId: preparation.id, status: 'RUNNING' });
    }
    try {
      await dependencies.queue.add(
        'PREPARE_APPLICATION',
        { applicationId: application.id, requestId: request.id },
        {
          jobId: `prepare-${preparation.id}-${randomUUID()}`,
          attempts: 2,
          backoff: { type: 'exponential', delay: 1000 },
          removeOnComplete: true,
          removeOnFail: true,
        },
      );
    } catch (error) {
      await db.applicationPreparation.updateMany({
        where: { id: preparation.id, state: 'PENDING' },
        data: {
          state: 'FAILED',
          result: Prisma.DbNull,
          errorCode: 'QUEUE_UNAVAILABLE',
          completedAt: new Date(),
        },
      });
      request.log.error({ error }, 'Preparation queue unavailable');
      return reply.code(503).send({ error: 'QUEUE_UNAVAILABLE' });
    }
    return reply
      .code(202)
      .send({ preparationId: preparation.id, status: 'PENDING' });
  });
  app.get('/api/v1/applications/:id/preparation', async (request, reply) => {
    const caller = authenticateBearer(
      request.headers.authorization,
      dependencies.authSecret,
    );
    if (!caller) return reply.code(401).send({ error: 'UNAUTHENTICATED' });
    const params = paramsSchema.safeParse(request.params);
    if (!params.success)
      return reply.code(400).send({ error: 'INVALID_APPLICATION_ID' });
    if (!dependencies.db)
      return reply.code(503).send({ error: 'PREPARATION_UNAVAILABLE' });
    const application = await dependencies.db.application.findFirst({
      where: { id: params.data.id, userId: caller },
      include: { preparation: true },
    });
    if (!application)
      return reply.code(404).send({ error: 'APPLICATION_NOT_FOUND' });
    if (!application.preparation)
      return reply.code(404).send({ error: 'PREPARATION_NOT_FOUND' });
    return {
      preparationId: application.preparation.id,
      status: application.preparation.state,
      errorCode: application.preparation.errorCode,
      result: safePreparation(application.preparation.result),
    };
  });
  return app;
}
