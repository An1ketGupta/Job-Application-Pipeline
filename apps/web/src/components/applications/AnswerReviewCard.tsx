import React from 'react';

export const answerReviewInput =
  'mt-3 w-full rounded border border-slate-300 p-2';

export function AnswerReviewCard({
  fieldId,
  question,
  required,
  reason,
  confidence,
  source,
  children,
}: {
  fieldId: string;
  question: string;
  required?: boolean;
  reason: string | null;
  confidence?: number | null;
  source?: string | null;
  children: React.ReactNode;
}) {
  return (
    <div className="mt-4 rounded-lg border border-slate-200 p-4">
      <label htmlFor={fieldId} className="font-medium">
        {question}
        {required === true ? ' *' : required === false ? ' (optional)' : ''}
      </label>
      <p className="mt-1 text-sm text-amber-800">{reason}</p>
      {confidence != null && (
        <p className="mt-1 text-xs text-slate-500">
          Gemini confidence: {Math.round(confidence * 100)}%
        </p>
      )}
      {source && (
        <p className="mt-1 text-xs text-slate-500">
          Proposed answer from {source.toLowerCase().replaceAll('_', ' ')}
        </p>
      )}
      {children}
    </div>
  );
}
