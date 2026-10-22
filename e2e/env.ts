import { loadEnvConfig } from '@next/env';

/**
 * Settings shared by the Playwright configs, the server they start and the db helper.
 * The e2e server always runs on mocks (fal, Claude, local storage, face engine) whatever
 * `.env.local` holds; only DATABASE_URL comes from the environment, because it needs a real Postgres.
 */

// DATABASE_URL from .env.local locally; CI sets it on the job.
loadEnvConfig(process.cwd(), true, { info: () => {}, error: console.error });

export const E2E = {
  accessCode: 'e2e-access',
  sessionSecret: 'e2e-session-secret',
  webhookSecret: 'e2e-webhook-secret',
  cronSecret: 'e2e-cron-secret',
  /** Main suite. */
  port: 3100,
  /** The MOCK_FAL_FAILURE_MODE=always pass (playwright.provider-failure.config.ts). */
  failurePort: 3101,
} as const;

export function databaseUrl(): string {
  const url = process.env.DATABASE_URL;
  if (!url) throw new Error('e2e needs DATABASE_URL (a real Postgres with the migrations applied): set it or add it to .env.local.');
  return url;
}

export const baseUrl = (port: number) => `http://localhost:${port}`;

/**
 * The dev server's environment. Empty strings beat `.env.local` (Next never overrides a variable that is
 * already set) and lib/env.ts treats them as unset, which selects the mocks.
 */
export function serverEnv(port: number, failureMode: 'none' | 'always'): Record<string, string> {
  return {
    DATABASE_URL: databaseUrl(),
    ACCESS_CODE: E2E.accessCode,
    SESSION_SECRET: E2E.sessionSecret,
    WEBHOOK_SECRET: E2E.webhookSecret,
    CRON_SECRET: E2E.cronSecret,
    APP_URL: baseUrl(port),
    FAL_KEY: '',
    ANTHROPIC_API_KEY: '',
    BLOB_READ_WRITE_TOKEN: '',
    FACE_ENGINE: 'mock',
    MOCK_FAL_FAILURE_MODE: failureMode,
    // The specs seed whole days of rounds; the global cap must never be what stops them.
    GLOBAL_DAILY_UNITS: '1000000',
    NEXT_TELEMETRY_DISABLED: '1',
  };
}
