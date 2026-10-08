import {
  createCipheriv,
  createDecipheriv,
  createHash,
  randomBytes,
} from 'node:crypto';
import { EmailAddressSchema } from '@careerlift/domain';
import { z } from 'zod';
export * from './personalization.js';

export const GMAIL_SEND_SCOPE = 'https://www.googleapis.com/auth/gmail.send';
export const GMAIL_SCOPES = `${GMAIL_SEND_SCOPE} https://www.googleapis.com/auth/userinfo.email`;
export interface GmailConfig {
  clientId: string;
  clientSecret: string;
  redirectUri: string;
  encryptionKey: string;
  webOrigin: string;
  allowSend: boolean;
  expectedSender?: string;
  defaultSenderName?: string;
}
export function gmailConfigFrom(config: {
  GMAIL_CLIENT_ID?: string | undefined;
  GMAIL_CLIENT_SECRET?: string | undefined;
  EMAIL_ENCRYPTION_KEY?: string | undefined;
  GMAIL_REDIRECT_URI: string;
  EMAIL_WEB_ORIGIN: string;
  EMAIL_ALLOW_SEND: string;
  EMAIL_EXPECTED_SENDER?: string | undefined;
  EMAIL_DEFAULT_SENDER_NAME?: string | undefined;
}): GmailConfig | undefined {
  if (
    !config.GMAIL_CLIENT_ID ||
    !config.GMAIL_CLIENT_SECRET ||
    !config.EMAIL_ENCRYPTION_KEY
  )
    return undefined;
  if (Buffer.from(config.EMAIL_ENCRYPTION_KEY, 'base64').length !== 32)
    throw new Error('EMAIL_ENCRYPTION_KEY_INVALID');
  const redirect = new URL(config.GMAIL_REDIRECT_URI),
    origin = new URL(config.EMAIL_WEB_ORIGIN);
  for (const url of [redirect, origin]) {
    if (
      url.username ||
      url.password ||
      url.hash ||
      url.search ||
      (url.protocol !== 'https:' &&
        !(
          url.protocol === 'http:' &&
          ['localhost', '127.0.0.1', '[::1]'].includes(url.hostname)
        ))
    )
      throw new Error('EMAIL_OAUTH_URL_INVALID');
  }
  return {
    clientId: config.GMAIL_CLIENT_ID,
    clientSecret: config.GMAIL_CLIENT_SECRET,
    encryptionKey: config.EMAIL_ENCRYPTION_KEY,
    redirectUri: redirect.href,
    webOrigin: origin.origin,
    allowSend: config.EMAIL_ALLOW_SEND === 'true',
    ...(config.EMAIL_EXPECTED_SENDER
      ? { expectedSender: config.EMAIL_EXPECTED_SENDER }
      : {}),
    ...(config.EMAIL_DEFAULT_SENDER_NAME
      ? { defaultSenderName: config.EMAIL_DEFAULT_SENDER_NAME }
      : {}),
  };
}
export interface MailAttachment {
  name: string;
  mimeType: string;
  buffer: Buffer;
}
export interface OutgoingEmail {
  from: string;
  to: string;
  subject: string;
  body: string;
  messageId: string;
  attachments: MailAttachment[];
  senderName?: string;
}
export interface EmailProvider {
  accessToken(refreshToken: string): Promise<string>;
  send(accessToken: string, message: OutgoingEmail): Promise<string>;
}
export class EmailProviderError extends Error {
  constructor(
    public readonly code: string,
    public readonly uncertain = false,
  ) {
    super(code);
  }
}
export function encryptSecret(value: string, key: string, context: string) {
  const bytes = Buffer.from(key, 'base64');
  if (bytes.length !== 32) throw new Error('EMAIL_ENCRYPTION_KEY_INVALID');
  const iv = randomBytes(12);
  const cipher = createCipheriv('aes-256-gcm', bytes, iv);
  cipher.setAAD(Buffer.from(context));
  const encrypted = Buffer.concat([
    cipher.update(value, 'utf8'),
    cipher.final(),
  ]);
  return [iv, cipher.getAuthTag(), encrypted]
    .map((b) => b.toString('base64url'))
    .join('.');
}
export function decryptSecret(value: string, key: string, context: string) {
  const [iv, tag, data] = value.split('.');
  if (!iv || !tag || !data) throw new Error('EMAIL_CREDENTIAL_INVALID');
  const decipher = createDecipheriv(
    'aes-256-gcm',
    Buffer.from(key, 'base64'),
    Buffer.from(iv, 'base64url'),
  );
  decipher.setAAD(Buffer.from(context));
  decipher.setAuthTag(Buffer.from(tag, 'base64url'));
  return Buffer.concat([
    decipher.update(Buffer.from(data, 'base64url')),
    decipher.final(),
  ]).toString('utf8');
}
export const hashOAuthState = (value: string) =>
  createHash('sha256').update(value).digest('hex');
export function oauthAuthorization(
  config: GmailConfig,
  state: string,
  verifier: string,
) {
  const url = new URL('https://accounts.google.com/o/oauth2/v2/auth');
  url.search = new URLSearchParams({
    client_id: config.clientId,
    redirect_uri: config.redirectUri,
    response_type: 'code',
    scope: GMAIL_SCOPES,
    access_type: 'offline',
    prompt: 'consent',
    state,
    code_challenge: createHash('sha256').update(verifier).digest('base64url'),
    code_challenge_method: 'S256',
    ...(config.expectedSender ? { login_hint: config.expectedSender } : {}),
  }).toString();
  return url.href;
}
const tokenSchema = z.object({
  access_token: z.string().min(1),
  refresh_token: z.string().optional(),
  scope: z.string().optional(),
});
export class GmailProvider implements EmailProvider {
  constructor(
    private readonly config: GmailConfig,
    private readonly http: typeof fetch = fetch,
  ) {}
  private async token(body: Record<string, string>) {
    let response: Response;
    try {
      response = await this.http('https://oauth2.googleapis.com/token', {
        method: 'POST',
        headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
        body: new URLSearchParams({
          ...body,
          client_id: this.config.clientId,
          client_secret: this.config.clientSecret,
        }),
        signal: AbortSignal.timeout(20000),
        redirect: 'error',
      });
    } catch {
      throw new EmailProviderError('EMAIL_AUTH_UNAVAILABLE');
    }
    if (!response.ok)
      throw new EmailProviderError(
        response.status === 400 || response.status === 401
          ? 'EMAIL_RECONNECT_REQUIRED'
          : 'EMAIL_AUTH_UNAVAILABLE',
      );
    const parsed = tokenSchema.safeParse(
      await response.json().catch(() => null),
    );
    if (!parsed.success) throw new EmailProviderError('EMAIL_AUTH_UNAVAILABLE');
    return parsed.data;
  }
  async exchange(code: string, verifier: string) {
    const token = await this.token({
      code,
      code_verifier: verifier,
      redirect_uri: this.config.redirectUri,
      grant_type: 'authorization_code',
    });
    if (
      !token.refresh_token ||
      !token.scope?.split(' ').includes(GMAIL_SEND_SCOPE)
    )
      throw new EmailProviderError('EMAIL_PERMISSION_REQUIRED');
    const response = await this.http(
      'https://www.googleapis.com/oauth2/v2/userinfo',
      {
        headers: { Authorization: `Bearer ${token.access_token}` },
        signal: AbortSignal.timeout(20000),
        redirect: 'error',
      },
    );
    if (!response.ok) throw new EmailProviderError('EMAIL_AUTH_UNAVAILABLE');
    const profile = z
      .object({ email: EmailAddressSchema, verified_email: z.literal(true) })
      .safeParse(await response.json());
    if (!profile.success)
      throw new EmailProviderError('EMAIL_ACCOUNT_UNVERIFIED');
    return { address: profile.data.email, refreshToken: token.refresh_token };
  }
  async accessToken(refreshToken: string) {
    return (
      await this.token({
        refresh_token: refreshToken,
        grant_type: 'refresh_token',
      })
    ).access_token;
  }
  async revoke(refreshToken: string) {
    const response = await this.http('https://oauth2.googleapis.com/revoke', {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({ token: refreshToken }),
      signal: AbortSignal.timeout(20000),
      redirect: 'error',
    });
    if (!response.ok && response.status !== 400)
      throw new EmailProviderError('EMAIL_AUTH_UNAVAILABLE');
  }
  async send(accessToken: string, message: OutgoingEmail) {
    // Build and validate before crossing the send boundary. Never retry this request.
    const raw = buildMimeMessage(message);
    let response: Response;
    try {
      response = await this.http(
        'https://gmail.googleapis.com/gmail/v1/users/me/messages/send',
        {
          method: 'POST',
          headers: {
            Authorization: `Bearer ${accessToken}`,
            'Content-Type': 'application/json',
          },
          body: JSON.stringify({ raw }),
          signal: AbortSignal.timeout(45000),
          redirect: 'error',
        },
      );
    } catch {
      throw new EmailProviderError('EMAIL_SEND_UNKNOWN', true);
    }
    // Network/server failures may have happened after acceptance; do not submit again.
    if (!response.ok)
      throw new EmailProviderError(
        response.status === 401
          ? 'EMAIL_RECONNECT_REQUIRED'
          : response.status === 429
            ? 'EMAIL_RATE_LIMITED'
            : 'EMAIL_SEND_REJECTED',
        response.status >= 500 || response.status === 408,
      );
    const parsed = z
      .object({ id: z.string().min(1) })
      .safeParse(await response.json().catch(() => null));
    if (!parsed.success)
      throw new EmailProviderError('EMAIL_SEND_UNKNOWN', true);
    return parsed.data.id;
  }
}
const wrapBase64 = (buffer: Buffer) =>
  buffer
    .toString('base64')
    .match(/.{1,76}/g)
    ?.join('\r\n') ?? '';
export function buildMimeMessage(message: OutgoingEmail) {
  const from = EmailAddressSchema.parse(message.from),
    to = EmailAddressSchema.parse(message.to);
  if (
    /[\r\n]/.test(message.subject) ||
    message.subject.length > 250 ||
    !message.subject.trim() ||
    !/^<[a-zA-Z0-9_-]+@careerlift\.local>$/.test(message.messageId)
  )
    throw new EmailProviderError('EMAIL_INVALID_MESSAGE');
  if (
    message.attachments.length > 5 ||
    message.attachments.reduce((n, a) => n + a.buffer.length, 0) >
      15 * 1024 * 1024
  )
    throw new EmailProviderError('EMAIL_ATTACHMENTS_TOO_LARGE');
  const boundary = `careerlift_${randomBytes(18).toString('hex')}`;
  const parts = [
    `From: ${message.senderName ? `=?UTF-8?B?${Buffer.from(message.senderName).toString('base64')}?= <${from}>` : from}`,
    `To: ${to}`,
    // Short encoded words allow Unicode while keeping header line lengths bounded.
    `Subject: ${Array.from(message.subject)
      .reduce<string[]>((chunks, char) => {
        const last = chunks.length - 1;
        if (last < 0 || Buffer.byteLength(chunks[last]! + char) > 36)
          chunks.push(char);
        else chunks[last] += char;
        return chunks;
      }, [])
      .map((part) => `=?UTF-8?B?${Buffer.from(part).toString('base64')}?=`)
      .join('\r\n ')}`,
    `Message-ID: ${message.messageId}`,
    `Date: ${new Date().toUTCString()}`,
    'MIME-Version: 1.0',
    `Content-Type: multipart/mixed; boundary="${boundary}"`,
    '',
    `--${boundary}`,
    'Content-Type: text/plain; charset=UTF-8',
    'Content-Transfer-Encoding: base64',
    '',
    wrapBase64(Buffer.from(message.body.replace(/\r?\n/g, '\r\n'))),
    '',
  ];
  for (const attachment of message.attachments) {
    if (
      !/^[a-zA-Z0-9][a-zA-Z0-9 _().-]{0,149}\.(pdf|txt)$/i.test(
        attachment.name,
      ) ||
      !['application/pdf', 'text/plain'].includes(attachment.mimeType)
    )
      throw new EmailProviderError('EMAIL_INVALID_ATTACHMENT');
    parts.push(
      `--${boundary}`,
      `Content-Type: ${attachment.mimeType}`,
      `Content-Disposition: attachment; filename="${attachment.name}"`,
      'Content-Transfer-Encoding: base64',
      '',
      wrapBase64(attachment.buffer),
      '',
    );
  }
  parts.push(`--${boundary}--`, '');
  return Buffer.from(parts.join('\r\n')).toString('base64url');
}
