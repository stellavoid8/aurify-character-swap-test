import 'server-only';
import { and, asc, eq, inArray } from 'drizzle-orm';
import { ai } from '../ai';
import { db } from '../db';
import { candidates, jobRounds, jobs, uploads, type Candidate, type Upload } from '../db/schema';
import { cosine, faceEngine, type FaceCallContext } from '../face';
import { FACE_MIN_SCORE, TEMPLATE_FACE_COSINE, TIE_BREAK_ACTION_WEIGHT, TIE_BREAK_DELTA } from '../limits';
import { fetchObject } from '../storage';
import { recordCall } from '../telemetry';
import type { Face } from '../types';

/**
 * Picks the round's best version. Each succeeded candidate is scored by the cosine similarity of
 * its subject's face to the reference photo's embedding; a near tie at the top is settled by the
 * vision LLM's action rating. Two failures the score alone can't see rank below every clean
 * result: a version that kept the template person's face (`template_face`), and one with more faces
 * than the template, such as a collage or added passers-by (`extra_faces`, likeness left out, since
 * any one of its faces can match the user). Never throws while the round has a result: if ranking
 * itself breaks, the earliest result wins unscored.
 */

/** Why a candidate's identity score is what it is; stored on its `ranking` (or `refining`) provider_calls row. */
type ScoreReason = 'scored' | 'template_face' | 'extra_faces' | 'no_face' | 'no_reference' | 'error';

type Scored = { candidate: Candidate; identity: number | null; action: number | null; reason: ScoreReason };

/** What a round's results are checked against besides the user: the template's face count and its subject's embedding. */
type TemplateChecks = { faceCount: number; subject: number[] | null };

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
    await writeRanks(succeeded.map((candidate) => ({ candidate, identity: null, action: null, reason: 'error' as const })), null).catch((writeErr) =>
      console.error('[rank] fallback rank write failed', { roundId, writeErr }),
    );
    return succeeded[0].id;
  }
}

/** What a job's results are scored against: the reference photo's embedding and where the template's subject is. */
type IdentityTarget = { template: Upload; reference: number[] | null; target: [number, number] | null };

async function identityTargetFor(jobId: string): Promise<IdentityTarget> {
  const [job] = await db.select().from(jobs).where(eq(jobs.id, jobId));
  const uploadIds = [job.templateUploadId, ...(job.referenceUploadId ? [job.referenceUploadId] : [])];
  const byId = new Map((await db.select().from(uploads).where(inArray(uploads.id, uploadIds))).map((u) => [u.id, u]));
  const template = byId.get(job.templateUploadId)!;
  const reference = job.referenceUploadId ? (byId.get(job.referenceUploadId)?.embedding ?? null) : null;
  return { template, reference, target: subjectCentre(template) };
}

/**
 * One finished candidate's likeness, measured exactly as rankRound measures it. Used by Fix the
 * face, so its before and after numbers are comparable. Null when it can't be measured.
 */
export async function scoreIdentity(candidate: Candidate, stage: string): Promise<number | null> {
  try {
    const { reference, target } = await identityTargetFor(candidate.jobId);
    return (await identityScore(candidate, reference, target, stage)).score;
  } catch (err) {
    console.error('[rank] identity target unavailable', { candidateId: candidate.id, err: err instanceof Error ? err.message : err });
    return null;
  }
}

/**
 * A video's likeness: each frame scored as rankRound scores a still, and the lowest kept, so the
 * point where the face drifted furthest from the user is what the number shows. Null when no frame
 * could be measured.
 */
export async function scoreVideoIdentity(candidate: Candidate, frameUrls: string[]): Promise<number | null> {
  try {
    const { reference, target } = await identityTargetFor(candidate.jobId);
    const scores: number[] = [];
    for (const url of frameUrls) {
      const { score } = await identityScore(candidate, reference, target, 'animating', url);
      if (score !== null) scores.push(score);
    }
    return scores.length > 0 ? Math.min(...scores) : null;
  } catch (err) {
    console.error('[rank] video identity unavailable', { candidateId: candidate.id, err: err instanceof Error ? err.message : err });
    return null;
  }
}

async function scoreAndRank(roundId: string, succeeded: Candidate[]): Promise<string> {
  const [round] = await db.select().from(jobRounds).where(eq(jobRounds.id, roundId));
  const { template, reference, target } = await identityTargetFor(round.jobId);
  const checks = await templateChecks(template, target, { jobId: round.jobId, roundId, stage: 'ranking' });

  const scored: Scored[] = [];
  // One at a time: the face models are CPU-bound, so parallel passes would only contend.
  for (const candidate of succeeded) {
    const { score, reason } = await identityScore(candidate, reference, target, 'ranking', candidate.imageUrl!, checks);
    scored.push({ candidate, identity: score, action: null, reason });
  }
  scored.sort(byIdentity);

  const [top1, top2] = scored;
  if (
    top2 &&
    top1.reason === 'scored' &&
    top2.reason === 'scored' &&
    top1.identity !== null &&
    top2.identity !== null &&
    top1.identity - top2.identity < TIE_BREAK_DELTA
  ) {
    await breakTie(template, top1, top2);
    const weighted = (s: Scored) => s.identity! + TIE_BREAK_ACTION_WEIGHT * (s.action ?? 0);
    if (weighted(top2) > weighted(top1)) [scored[0], scored[1]] = [top2, top1];
  }

  await writeRanks(scored, faceEngine.name);
  return scored[0].candidate.id;
}

/** Clean results first, then ones that kept the template's face, then unscored; earlier results win ties, since `succeeded` is in completion order. */
function byIdentity(a: Scored, b: Scored): number {
  const tier = (s: Scored) => (s.identity === null ? 2 : s.reason === 'template_face' ? 1 : 0);
  if (tier(a) !== tier(b)) return tier(a) - tier(b);
  if (a.identity === null || b.identity === null) return 0;
  return b.identity - a.identity;
}

/**
 * The template's confident face count, and its subject's embedding (null when it has no subject face
 * or embedding it fails, which only skips the template-face check).
 */
async function templateChecks(template: Upload, target: [number, number] | null, ctx: FaceCallContext): Promise<TemplateChecks> {
  const faceCount = template.faces.filter((face) => face.score >= FACE_MIN_SCORE).length;
  if (!target) return { faceCount, subject: null };
  try {
    const jpeg = await fetchObject(template.url!);
    const { faces, width, height } = await faceEngine.analyzeImage(jpeg, ctx);
    const face = pickFace(faces, width, height, target);
    return { faceCount, subject: face ? await faceEngine.embedFace(jpeg, face, ctx) : null };
  } catch (err) {
    console.error('[rank] template subject embedding failed', { templateId: template.id, err: err instanceof Error ? err.message : err });
    return { faceCount, subject: null };
  }
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

/**
 * Cosine similarity to the reference, or null (with the reason recorded) when it can't be measured.
 * Scores the candidate's image, or `imageUrl` when given (a frame of a video result). With `checks`
 * (ranking only), also flags a result with extra faces or the template subject's face.
 */
async function identityScore(
  candidate: Candidate,
  reference: number[] | null,
  target: [number, number] | null,
  stage: string,
  imageUrl: string = candidate.imageUrl!,
  checks?: TemplateChecks,
): Promise<{ score: number | null; reason: ScoreReason }> {
  const ctx = { jobId: candidate.jobId, roundId: candidate.roundId, candidateId: candidate.id, stage };
  const started = performance.now();
  let score: number | null = null;
  let templateSimilarity: number | null = null;
  let faceCount: number | null = null;
  let reason: ScoreReason;
  try {
    if (!reference) {
      reason = 'no_reference';
    } else {
      const jpeg = await fetchObject(imageUrl);
      const { faces, width, height } = await faceEngine.analyzeImage(jpeg, ctx);
      const face = pickFace(faces, width, height, target);
      faceCount = faces.filter((f) => f.score >= FACE_MIN_SCORE).length;
      if (!face) {
        reason = 'no_face';
      } else {
        const embedding = await faceEngine.embedFace(jpeg, face, ctx);
        score = cosine(embedding, reference);
        reason = 'scored';
        if (checks?.subject) {
          templateSimilarity = cosine(embedding, checks.subject);
          if (templateSimilarity >= TEMPLATE_FACE_COSINE && templateSimilarity > score) reason = 'template_face';
        }
        if (checks && faceCount > Math.max(checks.faceCount, 1)) {
          reason = 'extra_faces';
          score = null;
        }
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
    meta: { identityScore: score, reason, ...(checks && { templateSimilarity, faceCount, templateFaceCount: checks.faceCount }) },
  });
  return { score, reason };
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
