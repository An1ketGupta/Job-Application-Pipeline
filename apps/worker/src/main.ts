import dotenv from 'dotenv';
import { resolve } from 'node:path';
import { Worker } from 'bullmq';
import { PrismaClient } from '@careerlift/database';
import { MockAnswerGenerationProvider } from '@careerlift/domain';
import {
  BrowserApplicationExecutor,
  LocalDocumentStorage,
  GeminiFormAnswerProvider,
  AshbySubmissionVerifier,
} from '@careerlift/browser';
import {
  createGoogleFormProcessor,
  recoverGoogleFormRuns,
} from './google-form-processor.js';
import {
  createExecutionProcessor,
  failStaleExecutions,
} from './execution-processor.js';
import {
  createVerificationProcessor,
  reconcileSubmissions,
} from './verification-processor.js';
import { CompositeApplicationResolver } from '@careerlift/application-resolver';
import {
  loadConfig,
  requireRedisUrl,
  resolveDocumentRoot,
} from '@careerlift/config';
import { logger } from '@careerlift/logging';
import {
  requestAutomaticExecution,
  recoverAutomaticExecutions,
} from './automatic-execution.js';
import {
  QUEUE_NAME,
  createRedisConnection,
  createApplicationQueue,
} from './queue.js';
import { createResolutionProcessor } from './processor.js';

// Keep the long-running worker watcher aligned with browser login changes.
import { GmailProvider, gmailConfigFrom } from '@careerlift/email';
import { createEmailProcessor, recoverStaleEmails } from './email-processor.js';
import {
  createInspectionProcessor,
  failStaleInspections,
} from './inspection-processor.js';
import {
  createPreparationProcessor,
  failStalePreparations,
} from './preparation-processor.js';

dotenv.config({ path: resolve(process.cwd(), '../../.env') });
const config = loadConfig();
if (!config.DATABASE_URL)
  throw new Error('DATABASE_URL is required to start the worker');
const connection = createRedisConnection(requireRedisUrl(config));
const db = new PrismaClient();
const queue = createApplicationQueue(connection);
const automaticSince = new Date(
  config.EXECUTION_AUTO_SUBMIT_SINCE ?? Date.now(),
);
const automaticSubmission =
  config.EXECUTION_ALLOW_REAL === 'true' &&
  config.EXECUTION_AUTO_SUBMIT === 'true';
const verifyTask = createVerificationProcessor(db, [
  new AshbySubmissionVerifier(),
]);
const resolveTask = createResolutionProcessor(
  db,
  new CompositeApplicationResolver(),
);
const inspectTask = createInspectionProcessor(db);
const gmail = gmailConfigFrom(config);
const emailTask = createEmailProcessor(
  db,
  gmail ? new GmailProvider(gmail) : undefined,
  gmail,
  new LocalDocumentStorage(resolveDocumentRoot(config.EXECUTION_DOCUMENT_ROOT)),
);
const browserExecutor = new BrowserApplicationExecutor({
  documents: new LocalDocumentStorage(
    resolveDocumentRoot(config.EXECUTION_DOCUMENT_ROOT),
  ),
  allowRealExecution: config.EXECUTION_ALLOW_REAL === 'true',
});
const executeTask = createExecutionProcessor(db, browserExecutor);
const answerProvider =
  config.ANSWER_PROVIDER === 'MOCK'
    ? new MockAnswerGenerationProvider()
    : config.ANSWER_PROVIDER === 'GEMINI' && config.GEMINI_API_KEY
      ? new GeminiFormAnswerProvider(
          config.GEMINI_API_KEY,
          config.EMAIL_GEMINI_MODEL,
        )
      : undefined;
const googleForms = createGoogleFormProcessor(db, {
  enabled: config.GOOGLE_FORMS_ENABLED === 'true',
  account: config.GOOGLE_FORMS_ACCOUNT,
  documents: new LocalDocumentStorage(
    resolveDocumentRoot(config.EXECUTION_DOCUMENT_ROOT),
  ),
  provider: answerProvider,
  confidenceThreshold: config.ANSWER_CONFIDENCE_THRESHOLD_PERCENT / 100,
});
const prepareTask = createPreparationProcessor(db, answerProvider, {
  confidenceThreshold: config.ANSWER_CONFIDENCE_THRESHOLD_PERCENT / 100,
  documentRoot: resolveDocumentRoot(config.EXECUTION_DOCUMENT_ROOT),
  ...(automaticSubmission
    ? {
        onPrepared: (applicationId: string) =>
          requestAutomaticExecution(db, queue, applicationId),
      }
    : {}),
});
const worker = new Worker(
  QUEUE_NAME,
  (task) =>
    task.name === 'GOOGLE_FORM_APPLICATION' ||
    task.name === 'GOOGLE_FORM_SESSION'
      ? googleForms.process(task)
      : task.name === 'SEND_EMAIL_APPLICATION'
        ? emailTask(task)
        : task.name === 'VERIFY_SUBMISSION'
          ? verifyTask(task)
          : task.name === 'EXECUTE_APPLICATION'
            ? executeTask(task)
            : task.name === 'INSPECT_APPLICATION'
              ? inspectTask(task)
              : task.name === 'PREPARE_APPLICATION'
                ? prepareTask(task)
                : resolveTask(task),
  { connection },
);
worker.on('error', (error) => logger.error({ error }, 'Worker error'));
worker.on('failed', (task, error) =>
  logger.error(
    { event: 'queue.failed', taskId: task?.id, error },
    'Queue task failed',
  ),
);
const staleTimer = setInterval(() => {
  void recoverGoogleFormRuns(db).catch(() =>
    logger.error(
      { event: 'google_forms.recovery_failed' },
      'Google Forms recovery failed',
    ),
  );
  void recoverStaleEmails(db).catch(() =>
    logger.error({ event: 'email.recovery_failed' }, 'Email recovery failed'),
  );
  void failStaleExecutions(db, new Date(Date.now() - 120_000)).catch(() =>
    logger.error(
      { event: 'execution.stale_check_failed' },
      'Execution stale check failed',
    ),
  );
  void failStaleInspections(db, new Date(Date.now() - 120_000)).catch((error) =>
    logger.error({ error }, 'Stale inspection recovery failed'),
  );
  void failStalePreparations(db, new Date(Date.now() - 120_000)).catch(
    (error) => logger.error({ error }, 'Stale preparation recovery failed'),
  );
}, 60_000);
let recovering = false;
async function recover() {
  if (recovering) return;
  recovering = true;
  try {
    if (automaticSubmission)
      await recoverAutomaticExecutions(db, queue, automaticSince);
    await failStaleExecutions(db, new Date(Date.now() - 120_000));
    await reconcileSubmissions(db, queue);
  } catch {
    logger.error(
      { event: 'verification.recovery_failed' },
      'Submission recovery failed',
    );
  } finally {
    recovering = false;
  }
}
void recover();
const recoveryTimer = setInterval(() => {
  void recover();
}, 10000);
logger.info({ event: 'worker.started', queue: QUEUE_NAME }, 'Worker listening');
async function shutdown() {
  await googleForms.close();
  clearInterval(staleTimer);
  clearInterval(recoveryTimer);
  await worker.close();
  await browserExecutor.close();
  await queue.close();
  await connection.quit();
  await db.$disconnect();
}
process.on('SIGINT', () => {
  void shutdown().then(() => process.exit(0));
});
process.on('SIGTERM', () => {
  void shutdown().then(() => process.exit(0));
});
