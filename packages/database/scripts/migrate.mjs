/* global URL, process */
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { resolve } from 'node:path';
import dotenv from 'dotenv';

const databaseDir = fileURLToPath(new URL('..', import.meta.url));
const rootEnv = fileURLToPath(new URL('../../../.env', import.meta.url));
dotenv.config({ path: rootEnv });
if (!process.env.DATABASE_URL) {
  throw new Error(
    'DATABASE_URL is required; copy .env.example to .env and configure PostgreSQL',
  );
}
const prismaCli = resolve(databaseDir, 'node_modules/prisma/build/index.js');
const result = spawnSync(
  process.execPath,
  [prismaCli, 'migrate', process.argv.includes('--deploy') ? 'deploy' : 'dev'],
  {
    cwd: databaseDir,
    env: process.env,
    stdio: 'inherit',
  },
);
if (result.error) throw result.error;
process.exit(result.status ?? 1);
