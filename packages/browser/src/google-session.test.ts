import { describe, expect, it } from 'vitest';
import {
  googleSessionState,
  WindowsGoogleSessionVault,
  type GoogleStorageState,
} from './google-session.js';

const state: GoogleStorageState = {
  cookies: [
    {
      name: 'controlled-session',
      value: 'fixture-secret-value',
      domain: '.google.com',
      path: '/',
      expires: -1,
      httpOnly: true,
      secure: true,
      sameSite: 'Lax',
    },
  ],
  origins: [
    {
      origin: 'https://docs.google.com',
      localStorage: [{ name: 'fixture', value: 'controlled' }],
    },
  ],
};
describe('dedicated Google Forms session', () => {
  it('filters unrelated browser cookies and storage', () => {
    const unrelated = { ...state.cookies[0]!, domain: '.example.com' };
    expect(
      googleSessionState({
        cookies: [...state.cookies, unrelated],
        origins: [
          ...state.origins,
          { origin: 'https://example.com', localStorage: [] },
        ],
      }),
    ).toEqual(state);
  });
  it.runIf(process.platform === 'win32')(
    'encrypts with Windows CurrentUser DPAPI and rejects tampered ciphertext',
    async () => {
      const vault = new WindowsGoogleSessionVault();
      const encrypted = await vault.seal(state);
      expect(encrypted).not.toContain('fixture-secret-value');
      expect(await vault.open(encrypted)).toEqual(state);
      await expect(
        vault.open(Buffer.from('tampered').toString('base64')),
      ).rejects.toThrow('GOOGLE_SESSION_VAULT_UNAVAILABLE');
      await expect(
        vault.open(
          await vault.seal({
            cookies: [{ ...state.cookies[0]!, domain: '.example.com' }],
            origins: [],
          }),
        ),
      ).rejects.toThrow('GOOGLE_SESSION_INVALID_ORIGIN');
    },
    30000,
  );
});
