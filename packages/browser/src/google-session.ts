import { spawn } from 'node:child_process';
import { z } from 'zod';
import type { BrowserContext } from 'playwright';

export type GoogleStorageState = Awaited<
  ReturnType<BrowserContext['storageState']>
>;
// Windows CurrentUser DPAPI binds session credentials to this Windows account.
// Only ciphertext is persisted. No browser profile, cookies, or token values are logged.
export class WindowsGoogleSessionVault {
  private transform(value: string, protect: boolean): Promise<string> {
    if (process.platform !== 'win32')
      return Promise.reject(new Error('GOOGLE_SESSION_WINDOWS_REQUIRED'));
    const script = `Add-Type -AssemblyName System.Security; $b=[Convert]::FromBase64String([Console]::In.ReadToEnd()); $e=[Text.Encoding]::UTF8.GetBytes('CareerLift.GoogleForms.v1'); $r=[Security.Cryptography.ProtectedData]::${protect ? 'Protect' : 'Unprotect'}($b,$e,[Security.Cryptography.DataProtectionScope]::CurrentUser); [Console]::Out.Write([Convert]::ToBase64String($r))`;
    return new Promise((resolve, reject) => {
      const child = spawn(
        'powershell.exe',
        [
          '-NoProfile',
          '-NonInteractive',
          '-WindowStyle',
          'Hidden',
          '-Command',
          script,
        ],
        { windowsHide: true, stdio: ['pipe', 'pipe', 'pipe'] },
      );
      let output = '';
      const timer = setTimeout(() => {
        child.kill();
        reject(new Error('GOOGLE_SESSION_VAULT_TIMEOUT'));
      }, 15000);
      child.stdout.on('data', (data: Buffer) => {
        output += data.toString();
        if (output.length > 4 * 1024 * 1024) child.kill();
      });
      child.stderr.resume();
      child.on('error', () => {
        clearTimeout(timer);
        reject(new Error('GOOGLE_SESSION_VAULT_UNAVAILABLE'));
      });
      child.on('close', (code) => {
        clearTimeout(timer);
        if (code === 0 && /^[A-Za-z0-9+/=]+$/.test(output)) resolve(output);
        else reject(new Error('GOOGLE_SESSION_VAULT_UNAVAILABLE'));
      });
      child.stdin.end(value);
    });
  }
  async seal(state: GoogleStorageState): Promise<string> {
    return this.transform(
      Buffer.from(JSON.stringify(state)).toString('base64'),
      true,
    );
  }
  async open(ciphertext: string): Promise<GoogleStorageState> {
    const decoded = Buffer.from(
      await this.transform(ciphertext, false),
      'base64',
    ).toString('utf8');
    const parsed = z
      .object({
        cookies: z.array(
          z.object({
            name: z.string(),
            value: z.string(),
            domain: z.string(),
            path: z.string(),
            expires: z.number(),
            httpOnly: z.boolean(),
            secure: z.boolean(),
            sameSite: z.enum(['Strict', 'Lax', 'None']),
          }),
        ),
        origins: z.array(
          z.object({
            origin: z.string().url(),
            localStorage: z.array(
              z.object({ name: z.string(), value: z.string() }),
            ),
          }),
        ),
      })
      .parse(JSON.parse(decoded));
    if (
      parsed.cookies.some(
        (c) => !/(^|\.)google\.com$/.test(c.domain.replace(/^\./, '')),
      ) ||
      parsed.origins.some(
        (o) =>
          !['https://accounts.google.com', 'https://docs.google.com'].includes(
            o.origin,
          ),
      )
    )
      throw new Error('GOOGLE_SESSION_INVALID_ORIGIN');
    return parsed;
  }
}
export function googleSessionState(
  state: GoogleStorageState,
): GoogleStorageState {
  return {
    cookies: state.cookies.filter((c) =>
      /(^|\.)google\.com$/.test(c.domain.replace(/^\./, '')),
    ),
    origins: state.origins.filter((o) =>
      ['https://accounts.google.com', 'https://docs.google.com'].includes(
        o.origin,
      ),
    ),
  };
}
