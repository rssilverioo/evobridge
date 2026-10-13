import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { defineConfig, devices } from '@playwright/test';

const here = path.dirname(fileURLToPath(import.meta.url));
const dataDir = path.join(os.tmpdir(), `evobridge-e2e-${Date.now()}`);
const PORT = 3950;

/**
 * Runs the built EvoBridge (server bundle + static dashboard) against the fake providers.
 * Build first: `pnpm build` at the repo root.
 */
export default defineConfig({
  testDir: './e2e',
  timeout: 60_000,
  fullyParallel: false,
  workers: 1,
  reporter: [['list']],
  use: { baseURL: `http://localhost:${PORT}`, trace: 'retain-on-failure', colorScheme: 'dark' },
  projects: [
    { name: 'desktop', use: { ...devices['Desktop Chrome'], viewport: { width: 1360, height: 900 } } },
  ],
  webServer: [
    {
      command: 'pnpm --filter @evobridge/server demo:providers',
      url: 'http://127.0.0.1:4010/server/ok',
      reuseExistingServer: false,
      cwd: path.resolve(here, '../..'),
    },
    {
      command: 'node ../server/dist/index.js',
      url: `http://localhost:${PORT}/healthz`,
      reuseExistingServer: false,
      env: { NODE_ENV: 'production', DATA_DIR: dataDir, PORT: String(PORT), ALLOW_PRIVATE_NETWORKS: 'true', LOG_LEVEL: 'warn', WEB_DIR: path.resolve(here, 'out') },
    },
  ],
});
