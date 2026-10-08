'use client';

import React, { useEffect, useState, use } from 'react';
import Link from 'next/link';
import { useRouter } from 'next/navigation';
import type { NormalizedJob } from '@/lib/types';
import { fetchJob, startApplication } from '@/lib/api';
import { useAuth } from '@/lib/auth-context';
import { isSafeDestinationUrl, sanitizeText } from '@/lib/security';

export default function JobDetailPage({
  params,
}: {
  params: Promise<{ id: string }>;
}) {
  const { id: routeId } = use(params);
  // Client navigation can retain the encoded segment for namespaced job IDs.
  // Decode at the routing boundary; the API client encodes the actual ID once.
  let id = routeId;
  try {
    id = decodeURIComponent(routeId);
  } catch {
    // Let the API return its normal not-found response for malformed IDs.
  }
  const router = useRouter();
  const { token, isLoading: isAuthLoading } = useAuth();
  const [job, setJob] = useState<NormalizedJob | null>(null);
  const [isLoading, setIsLoading] = useState(true);
  const [isApplying, setIsApplying] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [applyError, setApplyError] = useState<string | null>(null);
  const [loadedIdentity, setLoadedIdentity] = useState('');
  const [reload, setReload] = useState(0);

  useEffect(() => {
    const controller = new AbortController();
    async function load() {
      if (!token) return;
      setIsLoading(true);
      setError(null);
      try {
        const res = await fetchJob(id, token, controller.signal);
        if (controller.signal.aborted) return;
        setJob(res.job);
        setLoadedIdentity(`${token}|${id}`);
      } catch (err: unknown) {
        if (controller.signal.aborted) return;
        const msg = err instanceof Error ? err.message : 'Job not found';
        setError(msg);
      } finally {
        if (!controller.signal.aborted) setIsLoading(false);
      }
    }

    if (!isAuthLoading && token) {
      load();
    }
    return () => controller.abort();
  }, [id, token, isAuthLoading, reload]);

  const handleApply = async () => {
    if (!token || !job || isApplying) return;
    if (
      job.applicationStatus?.hasApplication &&
      job.applicationStatus.applicationId
    ) {
      router.push(`/applications/${job.applicationStatus.applicationId}`);
      return;
    }

    setIsApplying(true);
    setApplyError(null);
    try {
      const res = await startApplication(job.id, token);
      router.push(`/applications/${res.application.id}`);
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : 'Could not apply';
      setApplyError(msg);
      setIsApplying(false);
    }
  };

  if (isAuthLoading) return <p role="status">Checking your account…</p>;
  if (!token) return <p role="alert">Log in to view this job.</p>;
  if (isLoading || (!error && loadedIdentity !== `${token}|${id}`)) {
    return (
      <div className="space-y-4 py-6" role="status" aria-label="Loading job">
        <div className="h-6 w-32 animate-pulse rounded bg-slate-200" />
        <div className="h-10 w-2/3 animate-pulse rounded bg-slate-200" />
        <div className="h-40 w-full animate-pulse rounded bg-slate-100" />
      </div>
    );
  }

  if (error || !job) {
    return (
      <div className="rounded-xl border border-rose-200 bg-rose-50/50 p-8 text-center space-y-3">
        <h2 className="text-base font-semibold text-rose-800">
          {error || 'Job not found'}
        </h2>
        <button
          className="rounded-lg border border-slate-300 px-4 py-2"
          onClick={() => setReload((value) => value + 1)}
        >
          Retry job
        </button>
        <Link
          href="/jobs"
          className="inline-block rounded-lg bg-slate-800 px-4 py-1.5 text-xs font-semibold text-white hover:bg-slate-900"
        >
          ← Back to Jobs
        </Link>
      </div>
    );
  }

  const status = job.applicationStatus;
  const isApplied = !!status?.hasApplication;
  const destinationUrl = job.application?.url;
  const isUrlSafe = isSafeDestinationUrl(destinationUrl);
  const isRemote =
    job.location?.toLowerCase().includes('remote') ||
    job.title?.toLowerCase().includes('remote');

  return (
    <article className="space-y-6">
      {applyError && (
        <p
          role="alert"
          className="rounded-lg bg-rose-50 p-3 text-sm text-rose-800"
        >
          {applyError}
        </p>
      )}
      {/* Back button */}
      <div>
        <Link
          href="/jobs"
          className="inline-flex items-center gap-1 text-xs font-medium text-slate-500 hover:text-slate-800 transition-colors"
        >
          ← Back to all jobs
        </Link>
      </div>

      {/* Existing Application Banner */}
      {isApplied && (
        <div className="rounded-xl border border-indigo-200 bg-indigo-50/80 p-4 flex flex-col sm:flex-row sm:items-center justify-between gap-3">
          <div className="space-y-0.5">
            <p className="text-xs font-semibold text-indigo-900 uppercase tracking-wide">
              Application already created
            </p>
            <p className="text-sm text-indigo-700">
              Current state:{' '}
              <strong className="font-semibold">{status?.state}</strong>
            </p>
          </div>
          <Link
            href={`/applications/${status?.applicationId}`}
            className="rounded-lg bg-indigo-600 px-3.5 py-1.5 text-xs font-semibold text-white hover:bg-indigo-700 text-center shadow-xs"
          >
            Open Application →
          </Link>
        </div>
      )}

      {/* Job Header */}
      <div className="rounded-xl border border-slate-200 bg-white p-6 shadow-xs space-y-4">
        <div className="flex flex-col justify-between gap-4 sm:flex-row sm:items-start">
          <div className="space-y-1">
            <h1 className="text-2xl font-bold tracking-tight text-slate-900">
              {job.title}
            </h1>
            <p className="text-base font-medium text-slate-700">
              {job.company}
            </p>

            <div className="flex flex-wrap items-center gap-2 pt-2 text-xs">
              {job.location && (
                <span className="inline-flex items-center gap-1 rounded-md bg-slate-100 px-2.5 py-1 text-slate-700 font-medium">
                  {isRemote && (
                    <span className="h-1.5 w-1.5 rounded-full bg-emerald-500" />
                  )}
                  {job.location}
                </span>
              )}
              {job.employmentType && (
                <span className="rounded-md bg-slate-100 px-2.5 py-1 text-slate-700 font-medium">
                  {job.employmentType}
                </span>
              )}
              <span className="rounded-md bg-purple-50 px-2.5 py-1 text-purple-700 font-medium">
                Platform:{' '}
                {job.application?.provider || job.application?.type || 'Direct'}
              </span>
              <span className="rounded-md bg-slate-100 px-2.5 py-1 text-slate-600">
                Source: {job.source}
              </span>
            </div>
          </div>

          {/* Action Button */}
          <div className="shrink-0">
            {isApplied ? (
              <Link
                href={`/applications/${status?.applicationId}`}
                className="inline-flex items-center gap-1 rounded-lg bg-slate-900 px-4 py-2 text-sm font-semibold text-white shadow-xs hover:bg-slate-800 transition-colors"
              >
                View Application
              </Link>
            ) : (
              <button
                type="button"
                disabled={isApplying}
                onClick={handleApply}
                className="inline-flex items-center gap-2 rounded-lg bg-indigo-600 px-5 py-2 text-sm font-semibold text-white shadow-xs hover:bg-indigo-700 disabled:opacity-50 transition-colors cursor-pointer"
              >
                {isApplying ? (
                  <>
                    <svg
                      className="h-4 w-4 animate-spin text-white"
                      viewBox="0 0 24 24"
                      fill="none"
                    >
                      <circle
                        className="opacity-25"
                        cx="12"
                        cy="12"
                        r="10"
                        stroke="currentColor"
                        strokeWidth="4"
                      />
                      <path
                        className="opacity-75"
                        fill="currentColor"
                        d="M4 12a8 8 0 018-8v8z"
                      />
                    </svg>
                    Creating Application...
                  </>
                ) : (
                  'Apply Now'
                )}
              </button>
            )}
          </div>
        </div>
      </div>

      {/* About Role / Safe Description */}
      <section className="rounded-xl border border-slate-200 bg-white p-6 shadow-xs space-y-3">
        <h2 className="text-base font-bold text-slate-900">About the Role</h2>
        {job.description ? (
          <div className="text-sm leading-relaxed text-slate-700 whitespace-pre-line font-sans select-text">
            {sanitizeText(job.description)}
          </div>
        ) : (
          <p className="text-xs text-slate-400 italic">
            No description provided for this job.
          </p>
        )}
      </section>

      {/* Requirements */}
      {job.requirements && job.requirements.length > 0 && (
        <section className="rounded-xl border border-slate-200 bg-white p-6 shadow-xs space-y-3">
          <h2 className="text-base font-bold text-slate-900">
            Extracted Requirements
          </h2>
          <ul className="space-y-1.5 text-sm text-slate-700">
            {job.requirements.map((req, idx) => (
              <li key={idx} className="flex items-start gap-2">
                <span className="text-indigo-500 font-bold">•</span>
                <span>{req}</span>
              </li>
            ))}
          </ul>
        </section>
      )}

      {/* Application Metadata & Security Boundary */}
      <section className="rounded-xl border border-slate-200 bg-slate-50/70 p-6 space-y-3">
        <h2 className="text-base font-bold text-slate-900">
          Application Information
        </h2>
        <div className="grid grid-cols-1 gap-3 sm:grid-cols-2 text-xs">
          <div>
            <span className="block text-slate-500 font-medium">
              Application Method:
            </span>
            <span className="font-semibold text-slate-800">
              {job.application?.type || 'Direct Portal'}
            </span>
          </div>

          <div>
            <span className="block text-slate-500 font-medium">
              ATS Provider:
            </span>
            <span className="font-semibold text-slate-800">
              {job.application?.provider || 'None identified'}
            </span>
          </div>

          <div>
            <span className="block text-slate-500 font-medium">
              Destination:
            </span>
            {destinationUrl ? (
              isUrlSafe ? (
                <a
                  href={destinationUrl}
                  target="_blank"
                  rel="noopener noreferrer"
                  className="font-medium text-indigo-600 hover:text-indigo-800 underline break-all inline-flex items-center gap-1"
                >
                  {destinationUrl}
                  <span className="text-slate-400">↗</span>
                </a>
              ) : (
                <span className="text-amber-700 font-mono bg-amber-50 px-1 py-0.5 rounded break-all">
                  Unverified / non-HTTPS destination
                </span>
              )
            ) : job.application?.email ? (
              <span className="font-medium text-slate-800 font-mono">
                {job.application.email}
              </span>
            ) : (
              <span className="text-slate-400">Not specified</span>
            )}
          </div>

          <div>
            <span className="block text-slate-500 font-medium">
              Human Review Flag:
            </span>
            <span className="font-semibold text-slate-800">
              {job.application?.requiresHumanReview
                ? 'Required'
                : 'Checked during application resolution'}
            </span>
          </div>
        </div>
      </section>
    </article>
  );
}
