import { randomUUID } from 'node:crypto';
import { z } from 'zod';
import type { FastifyInstance } from 'fastify';
import type { Queue } from 'bullmq';
import {
  ExecutionModeSchema,
  ApplicationSchemaSchema,
  PreparedApplicationSchema,
} from '@careerlift/domain';
import {
  Prisma,
  executionApplicationInclude,
  executionInputFromApplication,
  executionInputHash,
  executionResultFromRecord,
  type PrismaClient,
} from '@careerlift/database';
import {
  InspectionError,
  validateExecutionTarget,
  type BrowserNetworkPolicy,
} from '@careerlift/browser';
import { authenticateBearer } from './auth.js';
import { safeExecution } from './safe-stage-views.js';

export type ExecutionRouteDependencies = {
  db?: PrismaClient;
  queue?: Queue;
  authSecret?: string;
  policy?: BrowserNetworkPolicy;
  executionFixtureOrigin?: string;
  allowRealExecution?: boolean;
  ashbyBrowserAssisted?: boolean;
};
export function registerExecutionRoutes(
  app: FastifyInstance,
  dependencies: ExecutionRouteDependencies,
) {
  const paramsSchema = z.object({ id: z.string().min(1) });
  const startSchema = z.object({ mode: ExecutionModeSchema }).strict();
  const resumeSchema = z.object({ executionId: z.string().min(1) }).strict();
  app.get(
    '/api/v1/applications/:id/submission-preview',
    async (request, reply) => {
      reply.header('Cache-Control', 'no-store');
      const caller = authenticateBearer(
        request.headers.authorization,
        dependencies.authSecret,
      );
      if (!caller) return reply.code(401).send({ error: 'UNAUTHENTICATED' });
      const params = paramsSchema.safeParse(request.params);
      if (!params.success)
        return reply.code(400).send({ error: 'INVALID_APPLICATION_ID' });
      if (!dependencies.db)
        return reply.code(503).send({ error: 'EXECUTION_UNAVAILABLE' });
      const application = await dependencies.db.application.findFirst({
        where: { id: params.data.id, userId: caller },
        include: executionApplicationInclude,
      });
      if (!application)
        return reply.code(404).send({ error: 'APPLICATION_NOT_FOUND' });
      const schema = ApplicationSchemaSchema.safeParse(
          application.inspection?.result,
        ),
        prepared = PreparedApplicationSchema.safeParse(
          application.preparation?.result,
        );
      if (
        !schema.success ||
        !prepared.success ||
        prepared.data.applicationId !== application.id ||
        prepared.data.inspectionId !== application.inspection?.id
      )
        return reply.code(409).send({ error: 'PREPARATION_NOT_COMPLETED' });
      return {
        version: application.preparation!.version,
        answers: [
          ...prepared.data.fields
            .filter((f) => f.value !== null)
            .map((f) => ({
              label:
                schema.data.fields.find((s) => s.id === f.fieldId)?.choiceGroup
                  ?.label ??
                schema.data.fields.find((s) => s.id === f.fieldId)?.label ??
                'Answer',
              value: f.value!,
            })),
          ...prepared.data.questions
            .filter((q) => q.answer !== null)
            .map((q) => ({
              label:
                schema.data.questions.find((s) => s.id === q.questionId)
                  ?.text ?? 'Question',
              value: q.answer!,
            })),
        ],
        documents: prepared.data.documents
          .filter((d) => d.documentId)
          .map((d) => ({
            label: d.documentType.replaceAll('_', ' '),
            name:
              application.user.documents.find((s) => s.id === d.documentId)
                ?.name ?? 'Selected document',
          })),
      };
    },
  );
  const view = (record: {
    id: string;
    applicationId: string;
    mode: string;
    state: string;
    result: unknown;
    errorCode: string | null;
  }) => ({
    executionId: record.id,
    status: record.state,
    errorCode: record.errorCode,
    result: safeExecution(record.result),
  });
  for (const resume of [false, true])
    app.post(
      `/api/v1/applications/:id/${resume ? 'execution/resume' : 'execute'}`,
      async (request, reply) => {
        const caller = authenticateBearer(
          request.headers.authorization,
          dependencies.authSecret,
        );
        if (!caller) return reply.code(401).send({ error: 'UNAUTHENTICATED' });
        const params = paramsSchema.safeParse(request.params);
        const body = (resume ? resumeSchema : startSchema).safeParse(
          request.body,
        );
        if (!params.success || !body.success)
          return reply.code(400).send({ error: 'INVALID_EXECUTION_REQUEST' });
        const { db, queue } = dependencies;
        if (!db || !queue)
          return reply.code(503).send({ error: 'EXECUTION_UNAVAILABLE' });
        const application = await db.application.findFirst({
          where: { id: params.data.id, userId: caller },
          include: executionApplicationInclude,
        });
        if (!application)
          return reply.code(404).send({ error: 'APPLICATION_NOT_FOUND' });
        if (!['RESOLVED', 'READY'].includes(application.state))
          return reply.code(409).send({ error: 'APPLICATION_NOT_EXECUTABLE' });
        let execution = resume
          ? await db.applicationExecution.findFirst({
              where: {
                id: (body.data as z.infer<typeof resumeSchema>).executionId,
                applicationId: application.id,
              },
            })
          : await db.applicationExecution.findUnique({
              where: {
                applicationId_mode: {
                  applicationId: application.id,
                  mode: (body.data as z.infer<typeof startSchema>).mode,
                },
              },
            });
        if (resume && !execution)
          return reply.code(404).send({ error: 'EXECUTION_NOT_FOUND' });
        if (!resume && execution)
          return reply
            .code(
              ['PENDING', 'PREPARING', 'RUNNING'].includes(execution.state)
                ? 202
                : 200,
            )
            .send(view(execution));
        const mode =
          execution?.mode ?? (body.data as z.infer<typeof startSchema>).mode;
        if (
          mode === 'REAL_EXECUTION' &&
          (!dependencies.allowRealExecution ||
            process.env.VITEST ||
            process.env.NODE_ENV === 'test')
        )
          return reply.code(409).send({ error: 'REAL_EXECUTION_DISABLED' });
        if (mode !== 'REAL_EXECUTION' && !dependencies.executionFixtureOrigin)
          return reply.code(409).send({ error: 'LOCAL_FIXTURE_REQUIRED' });
        const previous =
          resume && execution
            ? executionResultFromRecord(execution)
            : undefined;
        if (
          resume &&
          (execution?.state !== 'PAUSED_HUMAN_REQUIRED' ||
            !previous?.checkpoint?.resumable ||
            previous.checkpoint.unsafeActionStarted)
        )
          return reply.code(409).send({ error: 'UNSAFE_RESUME' });
        const id = execution?.id ?? randomUUID();
        let input;
        try {
          input = executionInputFromApplication(
            application,
            {
              id,
              mode,
              preparationVersion:
                execution?.preparationVersion ??
                application.preparation?.version ??
                0,
            },
            previous,
          );
          if (mode === 'REAL_EXECUTION' && !input.plan.destination.target)
            throw new Error('UNSUPPORTED_APPLICATION_PLATFORM');
          if (
            mode !== 'REAL_EXECUTION' &&
            new URL(input.inspection.finalUrl).origin !==
              dependencies.executionFixtureOrigin
          )
            throw new Error('LOCAL_FIXTURE_REQUIRED');
          await validateExecutionTarget(input, {
            ashbyBrowserAssisted: dependencies.ashbyBrowserAssisted ?? false,
            ...(dependencies.policy ? { policy: dependencies.policy } : {}),
            ...(dependencies.executionFixtureOrigin
              ? { fixtureOrigin: dependencies.executionFixtureOrigin }
              : {}),
          });
          if (execution && execution.inputHash !== executionInputHash(input))
            throw new Error('STALE_EXECUTION_INPUT');
        } catch (error) {
          return reply.code(409).send({
            error:
              error instanceof InspectionError
                ? error.code
                : 'EXECUTION_BLOCKED',
          });
        }
        if (!execution)
          execution = await db.applicationExecution.upsert({
            where: {
              applicationId_mode: { applicationId: application.id, mode },
            },
            create: {
              id,
              applicationId: application.id,
              applicationPlanId: input.applicationPlanId,
              inspectionId: input.inspectionId,
              preparationId: input.preparationId,
              preparationVersion: input.preparationVersion,
              inputHash: executionInputHash(input),
              mode,
            },
            update: {},
          });
        if (resume) {
          const changed = await db.applicationExecution.updateMany({
            where: {
              id: execution.id,
              state: 'PAUSED_HUMAN_REQUIRED',
              generation: execution.generation,
            },
            data: {
              state: 'PENDING',
              generation: { increment: 1 },
              runId: null,
              completedAt: null,
            },
          });
          if (!changed.count)
            return reply.code(409).send({ error: 'CONCURRENT_EXECUTION' });
          execution = await db.applicationExecution.findUniqueOrThrow({
            where: { id: execution.id },
          });
        }
        try {
          await queue.add(
            'EXECUTE_APPLICATION',
            {
              applicationId: application.id,
              executionId: execution.id,
              generation: execution.generation,
              requestId: request.id,
            },
            {
              jobId: `execute-${execution.id}-${execution.generation}`,
              attempts: 1,
              removeOnComplete: true,
              removeOnFail: true,
            },
          );
        } catch {
          await db.applicationExecution.updateMany({
            where: {
              id: execution.id,
              state: 'PENDING',
              generation: execution.generation,
            },
            data: {
              state: 'FAILED',
              errorCode: 'QUEUE_UNAVAILABLE',
              completedAt: new Date(),
              result: Prisma.DbNull,
            },
          });
          return reply.code(503).send({ error: 'QUEUE_UNAVAILABLE' });
        }
        return reply
          .code(202)
          .send({ executionId: execution.id, status: 'PENDING' });
      },
    );
  app.get('/api/v1/applications/:id/execution', async (request, reply) => {
    const caller = authenticateBearer(
      request.headers.authorization,
      dependencies.authSecret,
    );
    if (!caller) return reply.code(401).send({ error: 'UNAUTHENTICATED' });
    const params = paramsSchema.safeParse(request.params);
    if (!params.success)
      return reply.code(400).send({ error: 'INVALID_APPLICATION_ID' });
    const query = z
      .object({ mode: ExecutionModeSchema.optional() })
      .strict()
      .safeParse(request.query);
    if (!query.success) return reply.code(400).send({ error: 'INVALID_QUERY' });
    if (!dependencies.db)
      return reply.code(503).send({ error: 'EXECUTION_UNAVAILABLE' });
    const application = await dependencies.db.application.findFirst({
      where: { id: params.data.id, userId: caller },
    });
    if (!application)
      return reply.code(404).send({ error: 'APPLICATION_NOT_FOUND' });
    const execution = await dependencies.db.applicationExecution.findFirst({
      where: {
        applicationId: application.id,
        ...(query.data.mode ? { mode: query.data.mode } : {}),
      },
      orderBy: { updatedAt: 'desc' },
    });
    if (!execution)
      return reply.code(404).send({ error: 'EXECUTION_NOT_FOUND' });
    return view(execution);
  });
}
