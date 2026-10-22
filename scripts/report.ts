/**
 * Measured cost and time numbers for the README (DR-6, DR-8, NFR-8), from the jobs tables.
 *   npm run report                      # print Markdown
 *   npm run report -- --write           # also write docs/metrics.md and the README's METRICS block
 *   npm run report -- --budget-usd 20   # daily budget behind the GLOBAL_DAILY_UNITS suggestion (default 10)
 *
 * Only real runs count: a job is left out when it belongs to the seed session or any of its
 * candidates or provider calls touched a mock (scorer 'mock', or a model name starting with 'mock').
 * Percentiles interpolate linearly between ranks, like Postgres percentile_cont.
 */
import { readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import type { Executor } from '../lib/db';
import { candidates, jobRounds, jobs, providerCalls } from '../lib/db/schema';
import { formatUsd } from '../lib/money';

/** `SESSION_ID` in scripts/seed.ts. */
export const SEED_SESSION_ID = '00000000-0000-0000-0000-000000000001';
const STAGES = ['analyzing', 'generating', 'ranking', 'refining'] as const;
const CASES = ['crossGender', 'crossAge', 'neither'] as const;
type Case = (typeof CASES)[number];
const CASE_LABELS: Record<Case, string> = { crossGender: 'Cross-gender', crossAge: 'Cross-age', neither: 'Neither' };
const DEFAULT_BUDGET_USD = 10;
const README_START = '<!-- METRICS:START -->';
const README_END = '<!-- METRICS:END -->';

export type Spread = { count: number; p50: number | null; p95: number | null };
export type Average = { count: number; mean: number | null; median: number | null };

export type Metrics = {
  window: { from: Date; to: Date } | null;
  jobs: number;
  stages: Record<(typeof STAGES)[number], Spread>;
  /** Succeeded generation rounds, started → finished, in ms. */
  endToEndMs: Spread;
  /** Integer micros. */
  costPerCandidate: Average;
  costPerRound: Average;
  costPerRefinement: Average;
  identityByCase: Record<Case, Average>;
  refinement: { pairs: number; before: number | null; after: number | null; improved: number };
  failures: { code: string; jobs: number; candidates: number }[];
  autoRetries: number;
  contentBlockedByCase: Record<Case, number>;
  budgetUsd: number;
  suggestedDailyUnits: number | null;
};

/** Linear interpolation between closest ranks (percentile_cont). */
export function percentile(values: number[], p: number): number | null {
  if (values.length === 0) return null;
  const sorted = [...values].sort((a, b) => a - b);
  const rank = p * (sorted.length - 1);
  const lo = Math.floor(rank);
  const hi = Math.ceil(rank);
  return sorted[lo] + (sorted[hi] - sorted[lo]) * (rank - lo);
}

const spread = (values: number[]): Spread => ({ count: values.length, p50: percentile(values, 0.5), p95: percentile(values, 0.95) });
const average = (values: number[]): Average => ({
  count: values.length,
  mean: values.length ? values.reduce((a, b) => a + b, 0) / values.length : null,
  median: percentile(values, 0.5),
});
const isMock = (model: string | null | undefined) => model?.startsWith('mock') ?? false;

export async function computeMetrics(db: Executor, { budgetUsd = DEFAULT_BUDGET_USD } = {}): Promise<Metrics> {
  const [jobRows, roundRows, candidateRows, callRows] = await Promise.all([
    db.select().from(jobs),
    db.select().from(jobRounds),
    db.select().from(candidates),
    db.select().from(providerCalls),
  ]);

  const mockJobs = new Set<string>();
  for (const c of candidateRows) if (c.scorer === 'mock' || isMock(c.model)) mockJobs.add(c.jobId);
  for (const call of callRows) if (call.jobId && isMock(call.model)) mockJobs.add(call.jobId);
  const realJobs = jobRows.filter((job) => job.sessionId !== SEED_SESSION_ID && !mockJobs.has(job.id));
  const jobById = new Map(realJobs.map((job) => [job.id, job]));
  const rounds = roundRows.filter((round) => jobById.has(round.jobId));
  const cands = candidateRows.filter((c) => jobById.has(c.jobId));
  const candById = new Map(cands.map((c) => [c.id, c]));
  const calls = callRows.filter((call) => call.jobId && jobById.has(call.jobId));

  const casesOf = (jobId: string): Case[] => {
    const flags = jobById.get(jobId)!.flags;
    const cases: Case[] = [];
    if (flags.crossGender) cases.push('crossGender');
    if (flags.crossAge) cases.push('crossAge');
    return cases.length ? cases : ['neither'];
  };

  const stages = Object.fromEntries(
    STAGES.map((stage) => [
      stage,
      spread(rounds.flatMap((r) => (typeof r.stageTimings[stage]?.ms === 'number' ? [r.stageTimings[stage].ms] : []))),
    ]),
  ) as Metrics['stages'];

  const endToEndMs = spread(
    rounds
      .filter((r) => r.kind === 'generation' && r.status === 'succeeded' && r.finishedAt)
      .map((r) => r.finishedAt!.getTime() - r.startedAt.getTime()),
  );

  const costByRound = new Map<string, number>();
  for (const call of calls) {
    if (call.roundId) costByRound.set(call.roundId, (costByRound.get(call.roundId) ?? 0) + call.costUsdMicros);
  }
  // Every finished round costs money, failed or not; that is what a rate-limit unit spends.
  const roundCosts = (kind: 'generation' | 'refinement') =>
    average(rounds.filter((r) => r.kind === kind && r.status !== 'running').map((r) => costByRound.get(r.id) ?? 0));
  const costPerRound = roundCosts('generation');

  const identityByCase = Object.fromEntries(CASES.map((c) => [c, [] as number[]])) as Record<Case, number[]>;
  for (const job of realJobs) {
    const score = job.chosenCandidateId ? candById.get(job.chosenCandidateId)?.identityScore : null;
    if (score == null) continue;
    for (const c of casesOf(job.id)) identityByCase[c].push(score);
  }

  const pairs = cands.flatMap((c) => {
    const parent = c.kind === 'refinement' && c.parentCandidateId ? candById.get(c.parentCandidateId) : undefined;
    return parent?.identityScore != null && c.identityScore != null ? [{ before: parent.identityScore, after: c.identityScore }] : [];
  });

  const failureCounts = new Map<string, { jobs: number; candidates: number }>();
  const bump = (code: string, key: 'jobs' | 'candidates') => {
    const entry = failureCounts.get(code) ?? { jobs: 0, candidates: 0 };
    entry[key]++;
    failureCounts.set(code, entry);
  };
  for (const job of realJobs) if (job.errorCode) bump(job.errorCode, 'jobs');
  for (const c of cands) if (c.errorCode) bump(c.errorCode, 'candidates');

  const contentBlockedByCase = Object.fromEntries(CASES.map((c) => [c, 0])) as Record<Case, number>;
  for (const c of cands) {
    if (c.errorCode === 'CONTENT_BLOCKED') for (const k of casesOf(c.jobId)) contentBlockedByCase[k]++;
  }

  const starts = rounds.map((r) => r.startedAt.getTime());
  const perRoundUsd = costPerRound.mean === null ? null : costPerRound.mean / 1_000_000;

  return {
    window: starts.length ? { from: new Date(Math.min(...starts)), to: new Date(Math.max(...starts)) } : null,
    jobs: realJobs.length,
    stages,
    endToEndMs,
    costPerCandidate: average(
      cands.filter((c) => c.kind === 'generation' && c.costUsdMicros !== null).map((c) => c.costUsdMicros!),
    ),
    costPerRound,
    costPerRefinement: roundCosts('refinement'),
    identityByCase: Object.fromEntries(CASES.map((c) => [c, average(identityByCase[c])])) as Metrics['identityByCase'],
    refinement: {
      pairs: pairs.length,
      before: average(pairs.map((p) => p.before)).mean,
      after: average(pairs.map((p) => p.after)).mean,
      improved: pairs.filter((p) => p.after > p.before).length,
    },
    failures: [...failureCounts].map(([code, n]) => ({ code, ...n })).sort((a, b) => a.code.localeCompare(b.code)),
    autoRetries: cands.filter((c) => c.attempt >= 2).length,
    contentBlockedByCase,
    budgetUsd,
    suggestedDailyUnits: perRoundUsd ? Math.floor(budgetUsd / perRoundUsd) : null,
  };
}

const dash = '—';
const seconds = (ms: number | null) => (ms === null ? dash : `${(ms / 1000).toFixed(1)} s`);
const usd = (micros: number | null) => (micros === null ? dash : formatUsd(micros));
const score = (value: number | null) => (value === null ? dash : value.toFixed(3));
const day = (date: Date) => date.toISOString().slice(0, 10);

export function renderReport(m: Metrics): string {
  const lines: string[] = [];
  const table = (head: string[], rows: (string | number)[][]) => {
    lines.push(`| ${head.join(' | ')} |`, `| ${head.map(() => '---').join(' | ')} |`);
    for (const row of rows) lines.push(`| ${row.join(' | ')} |`);
    lines.push('');
  };

  lines.push('## Measured metrics', '');
  lines.push(
    m.window
      ? `Window: ${day(m.window.from)} to ${day(m.window.to)}, ${m.jobs} real jobs (seed and mock runs excluded).`
      : 'No real jobs yet (seed and mock runs are excluded).',
    '',
  );

  lines.push('### Time per stage', '');
  table(
    ['Stage', 'Rounds', 'p50', 'p95'],
    [
      ...STAGES.map((s) => [s, m.stages[s].count, seconds(m.stages[s].p50), seconds(m.stages[s].p95)]),
      ['**end to end** (succeeded generation round)', m.endToEndMs.count, seconds(m.endToEndMs.p50), seconds(m.endToEndMs.p95)],
    ],
  );

  lines.push('### Cost', '');
  table(
    ['Unit', 'n', 'Mean'],
    [
      ['Candidate (one generated image)', m.costPerCandidate.count, usd(m.costPerCandidate.mean)],
      ['Generation round (all provider calls, incl. Anthropic)', m.costPerRound.count, usd(m.costPerRound.mean)],
      ['Fix the face (refinement round)', m.costPerRefinement.count, usd(m.costPerRefinement.mean)],
    ],
  );
  lines.push(
    m.suggestedDailyUnits === null
      ? `Suggested \`GLOBAL_DAILY_UNITS\` for a $${m.budgetUsd}/day budget: ${dash} (no finished generation rounds).`
      : `Suggested \`GLOBAL_DAILY_UNITS\` for a $${m.budgetUsd}/day budget: **${m.suggestedDailyUnits}** (budget ÷ mean round cost).`,
    '',
  );

  lines.push('### Likeness of the chosen picture', '');
  table(
    ['Case', 'Jobs', 'Mean', 'Median'],
    CASES.map((c) => [CASE_LABELS[c], m.identityByCase[c].count, score(m.identityByCase[c].mean), score(m.identityByCase[c].median)]),
  );
  lines.push(
    `Fix the face: ${m.refinement.pairs} pairs, mean likeness ${score(m.refinement.before)} → ${score(m.refinement.after)}, ` +
      `${m.refinement.improved} of ${m.refinement.pairs} improved.`,
    '',
  );

  lines.push('### Failures', '');
  if (m.failures.length) table(['Error code', 'Jobs', 'Candidates'], m.failures.map((f) => [f.code, f.jobs, f.candidates]));
  else lines.push('No failures recorded.', '');
  lines.push(`Auto-retries (candidates on attempt 2): ${m.autoRetries}.`, '');
  table(['Case', 'CONTENT_BLOCKED candidates'], CASES.map((c) => [CASE_LABELS[c], m.contentBlockedByCase[c]]));

  lines.push('fal billed total for the window: ____ (paste from the fal dashboard to check the price-table estimate)');
  return lines.join('\n') + '\n';
}

/** Replaces the text between the METRICS markers; returns null when the markers are missing. */
export function replaceReadmeBlock(readme: string, block: string): string | null {
  const start = readme.indexOf(README_START);
  const end = readme.indexOf(README_END, start);
  if (start === -1 || end === -1) return null;
  return `${readme.slice(0, start + README_START.length)}\n${block}${readme.slice(end)}`;
}

function parseArgs(argv: string[]) {
  const write = argv.includes('--write');
  const i = argv.findIndex((arg) => arg === '--budget-usd' || arg.startsWith('--budget-usd='));
  const raw = i === -1 ? undefined : argv[i].includes('=') ? argv[i].split('=')[1] : argv[i + 1];
  const budgetUsd = raw === undefined ? DEFAULT_BUDGET_USD : Number(raw);
  if (!Number.isFinite(budgetUsd) || budgetUsd <= 0) throw new Error(`--budget-usd must be a positive number, got ${raw}`);
  return { write, budgetUsd };
}

async function main() {
  const { write, budgetUsd } = parseArgs(process.argv.slice(2));
  await import('./load-env');
  const { db } = await import('../lib/db');
  try {
    const markdown = renderReport(await computeMetrics(db, { budgetUsd }));
    console.log(markdown);
    if (!write) return;
    const root = process.cwd();
    await writeFile(path.join(root, 'docs', 'metrics.md'), `# Metrics\n\n${markdown}`);
    console.error('Wrote docs/metrics.md');
    const readmePath = path.join(root, 'README.md');
    const updated = replaceReadmeBlock(await readFile(readmePath, 'utf8'), markdown);
    if (updated === null) console.error(`README.md has no ${README_START} … ${README_END} block; left unchanged.`);
    else {
      await writeFile(readmePath, updated);
      console.error('Updated the README metrics block');
    }
  } finally {
    await db.$client.end();
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  main().catch((error) => {
    console.error(error);
    process.exitCode = 1;
  });
}
