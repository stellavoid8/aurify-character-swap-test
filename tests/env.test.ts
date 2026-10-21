import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const OPTIONAL = [
  'DIRECT_URL',
  'SESSION_SECRET',
  'ACCESS_CODE',
  'APP_URL',
  'WEBHOOK_SECRET',
  'CRON_SECRET',
  'FAL_KEY',
  'ANTHROPIC_API_KEY',
  'BLOB_READ_WRITE_TOKEN',
  'GLOBAL_DAILY_UNITS',
  'RETENTION_DAYS',
  'FACE_ENGINE',
  'MOCK_FAL_FAILURE_MODE',
  'NEXT_PHASE',
];

const loadEnv = async () => (await import('@/lib/env')).env;

describe('lib/env', () => {
  beforeEach(() => {
    vi.resetModules();
    for (const key of OPTIONAL) vi.stubEnv(key, undefined);
    vi.stubEnv('DATABASE_URL', 'postgres://localhost:5432/test');
  });

  afterEach(() => {
    vi.unstubAllEnvs();
  });

  it('runs in dev with only DATABASE_URL, using mocks and fallbacks', async () => {
    vi.stubEnv('NODE_ENV', 'development');
    const env = await loadEnv();
    expect(env.useMockFal).toBe(true);
    expect(env.useMockAi).toBe(true);
    expect(env.useLocalStorage).toBe(true);
    expect(env.ACCESS_CODE).toBe('dev-access');
    expect(env.APP_URL).toBe('http://localhost:3000');
    expect(env.GLOBAL_DAILY_UNITS).toBe(150);
    expect(env.RETENTION_DAYS).toBe(10);
    expect(env.FACE_ENGINE).toBe('auto');
    expect(env.MOCK_FAL_FAILURE_MODE).toBe('none');
  });

  it('treats empty values as unset', async () => {
    vi.stubEnv('FAL_KEY', '');
    vi.stubEnv('GLOBAL_DAILY_UNITS', '');
    const env = await loadEnv();
    expect(env.useMockFal).toBe(true);
    expect(env.GLOBAL_DAILY_UNITS).toBe(150);
  });

  it('reads an optional DIRECT_URL for migrations', async () => {
    expect((await loadEnv()).DIRECT_URL).toBeUndefined();
    vi.resetModules();
    vi.stubEnv('DIRECT_URL', 'postgresql://postgres:pw@pooler.supabase.com:5432/postgres');
    expect((await loadEnv()).DIRECT_URL).toBe('postgresql://postgres:pw@pooler.supabase.com:5432/postgres');
  });

  it('rejects a DIRECT_URL that is not a Postgres URL', async () => {
    vi.stubEnv('DIRECT_URL', 'https://example.supabase.co');
    await expect(loadEnv()).rejects.toThrow(/DIRECT_URL must start with postgres/);
  });

  it('requires DATABASE_URL', async () => {
    vi.stubEnv('DATABASE_URL', undefined);
    await expect(loadEnv()).rejects.toThrow(/DATABASE_URL is required/);
  });

  it('names a missing production variable', async () => {
    vi.stubEnv('NODE_ENV', 'production');
    for (const key of OPTIONAL.slice(0, 8)) vi.stubEnv(key, key === 'APP_URL' ? 'https://swap.example.com' : 'x');
    vi.stubEnv('FAL_KEY', undefined);
    await expect(loadEnv()).rejects.toThrow(/FAL_KEY is required in production/);
  });

  it('does not enforce production secrets during next build', async () => {
    vi.stubEnv('NODE_ENV', 'production');
    vi.stubEnv('NEXT_PHASE', 'phase-production-build');
    await expect(loadEnv()).resolves.toMatchObject({ useMockFal: true });
  });

  it('does not require DATABASE_URL during next build', async () => {
    vi.stubEnv('NODE_ENV', 'production');
    vi.stubEnv('NEXT_PHASE', 'phase-production-build');
    vi.stubEnv('DATABASE_URL', undefined);
    await expect(loadEnv()).resolves.toMatchObject({ DATABASE_URL: expect.stringMatching(/^postgres:\/\//) });
  });

  it('rejects malformed numbers and enums', async () => {
    vi.stubEnv('RETENTION_DAYS', 'ten');
    vi.stubEnv('FACE_ENGINE', 'gpu');
    await expect(loadEnv()).rejects.toThrow(/RETENTION_DAYS must be a whole number[\s\S]*FACE_ENGINE must be one of/);
  });
});
