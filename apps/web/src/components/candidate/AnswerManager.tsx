'use client';
import React, { useState } from 'react';
import Link from 'next/link';
import { request } from '@/lib/api';
import type { CandidateAnswer } from '@/lib/candidate-types';
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

function AnswerEditor({ token }: { token: string }) {
  const query = useCandidateRead<{ answers: CandidateAnswer[] }>(
    '/api/v1/verified-answers',
    token,
  );
  const [editing, setEditing] = useState<CandidateAnswer | null>(null),
    [question, setQuestion] = useState(''),
    [value, setValue] = useState(''),
    [confirmed, setConfirmed] = useState(false);
  const [busy, setBusy] = useState(false),
    [error, setError] = useState<string | null>(null),
    [success, setSuccess] = useState<string | null>(null);
  async function act(action: () => Promise<unknown>, feedback: string) {
    if (busy) return;
    setBusy(true);
    setError(null);
    setSuccess(null);
    try {
      await action();
      query.refresh();
      setSuccess(feedback);
    } catch (e) {
      setError(message(e));
    } finally {
      setBusy(false);
    }
  }
  function reset() {
    setEditing(null);
    setQuestion('');
    setValue('');
    setConfirmed(false);
  }
  return (
    <article className="space-y-5">
      <div className="flex flex-wrap justify-between gap-3">
        <div>
          <h1 className="text-2xl font-bold">Verified answers</h1>
          <p className="mt-1 text-sm text-slate-500">
            Answers you explicitly authorize for recurring application
            questions.
          </p>
        </div>
        <Link className={button} href="/profile">
          Back to Profile
        </Link>
      </div>
      <Feedback error={error || query.error} success={success} busy={busy} />
      <form
        className={`${panel} space-y-4`}
        onSubmit={(e) => {
          e.preventDefault();
          void act(async () => {
            await request(
              `/api/v1/verified-answers${editing ? `/${encodeURIComponent(editing.id)}` : ''}`,
              {
                method: editing ? 'PATCH' : 'POST',
                body: JSON.stringify({
                  ...(editing
                    ? { revision: editing.revision, active: true }
                    : {}),
                  question,
                  value,
                  userConfirmed: confirmed,
                }),
              },
              token,
            );
            reset();
          }, 'Your verified answer was saved.');
        }}
      >
        <h2 className="font-bold">
          {editing ? 'Edit verified answer' : 'Add verified answer'}
        </h2>
        <fieldset className="space-y-4" disabled={busy}>
          <Field label="Question">
            <textarea
              className={input}
              required
              minLength={3}
              maxLength={1000}
              rows={2}
              value={question}
              placeholder="Will you require sponsorship?"
              onChange={(e) => {
                setQuestion(e.target.value);
                setConfirmed(false);
              }}
            />
          </Field>
          <Field label="Your answer">
            <textarea
              className={input}
              required
              maxLength={10000}
              rows={3}
              value={value}
              onChange={(e) => {
                setValue(e.target.value);
                setConfirmed(false);
              }}
            />
          </Field>
          <label className="flex items-start gap-2 text-sm">
            <input
              type="checkbox"
              className="mt-1"
              required
              checked={confirmed}
              onChange={(e) => setConfirmed(e.target.checked)}
            />
            <span>
              I confirm this answer is accurate and authorize its use for this
              exact question.
            </span>
          </label>
        </fieldset>
        <p className="text-xs text-slate-500">
          Work authorization, sponsorship, salary, relocation, demographic, and
          legal answers require your explicit control. Different wording or
          conflicting answers can require another review.
        </p>
        <div className="flex gap-2">
          <button className={primary} disabled={busy || !confirmed}>
            {editing ? 'Save verified answer' : 'Create verified answer'}
          </button>
          {editing && (
            <button type="button" className={button} onClick={reset}>
              Cancel edit
            </button>
          )}
        </div>
      </form>
      <button
        className={button}
        disabled={busy || query.busy}
        onClick={query.refresh}
      >
        Refresh answers
      </button>
      {!query.data && !query.error && (
        <p role="status">Loading verified answers…</p>
      )}
      {query.data && !query.data.answers.length && (
        <section className={panel}>
          <p>
            No verified answers yet. Add a question and confirm your answer
            above.
          </p>
        </section>
      )}
      <div className="space-y-4">
        {query.data?.answers.map((answer) => (
          <section className={panel} key={answer.id}>
            <div className="flex flex-wrap justify-between gap-3">
              <h2 className="font-bold">{answer.question}</h2>
              <span
                className={`text-xs font-semibold ${answer.active && answer.verified ? 'text-emerald-700' : 'text-slate-500'}`}
              >
                {answer.active
                  ? answer.verified
                    ? 'User verified · Active'
                    : 'Unverified'
                  : 'Inactive'}
              </span>
            </div>
            <p className="mt-3 whitespace-pre-wrap text-sm">{answer.value}</p>
            {answer.verified && (
              <p className="mt-2 text-xs text-emerald-700">
                This answer has been explicitly verified by you.
              </p>
            )}
            <p className="mt-3 text-xs text-slate-500">
              {answer.category.replaceAll('_', ' ')} · Updated{' '}
              {new Date(answer.updatedAt).toLocaleString()}
            </p>
            <div className="mt-4 flex flex-wrap gap-2">
              <button
                className={button}
                disabled={busy}
                onClick={() => {
                  setEditing(answer);
                  setQuestion(answer.question);
                  setValue(answer.value);
                  setConfirmed(false);
                  window.scrollTo({ top: 0, behavior: 'instant' });
                }}
              >
                {answer.active ? 'Edit answer' : 'Review and reactivate'}
              </button>
              {answer.active && (
                <button
                  className={button}
                  disabled={busy}
                  onClick={() =>
                    void act(
                      () =>
                        request(
                          `/api/v1/verified-answers/${encodeURIComponent(answer.id)}`,
                          {
                            method: 'PATCH',
                            body: JSON.stringify({
                              revision: answer.revision,
                              active: false,
                            }),
                          },
                          token,
                        ),
                      'Answer deactivated. It will not be used for future preparation.',
                    )
                  }
                >
                  Deactivate
                </button>
              )}
            </div>
          </section>
        ))}
      </div>
    </article>
  );
}
export function AnswerManager() {
  return (
    <CandidateGate>{(token) => <AnswerEditor token={token} />}</CandidateGate>
  );
}
