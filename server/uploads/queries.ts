import 'server-only';
import { and, eq, inArray, isNull } from 'drizzle-orm';
import { z } from 'zod';
import { db } from '@/lib/db';
import { uploads, type Upload } from '@/lib/db/schema';
import { AppError } from '@/lib/errors';
import { FACE_MIN_SCORE } from '@/lib/limits';
import type { UploadView } from '@/lib/types';

const uuid = z.uuid();

/**
 * This session's live uploads, in the order of `ids`. Throws UPLOAD_NOT_FOUND if any id is malformed,
 * deleted or belongs to another session, so callers never learn whether a foreign id exists.
 */
export async function getUploadsForSession(sid: string, ids: string[]): Promise<Upload[]> {
  if (ids.some((id) => !uuid.safeParse(id).success)) throw new AppError('UPLOAD_NOT_FOUND', { detail: 'malformed upload id' });
  const unique = [...new Set(ids)];
  if (unique.length === 0) return [];

  const rows = await db
    .select()
    .from(uploads)
    .where(and(eq(uploads.sessionId, sid), inArray(uploads.id, unique), isNull(uploads.deletedAt)));
  const byId = new Map(rows.map((row) => [row.id, row]));
  if (byId.size !== unique.length) throw new AppError('UPLOAD_NOT_FOUND', { detail: 'upload missing or foreign' });
  return ids.map((id) => byId.get(id)!);
}

export function toUploadView(upload: Upload): UploadView {
  const subject = upload.subjectFaceIndex !== null ? upload.faces[upload.subjectFaceIndex] : undefined;
  return {
    id: upload.id,
    kind: upload.kind,
    status: upload.status,
    rejectCode: upload.rejectCode,
    url: upload.url,
    width: upload.width,
    height: upload.height,
    faceCount: upload.faces.filter((face) => face.score >= FACE_MIN_SCORE).length,
    subjectBox: subject?.box ?? null,
    qualityScore: upload.qualityScore,
  };
}
