import { existsSync, readFileSync, rmSync } from 'node:fs';
import path from 'node:path';
import { sql } from 'drizzle-orm';
import sharp from 'sharp';
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { createTestDb, type TestDb } from './helpers/db';

let testDb: TestDb;
let close: () => Promise<void>;
vi.mock('@/lib/db', () => ({
  get db() {
    return testDb;
  },
}));

const cookieJar = new Map<string, string>();
vi.mock('next/headers', () => ({
  cookies: async () => ({
    get: (name: string) => (cookieJar.has(name) ? { name, value: cookieJar.get(name)! } : undefined),
  }),
}));

const SID = '33333333-3333-4333-8333-333333333333';
const OTHER = '44444444-4444-4444-8444-444444444444';
const UPLOADS = path.join(process.cwd(), 'public', 'uploads');

// lib/env.ts reads process.env once on import: local storage, mock face engine.
vi.stubEnv('DATABASE_URL', 'postgres://localhost:5432/test');
vi.stubEnv('APP_URL', 'http://localhost:3000');
vi.stubEnv('BLOB_READ_WRITE_TOKEN', '');
vi.stubEnv('FACE_ENGINE', 'mock');
vi.stubEnv('SESSION_SECRET', 'test-secret');

const { preprocessUpload } = await import('@/lib/pipeline/preprocess');
const { putObject } = await import('@/lib/storage');
const { getUploadsForSession, toUploadView } = await import('@/server/uploads/queries');
const { normalizeUpload } = await import('@/server/uploads/actions');
const { signSession, newSessionPayload } = await import('@/lib/session');

const fixture = (name: string) => readFileSync(path.join('tests', 'fixtures', name));

/** Stores `bytes` the way /api/dev-upload would and returns the raw URL. */
async function rawUpload(bytes: Buffer, sid = SID, ext = 'jpg'): Promise<string> {
  return (await putObject(`sessions/${sid}/raw/${crypto.randomUUID()}.${ext}`, bytes, 'image/jpeg')).url;
}

const localFile = (url: string) => path.join(UPLOADS, new URL(url).pathname.slice('/uploads/'.length));

beforeAll(async () => {
  ({ db: testDb, close } = await createTestDb());
});

afterAll(async () => {
  vi.unstubAllEnvs();
  rmSync(path.join(UPLOADS, 'sessions', SID), { recursive: true, force: true });
  rmSync(path.join(UPLOADS, 'sessions', OTHER), { recursive: true, force: true });
  await close();
});

beforeEach(async () => {
  await testDb.execute(sql`truncate uploads cascade`);
  cookieJar.set('cs_session', await signSession(newSessionPayload(SID)));
});

describe('preprocessUpload (user photos)', () => {
  it.each([
    ['face-none-red.jpg', 'NO_FACE'],
    ['face-two-blue.jpg', 'MULTIPLE_FACES'],
  ])('%s is rejected with %s, kept as a row without an image', async (name, code) => {
    const rawUrl = await rawUpload(fixture(name));
    const upload = await preprocessUpload({ sid: SID, kind: 'user', rawUrl });
    expect(upload).toMatchObject({ status: 'rejected', rejectCode: code, url: null, embedding: null, sessionId: SID });
    expect(existsSync(localFile(rawUrl))).toBe(false);
  });

  it('accepts a single clear face with a 512-d embedding and stores the normalized JPEG', async () => {
    const rawUrl = await rawUpload(fixture('face-one-grey.jpg'));
    const upload = await preprocessUpload({ sid: SID, kind: 'user', rawUrl });

    expect(upload).toMatchObject({ status: 'ok', rejectCode: null, kind: 'user', rawUrl, width: 640, height: 480 });
    expect(upload.embedding).toHaveLength(512);
    expect(upload.qualityScore).toBeGreaterThan(0);
    expect(upload.faces).toHaveLength(1);
    expect(upload.url).toMatch(new RegExp(`/uploads/sessions/${SID}/norm/[a-f0-9-]{36}\\.jpg$`));
    expect(existsSync(localFile(rawUrl))).toBe(false);
    expect((await sharp(readFileSync(localFile(upload.url!))).metadata()).format).toBe('jpeg');
  });
});

describe('preprocessUpload (templates)', () => {
  it('keeps a two-person template and picks a subject', async () => {
    const upload = await preprocessUpload({ sid: SID, kind: 'template', rawUrl: await rawUpload(fixture('face-two-blue.jpg')) });
    expect(upload).toMatchObject({ status: 'ok', embedding: null });
    expect(upload.subjectFaceIndex).not.toBeNull();

    const view = toUploadView(upload);
    expect(view.faceCount).toBe(2);
    expect(view.subjectBox).toEqual(upload.faces[upload.subjectFaceIndex!].box);
  });

  it('keeps a template with no face, with no subject', async () => {
    const upload = await preprocessUpload({ sid: SID, kind: 'template', rawUrl: await rawUpload(fixture('face-none-red.jpg')) });
    expect(upload).toMatchObject({ status: 'ok', subjectFaceIndex: null });
    expect(toUploadView(upload)).toMatchObject({ faceCount: 0, subjectBox: null });
  });

  it('shrinks a large photo to a 1536 px long edge', async () => {
    const big = await sharp({ create: { width: 4000, height: 3000, channels: 3, background: { r: 128, g: 128, b: 128 } } })
      .jpeg()
      .toBuffer();
    const upload = await preprocessUpload({ sid: SID, kind: 'template', rawUrl: await rawUpload(big) });
    expect([upload.width, upload.height]).toEqual([1536, 1152]);
  });

  it('throws UNSUPPORTED_FILE_TYPE for a PDF, inserts nothing and still deletes the raw object', async () => {
    const rawUrl = await rawUpload(fixture('document.pdf'));
    await expect(preprocessUpload({ sid: SID, kind: 'template', rawUrl })).rejects.toMatchObject({ code: 'UNSUPPORTED_FILE_TYPE' });
    expect(existsSync(localFile(rawUrl))).toBe(false);
    expect(await testDb.execute(sql`select 1 from uploads`)).toMatchObject({ rows: [] });
  });
});

describe('normalizeUpload', () => {
  it('returns the upload view for an accepted photo', async () => {
    const result = await normalizeUpload({ kind: 'user', rawUrl: await rawUpload(fixture('face-one-grey.jpg')) });
    expect(result).toMatchObject({ ok: true, data: { kind: 'user', status: 'ok', faceCount: 1, subjectBox: null } });
  });

  it('returns the face-check code for a rejected user photo', async () => {
    const result = await normalizeUpload({ kind: 'user', rawUrl: await rawUpload(fixture('face-none-red.jpg')) });
    expect(result).toMatchObject({ ok: false, error: { code: 'NO_FACE' } });
  });

  it("refuses another session's raw upload without touching it", async () => {
    const foreign = await rawUpload(fixture('face-one-grey.jpg'), OTHER);
    const result = await normalizeUpload({ kind: 'user', rawUrl: foreign });
    expect(result).toMatchObject({ ok: false, error: { code: 'UPLOAD_NOT_FOUND' } });
    expect(existsSync(localFile(foreign))).toBe(true);
  });

  it('is ACCESS_DENIED without a session and VALIDATION_FAILED for bad input', async () => {
    expect(await normalizeUpload({ kind: 'user', rawUrl: 'not a url' })).toMatchObject({ ok: false, error: { code: 'VALIDATION_FAILED' } });
    cookieJar.clear();
    expect(await normalizeUpload({ kind: 'user', rawUrl: 'http://localhost:3000/x.jpg' })).toMatchObject({
      ok: false,
      error: { code: 'ACCESS_DENIED' },
    });
  });
});

describe('getUploadsForSession', () => {
  it('returns rows in the requested order and rejects foreign, missing or malformed ids', async () => {
    const a = await preprocessUpload({ sid: SID, kind: 'user', rawUrl: await rawUpload(fixture('face-one-grey.jpg')) });
    const b = await preprocessUpload({ sid: SID, kind: 'template', rawUrl: await rawUpload(fixture('face-two-blue.jpg')) });
    const foreign = await preprocessUpload({ sid: OTHER, kind: 'template', rawUrl: await rawUpload(fixture('face-two-blue.jpg'), OTHER) });

    expect((await getUploadsForSession(SID, [b.id, a.id])).map((u) => u.id)).toEqual([b.id, a.id]);
    for (const ids of [[a.id, foreign.id], [crypto.randomUUID()], ['nope']]) {
      await expect(getUploadsForSession(SID, ids)).rejects.toMatchObject({ code: 'UPLOAD_NOT_FOUND' });
    }
  });
});
