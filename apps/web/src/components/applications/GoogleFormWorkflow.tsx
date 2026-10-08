'use client';
import React, { useCallback, useEffect, useState } from 'react';
import Link from 'next/link';
import {
  GoogleFormViewSchema,
  type GoogleFormView,
  type GoogleFormValue,
} from '@careerlift/domain';
import { request } from '@/lib/api';
import { useAuth } from '@/lib/auth-context';
import { button, panel } from './WorkspaceUI';
import { GoogleFormSubmissionFlag } from './GoogleFormSubmissionFlag';
import { AnswerReviewCard, answerReviewInput } from './AnswerReviewCard';

const errorMessage = (error: unknown) =>
  error instanceof Error
    ? error.message
    : 'The request failed. Refresh and try again.';

export function GoogleFormSessionPanel() {
  const { token } = useAuth();
  const [session, setSession] = useState<{
    enabled: boolean;
    expectedAccount: string;
    state: string;
    issue: string | null;
  } | null>(null);
  const [busy, setBusy] = useState(false),
    [error, setError] = useState<string | null>(null);
  const refresh = useCallback(async () => {
    if (!token) return;
    try {
      setSession(await request('/api/v1/google-forms/session', {}, token));
      setError(null);
    } catch (failure) {
      setError(errorMessage(failure));
    }
  }, [token]);
  useEffect(() => {
    void refresh();
  }, [refresh]);
  useEffect(() => {
    if (session?.state !== 'CONNECTING') return;
    const timer = setInterval(() => {
      void refresh();
    }, 5000);
    return () => clearInterval(timer);
  }, [session?.state, refresh]);
  async function act(action: 'connect' | 'confirm' | 'disconnect') {
    if (!token) return;
    setBusy(true);
    setError(null);
    try {
      await request(
        '/api/v1/google-forms/session',
        { method: 'POST', body: JSON.stringify({ action }) },
        token,
      );
      await refresh();
    } catch (failure) {
      setError(errorMessage(failure));
    } finally {
      setBusy(false);
    }
  }
  return (
    <section className={panel}>
      <h2 className="font-bold">Google Forms account</h2>
      <p className="mt-2 text-sm">
        {session?.expectedAccount ?? 'guptaaniket600.ag@gmail.com'} ·{' '}
        {session?.state.toLowerCase().replaceAll('_', ' ') ?? 'loading'}
      </p>
      <p className="mt-2 text-sm text-slate-600">
        Public forms can run without sign-in. For forms requiring your Google
        account or uploads, sign in yourself in the dedicated browser. Your
        retained session is encrypted for your Windows account.
      </p>
      {session && !session.enabled && (
        <p className="mt-2 text-sm">
          Google Forms automation is disabled in the local configuration.
        </p>
      )}
      {session?.state === 'CONNECTING' && (
        <p className="mt-2 text-sm">
          Finish signing in in the browser window, then confirm below. If Google
          refuses the sign-in, leave the form paused and inspect the browser
          message.
        </p>
      )}
      {(error || session?.issue) && (
        <p role="alert" className="mt-2 text-sm text-red-700">
          {error || session?.issue}
        </p>
      )}
      <div className="mt-3 flex flex-wrap gap-3">
        <button
          className={button}
          disabled={
            !token ||
            !session?.enabled ||
            busy ||
            (session.state === 'CONNECTING' && !session.issue)
          }
          onClick={() => {
            void act('connect');
          }}
        >
          {session?.state === 'CONNECTED'
            ? 'Reconnect Google account'
            : session?.state === 'CONNECTING' && session.issue
              ? 'Restart Google sign-in'
              : 'Connect Google account'}
        </button>
        {session?.state === 'CONNECTING' && (
          <button
            className={button}
            disabled={busy}
            onClick={() => {
              void act('confirm');
            }}
          >
            I have signed in — confirm account
          </button>
        )}
        {session && session.state !== 'DISCONNECTED' && (
          <button
            className={button}
            disabled={busy}
            onClick={() => {
              void act('disconnect');
            }}
          >
            Forget retained session
          </button>
        )}
      </div>
    </section>
  );
}

export function GoogleFormReviewInbox({ token }: { token: string }) {
  const [page, setPage] = useState(1);
  const [result, setResult] = useState<{
    reviews: {
      applicationId: string;
      job: { title: string; company: string };
      run: { state: string; issue: string | null };
    }[];
    hasMore: boolean;
  } | null>(null);
  const [error, setError] = useState<string | null>(null);
  const refresh = useCallback(async () => {
    try {
      setResult(
        await request(`/api/v1/google-forms/reviews?page=${page}`, {}, token),
      );
      setError(null);
    } catch (failure) {
      setError(errorMessage(failure));
    }
  }, [token, page]);
  useEffect(() => {
    void refresh();
  }, [refresh]);
  if (!result?.reviews.length && !error) return null;
  return (
    <section className={panel}>
      <div className="flex items-center justify-between gap-3">
        <h2 className="font-bold">Google Forms reviews</h2>
        <button
          className={button}
          onClick={() => {
            void refresh();
          }}
        >
          Refresh Forms reviews
        </button>
      </div>
      {error && (
        <p role="alert" className="mt-2 text-sm text-red-700">
          {error}
        </p>
      )}
      {result?.reviews.map((review) => (
        <div
          key={review.applicationId}
          className="mt-4 rounded-lg border border-amber-200 p-4"
        >
          <h3 className="font-semibold">
            {review.job.title} · {review.job.company}
          </h3>
          <p className="mt-1 text-sm">
            {review.run.issue ??
              'Review the required answers for this application.'}
          </p>
          <Link
            className={`${button} mt-3`}
            href={`/applications/${encodeURIComponent(review.applicationId)}#google-form-workflow`}
          >
            Open Google Forms workflow
          </Link>
        </div>
      ))}
      {(page > 1 || result?.hasMore) && (
        <div className="mt-4 flex gap-3">
          <button
            className={button}
            disabled={page === 1}
            onClick={() => setPage((p) => p - 1)}
          >
            Previous
          </button>
          <span className="py-2 text-sm">Page {page}</span>
          <button
            className={button}
            disabled={!result?.hasMore}
            onClick={() => setPage((p) => p + 1)}
          >
            Next
          </button>
        </div>
      )}
    </section>
  );
}

function FormQuestionReview({
  item,
  documents,
  busy,
  onSave,
}: {
  item: GoogleFormView['reviews'][number];
  documents: GoogleFormView['documents'];
  busy: boolean;
  onSave: (id: string, value: GoogleFormValue) => Promise<void>;
}) {
  const question = item.question;
  const [value, setValue] = useState<GoogleFormValue>(
    item.answer.documentId ??
      item.answer.value ??
      (question.kind === 'CHECKBOX' ? [] : ''),
  );
  const fieldId = `google-answer-${question.id.replace(/[^a-zA-Z0-9_-]/g, '-')}`;
  return (
    <AnswerReviewCard
      fieldId={fieldId}
      question={question.label}
      required={question.required}
      reason={item.answer.review}
      confidence={item.answer.confidence ?? null}
      source={item.answer.value !== null ? item.answer.source : null}
    >
      {question.kind === 'FILE' ? (
        <select
          id={fieldId}
          className={answerReviewInput}
          value={typeof value === 'string' ? value : ''}
          onChange={(event) => setValue(event.target.value)}
        >
          <option value="">Select a document</option>
          {documents
            .filter((d) => d.type === question.documentType)
            .map((d) => (
              <option key={d.id} value={d.id}>
                {d.name}
              </option>
            ))}
        </select>
      ) : question.kind === 'CHECKBOX' ? (
        <fieldset id={fieldId} className="mt-3 space-y-2">
          <legend className="sr-only">{question.label}</legend>
          {question.options.map((option) => (
            <label key={option} className="flex items-start gap-2 text-sm">
              <input
                type="checkbox"
                checked={Array.isArray(value) && value.includes(option)}
                onChange={(event) =>
                  setValue(
                    event.target.checked
                      ? [...(Array.isArray(value) ? value : []), option]
                      : (Array.isArray(value) ? value : []).filter(
                          (v) => v !== option,
                        ),
                  )
                }
              />
              {option}
            </label>
          ))}
        </fieldset>
      ) : question.options.length ? (
        <select
          id={fieldId}
          className={answerReviewInput}
          value={typeof value === 'string' ? value : ''}
          onChange={(event) => setValue(event.target.value)}
        >
          <option value="">Select an answer</option>
          {question.options.map((option) => (
            <option key={option} value={option}>
              {option}
            </option>
          ))}
        </select>
      ) : question.kind === 'PARAGRAPH' ? (
        <textarea
          id={fieldId}
          className={answerReviewInput}
          rows={4}
          value={typeof value === 'string' ? value : ''}
          maxLength={question.maxLength}
          onChange={(event) => setValue(event.target.value)}
        />
      ) : (
        <input
          id={fieldId}
          className={answerReviewInput}
          type={
            question.kind === 'DATE'
              ? 'date'
              : question.kind === 'TIME'
                ? 'time'
                : question.kind === 'DATETIME'
                  ? 'datetime-local'
                  : question.kind === 'NUMBER'
                    ? 'number'
                    : 'text'
          }
          value={typeof value === 'string' ? value : ''}
          maxLength={question.maxLength}
          onChange={(event) => setValue(event.target.value)}
          disabled={question.kind === 'UNSUPPORTED'}
        />
      )}
      <div className="mt-3 flex flex-wrap gap-3">
        <button
          className={button}
          disabled={busy || question.kind === 'UNSUPPORTED'}
          onClick={() => {
            void onSave(question.id, value);
          }}
        >
          Confirm answer
        </button>
        {!question.required && question.kind !== 'UNSUPPORTED' && (
          <button
            className={button}
            disabled={busy}
            onClick={() => {
              void onSave(question.id, null);
            }}
          >
            Skip optional question
          </button>
        )}
        {question.kind === 'FILE' && (
          <Link className={`${button}`} href="/documents">
            Manage documents
          </Link>
        )}
      </div>
    </AnswerReviewCard>
  );
}
export function GoogleFormWorkflow({
  applicationId,
  token,
  refreshApplication,
}: {
  applicationId: string;
  token: string;
  refreshApplication: () => void;
}) {
  const [view, setView] = useState<GoogleFormView | null>(null),
    [busy, setBusy] = useState(false),
    [error, setError] = useState<string | null>(null);
  const refresh = useCallback(async () => {
    try {
      setView(
        GoogleFormViewSchema.parse(
          await request(
            `/api/v1/applications/${encodeURIComponent(applicationId)}/google-form`,
            {},
            token,
          ),
        ),
      );
    } catch (failure) {
      setError(errorMessage(failure));
    }
  }, [applicationId, token]);
  useEffect(() => {
    void refresh();
  }, [refresh]);
  useEffect(() => {
    if (
      !view?.run ||
      !['PENDING', 'RUNNING', 'SUBMITTING'].includes(view.run.state)
    )
      return;
    const timer = setInterval(() => {
      void refresh();
      refreshApplication();
    }, 5000);
    return () => clearInterval(timer);
  }, [view?.run?.state, refresh, refreshApplication]);
  async function command(
    operation: 'start' | 'resume' | 'review',
    data: object = {},
  ) {
    setBusy(true);
    setError(null);
    try {
      await request(
        `/api/v1/applications/${encodeURIComponent(applicationId)}/google-form/${operation}`,
        { method: 'POST', body: JSON.stringify(data) },
        token,
      );
      await refresh();
      refreshApplication();
    } catch (failure) {
      setError(errorMessage(failure));
    } finally {
      setBusy(false);
    }
  }
  const run = view?.run;
  return (
    <section
      id="google-form-workflow"
      className={panel}
      aria-labelledby="google-form-heading"
    >
      <h2 id="google-form-heading" className="font-bold">
        Google Forms application
      </h2>
      {view && <GoogleFormSubmissionFlag run={run ?? null} />}
      <p className="mt-2 text-sm">
        This application submits automatically after required information,
        document checks, and all reviews pass. Supported answers that meet the
        confidence threshold are used automatically; other answers need review.
      </p>
      <p className="mt-2 text-sm">
        <Link className="text-indigo-700 underline" href="/settings">
          Connect or manage your Google Forms account
        </Link>
      </p>
      <p className="mt-2 text-sm text-slate-600">
        Keep your{' '}
        <Link className="text-indigo-700 underline" href="/profile">
          Profile
        </Link>
        ,{' '}
        <Link className="text-indigo-700 underline" href="/verified-answers">
          Verified Answers
        </Link>
        , and{' '}
        <Link className="text-indigo-700 underline" href="/documents">
          Documents
        </Link>{' '}
        current before starting.
      </p>
      {run && (
        <p role="status" className="mt-3 text-sm font-medium">
          {run.state.toLowerCase().replaceAll('_', ' ')} · section{' '}
          {run.page + 1}
          {run.test ? ' · local test form' : ''}
        </p>
      )}
      {run?.issue && <p className="mt-2 text-sm text-amber-800">{run.issue}</p>}
      {error && (
        <p role="alert" className="mt-2 text-sm text-red-700">
          {error}
        </p>
      )}
      {view && !view.enabled && (
        <p className="mt-2 text-sm">
          Google Forms automation is disabled. Enable it in the local
          configuration to use this workflow.
        </p>
      )}
      {view?.enabled && (!run || ['BLOCKED', 'FAILED'].includes(run.state)) && (
        <button
          className={`${button} mt-3`}
          disabled={busy}
          onClick={() => {
            void command('start');
          }}
        >
          {run
            ? 'Re-inspect and restart Google Form'
            : 'Start Google Forms application'}
        </button>
      )}
      {run?.state === 'BROWSER_REQUIRED' && (
        <div className="mt-3">
          <p className="mb-3 text-sm">
            Complete the requested action in the visible browser window, then
            continue. The worker must remain running.
          </p>
          <button
            className={button}
            disabled={busy}
            onClick={() => {
              void command('resume', { version: run.version });
            }}
          >
            I have completed the browser action — continue
          </button>
        </div>
      )}
      {run?.state === 'UNKNOWN' && (
        <p className="mt-3 text-sm">
          No retry or restart is available because a submission may already
          exist. Inspect the employer form manually.
        </p>
      )}
      {run?.state === 'SUBMITTED' && (
        <p className="mt-3 text-sm">
          {run.test
            ? 'The controlled test form recorded confirmation. This is not an employer submission.'
            : 'Google Forms displayed its response confirmation after the recorded submission.'}
        </p>
      )}
      {run?.state === 'REVIEW' &&
        view?.reviews.map((item) => (
          <FormQuestionReview
            key={`${run.version}-${item.question.id}`}
            item={item}
            documents={view.documents}
            busy={busy}
            onSave={async (id, value) => {
              await command('review', {
                version: run.version,
                questionId: id,
                value,
                userConfirmed: true,
              });
            }}
          />
        ))}
      <button
        className={`${button} mt-4`}
        disabled={busy}
        onClick={() => {
          void refresh();
          refreshApplication();
        }}
      >
        Refresh Google Forms status
      </button>
    </section>
  );
}
