import { randomUUID } from 'node:crypto';
import { isDeepStrictEqual } from 'node:util';
import {
  ExecutionInputSchema,
  ExecutionResultSchema,
  ashbySubmissionBlocker,
  preparedValues,
  type ExecutionInput,
  type ExecutionObserver,
  type ExecutionResult,
  type ExecutionStep,
  type DocumentStorage,
} from '@careerlift/domain';
import { BrowserSessionManager } from './session.js';
import {
  DestinationPolicy,
  InspectionError,
  type BrowserNetworkPolicy,
} from './policy.js';
import {
  isAshbyReadRequest,
  isOptionalAshbyTelemetry,
} from './ashby-read-request.js';
import {
  AshbyPostingSchema,
  captureAshbySubmission,
  sameAshbyDefinition,
  ASHBY_QUERIES,
  type AshbyPosting,
} from './ashby-form.js';
import { extractPage, classifyPage } from './extract.js';
import { waitForFormRendering } from './form-readiness.js';
import { inspectSecurityControls } from './security-controls.js';
import { pinnedPost } from './pinned-request.js';
import { digest } from './mutation-contract.js';

type Upload = { name: string; mimeType: string; buffer: Uint8Array };
export interface AshbyExecutorOptions {
  documents: DocumentStorage;
  allowRealExecution?: boolean;
  fixtureOrigin?: string;
  policy?: BrowserNetworkPolicy;
}

export function ashbyApprovedValues(input: ExecutionInput) {
  const spec = input.inspection.ashbySubmission!;
  const values = preparedValues(input),
    approved = new Map<string, unknown>();
  for (const f of spec.fields) {
    if (f.type === 'File') continue;
    const members = f.fieldIds.map((id) =>
      input.inspection.fields.find((x) => x.id === id)!,
    );
    if (members.some((m) => !m))
      throw new InspectionError(
        'ASHBY_FIELD_MAPPING_CHANGED',
        'Inspected field is missing',
      );
    if (['ValueSelect', 'MultiValueSelect'].includes(f.type)) {
      const labels = members
        .filter((m) =>
          m.type === 'CHECKBOX'
            ? values.get(m.id) === 'true'
            : values.get(m.id) != null,
        )
        .map((m) => (m.type === 'SELECT' ? values.get(m.id)! : m.label));
      const selected = [...new Set(labels)].map((label) => {
        const matches = f.options.filter(
          (o) => o.label.trim() === label.trim(),
        );
        if (matches.length !== 1)
          throw new InspectionError(
            'INVALID_OPTION',
            'Choice differs from inspected options',
          );
        return matches[0]!.value;
      });
      if (f.required && !selected.length)
        throw new InspectionError(
          'REQUIRED_FIELD_MISSING',
          'A required choice is missing',
        );
      if (f.type === 'ValueSelect' && selected.length > 1)
        throw new InspectionError(
          'INVALID_OPTION',
          'Multiple values for a single choice',
        );
      if (selected.length)
        approved.set(
          f.path,
          f.type === 'MultiValueSelect' ? selected : selected[0],
        );
      continue;
    }
    const candidates = members
      .map((m) => values.get(m.id))
      .filter((v) => v != null);
    if (candidates.length > 1)
      throw new InspectionError(
        'AMBIGUOUS_FIELD',
        'Multiple answers map to one provider field',
      );
    const v = candidates[0];
    if (v == null) {
      if (f.required)
        throw new InspectionError(
          'REQUIRED_FIELD_MISSING',
          'A required answer is missing',
        );
      continue;
    }
    approved.set(
      f.path,
      f.type === 'Boolean' ? v === 'true' : f.type === 'Number' ? Number(v) : v,
    );
  }
  return approved;
}

// Every applicant mutation is constructed in trusted code from approved snapshots.
// The employer page has read-only network access throughout this adapter's run.
export class AshbyApplicationExecutor {
  constructor(private readonly options: AshbyExecutorOptions) {}
  async execute(
    raw: ExecutionInput,
    observer?: ExecutionObserver,
  ): Promise<ExecutionResult> {
    const started = Date.now();
    let dispatched = false;
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
    const persist = async () => {
      result.metadata.durationMs = Date.now() - started;
      await observer?.persist(ExecutionResultSchema.parse(result));
    };
    const step = async (
      type: ExecutionStep['type'],
      ref: string,
      action: () => Promise<void>,
    ) => {
      const s: ExecutionStep = {
        stepId: randomUUID(),
        type,
        targetRef: ref,
        status: 'RUNNING',
        attempt: 1,
        startedAt: new Date().toISOString(),
      };
      result.steps.push(s);
      await persist();
      try {
        await action();
        s.status = raw.mode === 'DRY_RUN' ? 'SIMULATED' : 'COMPLETED';
      } catch (e) {
        s.status = 'FAILED';
        s.error =
          e instanceof InspectionError ? e.code : 'ASHBY_EXECUTION_FAILED';
        throw e;
      } finally {
        s.completedAt = new Date().toISOString();
      }
      await persist();
    };
    let session:
      Awaited<ReturnType<BrowserSessionManager['create']>> | undefined;
    try {
      const input = ExecutionInputSchema.parse(raw),
        target = input.plan.destination.target,
        spec = input.inspection.ashbySubmission;
      if (target?.platform !== 'ASHBY' || !spec)
        throw new InspectionError(
          'ASHBY_SUBMISSION_INSPECTION_REQUIRED',
          'Reinspect the Ashby form',
        );
      if (input.previousResult)
        throw new InspectionError(
          'UNSAFE_RESUME',
          'Ashby requests cannot be replayed',
        );
      if (
        input.mode === 'REAL_EXECUTION' &&
        (!this.options.allowRealExecution ||
          !observer?.authorizeDispatch ||
          !input.dispatchIdentity ||
          process.env.VITEST ||
          process.env.NODE_ENV === 'test' ||
          this.options.fixtureOrigin)
      )
        throw new InspectionError(
          'REAL_EXECUTION_DISABLED',
          'Real execution is disabled',
        );
      if (
        input.mode !== 'REAL_EXECUTION' &&
        (!this.options.fixtureOrigin ||
          new URL(input.inspection.finalUrl).origin !==
            this.options.fixtureOrigin)
      )
        throw new InspectionError(
          'LOCAL_FIXTURE_REQUIRED',
          'An exact local fixture is required',
        );
      const blocker = ashbySubmissionBlocker(spec);
      if (blocker)
        throw new InspectionError(
          blocker,
          'The employer requires manual action',
        );
      const approved = ashbyApprovedValues(input),
        uploads = new Map<string, Upload>();
      for (const f of spec.fields.filter((f) => f.type === 'File')) {
        const selections = input.preparedApplication.documents.filter(
          (d) => f.fieldIds.includes(d.requirementId) && d.documentId,
        );
        if (selections.length > 1)
          throw new InspectionError(
            'AMBIGUOUS_FIELD',
            'Multiple files selected',
          );
        if (!selections.length) {
          if (f.required)
            throw new InspectionError(
              'REQUIRED_DOCUMENT_MISSING',
              'A required file is missing',
            );
          continue;
        }
        const d = input.documents.find(
          (d) => d.id === selections[0]!.documentId,
        )!;
        const requirement = input.inspection.documents.find(
          (d) => d.fieldId === selections[0]!.requirementId,
        )!;
        const file = await this.options.documents.resolve(
          d,
          requirement.acceptedFileTypes,
        );
        if (
          input.mode === 'REAL_EXECUTION' &&
          digest(file.buffer) !== d.metadata.contentDigest
        )
          throw new InspectionError(
            'DOCUMENT_CONTENT_MISMATCH',
            'Approved document bytes changed',
          );
        uploads.set(f.path, file);
      }
      const policy =
        this.options.policy ??
        new DestinationPolicy(this.options.fixtureOrigin);
      const endpoint = (op: string) =>
        `${new URL(input.inspection.finalUrl).origin}/api/non-user-graphql?op=${op}`;
      // Reading the form is permitted, but its JavaScript cannot send applicant mutations.
      const manager = new BrowserSessionManager(
        true,
        policy,
        Boolean(this.options.fixtureOrigin),
      );
      session = await manager.create(
        (url) => {
          if (url !== input.inspection.finalUrl)
            throw new InspectionError(
              'APPLICATION_IDENTITY_CHANGED',
              'Application destination changed',
            );
        },
        (url, method, body, contentType) =>
          isOptionalAshbyTelemetry(
            target.fixtureSourceUrl ?? input.inspection.finalUrl,
            url,
            method,
          )
            ? 'BLOCK_OPTIONAL'
            : isAshbyReadRequest(
                target.fixtureSourceUrl ?? input.inspection.finalUrl,
                url,
                method,
                body,
                contentType,
                this.options.fixtureOrigin,
              ),
      );
      let posting: AshbyPosting | undefined;
      const reads: Promise<void>[] = [];
      session.page.on('response', (r) => {
        if (new URL(r.url()).searchParams.get('op') === 'ApiJobPosting')
          reads.push(
            (async () => {
              const p = AshbyPostingSchema.safeParse(
                (await r.json()).data?.jobPosting,
              );
              if (p.success) posting = p.data;
            })(),
          );
      });
      result.status = 'RUNNING';
      await persist();
      await step('NAVIGATE', 'ashby-form', async () => {
        const r = await session!.page.goto(input.inspection.finalUrl, {
          waitUntil: 'domcontentloaded',
          timeout: 15000,
        });
        if (!r || r.status() >= 400)
          throw new InspectionError(
            'NAVIGATION_FAILED',
            'Application page failed to load',
          );
        await waitForFormRendering(session!.page);
        await Promise.all(reads);
        await session!.securityCheck();
      });
      await step('VALIDATE_PAGE', 'ashby-form', async () => {
        const security = await inspectSecurityControls(session!.page);
        if (!security.complete)
          throw new InspectionError(
            'SECURITY_INSPECTION_INCOMPLETE',
            'Security checks incomplete',
          );
        if (security.captcha || security.authentication)
          throw new InspectionError(
            security.captcha ? 'CAPTCHA' : 'AUTHENTICATION_REQUIRED',
            'Employer action is required',
          );
        const page = await extractPage(session!.page);
        if (
          page.title !== input.inspection.title ||
          classifyPage(page).authentication.required ||
          !posting ||
          posting.id !== target.externalJobId
        )
          throw new InspectionError(
            'APPLICATION_IDENTITY_CHANGED',
            'Application identity changed',
          );
        const fresh = captureAshbySubmission(posting, page.fields);
        if (!fresh || !sameAshbyDefinition(spec, fresh))
          throw new InspectionError(
            'ASHBY_FORM_CHANGED',
            'Employer form changed; reinspect before submitting',
          );
      });
      const form = posting!.applicationForm;
      const base = {
        organizationHostedJobsPageName: target.boardToken,
        formRenderIdentifier: form.id,
        formDefinitionIdentifier: form.sourceFormDefinitionId,
      };
      const send = async (
        url: string,
        body: Uint8Array,
        contentType: string,
        final = false,
      ) => {
        const now = new Date().toISOString();
        const mutation: NonNullable<ExecutionResult['mutations']>[number] = {
          mutationId: randomUUID(),
          executionId: input.executionId,
          stepId: result.steps.at(-1)!.stepId,
          action: final ? 'FINAL_SUBMIT' : 'NEXT',
          destination: `${new URL(url).origin}${new URL(url).pathname}`,
          method: 'POST',
          requestDigest: digest(body),
          documentDigests: [...uploads.values()].map((f) => digest(f.buffer)),
          startedAt: now,
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
              await session!.securityCheck();
              const security = await inspectSecurityControls(session!.page);
              if (
                !security.complete ||
                security.captcha ||
                security.authentication
              )
                throw new InspectionError(
                  'HUMAN_REVIEW_DISPATCH_BLOCKED',
                  'Employer action is required',
                );
              await observer?.authorizeDispatch?.();
              mutation.outcome = 'DISPATCHING';
              await persist();
              sent = true;
              if (final) dispatched = true;
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
        } catch (e) {
          mutation.outcome = sent ? 'UNKNOWN' : 'REJECTED';
          mutation.completedAt = new Date().toISOString();
          await persist();
          throw e;
        }
      };
      const graphql = async (
        op: string,
        query: string,
        variables: Record<string, unknown>,
        final = false,
      ) => {
        const response = await send(
          endpoint(op),
          Buffer.from(JSON.stringify({ operationName: op, query, variables })),
          'application/json',
          final,
        );
        let json: {
          errors?: unknown[];
          data?: {
            setFormValue?: { id?: string };
            setFormValueToFile?: { id?: string };
            fileUploadHandle?: {
              handle: string;
              url: string;
              fields: Record<string, unknown>;
            };
            submitApplicationFormAction?: {
              applicationFormResult?: { __typename?: string };
            };
          };
        };
        try {
          json = JSON.parse(response.body.toString('utf8'));
        } catch {
          throw new InspectionError(
            'ASHBY_INVALID_RESPONSE',
            'Invalid provider response',
          );
        }
        if (response.status !== 200 || json.errors?.length || !json.data)
          throw new InspectionError(
            'ASHBY_REQUEST_REJECTED',
            'Provider rejected the request',
          );
        return json.data;
      };
      for (const [path, value] of approved)
        await step('FILL_FIELD', path, async () => {
          if (input.mode === 'DRY_RUN') return;
          const data = await graphql(
            'ApiSetFormValue',
            ASHBY_QUERIES.setValue,
            { ...base, path, value },
          );
          if (data.setFormValue?.id !== form.id)
            throw new InspectionError(
              'ASHBY_FORM_CHANGED',
              'Provider form identity changed',
            );
        });
      for (const [path, file] of uploads)
        await step('UPLOAD_DOCUMENT', path, async () => {
          if (input.mode === 'DRY_RUN') return;
          const data = await graphql(
            'ApiCreateFileUploadHandle',
            ASHBY_QUERIES.uploadHandle,
            {
              organizationHostedJobsPageName: target.boardToken,
              fileUploadContext: 'NonUserFormEngine',
              filename: file.name,
              contentType: file.mimeType,
              contentLength: file.buffer.length,
            },
          );
          const handle = data.fileUploadHandle;
          if (
            typeof handle?.handle !== 'string' ||
            typeof handle.url !== 'string' ||
            !handle.fields ||
            typeof handle.fields !== 'object'
          )
            throw new InspectionError(
              'ASHBY_INVALID_UPLOAD_HANDLE',
              'Provider did not return an upload capability',
            );
          const uploadUrl = new URL(handle.url);
          if (
            uploadUrl.protocol !== 'https:' ||
            uploadUrl.username ||
            uploadUrl.password ||
            uploadUrl.hash ||
            (!this.options.fixtureOrigin &&
              !/^.+\.s3(?:[.-][a-z0-9-]+)?\.amazonaws\.com$/.test(
                uploadUrl.hostname,
              )) ||
            (this.options.fixtureOrigin &&
              uploadUrl.origin !== this.options.fixtureOrigin)
          )
            throw new InspectionError(
              'UNSAFE_UPLOAD_DESTINATION',
              'Upload endpoint is not supported',
            );
          const fd = new FormData();
          fd.append('Content-Type', file.mimeType);
          for (const [key, value] of Object.entries(handle.fields)) {
            if (
              typeof value !== 'string' ||
              key === 'file' ||
              (key === 'Content-Type' && value !== file.mimeType)
            )
              throw new InspectionError(
                'ASHBY_INVALID_UPLOAD_HANDLE',
                'Invalid upload fields',
              );
            if (key !== 'Content-Type') fd.append(key, value);
          }
          fd.append(
            'file',
            new Blob([new Uint8Array(file.buffer)], { type: file.mimeType }),
            file.name,
          );
          const serialized = new Request(uploadUrl, {
            method: 'POST',
            body: fd,
          });
          const response = await send(
            uploadUrl.href,
            new Uint8Array(await serialized.arrayBuffer()),
            serialized.headers.get('content-type')!,
          );
          if (response.status < 200 || response.status >= 300)
            throw new InspectionError(
              'DOCUMENT_UPLOAD_FAILED',
              'Upload was rejected',
            );
          const attached = await graphql(
            'ApiSetFormValueToFile',
            ASHBY_QUERIES.setFile,
            { ...base, path, fileHandle: handle.handle },
          );
          if (attached.setFormValueToFile?.id !== form.id)
            throw new InspectionError(
              'ASHBY_FORM_CHANGED',
              'Provider form identity changed',
            );
        });
      await step('PRE_SUBMIT_VALIDATION', 'ashby-form', async () => {
        await session!.securityCheck();
        if (!isDeepStrictEqual(ashbyApprovedValues(input), approved))
          throw new InspectionError(
            'STALE_EXECUTION_INPUT',
            'Approved inputs changed',
          );
      });
      if (input.mode === 'DRY_RUN') result.status = 'DRY_RUN_COMPLETED';
      else {
        result.status = 'SUBMITTING';
        await persist();
        await step('SUBMIT', 'ashby-submit', async () => {
          const data = await graphql(
            'ApiSubmitSingleApplicationFormAction',
            ASHBY_QUERIES.submit,
            {
              ...base,
              jobPostingId: target.externalJobId,
              actionIdentifier: spec.actionId,
              recaptchaToken: '',
            },
            true,
          );
          const outcome =
            data.submitApplicationFormAction?.applicationFormResult?.__typename;
          const final = result.mutations!.at(-1)!;
          if (outcome === 'FormSubmitSuccess')
            final.providerOutcome = 'CONFIRMED';
          else if (outcome === 'FormRender') final.providerOutcome = 'REJECTED';
          else
            throw new InspectionError(
              'ASHBY_INVALID_RESPONSE',
              'Provider acceptance was not established',
            );
          await persist();
        });
        // Bound server responses are reconciled through the verification worker.
        result.status = 'SUBMISSION_UNKNOWN';
      }
    } catch (e) {
      result.error =
        e instanceof InspectionError ? e.code : 'ASHBY_EXECUTION_FAILED';
      result.status =
        dispatched || result.status === 'SUBMITTING'
          ? 'SUBMISSION_UNKNOWN'
          : 'BLOCKED';
    } finally {
      await session?.close();
    }
    result.completedAt = new Date().toISOString();
    await persist();
    return ExecutionResultSchema.parse(result);
  }
}
