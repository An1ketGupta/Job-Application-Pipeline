'use client';
import React from 'react';
import Link from 'next/link';
export default function WorkspaceError({ reset }: { reset: () => void }) {
  return (
    <section
      role="alert"
      className="rounded-xl border border-rose-200 bg-rose-50 p-6"
    >
      <h1 className="text-xl font-bold">
        This page is temporarily unavailable
      </h1>
      <p className="mt-3">Refresh the page or return to your workspace.</p>
      <div className="mt-4 flex flex-wrap gap-3">
        <button
          className="rounded-lg border border-slate-300 bg-white px-4 py-2"
          onClick={reset}
        >
          Retry page
        </button>
        <Link
          className="rounded-lg border border-slate-300 bg-white px-4 py-2"
          href="/"
        >
          Return to Home
        </Link>
      </div>
    </section>
  );
}
