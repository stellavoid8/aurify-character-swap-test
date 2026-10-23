import { handleUpload } from '@vercel/blob/client';
import { z } from 'zod';
import { env, useLocalStorage } from '@/lib/env';
import { AppError, toResponse } from '@/lib/errors';
import { ACCEPTED_MIME, ACCEPTED_VIDEO_MIME, MAX_UPLOAD_BYTES, MAX_VIDEO_UPLOAD_BYTES } from '@/lib/limits';
import { requireSession } from '@/lib/session';
import { rawPathnamePattern, rawVideoPathnamePattern } from '@/lib/storage';

export const runtime = 'nodejs';

/**
 * Signs a one-off token so the browser can PUT a raw photo, or a template clip when VIDEO_ENABLED,
 * straight to Vercel Blob. The file extension in the pathname picks the allowed types and size.
 * Only the token-request event is accepted: there is deliberately no onUploadCompleted, because
 * that callback comes from Vercel without our cookie. The client asks the server to normalize instead.
 * The success body is the raw `handleUpload` result, the shape `@vercel/blob/client` `upload()` expects.
 */
const bodySchema = z.object({
  type: z.literal('blob.generate-client-token'),
  payload: z.object({
    pathname: z.string().max(200),
    clientPayload: z.string().nullable(),
    multipart: z.boolean(),
  }),
});

export async function POST(request: Request): Promise<Response> {
  try {
    if (useLocalStorage) throw new AppError('DIRECT_UPLOAD_UNAVAILABLE');
    const { sid } = await requireSession();
    const body = bodySchema.parse(await request.json());

    const result = await handleUpload({
      body,
      request,
      token: env.BLOB_READ_WRITE_TOKEN,
      onBeforeGenerateToken: async (pathname) => {
        if (env.VIDEO_ENABLED && rawVideoPathnamePattern(sid).test(pathname)) {
          return { allowedContentTypes: ACCEPTED_VIDEO_MIME, maximumSizeInBytes: MAX_VIDEO_UPLOAD_BYTES, addRandomSuffix: true };
        }
        if (!rawPathnamePattern(sid).test(pathname)) {
          throw new AppError('VALIDATION_FAILED', { detail: 'blob upload pathname outside session raw folder' });
        }
        return { allowedContentTypes: ACCEPTED_MIME, maximumSizeInBytes: MAX_UPLOAD_BYTES, addRandomSuffix: true };
      },
    });
    return Response.json(result);
  } catch (err) {
    return toResponse(err);
  }
}
