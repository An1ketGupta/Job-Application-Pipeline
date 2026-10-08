import { createHmac, timingSafeEqual } from 'node:crypto';

// Inspection routes accept only an authenticated subject from a verified token.
// Workers use the queue and database directly; they do not impersonate API users.
export function authenticateBearer(
  header: string | undefined,
  secret: string | undefined,
): string | null {
  if (!secret || !header?.startsWith('Bearer ')) return null;
  const token = header.slice(7);
  const parts = token.split('.');
  if (parts.length !== 3) return null;
  const [encodedHeader = '', encodedPayload = '', signature = ''] = parts;
  const expected = createHmac('sha256', secret)
    .update(`${encodedHeader}.${encodedPayload}`)
    .digest();
  let supplied: Buffer;
  try {
    supplied = Buffer.from(signature, 'base64url');
  } catch {
    return null;
  }
  if (
    supplied.length !== expected.length ||
    !timingSafeEqual(supplied, expected)
  )
    return null;
  try {
    const metadata = JSON.parse(
      Buffer.from(encodedHeader, 'base64url').toString(),
    ) as { alg?: string; typ?: string };
    const claims = JSON.parse(
      Buffer.from(encodedPayload, 'base64url').toString(),
    ) as { sub?: unknown; exp?: unknown };
    if (
      metadata.alg !== 'HS256' ||
      metadata.typ !== 'JWT' ||
      typeof claims.sub !== 'string' ||
      !claims.sub ||
      typeof claims.exp !== 'number' ||
      claims.exp <= Math.floor(Date.now() / 1000)
    )
      return null;
    return claims.sub;
  } catch {
    return null;
  }
}

export function createToken(
  sub: string,
  secret: string,
  expiresInSeconds: number = 3600,
): string {
  const header = Buffer.from(
    JSON.stringify({ alg: 'HS256', typ: 'JWT' }),
  ).toString('base64url');
  const payload = Buffer.from(
    JSON.stringify({
      sub,
      exp: Math.floor(Date.now() / 1000) + expiresInSeconds,
    }),
  ).toString('base64url');
  const signature = createHmac('sha256', secret)
    .update(`${header}.${payload}`)
    .digest('base64url');
  return `${header}.${payload}.${signature}`;
}
