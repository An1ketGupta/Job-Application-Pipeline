'use client';
import React, { useCallback, useEffect, useState } from 'react';
import { useRouter, useSearchParams } from 'next/navigation';
import {
  ApplicationStateSchema,
  VerificationStateSchema,
} from '@careerlift/domain';
import type { ApplicationsResponse } from '@/lib/types';
import { fetchApplications } from '@/lib/api';
import { useAuth } from '@/lib/auth-context';
import { useWorkspaceQuery } from '@/lib/use-workspace-query';
import { applicationLabels, stateLabel } from '@/lib/application-presentation';
import {
  ApplicationCard,
  ApplicationsEmpty,
  WorkspaceError,
  WorkspaceLoading,
  LiveStatus,
  button,
} from './WorkspaceUI';

const active = (value: ApplicationsResponse) =>
  value.applications.some((app) => app.active);
export function ApplicationsDashboard() {
  const { token, isLoading: authLoading } = useAuth();
  const router = useRouter();
  const searchParams = useSearchParams();
  const querySearch = searchParams.get('search') || '';
  const status =
    ApplicationStateSchema.safeParse(searchParams.get('status')).data || '';
  const verification =
    VerificationStateSchema.safeParse(searchParams.get('verification')).data ||
    '';
  const review = searchParams.get('review') === 'true' ? 'true' : '';
  const rawSort = searchParams.get('sort');
  const sort =
    rawSort === 'newest' || rawSort === 'oldest' ? rawSort : 'updated';
  const rawPage = Number(searchParams.get('page'));
  const page = Number.isInteger(rawPage)
    ? Math.min(100000, Math.max(1, rawPage))
    : 1;
  const [search, setSearch] = useState(querySearch);
  const [reviewChecked, setReviewChecked] = useState(!!review);
  useEffect(() => setReviewChecked(!!review), [review]);
  useEffect(() => setSearch(querySearch), [querySearch]);
  const update = useCallback(
    (values: Record<string, string>, resetPage = true) => {
      const query = new URLSearchParams(searchParams.toString());
      for (const [key, value] of Object.entries(values))
        if (value) query.set(key, value);
        else query.delete(key);
      if (resetPage) query.delete('page');
      router.replace(`/applications${query.size ? `?${query}` : ''}`, {
        scroll: false,
      });
    },
    [router, searchParams],
  );
  useEffect(() => {
    if (search === querySearch) return;
    const timer = setTimeout(() => update({ search: search.trim() }), 300);
    return () => clearTimeout(timer);
  }, [search, querySearch, update]);
  const read = useCallback(
    (signal: AbortSignal) =>
      fetchApplications(
        {
          search: querySearch,
          status,
          verification,
          review,
          sort,
          page,
          limit: 10,
        },
        token!,
        signal,
      ),
    [token, querySearch, status, verification, review, sort, page],
  );
  const identity = `${token}|${querySearch}|${status}|${verification}|${review}|${sort}|${page}`;
  const query = useWorkspaceQuery(
    read,
    active,
    !!token && !authLoading,
    identity,
  );
  const reset = () => {
    setSearch('');
    setReviewChecked(false);
    router.replace('/applications', { scroll: false });
  };
  const filtered = !!(querySearch || status || verification || review);
  return (
    <section className="space-y-5">
      <header className="flex flex-wrap items-center justify-between gap-3">
        <div>
          <h1 className="text-2xl font-bold">Applications</h1>
          <p className="mt-1 text-sm text-slate-500">
            Follow the agent’s work and see where your input is needed.
          </p>
        </div>
        <button
          type="button"
          className={button}
          disabled={query.busy || !token || authLoading}
          onClick={query.refresh}
        >
          Refresh
        </button>
      </header>
      <div className="rounded-xl border border-slate-200 bg-white p-4 space-y-4">
        <div>
          <label
            htmlFor="application-search"
            className="block text-xs font-semibold text-slate-600"
          >
            Search applications
          </label>
          <div className="mt-1 flex gap-2">
            <input
              id="application-search"
              type="search"
              maxLength={200}
              placeholder="Job title, company, or location"
              value={search}
              onChange={(e) => setSearch(e.target.value)}
              className="w-full rounded-lg border border-slate-300 px-3 py-2 text-sm"
            />
            {search && (
              <button
                type="button"
                className={button}
                onClick={() => {
                  setSearch('');
                  update({ search: '' });
                }}
              >
                Clear search
              </button>
            )}
          </div>
        </div>
        <div className="grid gap-3 sm:grid-cols-3">
          <label className="text-xs font-semibold text-slate-600">
            Application state
            <select
              aria-label="Application state"
              className="mt-1 block w-full rounded-lg border border-slate-300 p-2 text-sm"
              value={status}
              onChange={(e) => update({ status: e.target.value })}
            >
              <option value="">All application states</option>
              {ApplicationStateSchema.options.map((s) => (
                <option key={s} value={s}>
                  {applicationLabels[s]}
                </option>
              ))}
            </select>
          </label>
          <label className="text-xs font-semibold text-slate-600">
            Verification state
            <select
              aria-label="Verification state"
              className="mt-1 block w-full rounded-lg border border-slate-300 p-2 text-sm"
              value={verification}
              onChange={(e) => update({ verification: e.target.value })}
            >
              <option value="">All verification states</option>
              {VerificationStateSchema.options.map((s) => (
                <option key={s} value={s}>
                  {stateLabel(s)}
                </option>
              ))}
            </select>
          </label>
          <label className="text-xs font-semibold text-slate-600">
            Sort applications
            <select
              aria-label="Sort applications"
              className="mt-1 block w-full rounded-lg border border-slate-300 p-2 text-sm"
              value={sort}
              onChange={(e) => update({ sort: e.target.value })}
            >
              <option value="updated">Recently updated</option>
              <option value="newest">Newest</option>
              <option value="oldest">Oldest</option>
            </select>
          </label>
        </div>
        <div className="flex flex-wrap items-center justify-between gap-3">
          <label className="flex items-center gap-2 text-sm">
            <input
              type="checkbox"
              checked={reviewChecked}
              onChange={(e) => {
                setReviewChecked(e.target.checked);
                update({ review: e.target.checked ? 'true' : '' });
              }}
            />
            Needs human review
          </label>
          <button
            type="button"
            className="text-sm font-semibold text-indigo-600"
            onClick={reset}
          >
            Clear filters
          </button>
        </div>
      </div>
      {authLoading ? (
        <WorkspaceLoading />
      ) : !token ? (
        <WorkspaceError
          message="Log in to view your applications."
          refresh={query.refresh}
        />
      ) : (
        <>
          <LiveStatus
            busy={query.busy}
            stopped={query.stopped}
            active={!!query.data?.applications.some((a) => a.active)}
          />
          {query.error && (
            <WorkspaceError message={query.error} refresh={query.refresh} />
          )}
          {!query.data && !query.error ? (
            <WorkspaceLoading />
          ) : (
            query.data && (
              <div aria-busy={query.busy}>
                {query.data.applications.length ? (
                  <div className="space-y-4">
                    {query.data.applications.map((app) => (
                      <ApplicationCard key={app.id} application={app} />
                    ))}
                  </div>
                ) : (
                  <ApplicationsEmpty
                    filtered={filtered || page > 1}
                    reset={reset}
                  />
                )}
                <nav
                  aria-label="Application pagination"
                  className="mt-5 flex flex-wrap items-center justify-between gap-3"
                >
                  <p className="text-sm text-slate-500">
                    {query.data.applications.length
                      ? `Applications ${(page - 1) * 10 + 1}–${Math.min(page * 10, query.data.pagination.total)} of ${query.data.pagination.total}`
                      : `${query.data.pagination.total} applications`}{' '}
                    · Page {page} of {query.data.pagination.totalPages}
                  </p>
                  <div className="flex gap-2">
                    <button
                      type="button"
                      className={button}
                      disabled={page <= 1 || query.busy}
                      onClick={() => update({ page: String(page - 1) }, false)}
                    >
                      Previous
                    </button>
                    <button
                      type="button"
                      className={button}
                      disabled={
                        page >= query.data.pagination.totalPages || query.busy
                      }
                      onClick={() => update({ page: String(page + 1) }, false)}
                    >
                      Next
                    </button>
                  </div>
                </nav>
              </div>
            )
          )}
        </>
      )}
    </section>
  );
}
