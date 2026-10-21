import { eq } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { candidates, jobRounds, jobs, providerCalls, uploads, webhookEvents } from '@/lib/db/schema';
import { createTestDb, type TestDb } from './helpers/db';

const SID = '00000000-0000-0000-0000-0000000000aa';

let db: TestDb;
let close: () => Promise<void>;

beforeAll(async () => {
  ({ db, close } = await createTestDb());
});

afterAll(async () => {
  await close();
});

/** Postgres unique_violation, wherever the driver nests it. */
async function expectUniqueViolation(promise: Promise<unknown>) {
  const error = await promise.then(
    () => null,
    (e: unknown) => e,
  );
  expect(error).not.toBeNull();
  const err = error as { code?: string; cause?: { code?: string } };
  expect(err.cause?.code ?? err.code).toBe('23505');
}

async function seedJob() {
  const [template] = await db
    .insert(uploads)
    .values({ sessionId: SID, kind: 'template', rawUrl: 'raw', width: 10, height: 10, bytes: 100 })
    .returning();
  const [job] = await db
    .insert(jobs)
    .values({ sessionId: SID, templateUploadId: template.id, userUploadIds: [] })
    .returning();
  const [round] = await db
    .insert(jobRounds)
    .values({ jobId: job.id, sessionId: SID, round: 1, kind: 'generation' })
    .returning();
  return { job, round };
}

function newCandidate(jobId: string, roundId: string, falRequestId: string | null) {
  return { jobId, roundId, kind: 'generation' as const, model: 'mock', seed: 1, falRequestId };
}

describe('schema constraints', () => {
  it('rejects a duplicate webhook event for the same provider, request and status', async () => {
    const event = { provider: 'fal', requestId: 'req-dup', status: 'OK' };
    await db.insert(webhookEvents).values(event);
    await expectUniqueViolation(db.insert(webhookEvents).values(event));
    // A different status for the same request is a separate event.
    await db.insert(webhookEvents).values({ ...event, status: 'ERROR' });
  });

  it('rejects two candidates with the same fal request id', async () => {
    const { job, round } = await seedJob();
    await db.insert(candidates).values(newCandidate(job.id, round.id, 'fal-dup'));
    await expectUniqueViolation(db.insert(candidates).values(newCandidate(job.id, round.id, 'fal-dup')));
    // Unsubmitted candidates (null request id) don't collide.
    await db.insert(candidates).values(newCandidate(job.id, round.id, null));
    await db.insert(candidates).values(newCandidate(job.id, round.id, null));
  });

  it('cascades a job delete to rounds, candidates and provider calls', async () => {
    const { job, round } = await seedJob();
    const [candidate] = await db.insert(candidates).values(newCandidate(job.id, round.id, 'fal-cascade')).returning();
    await db.insert(providerCalls).values({
      jobId: job.id,
      roundId: round.id,
      candidateId: candidate.id,
      provider: 'fal',
      model: 'mock',
      stage: 'generating',
      status: 'ok',
      latencyMs: 1000,
      costUsdMicros: 40_000,
    });
    await db.insert(webhookEvents).values({ provider: 'fal', requestId: 'fal-cascade', status: 'OK', candidateId: candidate.id });

    await db.delete(jobs).where(eq(jobs.id, job.id));

    expect(await db.select().from(jobRounds).where(eq(jobRounds.jobId, job.id))).toHaveLength(0);
    expect(await db.select().from(candidates).where(eq(candidates.jobId, job.id))).toHaveLength(0);
    expect(await db.select().from(providerCalls).where(eq(providerCalls.jobId, job.id))).toHaveLength(0);
    expect(await db.select().from(webhookEvents).where(eq(webhookEvents.candidateId, candidate.id))).toHaveLength(0);
  });

  it('applies column defaults', async () => {
    const { job } = await seedJob();
    expect(job.status).toBe('queued');
    expect(job.currentRound).toBe(0);
    expect(job.notices).toEqual([]);
    expect(job.flags).toEqual({ crossGender: false, crossAge: false, multiPerson: false, subjectLabel: null });
    expect(job.createdAt).toBeInstanceOf(Date);
  });
});
