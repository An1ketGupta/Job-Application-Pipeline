import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    include: ['apps/**/*.integration.test.ts'],
    fileParallelism: false,
    exclude: ['**/node_modules/**'],
    testTimeout: 30000,
    hookTimeout: 30000,
  },
});
