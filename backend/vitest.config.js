import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    environment: 'node',
    include: ['tests/**/*.test.js'],
    testTimeout: 20_000,
    hookTimeout: 60_000,
    restoreMocks: true,
  },
});
