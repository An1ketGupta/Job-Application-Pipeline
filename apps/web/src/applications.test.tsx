import React from 'react';
import { renderToString } from 'react-dom/server';
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  ApplicationDetailsView,
  ApplicationCard,
  ApplicationsEmpty,
  WorkspaceLoading,
  WorkspaceError,
  LiveStatus,
} from './components/applications/WorkspaceUI';
import { applicationHeadline } from './lib/application-presentation';
import { startWorkspacePolling } from './lib/workspace-polling';
import { fetchApplication, fetchApplications } from './lib/api';
import type { ApplicationDetail } from './lib/types';
import { ApplicationSummarySchema } from '@careerlift/domain';
import { GoogleFormSubmissionFlag } from './components/applications/GoogleFormSubmissionFlag';
const at = '2026-10-07T10:00:00.000Z';
describe('Google Forms submission flags', () => {
  it.each([
    ['SUBMITTED', false, 'Submitted'],
    ['SUBMITTED', true, 'Not submitted'],
    ['UNKNOWN', true, 'Not submitted'],
    ['SUBMITTING', true, 'Not submitted'],
    ['UNKNOWN', false, 'Unconfirmed'],
    ['SUBMITTING', false, 'Unconfirmed'],
    ['BLOCKED', false, 'Not submitted'],
    ['REVIEW', false, 'Not submitted'],
  ] as const)('shows %s with test=%s as %s', (state, test, label) => {
    const run = {
      state,
      test,
      version: 1,
      page: 0,
      title: 'Form',
      issue: null,
      updatedAt: at,
      submittedAt: null,
    };
    const html = renderToString(<GoogleFormSubmissionFlag run={run} />);
    expect(html).toContain(`>${label}</span>`);
    if (state === 'UNKNOWN' && !test)
      expect(html).toContain('duplicate submission is blocked');
    if (test) expect(html).toContain('no employer application was submitted');
  });
  it('shows an application without a run as not submitted', () => {
    expect(renderToString(<GoogleFormSubmissionFlag run={null} />)).toContain(
      '>Not submitted</span>',
    );
  });
});
const base: ApplicationDetail = {
  id: 'app-1',
  state: 'RESOLVED',
  createdAt: at,
  updatedAt: at,
  lastActivityAt: at,
  job: {
    id: 'job:1',
    title: 'Engineer <script>',
    company: 'Acme',
    location: 'Remote',
    employmentType: null,
    source: 'CAREERLIFT',
  },
  plan: null,
  inspection: null,
  preparation: null,
  execution: null,
  executions: [],
  active: false,
  humanReviewRequired: false,
  reviewReasons: [],
  timeline: [{ id: 'created', label: 'Application created', at }],
  timelineTruncated: false,
  preparationSummary: null,
};
const execution = {
  mode: 'REAL_EXECUTION' as const,
  state: 'SUBMITTED' as const,
  startedAt: at,
  completedAt: at,
  updatedAt: at,
  issue: null,
  verification: {
    state: 'PENDING' as const,
    establishedState: null,
    updatedAt: at,
    verifiedAt: null,
    evidenceCount: 0,
    attemptCount: 1,
    summary: 'Checking acceptance.',
  },
};
afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
});
describe('Application workspace presentation', () => {
  it('renders cards, metadata, job navigation, stages and the safe timeline', () => {
    const card = renderToString(<ApplicationCard application={base} />);
    expect(card).toContain('Engineer &lt;script&gt;');
    expect(card).not.toContain('<script>');
    for (const text of [
      'Acme',
      'Remote',
      'Created',
      'Last activity',
      'View Application',
      'Verification',
    ])
      expect(card).toContain(text);
    const html = renderToString(<ApplicationDetailsView application={base} />);
    for (const text of [
      'Associated job',
      'Application lifecycle',
      'Timeline',
      'Application created',
      'Submission verification',
      'Answers and documents',
      '/jobs/job%3A1',
    ])
      expect(html).toContain(text);
    expect(html).not.toContain('Retry');
    expect(html).not.toContain('Force Submit');
  });
  it('never conflates an execution submission with confirmed acceptance', () => {
    expect(applicationHeadline({ ...base, execution })).toBe(
      'Verification pending',
    );
    expect(
      applicationHeadline({ ...base, state: 'SUBMITTED', execution }),
    ).toBe('Verification pending');
    const confirmed = {
      ...execution,
      verification: { ...execution.verification, state: 'CONFIRMED' as const },
    };
    expect(
      applicationHeadline({ ...base, execution: confirmed }),
    ).not.toContain('verified');
    expect(
      applicationHeadline({
        ...base,
        state: 'SUBMITTED',
        execution: confirmed,
      }),
    ).toBe('Submitted & verified');
    expect(
      applicationHeadline({
        ...base,
        state: 'SUBMITTED',
        execution: { ...confirmed, mode: 'TEST_FIXTURE' },
      }),
    ).toBe('Test submission verified');
    const html = renderToString(
      <ApplicationDetailsView application={{ ...base, execution }} />,
    );
    expect(html).toContain('Attempt recorded');
    expect(html).not.toContain('Submitted &amp; verified');
  });
  it('shows review requirements and review navigation without a decision UI', () => {
    const app = {
      ...base,
      state: 'HUMAN_REQUIRED' as const,
      humanReviewRequired: true,
      reviewReasons: ['Prepared answers need review.'],
    };
    const html = renderToString(<ApplicationDetailsView application={app} />);
    for (const text of [
      'Action required: human review',
      'Open Review',
      'href="#review"',
      'id="review"',
      'Prepared answers need review.',
      'Review required information',
      'href="/review/app-1"',
    ])
      expect(html).toContain(text);
    expect(html).not.toContain('Continue and submit');
    expect(renderToString(<ApplicationCard application={app} />)).toContain(
      '/applications/app-1#review',
    );
  });
  it.each(['UNKNOWN', 'FAILED', 'REJECTED'] as const)(
    'distinguishes verification %s',
    (state) => {
      const app = {
        ...base,
        execution: {
          ...execution,
          verification: { ...execution.verification, state },
        },
      };
      const headline = applicationHeadline(app);
      expect(headline.toLowerCase()).toContain(
        state === 'FAILED' ? 'service failed' : state.toLowerCase(),
      );
      expect(headline).not.toContain('verified');
    },
  );
  it('renders loading, empty, search-empty, error and live-update states', () => {
    expect(renderToString(<WorkspaceLoading />)).toContain('role="status"');
    expect(
      renderToString(<ApplicationsEmpty filtered={false} reset={() => {}} />),
    ).toContain('Browse Jobs');
    expect(
      renderToString(<ApplicationsEmpty filtered reset={() => {}} />),
    ).toContain('No matching applications');
    expect(
      renderToString(
        <WorkspaceError message="Unable to connect" refresh={() => {}} />,
      ),
    ).toContain('role="alert"');
    expect(
      renderToString(<LiveStatus busy={false} stopped="limit" active />),
    ).toContain('five minutes');
  });
});
describe('Bounded completion-based polling', () => {
  it('aborts a stalled request at its timeout and allows a new refresh session', async () => {
    vi.useFakeTimers();
    const signals: AbortSignal[] = [];
    const stopped = vi.fn();
    const errors = vi.fn();
    const cancel = startWorkspacePolling({
      read: (s) => {
        signals.push(s);
        return new Promise<boolean>(() => {});
      },
      onData: vi.fn(),
      onError: errors,
      onBusy: vi.fn(),
      onStopped: stopped,
      active: () => true,
      requestTimeoutMs: 20,
      maxDurationMs: 100,
    });
    await vi.advanceTimersByTimeAsync(30);
    expect(signals[0]?.aborted).toBe(true);
    expect(stopped).toHaveBeenCalledWith('error');
    expect(errors).toHaveBeenCalledTimes(1);
    cancel();
    const read = vi.fn(async () => false);
    const restart = startWorkspacePolling({
      read,
      onData: vi.fn(),
      onError: vi.fn(),
      onBusy: vi.fn(),
      onStopped: stopped,
      active: (v) => v,
    });
    await vi.advanceTimersByTimeAsync(1);
    expect(read).toHaveBeenCalledTimes(1);
    restart();
  });
  it('observes persisted stage responses and stops on terminal or review state', async () => {
    vi.useFakeTimers();
    const states = ['PREPARING', 'EXECUTING', 'VERIFYING', 'CONFIRMED'];
    const read = vi.fn(async () => states.shift()!);
    const observed: string[] = [];
    const stopped = vi.fn();
    const cancel = startWorkspacePolling({
      read,
      onData: (v) => observed.push(v),
      onError: vi.fn(),
      onBusy: vi.fn(),
      onStopped: stopped,
      active: (v) => v !== 'CONFIRMED',
      intervalMs: 10,
    });
    await vi.advanceTimersByTimeAsync(100);
    expect(observed).toEqual([
      'PREPARING',
      'EXECUTING',
      'VERIFYING',
      'CONFIRMED',
    ]);
    expect(read).toHaveBeenCalledTimes(4);
    expect(stopped).toHaveBeenCalledWith('terminal');
    cancel();
    const reviewRead = vi.fn(async () => 'HUMAN_REQUIRED');
    const stopReview = startWorkspacePolling({
      read: reviewRead,
      onData: vi.fn(),
      onError: vi.fn(),
      onBusy: vi.fn(),
      onStopped: vi.fn(),
      active: () => false,
      intervalMs: 10,
    });
    await vi.advanceTimersByTimeAsync(100);
    expect(reviewRead).toHaveBeenCalledTimes(1);
    stopReview();
  });
  it('never overlaps reads, aborts on cleanup and ignores late responses', async () => {
    vi.useFakeTimers();
    let resolve!: (v: boolean) => void;
    let signal!: AbortSignal;
    const read = vi.fn((s: AbortSignal) => {
      signal = s;
      return new Promise<boolean>((r) => (resolve = r));
    });
    const onData = vi.fn();
    const cancel = startWorkspacePolling({
      read,
      onData,
      onError: vi.fn(),
      onBusy: vi.fn(),
      onStopped: vi.fn(),
      active: () => true,
      intervalMs: 10,
    });
    await vi.advanceTimersByTimeAsync(100);
    expect(read).toHaveBeenCalledTimes(1);
    cancel();
    expect(signal.aborted).toBe(true);
    resolve(true);
    await vi.advanceTimersByTimeAsync(100);
    expect(onData).not.toHaveBeenCalled();
  });
  it('bounds reads, pauses hidden polling, and stops on errors', async () => {
    vi.useFakeTimers();
    const read = vi.fn(async () => true);
    const stopped = vi.fn();
    const cancel = startWorkspacePolling({
      read,
      onData: vi.fn(),
      onError: vi.fn(),
      onBusy: vi.fn(),
      onStopped: stopped,
      active: () => true,
      intervalMs: 10,
      maxReads: 3,
    });
    await vi.advanceTimersByTimeAsync(100);
    expect(read).toHaveBeenCalledTimes(3);
    expect(stopped).toHaveBeenCalledWith('limit');
    cancel();
    read.mockClear();
    const hidden = startWorkspacePolling({
      read,
      onData: vi.fn(),
      onError: vi.fn(),
      onBusy: vi.fn(),
      onStopped: stopped,
      active: () => true,
      visible: () => false,
      intervalMs: 10,
      maxDurationMs: 30,
    });
    await vi.advanceTimersByTimeAsync(100);
    expect(read).toHaveBeenCalledTimes(1);
    hidden();
    const onError = vi.fn();
    const failure = startWorkspacePolling({
      read: async () => {
        throw new Error('offline');
      },
      onData: vi.fn(),
      onError,
      onBusy: vi.fn(),
      onStopped: stopped,
      active: () => true,
    });
    await vi.advanceTimersByTimeAsync(100);
    expect(onError).toHaveBeenCalledTimes(1);
    expect(stopped).toHaveBeenCalledWith('error');
    failure();
  });
});
describe('Workspace API client', () => {
  it('passes composable queries, authorization and cancellation', async () => {
    const summary = ApplicationSummarySchema.strip().parse(base);
    const fetch = vi.fn<typeof globalThis.fetch>().mockResolvedValue({
      ok: true,
      json: async () => ({
        applications: [summary],
        pagination: { page: 2, limit: 10, total: 11, totalPages: 2 },
      }),
    } as Response);
    vi.stubGlobal('fetch', fetch);
    const signal = new AbortController().signal;
    await fetchApplications(
      {
        search: 'Acme & Co',
        status: 'RESOLVED',
        verification: 'PENDING',
        sort: 'oldest',
        page: 2,
      },
      'token',
      signal,
    );
    expect(String(fetch.mock.calls[0]?.[0])).toContain('search=Acme+%26+Co');
    expect(String(fetch.mock.calls[0]?.[0])).toContain('sort=oldest');
    expect(fetch).toHaveBeenCalledWith(
      expect.any(String),
      expect.objectContaining({
        signal: expect.any(AbortSignal),
        cache: 'no-store',
      }),
    );
  });
  it('rejects malformed authoritative states and missing data', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => ({
        ok: true,
        json: async () => ({
          application: { ...base, state: 'FAKE_CONFIRMED' },
        }),
      })),
    );
    await expect(fetchApplication('app-1', 'token')).rejects.toThrow(
      'unavailable or inconsistent',
    );
  });
});
