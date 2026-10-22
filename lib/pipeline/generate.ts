import 'server-only';
import { randomInt } from 'node:crypto';
import { and, eq, inArray } from 'drizzle-orm';
import { TemplateAnalysis } from '../ai/schemas';
import { db } from '../db';
import { candidates, jobRounds, jobs, uploads, type Candidate, type Upload } from '../db/schema';
import { AppError, isErrorCode } from '../errors';
import { submitToQueue } from '../fal/client';
import { buildInput, PRIMARY_GENERATOR, type FalModel } from '../fal/models';
import { CANDIDATES_PER_ROUND } from '../limits';
import { markStageEnd, markStageStart } from '../telemetry';
import type { ErrorCode, JobNotice } from '../types';
import { webhookUrlFor } from '../webhook-token';
import { analyzeJob } from './analyze';
import { detectCases } from './cases';
import { failJob, setStage } from './orchestrator';
import { selectReference } from './preprocess';
import { buildPrompt } from './prompt';

/**
 * The after() work of a generation round: analyze (round 1 only), choose the photos, build the
 * prompt and submit CANDIDATES_PER_ROUND seeded candidates to the fal queue. Results arrive later
 * through the webhook. Never throws: any failure ends the job with a catalogue error code.
 */

/** Postgres `int` seeds, so they fit the column and every generator's seed field. */
const SEED_MAX = 2 ** 31 - 1;

function distinctSeeds(count: number): number[] {
  const seeds = new Set<number>();
  while (seeds.size < count) seeds.add(randomInt(0, SEED_MAX));
  return [...seeds];
}

export type CandidateInput = { prompt: string; imageUrls: string[] };

/**
 * Submits one candidate attempt and stores its `fal_request_id`. A rejected submission marks the
 * candidate failed with its code instead of throwing. Returns the code, or null on success.
 */
export async function submitCandidate(candidate: Candidate, { prompt, imageUrls }: CandidateInput): Promise<ErrorCode | null> {
  const model = candidate.model as FalModel;
  try {
    const { requestId } = await submitToQueue({
      model,
      input: buildInput(model, { prompt, imageUrls, seed: candidate.seed }),
      webhookUrl: webhookUrlFor(candidate.id, candidate.attempt),
      context: { jobId: candidate.jobId, roundId: candidate.roundId, candidateId: candidate.id, stage: 'generating' },
    });
    await db.update(candidates).set({ falRequestId: requestId, submittedAt: new Date() }).where(eq(candidates.id, candidate.id));
    return null;
  } catch (err) {
    const code: ErrorCode = err instanceof AppError && err.code === 'CONTENT_BLOCKED' ? 'CONTENT_BLOCKED' : 'GENERATION_FAILED';
    if (!(err instanceof AppError)) console.error('[generate] submit failed', { candidateId: candidate.id, err });
    await db
      .update(candidates)
      .set({ status: 'failed', errorCode: code, completedAt: new Date() })
      .where(eq(candidates.id, candidate.id));
    return code;
  }
}

async function loadUploads(ids: string[]): Promise<Map<string, Upload>> {
  const rows = await db.select().from(uploads).where(inArray(uploads.id, ids));
  return new Map(rows.map((row) => [row.id, row]));
}

export async function runGenerationRound({ jobId, roundId }: { jobId: string; roundId: string }): Promise<void> {
  try {
    await generate(jobId, roundId);
  } catch (err) {
    const code = err instanceof AppError && isErrorCode(err.code) ? err.code : 'INTERNAL_ERROR';
    if (!(err instanceof AppError)) console.error('[generate] round failed', { jobId, roundId, err });
    await failJob(jobId, roundId, code).catch((failErr) => console.error('[generate] failJob failed', { jobId, failErr }));
  }
}

async function generate(jobId: string, roundId: string): Promise<void> {
  const [job] = await db.select().from(jobs).where(eq(jobs.id, jobId));
  const [round] = await db
    .select()
    .from(jobRounds)
    .where(and(eq(jobRounds.id, roundId), eq(jobRounds.jobId, jobId)));
  if (!job || !round) throw new AppError('JOB_NOT_FOUND', { detail: `runGenerationRound: ${jobId}/${roundId} missing` });

  const byId = await loadUploads([job.templateUploadId, ...job.userUploadIds]);
  const template = byId.get(job.templateUploadId);
  const userPhotos = job.userUploadIds.map((id) => byId.get(id)).filter((u): u is Upload => !!u);
  if (!template?.url || userPhotos.length !== job.userUploadIds.length) {
    throw new AppError('UPLOAD_NOT_FOUND', { detail: 'runGenerationRound: an upload is gone' });
  }

  // Try again rounds reuse the stored analysis; only the first round pays for the LLM call.
  const fresh = job.analysis == null;
  let analysis: TemplateAnalysis;
  if (fresh) {
    try {
      analysis = await analyzeJob({ jobId, roundId, template, userPhotos });
    } catch (err) {
      console.error('[generate] analysis failed', { jobId, err: err instanceof Error ? err.message : err });
      await failJob(jobId, roundId, 'ANALYSIS_FAILED');
      return;
    }
  } else {
    analysis = TemplateAnalysis.parse(job.analysis);
  }

  const cases = detectCases(analysis);
  const selection = selectReference(userPhotos, analysis);
  const used = selection.usedIds.map((id) => byId.get(id)!);
  const prompt = buildPrompt({
    analysis,
    cases,
    userPhotoCount: used.length,
    peopleCount: analysis.template.people_count,
  });

  if (fresh) {
    const { people_count: count, subject } = analysis.template;
    const notices: JobNotice[] = [...selection.notices];
    if (count > 1) notices.push({ code: 'TEMPLATE_MULTIPLE_PEOPLE', params: { count, subjectLabel: subject.label } });
    await db
      .update(jobs)
      .set({
        analysis,
        flags: { crossGender: cases.crossGender, crossAge: cases.crossAge, multiPerson: count > 1, subjectLabel: subject.label },
        prompt,
        referenceUploadId: selection.referenceId,
        notices: [...job.notices, ...notices],
      })
      .where(eq(jobs.id, jobId));
  }

  await markStageEnd(roundId, 'analyzing');
  // The job moved on (timed out, or a newer round started) while this one was analyzing.
  if (!(await setStage(jobId, roundId, 'generating'))) return;
  await markStageStart(roundId, 'generating');

  const inserted = await db
    .insert(candidates)
    .values(
      distinctSeeds(CANDIDATES_PER_ROUND).map((seed) => ({
        jobId,
        roundId,
        kind: 'generation' as const,
        model: PRIMARY_GENERATOR,
        seed,
        attempt: 1,
        status: 'pending' as const,
      })),
    )
    .returning();

  const input: CandidateInput = { prompt, imageUrls: [template.url, ...used.map((u) => u.url!)] };
  const results = await Promise.all(inserted.map((candidate) => submitCandidate(candidate, input)));
  const failures = results.filter((code): code is ErrorCode => code !== null);
  if (failures.length === inserted.length) {
    await failJob(jobId, roundId, failures.includes('CONTENT_BLOCKED') ? 'CONTENT_BLOCKED' : 'GENERATION_FAILED');
  }
}
