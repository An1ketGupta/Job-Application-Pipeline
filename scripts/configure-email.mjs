/* global process, URL, console */
import { readFile, writeFile } from 'node:fs/promises';
import { randomBytes } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { resolve } from 'node:path';

const root = fileURLToPath(new URL('../', import.meta.url));
const envPath = resolve(root, '.env');
const args = process.argv.slice(2);
let content = await readFile(envPath, 'utf8').catch(() => '');
const existing = (key) =>
  content
    .split(/\r?\n/)
    .find((line) => line.startsWith(`${key}=`))
    ?.slice(key.length + 1)
    .trim();
function set(key, value, onlyMissing = false) {
  if (onlyMissing && existing(key)) return;
  const line = `${key}=${JSON.stringify(value)}`;
  const pattern = new RegExp(`^${key}=.*$`, 'm');
  content = pattern.test(content)
    ? content.replace(pattern, () => line)
    : `${content.trimEnd()}\n${line}\n`;
}
set('GMAIL_CLIENT_ID', '', true);
set('GMAIL_CLIENT_SECRET', '', true);
set(
  'GMAIL_REDIRECT_URI',
  'http://localhost:3001/api/v1/email/oauth/callback',
  true,
);
set('EMAIL_WEB_ORIGIN', 'http://localhost:3000', true);
set('EMAIL_ENCRYPTION_KEY', randomBytes(32).toString('base64'), true);
set('EMAIL_ALLOW_SEND', 'false', true);
set('GEMINI_API_KEY', '', true);
set('EMAIL_GEMINI_MODEL', 'gemini-3.5-flash-lite', true);
const options = new Map();
for (let i = 0; i < args.length; i++) {
  if (args[i] === '--enable-sending') {
    set('EMAIL_ALLOW_SEND', 'true');
    continue;
  }
  if (
    !['--google-client', '--sender', '--name', '--test-recipient'].includes(
      args[i],
    )
  )
    throw new Error(
      'Use --google-client <JSON path>, --sender <address>, --name <display name>, --test-recipient <address>, or --enable-sending.',
    );
  if (!args[i + 1]) throw new Error('Option requires a value.');
  options.set(args[i], args[++i]);
}
if (options.has('--google-client')) {
  const credentials = JSON.parse(
    await readFile(resolve(options.get('--google-client')), 'utf8'),
  );
  const web = credentials.web;
  if (
    !web?.client_id ||
    !web?.client_secret ||
    !web.client_id.endsWith('.apps.googleusercontent.com')
  )
    throw new Error(
      'Download OAuth credentials of type Web application from Google Cloud.',
    );
  set('GMAIL_CLIENT_ID', web.client_id);
  set('GMAIL_CLIENT_SECRET', web.client_secret);
}
if (options.has('--sender'))
  set('EMAIL_EXPECTED_SENDER', options.get('--sender'));
if (options.has('--name'))
  set('EMAIL_DEFAULT_SENDER_NAME', options.get('--name'));
if (options.has('--test-recipient'))
  set('EMAIL_TEST_RECIPIENT', options.get('--test-recipient'));
await writeFile(envPath, content, { mode: 0o600 });
console.log(
  'Email configuration saved locally. Credentials are not printed. Add GEMINI_API_KEY and restart the API and worker.',
);
