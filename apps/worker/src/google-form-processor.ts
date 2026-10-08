import { randomUUID } from 'node:crypto';
import { z } from 'zod';
import { type Job as QueueJob, UnrecoverableError } from 'bullmq';
import { logger } from '@careerlift/logging';
import {
  Prisma,
  type PrismaClient,
  googleCandidateInput,
  googleCandidateInclude,
} from '@careerlift/database';
import {
  GoogleFormSnapshotSchema,
  GoogleFormQuestionSchema,
  prepareGoogleQuestions,
  googleFormIdentity,
  type GoogleFormSnapshot,
  type AnswerGenerationProvider,
} from '@careerlift/domain';
import {
  GoogleFormsBrowser,
  GoogleAccountLogin,
  WindowsGoogleSessionVault,
  googleSessionState,
  LocalDocumentStorage,
  extractResumeContext,
  selectApplicationResume,
  type GooglePageInspection,
} from '@careerlift/browser';

const payload = z
  .object({ runId: z.string().min(1), version: z.number().int().positive() })
  .strict();
type Live = {
  browser: GoogleFormsBrowser;
  timer: ReturnType<typeof setTimeout>;
  page: number;
};
const visibleBrowserInteractionErrors = new Set([
  'GOOGLE_FORMS_UPLOAD_REQUIRES_BROWSER',
  'GOOGLE_FORMS_UPLOAD_NOT_CONFIRMED',
  'GOOGLE_FORMS_VALIDATION_FAILED',
  'GOOGLE_FORMS_SECTION_DID_NOT_ADVANCE',
]);
export function isGoogleFormsVisibleBrowserInteractionError(error: unknown) {
  return (
    error instanceof Error && visibleBrowserInteractionErrors.has(error.message)
  );
}
export type GoogleFormProcessorOptions = {
  enabled: boolean;
  account: string;
  documents: Pick<LocalDocumentStorage, 'resolve'>;
  provider?: AnswerGenerationProvider | undefined;
  confidenceThreshold?: number;
  fixtureOrigin?: string;
  headless?: boolean;
};
export function createGoogleFormProcessor(
  db: PrismaClient,
  options: GoogleFormProcessorOptions,
) {
  const live = new Map<string, Live>(),
    logins = new Map<
      string,
      {
        login: GoogleAccountLogin;
        generation: number;
        timer: ReturnType<typeof setTimeout>;
      }
    >();
  const vault = new WindowsGoogleSessionVault();
  const release = async (id: string) => {
    const session = live.get(id);
    if (session) {
      live.delete(id);
      clearTimeout(session.timer);
      await session.browser.close();
    }
  };
  async function sessionTask(task: QueueJob) {
    const parsed = z
      .object({
        userId: z.string().min(1),
        generation: z.number().int().positive(),
        action: z.enum(['connect', 'confirm', 'disconnect']),
      })
      .strict()
      .parse(task.data);
    const row = await db.googleFormSession.findUnique({
      where: { userId: parsed.userId },
    });
    if (!row || row.generation !== parsed.generation) return;
    const previous = logins.get(parsed.userId);
    if (parsed.action === 'connect' || parsed.action === 'disconnect') {
      if (previous) {
        clearTimeout(previous.timer);
        await previous.login.close();
        logins.delete(parsed.userId);
      }
      if (parsed.action === 'disconnect') {
        const owned = await db.googleFormRun.findMany({
          where: { userId: parsed.userId, submitStartedAt: null },
          select: { id: true },
        });
        for (const run of owned) await release(run.id);
        return;
      }
      try {
        const login = await GoogleAccountLogin.open();
        const timer = setTimeout(
          () => {
            void login.close();
            logins.delete(parsed.userId);
            void db.googleFormSession.updateMany({
              where: {
                userId: parsed.userId,
                generation: parsed.generation,
                state: 'CONNECTING',
              },
              data: {
                state: 'DISCONNECTED',
                errorCode: 'GOOGLE_FORMS_SESSION_LOST',
              },
            });
          },
          30 * 60 * 1000,
        );
        timer.unref();
        logins.set(parsed.userId, {
          login,
          generation: parsed.generation,
          timer,
        });
      } catch {
        await db.googleFormSession.updateMany({
          where: { userId: parsed.userId, generation: parsed.generation },
          data: {
            state: 'DISCONNECTED',
            errorCode: 'GOOGLE_FORMS_BROWSER_UNAVAILABLE',
          },
        });
      }
      return;
    }
    if (!previous || previous.generation !== parsed.generation) {
      await db.googleFormSession.updateMany({
        where: { userId: parsed.userId, generation: parsed.generation },
        data: { state: 'DISCONNECTED', errorCode: 'GOOGLE_FORMS_SESSION_LOST' },
      });
      return;
    }
    try {
      const state = await previous.login.confirm(options.account);
      const encryptedState = await vault.seal(state);
      await db.googleFormSession.updateMany({
        where: {
          userId: parsed.userId,
          generation: parsed.generation,
          state: 'CONNECTING',
        },
        data: {
          state: 'CONNECTED',
          account: options.account,
          encryptedState,
          errorCode: null,
        },
      });
      clearTimeout(previous.timer);
      await previous.login.close();
      logins.delete(parsed.userId);
    } catch (error) {
      await db.googleFormSession.updateMany({
        where: { userId: parsed.userId, generation: parsed.generation },
        data: {
          errorCode:
            error instanceof Error &&
            /^GOOGLE_FORMS_[A-Z_]+$/.test(error.message)
              ? error.message
              : 'GOOGLE_FORMS_AUTHENTICATION_REQUIRED',
        },
      });
    }
  }
  async function process(task: QueueJob) {
    if (!options.enabled) throw new UnrecoverableError('GOOGLE_FORMS_DISABLED');
    if (task.name === 'GOOGLE_FORM_SESSION') return sessionTask(task);
    if (task.name !== 'GOOGLE_FORM_APPLICATION')
      throw new UnrecoverableError('Invalid Google Forms task');
    const parsed = payload.parse(task.data);
    let run = await db.googleFormRun.findUnique({
      where: { id: parsed.runId },
    });
    if (
      !run ||
      run.version !== parsed.version ||
      run.state !== 'PENDING' ||
      run.submitStartedAt
    )
      return;
    const lease = randomUUID();
    const claimed = await db.googleFormRun.updateMany({
      where: {
        id: run.id,
        version: run.version,
        state: 'PENDING',
        submitStartedAt: null,
      },
      data: { state: 'RUNNING', runId: lease, errorCode: null },
    });
    if (claimed.count !== 1) return;
    const runId = run.id;
    let submitStarted = false;
    let submissionObservation: {
      transportOutcome: string;
      [key: string]: unknown;
    } | null = null;
    const heartbeat = setInterval(() => {
      live.get(runId)?.timer.refresh();
      void db.googleFormRun
        .updateMany({
          where: {
            id: runId,
            runId: lease,
            state: { in: ['RUNNING', 'SUBMITTING'] },
          },
          data: { updatedAt: new Date() },
        })
        .catch(() => {});
    }, 30000);
    heartbeat.unref();
    const write = async (data: Prisma.GoogleFormRunUpdateManyMutationInput) => {
      const updated = await db.googleFormRun.updateMany({
        where: { id: runId, runId: lease, version: run!.version },
        data,
      });
      if (updated.count !== 1) throw new Error('GOOGLE_FORMS_LEASE_LOST');
    };
    const application = await db.application.findUniqueOrThrow({
      where: { id: run.applicationId },
      include: googleCandidateInclude,
    });
    let session: Live | undefined;
    try {
      if (
        application.userId !== run.userId ||
        application.state === 'SUBMITTED' ||
        application.executions.some(
          (e) =>
            e.mode === 'REAL_EXECUTION' &&
            ['SUBMITTING', 'SUBMITTED', 'SUBMISSION_UNKNOWN'].includes(e.state),
        )
      )
        throw new Error('GOOGLE_FORMS_RESUBMISSION_BLOCKED');
      const candidate = googleCandidateInput(application);
      const url = candidate.job.application?.url;
      const fixture = Boolean(
        options.fixtureOrigin &&
        url &&
        new URL(url).origin === options.fixtureOrigin &&
        run.test,
      );
      if (!url || (!googleFormIdentity(url) && !fixture))
        throw new Error('GOOGLE_FORMS_DESTINATION_REQUIRED');
      const stored = GoogleFormSnapshotSchema.safeParse(run.snapshot);
      if (
        stored.success &&
        stored.data.page > 0 &&
        stored.data.inputDigest !== candidate.inputDigest
      )
        throw new Error('GOOGLE_FORMS_INPUT_CHANGED');
      session = live.get(runId);
      if (
        session &&
        (!session.browser.alive() || (!stored.success && session.page > 0))
      ) {
        await release(runId);
        session = undefined;
      }
      const replay =
        stored.success && (!session || session.page < stored.data.page);
      if (
        replay &&
        stored.data.completedPages.some((completed) => !completed.snapshot)
      )
        throw new Error('GOOGLE_FORMS_REPLAY_UNAVAILABLE');
      if (!session) {
        let state;
        const account = application.user.googleFormSession;
        if (
          account?.state === 'CONNECTED' &&
          account.account === options.account &&
          account.encryptedState
        )
          state = await vault.open(account.encryptedState);
        const browser = await GoogleFormsBrowser.open({
          url,
          storage: options.documents,
          ...(state ? { state } : {}),
          ...(fixture ? { fixtureOrigin: options.fixtureOrigin! } : {}),
          ...(options.headless !== undefined
            ? { headless: options.headless }
            : {}),
        });
        const timer = setTimeout(
          () => {
            void release(runId);
          },
          30 * 60 * 1000,
        );
        timer.unref();
        session = { browser, timer, page: 0 };
        live.set(runId, session);
      }
      session.timer.refresh();
      await session.browser.finishHumanInteraction();
      let page = session.page;
      let completed: GoogleFormSnapshot['completedPages'] = stored.success
        ? stored.data.completedPages.slice(0, page)
        : [];
      let inspection: GooglePageInspection | null = null;
      for (; page < 100; page++) {
        inspection = await session.browser.inspect();
        if (
          inspection.challenge ||
          inspection.authentication ||
          (inspection.account &&
            inspection.account.toLowerCase() !== options.account.toLowerCase())
        ) {
          await session.browser.allowHumanInteraction();
          await write({
            state: 'BROWSER_REQUIRED',
            errorCode: inspection.challenge
              ? 'GOOGLE_FORMS_CAPTCHA'
              : inspection.authentication
                ? 'GOOGLE_FORMS_AUTHENTICATION_REQUIRED'
                : 'GOOGLE_FORMS_ACCOUNT_MISMATCH',
            runId: null,
          });
          return;
        }
        if (!inspection.next && !inspection.submit)
          throw new Error('GOOGLE_FORMS_FORM_UNAVAILABLE');
        const previousPage =
          replay && stored.success && page < stored.data.page
            ? stored.data.completedPages[page]
            : undefined;
        const checkpoint =
          stored.success && page === stored.data.page
            ? stored.data
            : previousPage?.snapshot;
        const fingerprint =
          stored.success && page === stored.data.page
            ? stored.data.fingerprint
            : previousPage?.fingerprint;
        if (
          replay &&
          stored.success &&
          page < stored.data.page &&
          !previousPage?.snapshot
        )
          throw new Error('GOOGLE_FORMS_SESSION_LOST');
        if (fingerprint && fingerprint !== inspection.fingerprint)
          throw new Error('GOOGLE_FORMS_FORM_CHANGED');
        const decisions =
          checkpoint &&
          stored.success &&
          stored.data.inputDigest === candidate.inputDigest
            ? checkpoint.decisions
            : {};
        const hasResumeControl = inspection.questions.some(
          (question) =>
            question.kind === 'FILE' && question.documentType === 'RESUME',
        );
        const selection = await prepareGoogleQuestions({
          questions: hasResumeControl
            ? inspection.questions
            : [
                ...inspection.questions,
                GoogleFormQuestionSchema.parse({
                  id: 'candidate-context-resume',
                  label: 'Resume',
                  kind: 'FILE',
                  required: false,
                  documentType: 'RESUME',
                }),
              ],
          ...candidate,
          decisions,
        });
        const selectedResumeId = selection.find(
          (answer) =>
            answer.documentId &&
            candidate.documents.some(
              (document) =>
                document.id === answer.documentId && document.type === 'RESUME',
            ),
        )?.documentId;
        const selectedResume = selectedResumeId
          ? candidate.documents.find(
              (document) => document.id === selectedResumeId,
            )
          : candidate.documents.filter((document) => document.type === 'RESUME')
                .length > 1
            ? undefined
            : selectApplicationResume(candidate.documents);
        const resumeContext = options.provider?.generateAnswers
          ? await extractResumeContext(options.documents, selectedResume)
          : undefined;
        if (
          resumeContext &&
          !selectedResume &&
          candidate.documents.filter((d) => d.type === 'RESUME').length > 1
        )
          resumeContext.status = 'AMBIGUOUS';
        const answers =
          checkpoint &&
          stored.success &&
          stored.data.inputDigest === candidate.inputDigest &&
          checkpoint.answers.every((answer) => !answer.review)
            ? checkpoint.answers
            : await prepareGoogleQuestions({
                questions: inspection.questions,
                ...candidate,
                decisions,
                provider: options.provider,
                ...(resumeContext ? { resumeContext } : {}),
                ...(options.confidenceThreshold !== undefined
                  ? { confidenceThreshold: options.confidenceThreshold }
                  : {}),
              });
        const snapshot: GoogleFormSnapshot = {
          title: inspection.title,
          url: inspection.url,
          fingerprint: inspection.fingerprint,
          page,
          questions: inspection.questions,
          answers,
          decisions,
          inputDigest: candidate.inputDigest,
          completedPages: completed,
        };
        // Preserve the latest checkpoint until replay reaches that section.
        if (!previousPage)
          await write({ snapshot: snapshot as Prisma.InputJsonValue, page });
        if (answers.some((answer) => answer.review)) {
          session.timer.refresh();
          await write({ state: 'REVIEW', runId: null });
          await db.application.updateMany({
            where: { id: application.id, state: { not: 'SUBMITTED' } },
            data: { state: 'HUMAN_REQUIRED' },
          });
          await db.applicationEvent.create({
            data: {
              applicationId: application.id,
              type: 'HUMAN_REVIEW_REQUIRED',
              status: 'HUMAN_REQUIRED',
              data: {
                workflow: 'GOOGLE_FORM',
                page,
                count: answers.filter((a) => a.review).length,
              },
            },
          });
          return;
        }
        await session.browser.fill(answers, candidate.documents);
        const reinspection = await session.browser.inspect();
        if (
          reinspection.fingerprint !== inspection.fingerprint ||
          reinspection.authentication ||
          reinspection.challenge
        )
          throw new Error('GOOGLE_FORMS_FORM_CHANGED');
        await session.browser.validateFilled(answers);
        if (inspection.next) {
          await session.browser.next(
            {
              applicationId: application.id,
              runId,
              userId: run.userId,
              version: run.version,
            },
            {
              authorize: async () => {
                const owner = await db.application.findUniqueOrThrow({
                  where: { id: application.id },
                  include: googleCandidateInclude,
                });
                const leaseRow = await db.googleFormRun.findFirst({
                  where: {
                    id: runId,
                    runId: lease,
                    version: run!.version,
                    state: 'RUNNING',
                  },
                });
                if (
                  !leaseRow ||
                  googleCandidateInput(owner).inputDigest !==
                    candidate.inputDigest
                )
                  throw new Error('GOOGLE_FORMS_INPUT_CHANGED');
              },
              transport: async (outcome, response) => {
                await write({
                  confirmation: {
                    action: 'NEXT',
                    outcome,
                    ...(response ?? {}),
                  },
                });
              },
            },
          );
          completed = [
            ...completed,
            {
              fingerprint: inspection.fingerprint,
              questionCount: inspection.questions.length,
              reviewedCount: answers.filter((a) => a.source === 'REVIEW')
                .length,
              snapshot: { questions: inspection.questions, answers, decisions },
            },
          ];
          session.page = page + 1;
          // Retain approved section answers so a lost browser can rebuild the form.
          continue;
        }
        const currentApplication = await db.application.findUniqueOrThrow({
          where: { id: application.id },
          include: googleCandidateInclude,
        });
        if (
          googleCandidateInput(currentApplication).inputDigest !==
          candidate.inputDigest
        )
          throw new Error('GOOGLE_FORMS_INPUT_CHANGED');
        await session.browser.prepareSubmit({
          applicationId: application.id,
          runId,
          userId: run.userId,
          version: run.version,
        });
        await db.$transaction(async (tx) => {
          const changed = await tx.googleFormRun.updateMany({
            where: {
              id: runId,
              runId: lease,
              state: 'RUNNING',
              version: run!.version,
              submitStartedAt: null,
            },
            data: { state: 'SUBMITTING' },
          });
          if (changed.count !== 1) throw new Error('GOOGLE_FORMS_LEASE_LOST');
          await tx.application.updateMany({
            where: { id: application.id, state: { not: 'SUBMITTED' } },
            data: { state: 'EXECUTING' },
          });
          await tx.applicationEvent.create({
            data: {
              applicationId: application.id,
              type: 'APPLICATION_EXECUTION_STARTED',
              status: 'EXECUTING',
              data: { workflow: 'GOOGLE_FORM', runId, test: run!.test },
            },
          });
        });
        const outcome = await session.browser.submit(
          {
            applicationId: application.id,
            runId,
            userId: run.userId,
            version: run.version,
          },
          {
            authorize: async () => {
              const latest = await db.googleFormRun.findFirst({
                where: {
                  id: runId,
                  runId: lease,
                  version: run!.version,
                  state: 'SUBMITTING',
                  userId: run!.userId,
                  submitStartedAt: null,
                },
              });
              const owner = await db.application.findUniqueOrThrow({
                where: { id: application.id },
                include: googleCandidateInclude,
              });
              if (
                !latest ||
                owner.userId !== run!.userId ||
                owner.state === 'SUBMITTED' ||
                googleCandidateInput(owner).inputDigest !==
                  candidate.inputDigest
              )
                throw new Error('GOOGLE_FORMS_INPUT_CHANGED');
              // Persist immediately before the transport can send any response bytes.
              const dispatch = await db.googleFormRun.updateMany({
                where: {
                  id: runId,
                  runId: lease,
                  version: run!.version,
                  state: 'SUBMITTING',
                  submitStartedAt: null,
                },
                data: { submitStartedAt: new Date() },
              });
              if (dispatch.count !== 1)
                throw new Error('GOOGLE_FORMS_LEASE_LOST');
              submitStarted = true;
            },
            transport: async (transportOutcome, response) => {
              submissionObservation = { transportOutcome, ...(response ?? {}) };
              if (transportOutcome === 'REJECTED') submitStarted = false;
              await write({
                ...(transportOutcome === 'REJECTED'
                  ? { submitStartedAt: null }
                  : {}),
                confirmation: {
                  transportOutcome,
                  ...(response ?? {}),
                  runId,
                  test: run!.test,
                },
              });
            },
          },
        );
        await db.$transaction(async (tx) => {
          const changed = await tx.googleFormRun.updateMany({
            where: {
              id: runId,
              runId: lease,
              version: run!.version,
              state: 'SUBMITTING',
            },
            data: {
              state: outcome.confirmed
                ? 'SUBMITTED'
                : submitStarted
                  ? 'UNKNOWN'
                  : 'BLOCKED',
              submittedAt: outcome.confirmed ? new Date() : null,
              runId: null,
              errorCode: outcome.confirmed
                ? null
                : submitStarted
                  ? 'GOOGLE_FORMS_OUTCOME_UNKNOWN'
                  : 'GOOGLE_FORMS_SUBMISSION_NOT_DISPATCHED',
              confirmation: {
                ...(submissionObservation ?? {}),
                dispatchStarted: submitStarted,
                confirmed: outcome.confirmed,
                ...(outcome.response ?? {}),
                confirmationDigest: outcome.confirmed
                  ? outcome.confirmationDigest
                  : null,
                runId,
                test: run!.test,
              },
            },
          });
          if (changed.count !== 1) throw new Error('GOOGLE_FORMS_LEASE_LOST');
          await tx.application.update({
            where: { id: application.id },
            data: {
              state:
                outcome.confirmed && !run!.test
                  ? 'SUBMITTED'
                  : 'HUMAN_REQUIRED',
            },
          });
          await tx.applicationEvent.create({
            data: {
              applicationId: application.id,
              type: outcome.confirmed
                ? 'APPLICATION_SUBMITTED'
                : 'HUMAN_REVIEW_REQUIRED',
              status:
                outcome.confirmed && !run!.test
                  ? 'SUBMITTED'
                  : 'HUMAN_REQUIRED',
              data: {
                workflow: 'GOOGLE_FORM',
                runId,
                test: run!.test,
                outcome: outcome.confirmed ? 'CONFIRMED' : 'UNKNOWN',
              },
            },
          });
        });
        if (
          !fixture &&
          application.user.googleFormSession?.state === 'CONNECTED'
        ) {
          const encryptedState = await vault.seal(
            googleSessionState(await session.browser.context.storageState()),
          );
          await db.googleFormSession.updateMany({
            where: {
              userId: application.userId,
              generation: application.user.googleFormSession.generation,
              state: 'CONNECTED',
            },
            data: { encryptedState },
          });
        }
        await release(runId);
        return;
      }
      throw new Error('GOOGLE_FORMS_SECTION_LIMIT');
    } catch (error) {
      const code =
        error instanceof Error && /^GOOGLE_FORMS_[A-Z_]+$/.test(error.message)
          ? error.message
          : 'GOOGLE_FORMS_WORKER_FAILED';
      // Record the rejected endpoint without cookies, query strings or answer/file bodies.
      const networkFailure = session?.browser.networkFailure();
      if (networkFailure)
        logger.warn(
          { runId, ...networkFailure },
          'Google Forms request blocked',
        );
      let browserRequired =
        !submitStarted &&
        isGoogleFormsVisibleBrowserInteractionError(error) &&
        Boolean(session?.browser.alive());
      if (browserRequired) {
        try {
          await session!.browser.allowHumanInteraction();
        } catch {
          browserRequired = false;
        }
      }
      await db.googleFormRun.updateMany({
        where: { id: runId, runId: lease },
        data: {
          state: submitStarted
            ? 'UNKNOWN'
            : browserRequired
              ? 'BROWSER_REQUIRED'
              : 'BLOCKED',
          runId: null,
          errorCode: submitStarted ? 'GOOGLE_FORMS_OUTCOME_UNKNOWN' : code,
          ...(!submitStarted ? { submitStartedAt: null } : {}),
          confirmation: {
            ...(submissionObservation ?? {}),
            dispatchStarted: submitStarted,
            errorCode: code,
            ...(networkFailure ? { networkFailure } : {}),
          } as Prisma.InputJsonValue,
        },
      });
      await db.application.updateMany({
        where: { id: application.id, state: { not: 'SUBMITTED' } },
        data: { state: 'HUMAN_REQUIRED' },
      });
      // Keep a pre-submission browser available for inspection and recovery.
      if (submitStarted) await release(runId);
      else session?.timer.refresh();
    } finally {
      clearInterval(heartbeat);
      run = null;
    }
  }
  return {
    process,
    close: async () => {
      for (const id of live.keys()) await release(id);
      for (const login of logins.values()) {
        clearTimeout(login.timer);
        await login.login.close();
      }
      logins.clear();
    },
  };
}
export async function recoverGoogleFormRuns(
  db: PrismaClient,
  olderThan = new Date(Date.now() - 5 * 60 * 1000),
) {
  await db.googleFormRun.updateMany({
    where: {
      state: { in: ['RUNNING', 'SUBMITTING'] },
      updatedAt: { lt: olderThan },
      submitStartedAt: { not: null },
    },
    data: {
      state: 'UNKNOWN',
      runId: null,
      errorCode: 'GOOGLE_FORMS_OUTCOME_UNKNOWN',
    },
  });
  await db.googleFormRun.updateMany({
    where: {
      state: { in: ['PENDING', 'RUNNING', 'SUBMITTING'] },
      updatedAt: { lt: olderThan },
      submitStartedAt: null,
    },
    data: {
      state: 'BLOCKED',
      runId: null,
      errorCode: 'GOOGLE_FORMS_SESSION_LOST',
    },
  });
}
