import 'server-only';
import { and, eq, inArray, isNotNull, lt, sql } from 'drizzle-orm';
import { db } from '@/lib/db';
import { candidates, jobs, uploads } from '@/lib/db/schema';
import { CLEANUP_BATCH_SIZE, ORPHAN_MAX_AGE_MS, retentionDays } from '@/lib/limits';
import { enforceTimeout } from '@/lib/pipeline/timeout';
import { deleteObjects, listObjects } from '@/lib/storage';

export type CleanupCounts = { timedOut: number; deletedUploads: number; deletedJobs: number; deletedBlobs: number };

const RAW_PATH = /^sessions\/[^/]+\/raw\//;

/**
 * The daily cron: times out stuck jobs, then deletes everything past retention (privacy).
 * Objects are deleted before their rows, so a run that fails part way leaves rows pointing at
 * missing files (harmless, and retried tomorrow) rather than files no row points at.
 */
export async function runCleanup(now: Date = new Date()): Promise<CleanupCounts> {
  const counts: CleanupCounts = { timedOut: 0, deletedUploads: 0, deletedJobs: 0, deletedBlobs: 0 };

  // 1. Jobs nobody is polling never hit the lazy timeout on read.
  const stuck = await db
    .select()
    .from(jobs)
    .where(and(eq(jobs.status, 'running'), lt(jobs.deadlineAt, now)));
  for (const job of stuck) {
    if ((await enforceTimeout(job)).status !== 'running') counts.timedOut++;
  }

  // 2. Expired jobs, with their result images. Rounds, candidates, provider calls and webhook events cascade.
  const jobCutoff = new Date(now.getTime() - (await retentionDays()) * 24 * 60 * 60_000);
  for (;;) {
    const batch = await db
      .select({ id: jobs.id })
      .from(jobs)
      .where(lt(jobs.createdAt, jobCutoff))
      .limit(CLEANUP_BATCH_SIZE);
    if (batch.length === 0) break;
    const ids = batch.map((job) => job.id);
    const images = await db
      .select({ url: candidates.imageUrl })
      .from(candidates)
      .where(and(inArray(candidates.jobId, ids), isNotNull(candidates.imageUrl)));
    counts.deletedBlobs += await deleteObjects(images.map((row) => row.url as string));
    counts.deletedJobs += (await db.delete(jobs).where(inArray(jobs.id, ids)).returning({ id: jobs.id })).length;
  }

  // 3. Uploads no job uses: abandoned drafts, rejected photos, and those the expired jobs just released.
  const orphanCutoff = new Date(now.getTime() - ORPHAN_MAX_AGE_MS);
  const orphan = and(
    lt(uploads.createdAt, orphanCutoff),
    sql`not exists (select 1 from ${jobs} where ${jobs.templateUploadId} = ${uploads.id}
      or ${jobs.referenceUploadId} = ${uploads.id} or ${uploads.id} = any(${jobs.userUploadIds}))`,
  );
  for (;;) {
    const batch = await db
      .select({ id: uploads.id, rawUrl: uploads.rawUrl, url: uploads.url })
      .from(uploads)
      .where(orphan)
      .limit(CLEANUP_BATCH_SIZE);
    if (batch.length === 0) break;
    const urls = batch.flatMap((row) => (row.url ? [row.rawUrl, row.url] : [row.rawUrl]));
    counts.deletedBlobs += await deleteObjects(urls);
    // `orphan` again: an upload a job picked up since the select keeps its row.
    const deleted = await db
      .delete(uploads)
      .where(and(inArray(uploads.id, batch.map((row) => row.id)), orphan))
      .returning({ id: uploads.id });
    counts.deletedUploads += deleted.length;
  }

  // 4. Raw photos are deleted right after normalizing; these are leftovers from uploads that never finished.
  let stale: string[] = [];
  for await (const object of listObjects('sessions/')) {
    if (!RAW_PATH.test(object.pathname) || object.uploadedAt >= orphanCutoff) continue;
    stale.push(object.url);
    if (stale.length === CLEANUP_BATCH_SIZE) {
      counts.deletedBlobs += await deleteObjects(stale);
      stale = [];
    }
  }
  if (stale.length > 0) counts.deletedBlobs += await deleteObjects(stale);

  console.info('[cleanup] done', counts);
  return counts;
}
