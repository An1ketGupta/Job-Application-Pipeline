import { defineConfig } from 'vitest/config';
import { resolve } from 'node:path';

export default defineConfig({
  resolve: {
    alias: {
      '@': resolve(__dirname, './apps/web/src'),
    },
  },
  test: {
    include: [
      'packages/**/*.{test,spec}.ts',
      'packages/**/*.{test,spec}.tsx',
      'apps/**/*.{test,spec}.ts',
      'apps/**/*.{test,spec}.tsx',
    ],
    exclude: ['**/node_modules/**', '**/*.integration.test.ts'],
  },
});
