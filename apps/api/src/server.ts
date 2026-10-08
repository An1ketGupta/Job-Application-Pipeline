import dotenv from 'dotenv';
import { resolve } from 'node:path';
import { loadConfig, resolveDocumentRoot } from '@careerlift/config';
import { createApp } from './app.js';
import { PrismaClient } from '@careerlift/database';
import { Queue } from 'bullmq';
import { Redis } from 'ioredis';
import { gmailConfigFrom, GeminiEmailDraftGenerator } from '@careerlift/email';
import { GeminiFormAnswerProvider } from '@careerlift/browser';

import {
  CareerLiftMcpJobSource,
  DefaultCareerLiftJobSource,
} from '@careerlift/validation';

// Load the shared root configuration before constructing the Gemini provider.
dotenv.config({ path: resolve(process.cwd(), '../../.env') });
const config = loadConfig();
const db = config.DATABASE_URL ? new PrismaClient() : undefined;
const connection = config.REDIS_URL
  ? new Redis(config.REDIS_URL, { maxRetriesPerRequest: null })
  : undefined;
const queue = connection
  ? new Queue('applications', { connection })
  : undefined;
const authSecret =
  process.env.INSPECTION_AUTH_SECRET ||
  process.env.AUTH_SECRET ||
  'careerlift-development-auth-secret';
const source = config.CAREERLIFT_MCP_URL
  ? new CareerLiftMcpJobSource(config.CAREERLIFT_MCP_URL, {
      ...(config.CAREERLIFT_MCP_QUERY
        ? { query: config.CAREERLIFT_MCP_QUERY }
        : {}),
      ...(config.CAREERLIFT_MCP_LOCATION
        ? { location: config.CAREERLIFT_MCP_LOCATION }
        : {}),
      ...(config.CAREERLIFT_MCP_TYPE
        ? { type: config.CAREERLIFT_MCP_TYPE }
        : {}),
      maxPages: config.CAREERLIFT_MCP_MAX_PAGES,
    })
  : new DefaultCareerLiftJobSource(
      config.CAREERLIFT_API_URL,
      config.CAREERLIFT_API_KEY,
    );
const app = createApp({
  answerConfidenceThreshold: config.ANSWER_CONFIDENCE_THRESHOLD_PERCENT / 100,
  ...(config.ANSWER_PROVIDER === 'GEMINI' && config.GEMINI_API_KEY
    ? {
        answerProvider: new GeminiFormAnswerProvider(
          config.GEMINI_API_KEY,
          config.EMAIL_GEMINI_MODEL,
        ),
      }
    : {}),
  googleFormsEnabled: config.GOOGLE_FORMS_ENABLED === 'true',
  googleFormsAccount: config.GOOGLE_FORMS_ACCOUNT,
  emailDefaultSenderName: config.EMAIL_DEFAULT_SENDER_NAME,
  ...(config.EMAIL_EXPECTED_SENDER
    ? { emailExpectedSender: config.EMAIL_EXPECTED_SENDER }
    : {}),
  ...(config.EMAIL_TEST_RECIPIENT
    ? { emailTestRecipient: config.EMAIL_TEST_RECIPIENT }
    : {}),
  ...(gmailConfigFrom(config) ? { gmail: gmailConfigFrom(config)! } : {}),
  ...(config.GEMINI_API_KEY
    ? {
        emailDraftGenerator: new GeminiEmailDraftGenerator(
          config.GEMINI_API_KEY,
          config.EMAIL_GEMINI_MODEL,
        ),
      }
    : {}),
  allowRealExecution: config.EXECUTION_ALLOW_REAL === 'true',
  autoSubmit: config.EXECUTION_AUTO_SUBMIT === 'true',
  ...(config.EXECUTION_AUTO_SUBMIT_SINCE
    ? { autoSubmitSince: config.EXECUTION_AUTO_SUBMIT_SINCE }
    : {}),
  ...(db ? { db } : {}),
  ...(queue ? { queue } : {}),
  authSecret,
  source,
  documentRoot: resolveDocumentRoot(config.EXECUTION_DOCUMENT_ROOT),
});
app.addHook('onClose', async () => {
  await queue?.close();
  await connection?.quit();
  await db?.$disconnect();
});
try {
  await app.listen({ port: config.API_PORT, host: '0.0.0.0' });
} catch (error) {
  app.log.fatal({ error }, 'API failed to start');
  process.exit(1);
}
