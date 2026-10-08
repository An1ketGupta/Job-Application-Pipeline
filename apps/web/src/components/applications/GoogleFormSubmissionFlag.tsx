import React from 'react';
import type { GoogleFormView } from '@careerlift/domain';

export function GoogleFormSubmissionFlag({
  run,
  compact = false,
}: {
  run: GoogleFormView['run'];
  compact?: boolean;
}) {
  const submitted = run?.state === 'SUBMITTED' && !run.test;
  const uncertain =
    !run?.test && (run?.state === 'UNKNOWN' || run?.state === 'SUBMITTING');
  const label = submitted
    ? 'Submitted'
    : uncertain
      ? 'Unconfirmed'
      : 'Not submitted';
  const colors = submitted
    ? 'border-emerald-200 bg-emerald-50 text-emerald-800'
    : uncertain
      ? 'border-amber-200 bg-amber-50 text-amber-900'
      : 'border-slate-200 bg-slate-50 text-slate-700';
  return (
    <div className="mt-3">
      <p role="status">
        <span className="mr-2 text-sm">Submission:</span>
        <span
          data-testid="google-form-submission-flag"
          className={`inline-flex rounded-full border px-3 py-1 text-sm font-semibold ${colors}`}
        >
          {label}
        </span>
      </p>
      {!compact && (
        <p className="mt-1 text-sm text-slate-600">
          {submitted
            ? 'Google confirmed that your response was recorded.'
            : uncertain
              ? run?.state === 'SUBMITTING'
                ? 'Waiting for Google to confirm your response.'
                : 'Google acceptance could not be verified. A duplicate submission is blocked.'
              : run?.test
                ? 'This is a test run; no employer application was submitted.'
                : 'This application has not been submitted.'}
        </p>
      )}
    </div>
  );
}
