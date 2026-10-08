import {
  ApplicationTargetSchema,
  JobSchema,
  atsUrlIdentity,
  detectAtsPlatform,
  type ApplicationTarget,
  type Job,
  type SupportedAts,
} from '@careerlift/domain';

// Knowledge strategies for the existing resolver. No browser, persistence,
// answers, credentials, mutation capabilities or submission authority.
export interface AtsAdapter {
  readonly platform: SupportedAts;
  readonly version: 1;
  supports(url: string): boolean;
  resolve(job: Job): ApplicationTarget | undefined;
}
abstract class HostedAtsAdapter implements AtsAdapter {
  abstract readonly platform: SupportedAts;
  readonly version = 1 as const;
  supports(url: string) {
    return atsUrlIdentity(url)?.platform === this.platform;
  }
  resolve(input: Job) {
    const job = JobSchema.parse(input);
    const identity = job.application?.url
      ? atsUrlIdentity(job.application.url)
      : undefined;
    if (!identity || identity.platform !== this.platform) return undefined;
    const kind =
      this.platform === 'GREENHOUSE' ? 'HOSTED_FORM' : 'APPLICATION_ROUTE';
    return ApplicationTargetSchema.parse({
      ...identity,
      adapterVersion: this.version,
      company: job.company,
      role: job.title,
      metadataSource: 'JOB_UNTRUSTED',
      entryPoint: { url: identity.canonicalUrl, kind },
      capabilities: {
        supportsFileUpload: true,
        supportsResumeUpload: true,
        supportsCoverLetter: true,
        supportsDynamicQuestions: true,
        supportsMultiStepForms: true,
        supportsKnownSuccessSignals: false,
      },
      inspectionHints: { formIsDynamic: true, navigation: kind },
    });
  }
}
export class GreenhouseAdapter extends HostedAtsAdapter {
  readonly platform = 'GREENHOUSE' as const;
}
export class LeverAdapter extends HostedAtsAdapter {
  readonly platform = 'LEVER' as const;
}
export class AshbyAdapter extends HostedAtsAdapter {
  readonly platform = 'ASHBY' as const;
}
const adapters: readonly AtsAdapter[] = [
  new GreenhouseAdapter(),
  new LeverAdapter(),
  new AshbyAdapter(),
];
export function adapterForUrl(url: string): AtsAdapter | undefined {
  const platform = detectAtsPlatform(url);
  return adapters.find(
    (adapter) => adapter.platform === platform && adapter.supports(url),
  );
}
