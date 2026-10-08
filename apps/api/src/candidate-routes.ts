import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { extname } from 'node:path';
import { resolveDocumentRoot } from '@careerlift/config';
import { Prisma } from '@careerlift/database';
import {
  ApplicationProfileSchema,
  EvidenceSchema,
  DocumentTypeSchema,
  classifyQuestion,
  questionKey,
  type ApplicationProfile,
  ResumeJobTitlesSchema,
} from '@careerlift/domain';
import { LocalDocumentStorage } from '@careerlift/browser';
import {
  candidateBoundary,
  CandidateError,
  type CandidateDependencies,
} from './candidate-http.js';

const revision = z.number().int().min(0);
const params = z.object({ id: z.string().min(1).max(200) }).strict();
const filename = z
  .string()
  .max(154)
  .regex(/^[a-zA-Z0-9][a-zA-Z0-9 _().-]{0,149}\.(pdf|txt)$/i)
  .refine(
    (v) =>
      !v.includes('..') &&
      !/^(con|prn|aux|nul|com[1-9]|lpt[1-9])(?:\.|$)/i.test(v),
    'Unsafe filename',
  );
const uploadSchema = z
  .object({
    name: filename,
    type: DocumentTypeSchema,
    jobTitles: ResumeJobTitlesSchema,
    content: z
      .string()
      .min(4)
      .max(13981016)
      .regex(/^[A-Za-z0-9+/]*={0,2}$/)
      .refine((v) => v.length % 4 === 0, 'Invalid base64 length'),
  })
  .strict();
const answerSchema = z
  .object({
    question: z.string().trim().min(3).max(1000),
    value: z.string().trim().min(1).max(10000),
    userConfirmed: z.literal(true),
  })
  .strict();
const documentView = (d: {
  id: string;
  type: string;
  name: string;
  mimeType: string;
  size: number;
  createdAt: Date;
  updatedAt: Date;
  archivedAt: Date | null;
  isDefault: boolean;
  revision: number;
  metadata?: unknown;
}) => ({
  id: d.id,
  type: d.type,
  name: d.name,
  mimeType: d.mimeType,
  size: d.size,
  createdAt: d.createdAt.toISOString(),
  updatedAt: d.updatedAt.toISOString(),
  archivedAt: d.archivedAt?.toISOString() ?? null,
  isDefault: d.isDefault,
  revision: d.revision,
  jobTitles: ResumeJobTitlesSchema.catch([]).parse(
    (d.metadata as { jobTitles?: unknown } | null)?.jobTitles,
  ),
});
const answerView = (a: {
  id: string;
  question: string;
  category: string;
  value: string;
  source: string;
  active: boolean;
  verifiedAt: Date;
  updatedAt: Date;
  revision: number;
}) => ({
  id: a.id,
  question: a.question || a.category.replaceAll('_', ' '),
  category: a.category,
  value: a.value,
  verified: a.source === 'USER_VERIFIED',
  active: a.active,
  verifiedAt: a.verifiedAt.toISOString(),
  updatedAt: a.updatedAt.toISOString(),
  revision: a.revision,
});
function parse<T extends z.ZodTypeAny>(schema: T, value: unknown): z.output<T> {
  const parsed = schema.safeParse(value);
  if (!parsed.success)
    throw new CandidateError(
      'VALIDATION_ERROR',
      400,
      parsed.error.issues
        .map((i) => `${i.path.join('.')}: ${i.message}`)
        .join('; '),
    );
  return parsed.data;
}

export function registerCandidateRoutes(
  root: FastifyInstance,
  dependencies: CandidateDependencies,
) {
  root.register(
    async (app) => {
      const owner = candidateBoundary(app, dependencies);
      const db = dependencies.db!;
      const storage = new LocalDocumentStorage(
        dependencies.documentRoot ?? resolveDocumentRoot(),
      );
      const audit = (
        tx: Prisma.TransactionClient,
        actorId: string,
        type: Prisma.ApplicationEventCreateInput['type'],
        data: Prisma.InputJsonValue,
      ) => tx.applicationEvent.create({ data: { actorId, type, data } });
      async function saveProfile(
        userId: string,
        expected: number,
        data: ApplicationProfile,
      ) {
        return db.$transaction(async (tx) => {
          if (expected === 0)
            await tx.applicationProfile.create({ data: { userId, data } });
          else {
            const changed = await tx.applicationProfile.updateMany({
              where: { userId, revision: expected },
              data: { data, revision: { increment: 1 } },
            });
            if (!changed.count)
              throw new CandidateError(
                'CONCURRENT_UPDATE',
                409,
                'Profile changed. Refresh before saving.',
              );
          }
          await audit(tx, userId, 'PROFILE_UPDATED', {
            revision: expected + 1,
          });
          const saved = await tx.applicationProfile.findUniqueOrThrow({
            where: { userId },
          });
          return {
            data: ApplicationProfileSchema.parse(saved.data),
            revision: saved.revision,
            updatedAt: saved.updatedAt.toISOString(),
          };
        });
      }
      app.get('/profile', async (request) => {
        const row = await db.applicationProfile.findUnique({
          where: { userId: owner(request) },
        });
        return {
          data: ApplicationProfileSchema.parse(row?.data ?? {}),
          revision: row?.revision ?? 0,
          updatedAt: row?.updatedAt.toISOString() ?? null,
        };
      });
      app.patch('/profile', async (request) => {
        const body = parse(
          z.object({ revision, data: ApplicationProfileSchema }).strict(),
          request.body,
        );
        return saveProfile(owner(request), body.revision, body.data);
      });
      // Structured entries remain in the one profile JSON; every change uses its revision.
      for (const section of ['experience', 'education'] as const) {
        app.get(`/profile/${section}`, async (request) => {
          const row = await db.applicationProfile.findUnique({
            where: { userId: owner(request) },
          });
          return {
            entries: ApplicationProfileSchema.parse(row?.data ?? {})[section],
            revision: row?.revision ?? 0,
          };
        });
        for (const method of ['POST', 'PATCH', 'DELETE'] as const)
          app.route({
            method,
            url: `/profile/${section}${method === 'POST' ? '' : '/:id'}`,
            handler: async (request) => {
              const userId = owner(request);
              const body = parse(
                method === 'DELETE'
                  ? z.object({ revision }).strict()
                  : z.object({ revision, entry: EvidenceSchema }).strict(),
                request.body,
              );
              const row = await db.applicationProfile.findUnique({
                where: { userId },
              });
              const profile = ApplicationProfileSchema.parse(row?.data ?? {});
              const id =
                method === 'POST'
                  ? undefined
                  : parse(params, request.params).id;
              if (id && !profile[section].some((e) => e.id === id))
                throw new CandidateError('ENTRY_NOT_FOUND', 404);
              if ((row?.revision ?? 0) !== body.revision)
                throw new CandidateError('CONCURRENT_UPDATE', 409);
              if ('entry' in body) {
                const entry = body.entry as z.infer<typeof EvidenceSchema>;
                if (
                  entry.category !==
                    (section === 'experience' ? 'EXPERIENCE' : 'EDUCATION') ||
                  (id && entry.id !== id) ||
                  (method === 'POST' &&
                    profile[section].some((e) => e.id === entry.id))
                )
                  throw new CandidateError('INVALID_ENTRY', 400);
                if (method === 'POST') profile[section].push(entry);
                else
                  profile[section] = profile[section].map((e) =>
                    e.id === id ? entry : e,
                  );
              } else
                profile[section] = profile[section].filter((e) => e.id !== id);
              return saveProfile(
                userId,
                body.revision,
                parse(ApplicationProfileSchema, profile),
              );
            },
          });
      }
      app.get('/documents', async (request) => ({
        documents: (
          await db.userDocument.findMany({
            where: { userId: owner(request) },
            orderBy: [{ createdAt: 'desc' }, { id: 'asc' }],
          })
        ).map(documentView),
      }));
      app.post(
        '/documents',
        { bodyLimit: 14 * 1024 * 1024 },
        async (request, reply) => {
          const body = parse(uploadSchema, request.body);
          const bytes = Buffer.from(body.content, 'base64');
          if (
            !bytes.length ||
            bytes.length > 10 * 1024 * 1024 ||
            bytes.toString('base64') !== body.content
          )
            throw new CandidateError(
              'INVALID_FILE_SIZE',
              400,
              'Upload a file between 1 byte and 10 MB.',
            );
          let uploaded;
          try {
            uploaded = await storage.upload(body.name, body.type, bytes);
          } catch {
            throw new CandidateError(
              'INVALID_DOCUMENT',
              400,
              'Upload a valid PDF or UTF-8 TXT file with a safe filename.',
            );
          }
          try {
            const row = await db.$transaction(async (tx) => {
              const document = await tx.userDocument.create({
                data: {
                  ...uploaded,
                  metadata: {
                    ...uploaded.metadata,
                    jobTitles: body.type === 'RESUME' ? body.jobTitles : [],
                  } as Prisma.InputJsonValue,
                  userId: owner(request),
                },
              });
              await audit(tx, owner(request), 'DOCUMENT_UPLOADED', {
                documentId: document.id,
                type: document.type,
              });
              return document;
            });
            return reply.code(201).send({ document: documentView(row) });
          } catch (error) {
            await storage.discardUpload(uploaded);
            throw error;
          }
        },
      );
      for (const method of ['PATCH', 'DELETE'] as const)
        app.route({
          method,
          url: '/documents/:id',
          handler: async (request) => {
            const { id } = parse(params, request.params);
            const userId = owner(request);
            const current = await db.userDocument.findFirst({
              where: { id, userId },
            });
            if (!current) throw new CandidateError('DOCUMENT_NOT_FOUND', 404);
            const body = parse(
              z
                .object({
                  revision,
                  name: filename.optional(),
                  isDefault: z.boolean().optional(),
                  archived: z.boolean().optional(),
                  jobTitles: ResumeJobTitlesSchema.optional(),
                })
                .strict(),
              request.body,
            );
            if (
              method === 'DELETE' &&
              (body.name ||
                body.isDefault !== undefined ||
                body.jobTitles !== undefined ||
                body.archived !== undefined)
            )
              throw new CandidateError('INVALID_REQUEST', 400);
            if (
              body.name &&
              extname(body.name).toLowerCase() !==
                extname(current.name).toLowerCase()
            )
              throw new CandidateError('INVALID_EXTENSION', 400);
            const archived = method === 'DELETE' || body.archived === true;
            if (
              body.isDefault === true &&
              (archived || (current.archivedAt && body.archived !== false))
            )
              throw new CandidateError('DOCUMENT_ARCHIVED', 409);
            if (body.isDefault === true || body.archived === false) {
              try {
                await storage.resolve(
                  {
                    ...current,
                    type: DocumentTypeSchema.parse(current.type),
                    metadata: current.metadata as Record<string, unknown>,
                  },
                  [],
                );
              } catch {
                throw new CandidateError('DOCUMENT_UNAVAILABLE', 409);
              }
            }
            return db.$transaction(
              async (tx) => {
                if (body.isDefault === true)
                  await tx.userDocument.updateMany({
                    where: {
                      userId,
                      type: current.type,
                      isDefault: true,
                      id: { not: id },
                    },
                    data: { isDefault: false, revision: { increment: 1 } },
                  });
                const changed = await tx.userDocument.updateMany({
                  where: { id, userId, revision: body.revision },
                  data: {
                    ...(body.name ? { name: body.name } : {}),
                    ...(body.jobTitles !== undefined
                      ? {
                          metadata: {
                            ...(current.metadata as Prisma.JsonObject),
                            jobTitles: body.jobTitles,
                          } as Prisma.InputJsonValue,
                        }
                      : {}),
                    ...(body.isDefault !== undefined
                      ? { isDefault: body.isDefault }
                      : {}),
                    ...(archived
                      ? { archivedAt: new Date(), isDefault: false }
                      : body.archived === false
                        ? { archivedAt: null }
                        : {}),
                    revision: { increment: 1 },
                  },
                });
                if (!changed.count)
                  throw new CandidateError('CONCURRENT_UPDATE', 409);
                await audit(
                  tx,
                  userId,
                  archived ? 'DOCUMENT_ARCHIVED' : 'DOCUMENT_UPDATED',
                  { documentId: id, isDefault: body.isDefault ?? false },
                );
                return {
                  document: documentView(
                    await tx.userDocument.findUniqueOrThrow({ where: { id } }),
                  ),
                };
              },
              { isolationLevel: Prisma.TransactionIsolationLevel.Serializable },
            );
          },
        });
      app.get('/documents/:id/content', async (request, reply) => {
        const { id } = parse(params, request.params);
        const row = await db.userDocument.findFirst({
          where: { id, userId: owner(request), archivedAt: null },
        });
        if (!row) throw new CandidateError('DOCUMENT_NOT_FOUND', 404);
        let file;
        try {
          file = await storage.resolve(
            {
              ...row,
              type: DocumentTypeSchema.parse(row.type),
              metadata: row.metadata as Record<string, unknown>,
            },
            [],
          );
        } catch {
          throw new CandidateError('DOCUMENT_UNAVAILABLE', 409);
        }
        return reply
          .header('X-Content-Type-Options', 'nosniff')
          .header(
            'Content-Disposition',
            `attachment; filename="${row.name.replaceAll('"', '')}"`,
          )
          .type(file.mimeType)
          .send(file.buffer);
      });
      app.get('/verified-answers', async (request) => ({
        answers: (
          await db.verifiedAnswer.findMany({
            where: { userId: owner(request) },
            orderBy: [{ updatedAt: 'desc' }, { id: 'asc' }],
          })
        ).map(answerView),
      }));
      app.post('/verified-answers', async (request, reply) => {
        const body = parse(answerSchema, request.body);
        const userId = owner(request);
        const row = await db.$transaction(async (tx) => {
          const answer = await tx.verifiedAnswer.create({
            data: {
              userId,
              question: body.question,
              questionKey: questionKey(body.question),
              category: classifyQuestion(body.question),
              value: body.value,
              source: 'USER_VERIFIED',
            },
          });
          await audit(tx, userId, 'VERIFIED_ANSWER_UPDATED', {
            answerId: answer.id,
            revision: answer.revision,
            active: true,
          });
          return answer;
        });
        return reply.code(201).send({ answer: answerView(row) });
      });
      app.patch('/verified-answers/:id', async (request) => {
        const { id } = parse(params, request.params);
        const userId = owner(request);
        const row = await db.verifiedAnswer.findFirst({
          where: { id, userId },
        });
        if (!row) throw new CandidateError('ANSWER_NOT_FOUND', 404);
        const body = parse(
          z
            .object({
              revision,
              question: z.string().trim().min(3).max(1000).optional(),
              value: z.string().trim().min(1).max(10000).optional(),
              active: z.boolean().optional(),
              userConfirmed: z.literal(true).optional(),
            })
            .strict(),
          request.body,
        );
        if (
          (body.question !== undefined ||
            body.value !== undefined ||
            body.active === true) &&
          !body.userConfirmed
        )
          throw new CandidateError('EXPLICIT_CONFIRMATION_REQUIRED', 400);
        return db.$transaction(async (tx) => {
          const changed = await tx.verifiedAnswer.updateMany({
            where: { id, userId, revision: body.revision },
            data: {
              ...(body.question
                ? {
                    question: body.question,
                    questionKey: questionKey(body.question),
                    category: classifyQuestion(body.question),
                  }
                : {}),
              ...(body.value ? { value: body.value } : {}),
              ...(body.active !== undefined ? { active: body.active } : {}),
              ...(body.userConfirmed
                ? { source: 'USER_VERIFIED', verifiedAt: new Date() }
                : {}),
              revision: { increment: 1 },
            },
          });
          if (!changed.count)
            throw new CandidateError('CONCURRENT_UPDATE', 409);
          await audit(tx, userId, 'VERIFIED_ANSWER_UPDATED', {
            answerId: id,
            revision: body.revision + 1,
            active: body.active ?? row.active,
          });
          return {
            answer: answerView(
              await tx.verifiedAnswer.findUniqueOrThrow({ where: { id } }),
            ),
          };
        });
      });
    },
    { prefix: '/api/v1' },
  );
}
