import { randomUUID, createHash } from 'node:crypto';
import { isDeepStrictEqual } from 'node:util';
import type { Locator, Page, ElementHandle } from 'playwright';
import {
  ExecutionInputSchema,
  ExecutionResultSchema,
  preparedValues,
  type ApplicationExecutor,
  type ApplicationField,
  type ApplicationPlan,
  type DocumentStorage,
  type ExecutionInput,
  type ExecutionObserver,
  type ExecutionResult,
  type ExecutionStep,
  type ExecutionControl,
} from '@careerlift/domain';
import { BrowserSessionManager, type BrowserSession } from './session.js';
import {
  DestinationPolicy,
  InspectionError,
  type BrowserNetworkPolicy,
} from './policy.js';
import { ExecutionNetworkPolicy } from './execution-policy.js';
import { classifyPage, extractPage } from './extract.js';
import { detectPlatform } from './platform.js';
import {
  inspectSecurityControls,
  reviewControlsRemoved,
  type SecuritySnapshot,
} from './security-controls.js';
import { mutateBoundField, pinField } from './field-mutation.js';
import { suspendPageScripts } from './trusted-dom.js';
import { AshbyApplicationExecutor } from './ashby-executor.js';
import {
  bindContract,
  contractDigest,
  digest,
  type RequestField,
} from './mutation-contract.js';

const cssString = (value: string) =>
  `"${value
    .replace(/\\/g, '\\\\')
    .replace(/"/g, '\\"')
    .replace(/[\r\n\f]/g, ' ')}"`;
const byId = (page: Page, id: string) => page.locator(`[id=${cssString(id)}]`);
class ExecutionGate extends InspectionError {
  constructor(
    code: string,
    readonly targetRef: string,
    readonly human = false,
    readonly reviewFingerprint?: string,
  ) {
    super(code, code);
  }
}
type RetainedSession = {
  session: BrowserSession;
  policy: ExecutionNetworkPolicy;
  fingerprint: string;
  expires: number;
  timer: ReturnType<typeof setTimeout>;
  result: ExecutionResult;
};
export interface BrowserExecutorOptions {
  documents: DocumentStorage;
  fixtureOrigin?: string;
  fixtureTargets?: ReadonlyMap<string, string>;
  allowRealExecution?: boolean;
  policy?: BrowserNetworkPolicy;
  sessions?: (
    policy: ExecutionNetworkPolicy,
  ) => Pick<BrowserSessionManager, 'create' | 'networkPolicy'>;
  pauseTtlMs?: number;
  receiptTimeoutMs?: number;
}
export class BrowserApplicationExecutor implements ApplicationExecutor {
  private readonly retained = new Map<string, RetainedSession>();
  constructor(private readonly options: BrowserExecutorOptions) {}
  canHandle(plan: ApplicationPlan) {
    return plan.executor === 'BROWSER' && !plan.requiresHumanReview;
  }
  async close() {
    for (const entry of this.retained.values()) {
      clearTimeout(entry.timer);
      await entry.session.close();
    }
    this.retained.clear();
  }
  async execute(
    raw: ExecutionInput,
    observer?: ExecutionObserver,
  ): Promise<ExecutionResult> {
    if (raw.inspection.ashbySubmission && !raw.inspection.executionFlow)
      return new AshbyApplicationExecutor(this.options).execute(raw, observer);
    const started = Date.now();
    let result: ExecutionResult = {
      applicationId: raw.applicationId,
      executionId: raw.executionId,
      mode: raw.mode,
      status: 'PREPARING',
      startedAt: new Date().toISOString(),
      steps: [],
      humanReviewItems: [],
      metadata: { platform: 'UNKNOWN', durationMs: 0 },
    };
    let session: BrowserSession | undefined;
    let policy: ExecutionNetworkPolicy | undefined;
    let retain = false;
    let submissionInitiated = false;
    let releaseDispatchFence: (() => Promise<void>) | undefined;
    let reviewSnapshot: SecuritySnapshot | undefined;
    const persist = async () => {
      result.metadata.durationMs = Date.now() - started;
      ExecutionResultSchema.parse(result);
      await observer?.persist(result);
    };
    const step = async (
      type: ExecutionStep['type'],
      targetRef: string,
      action: () => Promise<void>,
      simulate = false,
    ) => {
      const item: ExecutionStep = {
        stepId: randomUUID(),
        type,
        targetRef,
        status: 'RUNNING',
        attempt:
          result.steps.filter(
            (s) => s.type === type && s.targetRef === targetRef,
          ).length + 1,
        startedAt: new Date().toISOString(),
      };
      result.steps.push(item);
      await persist(); // fence stale workers before each browser action
      try {
        await action();
        await session?.securityCheck();
        item.status = simulate ? 'SIMULATED' : 'COMPLETED';
      } catch (error) {
        let failure = error;
        try {
          await session?.securityCheck();
        } catch (networkError) {
          failure = networkError;
        }
        item.status =
          failure instanceof ExecutionGate && failure.human
            ? 'HUMAN_REQUIRED'
            : 'FAILED';
        item.error =
          failure instanceof InspectionError
            ? failure.code
            : 'BROWSER_ACTION_FAILED';
        throw failure;
      } finally {
        item.completedAt = new Date().toISOString();
      }
      await persist();
    };
    try {
      const parsed = ExecutionInputSchema.safeParse(raw);
      if (!parsed.success)
        throw new ExecutionGate('EXECUTION_PREFLIGHT_FAILED', 'preflight');
      const input = parsed.data;
      result.metadata.platform = input.inspection.platform;
      if (input.mode === 'REAL_EXECUTION') {
        if (
          !this.options.allowRealExecution ||
          !observer ||
          !observer.authorizeDispatch ||
          process.env.VITEST ||
          process.env.NODE_ENV === 'test' ||
          this.options.fixtureOrigin
        )
          throw new ExecutionGate('REAL_EXECUTION_DISABLED', 'mode');
        if (!input.plan.destination.target)
          throw new ExecutionGate(
            'UNSUPPORTED_APPLICATION_PLATFORM',
            'mode',
            true,
          );
      } else {
        if (
          !this.options.fixtureOrigin ||
          new URL(input.inspection.finalUrl).origin !==
            this.options.fixtureOrigin
        )
          throw new ExecutionGate('LOCAL_FIXTURE_REQUIRED', 'mode');
        const target = input.plan.destination.target;
        if (
          target?.fixtureSourceUrl &&
          this.options.fixtureTargets?.get(target.canonicalUrl) !==
            target.fixtureSourceUrl
        )
          throw new ExecutionGate('UNTRUSTED_FIXTURE_TARGET', 'mode');
        new DestinationPolicy(this.options.fixtureOrigin); // enforce exact loopback capability
        if (
          !['127.0.0.1', '[::1]'].includes(
            new URL(this.options.fixtureOrigin).hostname,
          )
        )
          throw new ExecutionGate('LOCAL_FIXTURE_REQUIRED', 'mode');
      }
      const flow = input.inspection.executionFlow;
      if (!flow)
        throw new ExecutionGate('EXPLICIT_FLOW_REQUIRED', 'flow', true);
      policy = new ExecutionNetworkPolicy(
        input,
        this.options.policy ??
          new DestinationPolicy(
            input.mode === 'REAL_EXECUTION'
              ? undefined
              : this.options.fixtureOrigin,
          ),
      );
      const installRejectionAuditor = () =>
        policy!.setRejectionAuditor(async (url, method, body) => {
          const destination = new URL(url);
          const now = new Date().toISOString();
          result.mutations ??= [];
          result.mutations.push({
            mutationId: randomUUID(),
            executionId: input.executionId,
            stepId: result.steps.at(-1)?.stepId ?? 'preflight',
            action:
              result.steps.at(-1)?.type === 'NAVIGATE_NEXT'
                ? 'NEXT'
                : 'FINAL_SUBMIT',
            destination: `${destination.origin}${destination.pathname}`,
            method,
            requestDigest: digest(body),
            documentDigests: [],
            startedAt: now,
            completedAt: now,
            outcome: 'REJECTED',
          });
          await persist();
        });
      installRejectionAuditor();
      for (const url of new Set(
        flow.pages.flatMap((p) => [p.url, p.expectedUrl, p.control.actionUrl]),
      ))
        await policy.validateAddress(url);
      const uploads = new Map<
        string,
        { name: string; mimeType: string; buffer: Uint8Array }
      >();
      // Resolve all files before opening a browser.
      for (const selected of input.preparedApplication.documents) {
        if (!selected.documentId) continue;
        const document = input.documents.find(
          (d) => d.id === selected.documentId,
        )!;
        if (
          input.mode === 'REAL_EXECUTION' &&
          !/^[a-f0-9]{64}$/.test(String(document.metadata.contentDigest ?? ''))
        )
          throw new ExecutionGate(
            'DOCUMENT_CONTENT_IDENTITY_REQUIRED',
            selected.requirementId,
            true,
          );
        const requirement = input.inspection.documents.find(
          (d) => d.fieldId === selected.requirementId,
        )!;
        uploads.set(
          selected.requirementId,
          await this.options.documents.resolve(
            document,
            requirement.acceptedFileTypes,
          ),
        );
      }
      const fingerprint = createHash('sha256')
        .update(
          JSON.stringify({
            ...input,
            previousResult: undefined,
            dispatchIdentity: undefined,
          }),
        )
        .digest('hex');
      const previous = input.previousResult;
      if (previous) {
        const entry = this.retained.get(input.executionId);
        if (
          !entry ||
          entry.expires < Date.now() ||
          entry.fingerprint !== fingerprint ||
          !isDeepStrictEqual(entry.result.checkpoint, previous.checkpoint)
        )
          throw new ExecutionGate('SESSION_EXPIRED_OR_CHANGED', 'checkpoint');
        clearTimeout(entry.timer);
        this.retained.delete(input.executionId);
        session = entry.session;
        policy = entry.policy;
        policy.rebindDispatch(input);
        result = structuredClone(previous);
        result.status = 'RUNNING';
        installRejectionAuditor();
        delete result.error;
        delete result.completedAt;
      } else {
        await persist(); // Recheck the durable lease and input freshness before browser launch.
        const manager =
          this.options.sessions?.(policy) ??
          new BrowserSessionManager(
            true,
            policy,
            input.mode !== 'REAL_EXECUTION',
          );
        // Session factory is trusted infrastructure and must preserve the execution policy.
        if (manager.networkPolicy !== policy)
          throw new ExecutionGate('INVALID_SESSION_POLICY', 'session');
        session = await manager.create();
        result.checkpoint = {
          sessionId: randomUUID(),
          pageIndex: 0,
          nextFieldIndex: 0,
          appliedFieldIds: [],
          unsafeActionStarted: false,
          resumable: true,
        };
        result.status = 'RUNNING';
        await step('NAVIGATE', 'page-0', async () => {
          const response = await session!.page.goto(flow.pages[0]!.url, {
            waitUntil: 'domcontentloaded',
          });
          if (!response || response.status() >= 400)
            throw new ExecutionGate('NAVIGATION_FAILED', 'page-0');
        });
      }
      await persist();
      const page = session.page;
      const checkpoint = result.checkpoint!;
      const documentIdentities = [...uploads].map(([fieldId, file]) => ({
        fieldId,
        documentId: input.preparedApplication.documents.find(
          (d) => d.requirementId === fieldId,
        )!.documentId!,
        sha256: digest(file.buffer),
        name: file.name,
        mimeType: file.mimeType,
        size: file.buffer.length,
      }));
      if (
        checkpoint.documentIdentities &&
        JSON.stringify(checkpoint.documentIdentities) !==
          JSON.stringify(documentIdentities)
      )
        throw new ExecutionGate('DOCUMENT_IDENTITY_CHANGED', 'documents');
      checkpoint.documentIdentities = documentIdentities;
      if (
        previous &&
        checkpoint.reviewRequirement &&
        checkpoint.reviewRequirement.status !== 'RESOLVED'
      ) {
        const security = await inspectSecurityControls(page);
        const requirement = checkpoint.reviewRequirement;
        const documentTransition =
          requirement.documentBackendNodeId !== undefined &&
          security.documentBackendNodeId !== undefined &&
          requirement.documentBackendNodeId !==
            security.documentBackendNodeId &&
          Boolean(requirement.controls?.length) &&
          requirement.controls!.every(
            (old) =>
              !security.nodes.some(
                (node) => node.backendNodeId === old.backendNodeId,
              ),
          );
        if (
          page.url() !== requirement.pageUrl ||
          !security.complete ||
          security.captcha ||
          security.authentication ||
          (requirement.type !== 'FLOW_CONTROL' &&
            !documentTransition &&
            (!reviewControlsRemoved(requirement.controls ?? [], security) ||
              !requirement.surroundingDomDigest ||
              requirement.surroundingDomDigest !==
                security.surroundingDomDigest))
        )
          throw new ExecutionGate(
            requirement.reason,
            `page-${checkpoint.pageIndex}`,
            true,
            security.fingerprint,
          );
        // Absence from classification is insufficient. Security review requires
        // original browser node removal and no equivalent replacement container.
        requirement.status = 'RESOLVED';
        requirement.resolvedAt = new Date().toISOString();
        if (requirement.type !== 'FLOW_CONTROL')
          requirement.resolution = documentTransition
            ? 'TRUSTED_DOCUMENT_TRANSITION'
            : 'TRUSTED_CONTROL_REMOVAL';
        result.humanReviewItems = [];
        await persist();
      }
      const values = preparedValues(input);
      const valueField = (
        field: ApplicationField,
        value: string | null | undefined,
      ) => {
        if (field.type !== 'RADIO' || value == null || field.choiceGroup)
          return field;
        const matches = input.inspection.fields.filter(
          (f) =>
            f.type === 'RADIO' &&
            (field.name
              ? f.name === field.name && f.formId === field.formId
              : f.id === field.id) &&
            f.optionValue === value,
        );
        if (matches.length !== 1)
          throw new ExecutionGate('INVALID_OPTION', field.id, true);
        return matches[0]!;
      };
      const validatePage = async (pageIndex: number, atDispatch = false) => {
        if (!atDispatch) await session!.securityCheck();
        policy!.validateNavigation(page.url());
        await policy!.validateAddress(page.url());
        const expected = flow.pages[pageIndex]!;
        const security = await inspectSecurityControls(page);
        reviewSnapshot = security;
        if (!security.complete)
          throw new ExecutionGate(
            'SECURITY_INSPECTION_INCOMPLETE',
            `page-${pageIndex}`,
            true,
            security.fingerprint,
          );
        if (security.authentication)
          throw new ExecutionGate(
            'AUTHENTICATION_REQUIRED',
            `page-${pageIndex}`,
            true,
            security.fingerprint,
          );
        if (security.captcha)
          throw new ExecutionGate(
            'CAPTCHA',
            `page-${pageIndex}`,
            true,
            security.fingerprint,
          );
        const rawPage = await extractPage(page);
        const review = classifyPage(rawPage);
        if (
          review.authentication.required ||
          /type=["']password["']/i.test(rawPage.signature)
        )
          throw new ExecutionGate(
            'AUTHENTICATION_REQUIRED',
            `page-${pageIndex}`,
            true,
          );
        if (review.humanReview.reasons.includes('CAPTCHA'))
          throw new ExecutionGate('CAPTCHA', `page-${pageIndex}`, true);
        if (
          page.url() !== expected.url ||
          rawPage.title !== expected.title ||
          detectPlatform(
            this.options.fixtureTargets?.get(page.url()) ?? page.url(),
            rawPage.signature,
            true,
          ).platform !== input.inspection.platform
        )
          throw new ExecutionGate(
            'APPLICATION_IDENTITY_CHANGED',
            `page-${pageIndex}`,
          );
        await this.locateControl(page, expected.control);
        for (const current of rawPage.fields.filter((f) => f.visible)) {
          const inspected = input.inspection.fields.find((f) =>
            this.sameIdentity(f, current),
          );
          if (
            inspected?.choiceGroup &&
            JSON.stringify(inspected.choiceGroup) !==
              JSON.stringify(current.choiceGroup)
          )
            throw new ExecutionGate('STALE_DOM_FIELD', current.id);
          if (
            !expected.fieldIds.some((id) =>
              this.sameIdentity(
                input.inspection.fields.find((f) => f.id === id)!,
                current,
              ),
            )
          )
            throw new ExecutionGate(
              'UNEXPECTED_DOM_FIELD',
              current.domId ?? 'page',
            );
        }
        if (
          rawPage.fields.some(
            (current) =>
              current.required &&
              !input.inspection.fields.some((expectedField) =>
                this.sameIdentity(expectedField, current),
              ),
          )
        )
          throw new ExecutionGate(
            'UNEXPECTED_REQUIRED_FIELD',
            `page-${pageIndex}`,
          );
      };
      const verifyFields = async (
        index: number,
        dry: boolean,
        fieldIds = flow.pages[index]!.fieldIds,
        allowHidden = false,
      ) => {
        for (const id of fieldIds) {
          const field = input.inspection.fields.find((f) => f.id === id)!;
          const value = values.get(id);
          const actualField = valueField(field, value);
          const locator = await this.locate(page, actualField, allowHidden);
          if (dry) {
            if (field.type !== 'FILE' && value !== null && value !== undefined)
              await this.validateValue(locator, actualField, value);
            continue;
          }
          const state = await locator.evaluate((element) => {
            const control = element as HTMLInputElement;
            return {
              value: control.value,
              checked: control.checked,
              files: control.files?.length ?? 0,
              valid: control.checkValidity(),
            };
          });
          const approvedDocument = documentIdentities.find(
            (d) => d.fieldId === id,
          );
          if (approvedDocument) {
            const files = await locator.evaluate(async (element) => {
              const files = (element as HTMLInputElement).files;
              return files
                ? Promise.all(
                    Array.from(files).map(async (file) => ({
                      name: file.name,
                      mimeType: file.type,
                      size: file.size,
                      bytes: Array.from(
                        new Uint8Array(await file.arrayBuffer()),
                      ),
                    })),
                  )
                : [];
            });
            if (
              files.length !== 1 ||
              files[0]!.name !== approvedDocument.name ||
              files[0]!.mimeType !== approvedDocument.mimeType ||
              files[0]!.size !== approvedDocument.size ||
              digest(new Uint8Array(files[0]!.bytes)) !==
                approvedDocument.sha256
            )
              throw new ExecutionGate('DOCUMENT_CONTENT_MISMATCH', id);
          }
          if (
            (field.required && !state.valid) ||
            (uploads.has(id) && state.files !== 1) ||
            (value !== null &&
              value !== undefined &&
              field.type !== 'FILE' &&
              (field.type === 'CHECKBOX'
                ? state.checked !== (value === 'true')
                : field.type === 'RADIO'
                  ? !state.checked || state.value !== value
                  : field.type === 'SELECT'
                    ? !(
                        await locator
                          .locator('option:checked')
                          .allTextContents()
                      ).some((text) => text.trim() === value) &&
                      state.value !== value
                    : state.value !== value))
          )
            throw new ExecutionGate('PRE_SUBMIT_VALUE_MISMATCH', id);
        }
      };
      const verifyPriorFields = async (index: number) => {
        const present: string[] = [];
        for (const id of checkpoint.appliedFieldIds.filter(
          (id) => !flow.pages[index]!.fieldIds.includes(id),
        )) {
          const field = valueField(
            input.inspection.fields.find((f) => f.id === id)!,
            values.get(id),
          );
          const locator = field.domId
            ? byId(page, field.domId)
            : field.name
              ? page.locator(`[name=${cssString(field.name)}]`)
              : page.getByLabel(field.label, { exact: true });
          if (await locator.count()) present.push(id);
        }
        await verifyFields(index, false, present, true);
      };
      const authorizeAction = async (
        action: 'NEXT' | 'FINAL_SUBMIT',
        destination: string,
        method: string,
        index: number,
      ) => {
        const expected = flow.pages[index]!;
        const inspectedForm = input.inspection.forms.find(
          (f) => f.id === expected.control.formId,
        )!;
        const current = await extractPage(page);
        const currentForm = current.forms.find(
          (f) => f.id === expected.control.formId,
        );
        if (!currentForm)
          throw new ExecutionGate(
            'APPLICATION_IDENTITY_CHANGED',
            expected.control.domId,
            true,
          );
        const fields: RequestField[] = [];
        const approvedHidden = inspectedForm.hiddenFields ?? [];
        const actualHidden = await byId(page, expected.control.domId).evaluate(
          (element) => {
            const form = (element as HTMLButtonElement).form;
            return form
              ? Array.from(form.elements)
                  .filter(
                    (e): e is HTMLInputElement =>
                      e instanceof HTMLInputElement && e.type === 'hidden',
                  )
                  .map((e) => ({ name: e.name, value: e.value }))
              : [];
          },
        );
        if (
          actualHidden.length !== approvedHidden.length ||
          new Set(actualHidden.map((f) => f.name)).size !== actualHidden.length
        )
          throw new ExecutionGate(
            'UNEXPECTED_HIDDEN_FIELD',
            expected.control.domId,
            true,
          );
        for (const hidden of approvedHidden) {
          const actual = actualHidden.find((f) => f.name === hidden.name);
          const dynamic = expected.dynamicFields?.find(
            (f) => f.name === hidden.name,
          );
          if (
            !hidden.name ||
            !actual ||
            (dynamic
              ? !/^[a-zA-Z0-9_.:/+=-]{16,4096}$/.test(actual.value) ||
                /job|posting|requisition/i.test(hidden.name)
              : digest(actual.value) !== hidden.valueDigest)
          )
            throw new ExecutionGate(
              'HIDDEN_FIELD_CHANGED',
              expected.control.domId,
              true,
            );
          fields.push({
            name: hidden.name,
            kind: dynamic ? 'DYNAMIC_APPROVED_FIELD' : 'STATIC_APPROVED_FIELD',
            value: actual.value,
          });
        }
        if (
          expected.dynamicFields?.some(
            (d) => !approvedHidden.some((h) => h.name === d.name),
          )
        )
          throw new ExecutionGate(
            'UNAPPROVED_DYNAMIC_FIELD',
            expected.control.domId,
            true,
          );
        for (const field of input.inspection.fields.filter(
          (f) =>
            f.formId === inspectedForm.id &&
            (action === 'FINAL_SUBMIT' || expected.fieldIds.includes(f.id)),
        )) {
          const value = values.get(field.id);
          if (field.type === 'RADIO' && value == null) continue;
          if (field.type === 'CHECKBOX' && value !== 'true') continue;
          const actualField = valueField(field, value);
          const name =
            actualField.name ??
            current.fields.find((f) => this.sameIdentity(actualField, f))?.name;
          if (!name)
            throw new ExecutionGate(
              'REQUEST_FIELD_IDENTITY_REQUIRED',
              field.id,
              true,
            );
          if (field.type === 'FILE') {
            const document = documentIdentities.find(
              (d) => d.fieldId === field.id,
            );
            if (!document)
              throw new ExecutionGate(
                'DOCUMENT_IDENTITY_REQUIRED',
                field.id,
                true,
              );
            fields.push({
              name,
              kind: 'DOCUMENT',
              documentId: document.documentId,
              fileName: document.name,
              mimeType: document.mimeType,
              size: document.size,
              sha256: document.sha256,
            });
          } else {
            let serializedValue = value ?? '';
            if (field.type === 'SELECT') {
              const options = field.selectOptions?.filter(
                (o) => !o.disabled && (o.label === value || o.value === value),
              );
              if (!options || options.length !== 1)
                throw new ExecutionGate('INVALID_OPTION', field.id, true);
              serializedValue = options[0]!.value;
            } else if (field.type === 'CHECKBOX')
              serializedValue = field.checkboxValue ?? 'on';
            fields.push({
              name,
              kind: 'STATIC_APPROVED_FIELD',
              value: serializedValue.replace(/\r?\n/g, '\r\n'),
            });
          }
        }
        if (action === 'NEXT') {
          const discriminator = expected.nextRequest!.discriminator;
          if (
            discriminator.value === discriminator.finalValue ||
            fields.some((f) => f.name === discriminator.name)
          )
            throw new ExecutionGate(
              'AMBIGUOUS_NEXT_MUTATION',
              expected.control.domId,
              true,
            );
          fields.push({
            name: discriminator.name,
            kind: 'STATIC_APPROVED_FIELD',
            value: discriminator.value,
          });
        }
        const stepId = result.steps.at(-1)!.stepId;
        const contract = bindContract(
          input,
          stepId,
          action,
          destination,
          method,
          fields,
        );
        const mutation = {
          mutationId: randomUUID(),
          executionId: input.executionId,
          stepId,
          action,
          destination: `${new URL(destination).origin}${new URL(destination).pathname}`,
          method,
          requestDigest: contractDigest(contract),
          documentDigests: fields
            .filter((f) => f.kind === 'DOCUMENT')
            .map((f) => (f.kind === 'DOCUMENT' ? f.sha256 : '')),
          startedAt: new Date().toISOString(),
          outcome: 'AUTHORIZED' as const,
        };
        result.mutations ??= [];
        result.mutations.push(mutation);
        await persist(); // Durable authorization evidence precedes creation of the in-memory authority.
        policy!.allowMutation(
          contract,
          result.status,
          async (outcome, response) => {
            if (outcome !== 'DISPATCHING' && releaseDispatchFence) {
              const release = releaseDispatchFence;
              releaseDispatchFence = undefined;
              await release();
            }
            const audit = result.mutations!.find(
              (m) => m.mutationId === mutation.mutationId,
            )!;
            audit.outcome = outcome;
            if (response) Object.assign(audit, response);
            if (outcome !== 'DISPATCHING')
              audit.completedAt = new Date().toISOString();
            await persist();
          },
          async () => {
            await validatePage(index, true);
            await verifyFields(index, false);
            if (action === 'FINAL_SUBMIT') await verifyPriorFields(index);
            await observer?.authorizeDispatch?.();
            // All persistence/freshness awaits precede this trusted checkpoint.
            // Hold Chromium page scripts suspended through request.end(body).
            const fence = await suspendPageScripts(page);
            releaseDispatchFence = fence.release;
            await validatePage(index, true);
            await verifyFields(index, false);
            if (action === 'FINAL_SUBMIT') await verifyPriorFields(index);
            const finalSecurity = await inspectSecurityControls(page);
            if (
              !finalSecurity.complete ||
              finalSecurity.captcha ||
              finalSecurity.authentication ||
              (checkpoint.reviewRequirement &&
                checkpoint.reviewRequirement.status !== 'RESOLVED')
            )
              throw new ExecutionGate(
                'HUMAN_REVIEW_DISPATCH_BLOCKED',
                `page-${index}`,
                true,
                finalSecurity.fingerprint,
              );
          },
        );
      };
      for (; checkpoint.pageIndex < flow.pages.length; checkpoint.pageIndex++) {
        const index = checkpoint.pageIndex,
          expected = flow.pages[index]!;
        await step('VALIDATE_PAGE', `page-${index}`, () => validatePage(index));
        for (
          ;
          checkpoint.nextFieldIndex < expected.fieldIds.length;
          checkpoint.nextFieldIndex++
        ) {
          const id = expected.fieldIds[checkpoint.nextFieldIndex]!;
          const field = input.inspection.fields.find((f) => f.id === id)!;
          const value = values.get(id),
            upload = uploads.get(id);
          if (!upload && (value === null || value === undefined)) continue;
          // Challenges and page changes are checked again immediately before every mutation.
          await validatePage(index);
          policy.sealReads();
          const actualField = valueField(field, value);
          const locator = await this.locate(page, actualField);
          if (value !== null && value !== undefined)
            await this.validateValue(locator, actualField, value);
          if (upload) {
            const accepted = ((await locator.getAttribute('accept')) ?? '')
              .split(',')
              .map((s) => s.trim())
              .filter(Boolean);
            const inspected = input.inspection.documents.find(
              (d) => d.fieldId === id,
            )!.acceptedFileTypes;
            if (JSON.stringify(accepted) !== JSON.stringify(inspected))
              throw new ExecutionGate('DOCUMENT_ACCEPT_CHANGED', id);
          }
          const type =
            field.type === 'FILE'
              ? 'UPLOAD_DOCUMENT'
              : field.type === 'SELECT'
                ? 'SELECT_OPTION'
                : ['RADIO', 'CHECKBOX'].includes(field.type)
                  ? 'CHECK_OPTION'
                  : 'FILL_FIELD';
          const boundNode =
            input.mode !== 'DRY_RUN' && field.type !== 'FILE'
              ? await pinField(page, actualField)
              : undefined;
          await step(
            type,
            id,
            async () => {
              if (input.mode === 'DRY_RUN') return;
              await this.locate(page, actualField);
              if (field.type === 'FILE') {
                checkpoint.unsafeActionStarted = true;
                checkpoint.resumable = false;
                await persist();
                const live = await this.locate(page, actualField);
                const handle = await live.elementHandle();
                if (!handle) throw new ExecutionGate('MISSING_FIELD', id);
                await this.locate(page, actualField, false, handle);
                try {
                  await handle.setInputFiles({
                    name: upload!.name,
                    mimeType: upload!.mimeType,
                    buffer: Buffer.from(upload!.buffer),
                  });
                } finally {
                  await handle.dispose();
                }
                checkpoint.unsafeActionStarted = false;
                checkpoint.resumable = true;
              } else
                await mutateBoundField(page, actualField, value!, boundNode!);
              checkpoint.appliedFieldIds.push(id);
            },
            input.mode === 'DRY_RUN',
          );
        }
        await step('PRE_SUBMIT_VALIDATION', `page-${index}`, async () => {
          await validatePage(index);
          await verifyFields(index, input.mode === 'DRY_RUN');
          if (input.mode !== 'DRY_RUN') await verifyPriorFields(index);
          await this.locateControl(page, expected.control);
          if (expected.action === 'SUBMIT' && input.mode !== 'DRY_RUN') {
            const plannedIds = input.inspection.fields
              .filter(
                (f) =>
                  (f.required && f.type !== 'RADIO') ||
                  values.get(f.id) != null ||
                  uploads.has(f.id),
              )
              .map((f) => f.id);
            if (
              plannedIds.some((id) => !checkpoint.appliedFieldIds.includes(id))
            )
              throw new ExecutionGate('UNAPPLIED_FIELD', 'pre-submit');
          }
        });
        if (input.mode === 'DRY_RUN') {
          await step(
            expected.action === 'SUBMIT' ? 'SUBMIT' : 'NAVIGATE_NEXT',
            expected.control.domId,
            async () => {},
            true,
          );
          // A dry run never clicks Next, which may mutate state. Further pages require separate static inspection.
          if (index < flow.pages.length - 1)
            throw new ExecutionGate(
              'DRY_RUN_NEXT_REQUIRES_INSPECTION',
              `page-${index + 1}`,
              true,
            );
          result.status = 'DRY_RUN_COMPLETED';
          checkpoint.resumable = false;
          break;
        }
        if (expected.action === 'NEXT') {
          if (
            expected.control.htmlType === 'submit' ||
            (expected.nextRequest &&
              flow.pages.some(
                (p) =>
                  p.action === 'SUBMIT' &&
                  p.control.actionUrl === expected.nextRequest!.destination,
              ))
          )
            throw new ExecutionGate(
              'AMBIGUOUS_NEXT_MUTATION',
              expected.control.domId,
              true,
            );
          await step('NAVIGATE_NEXT', expected.control.domId, async () => {
            checkpoint.unsafeActionStarted = true;
            checkpoint.resumable = false;
            await persist();
            // DOM-only Next has no mutation permit. Any page-generated POST is denied.
            if (expected.nextRequest)
              await authorizeAction(
                'NEXT',
                expected.nextRequest.destination,
                expected.nextRequest.method,
                index,
              );
            try {
              const control = await this.locateControl(page, expected.control);
              await control.click();
              await page.waitForURL(expected.expectedUrl, {
                waitUntil: 'domcontentloaded',
              });
              await byId(page, flow.pages[index + 1]!.control.domId).waitFor({
                state: 'visible',
              });
              await session!.securityCheck();
              checkpoint.unsafeActionStarted = false;
              checkpoint.resumable = true;
            } finally {
              policy!.closeMutation();
            }
          });
          checkpoint.nextFieldIndex = 0;
          continue;
        }
        // Commit SUBMITTING before the click: no retry may cross this barrier again.
        result.status = 'SUBMITTING';
        checkpoint.unsafeActionStarted = true;
        checkpoint.resumable = false;
        await persist();
        await step('SUBMIT', expected.control.domId, async () => {
          const control = await this.locateControl(page, expected.control);
          await validatePage(index);
          await verifyFields(index, false);
          await verifyPriorFields(index);
          await authorizeAction(
            'FINAL_SUBMIT',
            expected.control.actionUrl,
            expected.control.method,
            index,
          );
          submissionInitiated = true;
          try {
            await control.click();
          } finally {
            policy!.closeMutation();
          }
        });
        if (input.mode === 'TEST_FIXTURE' && flow.fixtureReceipt) {
          // Historical Phase 4 execution observation only. Generic DOM text is
          // never external acceptance evidence; Phase 5 must read server status.
          await step('VERIFY_SUBMISSION', 'fixture-receipt', async () => {
            const receipt = flow.fixtureReceipt!;
            const success = byId(page, receipt.successDomId),
              failure = byId(page, receipt.failureDomId);
            await Promise.race([
              success.waitFor({
                state: 'visible',
                timeout: this.options.receiptTimeoutMs ?? 5000,
              }),
              failure.waitFor({
                state: 'visible',
                timeout: this.options.receiptTimeoutMs ?? 5000,
              }),
            ]);
            await session!.securityCheck();
            if (
              (await failure.isVisible()) &&
              (await failure.textContent())?.trim() === receipt.failureText
            ) {
              result.status = 'FAILED';
              result.error = 'SUBMISSION_REJECTED';
              return;
            }
            if (
              (await success.count()) !== 1 ||
              !(await success.isVisible()) ||
              (await success.textContent())?.trim() !== receipt.successText
            )
              throw new ExecutionGate(
                'SUBMISSION_RECEIPT_MISSING',
                'fixture-receipt',
              );
            result.status = 'SUBMITTED';
            result.submittedAt = new Date().toISOString();
            result.confirmation = {
              identifier: 'fixture-dom-observation',
              source: 'LOCAL_FIXTURE',
            };
          });
        }
        // Sending a real request is not acceptance. Phase 5 reconciles it separately.
        if (result.status === 'SUBMITTING')
          result.status = 'SUBMISSION_UNKNOWN';
        break;
      }
    } catch (error) {
      const code =
        error instanceof InspectionError ? error.code : 'EXECUTION_FAILURE';
      if (
        submissionInitiated ||
        result.checkpoint?.unsafeActionStarted ||
        result.status === 'SUBMITTING'
      ) {
        result.status = 'SUBMISSION_UNKNOWN';
        if (result.checkpoint) result.checkpoint.resumable = false;
      } else if (error instanceof ExecutionGate && error.human) {
        result.status = 'PAUSED_HUMAN_REQUIRED';
        const reviewStep: ExecutionStep = {
          stepId: randomUUID(),
          type: 'HUMAN_REVIEW',
          targetRef: error.targetRef,
          status: 'HUMAN_REQUIRED',
          attempt: 1,
          startedAt: new Date().toISOString(),
          completedAt: new Date().toISOString(),
          error: code,
        };
        result.steps.push(reviewStep);
        result.humanReviewItems = [
          {
            reason: code,
            targetRef: error.targetRef,
            stepId: reviewStep.stepId,
            safeContinuationPoint: result.checkpoint
              ? `page-${result.checkpoint.pageIndex}-field-${result.checkpoint.nextFieldIndex}`
              : 'preflight',
          },
        ];
        if (
          result.checkpoint &&
          session &&
          result.checkpoint.reviewRequirement?.status !== 'ACTIVE'
        )
          result.checkpoint.reviewRequirement = {
            id: randomUUID(),
            type: [
              'CAPTCHA',
              'AUTHENTICATION_REQUIRED',
              'SECURITY_INSPECTION_INCOMPLETE',
            ].includes(code)
              ? 'SECURITY_CONTROL'
              : 'FLOW_CONTROL',
            createdAt: new Date().toISOString(),
            status: 'ACTIVE',
            controls: reviewSnapshot?.controls ?? [],
            ...(reviewSnapshot?.surroundingDomDigest === undefined
              ? {}
              : { surroundingDomDigest: reviewSnapshot.surroundingDomDigest }),
            ...(reviewSnapshot?.documentBackendNodeId === undefined
              ? {}
              : {
                  documentBackendNodeId: reviewSnapshot.documentBackendNodeId,
                }),
            reason: code,
            pageUrl: session.page.url(),
            fingerprint: error.reviewFingerprint ?? digest(code),
            checkpoint: `page-${result.checkpoint.pageIndex}-field-${result.checkpoint.nextFieldIndex}`,
          };
        retain = Boolean(session && result.checkpoint?.resumable);
      } else
        result.status = error instanceof InspectionError ? 'BLOCKED' : 'FAILED';
      result.error =
        result.status === 'SUBMISSION_UNKNOWN'
          ? 'SUBMISSION_OUTCOME_UNKNOWN'
          : code;
    } finally {
      if (releaseDispatchFence) {
        await releaseDispatchFence().catch(() => {});
        releaseDispatchFence = undefined;
      }
      result.completedAt = new Date().toISOString();
      try {
        await persist();
      } finally {
        if (retain && session && policy) {
          const input = ExecutionInputSchema.parse(raw);
          const fingerprint = createHash('sha256')
            .update(
              JSON.stringify({
                ...input,
                previousResult: undefined,
                dispatchIdentity: undefined,
              }),
            )
            .digest('hex');
          const savedSession = session;
          const ttl = this.options.pauseTtlMs ?? 5 * 60_000;
          const timer = setTimeout(() => {
            this.retained.delete(raw.executionId);
            void savedSession.close().catch(() => {});
          }, ttl);
          timer.unref();
          this.retained.set(raw.executionId, {
            session,
            policy,
            fingerprint,
            expires: Date.now() + ttl,
            timer,
            result: structuredClone(result),
          });
        } else {
          try {
            await session?.close();
          } catch {
            /* preserve outcome */
          }
        }
      }
    }
    return ExecutionResultSchema.parse(result);
  }
  private sameIdentity(expected: ApplicationField, current: ApplicationField) {
    return (
      expected.type === current.type &&
      (expected.domId
        ? expected.domId === current.domId
        : expected.name
          ? expected.name === current.name
          : Boolean(expected.label && expected.label === current.label))
    );
  }
  private async locate(
    page: Page,
    expected: ApplicationField,
    allowHidden = false,
    bound?: ElementHandle<HTMLElement | SVGElement>,
  ): Promise<Locator> {
    const locator = expected.domId
      ? byId(page, expected.domId)
      : expected.name
        ? page.locator(`[name=${cssString(expected.name)}]`)
        : expected.label
          ? page.getByLabel(expected.label, { exact: true })
          : expected.selector && /^#[a-zA-Z][\w-]*$/.test(expected.selector)
            ? page.locator(expected.selector)
            : undefined;
    if (!locator || (await locator.count()) !== 1)
      throw new ExecutionGate(
        locator && (await locator.count()) > 1
          ? 'AMBIGUOUS_FIELD'
          : 'MISSING_FIELD',
        expected.id,
        true,
      );
    const subject = bound ?? locator;
    const snapshot = (element: HTMLElement | SVGElement) => {
      const control = element as HTMLInputElement;
      const label = (
        control.labels?.[0]?.textContent ||
        element.getAttribute('aria-label') ||
        element.getAttribute('placeholder') ||
        element.getAttribute('name') ||
        ''
      )
        .trim()
        .replace(/\s+/g, ' ');
      const form = control.form;
      return {
        connected: element.isConnected,
        tag: element.tagName.toLowerCase(),
        type: control.type,
        id: element.id,
        name: control.name,
        label,
        placeholder: element.getAttribute('placeholder') ?? undefined,
        ariaLabel: element.getAttribute('aria-label') ?? undefined,
        required:
          control.required || element.getAttribute('aria-required') === 'true',
        disabled: control.disabled,
        readonly: control.readOnly,
        optionValue: control.type === 'radio' ? control.value : undefined,
        options:
          element instanceof HTMLSelectElement
            ? Array.from(element.options).map(
                (o) => o.textContent?.trim() ?? '',
              )
            : [],
        selectOptions:
          element instanceof HTMLSelectElement
            ? Array.from(element.options).map((o) => ({
                label: o.textContent?.trim() ?? '',
                value: o.value,
                disabled:
                  o.disabled ||
                  (o.parentElement instanceof HTMLOptGroupElement &&
                    o.parentElement.disabled),
              }))
            : undefined,
        ariaDescribedBy: element.getAttribute('aria-describedby') ?? undefined,
        formId: form
          ? `form-${Array.from(document.forms).indexOf(form) + 1}`
          : undefined,
      };
    };
    const actual = bound
      ? await bound.evaluate(snapshot)
      : await locator.evaluate(snapshot);
    const types: Record<string, string> = {
      text: 'TEXT',
      search: 'TEXT',
      email: 'EMAIL',
      tel: 'PHONE',
      url: 'URL',
      number: 'NUMBER',
      date: 'DATE',
      textarea: 'TEXTAREA',
      'select-one': 'SELECT',
      radio: 'RADIO',
      checkbox: 'CHECKBOX',
      file: 'FILE',
    };
    if (
      !actual.connected ||
      !['input', 'select', 'textarea'].includes(actual.tag) ||
      types[actual.type] !== expected.type ||
      (expected.htmlType && actual.type !== expected.htmlType) ||
      (expected.domId && actual.id !== expected.domId) ||
      (expected.name && actual.name !== expected.name) ||
      actual.label !== expected.label ||
      actual.required !== expected.required ||
      actual.placeholder !== expected.placeholder ||
      actual.ariaLabel !== expected.ariaLabel ||
      actual.ariaDescribedBy !== expected.ariaDescribedBy ||
      actual.formId !== expected.formId ||
      actual.optionValue !== expected.optionValue ||
      JSON.stringify(actual.options) !== JSON.stringify(expected.options) ||
      (expected.type === 'SELECT' &&
        (!expected.selectOptions ||
          JSON.stringify(actual.selectOptions) !==
            JSON.stringify(expected.selectOptions))) ||
      actual.disabled ||
      actual.readonly ||
      (!allowHidden && !(await subject.isVisible()))
    )
      throw new ExecutionGate('STALE_DOM_FIELD', expected.id);
    return locator;
  }
  private async validateValue(
    locator: Locator,
    field: ApplicationField,
    value: string,
  ) {
    if (
      (field.minLength && value.length < field.minLength) ||
      (field.maxLength && value.length > field.maxLength)
    )
      throw new ExecutionGate('INVALID_VALUE', field.id);
    if (field.type === 'UNKNOWN')
      throw new ExecutionGate('UNSUPPORTED_FIELD_TYPE', field.id, true);
    if (field.type === 'CHECKBOX' && !['true', 'false'].includes(value))
      throw new ExecutionGate('INVALID_BOOLEAN', field.id, true);
    if (
      field.type === 'RADIO' &&
      (!field.optionValue || value !== field.optionValue)
    )
      throw new ExecutionGate('INVALID_OPTION', field.id, true);
    if (
      (field.type === 'EMAIL' && !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(value)) ||
      (field.type === 'NUMBER' &&
        (!value.trim() || !Number.isFinite(Number(value)))) ||
      (field.type === 'DATE' &&
        (!/^\d{4}-\d{2}-\d{2}$/.test(value) ||
          !Number.isFinite(Date.parse(value)) ||
          new Date(value).toISOString().slice(0, 10) !== value))
    )
      throw new ExecutionGate('INVALID_VALUE', field.id);
    if (field.type === 'URL') {
      try {
        if (!['http:', 'https:'].includes(new URL(value).protocol))
          throw new Error();
      } catch {
        throw new ExecutionGate('INVALID_VALUE', field.id);
      }
    }
    if (field.type === 'SELECT') {
      const options = await locator.locator('option').evaluateAll((elements) =>
        elements.map((e) => ({
          value: (e as HTMLOptionElement).value,
          label: e.textContent?.trim(),
          disabled:
            (e as HTMLOptionElement).disabled ||
            (e.parentElement instanceof HTMLOptGroupElement &&
              e.parentElement.disabled),
        })),
      );
      if (
        field.options.length &&
        !field.options.includes(value) &&
        !options.some(
          (o) => o.value === value && field.options.includes(o.label ?? ''),
        )
      )
        throw new ExecutionGate('INVALID_OPTION', field.id, true);
      if (
        options.filter(
          (o) => !o.disabled && (o.value === value || o.label === value),
        ).length !== 1
      )
        throw new ExecutionGate('INVALID_OPTION', field.id, true);
    }
  }
  private async locateControl(page: Page, expected: ExecutionControl) {
    const locator = byId(page, expected.domId);
    if (
      (await locator.count()) !== 1 ||
      !(await locator.isVisible()) ||
      !(await locator.isEnabled())
    )
      throw new ExecutionGate(
        'SUBMISSION_CONTROL_MISSING',
        expected.domId,
        true,
      );
    const current = await locator.evaluate((element) => {
      const control = element as HTMLButtonElement;
      const form = control.form;
      return {
        tag: element.tagName.toLowerCase(),
        type: control.type,
        label: (
          element.textContent ||
          element.getAttribute('value') ||
          element.getAttribute('aria-label') ||
          ''
        )
          .trim()
          .replace(/\s+/g, ' '),
        formId: form
          ? `form-${Array.from(document.forms).indexOf(form) + 1}`
          : undefined,
        actionUrl: form
          ? new URL(form.getAttribute('action') || location.href, location.href)
              .href
          : undefined,
        method: form?.method.toUpperCase(),
        overrides: ['formaction', 'formmethod', 'formtarget'].some((a) =>
          element.hasAttribute(a),
        ),
        target: form?.target,
      };
    });
    if (
      !['button', 'input'].includes(current.tag) ||
      current.type !== expected.htmlType ||
      current.label !== expected.label ||
      current.formId !== expected.formId ||
      current.actionUrl !== expected.actionUrl ||
      current.method !== expected.method ||
      current.overrides ||
      (current.target && current.target !== '_self')
    )
      throw new ExecutionGate('SUBMISSION_CONTROL_CHANGED', expected.domId);
    return locator;
  }
}
