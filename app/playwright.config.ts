import { defineConfig } from '@playwright/test';
export default defineConfig({
  testDir: 'tests/e2e',
  webServer: { command: 'bun run build && bun run preview --port 4173', port: 4173, reuseExistingServer: true },
  use: { baseURL: 'http://localhost:4173' }
});
