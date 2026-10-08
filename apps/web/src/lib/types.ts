export type ApplicationState =
  | 'DISCOVERED'
  | 'ANALYZING'
  | 'RESOLVED'
  | 'READY'
  | 'EXECUTING'
  | 'VERIFYING'
  | 'SUBMITTED'
  | 'FAILED'
  | 'BLOCKED'
  | 'HUMAN_REQUIRED';

export type JobApplicationStatus = {
  hasApplication: boolean;
  applicationId: string;
  state: ApplicationState;
  requiresHumanReview: boolean;
  updatedAt: string;
};

export type ApplicationInfo = {
  type?: string;
  url?: string;
  email?: string;
  provider?: string;
  reportedMethod?: string;
  unrecognizedMethod?: string;
  requiresHumanReview?: boolean;
  structuredRequirements?: Array<{
    type: string;
    status: string;
    label: string;
    source: string;
  }>;
};

export type NormalizedJob = {
  id: string;
  externalId: string;
  source: string;
  company: string;
  title: string;
  location?: string | null;
  employmentType?: string | null;
  description?: string | null;
  requirements: string[];
  application?: ApplicationInfo | null;
  sourceUrl?: string | null;
  createdAt: string;
  updatedAt: string;
  applicationStatus?: JobApplicationStatus | null;
};

export type PaginationMeta = {
  page: number;
  limit: number;
  total: number;
  totalPages: number;
};

export type JobListResponse = {
  jobs: NormalizedJob[];
  pagination: PaginationMeta;
};

export type SyncResult = {
  synced: number;
  total: number;
  lastSyncedAt: string;
};

export type {
  ApplicationSummary,
  ApplicationsResponse,
} from '@careerlift/domain';
export type ApplicationDetail = import('@careerlift/domain').ApplicationDetails;

export type AuthUser = {
  id: string;
  email: string;
};
