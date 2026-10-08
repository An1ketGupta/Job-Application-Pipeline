import type { ApplicationProfile } from '@careerlift/domain';
export type ProfileRecord = {
  data: ApplicationProfile;
  revision: number;
  updatedAt: string | null;
};
export type CandidateDocument = {
  jobTitles?: string[];
  id: string;
  type: string;
  name: string;
  size: number;
  mimeType: string;
  isDefault: boolean;
  archivedAt: string | null;
  createdAt: string;
  updatedAt: string;
  revision: number;
};
export type CandidateAnswer = {
  id: string;
  question: string;
  category: string;
  value: string;
  active: boolean;
  verified: boolean;
  verifiedAt: string;
  updatedAt: string;
  revision: number;
};
export type ReviewItem = {
  requirementId: string;
  type: string;
  category: string;
  question: string;
  reason: string;
  proposedAnswer: string | null;
  confidence?: number | null;
  source: string | null;
  options: string[];
  minLength: number;
  maxLength: number;
  fieldType: string;
  required?: boolean;
  description?: string | null;
  multiple?: boolean;
  documentType: string | null;
  acceptedFileTypes: string[];
  status: string;
  priority: string;
  actions: string[];
};
export type CandidateReview = {
  applicationId: string;
  job: { id: string; title: string; company: string };
  preparationStatus: string | null;
  version: number;
  blocked: boolean;
  canResumePreparation: boolean;
  canStartPreparation?: boolean;
  canRecheckWithAi?: boolean;
  items: ReviewItem[];
  blockers: { type: string; reason: string; recommendation: string }[];
  history: {
    requirementId: string;
    action: string;
    status: string;
    decidedAt: string;
  }[];
};
export type ReviewResponse = {
  reviews: CandidateReview[];
  pagination: { page: number; total: number; totalPages: number };
};
