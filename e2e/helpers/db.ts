import { createHmac } from 'node:crypto';
import postgres from 'postgres';
import { E2E, databaseUrl } from '../env';

/**
 * Test-only database access for the e2e specs: seeding states the UI can't reach quickly (a used-up
 * day, a job past its deadline) and reading rows back. Plain SQL, because the app's db module is
 * server-only and validates the whole environment on import.
 */

let client: postgres.Sql | null = null;

/** prepare: false, like lib/db: the Supabase transaction pooler has no prepared statements. */
export function sql(): postgres.Sql {
  client ??= postgres(databaseUrl(), { prepare: false, max: 2, idle_timeout: 5, onnotice: () => {} });
  return client;
}

export async function closeDb(): Promise<void> {
  await client?.end({ timeout: 5 });
  client = null;
}

async function seedTemplate(sid: string): Promise<string> {
  const [row] = await sql()`
    insert into uploads (session_id, kind, status, raw_url, width, height, bytes)
    values (${sid}, 'template', 'ok', 'https://e2e.invalid/template.jpg', 640, 480, 1)
    returning id`;
  return row.id as string;
}

/** Uses up `count` of the session's daily units: one finished job with `count` rounds started now. */
export async function seedRounds(sid: string, count: number): Promise<void> {
  const templateId = await seedTemplate(sid);
  const [job] = await sql()`
    insert into jobs (session_id, status, stage, template_upload_id, user_upload_ids, current_round, finished_at)
    values (${sid}, 'succeeded', 'done', ${templateId}, '{}', ${count}, now())
    returning id`;
  await sql()`
    insert into job_rounds (job_id, session_id, round, kind, status, finished_at)
    select ${job.id}::uuid, ${sid}::uuid, n, 'generation', 'succeeded', now()
    from generate_series(1, ${count}::int) as n`;
}

/** A job still running round 1 whose 6-minute deadline passed a minute ago. Returns its id. */
export async function seedOverdueJob(sid: string): Promise<string> {
  const templateId = await seedTemplate(sid);
  const [job] = await sql()`
    insert into jobs (session_id, status, stage, template_upload_id, user_upload_ids, current_round, deadline_at)
    values (${sid}, 'running', 'generating', ${templateId}, '{}', 1, now() - interval '1 minute')
    returning id`;
  await sql()`
    insert into job_rounds (job_id, session_id, round, kind, started_at)
    values (${job.id}, ${sid}, 1, 'generation', now() - interval '7 minutes')`;
  return job.id as string;
}

export type JobSnapshot = {
  status: string;
  updatedAt: string;
  chosenCandidateId: string | null;
  candidates: { status: string; imageUrl: string | null }[];
};

export async function jobSnapshot(jobId: string): Promise<JobSnapshot> {
  const [job] = await sql()`select status, updated_at, chosen_candidate_id from jobs where id = ${jobId}`;
  const rows = await sql()`select status, image_url from candidates where job_id = ${jobId} order by id`;
  return {
    status: job.status,
    updatedAt: new Date(job.updated_at).toISOString(),
    chosenCandidateId: job.chosen_candidate_id,
    candidates: rows.map((r) => ({ status: r.status, imageUrl: r.image_url })),
  };
}

/** A finished candidate of the job, with what fal's webhook for it carried. */
export async function succeededCandidate(
  jobId: string,
): Promise<{ id: string; attempt: number; requestId: string; imageUrl: string }> {
  const [row] = await sql()`
    select id, attempt, fal_request_id, image_url from candidates
    where job_id = ${jobId} and status = 'succeeded' and fal_request_id is not null
    order by rank nulls last limit 1`;
  if (!row) throw new Error(`job ${jobId} has no succeeded candidate`);
  return { id: row.id, attempt: row.attempt, requestId: row.fal_request_id, imageUrl: row.image_url };
}

/** The per-attempt callback path lib/webhook-token.ts builds, signed with the e2e server's secret. */
export function webhookPath(candidateId: string, attempt: number): string {
  const token = createHmac('sha256', E2E.webhookSecret).update(`${candidateId}:${attempt}`).digest('base64url');
  return `/api/webhooks/fal?${new URLSearchParams({ cid: candidateId, a: String(attempt), t: token })}`;
}

/** Deletes everything the given sessions created. Rounds, candidates, provider calls and webhook events cascade from jobs. */
export async function deleteSessions(sids: string[]): Promise<void> {
  if (sids.length === 0) return;
  await sql()`delete from jobs where session_id = any(${sids}::uuid[])`;
  await sql()`delete from uploads where session_id = any(${sids}::uuid[])`;
}
