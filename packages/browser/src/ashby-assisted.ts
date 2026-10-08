import { randomUUID } from 'node:crypto';
import { isDeepStrictEqual } from 'node:util';
import { Kind, OperationTypeNode, parse } from 'graphql';
import type { Route, Page } from 'playwright';
import {
  ExecutionInputSchema,
  ExecutionResultSchema,
  ashbySubmissionBlocker,
  preparedValues,
  type ExecutionInput,
  type ExecutionObserver,
  type ExecutionResult,
  type ApplicationField,
} from '@careerlift/domain';
import { BrowserSessionManager, type BrowserSession } from './session.js';
import {
  DestinationPolicy,
  InspectionError,
  type BrowserNetworkPolicy,
} from './policy.js';
import {
  AshbyPostingSchema,
  captureAshbySubmission,
  sameAshbyDefinition,
  ASHBY_QUERIES,
  type AshbyPosting,
} from './ashby-form.js';
import {
  isAshbyReadRequest,
  isOptionalAshbyTelemetry,
} from './ashby-read-request.js';
import {
  ashbyApprovedValues,
  type AshbyExecutorOptions,
} from './ashby-executor.js';
import { extractPage, classifyPage } from './extract.js';
import { waitForFormRendering } from './form-readiness.js';
import { inspectSecurityControls } from './security-controls.js';
import { pinnedPost } from './pinned-request.js';
import { digest } from './mutation-contract.js';

type File = { name: string; mimeType: string; buffer: Uint8Array };
type Handle = {
  handle: string;
  url: string;
  fields: Record<string, string>;
  file: File;
  uploaded: boolean;
};
type Live = {
  session: BrowserSession;
  result: ExecutionResult;
  fingerprint: string;
  resume(
    input: ExecutionInput,
    observer?: ExecutionObserver,
  ): Promise<ExecutionResult>;
  timer: ReturnType<typeof setTimeout>;
};

export function isAshbyRecaptchaRequest(value: string) {
  const url = new URL(value);
  return (
    url.protocol === 'https:' &&
    !url.username &&
    !url.password &&
    ['https://www.google.com', 'https://www.recaptcha.net'].includes(
      url.origin,
    ) &&
    /^\/recaptcha\/(api2|enterprise)\//.test(url.pathname)
  );
}

// Validate the actual mutation, not just its client-chosen operation name.
export function ashbyNativeMutation(body: Buffer, contentType: string) {
  if (body.length > 65536 || !/^application\/json(?:;|$)/i.test(contentType))
    throw new InspectionError(
      'ASHBY_UNAPPROVED_MUTATION',
      'Unsupported payload',
    );
  try {
    const input = JSON.parse(body.toString('utf8'));
    if (
      !input ||
      Object.keys(input).some(
        (k) => !['query', 'variables', 'operationName'].includes(k),
      ) ||
      typeof input.query !== 'string' ||
      !input.variables ||
      Array.isArray(input.variables) ||
      typeof input.variables !== 'object'
    )
      throw new Error();
    const document = parse(input.query, { noLocation: true, maxTokens: 5000 });
    const operations = document.definitions.filter(
      (d) => d.kind === Kind.OPERATION_DEFINITION,
    );
    const operation = operations[0];
    if (
      operations.length !== 1 ||
      !operation ||
      document.definitions.some(
        (d) =>
          d.kind !== Kind.OPERATION_DEFINITION &&
          d.kind !== Kind.FRAGMENT_DEFINITION,
      ) ||
      operation.operation !== OperationTypeNode.MUTATION ||
      operation.name?.value !== input.operationName ||
      operation.directives?.length ||
      operation.selectionSet.selections.length !== 1
    )
      throw new Error();
    const root = operation.selectionSet.selections[0]!;
    if (root.kind !== Kind.FIELD || root.directives?.length) throw new Error();
    const names =
      operation.variableDefinitions?.map((v) => v.variable.name.value) ?? [];
    if (
      root.arguments?.length !== names.length ||
      new Set(names).size !== names.length ||
      Object.keys(input.variables).some((name) => !names.includes(name)) ||
      !names.every(
        (name) =>
          root.arguments?.filter(
            (a) =>
              a.name.value === name &&
              a.value.kind === Kind.VARIABLE &&
              a.value.name.value === name,
          ).length === 1,
      ) ||
      operation.variableDefinitions?.some(
        (v) =>
          v.defaultValue ||
          (v.type.kind === Kind.NON_NULL_TYPE &&
            input.variables[v.variable.name.value] == null),
      )
    )
      throw new Error();
    return {
      operation: input.operationName as string,
      root: root.name.value,
      alias: root.alias?.value ?? root.name.value,
      variables: input.variables as Record<string, unknown>,
    };
  } catch {
    throw new InspectionError(
      'ASHBY_UNAPPROVED_MUTATION',
      'Mutation identity is not approved',
    );
  }
}

const fingerprint = (input: ExecutionInput) =>
  digest(
    JSON.stringify({
      ...input,
      previousResult: undefined,
      dispatchIdentity: undefined,
    }),
  );
const quote = (value: string) =>
  `"${value
    .replace(/\\/g, '\\\\')
    .replace(/"/g, '\\"')
    .replace(/[\r\n\f]/g, ' ')}"`;
const control = (page: Page, field: ApplicationField) =>
  field.domId
    ? page.locator(`[id=${quote(field.domId)}]`)
    : field.name
      ? page.locator(`[name=${quote(field.name)}]`)
      : page.getByLabel(field.label, { exact: true });

export class AshbyAssistedExecutor {
  private readonly live = new Map<string, Live>();
  constructor(
    private readonly options: AshbyExecutorOptions & {
      assistedHeadless?: boolean;
      pauseTtlMs?: number;
      assistedSessions?: (
        policy: BrowserNetworkPolicy,
      ) => Pick<BrowserSessionManager, 'create'>;
    },
  ) {}
  async close() {
    for (const live of this.live.values()) {
      clearTimeout(live.timer);
      await live.session.close();
    }
    this.live.clear();
  }
  async execute(
    raw: ExecutionInput,
    initialObserver?: ExecutionObserver,
  ): Promise<ExecutionResult> {
    let existing = this.live.get(raw.executionId);
    if (existing?.session.page.isClosed()) {
      clearTimeout(existing.timer);
      this.live.delete(raw.executionId);
      await existing.session.close();
      existing = undefined;
    }
    if (raw.previousResult && existing) {
      if (
        existing.fingerprint !== fingerprint(raw) ||
        raw.previousResult.checkpoint?.sessionId !==
          existing.result.checkpoint?.sessionId
      ) {
        clearTimeout(existing.timer);
        this.live.delete(raw.executionId);
        await existing.session.close();
        throw new InspectionError(
          'STALE_EXECUTION_INPUT',
          'Prepared application changed',
        );
      }
      clearTimeout(existing.timer);
      this.live.delete(raw.executionId);
      return existing.resume(raw, initialObserver);
    }
    if (existing)
      throw new InspectionError('CONCURRENT_EXECUTION', 'Browser already open');
    const started = Date.now();
    let observer = initialObserver;
    let input = raw;
    const result: ExecutionResult = {
      applicationId: raw.applicationId,
      executionId: raw.executionId,
      mode: raw.mode,
      status: 'PREPARING',
      startedAt: new Date().toISOString(),
      steps: [],
      humanReviewItems: [],
      metadata: { platform: 'ASHBY', durationMs: 0 },
    };
    let session: BrowserSession | undefined;
    let retained = false,
      finalDispatched = false,
      finalReserved = false;
    let failure: InspectionError | undefined;
    let posting: AshbyPosting | undefined;
    let activeFile: { path: string; file: File } | undefined;
    let token: { body: Buffer; alias: string; expires: number } | undefined;
    let render: Record<string, unknown> = {};
    const files = new Map<string, File>(),
      handles = new Map<string, Handle>();
    const saved = new Map<string, unknown>(),
      attached = new Set<string>();
    const approved = new Map<string, unknown>();
    let base: Record<string, unknown> = {};
    const policy: BrowserNetworkPolicy =
      this.options.policy ?? new DestinationPolicy(this.options.fixtureOrigin);
    const persist = async () => {
      result.metadata.durationMs = Date.now() - started;
      await observer?.persist(ExecutionResultSchema.parse(result));
    };
    const check = async () => {
      if (failure) throw failure;
      if (!session || session.page.isClosed())
        throw new InspectionError('ASHBY_SESSION_LOST', 'Browser was closed');
      if (session.page.url() !== input.inspection.finalUrl)
        throw new InspectionError(
          'APPLICATION_IDENTITY_CHANGED',
          'Application destination changed',
        );
      await session.securityCheck();
      const security = await inspectSecurityControls(session.page, undefined, {
        allowRecaptchaFrames: true,
      });
      if (!security.complete || security.authentication)
        throw new InspectionError(
          'HUMAN_REVIEW_DISPATCH_BLOCKED',
          'Employer controls require review',
        );
    };
    const send = async (
      url: string,
      body: Buffer,
      contentType: string,
      final = false,
    ) => {
      if (finalReserved && !final)
        throw new InspectionError(
          'ASHBY_UNAPPROVED_MUTATION',
          'Application is frozen for submission',
        );
      const mutation: NonNullable<ExecutionResult['mutations']>[number] = {
        mutationId: randomUUID(),
        executionId: input.executionId,
        stepId: result.steps.at(-1)!.stepId,
        action: final ? 'FINAL_SUBMIT' : 'NEXT',
        destination: `${new URL(url).origin}${new URL(url).pathname}`,
        method: 'POST',
        requestDigest: digest(body),
        documentDigests: [...files.values()].map((file) => digest(file.buffer)),
        startedAt: new Date().toISOString(),
        outcome: 'AUTHORIZED',
      };
      result.mutations ??= [];
      result.mutations.push(mutation);
      await persist();
      let sent = false;
      try {
        const response = await pinnedPost(
          url,
          body,
          contentType,
          policy,
          async () => {
            await check();
            await observer?.authorizeDispatch?.();
            mutation.outcome = 'DISPATCHING';
            await persist();
            sent = true;
            if (final) finalDispatched = true;
          },
          Boolean(this.options.fixtureOrigin),
        );
        mutation.outcome = 'FORWARDED';
        mutation.completedAt = new Date().toISOString();
        mutation.responseReceivedAt = mutation.completedAt;
        mutation.responseStatus = response.status;
        mutation.responseFingerprint = digest(response.body);
        await persist();
        return response;
      } catch (error) {
        mutation.outcome = sent ? 'UNKNOWN' : 'REJECTED';
        mutation.completedAt = new Date().toISOString();
        await persist();
        throw error;
      }
    };
    const pause = async (reason = 'ASHBY_BROWSER_VERIFICATION_REQUIRED') => {
      result.status = 'PAUSED_HUMAN_REQUIRED';
      result.error = reason;
      result.humanReviewItems = [
        {
          reason,
          targetRef: 'ashby-form',
          stepId: result.steps.at(-1)!.stepId,
          safeContinuationPoint: 'ashby-browser',
        },
      ];
      result.checkpoint ??= {
        sessionId: randomUUID(),
        pageIndex: 0,
        nextFieldIndex: 0,
        appliedFieldIds: [],
        unsafeActionStarted: false,
        resumable: true,
      };
      await persist();
      retained = true;
      const timer = setTimeout(
        () => {
          this.live.delete(input.executionId);
          void session?.close();
        },
        this.options.pauseTtlMs ?? 30 * 60 * 1000,
      );
      timer.unref();
      this.live.set(input.executionId, {
        session: session!,
        result,
        fingerprint: fingerprint(input),
        timer,
        resume,
      });
      return ExecutionResultSchema.parse(result);
    };
    const finish = async (error?: unknown) => {
      if (error) {
        result.error =
          error instanceof InspectionError
            ? error.code
            : 'ASHBY_EXECUTION_FAILED';
        result.status =
          finalDispatched || result.status === 'SUBMITTING'
            ? 'SUBMISSION_UNKNOWN'
            : 'BLOCKED';
        const activeStep = result.steps.at(-1);
        if (activeStep?.status === 'RUNNING') {
          activeStep.status = 'FAILED';
          activeStep.error = result.error;
          activeStep.completedAt = new Date().toISOString();
        }
      }
      if (result.checkpoint)
        result.checkpoint = {
          ...result.checkpoint,
          resumable: false,
          unsafeActionStarted: finalDispatched,
        };
      result.completedAt = new Date().toISOString();
      await session?.close();
      await persist();
      return ExecutionResultSchema.parse(result);
    };
    const resume = async (
      next: ExecutionInput,
      nextObserver?: ExecutionObserver,
    ) => {
      retained = false;
      observer = nextObserver;
      input = ExecutionInputSchema.parse(next);
      result.status = 'PREPARING';
      result.humanReviewItems = [];
      delete result.error;
      await persist();
      try {
        await check();
        result.status = 'RUNNING';
        await persist();
        if (!token || token.expires <= Date.now()) {
          token = undefined;
          return await pause('ASHBY_BROWSER_VERIFICATION_REQUIRED');
        }
        if (
          approved.size !== saved.size ||
          [...approved].some(
            ([path, value]) => !isDeepStrictEqual(saved.get(path), value),
          ) ||
          [...files.keys()].some((path) => !attached.has(path))
        )
          throw new InspectionError(
            'REQUIRED_FIELD_MISSING',
            'Prepared values are not confirmed',
          );
        const current = token;
        token = undefined; // Consume before any await; never persist or replay tokens.
        finalReserved = true;
        result.status = 'SUBMITTING';
        result.checkpoint!.resumable = false;
        await persist();
        result.steps.push({
          stepId: randomUUID(),
          type: 'SUBMIT',
          targetRef: 'ashby-submit',
          status: 'RUNNING',
          attempt: 1,
          startedAt: new Date().toISOString(),
        });
        const response = await send(
          `${new URL(input.inspection.finalUrl).origin}/api/non-user-graphql?op=ApiSubmitSingleApplicationFormAction`,
          current.body,
          'application/json',
          true,
        );
        const json = JSON.parse(response.body.toString('utf8'));
        const outcome =
          json.data?.[current.alias]?.applicationFormResult?.__typename;
        if (
          response.status !== 200 ||
          json.errors?.length ||
          !['FormSubmitSuccess', 'FormRender'].includes(outcome)
        )
          throw new InspectionError(
            'ASHBY_INVALID_RESPONSE',
            'Acceptance was not established',
          );
        result.mutations!.at(-1)!.providerOutcome =
          outcome === 'FormSubmitSuccess' ? 'CONFIRMED' : 'REJECTED';
        result.steps.at(-1)!.status = 'COMPLETED';
        result.steps.at(-1)!.completedAt = new Date().toISOString();
        result.status = 'SUBMISSION_UNKNOWN';
        return await finish();
      } catch (error) {
        return finish(error);
      }
    };
    try {
      input = ExecutionInputSchema.parse(raw);
      const spec = input.inspection.ashbySubmission,
        target = input.plan.destination.target;
      if (target?.platform !== 'ASHBY' || !spec || !spec.requiresCaptcha)
        throw new InspectionError(
          'ASHBY_SUBMISSION_INSPECTION_REQUIRED',
          'Assisted Ashby inspection required',
        );
      const blocker = ashbySubmissionBlocker(spec, true);
      if (blocker)
        throw new InspectionError(
          blocker,
          'Employer interaction is unsupported',
        );
      if (
        input.mode === 'REAL_EXECUTION'
          ? !this.options.allowRealExecution ||
            !observer?.authorizeDispatch ||
            !input.dispatchIdentity ||
            Boolean(process.env.VITEST) ||
            process.env.NODE_ENV === 'test' ||
            Boolean(this.options.fixtureOrigin)
          : !this.options.fixtureOrigin ||
            new URL(input.inspection.finalUrl).origin !==
              this.options.fixtureOrigin ||
            input.mode === 'DRY_RUN'
      )
        throw new InspectionError(
          'REAL_EXECUTION_DISABLED',
          'Assisted browser execution unavailable',
        );
      for (const [path, value] of ashbyApprovedValues(input))
        approved.set(path, value);
      for (const field of spec.fields.filter((f) => f.type === 'File')) {
        const selections = input.preparedApplication.documents.filter(
          (d) => field.fieldIds.includes(d.requirementId) && d.documentId,
        );
        if (selections.length > 1)
          throw new InspectionError(
            'AMBIGUOUS_FIELD',
            'Multiple selected files',
          );
        if (!selections.length) {
          if (field.required)
            throw new InspectionError(
              'REQUIRED_DOCUMENT_MISSING',
              'Required document missing',
            );
          continue;
        }
        const document = input.documents.find(
          (d) => d.id === selections[0]!.documentId,
        )!;
        const requirement = input.inspection.documents.find(
          (d) => d.fieldId === selections[0]!.requirementId,
        )!;
        const file = await this.options.documents.resolve(
          document,
          requirement.acceptedFileTypes,
        );
        if (digest(file.buffer) !== document.metadata.contentDigest)
          throw new InspectionError(
            'DOCUMENT_CONTENT_MISMATCH',
            'Approved file changed',
          );
        files.set(field.path, file);
      }
      const source = target.fixtureSourceUrl ?? input.inspection.finalUrl;
      const manager =
        this.options.assistedSessions?.(policy) ??
        new BrowserSessionManager(
          this.options.assistedHeadless ?? false,
          policy,
          Boolean(this.options.fixtureOrigin),
        );
      session = await manager.create(
        (url) => {
          if (
            url !== input.inspection.finalUrl &&
            !isAshbyRecaptchaRequest(url)
          )
            throw new InspectionError(
              'APPLICATION_IDENTITY_CHANGED',
              'Unexpected navigation',
            );
        },
        (url, method, body, contentType) =>
          isOptionalAshbyTelemetry(source, url, method)
            ? 'BLOCK_OPTIONAL'
            : (method === 'POST' && isAshbyRecaptchaRequest(url)) ||
              isAshbyReadRequest(
                source,
                url,
                method,
                body,
                contentType,
                this.options.fixtureOrigin,
              ),
      );
      const reads: Promise<void>[] = [];
      session.page.on('response', (response) => {
        const url = new URL(response.url());
        if (
          url.origin === new URL(input.inspection.finalUrl).origin &&
          url.pathname === '/api/non-user-graphql' &&
          url.searchParams.get('op') === 'ApiJobPosting'
        ) {
          reads.push(
            response
              .json()
              .then((json) => {
                const parsed = AshbyPostingSchema.safeParse(
                  json.data?.jobPosting,
                );
                if (parsed.success) {
                  posting = parsed.data;
                  render = json.data.jobPosting.applicationForm;
                }
              })
              .catch(() => {}),
          );
        }
      });
      // Only validated applicant mutations bypass the read-only session route.
      // They use the same pinned, single-dispatch transport as the ordinary adapter.
      let pending = 0;
      await session.context.route('**/*', async (route: Route) => {
        const request = route.request(),
          url = new URL(request.url());
        if (
          request.method() !== 'POST' ||
          isAshbyRecaptchaRequest(url.href) ||
          isAshbyReadRequest(
            source,
            url.href,
            request.method(),
            request.postDataBuffer() ?? Buffer.alloc(0),
            request.headers()['content-type'] ?? '',
            this.options.fixtureOrigin,
          ) ||
          isOptionalAshbyTelemetry(source, url.href, request.method())
        )
          return route.fallback();
        pending++;
        try {
          if (!posting || !Object.keys(base).length)
            throw new InspectionError(
              'ASHBY_UNAPPROVED_MUTATION',
              'Form not validated',
            );
          const body = request.postDataBuffer() ?? Buffer.alloc(0),
            contentType = request.headers()['content-type'] ?? '';
          const capability = [...handles.values()].find(
            (h) => h.url === url.href && !h.uploaded,
          );
          if (capability) {
            const data = await new Request(url.href, {
              method: 'POST',
              headers: { 'content-type': contentType },
              body: new Uint8Array(body),
            }).formData();
            const file = data.get('file');
            const allowed = new Set([
              'file',
              'Content-Type',
              ...Object.keys(capability.fields),
            ]);
            if (
              !file ||
              typeof file === 'string' ||
              file.name !== capability.file.name ||
              file.type !== capability.file.mimeType ||
              digest(new Uint8Array(await file.arrayBuffer())) !==
                digest(capability.file.buffer) ||
              [...data.keys()].some(
                (k) => !allowed.has(k) || data.getAll(k).length !== 1,
              ) ||
              data.get('Content-Type') !== capability.file.mimeType ||
              Object.entries(capability.fields).some(
                ([k, v]) => data.get(k) !== v,
              )
            )
              throw new InspectionError(
                'DOCUMENT_CONTENT_MISMATCH',
                'Upload differs from approved document',
              );
            capability.uploaded = true; // Consume before transport; no upload retry.
            const response = await send(url.href, body, contentType);
            if (response.status < 200 || response.status >= 300)
              throw new InspectionError(
                'DOCUMENT_UPLOAD_FAILED',
                'Upload rejected',
              );
            await route.fulfill({
              status: response.status,
              body: response.body,
            });
            return;
          }
          if (
            url.origin !== new URL(input.inspection.finalUrl).origin ||
            url.pathname !== '/api/non-user-graphql' ||
            [...url.searchParams.keys()].length !== 1
          )
            throw new InspectionError(
              'ASHBY_UNAPPROVED_MUTATION',
              'Unexpected mutation destination',
            );
          const mutation = ashbyNativeMutation(body, contentType),
            variables = mutation.variables;
          if (url.searchParams.get('op') !== mutation.operation)
            throw new InspectionError(
              'ASHBY_UNAPPROVED_MUTATION',
              'Operation changed',
            );
          const matches = (expected: Record<string, unknown>) =>
            isDeepStrictEqual(expected, variables);
          if (mutation.root === 'setFormValue') {
            const expected =
              typeof variables.path === 'string'
                ? approved.get(variables.path)
                : undefined;
            const intermediate =
              result.status === 'RUNNING' &&
              Array.isArray(expected) &&
              Array.isArray(variables.value) &&
              variables.value.every((value) => expected.includes(value)) &&
              new Set(variables.value).size === variables.value.length;
            if (
              typeof variables.path !== 'string' ||
              !approved.has(variables.path) ||
              !matches({
                ...base,
                path: variables.path,
                value: intermediate ? variables.value : expected,
              })
            )
              throw new InspectionError(
                'ASHBY_UNAPPROVED_VALUE',
                'Answer differs from prepared values',
              );
          } else if (mutation.root === 'createFileUploadHandle') {
            if (
              !activeFile ||
              !matches({
                organizationHostedJobsPageName: target.boardToken,
                fileUploadContext: 'NonUserFormEngine',
                filename: activeFile.file.name,
                contentType: activeFile.file.mimeType,
                contentLength: activeFile.file.buffer.length,
              })
            )
              throw new InspectionError(
                'ASHBY_UNAPPROVED_VALUE',
                'File is not approved',
              );
          } else if (mutation.root === 'setFormValueToFile') {
            const handle =
              typeof variables.fileHandle === 'string'
                ? handles.get(variables.fileHandle)
                : undefined;
            if (
              !handle?.uploaded ||
              typeof variables.path !== 'string' ||
              files.get(variables.path) !== handle.file ||
              !matches({
                ...base,
                path: variables.path,
                fileHandle: handle.handle,
              })
            )
              throw new InspectionError(
                'ASHBY_UNAPPROVED_VALUE',
                'Document binding is not approved',
              );
          } else if (mutation.root === 'submitSingleApplicationFormAction') {
            const protocolNames = [
              'sourceAttributionCode',
              'viewedAutomatedProcessingLegalNoticeRuleId',
              'deviceFingerprint',
              'applicationRequestId',
            ];
            const protocol = Object.fromEntries(
              Object.entries(variables).filter(([key]) =>
                protocolNames.includes(key),
              ),
            );
            const validProtocol = Object.entries(protocol).every(
              ([key, value]) =>
                value === null ||
                (typeof value === 'string' &&
                  value.length <= (key === 'deviceFingerprint' ? 32768 : 1000)),
            );
            if (
              result.status !== 'PAUSED_HUMAN_REQUIRED' ||
              finalReserved ||
              pending !== 1 ||
              typeof variables.recaptchaToken !== 'string' ||
              !variables.recaptchaToken.trim() ||
              variables.recaptchaToken.length > 10000 ||
              !validProtocol ||
              !matches({
                ...base,
                ...protocol,
                jobPostingId: target.externalJobId,
                actionIdentifier: spec.actionId,
                recaptchaToken: variables.recaptchaToken,
              }) ||
              [...approved].some(
                ([path, value]) => !isDeepStrictEqual(saved.get(path), value),
              ) ||
              [...files.keys()].some((path) => !attached.has(path))
            )
              throw new InspectionError(
                'ASHBY_BROWSER_VERIFICATION_REQUIRED',
                'Complete browser verification before continuing',
              );
            await check();
            token = {
              body: Buffer.from(body),
              alias: mutation.alias,
              expires: Date.now() + 90000,
            };
            await route.fulfill({
              status: 200,
              contentType: 'application/json',
              // Returning the existing render keeps Ashby's native form usable
              // if verification expires. Never report employer acceptance here.
              body: JSON.stringify({
                data: {
                  [mutation.alias]: {
                    applicationFormResult: {
                      ...render,
                      id: posting.applicationForm.id,
                      __typename: 'FormRender',
                    },
                    messages: { blockMessageForCandidateHtml: null },
                  },
                },
              }),
            });
            await session!.page
              .locator('#careerlift-browser-assistance')
              .evaluate((node) => {
                node.textContent =
                  'Verification is ready. Return to CareerLift and click Continue Ashby application promptly to submit.';
              });
            return;
          } else
            throw new InspectionError(
              'ASHBY_UNAPPROVED_MUTATION',
              'Unsupported mutation',
            );
          if (result.status !== 'RUNNING')
            throw new InspectionError(
              'ASHBY_UNAPPROVED_MUTATION',
              'Prepared answers are frozen while awaiting verification',
            );
          const response = await send(url.href, body, contentType);
          const json = JSON.parse(response.body.toString('utf8')),
            data = json.data?.[mutation.alias];
          if (response.status !== 200 || json.errors?.length || !data)
            throw new InspectionError(
              'ASHBY_REQUEST_REJECTED',
              'Provider rejected request',
            );
          if (mutation.root === 'createFileUploadHandle') {
            const upload = new URL(data.url);
            if (
              typeof data.handle !== 'string' ||
              upload.protocol !== 'https:' ||
              upload.username ||
              upload.password ||
              upload.hash ||
              (this.options.fixtureOrigin
                ? upload.origin !== this.options.fixtureOrigin
                : !/^.+\.s3(?:[.-][a-z0-9-]+)?\.amazonaws\.com$/.test(
                    upload.hostname,
                  )) ||
              !data.fields ||
              Object.entries(data.fields).some(
                ([k, v]) =>
                  typeof v !== 'string' ||
                  k === 'file' ||
                  (k === 'Content-Type' && v !== activeFile!.file.mimeType),
              )
            )
              throw new InspectionError(
                'ASHBY_INVALID_UPLOAD_HANDLE',
                'Invalid upload capability',
              );
            handles.set(data.handle, {
              ...data,
              file: activeFile!.file,
              uploaded: false,
            });
          } else {
            if (
              data.id !== posting.applicationForm.id ||
              data.formErrors?.length
            )
              throw new InspectionError(
                'ASHBY_REQUEST_REJECTED',
                'Form value was not accepted',
              );
            render = data;
            if (mutation.root === 'setFormValue')
              saved.set(variables.path as string, variables.value);
            else attached.add(variables.path as string);
          }
          await route.fulfill({
            status: response.status,
            contentType: 'application/json',
            body: response.body,
          });
        } catch (error) {
          if (
            error instanceof InspectionError &&
            error.code === 'ASHBY_BROWSER_VERIFICATION_REQUIRED'
          ) {
            await route.fulfill({
              status: 200,
              contentType: 'application/json',
              body: JSON.stringify({
                errors: [
                  {
                    message:
                      'Complete verification in this browser, then return to CareerLift to continue.',
                  },
                ],
              }),
            });
          } else {
            failure =
              error instanceof InspectionError
                ? error
                : new InspectionError(
                    'ASHBY_UNAPPROVED_MUTATION',
                    'Request validation failed',
                  );
            await route.abort('blockedbyclient');
          }
        } finally {
          pending--;
        }
      });
      result.steps.push({
        stepId: randomUUID(),
        type: 'NAVIGATE',
        targetRef: 'ashby-form',
        status: 'RUNNING',
        attempt: 1,
        startedAt: new Date().toISOString(),
      });
      result.status = 'RUNNING';
      await persist();
      const response = await session.page.goto(input.inspection.finalUrl, {
        waitUntil: 'domcontentloaded',
        timeout: 15000,
      });
      if (!response || response.status() >= 400)
        throw new InspectionError(
          'NAVIGATION_FAILED',
          'Employer page unavailable',
        );
      await waitForFormRendering(session.page);
      await Promise.all(reads);
      const page = await extractPage(session.page),
        fresh = captureAshbySubmission(posting, page.fields);
      if (
        !posting ||
        posting.id !== target.externalJobId ||
        page.title !== input.inspection.title ||
        classifyPage(page).authentication.required ||
        !fresh ||
        !sameAshbyDefinition(spec, fresh)
      )
        throw new InspectionError(
          'ASHBY_FORM_CHANGED',
          'Reinspect the employer form',
        );
      base = {
        organizationHostedJobsPageName: target.boardToken,
        formRenderIdentifier: posting.applicationForm.id,
        formDefinitionIdentifier:
          posting.applicationForm.sourceFormDefinitionId,
      };
      await check();
      result.steps.at(-1)!.status = 'COMPLETED';
      result.steps.at(-1)!.completedAt = new Date().toISOString();
      const values = preparedValues(input);
      for (const field of spec.fields) {
        let changed = false;
        const currentField = fresh.fields.find((f) => f.path === field.path)!;
        for (let index = 0; index < field.fieldIds.length; index++) {
          const original = input.inspection.fields.find(
            (f) => f.id === field.fieldIds[index],
          )!;
          const current = page.fields.find(
            (f) => f.id === currentField.fieldIds[index],
          );
          if (
            !current ||
            current.label !== original.label ||
            current.type !== original.type
          )
            throw new InspectionError(
              'ASHBY_FIELD_MAPPING_CHANGED',
              'Field identity changed',
            );
          const value = values.get(original.id),
            file = files.get(field.path);
          if (current.type === 'FILE' ? !file : value == null) continue;
          result.steps.push({
            stepId: randomUUID(),
            type: file ? 'UPLOAD_DOCUMENT' : 'FILL_FIELD',
            targetRef: field.path,
            status: 'RUNNING',
            attempt: 1,
            startedAt: new Date().toISOString(),
          });
          await persist();
          const locator = control(session.page, current);
          if (file) {
            changed = true;
            activeFile = { path: field.path, file };
            await locator.setInputFiles({
              name: file.name,
              mimeType: file.mimeType,
              buffer: Buffer.from(file.buffer),
            });
          } else if (current.type === 'SELECT') {
            changed ||=
              (await locator.locator('option:checked').textContent()) !== value;
            await locator.selectOption({ label: value! });
          } else if (current.type === 'RADIO' || current.type === 'CHECKBOX') {
            const selected = value === 'true';
            const tag = await locator.evaluate((node) => node.tagName);
            if (tag === 'INPUT') {
              changed ||= (await locator.isChecked()) !== selected;
              await locator.setChecked(selected);
            } else {
              const checked =
                (await locator.getAttribute('aria-pressed')) === 'true' ||
                (await locator.getAttribute('aria-checked')) === 'true';
              changed ||= checked !== selected;
              if (checked !== selected) await locator.click();
            }
          } else {
            changed ||= (await locator.inputValue()) !== value;
            await locator.fill(value!);
            await locator.blur();
          }
        }
        // An unchanged checkbox/default does not fire Ashby's change handler.
        // Explicitly bind that already-visible value to this prepared snapshot.
        if (!changed && approved.has(field.path) && !saved.has(field.path)) {
          const response = await send(
            `${new URL(input.inspection.finalUrl).origin}/api/non-user-graphql?op=ApiSetFormValue`,
            Buffer.from(
              JSON.stringify({
                operationName: 'ApiSetFormValue',
                query: ASHBY_QUERIES.setValue,
                variables: {
                  ...base,
                  path: field.path,
                  value: approved.get(field.path),
                },
              }),
            ),
            'application/json',
          );
          const json = JSON.parse(response.body.toString('utf8'));
          if (
            response.status !== 200 ||
            json.errors?.length ||
            json.data?.setFormValue?.id !== posting.applicationForm.id
          )
            throw new InspectionError(
              'ASHBY_REQUEST_REJECTED',
              'Default value was not accepted',
            );
          saved.set(field.path, approved.get(field.path));
        }
        if (files.has(field.path) || approved.has(field.path)) {
          const until = Date.now() + 15000;
          while (
            files.has(field.path)
              ? !attached.has(field.path)
              : !isDeepStrictEqual(
                  saved.get(field.path),
                  approved.get(field.path),
                )
          ) {
            if (failure) throw failure;
            if (Date.now() >= until)
              throw new InspectionError(
                'ASHBY_BROWSER_FILL_FAILED',
                'Employer did not confirm prepared field',
              );
            await new Promise((resolve) => setTimeout(resolve, 50));
          }
        }
        activeFile = undefined;
        if (result.steps.at(-1)!.status === 'RUNNING') {
          result.steps.at(-1)!.status = 'COMPLETED';
          result.steps.at(-1)!.completedAt = new Date().toISOString();
        }
      }
      const settledBy = Date.now() + 15000;
      while (pending) {
        if (failure) throw failure;
        if (Date.now() >= settledBy)
          throw new InspectionError(
            'ASHBY_BROWSER_FILL_FAILED',
            'Employer updates did not settle',
          );
        await new Promise((resolve) => setTimeout(resolve, 50));
      }
      await session.page.evaluate(() => {
        const notice = document.createElement('div');
        notice.id = 'careerlift-browser-assistance';
        notice.setAttribute('role', 'status');
        notice.style.cssText =
          'margin:16px;padding:16px;background:#eef2ff;color:#172554;border:1px solid #c7d2fe;border-radius:12px;font:14px system-ui';
        notice.textContent =
          'CareerLift filled your prepared application. Click the employer Submit button and complete any verification yourself. Then return to CareerLift and click Continue Ashby application. Nothing is submitted until you continue there.';
        document.body.prepend(notice);
      });
      return await pause(
        raw.previousResult ? 'ASHBY_SESSION_REOPENED' : undefined,
      );
    } catch (error) {
      return await finish(error);
    } finally {
      if (!retained) await session?.close();
    }
  }
}
