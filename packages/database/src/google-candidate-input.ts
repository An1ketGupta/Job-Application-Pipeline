import { createHash } from 'node:crypto';
import { Prisma } from '@prisma/client';
import {
  ApplicationProfileSchema,
  UserDocumentSchema,
  VerifiedAnswerSchema,
  JobSchema,
} from '@careerlift/domain';

export const googleCandidateInclude = {
  job: true,
  executions: true,
  user: {
    include: {
      profile: true,
      documents: { where: { archivedAt: null }, orderBy: { id: 'asc' } },
      verifiedAnswers: {
        where: { active: true, source: 'USER_VERIFIED' },
        orderBy: { id: 'asc' },
      },
      googleFormSession: true,
    },
  },
} as const;
type ApplicationInput = Prisma.ApplicationGetPayload<{
  include: typeof googleCandidateInclude;
}>;
export function googleCandidateInput(application: ApplicationInput) {
  const profile = ApplicationProfileSchema.parse(
    application.user.profile?.data ?? {},
  );
  const documents = application.user.documents.map((d) =>
    UserDocumentSchema.parse({
      id: d.id,
      name: d.name,
      type: d.type,
      mimeType: d.mimeType,
      size: d.size,
      storageRef: d.storageRef,
      metadata: {
        ...(d.metadata as Record<string, unknown>),
        isDefault: d.isDefault,
      },
    }),
  );
  const verified = application.user.verifiedAnswers.map((a) =>
    VerifiedAnswerSchema.parse({
      id: a.id,
      category: a.category,
      question: a.question,
      questionKey: a.questionKey,
      value: a.value,
      source: 'USER_VERIFIED',
      verifiedAt: a.verifiedAt.toISOString(),
    }),
  );
  const record = application.job;
  const job = JobSchema.parse({
    id: record.id,
    externalId: record.externalId,
    source: record.source,
    title: record.title,
    company: record.company,
    requirements: record.requirements,
    location: record.location ?? undefined,
    employmentType: record.employmentType ?? undefined,
    description: record.description ?? undefined,
    sourceUrl: record.sourceUrl ?? undefined,
    application: record.applicationInfo ?? undefined,
    createdAt: record.createdAt.toISOString(),
  });
  const inputDigest = createHash('sha256')
    .update(
      JSON.stringify({
        profile,
        revision: application.user.profile?.revision,
        documents,
        verified,
        job,
        session: application.user.googleFormSession?.generation,
      }),
    )
    .digest('hex');
  return {
    profile,
    documents,
    verified,
    job,
    email: application.user.email,
    inputDigest,
  };
}
