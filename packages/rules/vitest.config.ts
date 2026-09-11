import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    environment: 'node',
    include: ['src/**/*.test.ts'],
    // Rules tests talk to an emulator over the network; the default 5s timeout
    // is tight for the first connection.
    testTimeout: 20_000,
    hookTimeout: 30_000,
    // One emulator, shared state — parallel files would race each other's data.
    fileParallelism: false,
  },
});
