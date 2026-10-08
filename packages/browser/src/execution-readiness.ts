import {
  ashbySubmissionBlocker,
  greenhouseSubmissionBlocker,
  type ExecutionInput,
} from '@careerlift/domain';
import {
  DestinationPolicy,
  InspectionError,
  type BrowserNetworkPolicy,
} from './policy.js';
import { ExecutionNetworkPolicy } from './execution-policy.js';

export async function validateExecutionTarget(
  input: ExecutionInput,
  options: {
    fixtureOrigin?: string;
    policy?: BrowserNetworkPolicy;
    ashbyBrowserAssisted?: boolean;
    greenhouseBrowserAssisted?: boolean;
  },
) {
  if (input.inspection.greenhouseSubmission) {
    if (
      input.plan.destination.target?.platform !== 'GREENHOUSE' ||
      input.inspection.platform !== 'GREENHOUSE'
    )
      throw new InspectionError(
        'UNSUPPORTED_APPLICATION_PLATFORM',
        'The Greenhouse adapter does not match this application',
      );
    const blocker = greenhouseSubmissionBlocker(
      input.inspection.greenhouseSubmission,
      !!options.greenhouseBrowserAssisted || input.mode === 'DRY_RUN',
    );
    if (blocker)
      throw new InspectionError(
        blocker,
        'The Greenhouse application needs browser assistance',
      );
    const base =
      options.policy ??
      new DestinationPolicy(
        input.mode === 'REAL_EXECUTION' ? undefined : options.fixtureOrigin,
      );
    base.validateNavigation(input.inspection.finalUrl);
    await base.validateAddress(input.inspection.finalUrl);
    await base.validateAddress(input.inspection.greenhouseSubmission.submitUrl);
    return;
  }
  if (input.inspection.ashbySubmission && !input.inspection.executionFlow) {
    if (
      input.plan.destination.target?.platform !== 'ASHBY' ||
      input.inspection.platform !== 'ASHBY'
    )
      throw new InspectionError(
        'UNSUPPORTED_APPLICATION_PLATFORM',
        'The submission adapter does not match this application',
      );
    const blocker = ashbySubmissionBlocker(
      input.inspection.ashbySubmission,
      options.ashbyBrowserAssisted && input.mode !== 'DRY_RUN',
    );
    if (blocker)
      throw new InspectionError(blocker, 'The employer requires manual action');
    const base =
      options.policy ??
      new DestinationPolicy(
        input.mode === 'REAL_EXECUTION' ? undefined : options.fixtureOrigin,
      );
    base.validateNavigation(input.inspection.finalUrl);
    await base.validateAddress(input.inspection.finalUrl);
    return;
  }
  if (!input.inspection.executionFlow)
    throw new InspectionError(
      'EXPLICIT_FLOW_REQUIRED',
      'Reinspect the submission flow',
    );
  const policy = new ExecutionNetworkPolicy(
    input,
    options.policy ??
      new DestinationPolicy(
        input.mode === 'REAL_EXECUTION' ? undefined : options.fixtureOrigin,
      ),
  );
  for (const page of input.inspection.executionFlow.pages)
    for (const url of [page.url, page.control.actionUrl, page.expectedUrl])
      await policy.validateAddress(url);
}
