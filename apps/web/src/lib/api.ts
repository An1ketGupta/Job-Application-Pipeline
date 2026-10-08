import type {
  JobListResponse,
  NormalizedJob,
  SyncResult,
  ApplicationDetail,
  AuthUser,
} from './types.js';
import {
  ApplicationDetailsSchema,
  ApplicationsResponseSchema,
} from '@careerlift/domain';
import type { ApplicationsResponse } from './types.js';

const API_BASE_URL = process.env.NEXT_PUBLIC_API_URL || 'http://localhost:3001';
export async function downloadDocument(
  id: string,
  token: string,
): Promise<Blob> {
  let response: Response;
  try {
    response = await fetch(
      `${API_BASE_URL}/api/v1/documents/${encodeURIComponent(id)}/content`,
      {
        headers: { Authorization: `Bearer ${token}` },
        cache: 'no-store',
        signal: AbortSignal.timeout(20000),
      },
    );
  } catch {
    throw new ApiError(
      'DOWNLOAD_FAILED',
      'Unable to download this document. Try again.',
      0,
    );
  }
  if (response.status === 401 && typeof window !== 'undefined')
    window.dispatchEvent(
      new CustomEvent('careerlift-session-expired', { detail: token }),
    );
  if (!response.ok)
    throw new ApiError(
      'DOWNLOAD_FAILED',
      response.status === 401
        ? 'Log in to download this document.'
        : 'This document is unavailable. Refresh and try again.',
      response.status,
    );
  return response.blob();
}

export class ApiError extends Error {
  constructor(
    public readonly code: string,
    message: string,
    public readonly status: number,
  ) {
    super(message);
    this.name = 'ApiError';
  }
}

export async function request<T>(
  endpoint: string,
  options: RequestInit = {},
  token?: string | null,
  timeoutMs = 20000,
): Promise<T> {
  const url = `${API_BASE_URL}${endpoint}`;
  const headers = new Headers(options.headers || {});

  if (!headers.has('Accept')) {
    headers.set('Accept', 'application/json');
  }
  if (token) {
    headers.set('Authorization', `Bearer ${token}`);
  }
  if (
    options.body &&
    typeof options.body === 'string' &&
    !headers.has('Content-Type')
  ) {
    headers.set('Content-Type', 'application/json');
  }

  let response: Response;
  const timeout = AbortSignal.timeout(timeoutMs);
  try {
    response = await fetch(url, {
      ...options,
      headers,
      signal: options.signal
        ? AbortSignal.any([options.signal, timeout])
        : timeout,
    });
  } catch {
    if (options.signal?.aborted)
      throw new DOMException('Request cancelled', 'AbortError');
    if (timeout.aborted)
      throw new ApiError(
        'REQUEST_TIMEOUT',
        'The request timed out. Refresh to check the current state before trying again.',
        0,
      );
    throw new ApiError(
      'NETWORK_ERROR',
      'Unable to connect to CareerLift Agent server. Please ensure the backend is running.',
      0,
    );
  }

  const json = await response.json().catch(() => null);

  if (!response.ok) {
    if (response.status === 401 && token && typeof window !== 'undefined')
      window.dispatchEvent(
        new CustomEvent('careerlift-session-expired', { detail: token }),
      );
    const errorCode =
      typeof json?.error === 'string' ? json.error : `HTTP_${response.status}`;
    const explanations: Record<string, string> = {
      SYNC_FAILED:
        'Unable to synchronize jobs. Check the local services and try again.',
      INVALID_EMAIL: 'Enter a valid email address for your local account.',
      VALIDATION_ERROR:
        'Check your information and file format, then try again.',
      INVALID_DOCUMENT: 'Choose a valid PDF or UTF-8 TXT document up to 10 MB.',
      INVALID_EXTENSION:
        'The filename must keep its original PDF or TXT extension.',
      DOCUMENT_ARCHIVED: 'Restore this archived document before using it.',
      DOCUMENT_UNAVAILABLE:
        'This document is unavailable. Refresh or upload a new copy.',
      CONCURRENT_UPDATE:
        'This record changed or already exists. Refresh and try again.',
      STALE_REVIEW:
        'This review changed. Refresh before making another decision.',
      EXPLICIT_CONFIRMATION_REQUIRED:
        'Explicitly confirm your answer before saving.',
      REAL_EXECUTION_DISABLED: 'Real execution is disabled.',
      EXPLICIT_FLOW_REQUIRED:
        'Retry form inspection to identify the submission flow.',
      CAPTCHA:
        'The employer requires reCAPTCHA. Complete this application on the employer site.',
      ASHBY_BROWSER_VERIFICATION_REQUIRED:
        'Complete verification in the open employer browser, then continue here.',
      GREENHOUSE_BROWSER_ASSISTANCE_REQUIRED:
        'Greenhouse browser assistance is required to complete verification.',
      GREENHOUSE_BROWSER_VERIFICATION_REQUIRED:
        'Click Submit application and complete verification in the Greenhouse browser, then return here and continue.',
      GREENHOUSE_INTERNATIONAL_PHONE_REQUIRED:
        'Add the country calling code to your profile phone number, for example +91.',
      GREENHOUSE_UNSUPPORTED_FORM:
        'This Greenhouse form includes additional surveys or controls that require manual completion.',
      GREENHOUSE_FORM_CHANGED:
        'The Greenhouse form changed. Inspect and prepare it again.',
      GREENHOUSE_UNAPPROVED_VALUE:
        'The employer request differs from your prepared application. Review the saved answers before starting again.',
      ASHBY_SESSION_LOST:
        'The browser session ended. Continue to reopen it and restore prepared answers.',
      ASHBY_SURVEY_REVIEW_REQUIRED:
        'Complete the employer survey forms on the employer site.',
      ASHBY_UNSUPPORTED_FIELD:
        'This employer form requires a browser interaction. Complete it on the employer site.',
      ASHBY_FORM_CHANGED:
        'The employer form changed. Inspect and prepare it again before submission.',
      LOCAL_FIXTURE_REQUIRED:
        'Controlled execution requires an explicitly configured local test fixture.',
      EXECUTION_BLOCKED:
        'Execution is blocked by the current application or safety checks. Open Human Review.',
      QUEUE_UNAVAILABLE:
        'The workflow worker queue is unavailable. Check the local services and refresh.',
      UNSAFE_DESTINATION:
        'The application destination requires security review. Automation has stopped.',
      UNSUPPORTED_PLAN_TYPE:
        'Browser inspection is unavailable for this application method. Email applications use the email preparation controls.',
      EMAIL_NOT_CONFIGURED:
        'Configure GMAIL_CLIENT_ID, GMAIL_CLIENT_SECRET, and EMAIL_ENCRYPTION_KEY locally, then restart the API and worker.',
      EMAIL_SENDING_DISABLED:
        'Email sending is disabled. Set EMAIL_ALLOW_SEND=true locally and restart the API and worker.',
      EMAIL_RECONNECT_REQUIRED:
        'Connect or reconnect your Gmail account on the Email page.',
      EMAIL_APPLICATION_REQUIRED:
        'This application does not have a supported email destination.',
      EMAIL_REVIEW_REQUIRED:
        'This application needs review before an email can be prepared or sent.',
      EMAIL_ACCOUNT_CHANGED:
        'The connected Gmail account changed. Save a fresh email draft before sending.',
      EMAIL_DRAFT_STALE:
        'The application or selected documents changed. Refresh, review, and save a fresh draft.',
      EMAIL_DRAFT_LOCKED:
        'This email is already queued, sending, sent, or has an unknown outcome. Refresh its status before continuing.',
      EMAIL_DRAFT_REQUIRED: 'Save and review an email draft before sending.',
      EMAIL_MESSAGE_NOT_FOUND: 'The email record was not found.',
      EMAIL_RESUME_REQUIRED:
        'Select a resume and save the draft before sending this application.',
      EMAIL_ATTACHMENTS_TOO_LARGE:
        'Choose up to five attachments totaling no more than 15 MB.',
      EMAIL_DAILY_LIMIT:
        'The local limit of 20 queued or sent emails per 24 hours has been reached.',
      EMAIL_SENDING_IN_PROGRESS:
        'Wait for the current email send to finish before disconnecting Gmail.',
      EMAIL_AI_NOT_CONFIGURED:
        'Add GEMINI_API_KEY to the root .env file and restart the API.',
      EMAIL_PROFILE_REQUIRED:
        'Save your profile before generating a personalized email.',
      EMAIL_AI_RATE_LIMITED:
        'Gemini reached a rate limit. Wait before generating another draft.',
      EMAIL_AI_KEY_INVALID:
        'Check GEMINI_API_KEY and your Gemini API access, then restart the API.',
      EMAIL_AI_INVALID_OUTPUT:
        'Gemini did not return a valid email draft. Your existing draft was kept; you can retry or edit it yourself.',
      EMAIL_PERSONALIZATION_UNAVAILABLE:
        'Gemini could not personalize the draft. Check your API key, model, and connection or edit the email yourself.',
    };
    const errorMessage =
      explanations[errorCode] ||
      (response.status === 401
        ? 'Session expired or unauthenticated. Please log in.'
        : response.status === 404
          ? 'The requested resource was not found.'
          : response.status === 409
            ? 'This action is unavailable in the current state. Refresh and review the application.'
            : response.status === 400 || response.status === 413
              ? 'Check the supplied information and file size, then try again.'
              : 'CareerLift is temporarily unavailable. Check the local services and try again.');
    throw new ApiError(errorCode, errorMessage, response.status);
  }

  return json as T;
}

export async function syncJobs(token: string): Promise<SyncResult> {
  return request<SyncResult>(
    '/api/v1/jobs/sync',
    { method: 'POST' },
    token,
    120000,
  );
}

export async function fetchJobs(
  params: Record<string, string | number | undefined>,
  token: string,
  signal?: AbortSignal,
): Promise<JobListResponse> {
  const query = new URLSearchParams();
  for (const [key, val] of Object.entries(params)) {
    if (val !== undefined && val !== '' && val !== 'all' && val !== 'any') {
      query.set(key, String(val));
    }
  }
  const queryString = query.toString();
  const endpoint = `/api/v1/jobs${queryString ? `?${queryString}` : ''}`;
  return request<JobListResponse>(
    endpoint,
    { method: 'GET', cache: 'no-store', ...(signal ? { signal } : {}) },
    token,
  );
}

export async function fetchJob(
  id: string,
  token: string,
  signal?: AbortSignal,
): Promise<{ job: NormalizedJob }> {
  return request<{ job: NormalizedJob }>(
    `/api/v1/jobs/${encodeURIComponent(id)}`,
    { method: 'GET', cache: 'no-store', ...(signal ? { signal } : {}) },
    token,
  );
}

export async function startApplication(
  jobId: string,
  token: string,
): Promise<{
  application: { id: string; state: import('./types.js').ApplicationState };
  isExisting: boolean;
  message: string;
}> {
  return request<{
    application: { id: string; state: import('./types.js').ApplicationState };
    isExisting: boolean;
    message: string;
  }>(
    `/api/v1/jobs/${encodeURIComponent(jobId)}/applications`,
    { method: 'POST' },
    token,
  );
}

export async function fetchApplication(
  id: string,
  token: string,
  signal?: AbortSignal,
): Promise<{ application: ApplicationDetail }> {
  const result = await request<{ application: unknown }>(
    `/api/v1/applications/${encodeURIComponent(id)}`,
    { method: 'GET', cache: 'no-store', ...(signal ? { signal } : {}) },
    token,
  );
  const parsed = ApplicationDetailsSchema.safeParse(result?.application);
  if (!parsed.success)
    throw new ApiError(
      'INVALID_APPLICATION',
      'Application data is unavailable or inconsistent. Please refresh.',
      502,
    );
  return { application: parsed.data };
}

export async function fetchApplications(
  params: Record<string, string | number | undefined>,
  token: string,
  signal?: AbortSignal,
): Promise<ApplicationsResponse> {
  const query = new URLSearchParams();
  for (const [key, value] of Object.entries(params))
    if (value !== undefined && value !== '') query.set(key, String(value));
  const result = await request<unknown>(
    `/api/v1/applications?${query}`,
    { method: 'GET', cache: 'no-store', ...(signal ? { signal } : {}) },
    token,
  );
  const parsed = ApplicationsResponseSchema.safeParse(result);
  if (!parsed.success)
    throw new ApiError(
      'INVALID_APPLICATIONS',
      'Application data is unavailable or inconsistent. Please refresh.',
      502,
    );
  return parsed.data;
}

export async function loginUser(
  email?: string,
): Promise<{ token: string; user: AuthUser }> {
  return request<{ token: string; user: AuthUser }>('/api/v1/auth/login', {
    method: 'POST',
    body: JSON.stringify({ email }),
  });
}

export async function fetchCurrentUser(
  token: string,
): Promise<{ user: AuthUser }> {
  return request<{ user: AuthUser }>(
    '/api/v1/auth/me',
    { method: 'GET' },
    token,
  );
}
