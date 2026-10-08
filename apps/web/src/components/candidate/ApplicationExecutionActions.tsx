'use client';
import React, { useState } from 'react';
import { request } from '@/lib/api';
import type { ApplicationDetail } from '@/lib/types';
import { Feedback, button, panel, message } from './CandidateUI';
import { SubmissionPreview } from './SubmissionPreview';

export function ApplicationExecutionActions({
  application: app,
  token,
  refresh,
}: {
  application: ApplicationDetail;
  token: string;
  refresh: () => void;
}) {
  const [busy, setBusy] = useState(false);
  const [confirmed, setConfirmed] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [success, setSuccess] = useState<string | null>(null);
  const modes = app.executionModes ?? [];
  const assisted = !!app.executionReadiness?.browserAssisted;
  const provider = app.plan?.platform === 'GREENHOUSE' ? 'Greenhouse' : 'Ashby';
  const canResume =
    assisted && app.execution?.state === 'PAUSED_HUMAN_REQUIRED';
  const verification = app.execution?.verification;
  const canCheck =
    app.execution &&
    app.execution.mode !== 'DRY_RUN' &&
    ['SUBMISSION_UNKNOWN', 'SUBMITTED'].includes(app.execution.state) &&
    !['PENDING', 'VERIFYING', 'CONFIRMED', 'REJECTED'].includes(
      verification?.state ?? '',
    );
  const canDecide = verification?.state === 'HUMAN_REQUIRED';
  async function act(
    operation:
      | 'DRY_RUN'
      | 'TEST_FIXTURE'
      | 'REAL_EXECUTION'
      | 'resume'
      | 'check'
      | 'confirm'
      | 'reject',
  ) {
    if (
      busy ||
      (['REAL_EXECUTION', 'TEST_FIXTURE', 'confirm', 'reject'].includes(
        operation,
      ) &&
        !confirmed)
    )
      return;
    setBusy(true);
    setError(null);
    setSuccess(null);
    try {
      if (
        operation === 'DRY_RUN' ||
        operation === 'TEST_FIXTURE' ||
        operation === 'REAL_EXECUTION'
      ) {
        await request(
          `/api/v1/applications/${encodeURIComponent(app.id)}/execute`,
          {
            method: 'POST',
            body: JSON.stringify({ mode: operation }),
          },
          token,
        );
        setSuccess(
          `${operation} requested. The worker will check the application before execution.`,
        );
      } else if (operation === 'resume') {
        const execution = await request<{ executionId: string }>(
          `/api/v1/applications/${encodeURIComponent(app.id)}/execution?mode=${app.execution!.mode}`,
          { cache: 'no-store' },
          token,
        );
        await request(
          `/api/v1/applications/${encodeURIComponent(app.id)}/execution/resume`,
          {
            method: 'POST',
            body: JSON.stringify({ executionId: execution.executionId }),
          },
          token,
        );
        setSuccess(
          'Continuation requested. The worker will check verification before submitting.',
        );
      } else {
        const execution = await request<{ executionId: string }>(
          `/api/v1/applications/${encodeURIComponent(app.id)}/execution?mode=${app.execution!.mode}`,
          { cache: 'no-store' },
          token,
        );
        await request(
          `/api/v1/executions/${encodeURIComponent(execution.executionId)}/verification/${operation}`,
          {
            method: 'POST',
            body: JSON.stringify(
              operation === 'confirm'
                ? { confirmed: true }
                : operation === 'reject'
                  ? { rejected: true }
                  : {},
            ),
          },
          token,
        );
        setSuccess(
          operation === 'check'
            ? 'Independent verification requested. No application will be submitted again.'
            : 'Your explicit submission decision was recorded.',
        );
      }
      setConfirmed(false);
      refresh();
    } catch (e) {
      setError(message(e));
    } finally {
      setBusy(false);
    }
  }
  if (app.googleForm || app.plan?.platform === 'GOOGLE_FORM') return null;
  if (
    !modes.length &&
    !canResume &&
    !canCheck &&
    !canDecide &&
    !success &&
    !error
  )
    return app.preparation?.state === 'COMPLETED' &&
      app.plan?.applicationType !== 'EMAIL' ? (
      <SubmissionPreview applicationId={app.id} token={token} />
    ) : null;
  return (
    <section className={panel} aria-label="Execution and verification controls">
      <h2 className="font-bold">
        {modes.length
          ? modes.includes('REAL_EXECUTION')
            ? assisted
              ? `${provider} browser assistance`
              : 'Submit application'
            : 'Controlled local execution'
          : canResume
            ? `Continue ${provider} application`
            : 'Resolve submission outcome'}
      </h2>
      <Feedback busy={busy} error={error} success={success} />
      {app.preparation?.state === 'COMPLETED' && (
        <div className="mt-4">
          <SubmissionPreview applicationId={app.id} token={token} />
        </div>
      )}
      {!!modes.length && (
        <>
          <p className="mt-3 text-sm text-slate-600">
            {assisted
              ? 'A dedicated browser will open on the worker’s computer and fill your prepared answers and résumé. Click the employer Submit button and complete any verification yourself, then return here and continue to submit.'
              : modes.includes('REAL_EXECUTION')
                ? `The worker will send your prepared answers and selected documents to ${app.job.company}. Check them before submitting. Each application is submitted once.`
                : 'These controls use the configured local test system. DRY_RUN submits nothing. TEST_FIXTURE can submit once after the existing safety checks pass.'}
          </p>
          {(modes.includes('TEST_FIXTURE') ||
            modes.includes('REAL_EXECUTION')) && (
            <label className="mt-4 flex items-start gap-2 text-sm">
              <input
                type="checkbox"
                checked={confirmed}
                disabled={busy}
                onChange={(e) => setConfirmed(e.target.checked)}
              />
              <span>
                {modes.includes('REAL_EXECUTION')
                  ? 'I authorize submission of this application to the employer.'
                  : 'I authorize one controlled TEST_FIXTURE submission.'}
              </span>
            </label>
          )}
          <div className="mt-4 flex flex-wrap gap-3">
            {modes.includes('REAL_EXECUTION') && (
              <button
                className={button}
                disabled={busy || !confirmed}
                onClick={() => void act('REAL_EXECUTION')}
              >
                {assisted
                  ? `Open assisted ${provider} browser`
                  : 'Submit application'}
              </button>
            )}
            {modes.includes('DRY_RUN') && (
              <button
                className={button}
                disabled={busy}
                onClick={() => void act('DRY_RUN')}
              >
                Run DRY_RUN
              </button>
            )}
            {modes.includes('TEST_FIXTURE') && (
              <button
                className={button}
                disabled={busy || !confirmed}
                onClick={() => void act('TEST_FIXTURE')}
              >
                Execute TEST_FIXTURE
              </button>
            )}
          </div>
        </>
      )}
      {canResume && (
        <div className="mt-4">
          <p className="text-sm text-slate-600">
            {app.execution?.issue ??
              'Complete verification in the open employer browser, then continue here.'}{' '}
            Continue promptly after verification. If the browser session ended,
            continuing opens a new browser and restores your prepared
            application.
          </p>
          <button
            className={`${button} mt-3`}
            disabled={busy}
            onClick={() => void act('resume')}
          >
            Continue {provider} application
          </button>
        </div>
      )}
      {canCheck && (
        <button
          className={`${button} mt-4`}
          disabled={busy}
          onClick={() => void act('check')}
        >
          Check independent verification
        </button>
      )}
      {canDecide && (
        <>
          <p className="mt-3 text-sm">
            Open the employer application system and establish the outcome
            manually. Record a decision only after checking that system.
          </p>
          <label className="mt-4 flex items-start gap-2 text-sm">
            <input
              type="checkbox"
              checked={confirmed}
              disabled={busy}
              onChange={(e) => setConfirmed(e.target.checked)}
            />
            <span>
              I independently checked the outcome and confirm my decision.
            </span>
          </label>
          <div className="mt-4 flex flex-wrap gap-3">
            <button
              className={button}
              disabled={busy || !confirmed}
              onClick={() => void act('confirm')}
            >
              Record acceptance confirmed by me
            </button>
            <button
              className={button}
              disabled={busy || !confirmed}
              onClick={() => void act('reject')}
            >
              Record rejection confirmed by me
            </button>
          </div>
        </>
      )}
    </section>
  );
}
