import { z } from 'zod';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const ConfigSchema = z.object({
  DATABASE_URL: z.string().url().optional(),
  REDIS_URL: z.string().url().optional(),
  API_PORT: z.coerce.number().int().min(1).max(65535).default(3001),
  CAREERLIFT_API_URL: z.string().url().optional(),
  CAREERLIFT_API_KEY: z.string().optional(),
  CAREERLIFT_MCP_URL: z.string().url().optional(),
  CAREERLIFT_MCP_QUERY: z.string().trim().optional(),
  CAREERLIFT_MCP_LOCATION: z.string().trim().optional(),
  CAREERLIFT_MCP_TYPE: z
    .enum(['Internship', 'Full-time', 'Full-time Internship', 'Apprenticeship'])
    .optional(),
  CAREERLIFT_MCP_MAX_PAGES: z.coerce.number().int().min(1).max(20).default(1),
  OPENAI_API_KEY: z.string().optional(),
  EMAIL_PROVIDER_API_KEY: z.string().optional(),
  GMAIL_CLIENT_ID: z.string().optional(),
  GMAIL_CLIENT_SECRET: z.string().optional(),
  GMAIL_REDIRECT_URI: z
    .string()
    .url()
    .default('http://localhost:3001/api/v1/email/oauth/callback'),
  EMAIL_ENCRYPTION_KEY: z.string().optional(),
  EMAIL_WEB_ORIGIN: z.string().url().default('http://localhost:3000'),
  EMAIL_ALLOW_SEND: z.enum(['true', 'false']).default('false'),
  EMAIL_EXPECTED_SENDER: z.string().email().optional(),
  EMAIL_DEFAULT_SENDER_NAME: z.string().default(''),
  EMAIL_TEST_RECIPIENT: z.string().email().optional(),
  GEMINI_API_KEY: z.string().optional(),
  ANSWER_CONFIDENCE_THRESHOLD_PERCENT: z.coerce
    .number()
    .min(0)
    .max(100)
    .default(75),
  EMAIL_GEMINI_MODEL: z
    .string()
    .regex(/^[a-zA-Z0-9._-]+$/)
    .default('gemini-3.5-flash-lite'),
  BROWSER_HEADLESS: z.enum(['true', 'false']).default('true'),
  GOOGLE_FORMS_ENABLED: z.enum(['true', 'false']).default('false'),
  GOOGLE_FORMS_ACCOUNT: z
    .string()
    .email()
    .default('guptaaniket600.ag@gmail.com'),
  GOOGLE_FORMS_GEMINI_MODEL: z
    .string()
    .regex(/^[a-zA-Z0-9._-]+$/)
    .optional(),
  ANSWER_PROVIDER: z.enum(['NONE', 'MOCK', 'GEMINI']).default('GEMINI'),
  EXECUTION_ALLOW_REAL: z.enum(['true', 'false']).default('false'),
  EXECUTION_DOCUMENT_ROOT: z.string().min(1).default('./documents'),
});
export type AppConfig = z.infer<typeof ConfigSchema>;
// Preserve the existing worker storage location for relative configuration while
// sharing exactly that root with the API, regardless of either process's cwd.
export function resolveDocumentRoot(path = './documents'): string {
  return resolve(
    fileURLToPath(new URL('../../../apps/worker/', import.meta.url)),
    path,
  );
}
export function loadConfig(env: NodeJS.ProcessEnv = process.env): AppConfig {
  const parsed = ConfigSchema.safeParse({
    ...env,
    CAREERLIFT_API_URL: env.CAREERLIFT_API_URL || undefined,
    CAREERLIFT_MCP_URL: env.CAREERLIFT_MCP_URL || undefined,
    CAREERLIFT_MCP_TYPE: env.CAREERLIFT_MCP_TYPE || undefined,
    CAREERLIFT_MCP_MAX_PAGES: env.CAREERLIFT_MCP_MAX_PAGES || undefined,
    GMAIL_CLIENT_ID: env.GMAIL_CLIENT_ID || undefined,
    GMAIL_CLIENT_SECRET: env.GMAIL_CLIENT_SECRET || undefined,
    EMAIL_ENCRYPTION_KEY: env.EMAIL_ENCRYPTION_KEY || undefined,
    EMAIL_EXPECTED_SENDER: env.EMAIL_EXPECTED_SENDER || undefined,
    EMAIL_TEST_RECIPIENT: env.EMAIL_TEST_RECIPIENT || undefined,
    GOOGLE_FORMS_GEMINI_MODEL: env.GOOGLE_FORMS_GEMINI_MODEL || undefined,
    ANSWER_CONFIDENCE_THRESHOLD_PERCENT:
      env.ANSWER_CONFIDENCE_THRESHOLD_PERCENT || undefined,
  });
  if (!parsed.success)
    throw new Error(
      `Invalid environment configuration: ${parsed.error.message}`,
    );
  return parsed.data;
}
export function requireRedisUrl(config: AppConfig): string {
  if (!config.REDIS_URL)
    throw new Error('REDIS_URL is required to start the worker');
  return config.REDIS_URL;
}
