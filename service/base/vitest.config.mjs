import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    testTimeout: 30_000,
    hookTimeout: 30_000,
    maxConcurrency: 4,
    poolOptions: {
      threads: {
        maxThreads: 2,
        minThreads: 1,
      },
      forks: {
        maxForks: 2,
        minForks: 1,
      },
    },
  },
});
