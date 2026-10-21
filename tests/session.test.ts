import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const SID = '6f1c1c3e-3f6b-4b8e-9a51-1d2f0c4e7a90';

const loadSession = () => import('@/lib/session');

function b64url(value: string): string {
  return Buffer.from(value).toString('base64url');
}

describe('lib/session', () => {
  beforeEach(() => {
    vi.resetModules();
    vi.stubEnv('DATABASE_URL', 'postgres://localhost:5432/test');
    vi.stubEnv('SESSION_SECRET', 'test-secret');
  });

  afterEach(() => {
    vi.unstubAllEnvs();
    vi.useRealTimers();
  });

  it('round-trips a signed session', async () => {
    const { signSession, verifySession, newSessionPayload } = await loadSession();
    const payload = newSessionPayload(SID);
    const token = await signSession(payload);
    expect(token).toMatch(/^[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+$/);
    await expect(verifySession(token)).resolves.toEqual(payload);
  });

  it('gives new sessions a random sid and a 14-day expiry', async () => {
    const { newSessionPayload, SESSION_TTL_DAYS } = await loadSession();
    const a = newSessionPayload();
    const b = newSessionPayload();
    expect(a.sid).not.toBe(b.sid);
    expect(SESSION_TTL_DAYS).toBe(14);
    expect(a.exp - Math.floor(Date.now() / 1000)).toBe(14 * 24 * 60 * 60);
  });

  it('rejects a tampered payload', async () => {
    const { signSession, verifySession, newSessionPayload } = await loadSession();
    const token = await signSession(newSessionPayload(SID));
    const [, signature] = token.split('.');
    const forged = b64url(JSON.stringify({ sid: crypto.randomUUID(), exp: 9_999_999_999 }));
    await expect(verifySession(`${forged}.${signature}`)).resolves.toBeNull();
  });

  it('rejects a tampered signature', async () => {
    const { signSession, verifySession, newSessionPayload } = await loadSession();
    const token = await signSession(newSessionPayload(SID));
    const last = token.at(-1) === 'A' ? 'B' : 'A';
    await expect(verifySession(token.slice(0, -1) + last)).resolves.toBeNull();
  });

  it('rejects a token signed with another secret', async () => {
    const { signSession, newSessionPayload } = await loadSession();
    const token = await signSession(newSessionPayload(SID));
    vi.resetModules();
    vi.stubEnv('SESSION_SECRET', 'other-secret');
    const { verifySession } = await loadSession();
    await expect(verifySession(token)).resolves.toBeNull();
  });

  it('rejects an expired session', async () => {
    const { signSession, verifySession } = await loadSession();
    const token = await signSession({ sid: SID, exp: Math.floor(Date.now() / 1000) + 60 });
    await expect(verifySession(token)).resolves.not.toBeNull();
    vi.useFakeTimers({ now: Date.now() + 61_000 });
    await expect(verifySession(token)).resolves.toBeNull();
  });

  it('rejects malformed tokens', async () => {
    const { verifySession } = await loadSession();
    for (const token of [undefined, null, '', 'abc', 'a.b.c', '!!!.???', `${b64url('not json')}.AAAA`]) {
      await expect(verifySession(token)).resolves.toBeNull();
    }
  });

  it('only allows same-origin next paths', async () => {
    const { safeNextPath } = await loadSession();
    expect(safeNextPath('/jobs/1?x=2')).toBe('/jobs/1?x=2');
    expect(safeNextPath('//evil.com')).toBe('/');
    expect(safeNextPath('/\\evil.com')).toBe('/');
    expect(safeNextPath('https://evil.com')).toBe('/');
    expect(safeNextPath(undefined)).toBe('/');
  });
});
