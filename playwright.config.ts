import { defineConfig, devices } from '@playwright/test';
import { E2E, baseUrl, serverEnv } from './e2e/env';

/**
 * End-to-end smoke tests on mocks. The server is `next dev`, not `next build && next start`: a production
 * server refuses to start without real provider keys (lib/env.ts), and `next start` only serves the
 * public/ files that existed at build time, so the local-storage uploads would 404. CI builds separately.
 *
 * Tests tagged @provider-failure need MOCK_FAL_FAILURE_MODE=always, so they run in a second pass with its
 * own server: playwright.provider-failure.config.ts (`npm run test:e2e` runs both).
 */

const port = E2E.port;

export default defineConfig({
  testDir: './e2e',
  testMatch: '*.spec.ts',
  grepInvert: /@provider-failure/,
  globalSetup: './e2e/global-setup.ts',
  globalTeardown: './e2e/global-teardown.ts',
  // A dev server compiles each route on first use; a whole job takes ~10 s on the mock provider.
  timeout: 180_000,
  expect: { timeout: 15_000 },
  fullyParallel: false,
  workers: process.env.CI ? 2 : 3,
  retries: process.env.CI ? 1 : 0,
  forbidOnly: !!process.env.CI,
  reporter: process.env.CI ? [['github'], ['html', { open: 'never' }]] : 'list',
  use: {
    baseURL: baseUrl(port),
    navigationTimeout: 90_000,
    actionTimeout: 30_000,
    trace: 'retain-on-failure',
    screenshot: 'only-on-failure',
  },
  projects: [
    { name: 'Mobile Safari', use: { ...devices['iPhone 14'] } },
    { name: 'Desktop Chrome', use: { ...devices['Desktop Chrome'] } },
    { name: 'Desktop Safari', use: { ...devices['Desktop Safari'] } },
  ],
  webServer: {
    command: `npm run dev -- --port ${port}`,
    url: `${baseUrl(port)}/gate`,
    env: serverEnv(port, 'none'),
    reuseExistingServer: !process.env.CI,
    timeout: 180_000,
    stdout: 'ignore',
    stderr: 'pipe',
  },
});
