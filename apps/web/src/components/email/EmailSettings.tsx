'use client';
import React, { useEffect, useRef, useState } from 'react';
import Link from 'next/link';
import {
  EmailPreferencesSchema,
  EmailConnectionFailureSchema,
  type EmailPreferences,
  type EmailMessageView,
} from '@careerlift/domain';
import { request } from '@/lib/api';
import {
  CandidateGate,
  useCandidateRead,
  Feedback,
  Field,
  input,
  panel,
  button,
  primary,
  message,
} from '../candidate/CandidateUI';

export type EmailSettingsData = {
  configured: boolean;
  sendingEnabled: boolean;
  personalizationConfigured: boolean;
  expectedSender: string | null;
  testRecipient: string;
  account: { address: string; connected: boolean; updatedAt: string } | null;
  preferences: EmailPreferences;
  testMessages: EmailMessageView[];
};
export function EmailTemplateEditor({ token }: { token: string }) {
  const query = useCandidateRead<EmailSettingsData>(
    '/api/v1/email/settings',
    token,
  );
  if (!query.data)
    return (
      <section className={panel}>
        <h2 className="font-bold">Application email template</h2>
        <Feedback error={query.error} />
        <p className="mt-2 text-sm">Loading email preferences…</p>
      </section>
    );
  return (
    <TemplateForm
      token={token}
      initial={query.data.preferences}
      refresh={query.refresh}
    />
  );
}
function TemplateForm({
  token,
  initial,
  refresh,
}: {
  token: string;
  initial: EmailPreferences;
  refresh: () => void;
}) {
  const [draft, setDraft] = useState(initial),
    [busy, setBusy] = useState(false),
    [error, setError] = useState<string | null>(null),
    [success, setSuccess] = useState<string | null>(null);
  const update = (key: keyof EmailPreferences, value: string | boolean) =>
    setDraft({ ...draft, [key]: value });
  return (
    <form
      className={`${panel} space-y-4`}
      onSubmit={async (event) => {
        event.preventDefault();
        setBusy(true);
        setError(null);
        setSuccess(null);
        try {
          const preferences = EmailPreferencesSchema.parse(draft);
          await request(
            '/api/v1/email/settings',
            { method: 'PUT', body: JSON.stringify(preferences) },
            token,
          );
          setSuccess('Email template saved.');
          refresh();
        } catch (e) {
          setError(message(e));
        } finally {
          setBusy(false);
        }
      }}
    >
      <h2 className="text-lg font-bold">Application email template</h2>
      <p className="text-sm text-slate-600">
        Gemini uses this template, your saved profile, and the job details to
        prepare an email you can edit and approve.
      </p>
      <fieldset className="space-y-4" disabled={busy}>
        <Field label="Sender display name">
          <input
            className={input}
            value={draft.senderName}
            maxLength={150}
            onChange={(e) => update('senderName', e.target.value)}
          />
        </Field>
        <Field label="Subject template">
          <input
            className={input}
            value={draft.subjectTemplate}
            required
            maxLength={250}
            onChange={(e) => update('subjectTemplate', e.target.value)}
          />
        </Field>
        <Field label="Email body template">
          <textarea
            className={input}
            rows={10}
            value={draft.bodyTemplate}
            required
            maxLength={15000}
            onChange={(e) => update('bodyTemplate', e.target.value)}
          />
        </Field>
        <Field label="Signature">
          <textarea
            className={input}
            rows={3}
            value={draft.signature}
            maxLength={2000}
            onChange={(e) => update('signature', e.target.value)}
          />
        </Field>
        <Field label="Personalization instructions">
          <textarea
            className={input}
            rows={3}
            value={draft.personalizationInstructions}
            maxLength={2000}
            onChange={(e) =>
              update('personalizationInstructions', e.target.value)
            }
          />
        </Field>
        <label className="flex gap-2 text-sm">
          <input
            type="checkbox"
            checked={draft.requireResume}
            onChange={(e) => update('requireResume', e.target.checked)}
          />
          Require a resume before sending application emails
        </label>
      </fieldset>
      <p className="text-xs text-slate-500">
        Available placeholders:{' '}
        {
          '{{jobTitle}}, {{company}}, {{fullName}}, {{profileSummary}}, {{signature}}'
        }
        . Drafts are stored in CareerLift; they are sent only after your
        approval.
      </p>
      <Feedback error={error} success={success} busy={busy} />
      <button className={primary} disabled={busy}>
        Save email template
      </button>
      <Link className={`${button} ml-3`} href="/email">
        Manage Gmail connection
      </Link>
    </form>
  );
}
const hasActiveTests = (data: EmailSettingsData) =>
  data.testMessages.some((m) => ['QUEUED', 'SENDING'].includes(m.state));
function ConnectionManager({ token }: { token: string }) {
  const query = useCandidateRead<EmailSettingsData>(
    '/api/v1/email/settings',
    token,
    hasActiveTests,
  );
  const [busy, setBusy] = useState(false),
    [error, setError] = useState<string | null>(null),
    [success, setSuccess] = useState<string | null>(null),
    [recipient, setRecipient] = useState('');
  const testKey = useRef<string | null>(null);
  const initialized = useRef(false);
  useEffect(() => {
    if (query.data && !initialized.current) {
      initialized.current = true;
      setRecipient(query.data.testRecipient);
    }
  }, [query.data]);
  useEffect(() => {
    const params = new URLSearchParams(window.location.search);
    const result = params.get('connection');
    if (result === 'failed') {
      const reason = EmailConnectionFailureSchema.catch(
        'EMAIL_CONNECTION_FAILED',
      ).parse(params.get('reason'));
      const explanations: Record<string, string> = {
        EMAIL_ACCOUNT_MISMATCH: `The Gmail account selected does not match the configured application sender${query.data?.expectedSender ? ` (${query.data.expectedSender})` : ''}. Click Connect Gmail and choose that address, or update EMAIL_EXPECTED_SENDER locally and restart the API and worker.`,
        EMAIL_OAUTH_STATE_INVALID:
          'This Gmail connection attempt expired or was already used. Click Connect Gmail to start a fresh attempt.',
        EMAIL_ACCESS_DENIED:
          'Google authorization was cancelled or denied. Click Connect Gmail and grant the requested sending permission.',
        EMAIL_PERMISSION_REQUIRED:
          'Google did not grant Gmail sending permission and offline access. Reconnect and grant the requested permissions.',
        EMAIL_ACCOUNT_UNVERIFIED:
          'Google did not provide a verified email address. Reconnect with your verified Gmail account.',
        EMAIL_RECONNECT_REQUIRED:
          'Google rejected the authorization exchange. Check that the client ID and secret belong to the same Web application, restart the API and worker, and reconnect.',
        EMAIL_AUTH_UNAVAILABLE:
          'CareerLift could not complete authorization with Google. Check your connection and try Connect Gmail again.',
        EMAIL_SENDING_IN_PROGRESS:
          'Wait for the current email send to finish before reconnecting Gmail.',
      };
      setError(
        explanations[reason] ||
          'Gmail connection failed. Check the OAuth configuration, grant sending permission, and connect the configured sender account.',
      );
    }
    if (result === 'connected') setSuccess('Gmail connected.');
  }, [query.data?.expectedSender]);
  const act = async (action: () => Promise<void>) => {
    setBusy(true);
    setError(null);
    setSuccess(null);
    try {
      await action();
      query.refresh();
    } catch (e) {
      setError(message(e));
    } finally {
      setBusy(false);
    }
  };
  const data = query.data;
  return (
    <article className="space-y-5">
      <h1 className="text-2xl font-bold">Email automation</h1>
      <p className="text-sm text-slate-600">
        Connect Gmail, prepare personalized applications, and approve each email
        before sending.
      </p>
      <Feedback error={error || query.error} success={success} busy={busy} />
      <section className={`${panel} space-y-4`}>
        <h2 className="font-bold">Gmail connection</h2>
        {!data ? (
          <p>Loading connection…</p>
        ) : (
          <>
            <p>
              {data.account?.connected
                ? `Connected: ${data.account.address}`
                : 'Gmail is not connected.'}
            </p>
            {data.expectedSender && (
              <p className="text-sm text-slate-500">
                Application sender: {data.expectedSender}
              </p>
            )}
            {!data.configured && (
              <p className="rounded-lg bg-amber-50 p-3 text-sm">
                Gmail setup is needed. Follow docs/email-automation.md to
                configure Google OAuth credentials locally, then restart the API
                and worker.
              </p>
            )}
            {!data.sendingEnabled && (
              <p className="text-sm text-slate-600">
                Sending is disabled in local configuration. Set
                EMAIL_ALLOW_SEND=true when you are ready to use the send
                buttons.
              </p>
            )}
            <div className="flex flex-wrap gap-3">
              <button
                className={primary}
                disabled={busy || !data.configured}
                onClick={() =>
                  void act(async () => {
                    const result = await request<{ url: string }>(
                      '/api/v1/email/connect',
                      { method: 'POST' },
                      token,
                    );
                    const url = new URL(result.url);
                    if (url.origin !== 'https://accounts.google.com')
                      throw new Error('Unexpected Google sign-in destination.');
                    window.location.assign(url.href);
                  })
                }
              >
                {data.account?.connected ? 'Reconnect Gmail' : 'Connect Gmail'}
              </button>
              {data.account?.connected && (
                <button
                  className={button}
                  disabled={busy}
                  onClick={() =>
                    void act(async () => {
                      await request(
                        '/api/v1/email/disconnect',
                        { method: 'POST' },
                        token,
                      );
                      setSuccess('Gmail disconnected.');
                    })
                  }
                >
                  Disconnect Gmail
                </button>
              )}
              <button
                className={button}
                disabled={busy || query.busy}
                onClick={query.refresh}
              >
                Refresh connection
              </button>
            </div>
          </>
        )}
      </section>
      <section className={`${panel} space-y-4`}>
        <h2 className="font-bold">Gemini personalization</h2>
        <p className="text-sm">
          {data?.personalizationConfigured
            ? 'Gemini is configured. Generate a personalized draft from an email application page.'
            : 'Add GEMINI_API_KEY to the root .env file and restart the API to enable personalization.'}
        </p>
        <Link className={button} href="/profile">
          Edit profile and email template
        </Link>
      </section>
      <form
        className={`${panel} space-y-4`}
        onSubmit={(e) => {
          e.preventDefault();
          void act(async () => {
            testKey.current ??= crypto.randomUUID();
            await request(
              '/api/v1/email/test',
              {
                method: 'POST',
                body: JSON.stringify({
                  to: recipient,
                  key: testKey.current,
                  userConfirmed: true,
                }),
              },
              token,
            );
            testKey.current = null;
            setSuccess('Test email queued. Check its status below.');
          });
        }}
      >
        <h2 className="font-bold">Send a connection test</h2>
        <p className="text-sm text-slate-600">
          This sends one test message to the address you enter.
        </p>
        <Field label="Test recipient you control">
          <input
            className={input}
            type="email"
            required
            value={recipient}
            onChange={(e) => {
              setRecipient(e.target.value);
              testKey.current = null;
            }}
            placeholder={data?.account?.address ?? 'your-address@gmail.com'}
          />
        </Field>
        <button
          className={primary}
          disabled={busy || !data?.account?.connected || !data.sendingEnabled}
        >
          Send test email
        </button>
        {data?.testMessages.map((mail) => (
          <p className="text-sm" key={mail.id}>
            {mail.to}: {mail.state.toLowerCase().replaceAll('_', ' ')}
            {mail.state === 'UNKNOWN'
              ? ' — check Gmail Sent before attempting another test'
              : ''}
            {mail.errorCode ? ` (${mail.errorCode})` : ''}
          </p>
        ))}
      </form>
    </article>
  );
}
export function EmailSettings() {
  return (
    <CandidateGate>
      {(token) => <ConnectionManager token={token} />}
    </CandidateGate>
  );
}
