import type { FastifyInstance, FastifyRequest } from 'fastify';
import { Prisma, type PrismaClient } from '@careerlift/database';
import type { Queue } from 'bullmq';
import { authenticateBearer } from './auth.js';
import type { AnswerGenerationProvider } from '@careerlift/domain';

export type CandidateDependencies = {
  db?: PrismaClient;
  queue?: Queue;
  authSecret?: string;
  documentRoot?: string;
  answerProvider?: AnswerGenerationProvider;
  answerConfidenceThreshold?: number;
};
export class CandidateError extends Error {
  constructor(
    public code: string,
    public status: number,
    message = code.replaceAll('_', ' '),
  ) {
    super(message);
  }
}
export function candidateBoundary(
  app: FastifyInstance,
  dependencies: CandidateDependencies,
) {
  app.addHook('onRequest', async (request, reply) => {
    const userId = authenticateBearer(
      request.headers.authorization,
      dependencies.authSecret,
    );
    if (!userId)
      return reply
        .code(401)
        .send({ error: 'UNAUTHENTICATED', message: 'Log in to continue.' });
    if (!dependencies.db)
      return reply.code(503).send({ error: 'DATABASE_UNAVAILABLE' });
    if (
      !(await dependencies.db.user.findUnique({
        where: { id: userId },
        select: { id: true },
      }))
    )
      return reply.code(401).send({ error: 'UNAUTHENTICATED' });
    reply.header('Cache-Control', 'no-store');
  });
  app.setErrorHandler((error, request, reply) => {
    if (error instanceof CandidateError)
      return reply
        .code(error.status)
        .send({ error: error.code, message: error.message });
    if (
      error instanceof Prisma.PrismaClientKnownRequestError &&
      ['P2002', 'P2034'].includes(error.code)
    )
      return reply.code(409).send({
        error: 'CONCURRENT_UPDATE',
        message:
          'This record changed or already exists. Refresh and try again.',
      });
    const status =
      error && typeof error === 'object' && 'statusCode' in error
        ? Number(error.statusCode)
        : 0;
    if (status >= 400 && status < 500)
      return reply.code(status).send({
        error: 'INVALID_REQUEST',
        message: 'The request is invalid or too large.',
      });
    request.log.error(
      { event: 'candidate_request_failed', requestId: request.id },
      'Candidate request failed',
    );
    return reply.code(500).send({
      error: 'REQUEST_FAILED',
      message: 'Unable to save or load this information. Try again.',
    });
  });
  return (request: FastifyRequest) =>
    authenticateBearer(request.headers.authorization, dependencies.authSecret)!;
}
