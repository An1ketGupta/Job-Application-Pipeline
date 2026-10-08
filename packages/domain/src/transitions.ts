import type { ApplicationState } from './schemas.js';

const allowed: Record<ApplicationState, readonly ApplicationState[]> = {
  DISCOVERED: ['ANALYZING', 'FAILED'],
  ANALYZING: ['RESOLVED', 'HUMAN_REQUIRED', 'FAILED'],
  FAILED: ['ANALYZING'],
  RESOLVED: [],
  HUMAN_REQUIRED: [],
  READY: [],
  EXECUTING: [],
  VERIFYING: [],
  SUBMITTED: [],
  BLOCKED: [],
};

export function canTransition(
  from: ApplicationState,
  to: ApplicationState,
): boolean {
  return allowed[from].includes(to);
}
