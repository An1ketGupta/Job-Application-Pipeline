'use client';
import React, { useEffect, useState } from 'react';
import { request } from '@/lib/api';
import { panel, button, message } from './CandidateUI';
type Preview = {
  version: number;
  answers: { label: string; value: string }[];
  documents: { label: string; name: string }[];
};
export function SubmissionPreview({
  applicationId,
  token,
}: {
  applicationId: string;
  token: string;
}) {
  const [preview, setPreview] = useState<Preview | null>(null),
    [error, setError] = useState<string | null>(null),
    [copied, setCopied] = useState(false);
  useEffect(() => {
    let active = true;
    void request<Preview>(
      `/api/v1/applications/${encodeURIComponent(applicationId)}/submission-preview`,
      { cache: 'no-store' },
      token,
    )
      .then((p) => {
        if (active) setPreview(p);
      })
      .catch((e) => {
        if (active) setError(message(e));
      });
    return () => {
      active = false;
    };
  }, [applicationId, token]);
  return (
    <details className={panel}>
      <summary className="font-bold cursor-pointer">
        Prepared answers and documents
      </summary>
      {error ? (
        <p className="mt-3 text-red-700" role="alert">
          {error}
        </p>
      ) : !preview ? (
        <p className="mt-3">Loading prepared answers…</p>
      ) : (
        <>
          <dl className="mt-4 space-y-4">
            {preview.answers.map((a, i) => (
              <div key={i}>
                <dt className="text-sm text-slate-500">{a.label}</dt>
                <dd className="mt-1 whitespace-pre-wrap break-words">
                  {a.value}
                </dd>
              </div>
            ))}
          </dl>
          {preview.documents.length > 0 && (
            <div className="mt-5">
              <h3 className="font-semibold">Selected documents</h3>
              <ul className="mt-2">
                {preview.documents.map((d, i) => (
                  <li key={i}>
                    {d.label}: {d.name}
                  </li>
                ))}
              </ul>
            </div>
          )}
          <button
            className={`${button} mt-4`}
            onClick={() =>
              void navigator.clipboard
                .writeText(
                  preview.answers
                    .map((a) => `${a.label}\n${a.value}`)
                    .join('\n\n'),
                )
                .then(() => setCopied(true))
                .catch(() =>
                  setError(
                    'Could not copy. Select the answers above to copy them manually.',
                  ),
                )
            }
          >
            {copied ? 'Answers copied' : 'Copy prepared answers'}
          </button>
        </>
      )}
    </details>
  );
}
