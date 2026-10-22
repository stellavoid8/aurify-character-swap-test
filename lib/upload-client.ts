import { upload } from '@vercel/blob/client';
import { AppError, isErrorCode } from './errors';
import { ACCEPTED_EXT, ACCEPTED_MIME, CLIENT_PRERESIZE_LONG_EDGE, MAX_UPLOAD_BYTES } from './limits';
import type { ErrorCode } from './types';

/**
 * Browser-side upload helpers: check a picked file, shrink it, and send it straight to storage
 * (Vercel Blob, or /api/dev-upload when the server has no Blob token). Never imports server code.
 */

const EXT_BY_MIME: Record<string, string> = {
  'image/jpeg': 'jpg',
  'image/png': 'png',
  'image/webp': 'webp',
  'image/heic': 'heic',
  'image/heif': 'heif',
};
/** Formats every browser can decode, so a small enough file can be sent as it is. */
const BROWSER_SAFE_MIME = ['image/jpeg', 'image/png', 'image/webp'];
const PRERESIZE_QUALITY = 0.9;

function extensionOf(name: string): string {
  const dot = name.lastIndexOf('.');
  return dot === -1 ? '' : name.slice(dot).toLowerCase();
}

/** Upload extension, from the declared type or, when the browser sent none (common for HEIC), the name. */
function uploadExtension(file: File): string | null {
  if (ACCEPTED_MIME.includes(file.type)) return EXT_BY_MIME[file.type];
  if (file.type && file.type !== 'application/octet-stream') return null;
  const ext = extensionOf(file.name);
  return ACCEPTED_EXT.includes(ext) ? ext.slice(1).replace('jpeg', 'jpg') : null;
}

/** Cheap pre-upload check. The server still sniffs the bytes; this only saves a pointless upload. */
export function validateFile(file: File): ErrorCode | null {
  if (!uploadExtension(file)) return 'UNSUPPORTED_FILE_TYPE';
  if (file.size > MAX_UPLOAD_BYTES) return 'FILE_TOO_LARGE';
  return null;
}

/**
 * Applies EXIF rotation and shrinks the long edge to CLIENT_PRERESIZE_LONG_EDGE as a JPEG, to save mobile data.
 * Returns the original file when it is already small and web-safe, or when the browser can't decode it
 * (HEIC in Chrome): the server converts those.
 */
export async function preResize(file: File): Promise<File> {
  let bitmap: ImageBitmap;
  try {
    bitmap = await createImageBitmap(file, { imageOrientation: 'from-image' });
  } catch {
    return file;
  }
  try {
    const scale = Math.min(1, CLIENT_PRERESIZE_LONG_EDGE / Math.max(bitmap.width, bitmap.height));
    if (scale === 1 && BROWSER_SAFE_MIME.includes(file.type)) return file;

    const canvas = document.createElement('canvas');
    canvas.width = Math.round(bitmap.width * scale);
    canvas.height = Math.round(bitmap.height * scale);
    const ctx = canvas.getContext('2d');
    if (!ctx) return file;
    ctx.drawImage(bitmap, 0, 0, canvas.width, canvas.height);
    const blob = await new Promise<Blob | null>((resolve) => canvas.toBlob(resolve, 'image/jpeg', PRERESIZE_QUALITY));
    if (!blob) return file;
    const base = file.name.replace(/\.[^.]*$/, '') || 'photo';
    return new File([blob], `${base}.jpg`, { type: 'image/jpeg' });
  } finally {
    bitmap.close();
  }
}

let directUpload: Promise<boolean> | null = null;

/** /api/blob/upload answers 404 before reading the body when the server has no Blob token. Asked once per page load. */
function directUploadAvailable(): Promise<boolean> {
  directUpload ??= fetch('/api/blob/upload', { method: 'POST', body: '{}' })
    .then((res) => res.status !== 404)
    .catch(() => {
      directUpload = null;
      return true;
    });
  return directUpload;
}

/** Local-storage fallback, via XHR because fetch has no upload progress. */
function devUpload(file: File, onProgress: (fraction: number) => void): Promise<string> {
  return new Promise((resolve, reject) => {
    const xhr = new XMLHttpRequest();
    xhr.open('POST', '/api/dev-upload');
    xhr.responseType = 'json';
    xhr.upload.onprogress = (event) => {
      if (event.lengthComputable) onProgress(event.loaded / event.total);
    };
    xhr.onerror = () => reject(new AppError('UPLOAD_FAILED', { detail: 'dev-upload network error' }));
    xhr.onload = () => {
      const body = xhr.response as { data?: { url: string }; error?: { code: string } } | null;
      if (xhr.status === 200 && body?.data?.url) return resolve(body.data.url);
      const code = body?.error?.code;
      reject(new AppError(isErrorCode(code) ? code : 'UPLOAD_FAILED', { detail: `dev-upload HTTP ${xhr.status}` }));
    };
    const form = new FormData();
    form.set('file', file);
    xhr.send(form);
  });
}

/**
 * Uploads a raw photo to `sessions/<sid>/raw/<uuid>.<ext>` without passing through a function body,
 * and returns its URL for `normalizeUpload`. `onProgress` gets 0–1. Throws `AppError` (UPLOAD_FAILED by default).
 */
export async function uploadFile(file: File, { sid }: { sid: string }, onProgress: (fraction: number) => void): Promise<string> {
  const ext = uploadExtension(file);
  if (!ext) throw new AppError('UNSUPPORTED_FILE_TYPE');

  if (!(await directUploadAvailable())) return devUpload(file, onProgress);

  try {
    const blob = await upload(`sessions/${sid}/raw/${crypto.randomUUID()}.${ext}`, file, {
      access: 'public',
      handleUploadUrl: '/api/blob/upload',
      // HEIC often arrives with no type; the token only allows the listed image types.
      contentType: ACCEPTED_MIME.includes(file.type) ? file.type : `image/${ext === 'jpg' ? 'jpeg' : ext}`,
      onUploadProgress: ({ percentage }) => onProgress(percentage / 100),
    });
    return blob.url;
  } catch (err) {
    throw new AppError('UPLOAD_FAILED', { detail: 'blob upload failed', cause: err });
  }
}
