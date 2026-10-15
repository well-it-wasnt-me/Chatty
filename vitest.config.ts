import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    include: ['src/**/*.test.ts'],
    // Tests must be hermetic: no real messaging accounts or network access.
    environment: 'node',
    testTimeout: 10_000,
  },
});
