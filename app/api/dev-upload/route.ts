import { env, useLocalStorage } from '@/lib/env';
import { AppError, toResponse } from '@/lib/errors';
import { ACCEPTED_EXT, ACCEPTED_MIME, ACCEPTED_VIDEO_EXT, ACCEPTED_VIDEO_MIME, MAX_UPLOAD_BYTES, MAX_VIDEO_UPLOAD_BYTES } from '@/lib/limits';
import { requireSession } from '@/lib/session';
import { putObject } from '@/lib/storage';

export const runtime = 'nodejs';

const EXT_BY_MIME: Record<string, string> = {
  'image/jpeg': 'jpg',
  'image/png': 'png',
  'image/webp': 'webp',
  'image/heic': 'heic',
  'image/heif': 'heif',
  'video/mp4': 'mp4',
  'video/quicktime': 'mov',
  'video/webm': 'webm',
  'video/x-m4v': 'm4v',
};

/** Multipart overhead allowed on top of the file itself before we refuse to read the body. */
const FORM_OVERHEAD_BYTES = 64 * 1024;

/** Extension for the stored file, from the declared type or, when the browser sent none (common for HEIC), the name. */
function extensionFor(file: File): string | null {
  const mime = env.VIDEO_ENABLED ? [...ACCEPTED_MIME, ...ACCEPTED_VIDEO_MIME] : ACCEPTED_MIME;
  if (mime.includes(file.type)) return EXT_BY_MIME[file.type];
  if (file.type && file.type !== 'application/octet-stream') return null;
  const ext = file.name.slice(file.name.lastIndexOf('.')).toLowerCase();
  const exts = env.VIDEO_ENABLED ? [...ACCEPTED_EXT, ...ACCEPTED_VIDEO_EXT] : ACCEPTED_EXT;
  return exts.includes(ext) ? ext.slice(1).replace('jpeg', 'jpg') : null;
}

const isVideoExt = (ext: string) => ACCEPTED_VIDEO_EXT.includes(`.${ext}`);

/** Dev-only stand-in for direct Blob uploads: field `file` (photo, or clip when VIDEO_ENABLED) → public/uploads/sessions/<sid>/raw/<uuid>.<ext>. */
export async function POST(request: Request): Promise<Response> {
  if (!useLocalStorage || env.isProduction) return new Response(null, { status: 404 });
  try {
    const { sid } = await requireSession();
    const maxBytes = env.VIDEO_ENABLED ? MAX_VIDEO_UPLOAD_BYTES : MAX_UPLOAD_BYTES;
    if (Number(request.headers.get('content-length') ?? 0) > maxBytes + FORM_OVERHEAD_BYTES) {
      throw new AppError('FILE_TOO_LARGE');
    }

    const form = await request.formData().catch((cause: unknown) => {
      throw new AppError('VALIDATION_FAILED', { detail: 'dev-upload: body is not multipart form data', cause });
    });
    const file = form.get('file');
    if (!(file instanceof File)) throw new AppError('VALIDATION_FAILED', { detail: 'dev-upload: missing file field' });
    const ext = extensionFor(file);
    if (!ext) throw new AppError('UNSUPPORTED_FILE_TYPE');
    if (isVideoExt(ext) ? file.size > MAX_VIDEO_UPLOAD_BYTES : file.size > MAX_UPLOAD_BYTES) {
      throw new AppError(isVideoExt(ext) ? 'VIDEO_TOO_LARGE' : 'FILE_TOO_LARGE');
    }

    const pathname = `sessions/${sid}/raw/${crypto.randomUUID()}.${ext}`;
    const { url } = await putObject(pathname, Buffer.from(await file.arrayBuffer()), file.type || 'application/octet-stream');
    return Response.json({ data: { url } });
  } catch (err) {
    return toResponse(err);
  }
}
