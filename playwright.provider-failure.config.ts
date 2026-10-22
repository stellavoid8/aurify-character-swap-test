import { defineConfig } from '@playwright/test';
import base from './playwright.config';
import { E2E, baseUrl, serverEnv } from './e2e/env';

/** Second e2e pass: only @provider-failure tests, against a server whose mock fal fails every attempt. */

const port = E2E.failurePort;

export default defineConfig({
  ...base,
  grep: /@provider-failure/,
  grepInvert: undefined,
  use: { ...base.use, baseURL: baseUrl(port) },
  webServer: {
    command: `npm run dev -- --port ${port}`,
    url: `${baseUrl(port)}/gate`,
    env: serverEnv(port, 'always'),
    reuseExistingServer: !process.env.CI,
    timeout: 180_000,
    stdout: 'ignore',
    stderr: 'pipe',
  },
});
