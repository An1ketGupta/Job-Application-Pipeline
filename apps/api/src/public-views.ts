import { atsUrlIdentity } from '@careerlift/domain';

// Public URLs are display data, never execution inputs. Preserve only validated
// public ATS posting identifiers; credentials and arbitrary query values stay private.
export function publicUrl(value: unknown): string | null {
  if (typeof value !== 'string') return null;
  try {
    const url = new URL(value);
    if (url.protocol !== 'https:' || url.username || url.password) return null;
    const target = atsUrlIdentity(value);
    url.search = '';
    url.hash = '';
    if (
      target?.platform === 'GREENHOUSE' &&
      url.pathname === '/embed/job_app'
    ) {
      url.searchParams.set('for', target.boardToken);
      url.searchParams.set('token', target.externalJobId);
    }
    return url.href;
  } catch {
    return null;
  }
}

export function publicJobApplication(value: unknown) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
  const app = value as Record<string, unknown>;
  return {
    ...(typeof app.type === 'string' ? { type: app.type } : {}),
    ...(typeof app.provider === 'string' ? { provider: app.provider } : {}),
    ...(typeof app.email === 'string' ? { email: app.email } : {}),
    ...(publicUrl(app.url) ? { url: publicUrl(app.url) } : {}),
    ...(typeof app.requiresHumanReview === 'boolean'
      ? { requiresHumanReview: app.requiresHumanReview }
      : {}),
  };
}
