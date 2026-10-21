import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const cookieJar = new Map<string, string>();
vi.mock('next/headers', () => ({
  cookies: async () => ({
    get: (name: string) => (cookieJar.has(name) ? { name, value: cookieJar.get(name)! } : undefined),
  }),
}));

const SID = '11111111-1111-4111-8111-111111111111';
const OTHER = '22222222-2222-4222-8222-222222222222';
const FILE = '0f8fad5b-d9cb-469f-a165-70867728950e';

async function setup(mode: 'blob' | 'local', { signedIn = true } = {}) {
  vi.resetModules();
  vi.stubEnv('DATABASE_URL', 'postgres://localhost:5432/test');
  vi.stubEnv('SESSION_SECRET', 'test-secret');
  vi.stubEnv('BLOB_READ_WRITE_TOKEN', mode === 'blob' ? 'vercel_blob_rw_abcd1234efgh_secretpart' : '');
  cookieJar.clear();
  if (signedIn) {
    const { signSession, newSessionPayload } = await import('@/lib/session');
    cookieJar.set('cs_session', await signSession(newSessionPayload(SID)));
  }
}

const tokenRequest = (pathname: string) =>
  new Request('http://localhost:3000/api/blob/upload', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ type: 'blob.generate-client-token', payload: { pathname, clientPayload: null, multipart: false } }),
  });

beforeEach(() => cookieJar.clear());
afterEach(() => vi.unstubAllEnvs());

describe('POST /api/blob/upload', () => {
  it("signs a token for this session's raw folder", async () => {
    await setup('blob');
    const { POST } = await import('@/app/api/blob/upload/route');
    const res = await POST(tokenRequest(`sessions/${SID}/raw/${FILE}.heic`));
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body).toMatchObject({ type: 'blob.generate-client-token', clientToken: expect.stringMatching(/^vercel_blob_client_/) });

    const { getPayloadFromClientToken } = await import('@vercel/blob/client');
    expect(getPayloadFromClientToken(body.clientToken)).toMatchObject({
      pathname: `sessions/${SID}/raw/${FILE}.heic`,
      maximumSizeInBytes: 25 * 1024 * 1024,
      addRandomSuffix: true,
      allowedContentTypes: expect.arrayContaining(['image/heic', 'image/jpeg']),
    });
  });

  it.each([
    `sessions/${OTHER}/raw/${FILE}.jpg`,
    `sessions/${SID}/raw/${FILE}.pdf`,
    `sessions/${SID}/results/${FILE}.jpg`,
    `sessions/${SID}/raw/../${FILE}.jpg`,
  ])('rejects pathname %s with 400', async (pathname) => {
    await setup('blob');
    const { POST } = await import('@/app/api/blob/upload/route');
    const res = await POST(tokenRequest(pathname));
    expect(res.status).toBe(400);
    expect(await res.json()).toMatchObject({ error: { code: 'VALIDATION_FAILED' } });
  });

  it('rejects the upload-completed callback event', async () => {
    await setup('blob');
    const { POST } = await import('@/app/api/blob/upload/route');
    const res = await POST(
      new Request('http://localhost:3000/api/blob/upload', {
        method: 'POST',
        body: JSON.stringify({ type: 'blob.upload-completed', payload: { blob: {}, tokenPayload: null } }),
      }),
    );
    expect(res.status).toBe(400);
  });

  it('is 401 without a session cookie', async () => {
    await setup('blob', { signedIn: false });
    const { POST } = await import('@/app/api/blob/upload/route');
    const res = await POST(tokenRequest(`sessions/${SID}/raw/${FILE}.jpg`));
    expect(res.status).toBe(401);
    expect(await res.json()).toMatchObject({ error: { code: 'ACCESS_DENIED' } });
  });

  it('is 404 in local-storage mode so the browser falls back to /api/dev-upload', async () => {
    await setup('local');
    const { POST } = await import('@/app/api/blob/upload/route');
    expect((await POST(tokenRequest(`sessions/${SID}/raw/${FILE}.jpg`))).status).toBe(404);
  });
});

describe('POST /api/dev-upload', () => {
  const upload = (file: File) => {
    const form = new FormData();
    form.set('file', file);
    return new Request('http://localhost:3000/api/dev-upload', { method: 'POST', body: form });
  };

  it('stores an accepted photo under the session raw folder', async () => {
    await setup('local');
    const writeFile = vi.fn(async () => {});
    vi.doMock('node:fs/promises', async (orig) => ({ ...(await orig<object>()), mkdir: vi.fn(async () => {}), writeFile }));
    const { POST } = await import('@/app/api/dev-upload/route');
    const res = await POST(upload(new File([new Uint8Array([1, 2, 3])], 'IMG_0001.HEIC', { type: '' })));
    expect(res.status).toBe(200);
    const { data } = await res.json();
    expect(data.url).toMatch(new RegExp(`^http://localhost:3000/uploads/sessions/${SID}/raw/[a-f0-9-]{36}\\.heic$`));
    expect(writeFile).toHaveBeenCalledOnce();
    vi.doUnmock('node:fs/promises');
  });

  it('rejects unsupported types and oversized files', async () => {
    await setup('local');
    const { POST } = await import('@/app/api/dev-upload/route');
    const pdf = await POST(upload(new File(['%PDF-1.4'], 'doc.pdf', { type: 'application/pdf' })));
    expect(pdf.status).toBe(415);
    const big = await POST(upload(new File([new Uint8Array(25 * 1024 * 1024 + 1)], 'big.jpg', { type: 'image/jpeg' })));
    expect(big.status).toBe(413);
  });

  it('is 401 without a session and 404 when Blob is configured', async () => {
    await setup('local', { signedIn: false });
    let { POST } = await import('@/app/api/dev-upload/route');
    expect((await POST(upload(new File(['x'], 'a.jpg', { type: 'image/jpeg' })))).status).toBe(401);

    await setup('blob');
    ({ POST } = await import('@/app/api/dev-upload/route'));
    expect((await POST(upload(new File(['x'], 'a.jpg', { type: 'image/jpeg' })))).status).toBe(404);
  });
});
