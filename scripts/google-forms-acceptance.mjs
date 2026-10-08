import { spawnSync } from 'node:child_process';
import { fileURLToPath, URL } from 'node:url';
import { resolve } from 'node:path';
import process from 'node:process';

const root = fileURLToPath(new URL('..', import.meta.url));
const database =
  process.env.INTEGRATION_DATABASE_URL ||
  'postgresql://careerlift_test:careerlift_test@localhost:55432/careerlift_test?schema=public';
const redis = process.env.INTEGRATION_REDIS_URL || 'redis://localhost:56379';
if (!/\/careerlift_test(?:\?|$)/.test(database))
  throw new Error(
    'Google Forms acceptance requires the isolated careerlift_test database.',
  );
const env = {
  ...process.env,
  INTEGRATION_DATABASE_URL: database,
  INTEGRATION_REDIS_URL: redis,
  DATABASE_URL: database,
  NODE_ENV: 'test',
};
const cli = resolve(root, 'node_modules/vitest/vitest.mjs');
const result = spawnSync(
  process.execPath,
  [
    cli,
    'run',
    '--config',
    'vitest.integration.config.ts',
    'apps/api/src/google-forms.integration.test.ts',
  ],
  { cwd: root, env, stdio: 'inherit' },
);
process.exit(result.status ?? 1);
