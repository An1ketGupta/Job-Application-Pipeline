'use client';
import React, { useState } from 'react';
import { request } from '@/lib/api';
import type { ApplicationDetail } from '@/lib/types';
import { Feedback, button, panel, message } from './CandidateUI';
export function ApplicationPreparationActions({
  application,
  token,
  refresh,
}: {
  application: ApplicationDetail;
  token: string;
  refresh: () => void;
}) {
  const [busy, setBusy] = useState(false),
    [error, setError] = useState<string | null>(null),
    [success, setSuccess] = useState<string | null>(null);
  const inspect =
    !!application.plan &&
    [
      'DIRECT_PORTAL',
      'EXTERNAL_ATS',
      'GOOGLE_FORM',
      'GOOGLE_DOC',
      'LINKEDIN',
    ].includes(application.plan.applicationType) &&
    ['RESOLVED', 'READY'].includes(application.state) &&
    (!application.inspection || application.inspection.state === 'FAILED') &&
    !application.executions.length;
  const prepare =
    application.preparationAllowed &&
    (!application.preparation || application.preparation.state === 'FAILED');
  if (
    application.googleForm ||
    application.plan?.platform === 'GOOGLE_FORM' ||
    (!inspect && !prepare)
  )
    return null;
  return (
    <section className={panel}>
      <h2 className="font-bold">Prepare your application</h2>
      <p className="mt-2 text-sm text-slate-500">
        {inspect
          ? 'Inspect the application form to identify its requirements.'
          : 'Check your profile, verified answers, and documents against this application’s requirements.'}
      </p>
      <Feedback error={error} success={success} busy={busy} />
      <button
        className={`${button} mt-3`}
        disabled={busy}
        onClick={async () => {
          setBusy(true);
          setError(null);
          setSuccess(null);
          try {
            await request(
              `/api/v1/applications/${encodeURIComponent(application.id)}/${inspect ? 'inspect' : 'prepare'}`,
              { method: 'POST' },
              token,
            );
            setSuccess(
              inspect
                ? 'Inspection requested.'
                : 'Preparation requested. Missing information will appear in Human Review.',
            );
            refresh();
          } catch (e) {
            setError(message(e));
          } finally {
            setBusy(false);
          }
        }}
      >
        {inspect ? 'Inspect application' : 'Prepare required information'}
      </button>
    </section>
  );
}
