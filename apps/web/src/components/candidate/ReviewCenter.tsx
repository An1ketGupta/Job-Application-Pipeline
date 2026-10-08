'use client';
import React, { useRef, useState } from 'react';
import Link from 'next/link';
import { request } from '@/lib/api';
import { GoogleFormReviewInbox } from '../applications/GoogleFormWorkflow';
import type {
  CandidateDocument,
  CandidateReview,
  ReviewItem,
  ReviewResponse,
} from '@/lib/candidate-types';
import {
  CandidateGate,
  useCandidateRead,
  Feedback,
  Field,
  panel,
  button,
  primary,
  input,
  message,
} from './CandidateUI';

const active = (value: ReviewResponse) =>
  value.reviews.some((r) =>
    ['PENDING', 'RUNNING'].includes(r.preparationStatus ?? ''),
  );
function RecheckAnswers({
  review,
  token,
  onSaved,
}: {
  review: CandidateReview;
  token: string;
  onSaved: () => void;
}) {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const attempt = useRef(crypto.randomUUID());
  return (
    <div className="mt-4">
      <button
        className={button}
        disabled={busy}
        onClick={() => {
          setBusy(true);
          setError(null);
          request(
            `/api/v1/human-review/${encodeURIComponent(review.applicationId)}/recheck`,
            {
              method: 'POST',
              body: JSON.stringify({
                version: review.version,
                key: attempt.current,
              }),
            },
            token,
          )
            .then(onSaved)
            .catch((failure) => setError(message(failure)))
            .finally(() => setBusy(false));
        }}
      >
        {busy ? 'Checking with Gemini…' : 'Recheck with Gemini'}
      </button>
      <Feedback error={error} />
    </div>
  );
}
function ReviewForm({
  review,
  item,
  documents,
  token,
  onSaved,
}: {
  review: CandidateReview;
  item: ReviewItem;
  documents: CandidateDocument[];
  token: string;
  onSaved: (feedback: string) => void;
}) {
  const [value, setValue] = useState(item.proposedAnswer ?? ''),
    [documentId, setDocumentId] = useState(''),
    [confirmed, setConfirmed] = useState(false);
  const [busy, setBusy] = useState(false),
    [error, setError] = useState<string | null>(null),
    [success, setSuccess] = useState<string | null>(null);
  const attempt = useRef<{ signature: string; key: string } | null>(null);
  const matching = documents.filter(
    (d) =>
      !d.archivedAt &&
      d.type === item.documentType &&
      (!item.acceptedFileTypes.length ||
        item.acceptedFileTypes.some(
          (t) =>
            d.name.toLowerCase().endsWith(t.toLowerCase()) ||
            d.mimeType.toLowerCase() === t.toLowerCase(),
        )),
  );
  async function act(action: string) {
    if (busy) return;
    if (!confirmed) {
      setError('Confirm your decision before saving it.');
      return;
    }
    const values = {
      requirementId: item.requirementId,
      version: review.version,
      action,
      userConfirmed: true,
      ...(action === 'ANSWER'
        ? { value }
        : action === 'SELECT_DOCUMENT'
          ? { documentId }
          : {}),
    };
    const signature = JSON.stringify(values);
    if (attempt.current?.signature !== signature)
      attempt.current = { signature, key: crypto.randomUUID() };
    setBusy(true);
    setError(null);
    setSuccess(null);
    try {
      await request(
        `/api/v1/human-review/${encodeURIComponent(review.applicationId)}/${action === 'REJECT' ? 'reject' : 'resolve'}`,
        {
          method: 'POST',
          body: JSON.stringify({ ...values, key: attempt.current!.key }),
        },
        token,
      );
      setSuccess(
        action === 'REJECT'
          ? 'Proposed answer rejected. Provide a replacement to resolve this item.'
          : 'Decision saved. Preparation is checking the application again.',
      );
      onSaved(
        action === 'REJECT'
          ? 'Proposed answer rejected. Provide a replacement to resolve this item.'
          : 'Decision accepted. Application workflow resuming… The worker will recheck preparation.',
      );
    } catch (e) {
      setError(message(e));
    } finally {
      setBusy(false);
    }
  }
  return (
    <section
      className="mt-4 rounded-lg border border-slate-200 p-4"
      aria-label={item.question}
    >
      <div className="flex flex-wrap justify-between gap-2">
        <p className="text-xs font-semibold text-amber-800">
          {item.priority === 'HIGH' ? 'High priority · ' : ''}
          {item.type.replaceAll('_', ' ')}
        </p>
        <span className="text-xs text-slate-500">{item.status}</span>
      </div>
      <h3 className="mt-2 font-bold">{item.question}</h3>
      <p className="mt-2 text-sm text-slate-600">{item.reason}</p>
      <div className="mt-3 rounded-lg bg-slate-50 p-3 text-sm">
        <p className="text-xs font-semibold text-slate-500">
          Current proposed answer
        </p>
        <p className="mt-1 whitespace-pre-wrap">
          {item.proposedAnswer ?? 'Needs your input'}
        </p>
        {item.source && (
          <p className="mt-2 text-xs text-slate-500">
            Source: {item.source.replaceAll('_', ' ')}
          </p>
        )}
        {item.source === 'LLM_GENERATED' && item.confidence != null && (
          <p className="mt-2 text-xs text-slate-500">
            Gemini confidence: {Math.round(item.confidence * 100)}%
          </p>
        )}
      </div>
      <Feedback error={error} success={success} busy={busy} />
      {!!item.actions.length && (
        <form
          className="mt-4 space-y-3"
          onSubmit={(e) => {
            e.preventDefault();
            void act(item.documentType ? 'SELECT_DOCUMENT' : 'ANSWER');
          }}
        >
          <fieldset disabled={busy} className="space-y-3">
            {item.documentType ? (
              <>
                <Field label="Select document">
                  <select
                    className={input}
                    required
                    value={documentId}
                    onChange={(e) => {
                      setDocumentId(e.target.value);
                      setConfirmed(false);
                    }}
                  >
                    <option value="">
                      Choose an active{' '}
                      {item.documentType.toLowerCase().replaceAll('_', ' ')}
                    </option>
                    {matching.map((d) => (
                      <option key={d.id} value={d.id}>
                        {d.name}
                        {d.isDefault ? ' (default)' : ''}
                      </option>
                    ))}
                  </select>
                </Field>
                {!matching.length && (
                  <p className="text-sm text-slate-500">
                    No matching documents are available.{' '}
                    <Link
                      className="text-indigo-600 underline"
                      href="/documents"
                    >
                      Upload a document
                    </Link>
                    , then refresh this review.
                  </p>
                )}
              </>
            ) : (
              <Field label="Your answer">
                {item.options.length ? (
                  <select
                    className={input}
                    required
                    value={value}
                    onChange={(e) => {
                      setValue(e.target.value);
                      setConfirmed(false);
                    }}
                  >
                    <option value="">Choose an answer</option>
                    {item.options.map((o) => (
                      <option key={o} value={o}>
                        {o}
                      </option>
                    ))}
                  </select>
                ) : (
                  <textarea
                    className={input}
                    required
                    minLength={item.minLength}
                    maxLength={item.maxLength}
                    rows={3}
                    value={value}
                    onChange={(e) => {
                      setValue(e.target.value);
                      setConfirmed(false);
                    }}
                  />
                )}
              </Field>
            )}
            <label className="flex items-start gap-2 text-sm">
              <input
                type="checkbox"
                required
                checked={confirmed}
                onChange={(e) => setConfirmed(e.target.checked)}
                className="mt-1"
              />
              <span>I confirm this decision for this application.</span>
            </label>
          </fieldset>
          <div className="flex flex-wrap gap-2">
            <button className={primary} disabled={busy || !confirmed}>
              {item.documentType
                ? 'Select document and recheck'
                : 'Save answer and recheck'}
            </button>
            {item.actions.includes('CONFIRM') && (
              <button
                className={button}
                type="button"
                disabled={busy || !confirmed}
                onClick={() => void act('CONFIRM')}
              >
                Confirm proposed answer
              </button>
            )}
            {item.actions.includes('REJECT') && (
              <button
                className={button}
                type="button"
                disabled={busy || !confirmed}
                onClick={() => void act('REJECT')}
              >
                Reject proposed answer
              </button>
            )}
          </div>
          <p className="text-xs text-slate-500">
            Approved answers are saved immediately to Verified Answers for
            reuse.
          </p>
        </form>
      )}
      {!item.actions.length && (
        <p className="mt-3 text-xs text-slate-500">
          This item is waiting for preparation or another application gate.
          Refresh for current actions.
        </p>
      )}
    </section>
  );
}
function ReviewReader({
  token,
  applicationId,
}: {
  token: string;
  applicationId?: string;
}) {
  const [page, setPage] = useState(1);
  const [decisionFeedback, setDecisionFeedback] = useState<string | null>(null);
  const query = useCandidateRead<ReviewResponse>(
    `/api/v1/human-review?${applicationId ? `applicationId=${encodeURIComponent(applicationId)}&` : ''}page=${page}`,
    token,
    active,
  );
  const documents = useCandidateRead<{ documents: CandidateDocument[] }>(
    '/api/v1/documents',
    token,
  );
  const refresh = () => {
    query.refresh();
    documents.refresh();
  };
  return (
    <article className="space-y-5">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div>
          <h1 className="text-2xl font-bold">Human Review</h1>
          <p className="mt-1 text-sm text-slate-500">
            Review required information and understand what is blocking an
            application.
          </p>
        </div>
        <button
          className={button}
          disabled={query.busy || documents.busy}
          onClick={refresh}
        >
          Refresh reviews
        </button>
      </div>
      <div className="flex flex-wrap gap-3 text-sm text-indigo-600">
        <Link href="/profile">Update Profile</Link>
        <Link href="/documents">Manage Documents</Link>
        <Link href="/verified-answers">Verified Answers</Link>
        <Link href="/applications">Applications</Link>
      </div>
      <GoogleFormReviewInbox token={token} />
      <Feedback
        error={query.error || documents.error}
        success={decisionFeedback}
      />
      {!query.data && !query.error && <p role="status">Loading reviews…</p>}
      {query.data && !query.data.reviews.length && (
        <section className={panel}>
          <h2 className="font-bold">No pending reviews</h2>
          <p className="mt-2 text-sm text-slate-500">
            Your applications do not need candidate information right now.
          </p>
          {applicationId && (
            <Link
              className={`${button} mt-3`}
              href={`/applications/${encodeURIComponent(applicationId)}`}
            >
              Return to application
            </Link>
          )}
        </section>
      )}
      {query.data?.reviews.map((review) => (
        <article
          key={review.applicationId}
          className={`${panel} ${review.blocked ? 'border-amber-200' : ''}`}
        >
          <div className="flex flex-wrap justify-between gap-3">
            <div>
              <p className="text-sm text-slate-500">{review.job.company}</p>
              <h2 className="mt-1 text-lg font-bold">{review.job.title}</h2>
            </div>
            <span className="text-sm font-semibold text-amber-800">
              {review.blocked
                ? 'Action required'
                : ['PENDING', 'RUNNING'].includes(
                      review.preparationStatus ?? '',
                    )
                  ? 'Checking your information'
                  : 'Review complete'}
            </span>
          </div>
          {['PENDING', 'RUNNING'].includes(review.preparationStatus ?? '') && (
            <p className="mt-3 text-sm" role="status">
              Preparation is checking your information. This page updates
              automatically.
            </p>
          )}
          {review.preparationStatus === 'FAILED' && (
            <p className="mt-3 text-sm text-rose-800">
              Preparation stopped. Your saved decisions remain durable. Return
              to the application to retry preparation.
            </p>
          )}
          {review.canRecheckWithAi && (
            <RecheckAnswers
              key={`${review.applicationId}-${review.version}`}
              review={review}
              token={token}
              onSaved={refresh}
            />
          )}
          {review.items.map((item) => (
            <ReviewForm
              key={`${item.requirementId}-${review.version}`}
              review={review}
              item={item}
              documents={documents.data?.documents ?? []}
              token={token}
              onSaved={(feedback) => {
                setDecisionFeedback(feedback);
                query.refresh();
              }}
            />
          ))}
          {review.blockers.map((blocker, i) => (
            <section
              key={i}
              className="mt-4 rounded-lg border border-amber-200 bg-amber-50 p-4"
            >
              <h3 className="text-sm font-bold">
                {blocker.type.replaceAll('_', ' ')}
              </h3>
              <p className="mt-2 text-sm">{blocker.reason}</p>
              <p className="mt-2 text-sm text-slate-600">
                {blocker.recommendation}
              </p>
            </section>
          ))}
          {!review.items.length &&
            !review.blockers.length &&
            !['PENDING', 'RUNNING'].includes(
              review.preparationStatus ?? '',
            ) && (
              <p className="mt-3 text-sm text-emerald-700">
                Required information has been reviewed. The application is
                available for the next permitted workflow step.
              </p>
            )}
          {!!review.history.length && (
            <details className="mt-4 text-sm">
              <summary className="cursor-pointer font-semibold">
                Review history ({review.history.length})
              </summary>
              <ul className="mt-3 space-y-2">
                {review.history.map((event, i) => (
                  <li key={i}>
                    {event.action.replaceAll('_', ' ')} · {event.status} ·{' '}
                    {new Date(event.decidedAt).toLocaleString()}
                  </li>
                ))}
              </ul>
            </details>
          )}
          <div className="mt-4 flex flex-wrap gap-3">
            <Link
              className={button}
              href={`/applications/${encodeURIComponent(review.applicationId)}`}
            >
              Return to application
            </Link>
            <Link
              className={button}
              href={`/jobs/${encodeURIComponent(review.job.id)}`}
            >
              View job
            </Link>
          </div>
          <p className="mt-3 text-xs text-slate-500">
            Resolving candidate information re-runs preparation. Submission
            requires the existing execution and security checks.
          </p>
        </article>
      ))}
      {query.data && query.data.pagination.totalPages > 1 && (
        <nav className="flex items-center gap-3" aria-label="Review pages">
          <button
            className={button}
            disabled={query.busy || page <= 1}
            onClick={() => setPage(page - 1)}
          >
            Previous
          </button>
          <span className="text-sm">
            Page {page} of {query.data.pagination.totalPages}
          </span>
          <button
            className={button}
            disabled={query.busy || page >= query.data.pagination.totalPages}
            onClick={() => setPage(page + 1)}
          >
            Next
          </button>
        </nav>
      )}
    </article>
  );
}
export function ReviewCenter({ applicationId }: { applicationId?: string }) {
  return (
    <CandidateGate>
      {(token) => (
        <ReviewReader
          token={token}
          {...(applicationId ? { applicationId } : {})}
        />
      )}
    </CandidateGate>
  );
}
