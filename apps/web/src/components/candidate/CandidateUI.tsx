'use client';
import React, { useCallback, useId } from 'react';
import { useAuth } from '@/lib/auth-context';
import { request } from '@/lib/api';
import { useWorkspaceQuery } from '@/lib/use-workspace-query';
export { panel, button } from '../applications/WorkspaceUI';
export const input =
  'mt-1 block w-full rounded-lg border border-slate-300 bg-white px-3 py-2 text-sm text-slate-900 disabled:bg-slate-100';
export const primary =
  'rounded-lg bg-indigo-600 px-4 py-2 text-sm font-semibold text-white hover:bg-indigo-700 disabled:opacity-50';
export function CandidateGate({
  children,
}: {
  children: (token: string) => React.ReactNode;
}) {
  const { token, user, isLoading } = useAuth();
  if (isLoading) return <p role="status">Loading your account…</p>;
  if (!token)
    return <p role="alert">Log in to manage your candidate information.</p>;
  return <div key={user?.id}>{children(token)}</div>;
}
const idle = () => false;
export function useCandidateRead<T>(
  path: string,
  token: string,
  active: (value: T) => boolean = idle,
) {
  const read = useCallback(
    (signal: AbortSignal) =>
      request<T>(path, { signal, cache: 'no-store' }, token),
    [path, token],
  );
  return useWorkspaceQuery(read, active, true, `${token}|${path}`);
}
export function Feedback({
  error,
  success,
  busy,
}: {
  error?: string | null;
  success?: string | null;
  busy?: boolean;
}) {
  return (
    <div aria-live="polite">
      {error && (
        <p
          role="alert"
          className="rounded-lg border border-rose-200 bg-rose-50 p-3 text-sm text-rose-800"
        >
          {error}
        </p>
      )}
      {busy && (
        <p role="status" className="text-sm text-slate-500">
          Saving…
        </p>
      )}
      {success && (
        <p
          role="status"
          className="rounded-lg bg-emerald-50 p-3 text-sm text-emerald-800"
        >
          {success}
        </p>
      )}
    </div>
  );
}
export const message = (error: unknown) =>
  error instanceof Error ? error.message : 'Unable to save. Try again.';
export function Field({
  label,
  children,
}: {
  label: string;
  children: React.ReactElement<{ id?: string }>;
}) {
  const id = useId();
  return (
    <div>
      <label htmlFor={id} className="block text-sm font-medium text-slate-700">
        {label}
      </label>
      {React.cloneElement(children, { id })}
    </div>
  );
}
