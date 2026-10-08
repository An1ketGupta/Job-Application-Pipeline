/**
 * External Application URL Security Boundary.
 * Reuses the domain Destination Policy requirement:
 * HTTPS URLs only, must have hostname, no embedded username/password,
 * no dangerous schemes (javascript:, file:, data:, blob:, http:).
 */
export function isSafeDestinationUrl(value?: string | null): boolean {
  if (!value || typeof value !== 'string') return false;
  try {
    const url = new URL(value);
    return (
      url.protocol === 'https:' &&
      url.hostname.length > 0 &&
      !url.username &&
      !url.password
    );
  } catch {
    return false;
  }
}

/**
 * Format external text content safely.
 * Untrusted external content must never be treated as executable HTML.
 */
export function sanitizeText(text?: string | null): string {
  if (!text) return '';
  return text.trim();
}
