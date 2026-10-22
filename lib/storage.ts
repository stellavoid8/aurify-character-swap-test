import 'server-only';
import { mkdir, readdir, readFile, stat, unlink, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { del, list, put } from '@vercel/blob';
import { env, useLocalStorage } from './env';
import { AppError } from './errors';
import { FETCH_TIMEOUT_MS, MAX_UPLOAD_BYTES } from './limits';

/**
 * Object storage: Vercel Blob (public, random suffix) when BLOB_READ_WRITE_TOKEN is set,
 * otherwise files under public/uploads served by `next dev` at `${APP_URL}/uploads/...`.
 */

const LOCAL_ROOT = path.join(process.cwd(), 'public', 'uploads');
const BLOB_HOST_SUFFIX = '.public.blob.vercel-storage.com';
/** Largest object fetchObject will read; normalized images and results are far below this. */
const MAX_FETCH_BYTES = MAX_UPLOAD_BYTES;

/** Pathname the browser may upload a raw photo to: `sessions/<sid>/raw/<uuid>.<ext>`. */
export function rawPathnamePattern(sid: string): RegExp {
  const escaped = sid.replace(/[^a-f0-9-]/gi, '');
  return new RegExp(`^sessions/${escaped}/raw/[a-f0-9-]{36}\\.(jpe?g|png|webp|heic|heif)$`);
}

/** `<storeId>.public.blob.vercel-storage.com` from a `vercel_blob_rw_<storeId>_<secret>` token. */
function blobHost(): string | null {
  const storeId = env.BLOB_READ_WRITE_TOKEN?.split('_')[3];
  return storeId ? `${storeId.toLowerCase()}${BLOB_HOST_SUFFIX}` : null;
}

function isBlobUrl(url: URL): boolean {
  if (url.protocol !== 'https:') return false;
  const pinned = blobHost();
  return pinned ? url.hostname === pinned : url.hostname.endsWith(BLOB_HOST_SUFFIX);
}

/** Absolute path inside public/uploads for a pathname, or null if it would escape that folder. */
function localFile(pathname: string): string | null {
  if (!/^[A-Za-z0-9._/-]+$/.test(pathname) || pathname.split('/').some((part) => part === '..' || part === '')) {
    return null;
  }
  const file = path.resolve(LOCAL_ROOT, pathname);
  return file.startsWith(LOCAL_ROOT + path.sep) ? file : null;
}

/** Pathname under public/uploads for one of our local URLs, else null. */
function localPathname(url: URL): string | null {
  if (url.origin !== new URL(env.APP_URL).origin || !url.pathname.startsWith('/uploads/')) return null;
  return decodeURIComponent(url.pathname.slice('/uploads/'.length));
}

function parseUrl(value: string): URL | null {
  try {
    return new URL(value);
  } catch {
    return null;
  }
}

export async function putObject(
  pathname: string,
  body: Buffer | Uint8Array,
  contentType: string,
): Promise<{ url: string }> {
  if (!useLocalStorage) {
    const blob = await put(pathname, Buffer.from(body), {
      access: 'public',
      contentType,
      addRandomSuffix: true,
      token: env.BLOB_READ_WRITE_TOKEN,
    });
    return { url: blob.url };
  }
  const file = localFile(pathname);
  if (!file) throw new Error(`putObject: invalid pathname ${pathname}`);
  await mkdir(path.dirname(file), { recursive: true });
  await writeFile(file, body);
  return { url: `${env.APP_URL}/uploads/${pathname}` };
}

/**
 * Reads an object into memory. Local URLs are read from disk, never over HTTP: the request would
 * have no session cookie and middleware would reject it. Other URLs (Blob, provider results) are fetched.
 */
export async function fetchObject(url: string): Promise<Buffer> {
  const parsed = parseUrl(url);
  if (!parsed || (parsed.protocol !== 'https:' && parsed.protocol !== 'http:')) {
    throw new AppError('UPLOAD_NOT_FOUND', { detail: 'fetchObject: not an http(s) URL' });
  }

  const pathname = useLocalStorage ? localPathname(parsed) : null;
  if (pathname !== null) {
    const file = localFile(pathname);
    if (!file) throw new AppError('UPLOAD_NOT_FOUND', { detail: 'fetchObject: bad local path' });
    try {
      return await readFile(file);
    } catch (err) {
      throw new AppError('UPLOAD_NOT_FOUND', { detail: 'fetchObject: local file missing', cause: err });
    }
  }

  const res = await fetch(parsed, { signal: AbortSignal.timeout(FETCH_TIMEOUT_MS), redirect: 'error' });
  if (res.status === 404) throw new AppError('UPLOAD_NOT_FOUND', { detail: 'fetchObject: 404' });
  if (!res.ok) throw new Error(`fetchObject: HTTP ${res.status} from ${parsed.hostname}`);
  if (Number(res.headers.get('content-length') ?? 0) > MAX_FETCH_BYTES) {
    throw new AppError('FILE_TOO_LARGE', { detail: 'fetchObject: content-length over limit' });
  }
  const bytes = Buffer.from(await res.arrayBuffer());
  if (bytes.length > MAX_FETCH_BYTES) throw new AppError('FILE_TOO_LARGE', { detail: 'fetchObject: body over limit' });
  return bytes;
}

/**
 * Deletes our stored objects. URLs we don't own (other hosts, malformed) are ignored. Missing files are fine.
 * Returns how many owned objects it targeted.
 */
export async function deleteObjects(urls: string[]): Promise<number> {
  const blobUrls: string[] = [];
  const localFiles: string[] = [];
  for (const value of urls) {
    const parsed = parseUrl(value);
    if (!parsed) continue;
    if (isBlobUrl(parsed)) {
      blobUrls.push(value);
      continue;
    }
    const pathname = localPathname(parsed);
    const file = pathname !== null ? localFile(pathname) : null;
    if (file) localFiles.push(file);
  }

  if (blobUrls.length > 0 && !useLocalStorage) {
    for (let i = 0; i < blobUrls.length; i += 100) {
      await del(blobUrls.slice(i, i + 100), { token: env.BLOB_READ_WRITE_TOKEN });
    }
  }
  await Promise.all(
    localFiles.map((file) =>
      unlink(file).catch((err: NodeJS.ErrnoException) => {
        if (err.code !== 'ENOENT') throw err;
      }),
    ),
  );
  return (useLocalStorage ? 0 : blobUrls.length) + localFiles.length;
}

export type StoredObject = { url: string; pathname: string; uploadedAt: Date };

/** Every stored object whose pathname starts with `prefix`. Local mode walks public/uploads and uses file mtimes. */
export async function* listObjects(prefix: string): AsyncGenerator<StoredObject> {
  if (!useLocalStorage) {
    let cursor: string | undefined;
    do {
      const page = await list({ prefix, cursor, limit: 1000, token: env.BLOB_READ_WRITE_TOKEN });
      for (const blob of page.blobs) yield { url: blob.url, pathname: blob.pathname, uploadedAt: blob.uploadedAt };
      cursor = page.hasMore ? page.cursor : undefined;
    } while (cursor);
    return;
  }
  let entries;
  try {
    entries = await readdir(LOCAL_ROOT, { recursive: true, withFileTypes: true });
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') return;
    throw err;
  }
  for (const entry of entries) {
    if (!entry.isFile()) continue;
    const file = path.join(entry.parentPath, entry.name);
    const pathname = path.relative(LOCAL_ROOT, file).split(path.sep).join('/');
    if (!pathname.startsWith(prefix)) continue;
    const { mtime } = await stat(file);
    yield { url: `${env.APP_URL}/uploads/${pathname}`, pathname, uploadedAt: mtime };
  }
}

/**
 * SSRF and ownership guard for a client-supplied raw upload URL: it must be in our storage, under
 * this session's raw/ folder. Throws UPLOAD_NOT_FOUND otherwise. Returns the URL in canonical form.
 */
export function assertOwnedRawUrl(url: string, sid: string): string {
  const parsed = parseUrl(url);
  const fail = (detail: string) => new AppError('UPLOAD_NOT_FOUND', { detail: `assertOwnedRawUrl: ${detail}` });
  if (!parsed) throw fail('unparseable');
  if (parsed.username || parsed.password) throw fail('credentials in URL');
  // Encoded separators or dots could pass the prefix check here and be decoded into another path later.
  if (/%2f|%5c|%2e/i.test(parsed.pathname)) throw fail('encoded path characters');

  if (useLocalStorage) {
    if (parsed.origin !== new URL(env.APP_URL).origin) throw fail('wrong origin');
    if (!parsed.pathname.startsWith(`/uploads/sessions/${sid}/raw/`)) throw fail('wrong path');
  } else {
    if (!isBlobUrl(parsed)) throw fail('not our Blob store');
    if (!parsed.pathname.startsWith(`/sessions/${sid}/raw/`)) throw fail('wrong path');
  }
  // Exactly one file name after raw/, no deeper folders.
  if (parsed.pathname.split('/raw/')[1]?.includes('/')) throw fail('nested path');
  return parsed.toString();
}
