import { defineConfig } from 'vitest/config';
export default defineConfig({
  test: {
    include: ['tests/**/*.test.ts', 'src/**/*.test.ts'],
    environment: 'node',
    // real-APK tests (skipped when the user's APKs are absent) are slow, especially under v8 coverage
    testTimeout: 600_000,
    hookTimeout: 600_000,
    coverage: {
      provider: 'v8',
      include: ['src/**/*.ts'],
      exclude: ['**/*.test.ts', 'src/**/*.d.ts'],
      thresholds: { statements: 100, branches: 100, functions: 100, lines: 100 }
    }
  }
});
