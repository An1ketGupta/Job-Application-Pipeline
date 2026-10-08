import { z } from 'zod';
import { ApplicationDestinationUrlSchema } from './destination.js';

// Captured by inspection or a trusted provider adapter, never supplied by execute API.
export const ExecutionControlSchema = z
  .object({
    domId: z.string().min(1).max(200),
    label: z.string().min(1).max(1000),
    formId: z.string().min(1),
    htmlType: z.enum(['button', 'submit']),
    actionUrl: ApplicationDestinationUrlSchema,
    method: z.enum(['GET', 'POST']),
  })
  .strict();
export const ExecutionPageSchema = z
  .object({
    url: ApplicationDestinationUrlSchema,
    title: z.string().min(1).max(1000),
    fieldIds: z.array(z.string().min(1)).max(300),
    action: z.enum(['NEXT', 'SUBMIT']),
    control: ExecutionControlSchema,
    expectedUrl: ApplicationDestinationUrlSchema,
    // Only trusted inspection/adapters can declare a mutating Next. Absence means DOM-only Next.
    nextRequest: z
      .object({
        destination: ApplicationDestinationUrlSchema,
        method: z.literal('POST'),
        discriminator: z
          .object({
            name: z.string().min(1),
            value: z.string().min(1),
            finalValue: z.string().min(1),
          })
          .strict(),
      })
      .strict()
      .optional(),
    dynamicFields: z
      .array(
        z
          .object({
            name: z.string().min(1),
            purpose: z.enum(['CSRF', 'NONCE', 'SESSION_TOKEN']),
            origin: z.literal('INSPECTED_FORM_HIDDEN'),
          })
          .strict(),
      )
      .max(20)
      .optional(),
  })
  .strict();
export const ExecutionFlowSchema = z
  .object({
    pages: z.array(ExecutionPageSchema).min(1).max(20),
    // Real outcomes remain SUBMITTING; robust verification belongs to Phase 5.
    fixtureReceipt: z
      .object({
        successDomId: z.string().min(1),
        successText: z.string().min(1),
        failureDomId: z.string().min(1),
        failureText: z.string().min(1),
      })
      .strict()
      .optional(),
  })
  .strict();
export type ExecutionControl = z.infer<typeof ExecutionControlSchema>;
