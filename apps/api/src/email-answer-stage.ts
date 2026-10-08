import { createHash, randomUUID } from 'node:crypto';
import { z } from 'zod';
import { Prisma, type PrismaClient } from '@careerlift/database';
import {
  ApplicationProfileSchema,
  VerifiedAnswerSchema,
  UserDocumentSchema,
  EmailAnswerStageSchema,
  resolveCandidateAnswers,
  questionKey,
  classifyField,
  profileValue,
  type AnswerGenerationProvider,
  type EmailAnswerStage,
} from '@careerlift/domain';
import {
  extractResumeContext,
  type LocalDocumentStorage,
} from '@careerlift/browser';
import { CandidateError } from './candidate-http.js';

export async function latestEmailAnswerStage(
  db: PrismaClient | Prisma.TransactionClient,
  applicationId: string,
) {
  const event = await db.applicationEvent.findFirst({
    where: {
      applicationId,
      type: 'PREPARATION_SNAPSHOT',
      data: { path: ['workflow'], equals: 'EMAIL_ANSWERS' },
    },
    orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
  });
  const parsed = EmailAnswerStageSchema.safeParse(
    (event?.data as { stage?: unknown } | null)?.stage,
  );
  return parsed.success ? parsed.data : null;
}
export async function storeEmailAnswerStage(
  db: PrismaClient | Prisma.TransactionClient,
  applicationId: string,
  userId: string,
  stage: EmailAnswerStage,
) {
  await db.applicationEvent.create({
    data: {
      applicationId,
      actorId: userId,
      type: 'PREPARATION_SNAPSHOT',
      data: {
        workflow: 'EMAIL_ANSWERS',
        stage,
      } as unknown as Prisma.InputJsonValue,
    },
  });
}

export async function emailAnswerContext(
  db: PrismaClient | Prisma.TransactionClient,
  applicationId: string,
  userId: string,
  resumeId: string | null,
  threshold: number,
) {
  const application = await db.application.findFirstOrThrow({
    where: { id: applicationId, userId },
    include: {
      job: true,
      user: {
        include: {
          profile: true,
          verifiedAnswers: {
            where: { active: true, source: 'USER_VERIFIED' },
            orderBy: { id: 'asc' },
          },
          documents: { where: { archivedAt: null } },
        },
      },
    },
  });
  const profile = ApplicationProfileSchema.parse(
    application.user.profile?.data ?? {},
  );
  const verifiedAnswers = application.user.verifiedAnswers.map((answer) =>
    VerifiedAnswerSchema.parse({
      id: answer.id,
      question: answer.question,
      questionKey: answer.questionKey,
      category: answer.category,
      value: answer.value,
      source: 'USER_VERIFIED',
      verifiedAt: answer.verifiedAt.toISOString(),
    }),
  );
  const resume = resumeId
    ? application.user.documents.find(
        (document) => document.id === resumeId && document.type === 'RESUME',
      )
    : undefined;
  if (resumeId && !resume)
    throw new CandidateError('DOCUMENT_UNAVAILABLE', 409);
  const job = {
    title: application.job.title,
    company: application.job.company,
    ...(application.job.description
      ? { description: application.job.description }
      : {}),
    requirements: z.array(z.string()).parse(application.job.requirements),
  };
  const inputHash = createHash('sha256')
    .update(
      JSON.stringify({
        profile,
        profileRevision: application.user.profile?.revision,
        verifiedAnswers,
        job,
        resume,
        threshold,
      }),
    )
    .digest('hex');
  return {
    profile,
    verifiedAnswers,
    resume,
    job,
    inputHash,
    email: application.user.email,
  };
}

export async function prepareEmailAnswerStage(
  db: PrismaClient,
  applicationId: string,
  userId: string,
  resumeId: string | null,
  storage: LocalDocumentStorage,
  provider: AnswerGenerationProvider,
  threshold: number,
) {
  const { profile, verifiedAnswers, resume, job, inputHash, email } =
    await emailAnswerContext(db, applicationId, userId, resumeId, threshold);
  const previous = await latestEmailAnswerStage(db, applicationId);
  if (previous?.inputHash === inputHash) return previous;
  let questions;
  const instructionsHash = createHash('sha256')
    .update(JSON.stringify(job))
    .digest('hex');
  let discoveryFailed = false;
  try {
    if (!provider.discoverQuestions) throw new Error('DISCOVERY_UNAVAILABLE');
    questions =
      previous?.instructionsHash === instructionsHash &&
      !previous.discoveryFailed
        ? previous.questions
        : await provider.discoverQuestions(
            `${job.description ?? ''}\n${job.requirements.join('\n')}`,
          );
  } catch {
    discoveryFailed = true;
    questions = [
      {
        id: 'email-instructions-review',
        question:
          'Review the email application instructions and provide any requested candidate information (or confirm that none is requested).',
        category: 'CUSTOM_QUESTION' as const,
        fieldType: 'TEXT',
        options: [],
      },
    ];
  }
  const known: EmailAnswerStage['answers'] = [];
  const unresolved = questions.filter((question) => {
    if (discoveryFailed) return true;
    const saved = verifiedAnswers.filter(
      (answer) => answer.questionKey === questionKey(question.question),
    );
    if (saved.length > 1) {
      known.push({
        id: question.id,
        answer: null,
        confidence: 0,
        evidenceIds: [],
        requiresHumanReview: true,
        reason: 'Conflicting verified answers. Review this answer.',
      });
      return false;
    }
    const semantic = classifyField({
      id: question.id,
      label: question.question,
      type: 'TEXT',
      required: true,
      visible: true,
      disabled: false,
      readonly: false,
      options: [],
      source: 'DOM',
    }).semanticType;
    const value = saved[0]?.value ?? profileValue(semantic, profile, email);
    if (value) {
      known.push({
        id: question.id,
        answer: value,
        confidence: 1,
        evidenceIds: [],
        requiresHumanReview: false,
        reason: saved.length
          ? 'Uses your verified answer.'
          : 'Uses your saved profile.',
      });
      return false;
    }
    return true;
  });
  const resumeContext = await extractResumeContext(
    storage,
    resume
      ? UserDocumentSchema.parse({
          id: resume.id,
          name: resume.name,
          type: resume.type,
          mimeType: resume.mimeType,
          size: resume.size,
          storageRef: resume.storageRef,
          metadata: resume.metadata,
        })
      : undefined,
  );
  const generated = discoveryFailed
    ? unresolved.map((question) => ({
        id: question.id,
        answer: null,
        confidence: 0,
        evidenceIds: [],
        requiresHumanReview: true,
        reason:
          'Gemini could not inspect the email instructions. Review the job description before continuing.',
      }))
    : await resolveCandidateAnswers(
        {
          questions: unresolved,
          profile,
          email,
          resume: resumeContext,
          verifiedAnswers,
          job,
        },
        provider,
        threshold,
      );
  const stage = EmailAnswerStageSchema.parse({
    id: randomUUID(),
    inputHash,
    instructionsHash,
    discoveryFailed,
    resumeId,
    questions,
    answers: [...known, ...generated],
  });
  // One snapshot commits at a time; a cached or reviewed stage wins a concurrent generation.
  return db.$transaction(async (tx) => {
    await tx.$queryRaw`SELECT pg_advisory_xact_lock(hashtextextended(${`email-answers:${applicationId}`}, 0))::text`;
    const current = await latestEmailAnswerStage(tx, applicationId);
    if (current?.inputHash === inputHash) return current;
    await storeEmailAnswerStage(tx, applicationId, userId, stage);
    return stage;
  });
}
