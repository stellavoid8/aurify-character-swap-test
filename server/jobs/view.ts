import 'server-only';
import { and, asc, eq, inArray, sql } from 'drizzle-orm';
import { TemplateAnalysis } from '@/lib/ai/schemas';
import { db } from '@/lib/db';
import { candidates, jobRounds, uploads, type Job } from '@/lib/db/schema';
import { ERRORS, formatNotice, isErrorCode } from '@/lib/errors';
import { MAX_ROUNDS_PER_JOB } from '@/lib/limits';
import { enforceTimeout } from '@/lib/pipeline/timeout';
import { unitsLeftToday } from '@/lib/rate-limit';
import type { JobView } from '@/lib/types';
import { getEtaMs } from '@/server/stats/queries';
import { getJobForSession } from './queries';

/** The one job view, for the page's first render and for polling. Times the job out first if it is past its deadline. */
export async function getJobView(sid: string, jobId: string): Promise<JobView> {
  const job = await enforceTimeout(await getJobForSession(sid, jobId));

  const [rounds, photos, rows, etaMs, unitsLeft] = await Promise.all([
    db.select().from(jobRounds).where(and(eq(jobRounds.jobId, job.id), eq(jobRounds.round, job.currentRound))),
    db
      .select()
      .from(uploads)
      .where(and(eq(uploads.sessionId, sid), inArray(uploads.id, [job.templateUploadId, ...job.userUploadIds]))),
    db
      .select({ candidate: candidates, round: jobRounds.round })
      .from(candidates)
      .innerJoin(jobRounds, eq(jobRounds.id, candidates.roundId))
      .where(eq(candidates.jobId, job.id))
      .orderBy(asc(jobRounds.round), sql`${candidates.rank} asc nulls last`, asc(candidates.submittedAt), asc(candidates.id)),
    getEtaMs(),
    unitsLeftToday(sid),
  ]);
  const round = rounds[0];
  const byId = new Map(photos.map((p) => [p.id, p]));
  const template = byId.get(job.templateUploadId);
  const subject = template?.subjectFaceIndex == null ? undefined : template.faces[template.subjectFaceIndex];
  const analysis = TemplateAnalysis.safeParse(job.analysis);

  const finished = job.status === 'succeeded' || job.status === 'failed' || job.status === 'timed_out';
  const roundsLeft = job.currentRound < MAX_ROUNDS_PER_JOB && unitsLeft > 0;

  return {
    id: job.id,
    status: job.status,
    stage: job.stage,
    round: job.currentRound,
    elapsedMs: round ? Math.max(0, (round.finishedAt ?? new Date()).getTime() - round.startedAt.getTime()) : 0,
    etaMs,
    deadlineAt: job.deadlineAt?.toISOString() ?? null,
    error: viewError(job),
    template: {
      url: template?.url ?? null,
      width: template?.width ?? 0,
      height: template?.height ?? 0,
      subjectBox: subject?.box ?? null,
      peopleCount: analysis.success ? analysis.data.template.people_count : null,
      subjectLabel: job.flags.subjectLabel,
    },
    userPhotos: job.userUploadIds.map((id) => ({
      id,
      url: byId.get(id)?.url ?? null,
      isReference: id === job.referenceUploadId,
    })),
    notices: job.notices.map((n) => ({ code: n.code, message: formatNotice(n.code, n.params) })),
    candidates: rows.map(({ candidate: c, round: n }) => ({
      id: c.id,
      round: n,
      kind: c.kind,
      status: c.status,
      imageUrl: c.imageUrl,
      identityScore: c.identityScore,
      actionScore: c.actionScore,
      rank: c.rank,
      parentCandidateId: c.parentCandidateId,
    })),
    chosenCandidateId: job.chosenCandidateId,
    canRetry: finished && roundsLeft,
    canRefine: job.status === 'succeeded' && job.chosenCandidateId !== null && roundsLeft,
    unitsLeftToday: unitsLeft,
  };
}

/** Catalogue copy for a failed or timed-out job; an unknown stored code shows as INTERNAL_ERROR. */
function viewError(job: Job): JobView['error'] {
  if (job.status !== 'failed' && job.status !== 'timed_out') return null;
  const code = isErrorCode(job.errorCode) ? job.errorCode : job.status === 'timed_out' ? 'JOB_TIMED_OUT' : 'INTERNAL_ERROR';
  return { code, message: ERRORS[code].message, nextStep: ERRORS[code].nextStep };
}
