import { randomUUID } from 'node:crypto';
import { z } from 'zod';
import type { Job } from 'bullmq';
import { type PrismaClient } from '@careerlift/database';
import {
  DocumentTypeSchema,
  EmailAttachmentSchema,
  EmailAddressSchema,
} from '@careerlift/domain';
import { LocalDocumentStorage } from '@careerlift/browser';
import {
  decryptSecret,
  EmailProviderError,
  type EmailProvider,
  type GmailConfig,
} from '@careerlift/email';

export function createEmailProcessor(
  db: PrismaClient,
  provider: EmailProvider | undefined,
  config: GmailConfig | undefined,
  storage: LocalDocumentStorage,
) {
  return async (task: Pick<Job, 'data'>) => {
    const input = z
      .object({
        messageId: z.string().min(1),
        revision: z.number().int().positive(),
      })
      .strict()
      .safeParse(task.data);
    if (!input.success) return;
    const { messageId: id, revision } = input.data;
    const runId = randomUUID();
    const pending = await db.emailMessage.findUnique({ where: { id } });
    if (!pending) return;
    const claimed = await db.$transaction(async (tx) => {
      await tx.$queryRaw`SELECT pg_advisory_xact_lock(hashtextextended(${`email:${pending.userId}`}, 0))::text`;
      return tx.emailMessage.updateMany({
        where: { id, revision, state: 'QUEUED' },
        data: { state: 'SENDING', runId, startedAt: new Date() },
      });
    });
    if (!claimed.count) return;
    let crossedSendBoundary = false;
    try {
      if (!config?.allowSend || !provider)
        throw new EmailProviderError('EMAIL_SENDING_DISABLED');
      const message = await db.emailMessage.findUniqueOrThrow({
        where: { id },
      });
      const account = await db.emailAccount.findUnique({
        where: { userId: message.userId },
      });
      if (
        !account?.connected ||
        !account.encryptedRefreshToken ||
        account.version !== message.accountVersion ||
        account.address !== message.from
      )
        throw new EmailProviderError('EMAIL_ACCOUNT_CHANGED');
      if (
        config.expectedSender &&
        message.from.toLowerCase() !== config.expectedSender.toLowerCase()
      )
        throw new EmailProviderError('EMAIL_ACCOUNT_CHANGED');
      if (message.applicationId) {
        const application = await db.application.findFirst({
          where: { id: message.applicationId, userId: message.userId },
          include: { plan: true },
        });
        const recipient = EmailAddressSchema.safeParse(
          (application?.plan?.destination as { email?: unknown } | null)?.email,
        );
        if (
          !application ||
          !['RESOLVED', 'READY'].includes(application.state) ||
          application.plan?.requiresHumanReview ||
          application.plan?.id !== message.planId ||
          application.plan.applicationType !== 'EMAIL' ||
          application.plan.executor !== 'EMAIL' ||
          !recipient.success ||
          recipient.data !== message.to
        )
          throw new EmailProviderError('EMAIL_DRAFT_STALE');
      }
      const selected = z
        .array(EmailAttachmentSchema)
        .parse(message.attachments);
      const attachments = [];
      for (const snapshot of selected) {
        const document = await db.userDocument.findFirst({
          where: {
            id: snapshot.id,
            userId: message.userId,
            revision: snapshot.revision,
            archivedAt: null,
          },
        });
        if (
          !document ||
          document.name !== snapshot.name ||
          document.size !== snapshot.size ||
          document.mimeType !== snapshot.mimeType ||
          (document.metadata as { contentDigest?: unknown }).contentDigest !==
            snapshot.contentDigest
        )
          throw new EmailProviderError('EMAIL_DRAFT_STALE');
        attachments.push(
          await storage.resolve(
            {
              ...document,
              type: DocumentTypeSchema.parse(document.type),
              metadata: document.metadata as Record<string, unknown>,
            },
            [],
          ),
        );
      }
      const access = await provider.accessToken(
        decryptSecret(
          account.encryptedRefreshToken,
          config.encryptionKey,
          message.userId,
        ),
      );
      // Recheck the account after auth/network preflight and before the irreversible request.
      const current = await db.emailAccount.findUnique({
        where: { userId: message.userId },
      });
      if (!current?.connected || current.version !== message.accountVersion)
        throw new EmailProviderError('EMAIL_ACCOUNT_CHANGED');
      crossedSendBoundary = true;
      const providerMessageId = await provider.send(access, {
        from: message.from,
        to: message.to,
        senderName: message.senderName,
        subject: message.subject,
        body: message.body,
        attachments,
        messageId: `<${message.id}@careerlift.local>`,
      });
      await db.$transaction(async (tx) => {
        // A late, definitive response may resolve this worker's stale UNKNOWN record.
        const changed = await tx.emailMessage.updateMany({
          where: { id, runId, state: { in: ['SENDING', 'UNKNOWN'] } },
          data: {
            state: 'SENT',
            sentAt: new Date(),
            providerMessageId,
            errorCode: null,
          },
        });
        if (changed.count && message.applicationId) {
          await tx.application.update({
            where: { id: message.applicationId },
            data: { updatedAt: new Date() },
          });
          await tx.applicationEvent.create({
            data: {
              applicationId: message.applicationId,
              actorId: message.userId,
              type: 'APPLICATION_EXECUTION_STARTED',
              message:
                'Application email accepted by Gmail; employer receipt is not established.',
              data: { channel: 'EMAIL', emailMessageId: id },
            },
          });
        }
      });
    } catch (error) {
      const uncertain =
        error instanceof EmailProviderError
          ? error.uncertain
          : crossedSendBoundary;
      const errorCode =
        error instanceof EmailProviderError
          ? error.code
          : crossedSendBoundary
            ? 'EMAIL_SEND_UNKNOWN'
            : 'EMAIL_PREFLIGHT_FAILED';
      await db.emailMessage.updateMany({
        where: { id, runId, state: 'SENDING' },
        data: { state: uncertain ? 'UNKNOWN' : 'FAILED', errorCode },
      });
    }
  };
}
export async function recoverStaleEmails(
  db: PrismaClient,
  before = new Date(Date.now() - 10 * 60 * 1000),
) {
  await db.emailMessage.updateMany({
    where: { state: 'SENDING', updatedAt: { lt: before } },
    data: { state: 'UNKNOWN', errorCode: 'EMAIL_SEND_UNKNOWN' },
  });
  await db.emailMessage.updateMany({
    where: { state: 'QUEUED', updatedAt: { lt: before } },
    data: { state: 'FAILED', errorCode: 'QUEUE_UNAVAILABLE' },
  });
  await db.emailOAuthState.deleteMany({
    where: { expiresAt: { lt: new Date() } },
  });
}
