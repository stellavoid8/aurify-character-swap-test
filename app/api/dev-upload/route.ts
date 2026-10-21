import { env, useLocalStorage } from '@/lib/env';
import { AppError, toResponse } from '@/lib/errors';
import { ACCEPTED_EXT, ACCEPTED_MIME, MAX_UPLOAD_BYTES } from '@/lib/limits';
import { requireSession } from '@/lib/session';
import { putObject } from '@/lib/storage';

export const runtime = 'nodejs';

const EXT_BY_MIME: Record<string, string> = {
  'image/jpeg': 'jpg',
  'image/png': 'png',
  'image/webp': 'webp',
  'image/heic': 'heic',
  'image/heif': 'heif',
};

/** Multipart overhead allowed on top of the file itself before we refuse to read the body. */
const FORM_OVERHEAD_BYTES = 64 * 1024;

/** Extension for the stored file, from the declared type or, when the browser sent none (common for HEIC), the name. */
function extensionFor(file: File): string | null {
  if (ACCEPTED_MIME.includes(file.type)) return EXT_BY_MIME[file.type];
  if (file.type && file.type !== 'application/octet-stream') return null;
  const ext = file.name.slice(file.name.lastIndexOf('.')).toLowerCase();
  return ACCEPTED_EXT.includes(ext) ? ext.slice(1).replace('jpeg', 'jpg') : null;
}

/** Dev-only stand-in for direct Blob uploads: field `file` → public/uploads/sessions/<sid>/raw/<uuid>.<ext>. */
export async function POST(request: Request): Promise<Response> {
  if (!useLocalStorage || env.isProduction) return new Response(null, { status: 404 });
  try {
    const { sid } = await requireSession();
    if (Number(request.headers.get('content-length') ?? 0) > MAX_UPLOAD_BYTES + FORM_OVERHEAD_BYTES) {
      throw new AppError('FILE_TOO_LARGE');
    }

    const form = await request.formData().catch((cause: unknown) => {
      throw new AppError('VALIDATION_FAILED', { detail: 'dev-upload: body is not multipart form data', cause });
    });
    const file = form.get('file');
    if (!(file instanceof File)) throw new AppError('VALIDATION_FAILED', { detail: 'dev-upload: missing file field' });
    if (file.size > MAX_UPLOAD_BYTES) throw new AppError('FILE_TOO_LARGE');
    const ext = extensionFor(file);
    if (!ext) throw new AppError('UNSUPPORTED_FILE_TYPE');

    const pathname = `sessions/${sid}/raw/${crypto.randomUUID()}.${ext}`;
    const { url } = await putObject(pathname, Buffer.from(await file.arrayBuffer()), file.type || 'application/octet-stream');
    return Response.json({ data: { url } });
  } catch (err) {
    return toResponse(err);
  }
}
