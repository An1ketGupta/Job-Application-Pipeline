import {
  ApplicationPlanSchema,
  JobSchema,
  type ApplicationPlan,
  type Job,
} from '@careerlift/domain';
import { extractRequirements } from './requirements.js';
import { adapterForUrl } from './ats-adapters.js';

export interface ApplicationResolverStrategy {
  resolve(job: Job): Promise<ApplicationPlan> | ApplicationPlan;
}
export interface LLMResolver {
  resolve(job: Job): Promise<ApplicationPlan>;
}

type Method = Pick<
  ApplicationPlan,
  'applicationType' | 'executor' | 'confidence'
> & { provider?: ApplicationPlan['provider']; reason: string };
const hosts = {
  GOOGLE_FORM: ['docs.google.com'],
  GOOGLE_DOC: ['docs.google.com'],
  LINKEDIN: ['linkedin.com'],
} as const;
function matches(host: string, allowed: readonly string[]): boolean {
  return allowed.some(
    (domain) => host === domain || host.endsWith(`.${domain}`),
  );
}
function classifyUrl(value: string): Method | undefined {
  const url = new URL(value);
  const host = url.hostname.toLowerCase();
  if (matches(host, hosts.GOOGLE_FORM) && /^\/forms\//i.test(url.pathname))
    return {
      applicationType: 'GOOGLE_FORM',
      executor: 'GOOGLE_FORM',
      confidence: 0.99,
      reason: 'Google Forms destination URL',
    };
  if (matches(host, hosts.GOOGLE_DOC) && /^\/document\//i.test(url.pathname))
    return {
      applicationType: 'GOOGLE_DOC',
      executor: 'GOOGLE_DOC',
      confidence: 0.99,
      reason: 'Google Docs destination URL',
    };
  if (matches(host, hosts.LINKEDIN) && /\/jobs\//i.test(url.pathname))
    return {
      applicationType: 'LINKEDIN',
      executor: 'LINKEDIN',
      confidence: 0.95,
      reason: 'LinkedIn job URL',
    };
  const adapter = adapterForUrl(value);
  if (adapter)
    return {
      applicationType: 'EXTERNAL_ATS',
      provider: adapter.platform,
      executor: 'BROWSER',
      confidence: 0.97,
      reason: `${adapter.platform} supported application target`,
    };
  return undefined;
}

const executorByType: Record<
  ApplicationPlan['applicationType'],
  ApplicationPlan['executor']
> = {
  DIRECT_PORTAL: 'BROWSER',
  EMAIL: 'EMAIL',
  GOOGLE_FORM: 'GOOGLE_FORM',
  GOOGLE_DOC: 'GOOGLE_DOC',
  EXTERNAL_ATS: 'BROWSER',
  LINKEDIN: 'LINKEDIN',
  UNKNOWN: 'NONE',
  HUMAN_REQUIRED: 'HUMAN',
};

export class DeterministicResolver implements ApplicationResolverStrategy {
  constructor(private readonly fixtureOrigin?: string) {
    if (fixtureOrigin) {
      const url = new URL(fixtureOrigin);
      if (
        url.protocol !== 'https:' ||
        url.origin !== fixtureOrigin ||
        !['127.0.0.1', '[::1]'].includes(url.hostname)
      )
        throw new Error('LOCAL_HTTPS_FIXTURE_REQUIRED');
    }
  }
  resolve(input: Job): ApplicationPlan {
    const job = JobSchema.parse(input);
    const info = job.application;
    const reason: string[] = [];
    const target = info?.url
      ? adapterForUrl(info.url)?.resolve(job)
      : undefined;
    const fixture = Boolean(
      info?.url &&
      this.fixtureOrigin &&
      new URL(info.url).origin === this.fixtureOrigin,
    );
    let unsupported = false;
    let method: Method = {
      applicationType: 'UNKNOWN',
      executor: 'NONE',
      confidence: 0.1,
      reason: 'No reliable application destination',
    };
    if (info?.email)
      method = {
        applicationType: 'EMAIL',
        executor: 'EMAIL',
        confidence: 0.98,
        reason: 'Validated application email',
      };
    else if (info?.url) {
      const classified = classifyUrl(info.url);
      unsupported = !classified && !fixture;
      method =
        classified ??
        (fixture
          ? {
              applicationType: 'DIRECT_PORTAL',
              executor: 'BROWSER',
              confidence: 1,
              reason: 'Explicit local fixture destination',
            }
          : {
              applicationType: 'HUMAN_REQUIRED',
              executor: 'HUMAN',
              confidence: 1,
              reason: 'UNSUPPORTED_APPLICATION_PLATFORM',
            });
    }
    if (info?.email && info.url) {
      reason.push('Both email and URL destinations were supplied');
      method = {
        applicationType: 'HUMAN_REQUIRED',
        executor: 'HUMAN',
        confidence: 0.25,
        reason: 'Ambiguous application destinations',
      };
    }
    // Explicit structured data can resolve an otherwise unknown method, but cannot override a conflicting destination.
    if (
      info?.type &&
      info.type !== 'UNKNOWN' &&
      info.type !== 'HUMAN_REQUIRED'
    ) {
      if (method.applicationType === 'UNKNOWN') {
        method = {
          applicationType: info.type,
          executor: executorByType[info.type],
          confidence: 0.7,
          reason: 'Validated structured application type',
        };
      } else if (
        method.applicationType !== info.type &&
        method.applicationType !== 'HUMAN_REQUIRED'
      ) {
        reason.push(
          `Structured type ${info.type} conflicts with destination evidence`,
        );
        method = {
          applicationType: 'HUMAN_REQUIRED',
          executor: 'HUMAN',
          confidence: 0.25,
          reason: 'Conflicting application method evidence',
        };
      }
    }
    if (info?.provider && method.applicationType === 'EXTERNAL_ATS') {
      if (method.provider && method.provider !== info.provider) {
        reason.push('Structured ATS provider conflicts with destination host');
        method = {
          applicationType: 'HUMAN_REQUIRED',
          executor: 'HUMAN',
          confidence: 0.25,
          reason: 'Conflicting ATS provider evidence',
        };
      } else method = { ...method, provider: info.provider };
    }
    if (
      info?.type === 'HUMAN_REQUIRED' ||
      info?.requiresHumanReview === true ||
      info?.unrecognizedMethod
    ) {
      reason.push(
        'Source explicitly requests review or contains an unrecognized method',
      );
      method = {
        applicationType: 'HUMAN_REQUIRED',
        executor: 'HUMAN',
        confidence: 0.2,
        reason: 'Explicit human review condition',
      };
    }
    const requirements = extractRequirements(job);
    const sensitive = requirements.some(
      (r) =>
        r.status === 'human_required' ||
        ['SALARY_EXPECTATION', 'WORK_AUTHORIZATION', 'SPONSORSHIP'].includes(
          r.type,
        ),
    );
    const needsEmail = method.applicationType === 'EMAIL' && !info?.email;
    const needsUrl =
      [
        'DIRECT_PORTAL',
        'GOOGLE_FORM',
        'GOOGLE_DOC',
        'EXTERNAL_ATS',
        'LINKEDIN',
      ].includes(method.applicationType) && !info?.url;
    if (needsEmail || needsUrl)
      reason.push('Application destination is missing');
    if (sensitive)
      reason.push(
        'Sensitive requirement needs a human supplied answer or policy',
      );
    const requiresHumanReview =
      method.applicationType === 'UNKNOWN' ||
      method.applicationType === 'HUMAN_REQUIRED' ||
      reason.length > 0 ||
      sensitive;
    if (requiresHumanReview && method.applicationType !== 'UNKNOWN') {
      method = {
        ...(method.provider ? { provider: method.provider } : {}),
        applicationType: 'HUMAN_REQUIRED',
        executor: 'HUMAN',
        confidence: method.confidence,
        reason: method.reason,
      };
    } else if (requiresHumanReview) {
      method = { ...method, executor: 'HUMAN' };
    }
    const actions: ApplicationPlan['actions'] = requirements.map((r) => ({
      type:
        r.type === 'RESUME' || r.type === 'COVER_LETTER'
          ? 'PREPARE_DOCUMENT'
          : 'COLLECT_INFORMATION',
      description: `Provide ${r.label.toLowerCase()} (${r.status})`,
      requirementType: r.type,
    }));
    if (requiresHumanReview)
      actions.push({
        type: 'REVIEW_DESTINATION',
        description:
          'Review application method and requirements before execution',
      });
    else
      actions.push({
        type: 'HAND_OFF',
        description: `Route plan to ${method.executor} executor when enabled`,
      });
    return ApplicationPlanSchema.parse({
      jobId: job.id,
      applicationType: method.applicationType,
      ...(method.provider ? { provider: method.provider } : {}),
      destination: {
        ...(info?.url ? { url: target?.canonicalUrl ?? info.url } : {}),
        ...(info?.email ? { email: info.email } : {}),
        ...(target && method.provider === target.platform ? { target } : {}),
        ...(unsupported
          ? { unsupportedReason: 'UNSUPPORTED_APPLICATION_PLATFORM' }
          : {}),
      },
      requirements,
      actions,
      executor: method.executor,
      confidence: method.confidence,
      requiresHumanReview,
      reasoning: [method.reason, ...reason],
      resolvedBy: 'deterministic',
    });
  }
}

export class CompositeApplicationResolver implements ApplicationResolverStrategy {
  constructor(
    private readonly deterministic: ApplicationResolverStrategy = new DeterministicResolver(),
    private readonly llm?: LLMResolver,
    private readonly threshold = 0.8,
  ) {}
  async resolve(job: Job): Promise<ApplicationPlan> {
    const first = ApplicationPlanSchema.parse(
      await this.deterministic.resolve(job),
    );
    if (
      !this.llm ||
      first.destination.unsupportedReason ||
      first.destination.target ||
      (first.confidence >= this.threshold && !first.requiresHumanReview)
    )
      return first;
    try {
      const candidate = ApplicationPlanSchema.parse(
        await this.llm.resolve(job),
      );
      if (candidate.jobId !== job.id || candidate.resolvedBy !== 'llm')
        return first;
      // A model can add review, never invent a browser/platform authorization or clear a gate.
      if (
        candidate.executor !== first.executor ||
        candidate.applicationType !== first.applicationType ||
        candidate.provider !== first.provider ||
        (first.requiresHumanReview && !candidate.requiresHumanReview)
      )
        return first;
      if (
        (candidate.destination.email &&
          candidate.destination.email !== job.application?.email) ||
        (candidate.destination.url &&
          candidate.destination.url !== job.application?.url)
      )
        return first;
      return candidate.confidence > first.confidence ? candidate : first;
    } catch {
      return first;
    }
  }
}
