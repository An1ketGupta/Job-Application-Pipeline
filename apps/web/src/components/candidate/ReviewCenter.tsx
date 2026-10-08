'use client';
import React, { useId, useRef, useState } from 'react';
import Link from 'next/link';
import { selectedChoiceLabels } from '@careerlift/domain';
import { ReviewAnswerInput } from './ReviewAnswerInput';
import { request } from '@/lib/api';
import { GoogleFormReviewInbox } from '../applications/GoogleFormWorkflow';
import {
  AnswerReviewCard,
  answerReviewInput,
} from '../applications/AnswerReviewCard';
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
  panel,
  button,
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
            review.canStartPreparation
              ? `/api/v1/applications/${encodeURIComponent(review.applicationId)}/prepare`
              : `/api/v1/human-review/${encodeURIComponent(review.applicationId)}/recheck`,
            {
              method: 'POST',
              ...(!review.canStartPreparation
                ? {
                    body: JSON.stringify({
                      version: review.version,
                      key: attempt.current,
                    }),
                  }
                : {}),
            },
            token,
          )
            .then(onSaved)
            .catch((failure) => setError(message(failure)))
            .finally(() => setBusy(false));
        }}
      >
        {busy
          ? 'Checking answers…'
          : review.canStartPreparation
            ? 'Prepare answers'
            : 'Recheck with Gemini'}
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
  const fieldId = useId();
  const [value, setValue] = useState(item.proposedAnswer ?? ''),
    [documentId, setDocumentId] = useState('');
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
    if (!item.actions.includes(action)) return;
    if (
      action === 'ANSWER' &&
      item.multiple &&
      item.required !== false &&
      !selectedChoiceLabels(value)?.length
    ) {
      setError('Select at least one answer.');
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
    <AnswerReviewCard
      fieldId={fieldId}
      question={item.question}
      {...(item.required !== undefined ? { required: item.required } : {})}
      reason={item.reason}
      confidence={item.confidence ?? null}
      source={item.proposedAnswer !== null ? item.source : null}
    >
      {!!item.actions.length && (
        <form
          onSubmit={(e) => {
            e.preventDefault();
            void act(
              item.documentType
                ? 'SELECT_DOCUMENT'
                : value === item.proposedAnswer &&
                    item.actions.includes('CONFIRM')
                  ? 'CONFIRM'
                  : 'ANSWER',
            );
          }}
        >
          <fieldset disabled={busy}>
            {item.description && (
              <p className="mb-3 text-sm text-slate-600">{item.description}</p>
            )}
            {item.documentType ? (
              <>
                <select
                  id={fieldId}
                  className={answerReviewInput}
                  required
                  value={documentId}
                  onChange={(e) => setDocumentId(e.target.value)}
                >
                  <option value="">Select a document</option>
                  {matching.map((d) => (
                    <option key={d.id} value={d.id}>
                      {d.name}
                      {d.isDefault ? ' (default)' : ''}
                    </option>
                  ))}
                </select>
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
              <>
                <ReviewAnswerInput
                  item={item}
                  id={fieldId}
                  value={value}
                  onChange={setValue}
                />
              </>
            )}
          </fieldset>
          <div className="mt-3 flex flex-wrap gap-3">
            {(item.actions.includes('ANSWER') ||
              item.actions.includes('CONFIRM') ||
              item.actions.includes('SELECT_DOCUMENT')) && (
              <button className={button} type="submit" disabled={busy}>
                Confirm answer
              </button>
            )}
            {item.actions.includes('REJECT') && (
              <button
                className={button}
                type="button"
                disabled={busy}
                onClick={() => void act('REJECT')}
              >
                Reject proposed answer
              </button>
            )}
            {item.documentType && (
              <Link className={button} href="/documents">
                Manage documents
              </Link>
            )}
          </div>
        </form>
      )}
      {!item.actions.length && item.proposedAnswer !== null && (
        <p className="mt-3 whitespace-pre-wrap text-sm">
          {item.proposedAnswer}
        </p>
      )}
      {!item.actions.length && (
        <p className="mt-3 text-xs text-slate-500">
          This item is waiting for preparation or another application gate.
          Refresh for current actions.
        </p>
      )}
      <Feedback error={error} success={success} busy={busy} />
    </AnswerReviewCard>
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
          {(review.canStartPreparation || review.canRecheckWithAi) && (
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
            Confirmed answers are saved to Verified Answers for reuse. Resolving
            candidate information re-runs preparation. Submission requires the
            existing execution and security checks.
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
