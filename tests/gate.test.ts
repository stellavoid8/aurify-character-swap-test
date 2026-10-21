import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const cookieJar = new Map<string, { value: string; options?: Record<string, unknown> }>();
const requestHeaders = new Headers();

vi.mock('next/headers', () => ({
  cookies: async () => ({
    get: (name: string) => (cookieJar.has(name) ? { name, value: cookieJar.get(name)!.value } : undefined),
    set: (name: string, value: string, options?: Record<string, unknown>) => cookieJar.set(name, { value, options }),
  }),
  headers: async () => requestHeaders,
}));

class RedirectSignal extends Error {
  constructor(readonly url: string) {
    super(`NEXT_REDIRECT ${url}`);
  }
}
vi.mock('next/navigation', () => ({
  redirect: (url: string) => {
    throw new RedirectSignal(url);
  },
}));

vi.mock('@/lib/limits', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/lib/limits')>()),
  GATE_FAIL_DELAY_MS: 0,
}));

function form(code: string, next?: string): FormData {
  const data = new FormData();
  data.set('code', code);
  if (next !== undefined) data.set('next', next);
  return data;
}

async function submit(code: string, next?: string) {
  const { submitGate } = await import('@/server/gate/actions');
  try {
    return { result: await submitGate(null, form(code, next)), redirectedTo: null };
  } catch (err) {
    if (err instanceof RedirectSignal) return { result: null, redirectedTo: err.url };
    throw err;
  }
}

describe('submitGate', () => {
  beforeEach(async () => {
    vi.stubEnv('DATABASE_URL', 'postgres://localhost:5432/test');
    vi.stubEnv('ACCESS_CODE', 'open-sesame');
    vi.stubEnv('SESSION_SECRET', 'test-secret');
    cookieJar.clear();
    requestHeaders.set('x-forwarded-for', '203.0.113.7, 10.0.0.1');
    (await import('@/server/gate/attempts')).resetAttempts();
  });

  afterEach(() => {
    vi.unstubAllEnvs();
  });

  it('rejects a wrong code without setting a cookie', async () => {
    const { result } = await submit('nope');
    expect(result).toEqual({ ok: false, error: { code: 'INVALID_ACCESS_CODE', message: "That code didn't work." } });
    expect(cookieJar.has('cs_session')).toBe(false);
  });

  it('treats an empty code as wrong', async () => {
    const { result } = await submit('   ');
    expect(result).toMatchObject({ ok: false, error: { code: 'INVALID_ACCESS_CODE' } });
  });

  it('sets an httpOnly session cookie and redirects to next on the right code', async () => {
    const { redirectedTo } = await submit('  open-sesame ', '/jobs/abc');
    expect(redirectedTo).toBe('/jobs/abc');
    const cookie = cookieJar.get('cs_session');
    expect(cookie?.options).toMatchObject({ httpOnly: true, sameSite: 'lax', path: '/', maxAge: 14 * 24 * 60 * 60 });
    const { verifySession } = await import('@/lib/session');
    await expect(verifySession(cookie?.value)).resolves.toMatchObject({ sid: expect.any(String) });
  });

  it('blocks open redirects', async () => {
    expect((await submit('open-sesame', '//evil.com')).redirectedTo).toBe('/');
    expect((await submit('open-sesame', 'https://evil.com')).redirectedTo).toBe('/');
    expect((await submit('open-sesame')).redirectedTo).toBe('/');
  });

  it('keeps the existing sid when a valid cookie is present', async () => {
    const { signSession, verifySession, newSessionPayload } = await import('@/lib/session');
    const sid = crypto.randomUUID();
    cookieJar.set('cs_session', { value: await signSession(newSessionPayload(sid)) });
    await submit('open-sesame');
    await expect(verifySession(cookieJar.get('cs_session')?.value)).resolves.toMatchObject({ sid });
  });

  it('locks an IP out on the 11th wrong attempt, even with the right code', async () => {
    for (let i = 0; i < 10; i++) {
      expect((await submit(`wrong-${i}`)).result).toMatchObject({ error: { code: 'INVALID_ACCESS_CODE' } });
    }
    expect((await submit('wrong-10')).result).toMatchObject({ error: { code: 'TOO_MANY_ATTEMPTS' } });
    expect((await submit('open-sesame')).result).toMatchObject({ error: { code: 'TOO_MANY_ATTEMPTS' } });

    // Other IPs are unaffected.
    requestHeaders.set('x-forwarded-for', '198.51.100.2');
    expect((await submit('open-sesame')).redirectedTo).toBe('/');
  });

  it('lets the IP back in after the window passes', async () => {
    vi.useFakeTimers({ toFake: ['Date'] });
    try {
      for (let i = 0; i < 10; i++) await submit('wrong');
      expect((await submit('wrong')).result).toMatchObject({ error: { code: 'TOO_MANY_ATTEMPTS' } });
      vi.setSystemTime(Date.now() + 15 * 60_000 + 1);
      expect((await submit('open-sesame')).redirectedTo).toBe('/');
    } finally {
      vi.useRealTimers();
    }
  });
});
