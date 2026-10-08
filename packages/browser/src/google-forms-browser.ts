import { createHash, randomUUID } from 'node:crypto';
import {
  chromium,
  type Browser,
  type BrowserContext,
  type Page,
  type ElementHandle,
  type Frame,
} from 'playwright';
import {
  GoogleFormQuestionSchema,
  googleFormIdentity,
  type GoogleFormAnswer,
  type GoogleFormQuestion,
  type UserDocument,
} from '@careerlift/domain';
import {
  DestinationPolicy,
  InspectionError,
  type BrowserNetworkPolicy,
  type MutationResponse,
} from './policy.js';
import { forwardMutationOnce } from './mutation-transport.js';
import {
  validatePayload,
  type MutationContract,
  type RequestField,
} from './mutation-contract.js';
import { LocalDocumentStorage } from './document-storage.js';
import type { GoogleStorageState } from './google-session.js';

const hash = (value: string | Uint8Array) =>
  createHash('sha256').update(value).digest('hex');

// Google stamps this protocol field at click time. Every answer and file
// binding still has to match the prepared contract exactly.
export async function validateGoogleFormsPayload(
  contract: MutationContract,
  body: Buffer,
  contentType: string,
  window: { from: number; to: number },
) {
  const stamps = contract.fields.filter(
    (field) =>
      field.name === 'submissionTimestamp' && field.kind !== 'DOCUMENT',
  );
  if (
    stamps.length !== 1 ||
    body.length > 50 * 1024 * 1024 ||
    !/^(multipart\/form-data|application\/x-www-form-urlencoded)(?:;|$)/i.test(
      contentType,
    )
  )
    return validatePayload(contract, body, contentType);
  let data: FormData;
  try {
    data = await new Request('https://payload.invalid', {
      method: 'POST',
      headers: { 'content-type': contentType },
      body: new Uint8Array(body),
    }).formData();
  } catch {
    return validatePayload(contract, body, contentType);
  }
  const actual = data.getAll('submissionTimestamp');
  const stamp = actual[0];
  if (
    actual.length !== 1 ||
    typeof stamp !== 'string' ||
    !/^\d{13}$/.test(stamp) ||
    Number(stamp) < window.from ||
    Number(stamp) > window.to
  )
    return validatePayload(contract, body, contentType);
  return validatePayload(
    {
      ...contract,
      fields: contract.fields.map((field) =>
        field.name === 'submissionTimestamp' && field.kind !== 'DOCUMENT'
          ? { ...field, value: stamp }
          : field,
      ),
    },
    body,
    contentType,
  );
}
type Control = ElementHandle<HTMLElement>;
type Reference = { container: Control; control: Control; row?: string };
export type GooglePageInspection = {
  title: string;
  url: string;
  questions: GoogleFormQuestion[];
  fingerprint: string;
  next: boolean;
  submit: boolean;
  account: string | null;
  challenge: boolean;
  authentication: boolean;
};
export type GoogleDispatchObserver = {
  authorize(): Promise<void>;
  transport(
    outcome: 'REJECTED' | 'FORWARDED' | 'UNKNOWN',
    response?: MutationResponse,
  ): Promise<void>;
};

const readHosts = new Set([
  'docs.google.com',
  'forms.gle',
  'accounts.google.com',
  'www.gstatic.com',
  'ssl.gstatic.com',
  'fonts.gstatic.com',
  'fonts.googleapis.com',
  'apis.google.com',
  'drive.google.com',
  'content.googleapis.com',
  'www.google.com',
]);

// Suppress optional telemetry, font metadata, and draft persistence locally.
// Workflow checkpoints own recovery; these requests never receive write authority.
export function googleFormsBackgroundRequest(
  value: string,
  method: string,
  canonical: string,
) {
  if (method !== 'POST') return false;
  const url = new URL(value);
  if (url.protocol !== 'https:') return false;
  if (url.hostname === 'play.google.com' && url.pathname === '/log')
    return true;
  if (
    url.hostname === 'docs.google.com' &&
    ['/picker/logImpressions', '/picker/stat'].includes(url.pathname)
  )
    return true;
  if (
    url.hostname === 'csp.withgoogle.com' &&
    /^\/csp\/proto\/[a-f0-9]+$/.test(url.pathname)
  )
    return true;
  // Drive listings and realtime subscriptions are optional on the Upload tab.
  // Refuse these writes locally; they must never obtain upload authority.
  if (
    (url.hostname === 'clients6.google.com' &&
      url.pathname === '/batch/drive/v2internal') ||
    (url.hostname === 'signaler-pa.clients6.google.com' &&
      url.pathname === '/punctual/v1/chooseServer')
  )
    return true;
  const match =
    url.hostname === 'docs.google.com'
      ? url.pathname.match(
          /^\/forms\/(?:u\/\d+\/)?d\/(?:e\/)?([\w-]+)\/(?:naLogImpressions|font\/getmetadata|autosave|draftresponse)$/,
        )
      : null;
  return Boolean(match && match[1] === googleFormIdentity(canonical)?.id);
}

export function googleFormsPickerReadEndpoint(
  hostname: string,
  pathname: string,
) {
  if (hostname === 'clients6.google.com')
    return [
      '/empty.js',
      '/drive/v2internal/apps',
      '/drive/v2internal/changes/startPageToken',
    ].includes(pathname);
  return (
    hostname === 'drivefrontend-pa.clients6.google.com' &&
    ['/empty.js', '/v1/account'].includes(pathname)
  );
}

export function googleFormsUploadEndpoint(hostname: string, pathname: string) {
  if (hostname === 'clients6.google.com')
    return pathname === '/upload/drive/v2internal/files';
  if (
    !['docs.google.com', 'drive.google.com', 'content.googleapis.com'].includes(
      hostname,
    )
  )
    return false;
  return (
    /^(\/upload\/|\/_\/upload\/|\/_\/(?:Google)?FormsUi\/data\/batchexecute)/.test(
      pathname,
    ) ||
    (hostname === 'docs.google.com' &&
      /^\/forms\/(?:u\/\d+\/)?fileupload$/.test(pathname))
  );
}

class GoogleFormsPolicy implements BrowserNetworkPolicy {
  readonly forwardMutationsWithoutRetries = true;
  private readonly base: DestinationPolicy;
  canonical: string;
  interactive = false;
  uploading = false;
  denied: string | null = null;
  deniedRequest: {
    code: string;
    method: string;
    origin: string;
    pathname: string;
  } | null = null;
  grant: {
    contract: MutationContract;
    observer: GoogleDispatchObserver;
    expires: number;
  } | null = null;
  response: MutationResponse | null = null;
  constructor(
    url: string,
    readonly fixtureOrigin?: string,
  ) {
    this.canonical = url;
    this.base = new DestinationPolicy(fixtureOrigin);
  }
  private allowed(value: string) {
    this.base.validateNavigation(value);
    const url = new URL(value);
    if (this.fixtureOrigin) {
      if (url.origin !== this.fixtureOrigin)
        throw new InspectionError(
          'GOOGLE_FORMS_UNEXPECTED_HOST',
          'Fixture traffic must stay on the controlled local server',
        );
      return;
    }
    if (
      !readHosts.has(url.hostname) &&
      !googleFormsPickerReadEndpoint(url.hostname, url.pathname) &&
      !(
        this.uploading && googleFormsUploadEndpoint(url.hostname, url.pathname)
      ) &&
      !/^lh\d+\.googleusercontent\.com$/.test(url.hostname)
    )
      throw new InspectionError(
        'GOOGLE_FORMS_UNEXPECTED_HOST',
        'An unapproved host was requested',
      );
  }
  validateNavigation(value: string) {
    this.allowed(value);
    const url = new URL(value);
    if (this.fixtureOrigin && url.origin === this.fixtureOrigin) return;
    if (
      this.interactive &&
      (url.hostname === 'accounts.google.com' ||
        (url.hostname === 'www.google.com' &&
          /^\/recaptcha\/(api2|enterprise)\//.test(url.pathname)))
    )
      return;
    const identity = googleFormIdentity(value);
    const original = googleFormIdentity(this.canonical);
    if (!identity || (!original?.short && original?.id !== identity.id))
      throw new InspectionError(
        'GOOGLE_FORMS_UNEXPECTED_NAVIGATION',
        'The form destination changed',
      );
    if (original?.short && !identity.short) this.canonical = identity.url;
  }
  validateRequest(value: string, method: string) {
    this.allowed(value);
    if (['GET', 'HEAD'].includes(method)) return;
    const url = new URL(value);
    if (
      this.interactive &&
      (url.hostname === 'accounts.google.com' ||
        (url.hostname === 'www.google.com' &&
          /^\/recaptcha\/(api2|enterprise)\//.test(url.pathname)))
    )
      return;
    if (
      this.grant &&
      method === 'POST' &&
      url.href === this.grant.contract.destination
    )
      return;
    if (
      this.uploading &&
      ['POST', 'PUT'].includes(method) &&
      (googleFormsUploadEndpoint(url.hostname, url.pathname) ||
        (this.fixtureOrigin === url.origin &&
          url.pathname === '/upload/fixture'))
    )
      return;
    // Google Forms draft autosave is deliberately refused outside an explicitly approved upload.
    throw new InspectionError(
      'GOOGLE_FORMS_UNAPPROVED_MUTATION',
      'The form attempted an unapproved write',
    );
  }
  async validateAddress(value: string) {
    this.allowed(value);
    await this.base.validateAddress(value);
  }
  validateConnectedAddress(value: string, address: string) {
    this.allowed(value);
    this.base.validateConnectedAddress(value, address);
  }
  async authorizeMutation(
    value: string,
    method: string,
    body: Buffer,
    contentType: string,
  ) {
    const grant = this.grant;
    if (
      !grant ||
      grant.expires < Date.now() ||
      value !== grant.contract.destination ||
      method !== 'POST'
    )
      throw new InspectionError(
        'GOOGLE_FORMS_SUBMISSION_NOT_AUTHORIZED',
        'No current submission authority',
      );
    // Consume before any asynchronous operation; browser retries cannot obtain a second grant.
    this.grant = null;
    await validateGoogleFormsPayload(grant.contract, body, contentType, {
      from: grant.expires - 16000,
      to: grant.expires,
    });
    return {
      beforeDispatch: async () => {
        if (grant.expires < Date.now())
          throw new Error('GOOGLE_FORMS_AUTHORITY_EXPIRED');
        await grant.observer.authorize();
      },
      complete: async (
        outcome: 'REJECTED' | 'FORWARDED' | 'UNKNOWN',
        response?: MutationResponse,
      ) => {
        if (response) this.response = response;
        await grant.observer.transport(outcome, response);
      },
    };
  }
}

export class GoogleFormsBrowser {
  private readonly references = new Map<string, Reference>();
  private current: GooglePageInspection | null = null;
  private readonly uploaded = new Map<
    string,
    { document: UserDocument; digest: string }
  >();
  private readonly expectedEntries = new Map<string, string[]>();
  private preparedSubmission: MutationContract | null = null;
  private pendingUploadQuestion: string | null = null;
  private readonly policy: GoogleFormsPolicy;
  private browser!: Browser;
  context!: BrowserContext;
  page!: Page;
  private closed = false;
  private constructor(
    url: string,
    private readonly storage: Pick<LocalDocumentStorage, 'resolve'>,
    fixtureOrigin?: string,
  ) {
    this.policy = new GoogleFormsPolicy(url, fixtureOrigin);
  }
  static async open(options: {
    url: string;
    storage: Pick<LocalDocumentStorage, 'resolve'>;
    state?: GoogleStorageState;
    fixtureOrigin?: string;
    headless?: boolean;
  }) {
    if (
      (process.env.VITEST || process.env.NODE_ENV === 'test') &&
      !options.fixtureOrigin
    )
      throw new Error('GOOGLE_FORMS_TEST_FIXTURE_REQUIRED');
    const instance = new GoogleFormsBrowser(
      options.url,
      options.storage,
      options.fixtureOrigin,
    );
    await instance.policy.validateAddress(options.url);
    instance.browser = await chromium.launch({
      headless: options.headless ?? false,
    });
    try {
      instance.context = await instance.browser.newContext({
        ...(options.state ? { storageState: options.state } : {}),
        ignoreHTTPSErrors: Boolean(options.fixtureOrigin),
        serviceWorkers: 'block',
        acceptDownloads: false,
        locale: 'en-US',
      });
      instance.context.setDefaultTimeout(10000);
      await instance.context.routeWebSocket('**/*', (socket) => socket.close());
      await instance.context.route('**/*', async (route) => {
        const request = route.request();
        if (
          !options.fixtureOrigin &&
          googleFormsBackgroundRequest(
            request.url(),
            request.method(),
            instance.policy.canonical,
          )
        ) {
          await route.abort().catch(() => {});
          return;
        }
        try {
          instance.policy.validateRequest(request.url(), request.method());
          if (
            request.isNavigationRequest() &&
            request.frame() === instance.page?.mainFrame()
          )
            instance.policy.validateNavigation(request.url());
          await instance.policy.validateAddress(request.url());
          if (
            !['GET', 'HEAD'].includes(request.method()) &&
            !instance.policy.interactive &&
            !instance.policy.uploading
          )
            await forwardMutationOnce(
              route,
              instance.policy,
              Boolean(options.fixtureOrigin),
            );
          else await route.continue();
        } catch (error) {
          instance.policy.denied =
            error instanceof InspectionError
              ? error.code
              : 'GOOGLE_FORMS_NETWORK_BLOCKED';
          const destination = new URL(request.url());
          instance.policy.deniedRequest = {
            code: instance.policy.denied,
            method: request.method(),
            origin: destination.origin,
            pathname: destination.pathname,
          };
          await route.abort().catch(() => {});
        }
      });
      instance.context.on('page', (popup) => {
        if (instance.page && popup !== instance.page) void popup.close();
      });
      instance.page = await instance.context.newPage();
      instance.page.on('download', (download) => {
        void download.cancel();
      });
      instance.policy.interactive = true; // A login redirect may be shown; the agent never enters credentials.
      await instance.page.goto(options.url, {
        waitUntil: 'domcontentloaded',
        timeout: 30000,
      });
      instance.policy.interactive = false;
      return instance;
    } catch (error) {
      await instance.close();
      throw error;
    }
  }
  async close() {
    if (this.closed) return;
    this.closed = true;
    await this.browser?.close().catch(() => {});
  }
  alive() {
    return !this.closed && this.browser.isConnected() && !this.page.isClosed();
  }
  async allowHumanInteraction() {
    this.policy.interactive = true;
    await this.page.bringToFront();
  }
  async finishHumanInteraction() {
    this.policy.interactive = false;
    this.policy.denied = null;
    this.policy.deniedRequest = null;
  }
  networkFailure() {
    return this.policy.deniedRequest;
  }
  async inspect(): Promise<GooglePageInspection> {
    if (!this.alive()) throw new Error('GOOGLE_FORMS_SESSION_LOST');
    this.references.clear();
    const url = this.page.url();
    const authentication =
      new URL(url).hostname === 'accounts.google.com' ||
      (await this.page.locator('input[type="password"]').count()) > 0;
    const challenge =
      (await this.page
        .locator(
          'iframe[src*="recaptcha"][src*="bframe"]:visible,iframe[src*="hcaptcha"]:visible,#captcha:visible',
        )
        .count()) > 0;
    if (!authentication) this.policy.validateNavigation(url);
    const accountControl = this.page.locator(
      'a[aria-label*="Google Account"],button[aria-label*="Google Account"],a[href*="SignOutOptions"]',
    );
    const account = (await accountControl.count())
      ? await accountControl.first().getAttribute('aria-label')
      : null;
    const bodyText = (await this.page.locator('body').innerText()).slice(
      0,
      50000,
    );
    const accountAddress =
      account?.match(/[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}/i)?.[0] ??
      bodyText.match(
        /([A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,})\s+(?:Switch account|switch accounts)/i,
      )?.[1] ??
      null;
    const questions: GoogleFormQuestion[] = [];
    if (!authentication && !challenge) {
      // Google's response-email control sits above the normal question cards.
      // It must be prepared and checked just like the other required answers.
      for (const control of (await this.page
        .locator('form input[type="email"]:visible')
        .elementHandles()) as Control[]) {
        if (
          await control.evaluate((element) =>
            Boolean(element.closest('.Qr7Oae,[data-google-question]')),
          )
        )
          continue;
        const question = GoogleFormQuestionSchema.parse({
          id: 'emailAddress',
          label: 'Response email address',
          kind: 'TEXT',
          required: true,
        });
        questions.push(question);
        this.references.set(question.id, { container: control, control });
      }
      const containers = (await this.page
        .locator('.Qr7Oae,[data-google-question]')
        .elementHandles()) as Control[];
      for (const container of containers.slice(0, 300)) {
        if (!(await container.isVisible())) continue;
        const raw = await container.evaluate((element) => {
          const text = (value: string | null | undefined) =>
            (value ?? '').trim().replace(/\s+/g, ' ').slice(0, 2000);
          const heading = element.querySelector(
            '[role="heading"],legend,[data-question-label]',
          );
          const label = text(heading?.textContent).replace(/\s*\*\s*$/, '');
          const required =
            /\*\s*$/.test(text(heading?.textContent)) ||
            element.querySelector('[required],[aria-required="true"]') !== null;
          let params: unknown[] = [];
          try {
            const encoded =
              element.getAttribute('data-params') ??
              element
                .querySelector('[data-params]')
                ?.getAttribute('data-params') ??
              '';
            const decoded = JSON.parse(
              encoded.startsWith('%.@.') ? `[${encoded.slice(4)}` : encoded,
            );
            params = Array.isArray(decoded[0]) ? decoded[0] : decoded;
          } catch {
            /* Accessible/native fields remain independently inspectable. */
          }
          const entries = Array.isArray(params[4])
            ? (params[4] as unknown[][])
            : [];
          const type = typeof params[3] === 'number' ? params[3] : null;
          const controls = Array.from(
            element.querySelectorAll<HTMLElement>(
              'input:not([type="hidden"]),textarea,select,[role="radiogroup"],[role="listbox"],[role="checkbox"]',
            ),
          );
          const radios = Array.from(
            element.querySelectorAll<HTMLElement>(
              '[role="radio"],input[type="radio"]',
            ),
          );
          const boxes = Array.from(
            element.querySelectorAll<HTMLElement>(
              '[role="checkbox"],input[type="checkbox"]',
            ),
          );
          const file =
            element.querySelector<HTMLInputElement>('input[type="file"]');
          const upload = Array.from(
            element.querySelectorAll('[role="button"],button'),
          ).some((button) =>
            /add file|upload file/i.test(text(button.textContent)),
          );
          const option = (control: HTMLElement) =>
            text(
              control.getAttribute('data-value') ||
                control.getAttribute('aria-label') ||
                (control instanceof HTMLInputElement
                  ? control.labels?.[0]?.textContent || control.value
                  : control.textContent),
            );
          const first = controls[0];
          const kind =
            file || upload || type === 13
              ? 'FILE'
              : type === 7
                ? 'UNSUPPORTED'
                : type === 9
                  ? 'DATE'
                  : type === 10
                    ? 'TIME'
                    : radios.length
                      ? 'RADIO'
                      : boxes.length
                        ? 'CHECKBOX'
                        : first instanceof HTMLSelectElement ||
                            first?.getAttribute('role') === 'listbox'
                          ? 'SELECT'
                          : first instanceof HTMLTextAreaElement
                            ? 'PARAGRAPH'
                            : first instanceof HTMLInputElement
                              ? ((
                                  {
                                    date: 'DATE',
                                    time: 'TIME',
                                    'datetime-local': 'DATETIME',
                                    number: 'NUMBER',
                                  } as Record<string, string>
                                )[first.type] ?? 'TEXT')
                              : 'UNSUPPORTED';
          const options =
            kind === 'RADIO'
              ? radios.map(option)
              : kind === 'CHECKBOX'
                ? boxes.map(option)
                : first instanceof HTMLSelectElement
                  ? Array.from(first.options)
                      .filter((o) => !o.disabled && o.value !== '')
                      .map((o) => text(o.label))
                  : Array.from(
                      element.querySelectorAll<HTMLElement>('[role="option"]'),
                    )
                      .filter(
                        (control) =>
                          control.getAttribute('data-value') !== '' &&
                          control.getAttribute('aria-disabled') !== 'true',
                      )
                      .map(option);
          const name = element.querySelector<HTMLInputElement>(
            'input[name^="entry."],textarea[name^="entry."],select[name^="entry."],input[name="emailAddress"]',
          )?.name;
          const entry =
            typeof entries[0]?.[0] === 'number'
              ? `entry.${entries[0][0]}`
              : undefined;
          return {
            label,
            required,
            kind,
            options: [...new Set(options)],
            name: entry || name?.replace(/_sentinel$/, ''),
            itemId: params[0],
            accept:
              file?.accept
                .split(',')
                .map((v) => v.trim())
                .filter(Boolean) ?? [],
            minLength:
              first instanceof HTMLInputElement ||
              first instanceof HTMLTextAreaElement
                ? first.minLength
                : -1,
            maxLength:
              first instanceof HTMLInputElement ||
              first instanceof HTMLTextAreaElement
                ? first.maxLength
                : -1,
            rows:
              type === 7
                ? entries.map((row) => ({
                    entry: typeof row[0] === 'number' ? `entry.${row[0]}` : '',
                    label: typeof row[3] === 'string' ? row[3] : '',
                  }))
                : [],
          };
        });
        if (!raw.label) continue;
        const baseId =
          raw.name ||
          (typeof raw.itemId === 'number'
            ? `item.${raw.itemId}`
            : `question.${hash(raw.label).slice(0, 24)}`);
        const documentType = /resume|\bcv\b/i.test(raw.label)
          ? 'RESUME'
          : /cover.?letter/i.test(raw.label)
            ? 'COVER_LETTER'
            : /transcript/i.test(raw.label)
              ? 'TRANSCRIPT'
              : /certificate/i.test(raw.label)
                ? 'CERTIFICATE'
                : /portfolio/i.test(raw.label)
                  ? 'PORTFOLIO'
                  : 'OTHER';
        const definition = GoogleFormQuestionSchema.parse({
          id: baseId,
          label: raw.label,
          kind: raw.kind,
          required: raw.required,
          options: raw.options,
          accept: raw.accept,
          ...(raw.kind === 'FILE' ? { documentType } : {}),
          ...(raw.minLength > 0 ? { minLength: raw.minLength } : {}),
          ...(raw.maxLength > 0 ? { maxLength: raw.maxLength } : {}),
        });
        if (raw.rows.length) {
          const rowHandles = (await container.$$(
            '[role="radiogroup"],[role="group"][aria-label],tr',
          )) as Control[];
          for (const row of raw.rows) {
            const rowHandle = await this.findRow(rowHandles, row.label);
            if (!row.entry || !row.label || !rowHandle) {
              definition.kind = 'UNSUPPORTED';
              continue;
            }
            const boxes = await rowHandle.$$(
              '[role="checkbox"],input[type="checkbox"]',
            );
            const options = await rowHandle.$$eval(
              '[role="radio"],[role="checkbox"],input[type="radio"],input[type="checkbox"]',
              (nodes) =>
                nodes
                  .map(
                    (n) =>
                      n.getAttribute('data-value') ||
                      n.getAttribute('aria-label') ||
                      (n as HTMLInputElement).value ||
                      '',
                  )
                  .filter(Boolean),
            );
            const question = GoogleFormQuestionSchema.parse({
              ...definition,
              id: row.entry,
              groupId: baseId,
              row: row.label,
              label: `${raw.label} — ${row.label}`,
              kind: boxes.length ? 'CHECKBOX' : 'RADIO',
              options,
            });
            questions.push(question);
            this.references.set(question.id, { container, control: rowHandle });
          }
          if (questions.some((q) => q.groupId === baseId)) continue;
        }
        const control =
          ((await container.$(
            'input:not([type="hidden"]),textarea,select,[role="listbox"],[role="radiogroup"]',
          )) as Control | null) ?? container;
        questions.push(definition);
        this.references.set(definition.id, { container, control });
      }
    }
    if (new Set(questions.map((q) => q.id)).size !== questions.length)
      throw new Error('GOOGLE_FORMS_AMBIGUOUS_QUESTIONS');
    const next = (await this.control('Next').count()) === 1;
    const submit = (await this.control('Submit').count()) === 1;
    const title =
      (
        await this.page
          .locator('.F9yp7e,[data-form-title],h1')
          .first()
          .textContent()
          .catch(() => null)
      )
        ?.trim()
        .slice(0, 1000) || (await this.page.title()).slice(0, 1000);
    const histories = await this.page
      .locator('form input[name="pageHistory"]')
      .evaluateAll((elements) =>
        elements.map((element) => (element as HTMLInputElement).value),
      );
    if (histories.length > 1)
      throw new Error('GOOGLE_FORMS_AMBIGUOUS_NAVIGATION');
    const pageHistory = histories[0] ?? null;
    this.current = {
      title,
      url,
      questions,
      fingerprint: hash(
        JSON.stringify({
          title,
          questions,
          next,
          submit,
          ...(pageHistory !== null ? { pageHistory } : {}),
        }),
      ),
      next,
      submit,
      account: accountAddress,
      challenge,
      authentication,
    };
    return this.current;
  }
  private async findRow(handles: Control[], label: string) {
    for (const handle of handles)
      if (
        await handle.evaluate(
          (node, value) =>
            node.getAttribute('aria-label') === value ||
            node.querySelector('[role="rowheader"],th')?.textContent?.trim() ===
              value,
          label,
        )
      )
        return handle;
    return null;
  }
  private control(name: 'Next' | 'Submit') {
    return this.page.getByRole('button', { name, exact: true });
  }
  async fill(answers: GoogleFormAnswer[], documents: UserDocument[]) {
    this.preparedSubmission = null;
    if (!this.current) throw new Error('GOOGLE_FORMS_INSPECTION_REQUIRED');
    const questions = [...this.current.questions];
    if (await this.pickerIsOpen()) {
      const files = questions.filter((question) => question.kind === 'FILE');
      const pending = this.pendingUploadQuestion
        ? files.find((question) => question.id === this.pendingUploadQuestion)
        : files.length === 1
          ? files[0]
          : undefined;
      if (
        !pending ||
        !answers.find((answer) => answer.id === pending.id)?.documentId
      )
        throw new Error('GOOGLE_FORMS_UPLOAD_REQUIRES_BROWSER');
      // An open modal blocks the remaining fields. Finish its owning question first.
      questions.sort(
        (left, right) =>
          Number(right.id === pending.id) - Number(left.id === pending.id),
      );
    }
    for (const question of questions) {
      const answer = answers.find((a) => a.id === question.id);
      const ref = this.references.get(question.id);
      if (!answer || !ref || answer.review)
        throw new Error('GOOGLE_FORMS_UNRESOLVED_ANSWER');
      if (!(await ref.container.evaluate((e) => e.isConnected)))
        throw new Error('GOOGLE_FORMS_FORM_CHANGED');
      if (answer.documentId) {
        const document = documents.find((d) => d.id === answer.documentId);
        if (!document) throw new Error('GOOGLE_FORMS_DOCUMENT_MISSING');
        if (this.uploaded.get(question.id)?.document.id !== document.id)
          await this.upload(question, ref.container, document);
      } else if (answer.value === null) {
        if (
          ['TEXT', 'PARAGRAPH', 'DATE', 'TIME', 'DATETIME', 'NUMBER'].includes(
            question.kind,
          )
        ) {
          const controls = await ref.container.$$(
            'input:not([type="hidden"]),textarea',
          );
          for (const control of controls) await control.fill('');
        } else if (question.kind === 'CHECKBOX') {
          const choices = await (
            question.groupId ? ref.control : ref.container
          ).$$('[role="checkbox"],input[type="checkbox"]');
          for (const choice of choices)
            if (
              await choice.evaluate((e) =>
                e instanceof HTMLInputElement
                  ? e.checked
                  : e.getAttribute('aria-checked') === 'true',
              )
            )
              await choice.click();
        } else if (
          question.kind === 'SELECT' &&
          (await ref.control.evaluate((e) => e.tagName === 'SELECT'))
        ) {
          await ref.control.selectOption('');
        } else if (question.kind === 'SELECT') {
          await this.selectCustomOption(ref.control, '');
        }
      } else {
        if (
          ['DATE', 'TIME', 'DATETIME'].includes(question.kind) &&
          (await ref.container.$$('input:not([type="hidden"])')).length > 1
        ) {
          const parts =
            question.kind === 'TIME'
              ? String(answer.value).split(':')
              : String(answer.value).split(/[-T:]/);
          const names =
            question.kind === 'TIME'
              ? ['Hour', 'Minute']
              : [
                  'Year',
                  'Month',
                  'Day',
                  ...(question.kind === 'DATETIME' ? ['Hour', 'Minute'] : []),
                ];
          for (const [index, name] of names.entries()) {
            const controls = await ref.container.$$('[aria-label],input');
            let target: Control | null = null;
            for (const control of controls)
              if (
                await control.evaluate(
                  (e, name) =>
                    e instanceof HTMLInputElement &&
                    new RegExp(`^${name}$`, 'i').test(
                      e.getAttribute('aria-label') ??
                        e.getAttribute('placeholder') ??
                        '',
                    ),
                  name,
                )
              ) {
                if (target)
                  throw new Error('GOOGLE_FORMS_AMBIGUOUS_DATE_CONTROL');
                target = control as Control;
              }
            if (!target || !parts[index])
              throw new Error('GOOGLE_FORMS_UNSUPPORTED_DATE_CONTROL');
            await target.fill(parts[index]!);
          }
        } else if (
          ['TEXT', 'PARAGRAPH', 'DATE', 'TIME', 'DATETIME', 'NUMBER'].includes(
            question.kind,
          )
        )
          await ref.control.fill(String(answer.value));
        else if (question.kind === 'SELECT') {
          if (await ref.control.evaluate((e) => e.tagName === 'SELECT'))
            await ref.control.selectOption({ label: String(answer.value) });
          else await this.selectCustomOption(ref.control, String(answer.value));
        } else if (question.kind === 'RADIO' || question.kind === 'CHECKBOX') {
          const desired = Array.isArray(answer.value)
            ? answer.value
            : [answer.value];
          const controls = (await ref.control.$$(
            '[role="radio"],[role="checkbox"],input[type="radio"],input[type="checkbox"]',
          )) as Control[];
          // A checkbox container may itself be the first checkbox; use the whole question group.
          const choices = controls.length
            ? controls
            : ((await ref.container.$$(
                '[role="radio"],[role="checkbox"],input[type="radio"],input[type="checkbox"]',
              )) as Control[]);
          for (const choice of choices) {
            const meta = await choice.evaluate((e) => ({
              label:
                e.getAttribute('data-value') ||
                e.getAttribute('aria-label') ||
                (e instanceof HTMLInputElement
                  ? e.labels?.[0]?.textContent?.trim() || e.value
                  : e.textContent?.trim()),
              checked:
                e instanceof HTMLInputElement
                  ? e.checked
                  : e.getAttribute('aria-checked') === 'true',
            }));
            const wanted = desired.includes(meta.label ?? '');
            if (
              (question.kind === 'CHECKBOX' && wanted !== meta.checked) ||
              (question.kind === 'RADIO' && wanted && !meta.checked)
            )
              await choice.click();
          }
        }
        if (
          question.id.startsWith('entry.') ||
          question.id === 'emailAddress'
        ) {
          this.expectedEntries.set(
            question.id,
            Array.isArray(answer.value) ? answer.value : [answer.value],
          );
          if (['DATE', 'TIME', 'DATETIME'].includes(question.kind)) {
            const parts = String(answer.value).split(/[-T:]/);
            const suffixes =
              question.kind === 'TIME'
                ? ['hour', 'minute']
                : [
                    'year',
                    'month',
                    'day',
                    ...(question.kind === 'DATETIME' ? ['hour', 'minute'] : []),
                  ];
            for (const [index, suffix] of suffixes.entries())
              this.expectedEntries.set(`${question.id}_${suffix}`, [
                parts[index]!,
                String(Number(parts[index])),
              ]);
          }
        }
      }
    }
    for (const question of this.current.questions) {
      if (
        question.id.startsWith('entry.') &&
        answers.find((a) => a.id === question.id)?.value === null &&
        ['TEXT', 'PARAGRAPH', 'DATE', 'TIME', 'NUMBER', 'SELECT'].includes(
          question.kind,
        )
      )
        this.expectedEntries.set(question.id, ['']);
    }
    // Commit the last edit before reading Google's blur-triggered validation.
    await this.page.locator('form').evaluate((form) => {
      if (form.contains(document.activeElement))
        (document.activeElement as HTMLElement | null)?.blur();
    });
    await this.validateFilled(answers);
  }
  private async selectCustomOption(control: Control, value: string) {
    if ((await control.getAttribute('aria-expanded')) !== 'true')
      await control.click();
    // Google clones the collapsed options into this popup when it opens.
    // Searching the page also finds the trigger and other questions' choices.
    const menu = (await control.$('[jsname="V68bde"]')) ?? control;
    await this.page
      .waitForFunction(
        ({ menu, value }) =>
          Array.from(
            menu.querySelectorAll<HTMLElement>('[role="option"]'),
          ).some((option) => {
            const label =
              option.getAttribute('data-value') ??
              option.getAttribute('aria-label') ??
              option.textContent ??
              '';
            return (
              label.trim().replace(/\s+/g, ' ') === value &&
              option.getAttribute('aria-disabled') !== 'true' &&
              option.getClientRects().length > 0 &&
              getComputedStyle(option).visibility !== 'hidden'
            );
          }),
        { menu, value },
        { timeout: 10000 },
      )
      .catch(() => {
        throw new Error('GOOGLE_FORMS_OPTION_NOT_FOUND');
      });
    const matches: Control[] = [];
    for (const option of (await menu.$$('[role="option"]')) as Control[]) {
      if (
        (await option.isVisible()) &&
        (await option.evaluate((element, value) => {
          const label =
            element.getAttribute('data-value') ??
            element.getAttribute('aria-label') ??
            element.textContent ??
            '';
          return (
            label.trim().replace(/\s+/g, ' ') === value &&
            element.getAttribute('aria-disabled') !== 'true'
          );
        }, value))
      )
        matches.push(option);
    }
    if (matches.length !== 1) throw new Error('GOOGLE_FORMS_AMBIGUOUS_OPTION');
    await matches[0]!.click();
    // The click starts Google's closing animation. Its controller commits the
    // answer afterward; editing another field or blurring can cancel that commit.
    await this.page
      .waitForFunction(
        ({ control, value }) => {
          if (control.getAttribute('aria-expanded') === 'true') return false;
          const selected =
            control.querySelector(
              '[jsname="LgbsSe"] [role="option"][aria-selected="true"]',
            ) ?? control.querySelector('[role="option"][aria-selected="true"]');
          const actual =
            selected?.getAttribute('data-value') ??
            selected?.getAttribute('aria-label') ??
            selected?.textContent ??
            control.getAttribute('data-value');
          return actual?.trim().replace(/\s+/g, ' ') === value;
        },
        { control, value },
        { timeout: 10000 },
      )
      .catch(() => {
        throw new Error('GOOGLE_FORMS_VALUE_CHANGED');
      });
  }
  private async upload(
    question: GoogleFormQuestion,
    container: Control,
    document: UserDocument,
  ) {
    if (typeof document.metadata.contentDigest !== 'string')
      throw new Error('GOOGLE_FORMS_DOCUMENT_REAPPROVAL_REQUIRED');
    const file = await this.storage.resolve(document, question.accept);
    this.pendingUploadQuestion = question.id;
    this.policy.uploading = true;
    try {
      const input = await container.$('input[type="file"]');
      if (input) await input.setInputFiles(file);
      else {
        const add = await container.$('[role="button"],button');
        if (!add) throw new Error('GOOGLE_FORMS_UPLOAD_REQUIRES_BROWSER');
        if (!(await this.pickerIsOpen())) await add.click();
        const picker = await this.selectPickerFile(file);
        if (this.policy.denied) throw new Error(this.policy.denied);
        await this.completePickerUpload(
          picker,
          container,
          question.id,
          document.name,
        );
      }
      await this.waitForUploadConfirmation(
        container,
        question.id,
        document.name,
      );
      const entryValues = await this.page
        .locator('form')
        .evaluate(
          (form, id) =>
            new FormData(form as HTMLFormElement)
              .getAll(id)
              .filter((value): value is string => typeof value === 'string'),
          question.id,
        );
      if (entryValues.length)
        this.expectedEntries.set(question.id, entryValues);
      this.uploaded.set(question.id, { document, digest: hash(file.buffer) });
      this.pendingUploadQuestion = null;
    } finally {
      this.policy.uploading = false;
    }
  }
  private async pickerIsOpen() {
    for (const frame of this.page.frames()) {
      const tabs = frame.getByRole('tab', { name: 'Upload', exact: true });
      for (let index = 0; index < (await tabs.count()); index++)
        if (await tabs.nth(index).isVisible()) return true;
    }
    return false;
  }
  private async selectPickerFile(file: {
    name: string;
    mimeType: string;
    buffer: Buffer;
  }) {
    const names = [
      'Browse',
      'Select files from your device',
      'Select files from your computer',
    ];
    const deadline = Date.now() + 15000;
    while (Date.now() < deadline) {
      if (this.policy.denied) throw new Error(this.policy.denied);
      for (const frame of this.page.frames()) {
        const tabs = frame.getByRole('tab', { name: 'Upload', exact: true });
        let pickerVisible = false;
        for (let index = 0; index < (await tabs.count()); index++) {
          const tab = tabs.nth(index);
          if (!(await tab.isVisible())) continue;
          pickerVisible = true;
          if ((await tab.getAttribute('aria-selected')) !== 'true')
            await tab.click();
          break;
        }
        // Hidden inputs belong to the picker only after its Upload tab appears.
        // Other file questions on the form must not receive this document.
        if (pickerVisible) {
          const inputs = frame.locator('input[type="file"]');
          if ((await inputs.count()) === 1) {
            await inputs.setInputFiles(file);
            return frame;
          }
        }
        for (const name of names) {
          const buttons = frame.getByRole('button', { name, exact: true });
          for (let index = 0; index < (await buttons.count()); index++) {
            const button = buttons.nth(index);
            if (!(await button.isVisible()) || !(await button.isEnabled()))
              continue;
            const [chooser] = await Promise.all([
              this.page.waitForEvent('filechooser', { timeout: 10000 }),
              button.click(),
            ]).catch(() => {
              throw new Error('GOOGLE_FORMS_UPLOAD_REQUIRES_BROWSER');
            });
            await chooser.setFiles(file);
            return frame;
          }
        }
      }
      if (this.policy.denied) throw new Error(this.policy.denied);
      await this.page.waitForTimeout(250);
    }
    throw new Error('GOOGLE_FORMS_UPLOAD_REQUIRES_BROWSER');
  }
  private async completePickerUpload(
    picker: Frame,
    container: Control,
    id: string,
    name: string,
  ) {
    const deadline = Date.now() + 30000;
    const clicked = new Set<string>();
    while (Date.now() < deadline) {
      if (this.policy.denied) throw new Error(this.policy.denied);
      if (await this.uploadConfirmed(container, id, name)) return;
      if (picker.isDetached()) return;
      for (const action of ['Upload', 'Select', 'Insert']) {
        if (clicked.has(action)) continue;
        const buttons = picker.getByRole('button', {
          name: action,
          exact: true,
        });
        if ((await buttons.count()) !== 1) continue;
        if (!(await buttons.isVisible()) || !(await buttons.isEnabled()))
          continue;
        // Each stage runs at most once; do not restart an in-progress upload.
        clicked.add(action);
        await buttons.click();
        break;
      }
      await this.page.waitForTimeout(250);
    }
    throw new Error('GOOGLE_FORMS_UPLOAD_NOT_CONFIRMED');
  }
  private uploadConfirmed(container: Control, id: string, name: string) {
    return container.evaluate(
      (element, value) =>
        element.querySelector<HTMLInputElement>(`input[name="${value.id}"]`)
          ?.files?.[0]?.name === value.name ||
        element.innerText.includes(value.name),
      { id, name },
    );
  }
  private async waitForUploadConfirmation(
    container: Control,
    id: string,
    name: string,
  ) {
    const deadline = Date.now() + 30000;
    while (Date.now() < deadline) {
      if (this.policy.denied) throw new Error(this.policy.denied);
      if (await this.uploadConfirmed(container, id, name)) return;
      await this.page.waitForTimeout(250);
    }
    throw new Error('GOOGLE_FORMS_UPLOAD_NOT_CONFIRMED');
  }
  async validateFilled(answers: GoogleFormAnswer[]) {
    if (this.policy.denied) throw new Error(this.policy.denied);
    for (const question of this.current?.questions ?? []) {
      const answer = answers.find((a) => a.id === question.id)!;
      const ref = this.references.get(question.id)!;
      if (!(await ref.container.evaluate((e) => e.isConnected)))
        throw new Error('GOOGLE_FORMS_FORM_CHANGED');
      if (answer.documentId) {
        if (!this.uploaded.has(question.id))
          throw new Error('GOOGLE_FORMS_UPLOAD_NOT_CONFIRMED');
        continue;
      }
      if (question.kind === 'RADIO' || question.kind === 'CHECKBOX') {
        const selected = await (
          question.groupId ? ref.control : ref.container
        ).$$eval(
          '[role="radio"],[role="checkbox"],input[type="radio"],input[type="checkbox"]',
          (elements) =>
            elements
              .filter((e) =>
                e instanceof HTMLInputElement
                  ? e.checked
                  : e.getAttribute('aria-checked') === 'true',
              )
              .map(
                (e) =>
                  e.getAttribute('data-value') ||
                  e.getAttribute('aria-label') ||
                  (e instanceof HTMLInputElement
                    ? e.labels?.[0]?.textContent?.trim() || e.value
                    : e.textContent?.trim()) ||
                  '',
              ),
        );
        const expected =
          answer.value === null
            ? []
            : Array.isArray(answer.value)
              ? answer.value
              : [String(answer.value)];
        if (
          JSON.stringify([...selected].sort()) !==
          JSON.stringify([...expected].sort())
        )
          throw new Error('GOOGLE_FORMS_VALUE_CHANGED');
        continue;
      }
      if (question.kind === 'FILE' && !answer.documentId) {
        if (
          await ref.container
            .$eval(
              'input[type="file"]',
              (e) => (e as HTMLInputElement).files?.length ?? 0,
            )
            .catch(() => 0)
        )
          throw new Error('GOOGLE_FORMS_UNAPPROVED_FILE');
        continue;
      }
      if (
        ['DATE', 'TIME', 'DATETIME'].includes(question.kind) &&
        (await ref.container.$$('input:not([type="hidden"])')).length > 1
      ) {
        const parts =
          answer.value === null ? [] : String(answer.value).split(/[-T:]/);
        const names =
          question.kind === 'TIME'
            ? ['Hour', 'Minute']
            : [
                'Year',
                'Month',
                'Day',
                ...(question.kind === 'DATETIME' ? ['Hour', 'Minute'] : []),
              ];
        const values = await ref.container.$$eval(
          'input:not([type="hidden"])',
          (elements) =>
            elements.map((e) => ({
              name:
                e.getAttribute('aria-label') ??
                e.getAttribute('placeholder') ??
                '',
              value: (e as HTMLInputElement).value,
            })),
        );
        for (const [index, name] of names.entries()) {
          const match = values.filter(
            (v) => v.name.toLowerCase() === name.toLowerCase(),
          );
          if (
            match.length !== 1 ||
            (answer.value === null
              ? match[0]!.value !== ''
              : !match[0]!.value ||
                Number(match[0]!.value) !== Number(parts[index]))
          )
            throw new Error('GOOGLE_FORMS_VALUE_CHANGED');
        }
        if (await ref.container.$('[aria-invalid="true"]'))
          throw new Error('GOOGLE_FORMS_VALIDATION_FAILED');
        continue;
      }
      const actual = await ref.control.evaluate((e) => {
        if (e instanceof HTMLInputElement || e instanceof HTMLTextAreaElement)
          return e.value;
        if (e instanceof HTMLSelectElement)
          return e.selectedOptions[0]?.label ?? '';
        if (e.getAttribute('role') === 'listbox') {
          const selected =
            e.querySelector(
              '[jsname="LgbsSe"] [role="option"][aria-selected="true"]',
            ) ?? e.querySelector('[role="option"][aria-selected="true"]');
          return (
            selected?.getAttribute('data-value') ??
            selected?.getAttribute('aria-label') ??
            selected?.textContent?.trim().replace(/\s+/g, ' ') ??
            e.getAttribute('data-value')
          );
        }
        return null;
      });
      if (question.kind === 'SELECT' && actual === null)
        throw new Error('GOOGLE_FORMS_UNSUPPORTED_SELECT_CONTROL');
      if (actual !== null && actual !== (answer.value ?? ''))
        throw new Error('GOOGLE_FORMS_VALUE_CHANGED');
      if (await ref.container.$('[aria-invalid="true"]'))
        throw new Error('GOOGLE_FORMS_VALIDATION_FAILED');
    }
    if (
      await this.page
        .locator(
          'form [aria-invalid="true"]:visible,input:invalid,textarea:invalid,select:invalid',
        )
        .count()
    )
      throw new Error('GOOGLE_FORMS_VALIDATION_FAILED');
  }
  async next(
    identity: {
      applicationId: string;
      runId: string;
      userId: string;
      version: number;
    },
    observer: GoogleDispatchObserver,
  ) {
    if (!this.current?.next || this.current.submit)
      throw new Error('GOOGLE_FORMS_AMBIGUOUS_NAVIGATION');
    const previous = this.current.fingerprint;
    await this.authorizeFormRequest(identity, observer, 'NEXT');
    try {
      await this.control('Next').click();
      await this.page.waitForLoadState('domcontentloaded');
      for (let attempt = 0; attempt < 40; attempt++) {
        if (this.policy.denied) throw new Error(this.policy.denied);
        const next = await this.inspect();
        if (
          next.fingerprint !== previous &&
          (next.next || next.submit || next.authentication || next.challenge)
        )
          return next;
        if (
          await this.page
            .locator(
              '[aria-invalid="true"],input:invalid,textarea:invalid,select:invalid',
            )
            .count()
        )
          throw new Error('GOOGLE_FORMS_VALIDATION_FAILED');
        await this.page.waitForTimeout(250);
      }
      throw new Error('GOOGLE_FORMS_SECTION_DID_NOT_ADVANCE');
    } finally {
      this.policy.grant = null;
    }
  }
  private async authorizeFormRequest(
    identity: {
      applicationId: string;
      runId: string;
      userId: string;
      version: number;
    },
    observer: GoogleDispatchObserver | undefined,
    actionType: 'NEXT' | 'FINAL_SUBMIT',
  ) {
    const forms = await this.page.locator('form').elementHandles();
    if (forms.length !== 1) throw new Error('GOOGLE_FORMS_AMBIGUOUS_FORM');
    const fields = await forms[0]!.evaluate((form) =>
      Array.from(new FormData(form as HTMLFormElement).entries()).map(
        ([name, value]) => ({
          name,
          value: typeof value === 'string' ? value : null,
        }),
      ),
    );
    const action = await forms[0]!.evaluate(
      (form) => (form as HTMLFormElement).action,
    );
    this.policy.validateNavigation(action);
    if (!new URL(action).pathname.endsWith('/formResponse'))
      throw new Error('GOOGLE_FORMS_SUBMIT_ENDPOINT_INVALID');
    const approved: RequestField[] = [];
    for (const field of fields.filter(
      (field) =>
        ['draftResponse', 'partialResponse'].includes(field.name) &&
        field.value,
    )) {
      // Section drafts can carry earlier answers. Hidden data must not introduce
      // answers that were never prepared or reviewed by this application run.
      let draft: unknown;
      try {
        draft = JSON.parse(field.value!);
      } catch {
        throw new Error('GOOGLE_FORMS_UNAPPROVED_DRAFT');
      }
      if (
        !Array.isArray(draft) ||
        draft.length < 3 ||
        (draft[0] !== null && !Array.isArray(draft[0])) ||
        draft[1] !== null
      )
        throw new Error('GOOGLE_FORMS_UNAPPROVED_DRAFT');
      for (const entry of draft[0] ?? []) {
        if (
          !Array.isArray(entry) ||
          entry[0] !== null ||
          !Number.isSafeInteger(entry[1]) ||
          !Array.isArray(entry[2]) ||
          !entry[2].every((value: unknown) => typeof value === 'string')
        )
          throw new Error('GOOGLE_FORMS_UNAPPROVED_DRAFT');
        const expected = this.expectedEntries.get(`entry.${entry[1]}`);
        if (
          !expected ||
          entry[2].some((value: string) => !expected.includes(value))
        )
          throw new Error('GOOGLE_FORMS_UNAPPROVED_DRAFT');
      }
    }
    for (const field of fields) {
      if (field.value === null) {
        const uploaded = this.uploaded.get(field.name);
        if (!uploaded) throw new Error('GOOGLE_FORMS_UNAPPROVED_FILE');
        approved.push({
          name: field.name,
          kind: 'DOCUMENT',
          documentId: uploaded.document.id,
          fileName: uploaded.document.name,
          mimeType: uploaded.document.mimeType,
          size: uploaded.document.size,
          sha256: uploaded.digest,
        });
      } else {
        if (
          /^entry\.\d+(?:_(?:year|month|day|hour|minute))?$/.test(field.name) ||
          field.name === 'emailAddress'
        ) {
          const values =
            this.expectedEntries.get(field.name) ??
            (field.name === 'emailAddress' && this.current?.account
              ? [this.current.account]
              : undefined);
          if (!values || !values.includes(field.value))
            throw new Error('GOOGLE_FORMS_UNAPPROVED_VALUE');
        } else if (field.name === 'hud') {
          if (!['true', 'false'].includes(field.value))
            throw new Error('GOOGLE_FORMS_UNEXPECTED_FORM_FIELD');
        } else if (field.name === 'dlut') {
          // Last draft update time is supplied by Google's hydrated form.
          if (!/^(?:-1|\d{13})$/.test(field.value))
            throw new Error('GOOGLE_FORMS_UNEXPECTED_FORM_FIELD');
        } else if (field.name === 'fuIds') {
          const files = new Set(this.uploaded.keys());
          if (
            field.value &&
            field.value
              .split(',')
              .some((id) => !/^\d+$/.test(id) || !files.has(`entry.${id}`))
          )
            throw new Error('GOOGLE_FORMS_UNAPPROVED_FILE');
        } else if (
          !/^(fvv|draftResponse|pageHistory|fbzx|submissionTimestamp|partialResponse|token|tag|entry\.\d+_sentinel)$/.test(
            field.name,
          )
        )
          throw new Error('GOOGLE_FORMS_UNEXPECTED_FORM_FIELD');
        approved.push({
          name: field.name,
          kind: 'STATIC_APPROVED_FIELD',
          value: field.value,
        });
      }
    }
    // Google section POSTs must carry this exact discriminator. Without it the
    // request cannot receive Next authority at the shared formResponse endpoint.
    if (actionType === 'NEXT')
      approved.push({
        name: 'continue',
        kind: 'STATIC_APPROVED_FIELD',
        value: '1',
      });
    const contract: MutationContract = {
      applicationId: identity.applicationId,
      executionId: identity.runId,
      userId: identity.userId,
      runId: identity.runId,
      generation: identity.version,
      actionId: randomUUID(),
      action: actionType,
      destination: action,
      method: 'POST',
      externalIdentity: {
        canonicalApplicationUrl: this.policy.canonical,
        jobFields: [],
      },
      fields: approved,
    };
    if (observer)
      this.policy.grant = { contract, observer, expires: Date.now() + 15000 };
    return contract;
  }
  async prepareSubmit(identity: {
    applicationId: string;
    runId: string;
    userId: string;
    version: number;
  }) {
    this.preparedSubmission = null;
    if (!this.current?.submit || this.current.next)
      throw new Error('GOOGLE_FORMS_SUBMIT_CONTROL_MISSING');
    const preexistingConfirmation = this.page.locator(
      this.policy.fixtureOrigin
        ? '[data-google-confirmation]'
        : '.vHW8K,.freebirdFormviewerViewResponseConfirmationMessage',
    );
    if (await preexistingConfirmation.count())
      throw new Error('GOOGLE_FORMS_PREEXISTING_CONFIRMATION');
    this.preparedSubmission = await this.authorizeFormRequest(
      identity,
      undefined,
      'FINAL_SUBMIT',
    );
    return this.preparedSubmission;
  }
  async submit(
    identity: {
      applicationId: string;
      runId: string;
      userId: string;
      version: number;
    },
    observer: GoogleDispatchObserver,
  ) {
    const contract =
      this.preparedSubmission ?? (await this.prepareSubmit(identity));
    if (
      contract.applicationId !== identity.applicationId ||
      contract.executionId !== identity.runId ||
      contract.userId !== identity.userId ||
      contract.generation !== identity.version
    )
      throw new Error('GOOGLE_FORMS_SUBMISSION_PREPARATION_CHANGED');
    this.preparedSubmission = null;
    this.policy.grant = { contract, observer, expires: Date.now() + 15000 };
    this.policy.response = null;
    await this.control('Submit').click();
    await this.page.waitForLoadState('domcontentloaded').catch(() => {});
    const confirmation = this.page.locator(
      this.policy.fixtureOrigin
        ? '[data-google-confirmation]'
        : '.vHW8K,.freebirdFormviewerViewResponseConfirmationMessage',
    );
    const confirmed = await confirmation
      .first()
      .waitFor({ state: 'visible', timeout: 15000 })
      .then(() => true)
      .catch(() => false);
    this.policy.grant = null;
    const response = this.policy.response as MutationResponse | null;
    const sameForm = this.policy.fixtureOrigin
      ? new URL(this.page.url()).origin === this.policy.fixtureOrigin
      : googleFormIdentity(this.page.url())?.id ===
        googleFormIdentity(this.policy.canonical)?.id;
    if (
      !confirmed ||
      !response ||
      response.responseStatus < 200 ||
      response.responseStatus >= 300 ||
      !sameForm ||
      (await this.control('Submit').count())
    )
      return { confirmed: false, response };
    return {
      confirmed: true,
      response,
      confirmationDigest: hash(await confirmation.first().innerText()),
    };
  }
}
