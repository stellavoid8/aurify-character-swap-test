/**
 * Dev seed: one finished demo job with three succeeded candidates, so the result screen and
 * scripts/report.ts have data before any real generation runs. Fixed ids + upserts make it idempotent.
 * Run with `npm run db:seed`. `npm run db:seed -- --eta-samples` also adds ETA_SAMPLE_SECONDS.length
 * finished real-scored rounds from earlier days, so the waiting screen's ETA switches from the
 * default to their p50 (200 s → "Usually about 3 min").
 */
import './load-env';
import { mkdir } from 'node:fs/promises';
import path from 'node:path';
import sharp from 'sharp';
import { db } from '../lib/db';
import { candidates, jobRounds, jobs, providerCalls, uploads, type NewUpload } from '../lib/db/schema';

const WITH_ETA_SAMPLES = process.argv.includes('--eta-samples');
/** Durations of the ETA sample rounds; p50 = 200 s. One per day back, so none counts toward today's units. */
const ETA_SAMPLE_SECONDS = [150, 185, 200, 215, 260];

const SESSION_ID = '00000000-0000-0000-0000-000000000001';
const ids = {
  template: '00000000-0000-4000-8000-000000000101',
  user: '00000000-0000-4000-8000-000000000102',
  job: '00000000-0000-4000-8000-000000000201',
  round: '00000000-0000-4000-8000-000000000301',
  candidates: [
    '00000000-0000-4000-8000-000000000401',
    '00000000-0000-4000-8000-000000000402',
    '00000000-0000-4000-8000-000000000403',
  ],
  calls: Array.from({ length: 7 }, (_, i) => `00000000-0000-4000-8000-0000000005${String(i + 1).padStart(2, '0')}`),
  etaJobs: ETA_SAMPLE_SECONDS.map((_, i) => `00000000-0000-4000-8000-0000000006${String(i + 1).padStart(2, '0')}`),
  etaRounds: ETA_SAMPLE_SECONDS.map((_, i) => `00000000-0000-4000-8000-0000000007${String(i + 1).padStart(2, '0')}`),
  etaCandidates: ETA_SAMPLE_SECONDS.map((_, i) => `00000000-0000-4000-8000-0000000008${String(i + 1).padStart(2, '0')}`),
};

const SIZE = 512;
const SEED_DIR = path.join(process.cwd(), 'public', 'seed');
const MOCK_MODEL = 'mock/character-swap';
const ANALYSIS_MODEL = 'claude-opus-5-5';

/** A flat placeholder with a label, so seeded rows have real image files behind them. */
async function writePlaceholder(file: string, label: string, background: string) {
  const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="${SIZE}" height="${SIZE}">
    <rect width="100%" height="100%" fill="${background}"/>
    <circle cx="256" cy="200" r="90" fill="#ffffff" fill-opacity="0.85"/>
    <text x="50%" y="400" font-family="sans-serif" font-size="40" font-weight="700" fill="#17171A" text-anchor="middle">${label}</text>
  </svg>`;
  await sharp(Buffer.from(svg)).jpeg({ quality: 85 }).toFile(path.join(SEED_DIR, file));
  return `/seed/${file}`;
}

/** Upsert on the primary key, overwriting every column with the seed value. */
function upsertSet<T extends Record<string, unknown>>(row: T): Omit<T, 'id'> {
  // eslint-disable-next-line @typescript-eslint/no-unused-vars
  const { id, ...rest } = row;
  return rest;
}

async function main() {
  await mkdir(SEED_DIR, { recursive: true });
  const templateUrl = await writePlaceholder('template.jpg', 'Template', '#E8ECFF');
  const userUrl = await writePlaceholder('user.jpg', 'You', '#E5F4EA');
  const candidateUrls = await Promise.all(
    [1, 2, 3].map((n) => writePlaceholder(`candidate-${n}.jpg`, `Version ${n}`, '#FFF3D6')),
  );

  const face = {
    box: [0.32, 0.21, 0.36, 0.36] as [number, number, number, number],
    score: 0.98,
    landmarks: [
      [0.43, 0.35],
      [0.57, 0.35],
      [0.5, 0.42],
      [0.45, 0.48],
      [0.55, 0.48],
    ] as [number, number][],
  };
  // Deterministic unit-length 512-d embedding.
  const raw = Array.from({ length: 512 }, (_, i) => Math.sin(i + 1));
  const norm = Math.hypot(...raw);
  const embedding = raw.map((v) => v / norm);

  const now = Date.now();
  const at = (secondsAgo: number) => new Date(now - secondsAgo * 1000);

  const uploadRows: NewUpload[] = [
    {
      id: ids.template,
      sessionId: SESSION_ID,
      kind: 'template',
      status: 'ok',
      rawUrl: templateUrl,
      url: templateUrl,
      width: SIZE,
      height: SIZE,
      bytes: 40_000,
      faces: [face],
      subjectFaceIndex: 0,
      qualityScore: 0.9,
      createdAt: at(300),
    },
    {
      id: ids.user,
      sessionId: SESSION_ID,
      kind: 'user',
      status: 'ok',
      rawUrl: userUrl,
      url: userUrl,
      width: SIZE,
      height: SIZE,
      bytes: 40_000,
      faces: [face],
      qualityScore: 0.85,
      embedding,
      createdAt: at(280),
    },
  ];

  const jobRow = {
    id: ids.job,
    sessionId: SESSION_ID,
    status: 'succeeded' as const,
    stage: 'done' as const,
    templateUploadId: ids.template,
    userUploadIds: [ids.user],
    referenceUploadId: ids.user,
    analysis: { action: 'jumping off a pier', subjectCount: 1, seeded: true },
    flags: { crossGender: false, crossAge: false, multiPerson: false, subjectLabel: 'the person jumping' },
    prompt: 'Seeded demo prompt.',
    currentRound: 1,
    chosenCandidateId: ids.candidates[0],
    notices: [],
    errorCode: null,
    errorMessage: null,
    deadlineAt: at(-300),
    createdAt: at(270),
    finishedAt: at(150),
  };

  const roundRow = {
    id: ids.round,
    jobId: ids.job,
    sessionId: SESSION_ID,
    round: 1,
    kind: 'generation' as const,
    status: 'succeeded' as const,
    stageTimings: {
      analyzing: { startedAt: at(270).toISOString(), endedAt: at(260).toISOString(), ms: 10_000 },
      generating: { startedAt: at(260).toISOString(), endedAt: at(160).toISOString(), ms: 100_000 },
      ranking: { startedAt: at(160).toISOString(), endedAt: at(150).toISOString(), ms: 10_000 },
    },
    startedAt: at(270),
    finishedAt: at(150),
  };

  const scores = [
    { identity: 0.71, action: 0.88 },
    { identity: 0.64, action: 0.9 },
    { identity: 0.58, action: 0.82 },
  ];
  const candidateRows = ids.candidates.map((id, i) => ({
    id,
    jobId: ids.job,
    roundId: ids.round,
    kind: 'generation' as const,
    parentCandidateId: null,
    model: MOCK_MODEL,
    seed: 1000 + i,
    attempt: 1,
    falRequestId: `seed-request-${i + 1}`,
    status: 'succeeded' as const,
    imageUrl: candidateUrls[i],
    identityScore: scores[i].identity,
    actionScore: scores[i].action,
    rank: i + 1,
    scorer: 'mock' as const,
    errorCode: null,
    latencyMs: 95_000 + i * 2_000,
    costUsdMicros: 40_000,
    submittedAt: at(258),
    completedAt: at(163 - i),
  }));

  const callRows = [
    {
      id: ids.calls[0],
      jobId: ids.job,
      roundId: ids.round,
      candidateId: null,
      provider: 'anthropic' as const,
      model: ANALYSIS_MODEL,
      stage: 'analyzing',
      requestId: 'seed-msg-1',
      status: 'ok' as const,
      latencyMs: 8_200,
      costUsdMicros: 21_000,
      meta: { inputTokens: 3_000, outputTokens: 450, seeded: true },
      createdAt: at(260),
    },
    ...candidateRows.map((c, i) => ({
      id: ids.calls[1 + i],
      jobId: ids.job,
      roundId: ids.round,
      candidateId: c.id,
      provider: 'fal' as const,
      model: MOCK_MODEL,
      stage: 'generating',
      requestId: c.falRequestId,
      status: 'ok' as const,
      latencyMs: c.latencyMs,
      costUsdMicros: c.costUsdMicros,
      meta: { seed: c.seed, seeded: true },
      createdAt: c.completedAt,
    })),
    ...candidateRows.map((c, i) => ({
      id: ids.calls[4 + i],
      jobId: ids.job,
      roundId: ids.round,
      candidateId: c.id,
      provider: 'local' as const,
      model: 'mock-face',
      stage: 'ranking',
      requestId: null,
      status: 'ok' as const,
      latencyMs: 300,
      costUsdMicros: 0,
      meta: { identityScore: c.identityScore, seeded: true },
      createdAt: at(155),
    })),
  ];

  // Finished rounds scored by the real face engine: the ETA query counts these and skips mock-scored ones.
  const etaSamples = WITH_ETA_SAMPLES
    ? ETA_SAMPLE_SECONDS.map((seconds, i) => {
        const startedAt = at((i + 1) * 86_400);
        const finishedAt = new Date(startedAt.getTime() + seconds * 1000);
        return {
          job: {
            ...jobRow,
            id: ids.etaJobs[i],
            chosenCandidateId: ids.etaCandidates[i],
            deadlineAt: new Date(startedAt.getTime() + 360_000),
            createdAt: startedAt,
            finishedAt,
          },
          round: { ...roundRow, id: ids.etaRounds[i], jobId: ids.etaJobs[i], stageTimings: {}, startedAt, finishedAt },
          candidate: {
            ...candidateRows[0],
            id: ids.etaCandidates[i],
            jobId: ids.etaJobs[i],
            roundId: ids.etaRounds[i],
            falRequestId: `seed-eta-request-${i + 1}`,
            scorer: 'onnx' as const,
            latencyMs: seconds * 1000,
            submittedAt: startedAt,
            completedAt: finishedAt,
          },
        };
      })
    : [];

  await db.transaction(async (tx) => {
    for (const row of uploadRows) {
      await tx.insert(uploads).values(row).onConflictDoUpdate({ target: uploads.id, set: upsertSet(row) });
    }
    await tx.insert(jobs).values(jobRow).onConflictDoUpdate({ target: jobs.id, set: upsertSet(jobRow) });
    await tx.insert(jobRounds).values(roundRow).onConflictDoUpdate({ target: jobRounds.id, set: upsertSet(roundRow) });
    for (const row of candidateRows) {
      await tx.insert(candidates).values(row).onConflictDoUpdate({ target: candidates.id, set: upsertSet(row) });
    }
    for (const row of callRows) {
      await tx.insert(providerCalls).values(row).onConflictDoUpdate({ target: providerCalls.id, set: upsertSet(row) });
    }
    for (const sample of etaSamples) {
      await tx.insert(jobs).values(sample.job).onConflictDoUpdate({ target: jobs.id, set: upsertSet(sample.job) });
      await tx.insert(jobRounds).values(sample.round).onConflictDoUpdate({ target: jobRounds.id, set: upsertSet(sample.round) });
      await tx.insert(candidates).values(sample.candidate).onConflictDoUpdate({ target: candidates.id, set: upsertSet(sample.candidate) });
    }
  });

  console.log(
    `Seeded session ${SESSION_ID}: job ${ids.job} (1 round, ${candidateRows.length} candidates, ${callRows.length} provider calls)` +
      (etaSamples.length > 0 ? ` + ${etaSamples.length} ETA sample rounds.` : '.'),
  );
}

main()
  .catch((error) => {
    console.error(error);
    process.exitCode = 1;
  })
  .finally(() => db.$client.end());
