'use server';

import { z } from 'zod';
import { env } from '@/lib/env';
import { AppError, isErrorCode, toActionError } from '@/lib/errors';
import { preprocessUpload } from '@/lib/pipeline/preprocess';
import { preprocessVideoUpload } from '@/lib/pipeline/preprocess-video';
import { requireSession } from '@/lib/session';
import { assertOwnedRawUrl } from '@/lib/storage';
import type { ActionResult, UploadView } from '@/lib/types';
import { toUploadView } from './queries';

const normalizeSchema = z.object({
  kind: z.enum(['template', 'user']),
  /** `video` is a template clip (VIDEO_ENABLED only). */
  media: z.enum(['image', 'video']).default('image'),
  rawUrl: z.url(),
});

/**
 * Turns a raw photo (or template clip) the browser just uploaded into a checked `uploads` row.
 * A rejected user photo comes back as `{ ok: false }` with its face-check code; the row is kept for stats.
 */
export async function normalizeUpload(input: z.input<typeof normalizeSchema>): Promise<ActionResult<UploadView>> {
  try {
    const { sid } = await requireSession();
    const { kind, media, rawUrl } = normalizeSchema.parse(input);
    if (media === 'video') {
      if (!env.VIDEO_ENABLED) throw new AppError('VIDEO_UNAVAILABLE');
      if (kind !== 'template') throw new AppError('VALIDATION_FAILED', { detail: 'only a template can be a clip' });
      const upload = await preprocessVideoUpload({ sid, rawUrl: assertOwnedRawUrl(rawUrl, sid) });
      return { ok: true, data: toUploadView(upload) };
    }
    const upload = await preprocessUpload({ sid, kind, rawUrl: assertOwnedRawUrl(rawUrl, sid) });
    if (upload.status === 'rejected') {
      throw new AppError(isErrorCode(upload.rejectCode) ? upload.rejectCode : 'INTERNAL_ERROR');
    }
    return { ok: true, data: toUploadView(upload) };
  } catch (err) {
    return toActionError(err);
  }
}
