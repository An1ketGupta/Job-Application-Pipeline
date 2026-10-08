import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { Prisma, type PrismaClient } from '@careerlift/database';
import {
  ApplicationStateSchema,
  VerificationStateSchema,
  ApplicationSummarySchema,
  ApplicationDetailsSchema,
  PreparedApplicationSchema,
  ApplicationSchemaSchema,
  canPrepareInspection,
  canRetryEmptyInspection,
  canRepairChoiceInspection,
  canRepairSubmissionInspection,
  ashbySubmissionBlocker,
  ApplicationPlanSchema,
} from '@careerlift/domain';
import { authenticateBearer } from './auth.js';
import {
  googleFormRunSelect,
  googleFormSummary,
} from './google-form-routes.js';

const querySchema = z
  .object({
    search: z.string().trim().max(200).default(''),
    status: ApplicationStateSchema.optional(),
    verification: VerificationStateSchema.optional(),
    review: z.enum(['true']).optional(),
    sort: z.enum(['updated', 'newest', 'oldest']).default('updated'),
    page: z.coerce.number().int().min(1).max(100000).default(1),
    limit: z.coerce.number().int().min(1).max(50).default(10),
  })
  .strict();
const paramsSchema = z.object({ id: z.string().min(1).max(200) });
const stageSelect = {
  state: true,
  startedAt: true,
  completedAt: true,
  updatedAt: true,
  errorCode: true,
} as const;
const auditLabels: Record<string, string> = {
  SUBMISSION_ATTEMPTED: 'Submission attempt recorded',
  SUBMISSION_RESPONSE_RECEIVED: 'Submission response received',
  SUBMISSION_UNKNOWN: 'Submission outcome unknown',
  VERIFICATION_STARTED: 'Verification started',
  VERIFICATION_COMPLETED: 'Verification check completed',
  VERIFICATION_CONFIRMED: 'Submission verified',
  VERIFICATION_REJECTED: 'External submission rejected',
  VERIFICATION_UNKNOWN: 'Verification outcome unknown',
  VERIFICATION_FAILED: 'Verification service failed',
  HUMAN_REVIEW_REQUIRED: 'Human review requested',
  HUMAN_CONFIRMED: 'Submission confirmed by user',
  HUMAN_REJECTED: 'Submission rejected by user',
  RECOVERY_STARTED: 'Verification recovery requested',
  RECOVERY_COMPLETED: 'Verification recovery completed',
};
const eventLabels: Record<string, string> = {
  HUMAN_REVIEW_RESOLVED: 'Human review decision saved',
  HUMAN_REVIEW_REJECTED: 'Proposed answer rejected by user',
  PREPARATION_SNAPSHOT: 'Preparation snapshot recorded',
  JOB_DISCOVERED: 'Application created',
  APPLICATION_ANALYSIS_STARTED: 'Application analysis started',
  APPLICATION_RESOLVED: 'Application destination resolved',
  APPLICATION_RESOLUTION_FAILED: 'Application resolution failed',
  HUMAN_REVIEW_REQUIRED: 'Human review requested',
  APPLICATION_EXECUTION_STARTED: 'Application execution started',
  APPLICATION_SUBMITTED: 'Application recorded as submitted',
  APPLICATION_FAILED: 'Application failed',
  APPLICATION_INSPECTION_STARTED: 'Application inspection started',
  APPLICATION_INSPECTED: 'Application inspected',
  APPLICATION_INSPECTION_FAILED: 'Application inspection failed',
};
const summarySelect = {
  id: true,
  state: true,
  createdAt: true,
  updatedAt: true,
  job: {
    select: {
      id: true,
      title: true,
      company: true,
      location: true,
      employmentType: true,
      source: true,
    },
  },
  plan: {
    select: {
      applicationType: true,
      provider: true,
      requiresHumanReview: true,
      destination: true,
      createdAt: true,
    },
  },
  inspection: {
    select: { ...stageSelect, id: true, applicationPlanId: true, result: true },
  },
  preparation: { select: stageSelect },
  emailMessage: { select: { state: true, updatedAt: true, sentAt: true } },
  googleFormRun: { select: googleFormRunSelect },
  executions: {
    take: 3,
    orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
    select: {
      mode: true,
      ...stageSelect,
      verification: {
        select: {
          state: true,
          establishedState: true,
          updatedAt: true,
          _count: { select: { evidence: true, attempts: true } },
          events: {
            where: {
              type: { in: ['VERIFICATION_CONFIRMED', 'HUMAN_CONFIRMED'] },
            },
            orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
            take: 1,
            select: { type: true, createdAt: true },
          },
        },
      },
    },
  },
} satisfies Prisma.ApplicationSelect;
const detailsSelect = {
  ...summarySelect,
  inspection: summarySelect.inspection,
  preparation: { select: { ...stageSelect, result: true } },
  events: {
    orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
    take: 101,
    select: { id: true, type: true, createdAt: true, data: true },
  },
  executions: {
    ...summarySelect.executions,
    select: {
      ...summarySelect.executions.select,
      verification: {
        select: {
          ...summarySelect.executions.select.verification.select,
          events: {
            where: { type: { in: Object.keys(auditLabels) } },
            orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
            take: 101,
            select: { id: true, type: true, createdAt: true },
          },
        },
      },
    },
  },
} satisfies Prisma.ApplicationSelect;
type Row = Prisma.ApplicationGetPayload<{ select: typeof summarySelect }>;
type DetailRow = Prisma.ApplicationGetPayload<{ select: typeof detailsSelect }>;
const date = (value: Date | null) => value?.toISOString() ?? null;
const inspectionReviewMessages = {
  CAPTCHA: 'The employer form requires a CAPTCHA or human verification.',
  AUTHENTICATION_REQUIRED: 'The employer form requires you to sign in.',
  INTERACTIVE_DISCOVERY_REQUIRED:
    'No application fields were detected. Retry inspection to reload the form, or check it on the employer site.',
  SENSITIVE_QUESTION:
    'The form contains questions that need explicit candidate answers.',
  UNEXPECTED_NAVIGATION:
    'The application destination changed unexpectedly and needs review.',
  PLATFORM_MISMATCH:
    'The detected application platform does not match the planned destination.',
  UNSUPPORTED_INTERACTION:
    'The form requires an interaction that automatic inspection does not support.',
} as const;
function inspectionReviewReasons(row: Row) {
  if (row.inspection?.state !== 'HUMAN_REQUIRED') return [];
  const parsed = ApplicationSchemaSchema.safeParse(row.inspection.result);
  const reasons = parsed.success ? parsed.data.humanReview.reasons : [];
  return reasons.length
    ? reasons.map((reason) => inspectionReviewMessages[reason])
    : [
        issue(row.inspection.errorCode, row.inspection.state) ??
          'The inspected form needs your review.',
      ];
}
function issue(code: string | null, state: string) {
  const explanations: Record<string, string> = {
    CAPTCHA:
      'The employer requires reCAPTCHA. Complete this application on the employer site.',
    ASHBY_FORM_CHANGED:
      'The employer form changed. Reinspect and prepare it before submitting.',
    ASHBY_REQUEST_REJECTED:
      'Ashby rejected a request. Check the employer form before continuing.',
    ASHBY_INVALID_RESPONSE:
      'The employer response could not be interpreted. Check the submission outcome on the employer site.',
    ASHBY_UNSUPPORTED_FIELD:
      'A field requires a browser interaction. Complete this application on the employer site.',
    ASHBY_SURVEY_REVIEW_REQUIRED:
      'The employer survey forms require manual completion.',
    UNSAFE_DESTINATION:
      'The destination failed security validation. Review is required.',
    AUTHENTICATION_OR_SECURITY_CHALLENGE:
      'The platform requires authentication or security review. Automation has stopped.',
    APPLICATION_CLOSED:
      'This application is closed or unavailable. Check the employer site.',
    UNTRUSTED_FIXTURE_TARGET:
      'This application target is unavailable in the configured test environment.',
    HTTP_ERROR:
      'The application page is unavailable or closed. Check the employer site.',
    DNS_FAILURE: 'The application host could not be reached.',
    CONNECTION_FAILURE: 'The application page could not be reached.',
    NAVIGATION_TIMEOUT: 'The application page timed out during inspection.',
    INSPECTION_TIMEOUT: 'The application form could not be inspected in time.',
    FORM_FIELDS_NOT_FOUND:
      'No application fields were detected after waiting for the page to render. Retry inspection or check the employer form.',
    UNEXPECTED_NAVIGATION:
      'The application destination changed unexpectedly. Human review is required.',
    MUTATING_REQUEST_BLOCKED:
      'This page requires an interaction that read-only inspection cannot safely perform. Human review is required.',
    EXECUTION_INPUT_CHANGED:
      'The application plan changed. Execution has stopped.',
  };
  if (code && explanations[code]) return explanations[code];
  if (code === 'QUEUE_UNAVAILABLE')
    return 'The worker queue is unavailable. Refresh to check for progress.';
  if (['FAILED', 'BLOCKED'].includes(state))
    return 'The agent could not complete this stage. Review the application before continuing.';
  if (['HUMAN_REQUIRED', 'PAUSED_HUMAN_REQUIRED'].includes(state))
    return 'This stage needs your review before the agent can continue.';
  return code
    ? 'This stage encountered a problem. Refresh or open review for details.'
    : null;
}
function stage(row: {
  state: string;
  startedAt: Date | null;
  completedAt: Date | null;
  updatedAt: Date;
  errorCode: string | null;
}) {
  return {
    state: row.state,
    startedAt: date(row.startedAt),
    completedAt: date(row.completedAt),
    updatedAt: row.updatedAt.toISOString(),
    issue: issue(row.errorCode, row.state),
  };
}
function executionSummary(row: Row['executions'][number]) {
  const v = row.verification;
  return {
    ...stage(row),
    mode: row.mode,
    verification: v
      ? {
          state: v.state,
          establishedState: v.establishedState,
          updatedAt: v.updatedAt.toISOString(),
          verifiedAt:
            v.events
              .find((e) =>
                ['VERIFICATION_CONFIRMED', 'HUMAN_CONFIRMED'].includes(e.type),
              )
              ?.createdAt.toISOString() ?? null,
          evidenceCount: v._count.evidence,
          attemptCount: v._count.attempts,
          summary:
            v.state === 'CONFIRMED'
              ? 'Acceptance confirmed by the verification service or an explicit human decision.'
              : v.state === 'REJECTED'
                ? 'The application system or an explicit human decision established rejection.'
                : ['UNKNOWN', 'HUMAN_REQUIRED'].includes(v.state)
                  ? 'We could not establish whether the application was accepted. No duplicate submission will be attempted.'
                  : v.state === 'FAILED'
                    ? 'Verification encountered a service failure. Acceptance has not been established by this check.'
                    : v.state === 'NOT_REQUIRED'
                      ? 'No submission verification is required for this execution.'
                      : 'The verification service has not finished this check.',
        }
      : null,
  };
}
type ExecutionSettings = {
  allowRealExecution?: boolean;
  autoSubmit?: boolean;
  autoSubmitSince?: string;
  executionFixtureOrigin?: string;
};
function summarize(row: Row, settings: ExecutionSettings = {}) {
  const destination =
    ApplicationPlanSchema.innerType().shape.destination.safeParse(
      row.plan?.destination,
    );
  const platform =
    row.googleFormRun || row.plan?.applicationType === 'GOOGLE_FORM'
      ? ('GOOGLE_FORM' as const)
      : destination.success && destination.data.target
        ? destination.data.target.platform
        : destination.success && destination.data.unsupportedReason
          ? ('UNSUPPORTED' as const)
          : ('OTHER' as const);
  let applicationUrl: string | null = null;
  if (destination.success && destination.data.url) {
    const url = new URL(destination.data.url);
    // Keep only public target identifiers; source tracking/credentials never reach workspace URLs.
    url.hash = '';
    const target = destination.data.target;
    url.search = '';
    if (target && url.pathname === '/embed/job_app') {
      url.searchParams.set('for', target.boardToken);
      url.searchParams.set('token', target.externalJobId);
    }
    applicationUrl = url.href;
  }
  // Real execution takes precedence over test/dry runs, regardless of their creation order.
  const execution = ['REAL_EXECUTION', 'TEST_FIXTURE', 'DRY_RUN']
    .map((mode) => row.executions.find((e) => e.mode === mode))
    .find(Boolean);
  const reviewReasons = row.googleFormRun
    ? ['REVIEW', 'BROWSER_REQUIRED', 'UNKNOWN', 'BLOCKED', 'FAILED'].includes(
        row.googleFormRun.state,
      )
      ? [
          'The Google Forms workflow needs your input. Open its controls on this application.',
        ]
      : []
    : [
        ...(platform === 'UNSUPPORTED'
          ? [
              'This application platform is unsupported. Apply manually on the employer site; browser automation is unavailable.',
            ]
          : []),
        ...(row.plan?.requiresHumanReview
          ? ['The application destination requires human review.']
          : []),
        ...(row.state === 'HUMAN_REQUIRED'
          ? ['The application is waiting for your review.']
          : []),
        ...inspectionReviewReasons(row),
        ...(row.preparation?.state === 'HUMAN_REQUIRED'
          ? ['Prepared answers or document selections need your review.']
          : []),
        ...(execution?.state === 'PAUSED_HUMAN_REQUIRED'
          ? ['Execution paused for human input.']
          : []),
        ...(execution?.verification?.state === 'HUMAN_REQUIRED'
          ? ['Submission acceptance could not be established safely.']
          : []),
      ];
  const busy = row.googleFormRun
    ? ['PENDING', 'RUNNING', 'SUBMITTING'].includes(row.googleFormRun.state)
    : execution?.verification
      ? ['PENDING', 'VERIFYING'].includes(execution.verification.state)
      : execution
        ? [
            'PENDING',
            'PREPARING',
            'RUNNING',
            'SUBMITTING',
            'SUBMITTED',
            'SUBMISSION_UNKNOWN',
          ].includes(execution.state)
        : ['SUBMITTED', 'FAILED', 'BLOCKED', 'HUMAN_REQUIRED'].includes(
              row.state,
            )
          ? false
          : row.preparation
            ? ['PENDING', 'RUNNING'].includes(row.preparation.state)
            : row.inspection
              ? ['PENDING', 'RUNNING'].includes(row.inspection.state)
              : ['DISCOVERED', 'ANALYZING', 'EXECUTING', 'VERIFYING'].includes(
                  row.state,
                );
  const timestamps = [
    row.updatedAt,
    row.inspection?.updatedAt,
    row.preparation?.updatedAt,
    row.googleFormRun?.updatedAt,
    row.emailMessage?.updatedAt,
    ...row.executions.flatMap((e) => [e.updatedAt, e.verification?.updatedAt]),
  ].filter((d): d is Date => !!d);
  const inspectedForExecution = ApplicationSchemaSchema.safeParse(
    row.inspection?.result,
  );
  const code =
    inspectedForExecution.success && inspectedForExecution.data.ashbySubmission
      ? ashbySubmissionBlocker(inspectedForExecution.data.ashbySubmission)
      : null;
  const reasons: Record<string, string> = {
    CAPTCHA:
      'The employer requires reCAPTCHA. Complete this application on the employer site.',
    ASHBY_SURVEY_REVIEW_REQUIRED:
      'The employer includes additional survey forms. Complete them on the employer site.',
    ASHBY_UNSUPPORTED_FIELD:
      'The employer includes a field that requires a browser interaction. Complete the application on the employer site.',
  };
  const flow =
    inspectedForExecution.success &&
    !!(
      inspectedForExecution.data.executionFlow ||
      inspectedForExecution.data.ashbySubmission
    );
  const fixtureReady =
    settings.executionFixtureOrigin &&
    inspectedForExecution.success &&
    new URL(inspectedForExecution.data.finalUrl).origin ===
      settings.executionFixtureOrigin &&
    flow;
  const executionReadiness = {
    state:
      execution &&
      (execution.mode !== 'DRY_RUN' ||
        ['PENDING', 'PREPARING', 'RUNNING'].includes(execution.state))
        ? 'STARTED'
        : reviewReasons.length
          ? 'REVIEW_REQUIRED'
          : row.preparation?.state !== 'COMPLETED'
            ? 'PREPARATION_REQUIRED'
            : !flow || code
              ? 'BLOCKED'
              : !settings.allowRealExecution && !fixtureReady
                ? 'DISABLED'
                : 'READY',
    reason:
      execution && execution.mode !== 'DRY_RUN'
        ? null
        : reviewReasons.length
          ? 'Resolve the required reviews before submission.'
          : row.preparation?.state !== 'COMPLETED'
            ? 'Complete preparation before submission.'
            : !flow
              ? 'Submission handling has not been inspected. Retry form inspection.'
              : code
                ? reasons[code]
                : !settings.allowRealExecution && !fixtureReady
                  ? 'Real application submission is disabled in the server configuration.'
                  : null,
    automatic:
      !!settings.allowRealExecution &&
      !!settings.autoSubmit &&
      !fixtureReady &&
      (!settings.autoSubmitSince ||
        !row.preparation?.completedAt ||
        row.preparation.completedAt.getTime() >=
          Date.parse(settings.autoSubmitSince)),
  };
  return ApplicationSummarySchema.parse({
    executionReadiness,
    id: row.id,
    state: row.state,
    createdAt: row.createdAt.toISOString(),
    updatedAt: row.updatedAt.toISOString(),
    lastActivityAt: new Date(
      Math.max(...timestamps.map((d) => d.getTime())),
    ).toISOString(),
    job: row.job,
    plan: row.plan
      ? {
          applicationType: row.plan.applicationType,
          provider: row.plan.provider,
          requiresHumanReview: row.plan.requiresHumanReview,
          createdAt: row.plan.createdAt.toISOString(),
          platform,
          applicationUrl,
          applicationEmail: destination.success
            ? (destination.data.email ?? null)
            : null,
        }
      : null,
    inspection: row.inspection
      ? {
          ...stage(row.inspection),
          issue:
            row.inspection.state === 'HUMAN_REQUIRED'
              ? inspectionReviewReasons(row).join(' ')
              : issue(row.inspection.errorCode, row.inspection.state),
        }
      : null,
    preparation: row.preparation ? stage(row.preparation) : null,
    execution: execution ? executionSummary(execution) : null,
    ...(row.googleFormRun
      ? { googleForm: googleFormSummary(row.googleFormRun) }
      : {}),
    email: row.emailMessage
      ? {
          state: row.emailMessage.state,
          updatedAt: row.emailMessage.updatedAt.toISOString(),
          sentAt: date(row.emailMessage.sentAt),
        }
      : null,
    humanReviewRequired: reviewReasons.length > 0,
    reviewReasons,
    active:
      (!!busy ||
        (executionReadiness.state === 'READY' &&
          executionReadiness.automatic) ||
        ['QUEUED', 'SENDING'].includes(row.emailMessage?.state ?? '')) &&
      reviewReasons.length === 0,
  });
}
function detail(
  row: DetailRow,
  fixtureOrigin?: string,
  settings: ExecutionSettings = {},
) {
  const timeline = row.events
    .slice(0, 100)
    .reverse()
    .filter((e) => eventLabels[e.type])
    .map((e) => ({
      id: `application-${e.id}`,
      label:
        (e.data as { channel?: string })?.channel === 'EMAIL'
          ? 'Application email sent'
          : eventLabels[e.type]!,
      at: e.createdAt.toISOString(),
    }));
  if (!row.events.some((e) => e.type === 'JOB_DISCOVERED'))
    timeline.unshift({
      id: 'created',
      label: 'Application created',
      at: row.createdAt.toISOString(),
    });
  const addStage = (
    name: string,
    s: {
      state: string;
      startedAt: Date | null;
      completedAt: Date | null;
    } | null,
  ) => {
    if (s?.startedAt)
      timeline.push({
        id: `${name}-start`,
        label: `${name} started`,
        at: s.startedAt.toISOString(),
      });
    if (s?.completedAt)
      timeline.push({
        id: `${name}-end`,
        label: `${name} ended (${s.state.toLowerCase().replaceAll('_', ' ')})`,
        at: s.completedAt.toISOString(),
      });
  };
  addStage('Inspection', row.inspection);
  addStage('Preparation', row.preparation);
  for (const [index, e] of row.executions.entries()) {
    addStage(
      `Execution ${index + 1} (${e.mode.toLowerCase().replaceAll('_', ' ')})`,
      e,
    );
    timeline.push(
      ...(e.verification?.events
        .slice(0, 100)
        .reverse()
        .map((event) => ({
          id: `verification-${event.id}`,
          label: auditLabels[event.type]!,
          at: event.createdAt.toISOString(),
        })) ?? []),
    );
  }
  timeline.sort((a, b) => a.at.localeCompare(b.at));
  const prepared = PreparedApplicationSchema.safeParse(row.preparation?.result);
  const validPrepared =
    prepared.success && prepared.data.applicationId === row.id;
  const inspected = ApplicationSchemaSchema.safeParse(row.inspection?.result);
  const safeSummary = summarize(row, {
    ...settings,
    ...(fixtureOrigin ? { executionFixtureOrigin: fixtureOrigin } : {}),
  });
  const needed =
    validPrepared && row.preparation?.state === 'HUMAN_REQUIRED'
      ? prepared.data.humanReviewItems
          .map((item) => {
            const category = [
              'WORK_AUTHORIZATION',
              'SPONSORSHIP',
              'SALARY',
              'NOTICE_PERIOD',
              'SECURITY_CLEARANCE',
              'LEGAL_DECLARATION',
              'OTHER_SENSITIVE',
              'RESUME',
              'COVER_LETTER',
              'PORTFOLIO',
              'TRANSCRIPT',
              'CUSTOM_QUESTION',
              'UNKNOWN',
              'FULL_NAME',
              'FIRST_NAME',
              'LAST_NAME',
              'EMAIL',
              'PHONE',
            ].includes(item.category)
              ? item.category.replaceAll('_', ' ').toLowerCase()
              : 'required information';
            return `Review ${category}: an explicit valid answer or document selection is needed.`;
          })
          .slice(0, 30)
      : [];
  return ApplicationDetailsSchema.parse({
    ...safeSummary,
    executionModes:
      fixtureOrigin &&
      inspected.success &&
      new URL(inspected.data.finalUrl).origin === fixtureOrigin &&
      (inspected.data.executionFlow || inspected.data.ashbySubmission) &&
      safeSummary.executionReadiness?.state === 'READY' &&
      row.inspection?.state === 'COMPLETED' &&
      row.preparation?.state === 'COMPLETED' &&
      !safeSummary.humanReviewRequired &&
      ['RESOLVED', 'READY'].includes(row.state) &&
      !row.executions.some((e) => e.mode !== 'DRY_RUN')
        ? (['DRY_RUN', 'TEST_FIXTURE'] as const).filter(
            (mode) => !row.executions.some((e) => e.mode === mode),
          )
        : safeSummary.executionReadiness?.state === 'READY' &&
            settings.allowRealExecution &&
            ['RESOLVED', 'READY'].includes(row.state) &&
            !row.executions.some((e) => e.mode !== 'DRY_RUN') &&
            inspected.success &&
            ['GREENHOUSE', 'LEVER', 'ASHBY'].includes(
              inspected.data.platform,
            ) &&
            (!fixtureOrigin ||
              new URL(inspected.data.finalUrl).origin !== fixtureOrigin)
          ? ['REAL_EXECUTION']
          : [],
    reviewReasons: [...safeSummary.reviewReasons, ...new Set(needed)],
    inspectionRetryAllowed:
      !!row.inspection &&
      ['RESOLVED', 'READY'].includes(row.state) &&
      row.executions.length === 0 &&
      ((!row.preparation &&
        (row.inspection.state === 'FAILED' ||
          canRetryEmptyInspection(row.inspection))) ||
        (!['PENDING', 'RUNNING'].includes(row.preparation?.state ?? '') &&
          (canRepairChoiceInspection(row.inspection) ||
            canRepairSubmissionInspection(row.inspection)))),
    preparationAllowed:
      !!row.inspection &&
      inspected.success &&
      canPrepareInspection(row.inspection.state, inspected.data) &&
      ['RESOLVED', 'READY'].includes(row.state) &&
      row.executions.length === 0,
    executions: row.executions.map(executionSummary),
    timeline: timeline.slice(-250),
    timelineTruncated:
      row.events.length > 100 ||
      row.executions.some((e) => (e.verification?.events.length ?? 0) > 100) ||
      timeline.length > 250,
    preparationSummary: validPrepared
      ? {
          fieldCount: prepared.data.fields.length,
          answerCount: prepared.data.questions.length,
          reviewCount: prepared.data.humanReviewItems.length,
          documents: prepared.data.documents.map((d) => ({
            type: d.documentType,
            selected: !!d.documentId,
          })),
        }
      : null,
  });
}

// Filters use the same mode precedence as the summary; never match an old dry run's verification.
export function selectedExecutionFilter(
  filter: Prisma.ApplicationExecutionWhereInput,
): Prisma.ApplicationWhereInput {
  return {
    OR: [
      {
        executions: {
          some: { ...filter, mode: 'REAL_EXECUTION' },
        },
      },
      {
        AND: [
          { executions: { none: { mode: 'REAL_EXECUTION' } } },
          {
            executions: {
              some: { ...filter, mode: 'TEST_FIXTURE' },
            },
          },
        ],
      },
      {
        AND: [
          {
            executions: {
              none: { mode: { in: ['REAL_EXECUTION', 'TEST_FIXTURE'] } },
            },
          },
          {
            executions: { some: { ...filter, mode: 'DRY_RUN' } },
          },
        ],
      },
    ],
  };
}
function verificationFilter(state: z.infer<typeof VerificationStateSchema>) {
  return selectedExecutionFilter({ verification: { state } });
}
export function registerApplicationRoutes(
  app: FastifyInstance,
  dependencies: {
    db?: PrismaClient;
    authSecret?: string;
    executionFixtureOrigin?: string;
    allowRealExecution?: boolean;
    autoSubmit?: boolean;
    autoSubmitSince?: string;
  },
) {
  for (const kind of ['list', 'detail'] as const) {
    app.get(
      kind === 'list' ? '/api/v1/applications' : '/api/v1/applications/:id',
      async (request, reply) => {
        reply.header('Cache-Control', 'no-store');
        const userId = authenticateBearer(
          request.headers.authorization,
          dependencies.authSecret,
        );
        if (!userId) return reply.code(401).send({ error: 'UNAUTHENTICATED' });
        const db = dependencies.db;
        if (!db)
          return reply.code(503).send({ error: 'APPLICATIONS_UNAVAILABLE' });
        try {
          if (kind === 'detail') {
            const parsed = paramsSchema.safeParse(request.params);
            if (!parsed.success)
              return reply.code(400).send({ error: 'INVALID_APPLICATION_ID' });
            const row = await db.application.findFirst({
              where: { id: parsed.data.id, userId },
              select: detailsSelect,
            });
            if (!row)
              return reply.code(404).send({ error: 'APPLICATION_NOT_FOUND' });
            return {
              application: detail(
                row,
                dependencies.executionFixtureOrigin,
                dependencies,
              ),
            };
          }
          const parsed = querySchema.safeParse(request.query);
          if (!parsed.success)
            return reply.code(400).send({ error: 'INVALID_QUERY' });
          const q = parsed.data;
          const and: Prisma.ApplicationWhereInput[] = [];
          if (q.search)
            and.push({
              job: {
                OR: ['title', 'company', 'location'].map((field) => ({
                  [field]: { contains: q.search, mode: 'insensitive' },
                })),
              },
            });
          if (q.verification) and.push(verificationFilter(q.verification));
          if (q.review)
            and.push({
              OR: [
                { state: 'HUMAN_REQUIRED' },
                { plan: { requiresHumanReview: true } },
                { inspection: { state: 'HUMAN_REQUIRED' } },
                { preparation: { state: 'HUMAN_REQUIRED' } },
                selectedExecutionFilter({ state: 'PAUSED_HUMAN_REQUIRED' }),
                verificationFilter('HUMAN_REQUIRED'),
              ],
            });
          const where: Prisma.ApplicationWhereInput = {
            userId,
            ...(q.status ? { state: q.status } : {}),
            AND: and,
          };
          const orderBy: Prisma.ApplicationOrderByWithRelationInput[] = [
            q.sort === 'updated'
              ? { updatedAt: 'desc' }
              : { createdAt: q.sort === 'oldest' ? 'asc' : 'desc' },
            { id: 'asc' },
          ];
          const [total, rows] = await db.$transaction(
            [
              db.application.count({ where }),
              db.application.findMany({
                where,
                select: summarySelect,
                orderBy,
                skip: (q.page - 1) * q.limit,
                take: q.limit,
              }),
            ],
            { isolationLevel: Prisma.TransactionIsolationLevel.RepeatableRead },
          );
          return {
            applications: rows.map((row) => summarize(row, dependencies)),
            pagination: {
              page: q.page,
              limit: q.limit,
              total,
              totalPages: Math.max(1, Math.ceil(total / q.limit)),
            },
          };
        } catch (error) {
          request.log.error({ error }, 'Application workspace read failed');
          return reply.code(503).send({
            error: 'APPLICATIONS_UNAVAILABLE',
            message:
              'Applications are temporarily unavailable. Please refresh.',
          });
        }
      },
    );
  }
}
