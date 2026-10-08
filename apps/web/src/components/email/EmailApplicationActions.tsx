'use client';
import React, { useEffect, useState } from 'react';
import Link from 'next/link';
import type { EmailMessageView, EmailAnswerStage } from '@careerlift/domain';
import type { ApplicationDetail } from '@/lib/types';
import { request, downloadDocument } from '@/lib/api';
import {
  useCandidateRead,
  Feedback,
  Field,
  input,
  panel,
  button,
  primary,
  message,
} from '../candidate/CandidateUI';
import type { EmailSettingsData } from './EmailSettings';

type EmailApplicationData = {
  recipient: string;
  description: string | null;
  requireResume: boolean;
  documents: Array<{
    id: string;
    name: string;
    type: string;
    size: number;
    isDefault: boolean;
    jobTitles: string[];
  }>;
  resumeRecommendation: {
    id: string;
    name: string;
    score: number;
    reason: string;
  } | null;
  suggestion: { subject: string; body: string };
  message: EmailMessageView | null;
  answerPipelineConfigured?: boolean;
  answerStage?: EmailAnswerStage | null;
};
const isActive = (value: EmailApplicationData) =>
  ['QUEUED', 'SENDING'].includes(value.message?.state ?? '');
function EmailAnswerReview({
  stage,
  questionId,
  path,
  token,
  onSaved,
}: {
  stage: EmailAnswerStage;
  questionId: string;
  path: string;
  token: string;
  onSaved: (stage: EmailAnswerStage) => void;
}) {
  const question = stage.questions.find((item) => item.id === questionId)!;
  const answer = stage.answers.find((item) => item.id === questionId)!;
  const [value, setValue] = useState(answer.answer ?? '');
  const [confirmed, setConfirmed] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  return (
    <form
      className="space-y-3 rounded-lg border border-amber-200 p-4"
      onSubmit={(event) => {
        event.preventDefault();
        if (!confirmed || busy) return;
        setBusy(true);
        setError(null);
        request<{ stage: EmailAnswerStage }>(
          `${path}/answers/review`,
          {
            method: 'POST',
            body: JSON.stringify({
              stageId: stage.id,
              questionId,
              value,
              userConfirmed: true,
            }),
          },
          token,
        )
          .then((result) => onSaved(result.stage))
          .catch((failure) => setError(message(failure)))
          .finally(() => setBusy(false));
      }}
    >
      <h3 className="font-semibold">{question.question}</h3>
      <p className="text-sm text-amber-800">{answer.reason}</p>
      <p className="text-xs text-slate-500">
        Gemini confidence: {Math.round(answer.confidence * 100)}%
      </p>
      <Field label="Your answer">
        <textarea
          className={input}
          required
          rows={3}
          value={value}
          disabled={busy}
          onChange={(event) => {
            setValue(event.target.value);
            setConfirmed(false);
          }}
        />
      </Field>
      <label className="flex gap-2 text-sm">
        <input
          type="checkbox"
          required
          checked={confirmed}
          disabled={busy}
          onChange={(event) => setConfirmed(event.target.checked)}
        />
        I confirm this answer and save it to Verified Answers.
      </label>
      <Feedback error={error} />
      <button className={primary} disabled={busy || !confirmed}>
        Save verified answer
      </button>
    </form>
  );
}
export function EmailApplicationActions({
  application,
  token,
  refresh,
}: {
  application: ApplicationDetail;
  token: string;
  refresh: () => void;
}) {
  if (application.plan?.applicationType !== 'EMAIL') return null;
  return (
    <EmailApplicationLoader
      key={application.id}
      application={application}
      token={token}
      refresh={refresh}
    />
  );
}
function EmailApplicationLoader({
  application,
  token,
  refresh,
}: {
  application: ApplicationDetail;
  token: string;
  refresh: () => void;
}) {
  const query = useCandidateRead<EmailApplicationData>(
    `/api/v1/email/applications/${encodeURIComponent(application.id)}`,
    token,
    isActive,
  );
  const settings = useCandidateRead<EmailSettingsData>(
    '/api/v1/email/settings',
    token,
  );
  if (!query.data)
    return (
      <section className={panel}>
        <h2 className="font-bold">Prepare application email</h2>
        <Feedback error={query.error} />
        <p className="mt-2 text-sm">Loading email details…</p>
        <button className={`${button} mt-3`} onClick={query.refresh}>
          Refresh email
        </button>
      </section>
    );
  return (
    <EmailComposer
      key={`${query.data.message?.id ?? 'new'}-${query.data.message?.revision ?? 0}`}
      data={query.data}
      application={application}
      settings={settings.data}
      token={token}
      refresh={() => {
        query.refresh();
        settings.refresh();
        refresh();
      }}
    />
  );
}
function EmailComposer({
  data,
  application,
  settings,
  token,
  refresh,
}: {
  data: EmailApplicationData;
  application: ApplicationDetail;
  settings: EmailSettingsData | null;
  token: string;
  refresh: () => void;
}) {
  const saved = data.message;
  const [subject, setSubject] = useState(
      saved?.subject ?? data.suggestion.subject,
    ),
    [body, setBody] = useState(saved?.body ?? data.suggestion.body);
  const [selected, setSelected] = useState<string[]>(
    saved?.attachments.map((a) => a.id) ??
      (data.resumeRecommendation ? [data.resumeRecommendation.id] : []),
  );
  const [confirmed, setConfirmed] = useState(false),
    [busy, setBusy] = useState(false),
    [error, setError] = useState<string | null>(null),
    [success, setSuccess] = useState<string | null>(null),
    [warnings, setWarnings] = useState<string[]>([]);
  const locked =
    !!saved && ['QUEUED', 'SENDING', 'SENT', 'UNKNOWN'].includes(saved.state);
  const dirty =
    !saved ||
    saved.subject !== subject ||
    saved.body !== body ||
    JSON.stringify(saved.attachments.map((a) => a.id).sort()) !==
      JSON.stringify([...selected].sort());
  const canPrepare =
    !application.humanReviewRequired &&
    ['RESOLVED', 'READY'].includes(application.state);
  const path = `/api/v1/email/applications/${encodeURIComponent(application.id)}`;
  const act = async (action: () => Promise<void>) => {
    setBusy(true);
    setError(null);
    setSuccess(null);
    try {
      await action();
    } catch (e) {
      setError(message(e));
    } finally {
      setBusy(false);
    }
  };
  const selectedResume = data.documents.find(
    (doc) => doc.type === 'RESUME' && selected.includes(doc.id),
  );
  const [answerStage, setAnswerStage] = useState<EmailAnswerStage | null>(
    data.answerStage ?? null,
  );
  const [checkingAnswers, setCheckingAnswers] = useState(false);
  const resumeId = selectedResume?.id ?? null;
  useEffect(() => {
    if (!data.answerPipelineConfigured || locked || !canPrepare) return;
    let active = true;
    setCheckingAnswers(true);
    setAnswerStage(null);
    request<{ stage: EmailAnswerStage | null }>(
      `${path}/answers`,
      { method: 'POST', body: JSON.stringify({ resumeId }) },
      token,
    )
      .then((result) => {
        if (active) setAnswerStage(result.stage);
      })
      .catch((failure) => {
        if (active) setError(message(failure));
      })
      .finally(() => {
        if (active) setCheckingAnswers(false);
      });
    return () => {
      active = false;
    };
  }, [
    data.answerPipelineConfigured,
    locked,
    canPrepare,
    path,
    resumeId,
    token,
  ]);
  const answersNeedReview = !!answerStage?.answers.some(
    (answer) => answer.requiresHumanReview,
  );
  return (
    <section
      className={`${panel} space-y-4`}
      aria-labelledby="email-composer-heading"
    >
      <div className="flex flex-wrap items-center justify-between gap-3">
        <h2 id="email-composer-heading" className="text-lg font-bold">
          Application email
        </h2>
        <Link className={button} href="/email">
          Gmail connection
        </Link>
      </div>
      <dl className="grid gap-3 text-sm sm:grid-cols-2">
        <div>
          <dt className="text-slate-500">From</dt>
          <dd>
            {saved?.from ??
              settings?.account?.address ??
              'Connect Gmail to send'}
          </dd>
        </div>
        <div>
          <dt className="text-slate-500">To</dt>
          <dd className="break-all">{data.recipient}</dd>
        </div>
      </dl>
      {saved?.state === 'SENT' && (
        <p className="rounded-lg bg-emerald-50 p-4 text-sm" role="status">
          Application email sent
          {saved.sentAt ? ` on ${new Date(saved.sentAt).toLocaleString()}` : ''}
          . Gmail accepted the message; employer receipt and acceptance are not
          verified.
        </p>
      )}
      {saved?.state === 'UNKNOWN' && (
        <p className="rounded-lg bg-amber-50 p-4 text-sm" role="status">
          The send outcome is unknown. Check Gmail’s Sent folder before taking
          any further action. CareerLift will not automatically send this
          application again.
        </p>
      )}
      {saved && ['QUEUED', 'SENDING'].includes(saved.state) && (
        <p className="rounded-lg bg-indigo-50 p-3 text-sm" role="status">
          {saved.state === 'QUEUED'
            ? 'Email queued. Waiting for the worker.'
            : 'Sending application email…'}
        </p>
      )}
      {saved?.state === 'FAILED' && (
        <p className="rounded-lg bg-rose-50 p-3 text-sm">
          The email was not sent. Review the details, save a fresh draft, and
          approve it again. {saved.errorCode}
        </p>
      )}
      {!canPrepare && !locked && (
        <p className="rounded-lg bg-amber-50 p-3 text-sm">
          This application needs review before email preparation can continue.
        </p>
      )}
      <Feedback error={error} success={locked ? null : success} busy={busy} />
      {checkingAnswers && (
        <p role="status" className="text-sm text-slate-600">
          Checking requested application answers with Gemini…
        </p>
      )}
      {!locked && answerStage && (
        <div className="space-y-3">
          <p className="text-sm text-slate-600">
            {
              answerStage.answers.filter(
                (answer) => !answer.requiresHumanReview,
              ).length
            }{' '}
            application answers ready.
          </p>
          {answerStage.questions
            .filter(
              (question) =>
                answerStage.answers.find((answer) => answer.id === question.id)
                  ?.requiresHumanReview,
            )
            .map((question) => (
              <EmailAnswerReview
                key={`${answerStage.id}-${question.id}`}
                stage={answerStage}
                questionId={question.id}
                path={path}
                token={token}
                onSaved={(stage) => {
                  setAnswerStage(stage);
                  setConfirmed(false);
                  setSuccess(
                    'Answer saved to Verified Answers. Save the draft to include it.',
                  );
                }}
              />
            ))}
        </div>
      )}
      <fieldset className="space-y-4" disabled={busy || locked || !canPrepare}>
        <Field label="Subject">
          <input
            className={input}
            value={subject}
            maxLength={250}
            onChange={(e) => {
              setSubject(e.target.value);
              setConfirmed(false);
            }}
          />
        </Field>
        <Field label="Email body">
          <textarea
            className={input}
            rows={12}
            value={body}
            maxLength={20000}
            onChange={(e) => {
              setBody(e.target.value);
              setConfirmed(false);
            }}
          />
        </Field>
        <div className="space-y-2">
          <h3 className="font-semibold text-sm">Attachments</h3>
          {data.resumeRecommendation && (
            <p className="text-sm text-slate-600">
              Suggested resume: {data.resumeRecommendation.name}.{' '}
              {data.resumeRecommendation.reason}.
            </p>
          )}
          {!data.documents.length && (
            <p className="text-sm text-slate-500">
              Upload resumes and add their target job titles in Documents.
            </p>
          )}
          {data.documents.map((doc) => (
            <label
              key={doc.id}
              className="flex items-start gap-2 rounded-lg border border-slate-200 p-3 text-sm"
            >
              <input
                type="checkbox"
                checked={selected.includes(doc.id)}
                onChange={(e) => {
                  setConfirmed(false);
                  setSelected((current) =>
                    e.target.checked
                      ? [
                          ...(doc.type === 'RESUME'
                            ? current.filter(
                                (id) =>
                                  data.documents.find((d) => d.id === id)
                                    ?.type !== 'RESUME',
                              )
                            : current),
                          doc.id,
                        ]
                      : current.filter((id) => id !== doc.id),
                  );
                }}
              />
              <span>
                {doc.name}{' '}
                <span className="text-slate-500">
                  ({(doc.size / 1024).toFixed(1)} KB)
                </span>
                {doc.jobTitles.length > 0 && (
                  <span className="block text-xs text-slate-500">
                    {doc.jobTitles.join(', ')}
                  </span>
                )}
              </span>
            </label>
          ))}
        </div>
      </fieldset>
      <div className="flex flex-wrap gap-3">
        <Link className={button} href="/documents">
          Manage resumes
        </Link>
        <Link className={button} href="/profile">
          Edit template and profile
        </Link>
        {selectedResume && (
          <button
            className={button}
            disabled={busy}
            onClick={() =>
              void act(async () => {
                const blob = await downloadDocument(selectedResume.id, token);
                const url = URL.createObjectURL(blob);
                const link = document.createElement('a');
                link.href = url;
                link.download = selectedResume.name;
                link.click();
                setTimeout(() => URL.revokeObjectURL(url), 1000);
              })
            }
          >
            Download selected resume
          </button>
        )}
      </div>
      {!locked && canPrepare && (
        <>
          <p className="text-xs text-slate-500">
            Gemini uses your saved profile, selected resume text, and job
            instructions to prepare requested answers and your email. Review its
            draft for accuracy before saving.
          </p>
          <button
            className={button}
            disabled={busy || !settings?.personalizationConfigured}
            onClick={() =>
              void act(async () => {
                const result = await request<{
                  subject: string;
                  body: string;
                  warnings: string[];
                  answerStage?: EmailAnswerStage | null;
                }>(
                  `${path}/personalize`,
                  {
                    method: 'POST',
                    body: JSON.stringify({
                      profileSharingConfirmed: true,
                      resumeId: selectedResume?.id ?? null,
                    }),
                  },
                  token,
                  65000,
                );
                setSubject(result.subject);
                setBody(result.body);
                setWarnings(result.warnings);
                if (result.answerStage) setAnswerStage(result.answerStage);
                setConfirmed(false);
                setSuccess(
                  'Personalized draft ready. Review and save it before sending.',
                );
              })
            }
          >
            Personalize with Gemini
          </button>
          {!settings?.personalizationConfigured && (
            <p className="text-xs text-slate-500">
              Configure GEMINI_API_KEY to enable personalization.
            </p>
          )}
          {warnings.map((warning, index) => (
            <p className="rounded-lg bg-amber-50 p-3 text-sm" key={index}>
              {warning}
            </p>
          ))}
          <button
            className={`${primary} block`}
            disabled={
              busy ||
              !settings?.account?.connected ||
              !subject.trim() ||
              !body.trim() ||
              selected.length > 5
            }
            onClick={() =>
              void act(async () => {
                await request(
                  path,
                  {
                    method: 'PUT',
                    body: JSON.stringify({
                      revision: saved?.revision ?? 0,
                      subject,
                      body,
                      documentIds: selected,
                    }),
                  },
                  token,
                );
                setConfirmed(false);
                setSuccess(
                  'Draft saved. Check the message and attachments, then approve sending.',
                );
                refresh();
              })
            }
          >
            Save draft for review
          </button>
          {!settings?.account?.connected && (
            <p className="text-sm text-slate-500">
              Connect Gmail to save a draft with its sender address.
            </p>
          )}
          {saved?.state === 'DRAFT' && (
            <div className="space-y-3 rounded-lg border border-indigo-200 bg-indigo-50/50 p-4">
              <label className="flex gap-2 text-sm">
                <input
                  type="checkbox"
                  checked={confirmed}
                  disabled={dirty || busy}
                  onChange={(e) => setConfirmed(e.target.checked)}
                />
                I reviewed the saved recipient, subject, email body, and
                attachments and approve sending this application.
              </label>
              {dirty && (
                <p className="text-xs text-slate-600">
                  Save your changes before approving the email.
                </p>
              )}
              <button
                className={primary}
                disabled={
                  busy ||
                  checkingAnswers ||
                  answersNeedReview ||
                  (data.answerPipelineConfigured && !answerStage) ||
                  dirty ||
                  !confirmed ||
                  !settings?.sendingEnabled ||
                  (data.requireResume && !selectedResume)
                }
                onClick={() =>
                  void act(async () => {
                    await request(
                      `${path}/send`,
                      {
                        method: 'POST',
                        body: JSON.stringify({
                          revision: saved.revision,
                          userConfirmed: true,
                        }),
                      },
                      token,
                    );
                    setConfirmed(false);
                    setSuccess('Application email queued.');
                    refresh();
                  })
                }
              >
                Approve and send application email
              </button>
              {data.requireResume && !selectedResume && (
                <p className="text-sm text-amber-800">
                  Select a resume and save the draft before sending.
                </p>
              )}
            </div>
          )}
        </>
      )}
      {saved?.state === 'QUEUED' && (
        <button
          className={button}
          disabled={busy}
          onClick={() =>
            void act(async () => {
              await request(
                `${path}/cancel`,
                {
                  method: 'POST',
                  body: JSON.stringify({
                    revision: saved.revision,
                    userConfirmed: true,
                  }),
                },
                token,
              );
              refresh();
            })
          }
        >
          Cancel queued email
        </button>
      )}
      <button className={button} disabled={busy} onClick={refresh}>
        Refresh email status
      </button>
      {data.description && (
        <details className="text-sm">
          <summary className="cursor-pointer text-indigo-700">
            View job description and email instructions
          </summary>
          <p className="mt-3 whitespace-pre-wrap text-slate-600">
            {data.description}
          </p>
        </details>
      )}
    </section>
  );
}
