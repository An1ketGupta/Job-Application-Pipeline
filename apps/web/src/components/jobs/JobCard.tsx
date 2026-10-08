'use client';

import React, { useState } from 'react';
import Link from 'next/link';
import { useRouter } from 'next/navigation';
import type { NormalizedJob } from '@/lib/types';
import { startApplication } from '@/lib/api';
import { useAuth } from '@/lib/auth-context';

interface JobCardProps {
  job: NormalizedJob;
  onApplicationStarted?: (jobId: string, applicationId: string) => void;
}

export function JobCard({ job, onApplicationStarted }: JobCardProps) {
  const router = useRouter();
  const { token } = useAuth();
  const [isApplying, setIsApplying] = useState(false);
  const [errorMessage, setErrorMessage] = useState<string | null>(null);

  const status = job.applicationStatus;
  const isApplied = !!status?.hasApplication;
  const isRemote =
    job.location?.toLowerCase().includes('remote') ||
    job.title?.toLowerCase().includes('remote');

  const platform =
    job.application?.provider || job.application?.type || 'Direct';

  const handleApply = async (e: React.MouseEvent) => {
    e.stopPropagation();
    if (isApplying) return;
    if (!token) {
      setErrorMessage('Please log in to apply.');
      return;
    }
    if (isApplied && status?.applicationId) {
      router.push(`/applications/${status.applicationId}`);
      return;
    }

    setIsApplying(true);
    setErrorMessage(null);
    try {
      const res = await startApplication(job.id, token);
      if (onApplicationStarted) {
        onApplicationStarted(job.id, res.application.id);
      }
      router.push(`/applications/${res.application.id}`);
    } catch (err: unknown) {
      const msg =
        err instanceof Error ? err.message : 'Could not start application';
      setErrorMessage(msg);
      setIsApplying(false);
    }
  };

  const renderStatusBadge = () => {
    if (!status?.hasApplication) return null;

    switch (status.state) {
      case 'SUBMITTED':
        return (
          <span className="inline-flex items-center gap-1 rounded-full bg-emerald-50 px-2.5 py-0.5 text-xs font-semibold text-emerald-700 ring-1 ring-inset ring-emerald-600/20">
            ✓ Submitted
          </span>
        );
      case 'HUMAN_REQUIRED':
        return (
          <span className="inline-flex items-center gap-1 rounded-full bg-amber-50 px-2.5 py-0.5 text-xs font-semibold text-amber-700 ring-1 ring-inset ring-amber-600/20">
            ⚠ Human Review
          </span>
        );
      case 'FAILED':
      case 'BLOCKED':
        return (
          <span className="inline-flex items-center gap-1 rounded-full bg-rose-50 px-2.5 py-0.5 text-xs font-semibold text-rose-700 ring-1 ring-inset ring-rose-600/20">
            ● Failed
          </span>
        );
      default:
        return (
          <span className="inline-flex items-center gap-1 rounded-full bg-indigo-50 px-2.5 py-0.5 text-xs font-semibold text-indigo-700 ring-1 ring-inset ring-indigo-600/20">
            ● {status.state}
          </span>
        );
    }
  };

  return (
    <div className="group rounded-xl border border-slate-200 bg-white p-5 shadow-xs transition-all hover:border-slate-300 hover:shadow-md">
      <div className="flex flex-col justify-between gap-4 sm:flex-row sm:items-start">
        <div className="space-y-1.5 flex-1 min-w-0">
          <div className="flex flex-wrap items-center gap-2">
            <h2 className="text-base font-semibold text-slate-900">
              <Link
                href={`/jobs/${encodeURIComponent(job.id)}`}
                className="hover:text-indigo-600 transition-colors"
              >
                {job.title}
              </Link>
            </h2>
            {renderStatusBadge()}
          </div>

          <p className="text-sm font-medium text-slate-600">{job.company}</p>

          <div className="flex flex-wrap items-center gap-2 pt-1 text-xs text-slate-500">
            {job.location && (
              <span className="inline-flex items-center gap-1 rounded-md bg-slate-100 px-2 py-0.5 text-slate-700">
                {isRemote && (
                  <span className="h-1.5 w-1.5 rounded-full bg-emerald-500" />
                )}
                {job.location}
              </span>
            )}
            {job.employmentType && (
              <span className="inline-flex items-center rounded-md bg-slate-100 px-2 py-0.5 text-slate-700">
                {job.employmentType}
              </span>
            )}
            <span className="inline-flex items-center rounded-md bg-purple-50 px-2 py-0.5 text-purple-700 font-medium">
              Platform: {platform}
            </span>
            <span className="inline-flex items-center rounded-md bg-slate-50 px-2 py-0.5 text-slate-500">
              Source: {job.source}
            </span>
          </div>

          {job.description && (
            <p className="mt-2 text-xs text-slate-600 line-clamp-2">
              {job.description}
            </p>
          )}

          {errorMessage && (
            <p role="alert" className="mt-2 text-xs text-rose-600 font-medium">
              {errorMessage}
            </p>
          )}
        </div>

        {/* Action Buttons */}
        <div className="flex shrink-0 flex-wrap items-center gap-2 sm:self-center">
          <Link
            href={`/jobs/${encodeURIComponent(job.id)}`}
            className="rounded-lg border border-slate-300 bg-white px-3 py-1.5 text-xs font-semibold text-slate-700 shadow-2xs hover:bg-slate-50 hover:text-slate-900 transition-colors"
          >
            View Job
          </Link>

          {isApplied ? (
            <Link
              href={`/applications/${status?.applicationId}`}
              className="inline-flex items-center gap-1 rounded-lg bg-slate-900 px-3 py-1.5 text-xs font-semibold text-white shadow-2xs hover:bg-slate-800 transition-colors"
            >
              {status?.state === 'HUMAN_REQUIRED'
                ? 'Review'
                : 'View Application'}
            </Link>
          ) : (
            <button
              type="button"
              disabled={isApplying || !token}
              onClick={handleApply}
              className="inline-flex items-center gap-1 rounded-lg bg-indigo-600 px-3.5 py-1.5 text-xs font-semibold text-white shadow-2xs hover:bg-indigo-700 disabled:opacity-50 transition-colors cursor-pointer"
            >
              {isApplying ? (
                <>
                  <svg
                    className="h-3.5 w-3.5 animate-spin text-white"
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
                  Applying...
                </>
              ) : (
                'Apply'
              )}
            </button>
          )}
        </div>
      </div>
    </div>
  );
}
