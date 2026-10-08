import React from 'react';
import Link from 'next/link';
import type { ApplicationSummary, ApplicationDetail } from '@/lib/types';
import { GoogleFormSubmissionFlag } from './GoogleFormSubmissionFlag';
import {
  applicationHeadline,
  applicationLabels,
  stateLabel,
  formatTimestamp,
  submissionLabel,
} from '@/lib/application-presentation';

export const panel =
  'rounded-xl border border-slate-200 bg-white p-5 sm:p-6 shadow-xs';
export const button =
  'inline-flex items-center justify-center rounded-lg border border-slate-300 bg-white px-3 py-2 text-sm font-semibold text-slate-700 hover:bg-slate-50 disabled:opacity-50';
const platformLabel = (app: ApplicationSummary) =>
  ({
    GREENHOUSE: 'Greenhouse',
    LEVER: 'Lever',
    ASHBY: 'Ashby',
    GOOGLE_FORM: 'Google Forms',
    UNSUPPORTED: 'Unsupported',
    OTHER: 'Other',
  })[app.plan?.platform ?? 'OTHER'];
export function WorkspaceLoading() {
  return (
    <div
      role="status"
      aria-label="Loading applications"
      className="space-y-4 py-6"
    >
      <p className="text-sm text-slate-500">Loading applications…</p>
      {[0, 1, 2].map((i) => (
        <div key={i} className="h-24 animate-pulse rounded-xl bg-slate-100" />
      ))}
    </div>
  );
}
export function WorkspaceError({
  message,
  refresh,
}: {
  message: string;
  refresh: () => void;
}) {
  return (
    <div
      role="alert"
      className="rounded-xl border border-rose-200 bg-rose-50 p-5"
    >
      <p className="mb-3 text-sm text-rose-800">{message}</p>
      <button type="button" className={button} onClick={refresh}>
        Refresh
      </button>
    </div>
  );
}
export function LiveStatus({
  busy,
  stopped,
  active,
}: {
  busy: boolean;
  stopped: string | null;
  active: boolean;
}) {
  return (
    <p role="status" className="text-xs text-slate-500">
      {busy
        ? 'Refreshing application records…'
        : stopped === 'limit'
          ? 'Live updates paused after five minutes. Refresh to check again.'
          : stopped === 'error'
            ? 'Live updates paused. Refresh to reconnect.'
            : active
              ? 'Checking active applications every 5 seconds.'
              : 'Showing the latest application records.'}
    </p>
  );
}
export function ApplicationStatus({
  application: app,
}: {
  application: ApplicationSummary;
}) {
  return (
    <span
      className={`inline-flex rounded-full px-3 py-1 text-xs font-semibold ${app.humanReviewRequired ? 'bg-amber-50 text-amber-900' : app.state === 'FAILED' || app.state === 'BLOCKED' ? 'bg-rose-50 text-rose-800' : 'bg-indigo-50 text-indigo-700'}`}
    >
      {applicationHeadline(app)}
    </span>
  );
}
function Metadata({
  label,
  children,
}: {
  label: string;
  children: React.ReactNode;
}) {
  return (
    <div>
      <dt className="text-slate-500">{label}</dt>
      <dd className="mt-1">{children}</dd>
    </div>
  );
}
export function ApplicationCard({
  application: app,
}: {
  application: ApplicationSummary;
}) {
  const href = `/applications/${encodeURIComponent(app.id)}`;
  return (
    <article className={panel}>
      {app.googleForm && (
        <GoogleFormSubmissionFlag run={app.googleForm} compact />
      )}
      <div className="flex flex-col justify-between gap-4 sm:flex-row">
        <div>
          <h2 className="text-lg font-bold">
            <Link href={href} className="hover:text-indigo-600">
              {app.job.title}
            </Link>
          </h2>
          <p className="mt-1 text-sm text-slate-600">
            {app.job.company} · {app.job.location || 'Location not specified'}
          </p>
        </div>
        <div>
          <ApplicationStatus application={app} />
        </div>
      </div>
      <dl className="mt-4 grid gap-3 text-xs sm:grid-cols-2 lg:grid-cols-4">
        <Metadata label="Platform">{platformLabel(app)}</Metadata>
        <Metadata label="Application">{applicationLabels[app.state]}</Metadata>
        <Metadata label="Verification">
          {stateLabel(app.execution?.verification?.state)}
        </Metadata>
        <Metadata label="Created">
          <time dateTime={app.createdAt}>{formatTimestamp(app.createdAt)}</time>
        </Metadata>
        <Metadata label="Last activity">
          <time dateTime={app.lastActivityAt}>
            {formatTimestamp(app.lastActivityAt)}
          </time>
        </Metadata>
      </dl>
      <div className="mt-4 flex flex-wrap items-center justify-between gap-3 border-t border-slate-100 pt-4">
        <p className="text-xs text-slate-500">
          Application updated: {formatTimestamp(app.updatedAt)}
        </p>
        <Link
          className={button}
          href={app.humanReviewRequired ? `${href}#review` : href}
        >
          {app.humanReviewRequired ? 'Review Application' : 'View Application'}
        </Link>
      </div>
    </article>
  );
}
export function ApplicationsEmpty({
  filtered,
  reset,
}: {
  filtered: boolean;
  reset: () => void;
}) {
  return (
    <div className={`${panel} py-12 text-center`}>
      <h2 className="text-lg font-semibold">
        {filtered ? 'No matching applications' : 'No applications yet'}
      </h2>
      <p className="mt-2 text-sm text-slate-500">
        {filtered
          ? 'Try another search or clear your filters.'
          : 'Find a job and start your first application.'}
      </p>
      <div className="mt-5">
        {filtered ? (
          <button type="button" className={button} onClick={reset}>
            Clear filters
          </button>
        ) : (
          <Link className={button} href="/jobs">
            Browse Jobs
          </Link>
        )}
      </div>
    </div>
  );
}
export function ApplicationDetailsView({
  application: app,
}: {
  application: ApplicationDetail;
}) {
  const verification = app.execution?.verification;
  const isEmail = app.plan?.applicationType === 'EMAIL';
  const isGoogleForm = !!app.googleForm || app.plan?.platform === 'GOOGLE_FORM';
  const stages = [
    { label: 'Created', state: 'Created', at: app.createdAt },
    {
      label: 'Resolution',
      state: app.plan
        ? 'Resolved'
        : stateLabel(app.state === 'ANALYZING' ? 'ANALYZING' : null),
      at: app.plan?.createdAt,
    },
    {
      label: 'Inspection',
      state: isEmail
        ? 'Not needed for email'
        : stateLabel(app.inspection?.state),
      at: app.inspection?.completedAt || app.inspection?.startedAt,
    },
    {
      label: 'Preparation',
      state: isEmail
        ? app.email
          ? 'Email draft prepared'
          : 'Not started'
        : stateLabel(app.preparation?.state),
      at: app.preparation?.completedAt || app.preparation?.startedAt,
    },
    {
      label: 'Human review',
      state: app.humanReviewRequired
        ? 'Required'
        : isEmail && app.email?.state === 'DRAFT'
          ? 'Email approval required'
          : 'No pending review',
      at: app.updatedAt,
    },
    {
      label: 'Execution',
      state:
        app.execution?.state === 'SUBMISSION_UNKNOWN' &&
        ['CONFIRMED', 'REJECTED'].includes(verification?.establishedState ?? '')
          ? 'Attempt completed — see verified outcome below'
          : stateLabel(isEmail ? app.email?.state : app.execution?.state),
      at: isEmail
        ? app.email?.sentAt || app.email?.updatedAt
        : app.execution?.completedAt || app.execution?.startedAt,
    },
    {
      label: 'Submission',
      state: submissionLabel(app),
      at: app.execution?.completedAt,
    },
    {
      label: 'Verification',
      state: isEmail
        ? 'Employer receipt not verified'
        : stateLabel(verification?.state),
      at: verification?.updatedAt,
    },
  ];
  const issues = [
    app.inspection?.issue,
    app.preparation?.issue,
    app.execution?.issue,
  ].filter(Boolean);
  return (
    <div className="space-y-6">
      <header className={panel}>
        {app.googleForm && <GoogleFormSubmissionFlag run={app.googleForm} />}
        <p className="text-xs text-slate-500 break-all">Application {app.id}</p>
        <div className="mt-2 flex flex-col justify-between gap-3 sm:flex-row">
          <div>
            <h1 className="text-2xl font-bold">{app.job.title}</h1>
            <p className="mt-1 text-slate-600">{app.job.company}</p>
          </div>
          <div>
            <ApplicationStatus application={app} />
          </div>
        </div>
        <dl className="mt-5 grid gap-3 text-sm sm:grid-cols-2">
          <Metadata label="Application state">
            {applicationLabels[app.state]}{' '}
            <span className="text-xs text-slate-400">({app.state})</span>
          </Metadata>
          <Metadata label="Submission">{submissionLabel(app)}</Metadata>
        </dl>
      </header>
      {app.execution?.state === 'SUBMISSION_UNKNOWN' &&
        app.state !== 'SUBMITTED' &&
        verification?.state !== 'REJECTED' && (
          <section
            className="rounded-xl border border-amber-300 bg-amber-50 p-5"
            role="status"
          >
            <h2 className="font-bold">Submission outcome unknown</h2>
            <p className="mt-2 text-sm">
              CareerLift could not independently confirm whether the application
              was accepted. Check verification or inspect the application system
              manually. No repeat submission will be started.
            </p>
          </section>
        )}
      {!app.execution &&
        !isGoogleForm &&
        !app.humanReviewRequired &&
        app.preparation?.state === 'COMPLETED' && (
          <p className="rounded-lg bg-indigo-50 p-4 text-sm">
            Preparation is complete.{' '}
            {app.executionModes?.length
              ? 'Use the controlled local execution controls below.'
              : 'Controlled execution requires a configured local fixture. Real execution is disabled by default.'}
          </p>
        )}
      {app.humanReviewRequired && !isGoogleForm && (
        <section className="rounded-xl border border-amber-200 bg-amber-50 p-5">
          <h2 className="font-bold text-amber-950">
            Action required: human review
          </h2>
          <p className="mt-2 text-sm text-amber-900">
            The agent needs your input before it can continue.
          </p>
          <Link href="#review" className={`${button} mt-4`}>
            Open Review
          </Link>
        </section>
      )}
      {app.execution && (
        <p className="rounded-lg bg-slate-100 p-3 text-sm">
          Execution mode: {app.execution.mode}.{' '}
          {app.execution.mode === 'TEST_FIXTURE'
            ? 'Results refer to the local test system.'
            : app.execution.mode === 'DRY_RUN'
              ? 'A dry run does not submit an application.'
              : 'Real execution was explicitly enabled outside this UI.'}
        </p>
      )}
      <section className={panel} aria-labelledby="job-heading">
        <h2 id="job-heading" className="font-bold">
          Associated job
        </h2>
        <p className="mt-2 text-sm">
          {app.job.title} · {app.job.company}
        </p>
        <dl className="mt-4 grid gap-3 text-sm sm:grid-cols-2">
          <Metadata label="Location / remote">
            {app.job.location || 'Not specified'}
            {app.job.location?.toLowerCase().includes('remote')
              ? ' · Remote indicated in job location'
              : ''}
          </Metadata>
          <Metadata label="Employment">
            {app.job.employmentType || 'Not specified'}
          </Metadata>
          <Metadata label="Platform">
            {app.plan ? platformLabel(app) : 'Not resolved'}
          </Metadata>
          <Metadata label="Application URL">
            {app.plan?.applicationUrl ? (
              <a
                className="break-all text-indigo-600"
                href={app.plan.applicationUrl}
                target="_blank"
                rel="noopener noreferrer"
              >
                {app.plan.applicationUrl}
              </a>
            ) : (
              'Not available'
            )}
          </Metadata>
          {isEmail && (
            <Metadata label="Application email">
              {app.plan?.applicationEmail || 'Not available'}
            </Metadata>
          )}
          <Metadata label="Source">{app.job.source}</Metadata>
        </dl>
        <Link
          className={`${button} mt-4`}
          href={`/jobs/${encodeURIComponent(app.job.id)}`}
        >
          View Job
        </Link>
      </section>
      {!isGoogleForm && (
        <section className={panel}>
          <h2 className="font-bold">Application lifecycle</h2>
          <p className="mt-1 text-xs text-slate-500">
            Each stage shows its persisted state. Later stages do not imply
            earlier stages completed.
          </p>
          <ol className="mt-5 grid gap-3 sm:grid-cols-2 lg:grid-cols-3">
            {stages.map((s) => (
              <li
                key={s.label}
                className="rounded-lg border border-slate-200 p-3"
              >
                <h3 className="text-sm font-semibold">{s.label}</h3>
                <p className="mt-1 text-sm text-indigo-700">{s.state}</p>
                {s.at && (
                  <time
                    className="mt-2 block text-xs text-slate-500"
                    dateTime={s.at}
                  >
                    {formatTimestamp(s.at)}
                  </time>
                )}
              </li>
            ))}
          </ol>
        </section>
      )}
      {!isGoogleForm && (
        <section className={panel}>
          <h2 className="font-bold">Submission verification</h2>
          <dl className="mt-3 grid gap-3 text-sm sm:grid-cols-2">
            <Metadata label="Current check">
              {isEmail
                ? app.email?.state === 'SENT'
                  ? 'Gmail accepted the message'
                  : 'Email not confirmed sent'
                : stateLabel(verification?.state)}
            </Metadata>
            <Metadata label="Previously established outcome">
              {isEmail
                ? 'Employer receipt not verified'
                : stateLabel(verification?.establishedState)}
            </Metadata>
          </dl>
          <p className="mt-3 text-sm text-slate-600">
            {isEmail
              ? 'Email automation records Gmail’s send response. It does not check the employer’s inbox or establish whether the application was read or accepted.'
              : verification?.summary ||
                (app.execution?.state === 'SUBMISSION_UNKNOWN'
                  ? 'We could not establish whether the application was accepted. No duplicate submission will be attempted.'
                  : 'No verification record is available yet.')}
          </p>
          {verification && (
            <p className="mt-3 text-xs text-slate-500">
              {verification.evidenceCount} evidence records ·{' '}
              {verification.attemptCount} verification attempts
              {verification.verifiedAt &&
                ` · Confirmation recorded ${formatTimestamp(verification.verifiedAt)}`}
            </p>
          )}
        </section>
      )}
      {!isGoogleForm &&
        (issues.length > 0 || ['FAILED', 'BLOCKED'].includes(app.state)) && (
          <section className="rounded-xl border border-rose-200 bg-rose-50 p-5">
            <h2 className="font-bold">
              {verification?.state === 'REJECTED'
                ? 'Submission rejected'
                : 'Application needs attention'}
            </h2>
            <p className="mt-2 text-sm">
              {verification?.state === 'REJECTED'
                ? verification.summary
                : 'The agent could not complete the application. An execution failure does not establish external rejection.'}
            </p>
            {issues.map((text, i) => (
              <p key={i} className="mt-2 text-sm">
                {text}
              </p>
            ))}
          </section>
        )}
      {app.humanReviewRequired && !isGoogleForm && (
        <section
          id="review"
          tabIndex={-1}
          className={`${panel} scroll-mt-6 border-amber-200`}
        >
          <h2 className="font-bold">Action required</h2>
          <ul className="mt-3 list-disc space-y-2 pl-5 text-sm">
            {app.reviewReasons.map((reason) => (
              <li key={reason}>{reason}</li>
            ))}
          </ul>
          <p className="mt-4 text-sm text-slate-500">
            This application is blocked until the required information or
            security issue is reviewed. Candidate answers can resume
            preparation; execution remains subject to its existing checks.
          </p>
          <Link
            className={`${button} mt-4`}
            href={`/review/${encodeURIComponent(app.id)}`}
          >
            Review required information
          </Link>
        </section>
      )}
      {!isGoogleForm && (
        <section className={panel}>
          <h2 className="font-bold">Answers and documents</h2>
          {app.preparationSummary ? (
            <>
              <p className="mt-3 text-sm">
                {app.preparationSummary.fieldCount} prepared fields ·{' '}
                {app.preparationSummary.answerCount} prepared answers ·{' '}
                {app.preparationSummary.reviewCount} review requirements
              </p>
              <ul className="mt-3 space-y-2 text-sm">
                {app.preparationSummary.documents.map((d, i) => (
                  <li key={i}>
                    {stateLabel(d.type)}:{' '}
                    {d.selected
                      ? 'Selected during preparation'
                      : 'Selection needed'}
                  </li>
                ))}
              </ul>
              <p className="mt-3 text-xs text-slate-500">
                Document uploads and the exact documents used by execution are
                not available in this summary.
              </p>
            </>
          ) : (
            <p className="mt-3 text-sm text-slate-500">
              No safe preparation summary is available yet.
            </p>
          )}
        </section>
      )}
      <section className={panel}>
        <h2 className="font-bold">Timeline</h2>
        {app.timelineTruncated && (
          <p className="mt-2 text-xs text-slate-500">
            Showing recent recorded events; older history is omitted.
          </p>
        )}
        <ol className="mt-4 space-y-3">
          {app.timeline.map((event) => (
            <li key={event.id} className="border-l-2 border-indigo-200 pl-4">
              <p className="text-sm font-medium">{event.label}</p>
              <time className="text-xs text-slate-500" dateTime={event.at}>
                {formatTimestamp(event.at)}
              </time>
            </li>
          ))}
        </ol>
      </section>
      {app.executions.length > 1 && (
        <section className={panel}>
          <h2 className="font-bold">Execution history</h2>
          <ul className="mt-3 space-y-3 text-sm">
            {app.executions.map((e) => (
              <li key={e.mode}>
                {stateLabel(e.mode)} · {stateLabel(e.state)} · Verification:{' '}
                {stateLabel(e.verification?.state)}
              </li>
            ))}
          </ul>
        </section>
      )}
      <footer className="text-xs text-slate-500">
        Created {formatTimestamp(app.createdAt)} · Application updated{' '}
        {formatTimestamp(app.updatedAt)} · Last activity{' '}
        {formatTimestamp(app.lastActivityAt)}
        {app.active &&
          Date.now() - new Date(app.lastActivityAt).getTime() > 300000 && (
            <p className="mt-2">
              No recent recorded progress. The worker may be waiting or
              unavailable. Refresh to check.
            </p>
          )}
      </footer>
    </div>
  );
}
