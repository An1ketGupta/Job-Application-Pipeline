import { createHash } from 'node:crypto';
import {
  InvalidExternalDataError,
  JobSchema,
  ApplicationDestinationUrlSchema,
  RequirementTypeSchema,
  type Job,
} from '@careerlift/domain';
import { z } from 'zod';

// Fixture contract only. This is not a claim about a public CareerLift API.
export const CareerLiftFixtureJobSchema = z
  .object({
    id: z.union([z.string().min(1), z.number().int()]).optional(),
    company: z.string().min(1),
    role: z.string().min(1),
    location: z.string().optional(),
    employmentType: z.string().optional(),
    description: z.string().optional(),
    requirements: z.array(z.string()).optional(),
    application: z
      .object({
        type: z.string().optional(),
        url: ApplicationDestinationUrlSchema.optional(),
        email: z.string().email().optional(),
        provider: z.string().optional(),
        requiresHumanReview: z.boolean().optional(),
        requirements: z
          .array(
            z
              .object({
                type: RequirementTypeSchema,
                status: z
                  .enum(['required', 'optional', 'unknown', 'human_required'])
                  .optional(),
                label: z.string().optional(),
              })
              .strict(),
          )
          .optional(),
      })
      .strict()
      .optional(),
    sourceUrl: z.string().url().optional(),
    postedAt: z.string().datetime().optional(),
  })
  .strict();

export type CareerLiftFixtureJob = z.infer<typeof CareerLiftFixtureJobSchema>;

const types: Record<string, NonNullable<Job['application']>['type']> = {
  email: 'EMAIL',
  direct: 'DIRECT_PORTAL',
  portal: 'DIRECT_PORTAL',
  google_form: 'GOOGLE_FORM',
  google_doc: 'GOOGLE_DOC',
  ats: 'EXTERNAL_ATS',
  linkedin: 'LINKEDIN',
  unknown: 'UNKNOWN',
  human_required: 'HUMAN_REQUIRED',
};
const providers: Record<string, NonNullable<Job['application']>['provider']> = {
  greenhouse: 'GREENHOUSE',
  lever: 'LEVER',
  workday: 'WORKDAY',
  ashby: 'ASHBY',
  smartrecruiters: 'SMARTRECRUITERS',
  icims: 'ICIMS',
  other: 'OTHER',
  unknown: 'UNKNOWN',
};

export interface ExternalJobAdapter {
  parse(raw: unknown): Job;
}

export class CareerLiftJobAdapter implements ExternalJobAdapter {
  constructor(private readonly applicationSource = 'careerlift-fixture') {}

  parse(raw: unknown): Job {
    const result = CareerLiftFixtureJobSchema.safeParse(raw);
    if (!result.success)
      throw new InvalidExternalDataError(result.error.message);
    const data = result.data;
    const externalId = String(
      data.id ??
        createHash('sha256')
          .update(JSON.stringify(data))
          .digest('hex')
          .slice(0, 20),
    );
    const rawType = data.application?.type?.toLowerCase();
    const rawProvider = data.application?.provider?.toLowerCase();
    const type = rawType ? types[rawType] : undefined;
    const provider = rawProvider ? providers[rawProvider] : undefined;
    const application = data.application
      ? {
          ...(type ? { type } : {}),
          ...(data.application.url ? { url: data.application.url } : {}),
          ...(data.application.email ? { email: data.application.email } : {}),
          ...(provider ? { provider } : {}),
          source: this.applicationSource,
          ...(data.application.type
            ? { reportedMethod: data.application.type }
            : {}),
          ...(rawType && !type ? { unrecognizedMethod: rawType } : {}),
          ...(data.application.requiresHumanReview !== undefined
            ? { requiresHumanReview: data.application.requiresHumanReview }
            : {}),
          ...(data.application.requirements
            ? {
                structuredRequirements: data.application.requirements.map(
                  (requirement) => ({
                    type: requirement.type,
                    status: requirement.status ?? 'unknown',
                    label:
                      requirement.label ??
                      requirement.type.replaceAll('_', ' ').toLowerCase(),
                    source: 'structured' as const,
                  }),
                ),
              }
            : {}),
        }
      : undefined;
    return JobSchema.parse({
      id: `careerlift:${externalId}`,
      externalId,
      source: 'CAREERLIFT',
      company: data.company,
      title: data.role,
      requirements: data.requirements ?? [],
      ...(data.location ? { location: data.location } : {}),
      ...(data.employmentType ? { employmentType: data.employmentType } : {}),
      ...(data.description ? { description: data.description } : {}),
      ...(application ? { application } : {}),
      ...(data.sourceUrl ? { sourceUrl: data.sourceUrl } : {}),
      ...(data.postedAt ? { createdAt: data.postedAt } : {}),
    });
  }
}

export interface CareerLiftJobSource {
  readonly applicationSource?: string;
  fetchJobs(): Promise<unknown[]>;
}

export { DEFAULT_CAREERLIFT_FIXTURE_JOBS } from './fixture-data.js';
import { DEFAULT_CAREERLIFT_FIXTURE_JOBS } from './fixture-data.js';

export class DefaultCareerLiftJobSource implements CareerLiftJobSource {
  constructor(
    private readonly apiUrl?: string,
    private readonly apiKey?: string,
    private readonly fallbackData: unknown[] = DEFAULT_CAREERLIFT_FIXTURE_JOBS,
  ) {}

  async fetchJobs(): Promise<unknown[]> {
    if (this.apiUrl) {
      const headers: Record<string, string> = {
        Accept: 'application/json',
      };
      if (this.apiKey) {
        headers['Authorization'] = `Bearer ${this.apiKey}`;
      }
      const response = await fetch(this.apiUrl, { headers });
      if (!response.ok) {
        throw new Error(`CareerLift source returned HTTP ${response.status}`);
      }
      const data = await response.json();
      if (!Array.isArray(data)) {
        throw new Error('CareerLift source response is not an array');
      }
      return data;
    }
    return this.fallbackData;
  }
}
