import { z } from 'zod';

/**
 * Server environment, validated once when this module is first imported.
 * Dev runs with only DATABASE_URL; everything else falls back to dev values or mocks.
 * In production every secret and provider key is required, and a missing one fails startup.
 */

const DEV_FALLBACKS = {
  SESSION_SECRET: 'dev-session-secret-change-me',
  ACCESS_CODE: 'dev-access',
  APP_URL: 'http://localhost:3000',
  WEBHOOK_SECRET: 'dev-webhook-secret',
  CRON_SECRET: 'dev-cron-secret',
} as const;

/** Required when NODE_ENV=production. The description is shown in the startup error. */
const PRODUCTION_REQUIRED = {
  SESSION_SECRET: 'signs the access cookie',
  ACCESS_CODE: 'the shared code entered at /gate',
  APP_URL: 'public base URL, used for fal webhook callbacks',
  WEBHOOK_SECRET: 'signs per-candidate webhook tokens',
  CRON_SECRET: 'bearer token Vercel Cron sends to /api/cron/cleanup',
  FAL_KEY: 'fal.ai API key; without it image generation would be mocked',
  ANTHROPIC_API_KEY: 'Anthropic API key; without it template analysis would be mocked',
  BLOB_READ_WRITE_TOKEN: 'Vercel Blob token; without it uploads would go to local disk',
} as const;

const wholeNumber = (fallback: number) =>
  z.coerce
    .number({ error: 'must be a whole number' })
    .int({ error: 'must be a whole number' })
    .positive({ error: 'must be greater than 0' })
    .default(fallback);

const postgresUrl = /^postgres(ql)?:\/\//;
const BUILD_DATABASE_URL = 'postgres://build-placeholder.invalid:5432/unused';

const schema = z.object({
  DATABASE_URL: z
    .string({ error: 'is required (Postgres connection string)' })
    .regex(postgresUrl, { error: 'must start with postgres:// or postgresql://' }),
  DIRECT_URL: z.string().regex(postgresUrl, { error: 'must start with postgres:// or postgresql://' }).optional(),
  SESSION_SECRET: z.string().optional(),
  ACCESS_CODE: z.string().optional(),
  APP_URL: z
    .url({ error: 'must be a full URL such as https://example.com' })
    .transform((url) => url.replace(/\/+$/, ''))
    .optional(),
  WEBHOOK_SECRET: z.string().optional(),
  CRON_SECRET: z.string().optional(),
  FAL_KEY: z.string().optional(),
  ANTHROPIC_API_KEY: z.string().optional(),
  BLOB_READ_WRITE_TOKEN: z.string().optional(),
  GLOBAL_DAILY_UNITS: wholeNumber(150),
  RETENTION_DAYS: wholeNumber(10),
  FACE_ENGINE: z.enum(['auto', 'onnx', 'mock'], { error: 'must be one of auto, onnx, mock' }).default('auto'),
  MOCK_FAL_FAILURE_MODE: z
    .enum(['none', 'once', 'always'], { error: 'must be one of none, once, always' })
    .default('none'),
});

function loadEnv() {
  // Treat empty strings (e.g. `FAL_KEY=` copied from .env.example) as unset.
  const raw: Record<string, string | undefined> = {};
  for (const key of Object.keys(schema.shape)) {
    const value = process.env[key]?.trim();
    raw[key] = value ? value : undefined;
  }

  const isProduction = process.env.NODE_ENV === 'production';
  // `next build` imports server modules to collect page data but never queries the database or calls a provider,
  // so secrets and DATABASE_URL are enforced when the server starts, not while compiling.
  const isBuild = process.env.NEXT_PHASE === 'phase-production-build';
  const enforceProduction = isProduction && !isBuild;
  // The postgres client connects lazily, so this placeholder is never dialled during the build.
  if (isBuild) raw.DATABASE_URL ??= BUILD_DATABASE_URL;

  const problems: string[] = [];
  const parsed = schema.safeParse(raw);
  if (!parsed.success) {
    for (const issue of parsed.error.issues) problems.push(`${issue.path.join('.')} ${issue.message}`);
  }
  if (enforceProduction) {
    for (const [key, why] of Object.entries(PRODUCTION_REQUIRED)) {
      if (!raw[key]) problems.push(`${key} is required in production (${why})`);
    }
  }
  if (!parsed.success || problems.length > 0) {
    throw new Error(
      `Invalid environment configuration:\n${problems.map((p) => `  - ${p}`).join('\n')}\nSee .env.example.`,
    );
  }

  const values = parsed.data;
  return {
    ...values,
    SESSION_SECRET: values.SESSION_SECRET ?? DEV_FALLBACKS.SESSION_SECRET,
    ACCESS_CODE: values.ACCESS_CODE ?? DEV_FALLBACKS.ACCESS_CODE,
    APP_URL: values.APP_URL ?? DEV_FALLBACKS.APP_URL,
    WEBHOOK_SECRET: values.WEBHOOK_SECRET ?? DEV_FALLBACKS.WEBHOOK_SECRET,
    CRON_SECRET: values.CRON_SECRET ?? DEV_FALLBACKS.CRON_SECRET,
    isProduction,
    useMockFal: !values.FAL_KEY,
    useMockAi: !values.ANTHROPIC_API_KEY,
    useLocalStorage: !values.BLOB_READ_WRITE_TOKEN,
  };
}

export type Env = ReturnType<typeof loadEnv>;

export const env: Env = loadEnv();

export const { useMockFal, useMockAi, useLocalStorage } = env;
