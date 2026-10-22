import 'server-only';
import { and, asc, eq, inArray } from 'drizzle-orm';
import { ai } from '../ai';
import { db } from '../db';
import { candidates, jobRounds, jobs, uploads, type Candidate, type Upload } from '../db/schema';
import { cosine, faceEngine } from '../face';
import { FACE_MIN_SCORE, TIE_BREAK_ACTION_WEIGHT, TIE_BREAK_DELTA } from '../limits';
import { fetchObject } from '../storage';
import { recordCall } from '../telemetry';
import type { Face } from '../types';

/**
 * Picks the round's best version. Each succeeded candidate is scored by the cosine similarity of
 * its subject's face to the reference photo's embedding; a near tie at the top is settled by the
 * vision LLM's action rating. Never throws while the round has a result: if ranking itself
 * breaks, the earliest result wins unscored.
 */

/** Why a candidate's identity score is what it is; stored on its `ranking` provider_calls row. */
type ScoreReason = 'scored' | 'no_face' | 'no_reference' | 'error';

type Scored = { candidate: Candidate; identity: number | null; action: number | null };

/** Returns the rank-1 candidate's id, or null when the round has no succeeded candidate. */
export async function rankRound(roundId: string): Promise<string | null> {
  const succeeded = await db
    .select()
    .from(candidates)
    .where(and(eq(candidates.roundId, roundId), eq(candidates.status, 'succeeded')))
    .orderBy(asc(candidates.completedAt), asc(candidates.id));
  if (succeeded.length === 0) return null;

  try {
    return await scoreAndRank(roundId, succeeded);
  } catch (err) {
    console.error('[rank] ranking failed; keeping the earliest result', { roundId, err: err instanceof Error ? err.message : err });
    await writeRanks(succeeded.map((candidate) => ({ candidate, identity: null, action: null })), null).catch((writeErr) =>
      console.error('[rank] fallback rank write failed', { roundId, writeErr }),
    );
    return succeeded[0].id;
  }
}

async function scoreAndRank(roundId: string, succeeded: Candidate[]): Promise<string> {
  const [round] = await db.select().from(jobRounds).where(eq(jobRounds.id, roundId));
  const [job] = await db.select().from(jobs).where(eq(jobs.id, round.jobId));
  const uploadIds = [job.templateUploadId, ...(job.referenceUploadId ? [job.referenceUploadId] : [])];
  const byId = new Map((await db.select().from(uploads).where(inArray(uploads.id, uploadIds))).map((u) => [u.id, u]));
  const template = byId.get(job.templateUploadId)!;
  const reference = job.referenceUploadId ? (byId.get(job.referenceUploadId)?.embedding ?? null) : null;
  const target = subjectCentre(template);

  const scored: Scored[] = [];
  // One at a time: the face models are CPU-bound, so parallel passes would only contend.
  for (const candidate of succeeded) {
    scored.push({ candidate, identity: await identityScore(candidate, reference, target), action: null });
  }
  scored.sort(byIdentity);

  const [top1, top2] = scored;
  if (top2 && top1.identity !== null && top2.identity !== null && top1.identity - top2.identity < TIE_BREAK_DELTA) {
    await breakTie(template, top1, top2);
    const weighted = (s: Scored) => s.identity! + TIE_BREAK_ACTION_WEIGHT * (s.action ?? 0);
    if (weighted(top2) > weighted(top1)) [scored[0], scored[1]] = [top2, top1];
  }

  await writeRanks(scored, faceEngine.name);
  return scored[0].candidate.id;
}

/** Highest identity first, unscored last; earlier results win ties, since `succeeded` is in completion order. */
function byIdentity(a: Scored, b: Scored): number {
  if (a.identity === null || b.identity === null) return (a.identity === null ? 1 : 0) - (b.identity === null ? 1 : 0);
  return b.identity - a.identity;
}

/** Normalized centre of the template's subject face, or null when the template has none. */
function subjectCentre(template: Upload): [number, number] | null {
  const face = template.subjectFaceIndex == null ? undefined : template.faces[template.subjectFaceIndex];
  if (!face) return null;
  const [x, y, w, h] = face.box;
  return [x + w / 2, y + h / 2];
}

/** The candidate face standing in for the template subject: nearest its centre, else the largest. */
function pickFace(faces: Face[], width: number, height: number, target: [number, number] | null): Face | null {
  const confident = faces.filter((face) => face.score >= FACE_MIN_SCORE);
  if (confident.length === 0) return null;
  const cost = (face: Face) => {
    const [x, y, w, h] = face.box;
    if (!target) return -(w * h);
    return Math.hypot((x + w / 2) / width - target[0], (y + h / 2) / height - target[1]);
  };
  return confident.reduce((best, face) => (cost(face) < cost(best) ? face : best));
}

/** Cosine similarity to the reference, or null (with the reason recorded) when it can't be measured. */
async function identityScore(candidate: Candidate, reference: number[] | null, target: [number, number] | null): Promise<number | null> {
  const ctx = { jobId: candidate.jobId, roundId: candidate.roundId, candidateId: candidate.id, stage: 'ranking' };
  const started = performance.now();
  let score: number | null = null;
  let reason: ScoreReason;
  try {
    if (!reference) {
      reason = 'no_reference';
    } else {
      const jpeg = await fetchObject(candidate.imageUrl!);
      const { faces, width, height } = await faceEngine.analyzeImage(jpeg, ctx);
      const face = pickFace(faces, width, height, target);
      if (face) {
        score = cosine(await faceEngine.embedFace(jpeg, face, ctx), reference);
        reason = 'scored';
      } else {
        reason = 'no_face';
      }
    }
  } catch (err) {
    console.error('[rank] scoring failed', { candidateId: candidate.id, err: err instanceof Error ? err.message : err });
    reason = 'error';
  }
  await recordCall({
    ...ctx,
    provider: 'local',
    model: `${faceEngine.name}-identity`,
    status: reason === 'error' ? 'error' : 'ok',
    latencyMs: performance.now() - started,
    costUsdMicros: 0,
    meta: { identityScore: score, reason },
  });
  return score;
}

/** Asks the vision LLM which of the top two better matches the template's action. A failed call keeps identity order. */
async function breakTie(template: Upload, top1: Scored, top2: Scored): Promise<void> {
  try {
    const { result } = await ai.rateAction({
      templateUrl: template.url!,
      candidateUrls: [top1.candidate.imageUrl!, top2.candidate.imageUrl!],
      context: { jobId: top1.candidate.jobId, roundId: top1.candidate.roundId },
    });
    for (const { index, score } of result.scores) {
      const entry = [top1, top2][index - 1];
      if (entry) entry.action = score;
    }
  } catch (err) {
    console.error('[rank] action tie-break failed', { roundId: top1.candidate.roundId, err: err instanceof Error ? err.message : err });
  }
}

async function writeRanks(ordered: Scored[], scorer: Candidate['scorer']): Promise<void> {
  await db.transaction(async (tx) => {
    for (const [i, { candidate, identity, action }] of ordered.entries()) {
      await tx
        .update(candidates)
        .set({ rank: i + 1, identityScore: identity, actionScore: action, scorer })
        .where(eq(candidates.id, candidate.id));
    }
  });
}
