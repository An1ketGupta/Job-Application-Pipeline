import { randomUUID } from 'node:crypto';
import { z } from 'zod';
import { isDeepStrictEqual } from 'node:util';
import { setTimeout as delay } from 'node:timers/promises';
import {
  ExecutionInputSchema,
  ExecutionResultSchema,
  greenhouseSubmissionBlocker,
  preparedValues,
  type ExecutionInput,
  type ExecutionObserver,
  type ExecutionResult,
  type ExecutionStep,
  type DocumentStorage,
} from '@careerlift/domain';
import { BrowserSessionManager, type BrowserSession } from './session.js';
import {
  DestinationPolicy,
  InspectionError,
  type BrowserNetworkPolicy,
} from './policy.js';
import { extractPage } from './extract.js';
import { waitForFormRendering } from './form-readiness.js';
import { inspectSecurityControls } from './security-controls.js';
import { pinnedPost } from './pinned-request.js';
import { digest } from './mutation-contract.js';
import {
  readGreenhousePosting,
  requireGreenhousePosting,
  captureGreenhouseForm,
  sameGreenhouseDefinition,
  isGreenhouseTelemetry,
  isGreenhouseFrame,
  isGreenhouseRecaptcha,
  greenhousePostingFromHtml,
  type GreenhousePosting,
} from './greenhouse-form.js';
import {
  greenhouseApprovedValues,
  greenhouseApplication,
  validateGreenhousePayload,
  type GreenhouseUpload,
} from './greenhouse-payload.js';

type Live = {
  session: BrowserSession;
  result: ExecutionResult;
  fingerprint: string;
  timer: ReturnType<typeof setTimeout>;
  resume(
    input: ExecutionInput,
    observer?: ExecutionObserver,
  ): Promise<ExecutionResult>;
};
type UploadCapability = {
  url: string;
  key: string;
  fields: Record<string, string>;
  consumed: boolean;
};
const fingerprint = (input: ExecutionInput) =>
  digest(
    JSON.stringify({
      ...input,
      previousResult: undefined,
      dispatchIdentity: undefined,
    }),
  );
const quote = (v: string) =>
  `"${v
    .replace(/\\/g, '\\\\')
    .replace(/"/g, '\\"')
    .replace(/[\r\n\f]/g, ' ')}"`;
const escapeRegex = (v: string) => v.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
const uploadKeyPattern = (v: string) =>
  new RegExp(
    `^${v
      .split(/(\{timestamp\}|\{unique_id\})/)
      .map((p) =>
        p === '{timestamp}'
          ? '[0-9]{10,16}'
          : p === '{unique_id}'
            ? '[a-z0-9]{1,30}'
            : escapeRegex(p),
      )
      .join('')}$`,
  );
export interface GreenhouseExecutorOptions {
  documents: DocumentStorage;
  allowRealExecution?: boolean;
  fixtureOrigin?: string;
  policy?: BrowserNetworkPolicy;
  assistedHeadless?: boolean;
  pauseTtlMs?: number;
  assistedSessions?: (
    policy: BrowserNetworkPolicy,
  ) => Pick<BrowserSessionManager, 'create'>;
}

export class GreenhouseApplicationExecutor {
  private readonly live = new Map<string, Live>();
  private readonly finished = new Map<
    string,
    { fingerprint: string; result: ExecutionResult }
  >();
  constructor(private readonly options: GreenhouseExecutorOptions) {}
  async close() {
    for (const entry of this.live.values()) {
      clearTimeout(entry.timer);
      await entry.session.close();
    }
    this.live.clear();
  }
  async execute(
    raw: ExecutionInput,
    initialObserver?: ExecutionObserver,
  ): Promise<ExecutionResult> {
    const completed = this.finished.get(raw.executionId);
    if (completed) {
      if (completed.fingerprint !== fingerprint(raw))
        throw new InspectionError(
          'STALE_EXECUTION_INPUT',
          'This execution already finished with different input',
        );
      return structuredClone(completed.result);
    }
    let existing = this.live.get(raw.executionId);
    if (existing?.session.page.isClosed()) {
      clearTimeout(existing.timer);
      this.live.delete(raw.executionId);
      await existing.session.close();
      existing = undefined;
    }
    if (existing && raw.previousResult) {
      if (
        existing.fingerprint !== fingerprint(raw) ||
        !isDeepStrictEqual(
          existing.result.checkpoint,
          raw.previousResult.checkpoint,
        )
      ) {
        clearTimeout(existing.timer);
        this.live.delete(raw.executionId);
        await existing.session.close();
        throw new InspectionError(
          'STALE_EXECUTION_INPUT',
          'Your prepared application changed',
        );
      }
      clearTimeout(existing.timer);
      this.live.delete(raw.executionId);
      return existing.resume(raw, initialObserver);
    }
    if (existing)
      throw new InspectionError(
        'CONCURRENT_EXECUTION',
        'A Greenhouse browser is already open',
      );
    const started = Date.now();
    let observer = initialObserver,
      input = raw,
      session: BrowserSession | undefined;
    let retained = false,
      dispatched = false,
      failure: InspectionError | undefined;
    let captured:
      { body: Buffer; contentType: string; expires: number } | undefined;
    let pending = 0;
    const files = new Map<string, GreenhouseUpload>(),
      caps = new Map<string, UploadCapability>();
    const approved = new Map<string, string>();
    let expected: Record<string, unknown> | undefined,
      providerFingerprint: string | undefined;
    let posting: GreenhousePosting | undefined;
    const result: ExecutionResult = {
      applicationId: raw.applicationId,
      executionId: raw.executionId,
      mode: raw.mode,
      status: 'PREPARING',
      startedAt: new Date().toISOString(),
      steps: [],
      humanReviewItems: [],
      metadata: { platform: 'GREENHOUSE', durationMs: 0 },
    };
    const policy =
      this.options.policy ?? new DestinationPolicy(this.options.fixtureOrigin);
    const persist = async () => {
      result.metadata.durationMs = Date.now() - started;
      await observer?.persist(ExecutionResultSchema.parse(result));
    };
    const step = async (
      type: ExecutionStep['type'],
      targetRef: string,
      action: () => Promise<void>,
    ) => {
      const item: ExecutionStep = {
        stepId: randomUUID(),
        type,
        targetRef,
        status: 'RUNNING',
        attempt: 1,
        startedAt: new Date().toISOString(),
      };
      result.steps.push(item);
      await persist();
      try {
        await action();
        item.status = input.mode === 'DRY_RUN' ? 'SIMULATED' : 'COMPLETED';
      } catch (e) {
        item.status = 'FAILED';
        item.error =
          e instanceof InspectionError ? e.code : 'GREENHOUSE_EXECUTION_FAILED';
        throw e;
      } finally {
        item.completedAt = new Date().toISOString();
      }
      await persist();
    };
    const check = async () => {
      if (failure) throw failure;
      if (!session || session.page.isClosed())
        throw new InspectionError(
          'GREENHOUSE_SESSION_LOST',
          'The browser was closed',
        );
      if (session.page.url() !== input.inspection.finalUrl)
        throw new InspectionError(
          'APPLICATION_IDENTITY_CHANGED',
          'The application destination changed',
        );
      await session.securityCheck();
      const security = await inspectSecurityControls(session.page, undefined, {
        allowRecaptchaFrames: true,
      });
      if (!security.complete || security.authentication)
        throw new InspectionError(
          'HUMAN_REVIEW_DISPATCH_BLOCKED',
          'The employer requires additional verification',
        );
    };
    const send = async (
      url: string,
      body: Buffer,
      contentType: string,
      final: boolean,
    ) => {
      const mutation: NonNullable<ExecutionResult['mutations']>[number] = {
        mutationId: randomUUID(),
        executionId: input.executionId,
        stepId: result.steps.at(-1)!.stepId,
        action: final ? 'FINAL_SUBMIT' : 'NEXT',
        destination: new URL(url).origin + new URL(url).pathname,
        method: 'POST',
        requestDigest: digest(body),
        documentDigests: [...files.values()].map((f) => digest(f.buffer)),
        startedAt: new Date().toISOString(),
        outcome: 'AUTHORIZED',
      };
      (result.mutations ??= []).push(mutation);
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
    const finish = async (e?: unknown) => {
      if (e) {
        result.error =
          e instanceof InspectionError ? e.code : 'GREENHOUSE_EXECUTION_FAILED';
        result.status = dispatched ? 'SUBMISSION_UNKNOWN' : 'BLOCKED';
      }
      if (result.checkpoint) {
        result.checkpoint.resumable = false;
        result.checkpoint.unsafeActionStarted = dispatched;
      }
      result.completedAt = new Date().toISOString();
      await session?.close().catch(() => {});
      await persist();
      const final = ExecutionResultSchema.parse(result);
      this.finished.set(input.executionId, {
        fingerprint: fingerprint(input),
        result: structuredClone(final),
      });
      return final;
    };
    const pause = async (
      reason = 'GREENHOUSE_BROWSER_VERIFICATION_REQUIRED',
    ) => {
      result.status = 'PAUSED_HUMAN_REQUIRED';
      result.error = reason;
      result.humanReviewItems = [
        {
          reason,
          targetRef: 'greenhouse-form',
          stepId: result.steps.at(-1)!.stepId,
          safeContinuationPoint: 'greenhouse-browser',
        },
      ];
      result.checkpoint ??= {
        sessionId: randomUUID(),
        pageIndex: 0,
        nextFieldIndex: 0,
        appliedFieldIds: input.inspection.greenhouseSubmission!.fields.map(
          (f) => f.fieldId,
        ),
        unsafeActionStarted: false,
        resumable: true,
      };
      await persist();
      retained = true;
      const entry: Live = {
        session: session!,
        result,
        fingerprint: fingerprint(input),
        resume,
        timer: setTimeout(
          () => {
            if (this.live.get(input.executionId) === entry) {
              this.live.delete(input.executionId);
              void session?.close();
            }
          },
          this.options.pauseTtlMs ?? 30 * 60 * 1000,
        ),
      };
      entry.timer.unref();
      this.live.set(input.executionId, entry);
      return ExecutionResultSchema.parse(result);
    };
    const resume = async (
      next: ExecutionInput,
      nextObserver?: ExecutionObserver,
    ) => {
      observer = nextObserver;
      retained = false;
      try {
        input = ExecutionInputSchema.parse(next);
        result.status = 'RUNNING';
        result.humanReviewItems = [];
        delete result.error;
        await persist();
        await check();
        if (pending || !captured || captured.expires <= Date.now()) {
          captured = undefined;
          return await pause();
        }
        const current = captured;
        captured = undefined; // Verification payloads are consumed once, never persisted.
        validateGreenhousePayload(
          current.body,
          current.contentType,
          expected!,
          providerFingerprint,
        );
        result.status = 'SUBMITTING';
        result.checkpoint!.resumable = false;
        await persist();
        await step('SUBMIT', 'greenhouse-submit', async () => {
          const spec = input.inspection.greenhouseSubmission!;
          const url = this.options.fixtureOrigin
            ? `${input.inspection.finalUrl}/submit`
            : spec.submitUrl;
          const response = await send(
            url,
            current.body,
            current.contentType,
            true,
          );
          // HTTP success alone is insufficient proof of acceptance. Independent verification follows.
          if (response.status >= 400)
            result.error = 'GREENHOUSE_REQUEST_REJECTED';
        });
        result.status = 'SUBMISSION_UNKNOWN';
        return await finish();
      } catch (e) {
        return await finish(e);
      }
    };
    try {
      input = ExecutionInputSchema.parse(raw);
      const spec = input.inspection.greenhouseSubmission!,
        target = input.plan.destination.target;
      if (!spec || target?.platform !== 'GREENHOUSE')
        throw new InspectionError(
          'GREENHOUSE_SUBMISSION_INSPECTION_REQUIRED',
          'Reinspect the Greenhouse application',
        );
      const blocker = greenhouseSubmissionBlocker(spec, true);
      if (blocker)
        throw new InspectionError(blocker, 'This form needs manual completion');
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
              this.options.fixtureOrigin
      )
        throw new InspectionError(
          'REAL_EXECUTION_DISABLED',
          'Execution is unavailable',
        );
      for (const [k, v] of greenhouseApprovedValues(input)) approved.set(k, v);
      for (const binding of spec.fields.filter((f) => f.type === 'FILE')) {
        const selected = input.preparedApplication.documents.find(
          (d) => d.requirementId === binding.fieldId,
        );
        if (!selected?.documentId) {
          if (binding.required)
            throw new InspectionError(
              'REQUIRED_DOCUMENT_MISSING',
              'Select the required document',
            );
          continue;
        }
        const doc = input.documents.find((d) => d.id === selected.documentId)!;
        const requirement = input.inspection.documents.find(
          (d) => d.fieldId === binding.fieldId,
        )!;
        const file = await this.options.documents.resolve(
          doc,
          requirement.acceptedFileTypes,
        );
        if (digest(file.buffer) !== doc.metadata.contentDigest)
          throw new InspectionError(
            'DOCUMENT_CONTENT_MISMATCH',
            'The selected file changed',
          );
        files.set(binding.name, file);
      }
      const source = target.fixtureSourceUrl ?? input.inspection.finalUrl;
      const manager =
        this.options.assistedSessions?.(policy) ??
        new BrowserSessionManager(
          this.options.assistedHeadless ?? input.mode === 'DRY_RUN',
          policy,
          Boolean(this.options.fixtureOrigin),
        );
      await persist();
      session = await manager.create(
        (u) => {
          if (u !== input.inspection.finalUrl)
            throw new InspectionError(
              'APPLICATION_IDENTITY_CHANGED',
              'Unexpected navigation',
            );
        },
        (u, m) =>
          isGreenhouseTelemetry(source, u, m)
            ? 'BLOCK_OPTIONAL'
            : input.mode !== 'DRY_RUN' &&
              m === 'POST' &&
              isGreenhouseRecaptcha(u),
        (u) => isGreenhouseFrame(source, u),
      );
      const reads: Promise<void>[] = [];
      session.page.on('response', (response) => {
        const u = new URL(response.url()),
          base = new URL(input.inspection.finalUrl);
        if (
          u.origin !== base.origin ||
          u.pathname !==
            `${base.pathname}/uncacheable_attributes/presigned_fields` ||
          response.request().method() !== 'GET'
        )
          return;
        reads.push(
          (async () => {
            const names = u.searchParams.getAll('fields[]');
            if (
              [...u.searchParams.keys()].some((k) => k !== 'fields[]') ||
              !names.length ||
              new Set(names).size !== names.length ||
              names.some(
                (n) =>
                  !spec.fields.some((f) => f.name === n && f.type === 'FILE'),
              )
            )
              throw new InspectionError(
                'GREENHOUSE_INVALID_UPLOAD_HANDLE',
                'Unapproved upload fields',
              );
            const json = z
              .object({ url: z.string().url() })
              .passthrough()
              .parse(await response.json());
            const upload = new URL(json.url);
            if (
              upload.username ||
              upload.password ||
              upload.search ||
              upload.hash ||
              upload.protocol !== 'https:' ||
              (this.options.fixtureOrigin
                ? upload.origin !== this.options.fixtureOrigin
                : !/^grnhse-[a-z0-9-]+\.s3[.-][a-z0-9-]+\.amazonaws\.com$/.test(
                    upload.hostname,
                  ))
            )
              throw new InspectionError(
                'UNSAFE_UPLOAD_DESTINATION',
                'Unapproved document host',
              );
            for (const name of names) {
              const cap = z
                .object({
                  key: z.string().min(1),
                  fields: z.record(z.string()),
                })
                .parse(json[name]);
              if (
                !cap.key.startsWith('stash/applications/') ||
                Object.keys(cap.fields).some((k) =>
                  [
                    'file',
                    'key',
                    'utf8',
                    'authenticity_token',
                    'Content-Type',
                  ].includes(k),
                )
              )
                throw new InspectionError(
                  'GREENHOUSE_INVALID_UPLOAD_HANDLE',
                  'Unapproved upload capability',
                );
              caps.set(name, {
                url: json.url,
                key: cap.key,
                fields: cap.fields,
                consumed: false,
              });
            }
          })().catch((e) => {
            failure =
              e instanceof InspectionError
                ? e
                : new InspectionError(
                    'GREENHOUSE_INVALID_UPLOAD_HANDLE',
                    'Invalid upload metadata',
                  );
          }),
        );
      });
      await session.context.route('**/*', async (route) => {
        const request = route.request();
        if (
          request.method() !== 'POST' ||
          isGreenhouseTelemetry(source, request.url(), 'POST') ||
          isGreenhouseRecaptcha(request.url())
        )
          return route.fallback();
        pending++;
        try {
          if (input.mode === 'DRY_RUN')
            throw new InspectionError(
              'MUTATING_REQUEST_BLOCKED',
              'Dry run cannot write',
            );
          const body = request.postDataBuffer() ?? Buffer.alloc(0),
            contentType = request.headers()['content-type'] ?? '';
          const submitUrl = this.options.fixtureOrigin
            ? `${input.inspection.finalUrl}/submit`
            : spec.submitUrl;
          if (request.url() === submitUrl) {
            if (
              !expected ||
              dispatched ||
              result.status !== 'PAUSED_HUMAN_REQUIRED'
            )
              throw new InspectionError(
                'GREENHOUSE_UNAPPROVED_VALUE',
                'Submission is not ready',
              );
            validateGreenhousePayload(
              body,
              contentType,
              expected,
              providerFingerprint,
            );
            captured = {
              body: Buffer.from(body),
              contentType,
              expires: Date.now() + 90000,
            };
            await route.fulfill({
              status: 409,
              contentType: 'application/json',
              body: JSON.stringify({
                code: 'careerlift-review',
                message:
                  'Verification is ready. Return to CareerLift and continue the application.',
              }),
            });
            return;
          }
          if (body.length > 50 * 1024 * 1024)
            throw new InspectionError(
              'MUTATION_BODY_TOO_LARGE',
              'Document payload is too large',
            );
          const candidates = [...caps].filter(
            ([name, c]) =>
              !c.consumed && c.url === request.url() && files.has(name),
          );
          const data = await new Request(request.url(), {
            method: 'POST',
            headers: { 'content-type': contentType },
            body: new Uint8Array(body),
          }).formData();
          const key = data.get('key');
          const matching = candidates.filter(
            ([, c]) =>
              typeof key === 'string' && uploadKeyPattern(c.key).test(key),
          );
          if (matching.length !== 1)
            throw new InspectionError(
              'GREENHOUSE_INVALID_UPLOAD_HANDLE',
              'Upload destination changed',
            );
          const [name, cap] = matching[0]!,
            file = files.get(name)!;
          const uploaded = data.get('file');
          const allowed = new Set([
            'utf8',
            'key',
            'authenticity_token',
            'Content-Type',
            'file',
            ...Object.keys(cap.fields),
          ]);
          if (
            !uploaded ||
            typeof uploaded === 'string' ||
            uploaded.name !== file.name ||
            uploaded.type !== file.mimeType ||
            digest(new Uint8Array(await uploaded.arrayBuffer())) !==
              digest(file.buffer) ||
            [...data.keys()].some(
              (k) => !allowed.has(k) || data.getAll(k).length !== 1,
            ) ||
            Object.entries(cap.fields).some(([k, v]) => data.get(k) !== v) ||
            data.get('utf8') !== '✓' ||
            data.get('authenticity_token') !== '1234' ||
            data.get('Content-Type') !== 'application/octet-stream'
          )
            throw new InspectionError(
              'DOCUMENT_CONTENT_MISMATCH',
              'Upload differs from the selected document',
            );
          cap.consumed = true;
          const response = await send(request.url(), body, contentType, false);
          if (response.status < 200 || response.status >= 300)
            throw new InspectionError(
              'DOCUMENT_UPLOAD_FAILED',
              'Greenhouse rejected the upload',
            );
          file.url = `${cap.url}/${key}`;
          await route.fulfill({ status: response.status, body: response.body });
        } catch (e) {
          failure =
            e instanceof InspectionError
              ? e
              : new InspectionError(
                  'GREENHOUSE_UNAPPROVED_VALUE',
                  'Unapproved browser request',
                );
          captured = undefined;
          await route.abort('blockedbyclient');
        } finally {
          pending--;
        }
      });
      await step('NAVIGATE', 'greenhouse-form', async () => {
        const response = await session!.page.goto(input.inspection.finalUrl, {
          waitUntil: 'domcontentloaded',
          timeout: 15000,
        });
        if (!response || response.status() >= 400)
          throw new InspectionError(
            'HTTP_ERROR',
            'The application page is unavailable',
          );
        posting = greenhousePostingFromHtml(await response.text(), source);
        await waitForFormRendering(session!.page);
        if (!this.options.fixtureOrigin) {
          // Server-rendered controls precede React event handlers. Wait before typing.
          await session!.page.waitForFunction(
            (name) => {
              const control = document.getElementById(name);
              return (
                control &&
                Object.keys(control).some((key) =>
                  key.startsWith('__reactProps$'),
                )
              );
            },
            spec.fields[0]!.name,
            { timeout: 15000 },
          );
        }
      });
      await step('VALIDATE_PAGE', 'greenhouse-definition', async () => {
        const p = requireGreenhousePosting(
          posting ?? (await readGreenhousePosting(session!.page, source)),
        );
        providerFingerprint = p.jobPost.fingerprint;
        const actual = captureGreenhouseForm(
          await extractPage(session!.page),
          p,
          source,
        );
        if (!sameGreenhouseDefinition(spec, actual))
          throw new InspectionError(
            'GREENHOUSE_FORM_CHANGED',
            'The employer form changed; inspect it again',
          );
        await check();
      });
      if (input.mode === 'DRY_RUN') {
        for (const binding of spec.fields)
          await step(
            binding.type === 'FILE'
              ? 'UPLOAD_DOCUMENT'
              : binding.type === 'SELECT'
                ? 'SELECT_OPTION'
                : 'FILL_FIELD',
            binding.fieldId,
            async () => {},
          );
        result.status = 'DRY_RUN_COMPLETED';
        return await finish();
      }
      result.status = 'RUNNING';
      await persist();
      const page = session.page;
      const country = input.inspection.fields.find(
        (f) => f.domId === 'country',
      );
      const countryValue = country
        ? preparedValues(input).get(country.id)
        : undefined;
      if (countryValue) {
        await step('SELECT_OPTION', country!.id, async () => {
          await page.locator('#country').click();
          await page.locator('#country').fill(countryValue);
          const option = page.getByRole('option', {
            name: new RegExp(
              `^${escapeRegex(countryValue)}(?:\\s+\\+\\d{1,4})?$`,
              'i',
            ),
          });
          await option.first().waitFor({ state: 'visible' });
          if ((await option.count()) !== 1)
            throw new InspectionError(
              'GREENHOUSE_PHONE_COUNTRY_REQUIRED',
              'Select a valid phone country',
            );
          await option.click();
        });
      }
      for (const binding of spec.fields) {
        const field = input.inspection.fields.find(
          (f) => f.id === binding.fieldId,
        )!;
        if (!field.domId)
          throw new InspectionError(
            'GREENHOUSE_FORM_CHANGED',
            'The control identity is missing',
          );
        const control = page.locator(`[id=${quote(field.domId)}]`);
        if ((await control.count()) !== 1)
          throw new InspectionError(
            'GREENHOUSE_FORM_CHANGED',
            'The control is ambiguous',
          );
        if (binding.type === 'FILE') {
          const file = files.get(binding.name);
          if (!file) continue;
          await step('UPLOAD_DOCUMENT', binding.fieldId, async () => {
            const deadline = Date.now() + 10000;
            while (!caps.has(binding.name) && Date.now() < deadline) {
              await delay(100);
              await Promise.all(reads);
              if (failure) throw failure;
            }
            if (!caps.has(binding.name))
              throw new InspectionError(
                'GREENHOUSE_INVALID_UPLOAD_HANDLE',
                'The upload destination was not supplied',
              );
            await control.setInputFiles({
              name: file.name,
              mimeType: file.mimeType,
              buffer: Buffer.from(file.buffer),
            });
            while (!file.url && Date.now() < deadline) {
              if (failure) throw failure;
              await delay(100);
            }
            if (!file.url)
              throw new InspectionError(
                'DOCUMENT_UPLOAD_FAILED',
                'The document was not attached',
              );
          });
        } else {
          const value = approved.get(binding.name);
          if (value === undefined) continue;
          await step(
            binding.type === 'SELECT' ? 'SELECT_OPTION' : 'FILL_FIELD',
            binding.fieldId,
            async () => {
              if (binding.type === 'SELECT') {
                const label = binding.options.find(
                  (o) => o.value === value,
                )!.label;
                if (field.htmlType === 'select-one')
                  await control.selectOption({ label });
                else {
                  await control.click();
                  const option = page.getByRole('option', {
                    name: label,
                    exact: true,
                  });
                  await option.first().waitFor({ state: 'visible' });
                  if ((await option.count()) !== 1)
                    throw new InspectionError(
                      'INVALID_OPTION',
                      'The inspected choice changed',
                    );
                  await option.click();
                }
              } else await control.fill(value);
              await check();
            },
          );
        }
      }
      const timeZone = await page.evaluate(
        () => Intl.DateTimeFormat().resolvedOptions().timeZone,
      );
      expected = greenhouseApplication(input, approved, files, timeZone);
      await check();
      return await pause(
        raw.previousResult ? 'GREENHOUSE_SESSION_REOPENED' : undefined,
      );
    } catch (e) {
      return await finish(e);
    } finally {
      if (!retained) await session?.close().catch(() => {});
    }
  }
}
