import { z } from 'zod';
import type { FastifyInstance } from 'fastify';
import {
  ensureSubmissionVerification,
  refreshVerification,
  humanVerification,
  verificationInclude,
  type PrismaClient,
} from '@careerlift/database';
import type { Queue } from 'bullmq';
import { authenticateBearer } from './auth.js';
import { safeVerification } from './safe-stage-views.js';

export function registerVerificationRoutes(
  app: FastifyInstance,
  dependencies: { db?: PrismaClient; queue?: Queue; authSecret?: string },
) {
  const paramsSchema = z.object({ id: z.string().min(1).max(200) });
  for (const operation of [
    'status',
    'evidence',
    'check',
    'confirm',
    'reject',
  ] as const) {
    app.route({
      method:
        operation === 'status' || operation === 'evidence' ? 'GET' : 'POST',
      url: `/api/v1/executions/:id/verification${operation === 'status' ? '' : `/${operation}`}`,
      handler: async (request, reply) => {
        const userId = authenticateBearer(
          request.headers.authorization,
          dependencies.authSecret,
        );
        if (!userId) return reply.code(401).send({ error: 'UNAUTHENTICATED' });
        const params = paramsSchema.safeParse(request.params);
        if (!params.success)
          return reply.code(400).send({ error: 'INVALID_EXECUTION_ID' });
        const db = dependencies.db;
        if (!db)
          return reply.code(503).send({ error: 'VERIFICATION_UNAVAILABLE' });
        const execution = await db.applicationExecution.findFirst({
          where: { id: params.data.id, application: { userId } },
          include: {
            application: {
              include: {
                job: { select: { id: true, company: true, title: true } },
              },
            },
          },
        });
        if (!execution)
          return reply.code(404).send({ error: 'EXECUTION_NOT_FOUND' });
        let verification;
        try {
          verification = await ensureSubmissionVerification(db, execution.id);
        } catch {
          return reply
            .code(409)
            .send({ error: 'EXECUTION_NOT_READY_FOR_VERIFICATION' });
        }
        if (operation === 'evidence') {
          return {
            executionId: execution.id,
            evidenceCount: await db.verificationEvidence.count({
              where: { verificationId: verification.id },
            }),
          };
        }
        if (operation === 'status') {
          const record = await db.submissionVerification.findUniqueOrThrow({
            where: { id: verification.id },
            include: verificationInclude,
          });
          return {
            executionId: execution.id,
            executionStatus: execution.state,
            submissionStatus:
              record.state === 'NOT_REQUIRED'
                ? 'NOT_ATTEMPTED'
                : record.state === 'CONFIRMED' ||
                    (['PENDING', 'VERIFYING'].includes(record.state) &&
                      record.establishedState === 'CONFIRMED')
                  ? 'SUBMITTED'
                  : record.state === 'REJECTED' ||
                      (['PENDING', 'VERIFYING'].includes(record.state) &&
                        record.establishedState === 'REJECTED')
                    ? 'FAILED'
                    : 'UNKNOWN',
            verification: safeVerification(record),
            humanReview:
              record.state === 'HUMAN_REQUIRED'
                ? {
                    reason:
                      'Submission acceptance could not be established safely.',
                    applicationId: execution.applicationId,
                    job: execution.application.job,
                    message:
                      'CareerLift attempted the application but cannot safely determine whether it was accepted.',
                    attemptCount: record.attempts.length,
                    evidenceCount: record.evidence.length,
                  }
                : null,
          };
        }
        if (operation === 'confirm' || operation === 'reject') {
          const body = (
            operation === 'confirm'
              ? z.object({ confirmed: z.literal(true) }).strict()
              : z.object({ rejected: z.literal(true) }).strict()
          ).safeParse(request.body);
          if (!body.success)
            return reply
              .code(400)
              .send({ error: 'EXPLICIT_HUMAN_DECISION_REQUIRED' });
          try {
            return safeVerification(
              await humanVerification(
                db,
                execution.id,
                userId,
                operation === 'confirm' ? 'CONFIRMED' : 'REJECTED',
              ),
            );
          } catch {
            return reply
              .code(409)
              .send({ error: 'HUMAN_DECISION_BLOCKED_BY_STATE_OR_EVIDENCE' });
          }
        }
        if (
          !z
            .object({})
            .strict()
            .safeParse(request.body ?? {}).success
        )
          return reply
            .code(400)
            .send({ error: 'INVALID_VERIFICATION_REQUEST' });
        const queue = dependencies.queue;
        if (!queue) return reply.code(503).send({ error: 'QUEUE_UNAVAILABLE' });
        if (verification.state === 'NOT_REQUIRED')
          return reply.code(409).send({ error: 'VERIFICATION_NOT_REQUIRED' });
        if (verification.state === 'VERIFYING')
          return reply.code(202).send({
            verificationId: verification.id,
            state: verification.state,
          });
        if (verification.state !== 'PENDING') {
          try {
            verification = await refreshVerification(db, execution.id, userId);
          } catch {
            return reply
              .code(409)
              .send({ error: 'CONCURRENT_OR_INVALID_VERIFICATION' });
          }
        }
        try {
          await queue.add(
            'VERIFY_SUBMISSION',
            {
              executionId: execution.id,
              applicationId: execution.applicationId,
              userId,
              generation: verification.generation,
            },
            {
              jobId: `verify-${execution.id}-${verification.generation}`,
              attempts: 1,
              removeOnComplete: true,
              removeOnFail: true,
            },
          );
        } catch {
          // Leave PENDING durable: the recovery scanner repairs the enqueue gap.
          return reply.code(503).send({
            error: 'QUEUE_UNAVAILABLE',
            verificationId: verification.id,
          });
        }
        return reply
          .code(202)
          .send({ verificationId: verification.id, state: verification.state });
      },
    });
  }
}
