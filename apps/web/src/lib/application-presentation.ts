import type { ApplicationSummary } from './types.js';

export const applicationLabels: Record<ApplicationSummary['state'], string> = {
  DISCOVERED: 'Created',
  ANALYZING: 'Analyzing',
  RESOLVED: 'Resolved',
  READY: 'Ready',
  EXECUTING: 'Executing',
  VERIFYING: 'Verifying',
  SUBMITTED: 'Submitted',
  FAILED: 'Failed',
  BLOCKED: 'Blocked',
  HUMAN_REQUIRED: 'Human review required',
};
export function stateLabel(value: string | null | undefined) {
  if (!value) return 'Not started';
  return value
    .toLowerCase()
    .replaceAll('_', ' ')
    .replace(/^./, (c) => c.toUpperCase());
}
export function applicationHeadline(app: ApplicationSummary) {
  if (app.googleForm) {
    const labels: Record<string, string> = {
      PENDING: 'Google Forms queued',
      RUNNING: 'Filling Google Form',
      REVIEW: 'Google Forms answers need review',
      BROWSER_REQUIRED: 'Google browser action required',
      SUBMITTING: 'Submitting Google Form',
      SUBMITTED: app.googleForm.test
        ? 'Test form submission confirmed'
        : 'Google Form submitted & confirmed',
      UNKNOWN: 'Google Forms submission outcome unknown',
      FAILED: 'Google Forms failed',
      BLOCKED: 'Google Forms stopped',
    };
    return labels[app.googleForm.state] ?? 'Google Forms';
  }
  if (app.plan?.platform === 'GOOGLE_FORM') {
    if (app.state === 'SUBMITTED') return 'Submitted (application record)';
    if (app.execution?.state === 'SUBMISSION_UNKNOWN')
      return 'Submission outcome unknown';
    return 'Google Forms ready to start';
  }
  if (app.plan?.applicationType === 'EMAIL') {
    if (app.email?.state === 'SENT') return 'Application email sent';
    if (app.email?.state === 'UNKNOWN') return 'Email send outcome unknown';
    if (app.email?.state === 'QUEUED') return 'Email queued';
    if (app.email?.state === 'SENDING') return 'Sending application email';
    if (app.email?.state === 'FAILED') return 'Email needs attention';
    if (app.email?.state === 'DRAFT') return 'Email ready for review';
    return app.humanReviewRequired
      ? 'Human review required'
      : 'Prepare application email';
  }
  const verification = app.execution?.verification;
  if (verification?.state === 'REJECTED') return 'Submission rejected';
  if (app.plan?.platform === 'UNSUPPORTED') return 'Unsupported platform';
  if (
    app.execution?.state === 'SUBMISSION_UNKNOWN' &&
    app.state !== 'SUBMITTED'
  )
    return 'Submission outcome unknown';
  if (app.humanReviewRequired) return 'Human review required';
  if (app.execution?.mode === 'DRY_RUN')
    return `Dry run: ${stateLabel(app.execution.state)}`;
  if (app.state === 'SUBMITTED' && verification?.state === 'CONFIRMED')
    return app.execution?.mode === 'TEST_FIXTURE'
      ? 'Test submission verified'
      : 'Submitted & verified';
  if (verification?.state === 'UNKNOWN') return 'Submission outcome unknown';
  if (verification?.state === 'FAILED') return 'Verification service failed';
  if (verification && ['PENDING', 'VERIFYING'].includes(verification.state))
    return 'Verification pending';
  if (app.execution?.state === 'SUBMISSION_UNKNOWN')
    return 'Submission outcome unknown';
  if (app.execution?.state === 'DRY_RUN_COMPLETED') return 'Dry run completed';
  if (app.execution && ['FAILED', 'BLOCKED'].includes(app.execution.state))
    return 'Execution ' + stateLabel(app.execution.state).toLowerCase();
  if (
    app.execution &&
    ['PENDING', 'PREPARING', 'RUNNING', 'SUBMITTING'].includes(
      app.execution.state,
    )
  )
    return `Execution: ${stateLabel(app.execution.state)}`;
  if (
    app.preparation &&
    ['PENDING', 'RUNNING', 'FAILED'].includes(app.preparation.state)
  )
    return `Preparation: ${stateLabel(app.preparation.state)}`;
  if (
    app.inspection &&
    ['PENDING', 'RUNNING', 'FAILED'].includes(app.inspection.state)
  )
    return `Inspection: ${stateLabel(app.inspection.state)}`;
  if (app.preparation?.state === 'COMPLETED') {
    if (app.executionReadiness?.state === 'BLOCKED')
      return 'Submission needs attention';
    if (app.executionReadiness?.state === 'DISABLED')
      return 'Submission disabled';
    if (app.executionReadiness?.state === 'READY')
      return app.executionReadiness.automatic
        ? 'Ready for automatic submission'
        : 'Ready to submit';
    return 'Preparation complete';
  }
  if (app.inspection?.state === 'COMPLETED') return 'Preparation required';
  if (app.plan && ['RESOLVED', 'READY'].includes(app.state))
    return 'Inspection required';
  return applicationLabels[app.state];
}
export function formatTimestamp(value: string) {
  return new Date(value).toLocaleString(undefined, {
    year: 'numeric',
    month: 'short',
    day: 'numeric',
    hour: '2-digit',
    minute: '2-digit',
  });
}
export function submissionLabel(app: ApplicationSummary) {
  if (app.googleForm?.state === 'SUBMITTED')
    return app.googleForm.test
      ? 'Confirmed in the local test form'
      : 'Google Forms confirmation recorded';
  if (app.googleForm?.state === 'UNKNOWN') return 'Attempted — outcome unknown';
  if (app.googleForm?.state === 'SUBMITTING')
    return 'Submitting — confirmation pending';
  if (app.email?.state === 'SENT')
    return 'Email sent — employer receipt not verified';
  if (app.email?.state === 'UNKNOWN') return 'Email send outcome unknown';
  if (app.state === 'SUBMITTED') return 'Submitted (application record)';
  if (app.execution?.verification?.state === 'REJECTED') return 'Rejected';
  if (app.execution?.state === 'SUBMISSION_UNKNOWN')
    return 'Attempted — outcome unknown';
  if (app.execution?.state === 'SUBMITTED')
    return 'Attempt recorded — acceptance requires verification';
  if (app.execution?.state === 'SUBMITTING')
    return 'Submitting — acceptance not established';
  return 'No submitted application established';
}
