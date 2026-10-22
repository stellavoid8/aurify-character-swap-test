'use server';

import { z } from 'zod';
import { AppError, isErrorCode, toActionError } from '@/lib/errors';
import { preprocessUpload } from '@/lib/pipeline/preprocess';
import { requireSession } from '@/lib/session';
import { assertOwnedRawUrl } from '@/lib/storage';
import type { ActionResult, UploadView } from '@/lib/types';
import { toUploadView } from './queries';

const normalizeSchema = z.object({
  kind: z.enum(['template', 'user']),
  rawUrl: z.url(),
});

/**
 * Turns a raw photo the browser just uploaded into a checked `uploads` row.
 * A rejected user photo comes back as `{ ok: false }` with its face-check code; the row is kept for stats.
 */
export async function normalizeUpload(input: z.input<typeof normalizeSchema>): Promise<ActionResult<UploadView>> {
  try {
    const { sid } = await requireSession();
    const { kind, rawUrl } = normalizeSchema.parse(input);
    const upload = await preprocessUpload({ sid, kind, rawUrl: assertOwnedRawUrl(rawUrl, sid) });
    if (upload.status === 'rejected') {
      throw new AppError(isErrorCode(upload.rejectCode) ? upload.rejectCode : 'INTERNAL_ERROR');
    }
    return { ok: true, data: toUploadView(upload) };
  } catch (err) {
    return toActionError(err);
  }
}
