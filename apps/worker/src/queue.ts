import { Queue } from 'bullmq';
import { Redis } from 'ioredis';
import { z } from 'zod';
import { JobSchema } from '@careerlift/domain';

export const QUEUE_NAME = 'applications';
export const QueueJobTypeSchema = z.enum([
  'GOOGLE_FORM_APPLICATION',
  'GOOGLE_FORM_SESSION',
  'RESOLVE_APPLICATION',
  'INSPECT_APPLICATION',
  'PREPARE_APPLICATION',
  'EXECUTE_APPLICATION',
  'VERIFY_SUBMISSION',
  'VERIFY_APPLICATION',
  'SEND_EMAIL',
  'BROWSER_APPLICATION',
  'HUMAN_INTERVENTION',
]);
export const ResolveJobDataSchema = z
  .object({
    applicationId: z.string().min(1),
    job: JobSchema,
    requestId: z.string().min(1),
  })
  .strict();
export type ResolveJobData = z.infer<typeof ResolveJobDataSchema>;
export const InspectJobDataSchema = z
  .object({ applicationId: z.string().min(1), requestId: z.string().min(1) })
  .strict();
export type InspectJobData = z.infer<typeof InspectJobDataSchema>;
export const PrepareJobDataSchema = InspectJobDataSchema;
export const ExecuteJobDataSchema = z
  .object({
    applicationId: z.string().min(1),
    executionId: z.string().min(1),
    generation: z.number().int().positive(),
    requestId: z.string().min(1),
  })
  .strict();
export const VerifyJobDataSchema = z
  .object({
    executionId: z.string().min(1),
    applicationId: z.string().min(1),
    userId: z.string().min(1),
    generation: z.number().int().positive(),
  })
  .strict();
export async function enqueueVerification(
  queue: Queue,
  data: z.infer<typeof VerifyJobDataSchema>,
) {
  const valid = VerifyJobDataSchema.parse(data);
  await queue.add('VERIFY_SUBMISSION', valid, {
    jobId: `verify-${valid.executionId}-${valid.generation}`,
    attempts: 1,
    removeOnComplete: true,
    removeOnFail: true,
  });
}

export function createRedisConnection(url: string): Redis {
  return new Redis(url, { maxRetriesPerRequest: null });
}
export function createApplicationQueue(connection: Redis): Queue {
  return new Queue(QUEUE_NAME, { connection });
}
export async function enqueueResolution(
  queue: Queue,
  data: ResolveJobData,
): Promise<void> {
  const valid = ResolveJobDataSchema.parse(data);
  await queue.add('RESOLVE_APPLICATION', valid, {
    attempts: 3,
    backoff: { type: 'exponential', delay: 1000 },
  });
}
export async function enqueueInspection(
  queue: Queue,
  data: InspectJobData,
): Promise<void> {
  const valid = InspectJobDataSchema.parse(data);
  await queue.add('INSPECT_APPLICATION', valid, {
    jobId: `inspect-${valid.applicationId}`,
    attempts: 2,
    backoff: { type: 'exponential', delay: 1000 },
    removeOnComplete: true,
    removeOnFail: true,
  });
}
