import { Prisma } from '@prisma/client';
import { classifyQuestion, questionKey } from '@careerlift/domain';

export async function saveReviewedAnswer(
  tx: Prisma.TransactionClient,
  userId: string,
  question: string,
  value: string,
  category = classifyQuestion(question),
) {
  const answer = await tx.verifiedAnswer.upsert({
    where: {
      userId_category_questionKey: {
        userId,
        category,
        questionKey: questionKey(question),
      },
    },
    create: {
      userId,
      category,
      question,
      questionKey: questionKey(question),
      value,
      source: 'USER_VERIFIED',
    },
    update: {
      question,
      value,
      source: 'USER_VERIFIED',
      active: true,
      verifiedAt: new Date(),
      revision: { increment: 1 },
    },
  });
  await tx.applicationEvent.create({
    data: {
      actorId: userId,
      type: 'VERIFIED_ANSWER_UPDATED',
      data: {
        answerId: answer.id,
        revision: answer.revision,
        active: true,
        source: 'HUMAN_REVIEW',
      },
    },
  });
  return answer;
}
