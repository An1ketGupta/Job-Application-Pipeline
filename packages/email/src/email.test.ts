import { describe, expect, it, vi } from 'vitest';
import {
  buildMimeMessage,
  encryptSecret,
  decryptSecret,
  GmailProvider,
  oauthAuthorization,
  GMAIL_SEND_SCOPE,
  type GmailConfig,
} from './index.js';
const config: GmailConfig = {
  clientId: 'client.apps.googleusercontent.com',
  clientSecret: 'test-secret',
  redirectUri: 'http://localhost:3001/api/v1/email/oauth/callback',
  webOrigin: 'http://localhost:3000',
  encryptionKey: Buffer.alloc(32, 7).toString('base64'),
  allowSend: true,
};
const outgoing = {
  from: 'owner@gmail.com',
  to: 'jobs@example.com',
  subject: 'Application — AI Intern',
  body: 'Hello\nAniket',
  messageId: '<message-123@careerlift.local>',
  attachments: [
    {
      name: 'Resume.pdf',
      mimeType: 'application/pdf',
      buffer: Buffer.from('%PDF-resume'),
    },
  ],
};
describe('Gmail email transport', () => {
  it('encrypts refresh tokens and binds decryption to their owner', () => {
    const encrypted = encryptSecret(
      'private-refresh-token',
      config.encryptionKey,
      'owner',
    );
    expect(encrypted).not.toContain('private-refresh-token');
    expect(decryptSecret(encrypted, config.encryptionKey, 'owner')).toBe(
      'private-refresh-token',
    );
    expect(() =>
      decryptSecret(encrypted, config.encryptionKey, 'stranger'),
    ).toThrow();
    expect(() =>
      decryptSecret(encrypted.slice(0, -3), config.encryptionKey, 'owner'),
    ).toThrow();
  });
  it('requests narrow sending and identity scopes with offline access and PKCE', () => {
    const url = new URL(oauthAuthorization(config, 'state', 'verifier'));
    expect(url.searchParams.get('scope')).toContain(GMAIL_SEND_SCOPE);
    expect(url.searchParams.get('scope')).not.toContain('gmail.readonly');
    expect(url.searchParams.get('access_type')).toBe('offline');
    expect(url.searchParams.get('code_challenge_method')).toBe('S256');
    expect(
      new URL(
        oauthAuthorization(
          { ...config, expectedSender: 'chosen@gmail.com' },
          'state',
          'verifier',
        ),
      ).searchParams.get('login_hint'),
    ).toBe('chosen@gmail.com');
  });
  it('encodes Unicode subject, plaintext body, and actual attachment bytes in MIME', () => {
    const mime = Buffer.from(
      buildMimeMessage(outgoing),
      'base64url',
    ).toString();
    expect(mime).toContain('To: jobs@example.com');
    expect(mime).toContain('Subject: =?UTF-8?B?');
    expect(mime).toContain('filename="Resume.pdf"');
    expect(mime).toContain(outgoing.attachments[0]!.buffer.toString('base64'));
    expect(() =>
      buildMimeMessage({
        ...outgoing,
        subject: 'bad\r\nBcc: secret@example.com',
      }),
    ).toThrow();
    expect(() =>
      buildMimeMessage({
        ...outgoing,
        to: 'jobs@example.com\r\nBcc: attacker@example.com',
      }),
    ).toThrow();
  });
  it('never retries a send on timeouts or server errors and marks those outcomes uncertain', async () => {
    for (const result of [
      () => {
        throw new Error('socket timeout');
      },
      () => new Response('', { status: 503 }),
    ]) {
      const http = vi.fn(result);
      const provider = new GmailProvider(
        config,
        http as unknown as typeof fetch,
      );
      await expect(
        provider.send('access-token', outgoing),
      ).rejects.toMatchObject({ uncertain: true });
      expect(http).toHaveBeenCalledTimes(1);
    }
    const http = vi.fn(async () => new Response('{}', { status: 429 }));
    await expect(
      new GmailProvider(config, http as typeof fetch).send('token', outgoing),
    ).rejects.toMatchObject({ code: 'EMAIL_RATE_LIMITED', uncertain: false });
  });
  it('gets the sender identity without asking for inbox access', async () => {
    const http = vi.fn(async (url: string | URL | Request) =>
      String(url).includes('/token')
        ? new Response(
            JSON.stringify({
              access_token: 'access',
              refresh_token: 'refresh',
              scope: GMAIL_SEND_SCOPE,
            }),
          )
        : new Response(
            JSON.stringify({ email: 'owner@gmail.com', verified_email: true }),
          ),
    );
    expect(
      await new GmailProvider(config, http as typeof fetch).exchange(
        'code',
        'verifier',
      ),
    ).toEqual({ address: 'owner@gmail.com', refreshToken: 'refresh' });
    expect(http.mock.calls[1]?.[0]).toBe(
      'https://www.googleapis.com/oauth2/v2/userinfo',
    );
  });
});
