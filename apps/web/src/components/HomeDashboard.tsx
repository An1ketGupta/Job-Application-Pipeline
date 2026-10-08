'use client';
import React, { useCallback } from 'react';
import Link from 'next/link';
import { useAuth } from '@/lib/auth-context';
import { fetchApplications } from '@/lib/api';
import { useWorkspaceQuery } from '@/lib/use-workspace-query';
import { ApplicationCard, button, panel } from './applications/WorkspaceUI';

type HomeData = Awaited<ReturnType<typeof readHome>>;
async function readHome(token: string, signal: AbortSignal) {
  const [recent, review] = await Promise.all([
    fetchApplications({ limit: 3 }, token, signal),
    fetchApplications({ review: 'true', limit: 1 }, token, signal),
  ]);
  return { recent, review };
}
const active = (data: HomeData) =>
  data.recent.applications.some((app) => app.active);
export function HomeDashboard() {
  const { user, token, isLoading } = useAuth();
  const read = useCallback(
    (signal: AbortSignal) => readHome(token!, signal),
    [token],
  );
  const query = useWorkspaceQuery(
    read,
    active,
    !!token && !isLoading,
    token ?? 'logged-out',
  );
  return (
    <section className="space-y-5">
      <header>
        <h1 className="text-2xl font-bold">Your application workspace</h1>
        <p className="mt-2 text-sm text-slate-600">
          Discover jobs, prepare your information, review questions, and track
          applications through independent verification.
        </p>
      </header>
      {isLoading ? (
        <p role="status">Checking your account…</p>
      ) : !user ? (
        <section className={panel}>
          <h2 className="font-bold">Start with a local account</h2>
          <p className="mt-2 text-sm">
            Select Log in above and enter your email. Use the same email to
            return to your profile and application history.
          </p>
        </section>
      ) : (
        <>
          <div className="grid gap-4 sm:grid-cols-2">
            <section className={panel}>
              <h2 className="font-bold">Applications</h2>
              <p className="mt-2 text-sm">
                {query.data
                  ? `${query.data.recent.pagination.total} applications in your workspace`
                  : 'Loading your applications…'}
              </p>
              <Link className={`${button} mt-4`} href="/applications">
                Open applications
              </Link>
            </section>
            <section className={panel}>
              <h2 className="font-bold">Human Review</h2>
              <p className="mt-2 text-sm">
                {query.data
                  ? query.data.review.pagination.total
                    ? `${query.data.review.pagination.total} applications need your attention`
                    : "You're all caught up."
                  : 'Checking pending actions…'}
              </p>
              <Link className={`${button} mt-4`} href="/review">
                Review pending actions
              </Link>
            </section>
          </div>
          {query.error && (
            <div role="alert">
              <p>{query.error}</p>
              <button className={`${button} mt-2`} onClick={query.refresh}>
                Retry workspace
              </button>
            </div>
          )}
          {query.stopped === 'limit' && (
            <p role="status" className="text-sm">
              Live updates paused.{' '}
              <button className="underline" onClick={query.refresh}>
                Refresh workspace
              </button>
            </p>
          )}
        </>
      )}
      <section className={panel}>
        <h2 className="font-bold">How CareerLift works</h2>
        <ol className="mt-4 list-decimal space-y-3 pl-5 text-sm">
          <li>
            <Link href="/profile" className="text-indigo-700 underline">
              Set up your profile
            </Link>{' '}
            and{' '}
            <Link href="/documents" className="text-indigo-700 underline">
              upload a resume
            </Link>
            . Add recurring sensitive information in{' '}
            <Link
              href="/verified-answers"
              className="text-indigo-700 underline"
            >
              Verified Answers
            </Link>
            .
          </li>
          <li>
            <Link href="/jobs" className="text-indigo-700 underline">
              Open Jobs
            </Link>
            , synchronize listings, and select Apply. CareerLift creates one
            application for each job in your account.
          </li>
          <li>
            Open the application to inspect the form and prepare answers.
            Resolve required questions in Human Review; the worker resumes
            preparation.
          </li>
          <li>
            Use the explicitly configured local fixture controls to test
            execution. A dry run submits nothing. A controlled fixture submits
            once and requires an independent verification check.
          </li>
          <li>
            Track the outcome and timeline in Applications. An unknown outcome
            remains unknown until verification or an explicit manual decision
            establishes it.
          </li>
        </ol>
        <p className="mt-4 text-sm text-slate-600">
          Real execution is disabled by default. Greenhouse, Lever and Ashby use
          the existing safety checks. Unsupported platforms, CAPTCHA and
          authentication challenges require manual action.
        </p>
        <Link className={`${button} mt-4`} href="/settings">
          Local operation guide
        </Link>
      </section>
      {query.data?.recent.applications.length ? (
        <section className="space-y-4">
          <h2 className="text-lg font-bold">Recent applications</h2>
          {query.data.recent.applications.map((app) => (
            <ApplicationCard key={app.id} application={app} />
          ))}
        </section>
      ) : null}
    </section>
  );
}
