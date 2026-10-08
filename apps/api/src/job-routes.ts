import { randomUUID } from 'node:crypto';
import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import type { Queue } from 'bullmq';
import {
  Prisma,
  findOrCreateJobApplication,
  type PrismaClient,
} from '@careerlift/database';
import {
  CareerLiftJobAdapter,
  DefaultCareerLiftJobSource,
  type CareerLiftJobSource,
} from '@careerlift/validation';
import { type Job, type ApplicationState } from '@careerlift/domain';
import type { ApplicationResolverStrategy } from '@careerlift/application-resolver';
import { authenticateBearer, createToken } from './auth.js';
import { publicUrl, publicJobApplication } from './public-views.js';
import {
  startGoogleForm,
  googleFormError,
  googleFormsDestination,
  type GoogleFormDependencies,
} from './google-form-routes.js';

export type JobRouteDependencies = GoogleFormDependencies & {
  db?: PrismaClient;
  queue?: Queue;
  authSecret?: string;
  source?: CareerLiftJobSource;
  resolver?: ApplicationResolverStrategy;
};

const JobQuerySchema = z.object({
  search: z.string().trim().optional(),
  location: z.string().trim().optional(),
  remote: z.enum(['true', 'false', 'any']).optional(),
  employmentType: z.string().trim().optional(),
  platform: z.string().trim().optional(),
  status: z
    .enum([
      'ALL',
      'NOT_APPLIED',
      'APPLIED',
      'IN_PROGRESS',
      'SUBMITTED',
      'HUMAN_REQUIRED',
    ])
    .optional(),
  page: z.coerce.number().int().min(1).default(1),
  limit: z.coerce.number().int().min(1).max(50).default(10),
});

const ParamsWithIdSchema = z.object({
  id: z.string().min(1),
});
const jobApplicationSelect = {
  id: true,
  jobId: true,
  state: true,
  updatedAt: true,
  plan: { select: { requiresHumanReview: true } },
  inspection: { select: { state: true } },
  preparation: { select: { state: true } },
  executions: {
    select: {
      mode: true,
      state: true,
      verification: { select: { state: true } },
    },
  },
} satisfies Prisma.ApplicationSelect;
function needsReview(
  app: Prisma.ApplicationGetPayload<{ select: typeof jobApplicationSelect }>,
) {
  const execution = ['REAL_EXECUTION', 'TEST_FIXTURE', 'DRY_RUN']
    .map((mode) => app.executions?.find((e) => e.mode === mode))
    .find(Boolean);
  return (
    app.state === 'HUMAN_REQUIRED' ||
    !!app.plan?.requiresHumanReview ||
    app.inspection?.state === 'HUMAN_REQUIRED' ||
    app.preparation?.state === 'HUMAN_REQUIRED' ||
    execution?.state === 'PAUSED_HUMAN_REQUIRED' ||
    execution?.verification?.state === 'HUMAN_REQUIRED'
  );
}

export function registerJobRoutes(
  app: FastifyInstance,
  dependencies: JobRouteDependencies,
) {
  // Sync Jobs from CareerLift
  app.post('/api/v1/jobs/sync', async (request, reply) => {
    const caller = authenticateBearer(
      request.headers.authorization,
      dependencies.authSecret,
    );
    if (!caller) return reply.code(401).send({ error: 'UNAUTHENTICATED' });
    if (!dependencies.db)
      return reply.code(503).send({ error: 'DATABASE_UNAVAILABLE' });

    request.log.info(
      { event: 'job_sync_started', userId: caller },
      'Starting job synchronization',
    );

    try {
      const source: CareerLiftJobSource =
        dependencies.source ?? new DefaultCareerLiftJobSource();
      const rawJobs = await source.fetchJobs();
      const adapter = new CareerLiftJobAdapter(source.applicationSource);
      let synced = 0;

      for (const raw of rawJobs) {
        try {
          const job = adapter.parse(raw);
          await dependencies.db.job.upsert({
            where: {
              source_externalId: {
                source: job.source,
                externalId: job.externalId,
              },
            },
            create: {
              id: job.id,
              externalId: job.externalId,
              source: job.source,
              company: job.company,
              title: job.title,
              location: job.location ?? null,
              employmentType: job.employmentType ?? null,
              description: job.description ?? null,
              requirements: job.requirements,
              applicationInfo: job.application
                ? (job.application as unknown as Prisma.InputJsonValue)
                : Prisma.DbNull,
              sourceUrl: job.sourceUrl ?? null,
              createdAt: job.createdAt ? new Date(job.createdAt) : new Date(),
            },
            update: {
              company: job.company,
              title: job.title,
              location: job.location ?? null,
              employmentType: job.employmentType ?? null,
              description: job.description ?? null,
              requirements: job.requirements,
              applicationInfo: job.application
                ? (job.application as unknown as Prisma.InputJsonValue)
                : Prisma.DbNull,
              sourceUrl: job.sourceUrl ?? null,
            },
          });
          synced++;
        } catch (itemError) {
          request.log.warn(
            { event: 'malformed_job_skipped', error: itemError },
            'Skipped malformed job in sync',
          );
        }
      }

      const lastSyncedAt = new Date().toISOString();
      request.log.info(
        {
          event: 'job_sync_completed',
          userId: caller,
          synced,
          total: rawJobs.length,
        },
        'Job synchronization completed',
      );

      return {
        synced,
        total: rawJobs.length,
        lastSyncedAt,
      };
    } catch (error) {
      request.log.error(
        { event: 'job_sync_failed', userId: caller, error },
        'Job synchronization failed',
      );
      return reply
        .code(500)
        .send({ error: 'SYNC_FAILED', message: 'Could not sync jobs' });
    }
  });

  // List Jobs with Search, Filters, and Pagination
  app.get('/api/v1/jobs', async (request, reply) => {
    const caller = authenticateBearer(
      request.headers.authorization,
      dependencies.authSecret,
    );
    if (!caller) return reply.code(401).send({ error: 'UNAUTHENTICATED' });
    if (!dependencies.db)
      return reply.code(503).send({ error: 'DATABASE_UNAVAILABLE' });

    const queryParsed = JobQuerySchema.safeParse(request.query);
    if (!queryParsed.success) {
      return reply.code(400).send({
        error: 'INVALID_QUERY',
        issues: queryParsed.error.issues,
      });
    }

    const {
      search,
      location,
      remote,
      employmentType,
      platform,
      status,
      page,
      limit,
    } = queryParsed.data;

    const where: Prisma.JobWhereInput = {};

    if (search) {
      where.OR = [
        { title: { contains: search, mode: 'insensitive' } },
        { company: { contains: search, mode: 'insensitive' } },
        { description: { contains: search, mode: 'insensitive' } },
      ];
    }

    if (location) {
      where.location = { contains: location, mode: 'insensitive' };
    }

    if (remote === 'true') {
      where.AND = [{ location: { contains: 'remote', mode: 'insensitive' } }];
    } else if (remote === 'false') {
      where.NOT = { location: { contains: 'remote', mode: 'insensitive' } };
    }

    if (employmentType) {
      where.employmentType = { equals: employmentType, mode: 'insensitive' };
    }

    const matchingJobs = await dependencies.db.job.findMany({
      where,
      orderBy: { createdAt: 'desc' },
    });

    const jobIds = matchingJobs.map((j) => j.id);
    const userApplications =
      jobIds.length > 0
        ? await dependencies.db.application.findMany({
            where: { userId: caller, jobId: { in: jobIds } },
            select: jobApplicationSelect,
          })
        : [];

    const appMap = new Map(userApplications.map((app) => [app.jobId, app]));

    let filteredJobs = matchingJobs;

    if (platform) {
      const platUpper = platform.toUpperCase();
      filteredJobs = filteredJobs.filter((job) => {
        const info = job.applicationInfo as Record<string, unknown> | null;
        if (!info) return platUpper === 'UNKNOWN';
        const provider =
          typeof info.provider === 'string' ? info.provider.toUpperCase() : '';
        const type =
          typeof info.type === 'string' ? info.type.toUpperCase() : '';
        return provider === platUpper || type === platUpper;
      });
    }

    if (status && status !== 'ALL') {
      filteredJobs = filteredJobs.filter((job) => {
        const app = appMap.get(job.id);
        switch (status) {
          case 'NOT_APPLIED':
            return !app;
          case 'APPLIED':
            return !!app;
          case 'IN_PROGRESS':
            return (
              !!app &&
              [
                'DISCOVERED',
                'ANALYZING',
                'RESOLVED',
                'READY',
                'EXECUTING',
                'VERIFYING',
              ].includes(app.state)
            );
          case 'SUBMITTED':
            return !!app && app.state === 'SUBMITTED';
          case 'HUMAN_REQUIRED':
            return !!app && needsReview(app);
          default:
            return true;
        }
      });
    }

    const total = filteredJobs.length;
    const totalPages = Math.ceil(total / limit) || 1;
    const paginated = filteredJobs.slice((page - 1) * limit, page * limit);

    const jobs = paginated.map((job) => {
      const app = appMap.get(job.id);
      return {
        id: job.id,
        externalId: job.externalId,
        source: job.source,
        company: job.company,
        title: job.title,
        location: job.location,
        employmentType: job.employmentType,
        description: job.description,
        requirements: job.requirements,
        application: publicJobApplication(job.applicationInfo),
        sourceUrl: publicUrl(job.sourceUrl),
        createdAt: job.createdAt.toISOString(),
        updatedAt: job.updatedAt.toISOString(),
        applicationStatus: app
          ? {
              hasApplication: true,
              applicationId: app.id,
              state: app.state,
              requiresHumanReview: needsReview(app),
              updatedAt: app.updatedAt.toISOString(),
            }
          : null,
      };
    });

    return {
      jobs,
      pagination: {
        page,
        limit,
        total,
        totalPages,
      },
    };
  });

  // Get Single Job Details
  app.get('/api/v1/jobs/:id', async (request, reply) => {
    const caller = authenticateBearer(
      request.headers.authorization,
      dependencies.authSecret,
    );
    if (!caller) return reply.code(401).send({ error: 'UNAUTHENTICATED' });
    if (!dependencies.db)
      return reply.code(503).send({ error: 'DATABASE_UNAVAILABLE' });

    const params = ParamsWithIdSchema.safeParse(request.params);
    if (!params.success)
      return reply.code(400).send({ error: 'INVALID_JOB_ID' });

    const job = await dependencies.db.job.findUnique({
      where: { id: params.data.id },
    });
    if (!job) return reply.code(404).send({ error: 'JOB_NOT_FOUND' });

    const userApp = await dependencies.db.application.findFirst({
      where: { userId: caller, jobId: job.id },
      select: jobApplicationSelect,
    });

    request.log.info(
      { event: 'job_viewed', userId: caller, jobId: job.id },
      'Job viewed',
    );

    return {
      job: {
        id: job.id,
        externalId: job.externalId,
        source: job.source,
        company: job.company,
        title: job.title,
        location: job.location,
        employmentType: job.employmentType,
        description: job.description,
        requirements: job.requirements,
        application: publicJobApplication(job.applicationInfo),
        sourceUrl: publicUrl(job.sourceUrl),
        createdAt: job.createdAt.toISOString(),
        updatedAt: job.updatedAt.toISOString(),
        applicationStatus: userApp
          ? {
              hasApplication: true,
              applicationId: userApp.id,
              state: userApp.state,
              requiresHumanReview: needsReview(userApp),
              updatedAt: userApp.updatedAt.toISOString(),
            }
          : null,
      },
    };
  });

  // Start Application from Job
  app.post('/api/v1/jobs/:id/applications', async (request, reply) => {
    const caller = authenticateBearer(
      request.headers.authorization,
      dependencies.authSecret,
    );
    if (!caller) return reply.code(401).send({ error: 'UNAUTHENTICATED' });
    if (!dependencies.db)
      return reply.code(503).send({ error: 'DATABASE_UNAVAILABLE' });

    const params = ParamsWithIdSchema.safeParse(request.params);
    if (!params.success)
      return reply.code(400).send({ error: 'INVALID_JOB_ID' });

    const job = await dependencies.db.job.findUnique({
      where: { id: params.data.id },
    });
    if (!job) return reply.code(404).send({ error: 'JOB_NOT_FOUND' });

    request.log.info(
      { event: 'application_start_requested', userId: caller, jobId: job.id },
      'Application start requested',
    );

    // Prevent duplicate applications
    const existing = await dependencies.db.application.findFirst({
      where: { userId: caller, jobId: job.id },
      include: { plan: true, inspection: true },
    });

    if (existing) {
      if (
        dependencies.googleFormsEnabled &&
        googleFormsDestination(
          dependencies,
          (job.applicationInfo as { url?: string } | null)?.url,
        )
      ) {
        try {
          await startGoogleForm(dependencies, existing.id, caller);
        } catch (error) {
          if (!(
            error instanceof Error &&
            error.message === 'GOOGLE_FORMS_RESUBMISSION_BLOCKED'
          ))
            return reply.code(409).send({ error: googleFormError(error) });
        }
      }
      request.log.info(
        {
          event: 'duplicate_application_attempt',
          userId: caller,
          jobId: job.id,
          applicationId: existing.id,
        },
        'Application already exists; returning existing record',
      );
      return reply.code(200).send({
        application: { id: existing.id, state: existing.state },
        isExisting: true,
        message: 'Application already exists for this job',
      });
    }

    // Ensure User row exists
    let user = await dependencies.db.user.findUnique({
      where: { id: caller },
    });
    if (!user) {
      user = await dependencies.db.user.create({
        data: { id: caller, email: `${caller}@local.careerlift` },
      });
    }

    const created = await findOrCreateJobApplication(
      dependencies.db,
      caller,
      job.id,
    );
    const application = created.application;
    if (created.isExisting) {
      if (
        dependencies.googleFormsEnabled &&
        googleFormsDestination(
          dependencies,
          (job.applicationInfo as { url?: string } | null)?.url,
        )
      ) {
        try {
          await startGoogleForm(dependencies, application.id, caller);
        } catch (error) {
          if (googleFormError(error) !== 'GOOGLE_FORMS_RESUBMISSION_BLOCKED')
            return reply.code(409).send({ error: googleFormError(error) });
        }
      }
      return reply.code(200).send({
        application: { id: application.id, state: application.state },
        isExisting: true,
        message: 'Application already exists for this job',
      });
    }

    const normalizedJob: Job = {
      id: job.id,
      externalId: job.externalId,
      source: job.source,
      company: job.company,
      title: job.title,
      requirements: (job.requirements as string[]) ?? [],
      ...(job.location ? { location: job.location } : {}),
      ...(job.employmentType ? { employmentType: job.employmentType } : {}),
      ...(job.description ? { description: job.description } : {}),
      ...(job.applicationInfo
        ? { application: job.applicationInfo as unknown as Job['application'] }
        : {}),
      ...(job.sourceUrl ? { sourceUrl: job.sourceUrl } : {}),
      ...(job.createdAt ? { createdAt: job.createdAt.toISOString() } : {}),
    };

    if (
      dependencies.googleFormsEnabled &&
      googleFormsDestination(dependencies, normalizedJob.application?.url)
    ) {
      // Apply is the sole automatic entry point. Job synchronization never starts runs.
      const plan = await dependencies.resolver!.resolve(normalizedJob);
      await dependencies.db.applicationPlan.upsert({
        where: { applicationId: application.id },
        create: {
          applicationId: application.id,
          applicationType: plan.applicationType,
          provider: plan.provider ?? null,
          destination: plan.destination,
          requirements: plan.requirements,
          actions: plan.actions,
          executor: plan.executor,
          confidence: plan.confidence,
          requiresHumanReview: plan.requiresHumanReview,
          reasoning: plan.reasoning,
          resolvedBy: plan.resolvedBy,
        },
        update: {},
      });
      try {
        await startGoogleForm(dependencies, application.id, caller);
      } catch (error) {
        return reply.code(503).send({
          error: googleFormError(error),
          application: { id: application.id },
        });
      }
      return reply.code(201).send({
        application: { id: application.id, state: 'RESOLVED' },
        isExisting: false,
        message: 'Google Forms application started',
      });
    }

    if (dependencies.queue) {
      try {
        await dependencies.queue.add(
          'RESOLVE_APPLICATION',
          {
            applicationId: application.id,
            job: normalizedJob,
            requestId: randomUUID(),
          },
          {
            attempts: 3,
            backoff: { type: 'exponential', delay: 1000 },
          },
        );
      } catch (queueErr) {
        request.log.error(
          { event: 'resolution_enqueue_failed', error: queueErr },
          'Failed to enqueue resolution job',
        );
      }
    } else if (dependencies.resolver) {
      try {
        const plan = await dependencies.resolver.resolve(normalizedJob);
        const resolvedState: ApplicationState =
          plan.requiresHumanReview || plan.executor === 'NONE'
            ? 'HUMAN_REQUIRED'
            : 'RESOLVED';

        await dependencies.db.$transaction(async (tx) => {
          await tx.application.update({
            where: { id: application.id },
            data: { state: resolvedState },
          });
          await tx.applicationPlan.create({
            data: {
              applicationId: application.id,
              applicationType: plan.applicationType,
              provider: plan.provider ?? null,
              destination: plan.destination,
              requirements: plan.requirements,
              actions: plan.actions,
              executor: plan.executor,
              confidence: plan.confidence,
              requiresHumanReview: plan.requiresHumanReview,
              reasoning: plan.reasoning,
              resolvedBy: plan.resolvedBy,
            },
          });
          await tx.applicationEvent.create({
            data: {
              applicationId: application.id,
              jobId: job.id,
              type:
                resolvedState === 'RESOLVED'
                  ? 'APPLICATION_RESOLVED'
                  : 'HUMAN_REVIEW_REQUIRED',
              status: resolvedState,
              data: plan.destination.target
                ? {
                    atsEvents: ['ATS_DETECTED', 'APPLICATION_TARGET_RESOLVED'],
                    platform: plan.destination.target.platform,
                    adapterVersion: plan.destination.target.adapterVersion,
                  }
                : plan.destination.unsupportedReason
                  ? {
                      atsEvents: [
                        'ATS_UNSUPPORTED',
                        'ATS_REQUIRES_HUMAN_REVIEW',
                      ],
                      code: plan.destination.unsupportedReason,
                    }
                  : {},
            },
          });
        });
        application.state = resolvedState;
      } catch (resErr) {
        request.log.error(
          { event: 'sync_resolution_failed', error: resErr },
          'Synchronous resolution failed',
        );
      }
    }

    request.log.info(
      {
        event: 'application_created',
        userId: caller,
        jobId: job.id,
        applicationId: application.id,
      },
      'Application created',
    );

    return reply.code(201).send({
      application: { id: application.id, state: application.state },
      isExisting: false,
      message: 'Application started',
    });
  });

  // Simple Auth endpoints for Session / Login in Frontend
  app.post('/api/v1/auth/login', async (request, reply) => {
    if (!dependencies.db)
      return reply.code(503).send({ error: 'DATABASE_UNAVAILABLE' });

    const bodySchema = z
      .object({
        email: z.string().trim().max(300).email().optional(),
      })
      .strict();
    const parsed = bodySchema.safeParse(request.body ?? {});
    if (!parsed.success)
      return reply.code(400).send({ error: 'INVALID_EMAIL' });
    const email =
      parsed.success && parsed.data.email
        ? parsed.data.email
        : 'demo@careerlift.local';

    const user = await dependencies.db.user.upsert({
      where: { email },
      create: { email },
      update: {},
    });
    reply.header('Cache-Control', 'no-store');

    const secret =
      dependencies.authSecret ?? 'careerlift-development-auth-secret';
    const token = createToken(user.id, secret, 86400 * 7);

    return {
      token,
      user: { id: user.id, email: user.email },
    };
  });

  app.get('/api/v1/auth/me', async (request, reply) => {
    const caller = authenticateBearer(
      request.headers.authorization,
      dependencies.authSecret,
    );
    if (!caller) return reply.code(401).send({ error: 'UNAUTHENTICATED' });
    if (!dependencies.db)
      return reply.code(503).send({ error: 'DATABASE_UNAVAILABLE' });

    const user = await dependencies.db.user.findUnique({
      where: { id: caller },
    });
    if (!user) return reply.code(404).send({ error: 'USER_NOT_FOUND' });

    return {
      user: { id: user.id, email: user.email },
    };
  });
}
