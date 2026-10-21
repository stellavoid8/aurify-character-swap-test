import { existsSync, rmSync } from 'node:fs';
import path from 'node:path';
import { afterAll, afterEach, describe, expect, it, vi } from 'vitest';

const SID = '11111111-1111-4111-8111-111111111111';
const OTHER = '22222222-2222-4222-8222-222222222222';
const FILE = '0f8fad5b-d9cb-469f-a165-70867728950e';
const STORE = 'abcd1234efgh';

/** Fresh module graph per mode: lib/env.ts reads process.env once on import. */
async function loadStorage(mode: 'blob' | 'local') {
  vi.resetModules();
  vi.stubEnv('DATABASE_URL', 'postgres://localhost:5432/test');
  vi.stubEnv('APP_URL', 'http://localhost:3000');
  vi.stubEnv('BLOB_READ_WRITE_TOKEN', mode === 'blob' ? `vercel_blob_rw_${STORE}_secretpart` : '');
  return import('@/lib/storage');
}

afterEach(() => {
  vi.unstubAllEnvs();
});

const blobUrl = (p: string, host = `${STORE}.public.blob.vercel-storage.com`) => `https://${host}${p}`;

describe('assertOwnedRawUrl (Blob mode)', () => {
  it("accepts this session's raw upload", async () => {
    const { assertOwnedRawUrl } = await loadStorage('blob');
    const url = blobUrl(`/sessions/${SID}/raw/${FILE}-Xy7aB2.jpg`);
    expect(assertOwnedRawUrl(url, SID)).toBe(url);
  });

  it.each([
    ['another session', blobUrl(`/sessions/${OTHER}/raw/${FILE}.jpg`)],
    ['a non-raw folder', blobUrl(`/sessions/${SID}/results/${FILE}.jpg`)],
    ['a nested path', blobUrl(`/sessions/${SID}/raw/x/${FILE}.jpg`)],
    ['traversal', blobUrl(`/sessions/${SID}/raw/../../sessions/${OTHER}/raw/${FILE}.jpg`)],
    ['encoded traversal', blobUrl(`/sessions/${SID}/raw/%2e%2e%2f${FILE}.jpg`)],
    ['another Blob store', blobUrl(`/sessions/${SID}/raw/${FILE}.jpg`, 'evilstore.public.blob.vercel-storage.com')],
    ['a non-Blob host', `https://example.com/sessions/${SID}/raw/${FILE}.jpg`],
    ['a lookalike host', blobUrl(`/sessions/${SID}/raw/${FILE}.jpg`, `${STORE}.public.blob.vercel-storage.com.evil.io`)],
    ['plain http', blobUrl(`/sessions/${SID}/raw/${FILE}.jpg`).replace('https:', 'http:')],
    ['cloud metadata', `http://169.254.169.254/latest/meta-data/sessions/${SID}/raw/x.jpg`],
    ['userinfo trick', `https://${STORE}.public.blob.vercel-storage.com@169.254.169.254/sessions/${SID}/raw/x.jpg`],
    ['garbage', 'not a url'],
  ])('rejects %s', async (_label, url) => {
    const { assertOwnedRawUrl } = await loadStorage('blob');
    expect(() => assertOwnedRawUrl(url, SID)).toThrow(expect.objectContaining({ code: 'UPLOAD_NOT_FOUND' }));
  });
});

describe('assertOwnedRawUrl (local mode)', () => {
  it("accepts this session's local raw upload and rejects others", async () => {
    const { assertOwnedRawUrl } = await loadStorage('local');
    const ok = `http://localhost:3000/uploads/sessions/${SID}/raw/${FILE}.png`;
    expect(assertOwnedRawUrl(ok, SID)).toBe(ok);
    for (const bad of [
      `http://localhost:3000/uploads/sessions/${OTHER}/raw/${FILE}.png`,
      `http://localhost:4000/uploads/sessions/${SID}/raw/${FILE}.png`,
      blobUrl(`/sessions/${SID}/raw/${FILE}.jpg`),
      'http://169.254.169.254/latest/meta-data/',
    ]) {
      expect(() => assertOwnedRawUrl(bad, SID)).toThrow(expect.objectContaining({ code: 'UPLOAD_NOT_FOUND' }));
    }
  });
});

describe('local storage round trip', () => {
  const root = path.join(process.cwd(), 'public', 'uploads', 'sessions', SID);
  afterAll(() => rmSync(root, { recursive: true, force: true }));

  it('writes under public/uploads, reads from disk, deletes', async () => {
    const { putObject, fetchObject, deleteObjects } = await loadStorage('local');
    const fetchSpy = vi.spyOn(globalThis, 'fetch');
    const pathname = `sessions/${SID}/raw/${FILE}.jpg`;

    const { url } = await putObject(pathname, Buffer.from('bytes'), 'image/jpeg');
    expect(url).toBe(`http://localhost:3000/uploads/${pathname}`);
    expect((await fetchObject(url)).toString()).toBe('bytes');
    expect(fetchSpy).not.toHaveBeenCalled();

    await deleteObjects([url, 'https://example.com/not-ours.jpg', 'garbage']);
    expect(existsSync(path.join(process.cwd(), 'public', 'uploads', pathname))).toBe(false);
    await expect(fetchObject(url)).rejects.toMatchObject({ code: 'UPLOAD_NOT_FOUND' });
    fetchSpy.mockRestore();
  });

  it('refuses pathnames that escape public/uploads', async () => {
    const { putObject } = await loadStorage('local');
    await expect(putObject('../evil.txt', Buffer.from('x'), 'text/plain')).rejects.toThrow(/invalid pathname/);
    await expect(putObject('sessions//x.jpg', Buffer.from('x'), 'image/jpeg')).rejects.toThrow(/invalid pathname/);
  });
});
