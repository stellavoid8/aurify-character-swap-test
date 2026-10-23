/**
 * Generator bake-off: runs the same (template, user photos, prompt) through every model in
 * GENERATOR_CANDIDATES with seed 42, scores each result's likeness to the reference photo with ArcFace,
 * then runs REFINE_MODEL on the top model's results and scores those again.
 *   npm run bakeoff
 * Reads bakeoff/pairs.json (shape: bakeoff/pairs.example.json; image paths are relative to bakeoff/).
 * Needs real FAL_KEY, ANTHROPIC_API_KEY and the ONNX face models. Inputs go to Vercel Blob under
 * bakeoff/ when BLOB_READ_WRITE_TOKEN is set, otherwise to fal storage (providers can't read local disk).
 *
 * Resume-safe: each pair's analysis and prompt are cached in bakeoff/out/<pair>/prep.json, and a model
 * whose bakeoff/out/<pair>/<model>.jpg exists (or that was content-blocked) is not run again, so a
 * re-run makes no paid calls for finished cells. Failed cells are retried. Delete a file to redo it.
 * Writes bakeoff/out/results.csv, grid.html and summary.md.
 *
 * Options:
 *   --case <case>  run only that case's pairs, so each case is its own execution; reports go to
 *                  results-<case>.csv, grid-<case>.html and summary-<case>.md.
 *   --rescore      score the saved images again and run nothing new: no paid calls.
 * A result with more faces than the template (a collage or contact sheet instead of a swap) is
 * marked `collage` and its likeness is left out, since its best panel can match the user.
 */
import './load-env';
import './register-server-only';
import { access, mkdir, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { z } from 'zod';
import { ai, type TemplateAnalysis } from '../lib/ai';
import type { Upload } from '../lib/db/schema';
import { useLocalStorage, useMockAi, useMockFal } from '../lib/env';
import { AppError } from '../lib/errors';
import { checkUserFaces, cosine, faceEngine, pickSubjectFace, qualityScore, toFaceBox } from '../lib/face';
import { runSync, uploadToFalStorage } from '../lib/fal/client';
import { buildInput, GENERATOR_CANDIDATES, REFINE_MODEL, type FalModel } from '../lib/fal/models';
import { falCostMicros } from '../lib/fal/pricing';
import { normalizeImage } from '../lib/images';
import { FACE_MIN_SCORE, MAX_USER_PHOTOS } from '../lib/limits';
import { formatUsd } from '../lib/money';
import { detectCases, type Cases } from '../lib/pipeline/cases';
import { buildPrompt } from '../lib/pipeline/prompt';
import { selectReference } from '../lib/pipeline/preprocess';
import { putObject, fetchObject } from '../lib/storage';
import type { Face, JobNotice } from '../lib/types';

const BAKEOFF_DIR = path.join(process.cwd(), 'bakeoff');
const OUT_DIR = path.join(BAKEOFF_DIR, 'out');
const SEED = 42;
const CONCURRENCY = 2;
const SESSION_ID = '00000000-0000-0000-0000-0000000000b0';

const CASES = ['case1', 'case2_m2f', 'case2_f2m', 'case3_a2c', 'case3_c2a', 'stress'] as const;
type PairCase = (typeof CASES)[number];

function parseArgs(argv: string[]): { only: PairCase | null; rescore: boolean } {
  let only: PairCase | null = null;
  let rescore = false;
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === '--rescore') rescore = true;
    else if (argv[i] === '--case' && CASES.includes(argv[i + 1] as PairCase)) only = argv[++i] as PairCase;
    else {
      console.error(`Unknown option ${argv[i]}. Options: --case <${CASES.join('|')}>, --rescore`);
      process.exit(1);
    }
  }
  return { only, rescore };
}
const ARGS = parseArgs(process.argv.slice(2));

const PairSchema = z.object({
  id: z.string().regex(/^[a-z0-9][a-z0-9_-]*$/i, { error: 'letters, digits, - and _ only' }),
  case: z.enum(CASES),
  note: z.string(),
  template: z.string(),
  user: z.array(z.string()).min(1).max(MAX_USER_PHOTOS),
});
type Pair = z.infer<typeof PairSchema>;

/** Everything a pair needs before generation. Cached as prep.json so analysis is paid for once. */
type Prep = {
  templateUrl: string;
  /** Reference first, then the other usable photos, as sent to the generators. */
  userUrls: string[];
  /** Normalized centre of the template subject's face; null when the template has no face. */
  subjectCenter: [number, number] | null;
  referenceEmbedding: number[];
  /** Confident faces in the normalized template; a result with more is a collage. */
  templateFaces: number;
  analysis: TemplateAnalysis;
  cases: Cases;
  notices: JobNotice[];
  prompt: string;
};

type CellStatus = 'ok' | 'no_face' | 'collage' | 'blocked' | 'failed';
type Cell = {
  pair: string;
  case: PairCase;
  model: FalModel;
  kind: 'generation' | 'refinement';
  /** Refinement only: the generator whose result was refined. */
  baseModel: FalModel | null;
  identity: number | null;
  latencyMs: number | null;
  costUsdMicros: number;
  status: CellStatus;
  error: string | null;
};

const slug = (model: string) => model.replace(/[^a-z0-9.-]+/gi, '_');
const pairDir = (pair: Pair) => path.join(OUT_DIR, pair.id);
const refineFile = (baseModel: FalModel) => `refine__${slug(REFINE_MODEL)}__${slug(baseModel)}`;

async function exists(file: string): Promise<boolean> {
  return access(file).then(
    () => true,
    () => false,
  );
}

async function readJson<T>(file: string): Promise<T | null> {
  return (await exists(file)) ? (JSON.parse(await readFile(file, 'utf8')) as T) : null;
}

const writeJson = (file: string, value: unknown) => writeFile(file, `${JSON.stringify(value, null, 2)}\n`);

async function pool<T, R>(items: T[], limit: number, fn: (item: T) => Promise<R>): Promise<R[]> {
  const results = new Array<R>(items.length);
  let next = 0;
  const worker = async () => {
    while (next < items.length) {
      const i = next++;
      results[i] = await fn(items[i]);
    }
  };
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, worker));
  return results;
}

/** A public URL providers can fetch. */
async function publish(pair: Pair, name: string, jpeg: Buffer): Promise<string> {
  if (useLocalStorage) return uploadToFalStorage(jpeg, 'image/jpeg');
  return (await putObject(`bakeoff/${pair.id}/${name}.jpg`, jpeg, 'image/jpeg')).url;
}

async function loadImage(relative: string) {
  return normalizeImage(await readFile(path.resolve(BAKEOFF_DIR, relative)));
}

const centre = (face: Face, w: number, h: number): [number, number] => [
  (face.box[0] + face.box[2] / 2) / w,
  (face.box[1] + face.box[3] / 2) / h,
];

/** The shape selectReference reads, filled in for a photo that never went through the uploads table. */
function userUpload(n: number, url: string, img: { jpeg: Buffer; width: number; height: number }, face: Face, embedding: number[]): Upload {
  return {
    id: `photo-${n}`,
    sessionId: SESSION_ID,
    kind: 'user',
    mediaType: 'image',
    status: 'ok',
    rejectCode: null,
    rawUrl: url,
    url,
    width: img.width,
    height: img.height,
    bytes: img.jpeg.length,
    faces: [toFaceBox(face, img.width, img.height)],
    subjectFaceIndex: null,
    qualityScore: qualityScore(face, img.width, img.height),
    embedding,
    createdAt: new Date(),
    videoUrl: null,
    durationMs: null,
    fps: null,
    frameCount: null,
    keyframe: null,
    deletedAt: null,
  };
}

/** Normalize, detect, pick subject and reference, upload, analyze, build the prompt. Cached. */
async function prepare(pair: Pair): Promise<Prep> {
  const dir = pairDir(pair);
  const cached = await readJson<Prep>(path.join(dir, 'prep.json'));
  if (cached && cached.templateFaces === undefined) {
    // Prepared before templateFaces existed: count them on the saved template, no paid call.
    cached.templateFaces = await countFaces(await readFile(path.join(dir, 'template.jpg')));
    await writeJson(path.join(dir, 'prep.json'), cached);
  }
  if (cached) return cached;
  await mkdir(dir, { recursive: true });
  const ctx = { stage: 'bakeoff' };

  const template = await loadImage(pair.template);
  const { faces: templateFaces } = await faceEngine.analyzeImage(template.jpeg, ctx);
  const subjectIndex = pickSubjectFace(templateFaces, template.width, template.height);
  const subject = subjectIndex === null ? null : templateFaces[subjectIndex];

  const users: Upload[] = [];
  const jpegs = new Map<string, Buffer>();
  for (const [i, file] of pair.user.entries()) {
    const img = await loadImage(file);
    const { faces } = await faceEngine.analyzeImage(img.jpeg, ctx);
    const check = checkUserFaces(faces, img.width, img.height);
    if (!check.ok) {
      console.warn(`[${pair.id}] user photo ${i + 1} (${file}) left out: ${check.code}`);
      continue;
    }
    const embedding = await faceEngine.embedFace(img.jpeg, check.face, ctx);
    const url = await publish(pair, `user-${i + 1}`, img.jpeg);
    const upload = userUpload(i + 1, url, img, check.face, embedding);
    users.push(upload);
    jpegs.set(upload.id, img.jpeg);
  }
  if (users.length === 0) throw new Error('no user photo passed the face check');

  const templateUrl = await publish(pair, 'template', template.jpeg);
  const { result: analysis } = await ai.analyze({
    templateUrl,
    subjectBox: subject ? toFaceBox(subject, template.width, template.height).box : null,
    userPhotoUrls: users.map((u) => u.url!),
  });
  const cases = detectCases(analysis);
  const selection = selectReference(users, analysis);
  const used = selection.usedIds.map((id) => users.find((u) => u.id === id)!);
  const prompt = buildPrompt({ analysis, cases, userPhotoCount: used.length, peopleCount: analysis.template.people_count });

  await writeFile(path.join(dir, 'template.jpg'), template.jpeg);
  await writeFile(path.join(dir, 'ref.jpg'), jpegs.get(selection.referenceId)!);
  const prep: Prep = {
    templateUrl,
    userUrls: used.map((u) => u.url!),
    subjectCenter: subject ? centre(subject, template.width, template.height) : null,
    referenceEmbedding: used[0].embedding!,
    templateFaces: templateFaces.filter((f) => f.score >= FACE_MIN_SCORE).length,
    analysis,
    cases,
    notices: selection.notices,
    prompt,
  };
  await writeJson(path.join(dir, 'prep.json'), prep);
  return prep;
}

async function countFaces(jpeg: Buffer): Promise<number> {
  const { faces } = await faceEngine.analyzeImage(jpeg, { stage: 'bakeoff' });
  return faces.filter((f) => f.score >= FACE_MIN_SCORE).length;
}

type Score = Pick<Cell, 'identity' | 'status' | 'error'>;

/**
 * Likeness of the face nearest the template subject's location to the reference photo. No face
 * gives `no_face`; more faces than the template gives `collage`, with its likeness left out.
 */
async function scoreResult(jpeg: Buffer, prep: Prep): Promise<Score> {
  const { faces, width, height } = await faceEngine.analyzeImage(jpeg, { stage: 'bakeoff-score' });
  const confident = faces.filter((f) => f.score >= FACE_MIN_SCORE);
  if (confident.length === 0) return { identity: null, status: 'no_face', error: null };
  const [cx, cy] = prep.subjectCenter ?? [0.5, 0.5];
  const distance = (f: Face) => {
    const [x, y] = centre(f, width, height);
    return Math.hypot(x - cx, y - cy);
  };
  const nearest = confident.reduce((best, f) => (distance(f) < distance(best) ? f : best));
  const identity = cosine(await faceEngine.embedFace(jpeg, nearest, { stage: 'bakeoff-score' }), prep.referenceEmbedding);
  if (confident.length > Math.max(prep.templateFaces, 1)) {
    const error = `${confident.length} faces against ${prep.templateFaces} in the template (nearest likeness ${identity.toFixed(3)})`;
    return { identity: null, status: 'collage', error };
  }
  return { identity, status: 'ok', error: null };
}

type CellSpec = {
  pair: Pair;
  prep: Prep;
  model: FalModel;
  kind: Cell['kind'];
  baseModel: FalModel | null;
  file: string;
  /** Resolved only when the cell actually runs, so a skipped refinement uploads nothing. */
  imageUrls: () => Promise<string[]>;
};

async function runCell({ pair, prep, model, kind, baseModel, file, imageUrls }: CellSpec): Promise<Cell> {
  const jpgPath = path.join(pairDir(pair), `${file}.jpg`);
  const jsonPath = path.join(pairDir(pair), `${file}.json`);
  const base = { pair: pair.id, case: pair.case, model, kind, baseModel };
  const cached = await readJson<Cell>(jsonPath);
  const sameBase = cached?.baseModel === baseModel;
  const haveImage = await exists(jpgPath);

  if (haveImage && (ARGS.rescore || !cached)) {
    // Image saved: score it locally (again, or because its record was lost) rather than pay again.
    const keep = cached && sameBase ? { latencyMs: cached.latencyMs, costUsdMicros: cached.costUsdMicros } : { latencyMs: null, costUsdMicros: 0 };
    const cell: Cell = { ...base, ...keep, ...(await scoreResult(await readFile(jpgPath), prep)) };
    await writeJson(jsonPath, cell);
    return cell;
  }
  if (cached && sameBase && (haveImage || cached.status === 'blocked')) return cached;
  if (ARGS.rescore) return { ...base, identity: null, latencyMs: null, costUsdMicros: 0, status: 'failed', error: 'not run (--rescore)' };

  const label = `[${pair.id}] ${kind === 'refinement' ? `${model} on ${baseModel}` : model}`;
  console.log(`${label}: running`);
  const started = performance.now();
  let latencyMs: number | null = null;
  let costUsdMicros = 0;
  let cell: Cell;
  try {
    const input = buildInput(model, { prompt: prep.prompt, imageUrls: await imageUrls(), seed: SEED });
    const result = await runSync({ model, input, context: { stage: 'bakeoff' } });
    latencyMs = Math.round(performance.now() - started);
    costUsdMicros = falCostMicros(model, result.imageUrls.length);
    if (!result.imageUrls[0]) throw new AppError('GENERATION_FAILED', { detail: 'no image in the output' });
    const { jpeg } = await normalizeImage(await fetchObject(result.imageUrls[0]));
    const score = await scoreResult(jpeg, prep);
    await writeFile(jpgPath, jpeg);
    cell = { ...base, latencyMs, costUsdMicros, ...score };
  } catch (err) {
    const blocked = err instanceof AppError && err.code === 'CONTENT_BLOCKED';
    const error = err instanceof Error ? err.message : String(err);
    cell = { ...base, identity: null, latencyMs, costUsdMicros, status: blocked ? 'blocked' : 'failed', error };
  }
  await writeJson(jsonPath, cell);
  console.log(`${label}: ${cell.status}${cell.identity === null ? '' : ` likeness ${cell.identity.toFixed(3)}`}`);
  return cell;
}

// ---- Aggregation and reports ----

const mean = (xs: number[]) => (xs.length ? xs.reduce((a, b) => a + b, 0) / xs.length : null);
function median(xs: number[]): number | null {
  if (!xs.length) return null;
  const s = [...xs].sort((a, b) => a - b);
  const mid = Math.floor(s.length / 2);
  return s.length % 2 ? s[mid] : (s[mid - 1] + s[mid]) / 2;
}
const fmt = (x: number | null, digits = 3) => (x === null ? '–' : x.toFixed(digits));
const fmtSeconds = (ms: number | null) => (ms === null ? '–' : `${(ms / 1000).toFixed(1)} s`);
const scores = (cells: Cell[]) => cells.flatMap((c) => (c.identity === null ? [] : [c.identity]));

type ModelStats = {
  label: string;
  runs: number;
  meanIdentity: number | null;
  minIdentity: number | null;
  p50LatencyMs: number | null;
  meanCostMicros: number | null;
  failed: number;
  blocked: number;
  noFace: number;
  collage: number;
};

function stats(label: string, cells: Cell[]): ModelStats {
  const ids = scores(cells);
  const produced = cells.filter((c) => c.status === 'ok' || c.status === 'no_face' || c.status === 'collage');
  return {
    label,
    runs: cells.length,
    meanIdentity: mean(ids),
    minIdentity: ids.length ? Math.min(...ids) : null,
    p50LatencyMs: median(produced.flatMap((c) => (c.latencyMs === null ? [] : [c.latencyMs]))),
    meanCostMicros: mean(produced.map((c) => c.costUsdMicros)),
    failed: cells.filter((c) => c.status === 'failed').length,
    blocked: cells.filter((c) => c.status === 'blocked').length,
    noFace: cells.filter((c) => c.status === 'no_face').length,
    collage: cells.filter((c) => c.status === 'collage').length,
  };
}

/** Highest mean likeness; the model that produced more scored images wins a tie. */
function topModel(cells: Cell[]): FalModel | null {
  let best: { model: FalModel; score: number; n: number } | null = null;
  for (const model of GENERATOR_CANDIDATES) {
    const ids = scores(cells.filter((c) => c.model === model && c.kind === 'generation'));
    const score = mean(ids);
    if (score === null) continue;
    if (!best || score > best.score || (score === best.score && ids.length > best.n)) best = { model, score, n: ids.length };
  }
  return best?.model ?? null;
}

function csvField(value: string | number | null): string {
  const text = value === null ? '' : String(value);
  return /[",\n]/.test(text) ? `"${text.replace(/"/g, '""')}"` : text;
}

function resultsCsv(cells: Cell[]): string {
  const header = ['pair', 'case', 'model', 'identity', 'latency_ms', 'cost_usd_micros', 'status'];
  const rows = cells.map((c) => [
    c.pair,
    c.case,
    c.kind === 'refinement' ? `${c.model} (refining ${c.baseModel})` : c.model,
    c.identity === null ? null : c.identity.toFixed(4),
    c.latencyMs,
    c.costUsdMicros,
    c.status,
  ]);
  return [header, ...rows].map((row) => row.map(csvField).join(',')).join('\n') + '\n';
}

function summaryMd(pairs: Pair[], preps: Map<string, Prep>, skipped: Map<string, string>, cells: Cell[], top: FalModel | null): string {
  const generation = cells.filter((c) => c.kind === 'generation');
  const refinement = cells.filter((c) => c.kind === 'refinement');
  const table = (rows: ModelStats[]) => [
    '| Model | Runs | Mean likeness | Min likeness | p50 latency | Mean cost / image | Failed | Blocked | No face found | Collage |',
    '| --- | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: |',
    ...rows.map(
      (s) =>
        `| \`${s.label}\` | ${s.runs} | ${fmt(s.meanIdentity)} | ${fmt(s.minIdentity)} | ${fmtSeconds(s.p50LatencyMs)} | ${s.meanCostMicros === null ? '–' : formatUsd(s.meanCostMicros)} | ${s.failed} | ${s.blocked} | ${s.noFace} | ${s.collage} |`,
    ),
  ];

  const lines = [
    '# Generator bake-off',
    '',
    `Run ${new Date().toISOString().slice(0, 10)}. ${preps.size} pairs, seed ${SEED}, one image per model per pair.`,
    'Likeness is the ArcFace (InsightFace `w600k_mbf`) cosine between the reference photo and the face in the result nearest the template subject. Same person usually scores above 0.45; different people below 0.3.',
    'Latency is wall-clock through the fal queue. Cost is the list price in `lib/fal/pricing.ts`, not the fal invoice.',
    '',
    '## Generators',
    '',
    ...table(GENERATOR_CANDIDATES.map((m) => stats(m, generation.filter((c) => c.model === m)))),
    '',
  ];

  if (top) {
    const refined = stats(`${REFINE_MODEL} on ${top}`, refinement);
    const deltas = refinement.flatMap((r) => {
      const base = generation.find((g) => g.pair === r.pair && g.model === top);
      return r.identity !== null && base?.identity != null ? [r.identity - base.identity] : [];
    });
    const delta = mean(deltas);
    lines.push(
      '## Refinement',
      '',
      `Top generator by mean likeness: \`${top}\`. \`${REFINE_MODEL}\` was run on its result for each pair, with the reference photo as the source face.`,
      '',
      ...table([refined]),
      '',
      `Mean likeness change from refinement: ${delta === null ? '–' : `${delta >= 0 ? '+' : ''}${delta.toFixed(3)}`} over ${deltas.length} pairs.`,
      '',
    );
  }

  const casePairs = (c: PairCase) => pairs.filter((p) => p.case === c && preps.has(p.id)).map((p) => p.id);
  lines.push(
    '## Mean likeness by case',
    '',
    `| Case | Pairs | ${GENERATOR_CANDIDATES.map((m) => `\`${m}\``).join(' | ')} |`,
    `| --- | ---: | ${GENERATOR_CANDIDATES.map(() => '---:').join(' | ')} |`,
    ...CASES.filter((c) => casePairs(c).length > 0).map((c) => {
      const ids = casePairs(c);
      const cols = GENERATOR_CANDIDATES.map((m) => fmt(mean(scores(generation.filter((g) => g.model === m && ids.includes(g.pair))))));
      return `| ${c} | ${ids.length} | ${cols.join(' | ')} |`;
    }),
    '',
    '## Best model per case',
    '',
    'Highest mean likeness among scored results (collages excluded). Check each against the grid by eye before setting `GENERATOR_BY_CASE` in `lib/fal/models.ts`.',
    '',
    '| Case | Best model | Mean likeness |',
    '| --- | --- | ---: |',
    ...CASES.filter((c) => casePairs(c).length > 0).map((c) => {
      const ids = casePairs(c);
      const top = topModel(generation.filter((g) => ids.includes(g.pair)));
      const score = top ? mean(scores(generation.filter((g) => g.model === top && ids.includes(g.pair)))) : null;
      return `| ${c} | ${top ? `\`${top}\`` : '–'} | ${fmt(score)} |`;
    }),
    '',
  );

  const blocked = cells.filter((c) => c.status === 'blocked');
  lines.push('## Content blocks', '');
  const childPairs = casePairs('case3_a2c').length + casePairs('case3_c2a').length;
  if (blocked.length === 0) {
    lines.push(`No model blocked any pair${childPairs ? `, including the ${childPairs} child-photo pair(s) (case 3)` : '. No child-photo pair (case 3) ran'}.`);
  }
  else for (const c of blocked) lines.push(`- \`${c.model}\` blocked **${c.pair}** (${c.case}): ${c.error ?? 'no detail'}`);
  lines.push('');

  lines.push('## Case detection', '', '| Pair | Labelled | Detected | Note |', '| --- | --- | --- | --- |');
  for (const pair of pairs) {
    const prep = preps.get(pair.id);
    const detected = prep
      ? [prep.cases.crossGender && 'cross-gender', prep.cases.crossAge && `cross-age (${prep.cases.direction})`].filter(Boolean).join(', ') || 'same'
      : `skipped: ${skipped.get(pair.id)}`;
    lines.push(`| ${pair.id} | ${pair.case} | ${detected} | ${pair.note.replace(/\|/g, '\\|')} |`);
  }
  lines.push('');
  return lines.join('\n');
}

const esc = (text: string) => text.replace(/[&<>"]/g, (ch) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' })[ch]!);

function gridHtml(pairs: Pair[], preps: Map<string, Prep>, cells: Cell[], top: FalModel | null): string {
  const columns: { title: string; find: (pair: string) => Cell | undefined; file: string }[] = GENERATOR_CANDIDATES.map((m) => ({
    title: m,
    find: (pair) => cells.find((c) => c.pair === pair && c.kind === 'generation' && c.model === m),
    file: slug(m),
  }));
  if (top) {
    columns.push({
      title: `${REFINE_MODEL} on ${top}`,
      find: (pair) => cells.find((c) => c.pair === pair && c.kind === 'refinement'),
      file: refineFile(top),
    });
  }

  const img = (src: string, alt: string) => `<a href="${esc(src)}"><img src="${esc(src)}" alt="${esc(alt)}" loading="lazy"></a>`;
  const rows = pairs
    .filter((p) => preps.has(p.id))
    .map((pair) => {
      const prep = preps.get(pair.id)!;
      const best = Math.max(...columns.map((col) => col.find(pair.id)?.identity ?? -Infinity));
      const cellsHtml = columns.map((col) => {
        const cell = col.find(pair.id);
        if (!cell) return '<td class="empty">not run</td>';
        const picture = cell.status === 'ok' || cell.status === 'no_face' || cell.status === 'collage' ? img(`${pair.id}/${col.file}.jpg`, col.title) : `<div class="none">${cell.status}</div>`;
        const score = cell.identity === null ? cell.status : cell.identity.toFixed(3);
        const cls = cell.identity !== null && cell.identity === best ? ' class="best"' : '';
        return `<td><figure>${picture}<figcaption${cls}>${esc(score)} · ${fmtSeconds(cell.latencyMs)}</figcaption></figure></td>`;
      });
      return `<tr>
  <th><strong>${esc(pair.id)}</strong><br>${esc(pair.case)}<br><small>${esc(pair.note)}</small>
    <details><summary>prompt</summary><pre>${esc(prep.prompt)}</pre></details></th>
  <td>${img(`${pair.id}/template.jpg`, 'template')}</td>
  <td>${img(`${pair.id}/ref.jpg`, 'reference')}</td>
  ${cellsHtml.join('\n  ')}
</tr>`;
    });

  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>Generator bake-off</title>
<style>
  body { font: 14px/1.4 system-ui, sans-serif; margin: 16px; background: #fafaf7; color: #17171a; }
  table { border-collapse: collapse; }
  th, td { border: 1px solid #e4e2da; padding: 6px; vertical-align: top; background: #fff; }
  thead th { position: sticky; top: 0; font-size: 12px; max-width: 220px; word-break: break-all; }
  tbody th { text-align: left; width: 180px; font-weight: 400; }
  img { width: 220px; height: 220px; object-fit: contain; background: #f2f1ec; display: block; }
  figure { margin: 0; }
  figcaption { text-align: center; margin-top: 4px; font-variant-numeric: tabular-nums; }
  figcaption.best { font-weight: 700; color: #1f8a4c; }
  .none, .empty { width: 220px; height: 220px; display: grid; place-items: center; color: #c2362b; background: #fbe9e7; }
  pre { white-space: pre-wrap; font-size: 11px; max-width: 360px; }
</style>
</head>
<body>
<h1>Generator bake-off</h1>
<p>Number under each result: likeness to the reference photo (ArcFace cosine, higher is better) · latency. Best per row in green. Seed ${SEED}.</p>
<table>
<thead><tr><th>Pair</th><th>Template</th><th>User reference</th>${columns.map((c) => `<th>${esc(c.title)}</th>`).join('')}</tr></thead>
<tbody>
${rows.join('\n')}
</tbody>
</table>
</body>
</html>
`;
}

// ---- Main ----

function preflight() {
  const problems: string[] = [];
  if (useMockFal) problems.push('FAL_KEY is not set: the bake-off needs real fal generations.');
  if (useMockAi) problems.push('ANTHROPIC_API_KEY is not set: the bake-off needs real template analysis.');
  if (faceEngine.name !== 'onnx') problems.push('The face engine is the mock: run `npx tsx scripts/fetch-models.ts` and unset FACE_ENGINE=mock.');
  if (problems.length) {
    console.error(`Cannot run the bake-off:\n${problems.map((p) => `  - ${p}`).join('\n')}`);
    process.exit(1);
  }
}

async function loadPairs(): Promise<Pair[]> {
  const file = path.join(BAKEOFF_DIR, 'pairs.json');
  if (!(await exists(file))) {
    console.error('bakeoff/pairs.json not found. Copy bakeoff/pairs.example.json and point it at your photos.');
    process.exit(1);
  }
  const parsed = z.array(PairSchema).safeParse(JSON.parse(await readFile(file, 'utf8')));
  if (!parsed.success) {
    console.error(`bakeoff/pairs.json is invalid:\n${z.prettifyError(parsed.error)}`);
    process.exit(1);
  }
  const ids = parsed.data.map((p) => p.id);
  const duplicate = ids.find((id, i) => ids.indexOf(id) !== i);
  if (duplicate) {
    console.error(`bakeoff/pairs.json: pair id "${duplicate}" is used twice.`);
    process.exit(1);
  }
  return parsed.data;
}

async function main() {
  preflight();
  const pairs = (await loadPairs()).filter((p) => ARGS.only === null || p.case === ARGS.only);
  if (pairs.length === 0) {
    console.error(`bakeoff/pairs.json has no ${ARGS.only} pair.`);
    process.exit(1);
  }
  await mkdir(OUT_DIR, { recursive: true });
  if (ARGS.only) console.log(`Case ${ARGS.only} only.${ARGS.rescore ? ' Rescoring saved images, no paid calls.' : ''}`);
  console.log(`${pairs.length} pairs × ${GENERATOR_CANDIDATES.length} generators; storage: ${useLocalStorage ? 'fal' : 'Vercel Blob'}`);

  const preps = new Map<string, Prep>();
  const skipped = new Map<string, string>();
  await pool(pairs, CONCURRENCY, async (pair) => {
    try {
      preps.set(pair.id, await prepare(pair));
    } catch (err) {
      const reason = err instanceof Error ? err.message : String(err);
      skipped.set(pair.id, reason);
      console.error(`[${pair.id}] skipped: ${reason}`);
    }
  });

  const ready = pairs.filter((p) => preps.has(p.id));
  const generation = await pool(
    ready.flatMap((pair) => GENERATOR_CANDIDATES.map((model) => ({ pair, model }))),
    CONCURRENCY,
    ({ pair, model }) => {
      const prep = preps.get(pair.id)!;
      return runCell({
        pair,
        prep,
        model,
        kind: 'generation',
        baseModel: null,
        file: slug(model),
        imageUrls: async () => [prep.templateUrl, ...prep.userUrls],
      });
    },
  );

  const top = topModel(generation);
  const refinement = top
    ? await pool(
        ready.filter((pair) => generation.some((c) => c.pair === pair.id && c.model === top && c.identity !== null)),
        CONCURRENCY,
        (pair) => {
          const prep = preps.get(pair.id)!;
          return runCell({
            pair,
            prep,
            model: REFINE_MODEL,
            kind: 'refinement',
            baseModel: top,
            file: refineFile(top),
            imageUrls: async () => {
              const target = await readFile(path.join(pairDir(pair), `${slug(top)}.jpg`));
              return [await publish(pair, `${slug(top)}-result`, target), prep.userUrls[0]];
            },
          });
        },
      )
    : [];

  const cells = [...generation, ...refinement];
  const suffix = ARGS.only ? `-${ARGS.only}` : '';
  const [csvName, gridName, summaryName] = ['results.csv', 'grid.html', 'summary.md'].map((f) => f.replace('.', `${suffix}.`));
  await writeFile(path.join(OUT_DIR, csvName), resultsCsv(cells));
  await writeFile(path.join(OUT_DIR, gridName), gridHtml(pairs, preps, cells, top));
  await writeFile(path.join(OUT_DIR, summaryName), summaryMd(pairs, preps, skipped, cells, top));

  const spent = cells.reduce((sum, c) => sum + c.costUsdMicros, 0);
  console.log(`\nWrote bakeoff/out/${csvName}, ${gridName}, ${summaryName}. Top generator: ${top ?? 'none'}. Fal spend recorded across all runs: ${formatUsd(spent)}.`);
  if (skipped.size) console.log(`${skipped.size} pair(s) skipped; see ${summaryName}.`);
}

main()
  .then(() => process.exit(0))
  .catch((err) => {
    console.error(err);
    process.exit(1);
  });
