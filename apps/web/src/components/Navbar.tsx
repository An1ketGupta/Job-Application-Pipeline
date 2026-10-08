'use client';
import React, { useEffect, useRef, useState } from 'react';
import Link from 'next/link';
import { usePathname } from 'next/navigation';
import { useAuth } from '@/lib/auth-context';
const links = [
  ['/', 'Home'],
  ['/jobs', 'Jobs'],
  ['/applications', 'Applications'],
  ['/profile', 'Profile'],
  ['/documents', 'Documents'],
  ['/email', 'Email'],
  ['/verified-answers', 'Verified Answers'],
  ['/review', 'Human Review'],
] as const;
export function Navbar() {
  const pathname = usePathname();
  const { user, login, logout, isLoading, error } = useAuth();
  const [open, setOpen] = useState(false);
  const [email, setEmail] = useState('');
  const dialog = useRef<HTMLDialogElement>(null);
  useEffect(() => {
    if (open) dialog.current?.showModal();
    else dialog.current?.close();
  }, [open]);
  return (
    <header className="mb-8 border-b border-slate-200 pb-4">
      <div className="flex flex-wrap items-center justify-between gap-4">
        <Link href="/" className="text-xl font-bold tracking-tight">
          CareerLift Agent
        </Link>
        <div className="flex min-w-0 max-w-full flex-wrap items-center gap-3 text-sm">
          {isLoading ? (
            <span role="status">Checking account...</span>
          ) : user ? (
            <>
              <span className="max-w-full break-all rounded-full bg-slate-100 px-3 py-1 text-xs">
                {user.email}
              </span>
              <button
                type="button"
                className="text-indigo-700 underline"
                onClick={() => setOpen(true)}
              >
                Switch
              </button>
              <button
                type="button"
                className="text-slate-700 underline"
                onClick={logout}
              >
                Log out
              </button>
            </>
          ) : (
            <button
              type="button"
              className="rounded-lg bg-indigo-600 px-4 py-2 font-semibold text-white"
              onClick={() => setOpen(true)}
            >
              Log in
            </button>
          )}
        </div>
      </div>
      <nav
        aria-label="Main navigation"
        className="mt-4 flex flex-wrap gap-x-5 gap-y-3 text-sm font-medium"
      >
        {links.map(([href, label]) => {
          const active =
            pathname === href ||
            (href !== '/' && pathname.startsWith(`${href}/`));
          return (
            <Link
              key={href}
              href={href}
              aria-current={active ? 'page' : undefined}
              className={
                active
                  ? 'border-b-2 border-indigo-600 text-indigo-700'
                  : 'text-slate-600 hover:text-slate-900'
              }
            >
              {label}
            </Link>
          );
        })}
      </nav>
      <p className="mt-3 text-xs text-slate-600">
        Local development - Email identifies a local account; no email
        verification is performed.
      </p>
      {error && !open && (
        <p role="alert" className="mt-3 text-sm text-rose-800">
          {error}
        </p>
      )}
      <dialog
        ref={dialog}
        aria-labelledby="account-heading"
        aria-describedby="account-description"
        onClose={() => setOpen(false)}
        onCancel={(e) => {
          if (isLoading) e.preventDefault();
        }}
        className="m-auto w-[calc(100%-2rem)] max-w-sm rounded-xl bg-white p-5 text-slate-900 shadow-xl backdrop:bg-black/40"
      >
        <h2 id="account-heading" className="text-lg font-bold">
          {user ? 'Switch local account' : 'Log in to CareerLift'}
        </h2>
        <p id="account-description" className="mt-2 text-sm text-slate-600">
          Enter your email to open or create a local development account.
        </p>
        {error && (
          <p role="alert" className="mt-3 text-sm text-rose-800">
            {error}
          </p>
        )}
        <form
          className="mt-4 space-y-4"
          onSubmit={async (e) => {
            e.preventDefault();
            if (isLoading) return;
            try {
              await login(email.trim());
              setOpen(false);
              setEmail('');
            } catch {
              /* Auth feedback stays visible. */
            }
          }}
        >
          <label className="block text-sm font-medium" htmlFor="user-email">
            User Email
          </label>
          <input
            id="user-email"
            autoFocus
            type="email"
            autoComplete="email"
            required
            maxLength={300}
            disabled={isLoading}
            value={email}
            onChange={(e) => setEmail(e.target.value)}
            className="block w-full rounded-lg border border-slate-300 px-3 py-2"
          />
          <div className="flex flex-wrap justify-end gap-3">
            <button
              type="button"
              disabled={isLoading}
              onClick={() => setOpen(false)}
              className="rounded-lg border border-slate-300 px-4 py-2"
            >
              Cancel
            </button>
            <button
              type="submit"
              disabled={isLoading}
              className="rounded-lg bg-indigo-600 px-4 py-2 font-semibold text-white disabled:opacity-50"
            >
              {isLoading ? 'Logging in...' : 'Log in with email'}
            </button>
          </div>
        </form>
      </dialog>
    </header>
  );
}
