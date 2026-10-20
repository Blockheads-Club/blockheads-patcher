import { defineConfig } from '@playwright/test';
// E2E_PORT lets a run use another port when 4173 is taken by something else.
const port = Number(process.env.E2E_PORT ?? 4173);
// BASE_PATH (e.g. /patcher) builds and previews the app under that sub-path; tests navigate relative to baseURL ('./').
const base = (process.env.BASE_PATH ?? '').replace(/\/+$/, '');
export default defineConfig({
  testDir: 'tests/e2e',
  webServer: { command: `bun run build && bun run preview --port ${port} --strictPort`, port, reuseExistingServer: true },
  use: { baseURL: `http://localhost:${port}${base}/` }
});
