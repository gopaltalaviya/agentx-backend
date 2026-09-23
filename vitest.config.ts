import {defineConfig} from 'vitest/config';

export default defineConfig({
  test: {
    include: ['packages/*/test/**/*.test.ts', 'apps/*/test/**/*.test.ts'],
    // The API tests share one Postgres schema and TRUNCATE between cases, so
    // they must not run concurrently with each other.
    fileParallelism: false,
    testTimeout: 30_000,
  },
});
