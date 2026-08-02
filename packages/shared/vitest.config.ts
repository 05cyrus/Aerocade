import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    // Simulation tests step thousands of fixed ticks; on a CPU-constrained
    // machine running several files in parallel the 5 s default is too tight
    // and produces flaky timeouts rather than real failures.
    testTimeout: 30_000,
  },
});
