'use client';

import React, { useState, useEffect, useCallback, useRef } from 'react';
import type { NormalizedJob, PaginationMeta, SyncResult } from '@/lib/types';
import { fetchJobs, syncJobs, ApiError } from '@/lib/api';
import { useAuth } from '@/lib/auth-context';
import { JobCard } from './JobCard';
import { JobFilters, type FilterValues } from './JobFilters';

const initialFilters: FilterValues = {
  search: '',
  location: '',
  remote: 'any',
  platform: 'all',
  status: 'ALL',
};

export function JobsDashboard() {
  const { token, user, isLoading: isAuthLoading } = useAuth();
  if (isAuthLoading) return <p role="status">Checking your account…</p>;
  if (!token)
    return <p role="alert">Log in to discover jobs and create applications.</p>;
  return <JobsReader key={user?.id} token={token} />;
}
function JobsReader({ token }: { token: string }) {
  const currentRead = useRef<AbortController | null>(null);
  const [jobs, setJobs] = useState<NormalizedJob[]>([]);
  const [pagination, setPagination] = useState<PaginationMeta>({
    page: 1,
    limit: 10,
    total: 0,
    totalPages: 1,
  });
  const [filters, setFilters] = useState<FilterValues>(initialFilters);
  const [isLoading, setIsLoading] = useState(true);
  const [isSyncing, setIsSyncing] = useState(false);
  const [syncStatus, setSyncStatus] = useState<SyncResult | null>(null);
  const [syncError, setSyncError] = useState<string | null>(null);
  const [fetchError, setFetchError] = useState<string | null>(null);

  const loadJobs = useCallback(
    async (pageToLoad: number = 1, currentFilters: FilterValues = filters) => {
      if (!token) return;
      currentRead.current?.abort();
      const controller = new AbortController();
      currentRead.current = controller;
      setIsLoading(true);
      setFetchError(null);

      try {
        const res = await fetchJobs(
          {
            page: pageToLoad,
            limit: pagination.limit,
            search: currentFilters.search,
            location: currentFilters.location,
            remote:
              currentFilters.remote === 'any'
                ? undefined
                : currentFilters.remote,
            platform:
              currentFilters.platform === 'all'
                ? undefined
                : currentFilters.platform,
            status: currentFilters.status,
          },
          token,
          controller.signal,
        );
        if (controller.signal.aborted) return;
        setJobs(res.jobs);
        setPagination(res.pagination);
      } catch (err: unknown) {
        if (controller.signal.aborted) return;
        if (err instanceof ApiError) {
          setFetchError(err.message);
        } else {
          setFetchError('Unable to fetch jobs. Please verify your connection.');
        }
      } finally {
        if (!controller.signal.aborted) setIsLoading(false);
      }
    },
    [token, pagination.limit, filters],
  );

  useEffect(() => {
    void loadJobs(pagination.page, filters);
    return () => currentRead.current?.abort();
  }, [pagination.page, filters, loadJobs]);

  const handleSync = async () => {
    if (!token || isSyncing) return;
    setIsSyncing(true);
    setSyncError(null);

    try {
      const result = await syncJobs(token);
      setSyncStatus(result);
      // Reload jobs on page 1 after sync
      await loadJobs(1, filters);
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : 'Job sync failed';
      setSyncError(msg);
    } finally {
      setIsSyncing(false);
    }
  };

  const handleFiltersChange = (newFilters: FilterValues) => {
    setFilters(newFilters);
    setPagination((prev) => ({ ...prev, page: 1 }));
  };

  const handleResetFilters = () => {
    setFilters(initialFilters);
    setPagination((prev) => ({ ...prev, page: 1 }));
  };

  const handlePageChange = (newPage: number) => {
    if (newPage >= 1 && newPage <= pagination.totalPages) {
      setPagination((prev) => ({ ...prev, page: newPage }));
    }
  };

  const formatSyncTime = (isoString: string) => {
    try {
      const d = new Date(isoString);
      return d.toLocaleString(undefined, {
        month: 'short',
        day: 'numeric',
        year: 'numeric',
        hour: '2-digit',
        minute: '2-digit',
      });
    } catch {
      return isoString;
    }
  };

  return (
    <section className="space-y-6">
      {/* Top Header */}
      <div className="flex flex-col justify-between gap-4 border-b border-slate-200 pb-5 sm:flex-row sm:items-center">
        <div>
          <h1 className="text-2xl font-bold tracking-tight text-slate-900">
            Jobs
          </h1>
          <p className="mt-1 text-sm text-slate-500">
            Discover normalized job openings and launch automated application
            workflows.
          </p>
        </div>

        <div className="flex flex-wrap items-center gap-3">
          {syncStatus && (
            <span className="text-xs text-slate-500">
              Last synced: {formatSyncTime(syncStatus.lastSyncedAt)}
            </span>
          )}

          <button
            type="button"
            disabled={isSyncing || !token}
            onClick={handleSync}
            className="inline-flex items-center gap-2 rounded-lg bg-indigo-600 px-4 py-2 text-sm font-semibold text-white shadow-xs hover:bg-indigo-700 disabled:opacity-50 transition-colors cursor-pointer"
          >
            {isSyncing ? (
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
                Syncing...
              </>
            ) : (
              <>
                <svg
                  className="h-4 w-4 text-white"
                  fill="none"
                  viewBox="0 0 24 24"
                  stroke="currentColor"
                >
                  <path
                    strokeLinecap="round"
                    strokeLinejoin="round"
                    strokeWidth="2"
                    d="M4 4v5h.582m15.356 2A8.001 8.001 0 004.582 9m0 0H9m11 11v-5h-.581m0 0a8.003 8.003 0 01-15.357-2m15.357 2H15"
                  />
                </svg>
                Sync Jobs
              </>
            )}
          </button>
        </div>
      </div>

      {/* Sync Banner Status */}
      {syncStatus && !isSyncing && (
        <div className="flex items-center justify-between rounded-lg bg-emerald-50 border border-emerald-200 px-4 py-2.5 text-xs font-medium text-emerald-800">
          <span>✓ Synced {syncStatus.synced} jobs from CareerLift</span>
          <button
            type="button"
            onClick={() => setSyncStatus(null)}
            className="text-emerald-700 hover:text-emerald-900"
          >
            ✕
          </button>
        </div>
      )}

      {syncError && (
        <div className="rounded-lg bg-rose-50 border border-rose-200 p-3 text-xs text-rose-800 flex justify-between items-center">
          <span>We couldn't sync jobs. {syncError}</span>
          <button
            type="button"
            onClick={handleSync}
            className="font-semibold underline hover:text-rose-900"
          >
            Try Again
          </button>
        </div>
      )}

      {/* Search and Filters */}
      <JobFilters
        filters={filters}
        onChange={handleFiltersChange}
        onReset={handleResetFilters}
      />

      {/* Results Header */}
      <div className="flex items-center justify-between text-xs font-semibold uppercase tracking-wider text-slate-500">
        <span>
          {pagination.total}{' '}
          {pagination.total === 1 ? 'job available' : 'jobs available'}
        </span>
        {pagination.totalPages > 1 && (
          <span>
            Page {pagination.page} of {pagination.totalPages}
          </span>
        )}
      </div>

      {/* Loading Skeleton */}
      {isLoading && (
        <div className="space-y-3" role="status" aria-label="Loading jobs">
          {[1, 2, 3].map((i) => (
            <div
              key={i}
              className="animate-pulse rounded-xl border border-slate-200 bg-white p-5 space-y-3"
            >
              <div className="h-5 w-1/3 rounded-sm bg-slate-200" />
              <div className="h-4 w-1/4 rounded-sm bg-slate-100" />
              <div className="h-3 w-1/2 rounded-sm bg-slate-100" />
            </div>
          ))}
        </div>
      )}

      {/* Error State */}
      {!isLoading && fetchError && (
        <div className="rounded-xl border border-rose-200 bg-rose-50/50 p-8 text-center space-y-3">
          <p className="text-sm font-semibold text-rose-800">{fetchError}</p>
          <button
            type="button"
            onClick={() => loadJobs(pagination.page, filters)}
            className="rounded-lg bg-rose-600 px-4 py-1.5 text-xs font-semibold text-white hover:bg-rose-700"
          >
            Retry
          </button>
        </div>
      )}

      {/* Empty State: No jobs in database */}
      {!isLoading &&
        !fetchError &&
        pagination.total === 0 &&
        !filters.search &&
        !filters.location &&
        filters.platform === 'all' &&
        filters.remote === 'any' &&
        filters.status === 'ALL' && (
          <div className="rounded-xl border border-slate-200 bg-white p-12 text-center space-y-4">
            <div className="mx-auto flex h-12 w-12 items-center justify-center rounded-full bg-indigo-50 text-indigo-600">
              <svg
                className="h-6 w-6"
                fill="none"
                viewBox="0 0 24 24"
                stroke="currentColor"
              >
                <path
                  strokeLinecap="round"
                  strokeLinejoin="round"
                  strokeWidth="2"
                  d="M19 11H5m14 0a2 2 0 012 2v6a2 2 0 01-2 2H5a2 2 0 01-2-2v-6a2 2 0 012-2m14 0V9a2 2 0 00-2-2M5 11V9a2 2 0 012-2m0 0V5a2 2 0 012-2h6a2 2 0 012 2v2M7 7h10"
                />
              </svg>
            </div>
            <div className="space-y-1">
              <h3 className="text-base font-semibold text-slate-900">
                No jobs found
              </h3>
              <p className="text-xs text-slate-500 max-w-sm mx-auto">
                Sync jobs from CareerLift to discover normalized listings and
                begin applying.
              </p>
            </div>
            <button
              type="button"
              onClick={handleSync}
              disabled={isSyncing}
              className="rounded-lg bg-indigo-600 px-4 py-2 text-xs font-semibold text-white shadow-xs hover:bg-indigo-700"
            >
              {isSyncing ? 'Syncing...' : 'Discover jobs'}
            </button>
          </div>
        )}

      {/* Empty State: No matching filter results */}
      {!isLoading &&
        !fetchError &&
        pagination.total === 0 &&
        (filters.search ||
          filters.platform !== 'all' ||
          filters.remote !== 'any' ||
          filters.status !== 'ALL' ||
          filters.location) && (
          <div className="rounded-xl border border-slate-200 bg-white p-10 text-center space-y-3">
            <h3 className="text-base font-semibold text-slate-900">
              No jobs match your search
            </h3>
            <p className="text-xs text-slate-500">
              Try adjusting your search keywords or clearing active filters.
            </p>
            <button
              type="button"
              onClick={handleResetFilters}
              className="rounded-lg border border-slate-300 px-4 py-1.5 text-xs font-semibold text-slate-700 hover:bg-slate-50"
            >
              Clear filters
            </button>
          </div>
        )}

      {/* Jobs List */}
      {!isLoading && !fetchError && jobs.length > 0 && (
        <div className="space-y-3">
          {jobs.map((job) => (
            <JobCard
              key={job.id}
              job={job}
              onApplicationStarted={() => {
                // Refresh list on status update
                loadJobs(pagination.page, filters);
              }}
            />
          ))}
        </div>
      )}

      {/* Pagination Controls */}
      {pagination.totalPages > 1 && (
        <div className="flex items-center justify-between border-t border-slate-200 pt-4">
          <button
            type="button"
            disabled={isLoading || pagination.page <= 1}
            onClick={() => handlePageChange(pagination.page - 1)}
            className="rounded-lg border border-slate-300 px-3 py-1.5 text-xs font-semibold text-slate-700 hover:bg-slate-50 disabled:opacity-40 transition-colors"
          >
            Previous
          </button>

          <span className="text-xs text-slate-500">
            Page {pagination.page} of {pagination.totalPages}
          </span>

          <button
            type="button"
            disabled={isLoading || pagination.page >= pagination.totalPages}
            onClick={() => handlePageChange(pagination.page + 1)}
            className="rounded-lg border border-slate-300 px-3 py-1.5 text-xs font-semibold text-slate-700 hover:bg-slate-50 disabled:opacity-40 transition-colors"
          >
            Next
          </button>
        </div>
      )}
    </section>
  );
}
