import { defineConfig } from 'vitest/config';
export default defineConfig({
  test: {
    include: ['tests/**/*.test.ts', 'src/**/*.test.ts'],
    environment: 'node',
    // real game APKs are opened once per run (globalSetup) and their entry digests shared with every worker
    globalSetup: ['tests/setup/global-real-apks.ts'],
    setupFiles: ['tests/setup/seed-real-apks.ts'],
    // real-APK tests (skipped when the user's APKs are absent) are slow, especially under v8 coverage
    testTimeout: 600_000,
    // The real-APK suites are CPU-heavy (inflate, dex serialization, d8/dexdump JVMs): one worker per core oversubscribes
    // the machine, and a worker blocked for a minute fails the run with a vitest RPC timeout.
    maxWorkers: '50%',
    hookTimeout: 600_000,
    coverage: {
      provider: 'v8',
      include: ['src/**/*.ts'],
      exclude: ['**/*.test.ts', 'src/**/*.d.ts'],
      thresholds: { statements: 100, branches: 100, functions: 100, lines: 100 }
    }
  }
});
