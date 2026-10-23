# 0001: Primary generator and refinement model

Status: **accepted**, 2026-10-23, after `npm run bakeoff` and a by-eye review of `bakeoff/out/grid.html`.

## Context

Character Swap puts the user into a template photo. The result must be unmistakably the user (identity) while keeping
the template's pose, action, held objects, camera, light and scene (action). The generator is the single biggest factor
in both, and it also sets most of the per-job cost and the waiting time. A second, cheaper model refines the face of a
chosen result ("Fix the face"). Both are set as constants in `lib/fal/models.ts` (`PRIMARY_GENERATOR`, `REFINE_MODEL`).

## Options

Generators (`GENERATOR_CANDIDATES`), all multi-image edit endpoints on fal, sent `[template, reference, ...other user photos]`:

- `fal-ai/nano-banana-pro/edit`: list price $0.15 per image
- `fal-ai/bytedance/seedream/v4.5/edit`: list price $0.04 per image
- `fal-ai/flux-pro/kontext/max/multi`: list price $0.08 per image, template + reference only

Refinement: `fal-ai/face-swap` (inswapper-class) on the top generator's result, with the reference photo as the source
face. The fallback, if face-swap looks waxy, is FLUX.1 Kontext with the reference.

## Evidence

The full results are in `bakeoff/out/summary.md` (per-model mean/min likeness, p50 latency, mean cost, failures and
content blocks), `bakeoff/out/results.csv` and `bakeoff/out/grid.html`. They stay local because they contain real
faces. Paste the summary tables here.

Run 2026-10-23: 8 pairs, seed 42, one image per model per pair. They cover case 1 (frontal control, held guitar), case 2
in both directions (man to woman, woman to man), case 3 in both directions (adult to child with a consented child photo,
child to adult), and two stress shots (backlit with lens flare, very wide with a small face). Claude case detection
matched the label on all 8 pairs.

### Generators

| Model | Runs | Mean likeness | Min likeness | p50 latency | Mean cost / image | Failed | Blocked | No face found |
| --- | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: |
| `fal-ai/nano-banana-pro/edit` | 8 | 0.393 | 0.029 | 24.7 s | $0.150 | 0 | 0 | 0 |
| `fal-ai/bytedance/seedream/v4.5/edit` | 8 | 0.706 | 0.000 | 44.6 s | $0.040 | 0 | 0 | 0 |
| `fal-ai/flux-pro/kontext/max/multi` | 8 | 0.272 | -0.071 | 19.0 s | $0.080 | 0 | 0 | 0 |

### Refinement

Top generator by mean likeness: `fal-ai/bytedance/seedream/v4.5/edit`. `fal-ai/face-swap` was run on its result for each pair, with the reference photo as the source face.

| Model | Runs | Mean likeness | Min likeness | p50 latency | Mean cost / image | Failed | Blocked | No face found |
| --- | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: |
| `fal-ai/face-swap on fal-ai/bytedance/seedream/v4.5/edit` | 8 | 0.774 | 0.708 | 32.0 s | $0.010 | 0 | 0 | 0 |

Mean likeness change from refinement: +0.069 over 8 pairs.

### Mean likeness by case

| Case | Pairs | `fal-ai/nano-banana-pro/edit` | `fal-ai/bytedance/seedream/v4.5/edit` | `fal-ai/flux-pro/kontext/max/multi` |
| --- | ---: | ---: | ---: | ---: |
| case1 | 2 | 0.462 | 0.365 | 0.560 |
| case2_m2f | 1 | 0.029 | 0.887 | 0.271 |
| case2_f2m | 1 | 0.583 | 0.843 | 0.403 |
| case3_a2c | 1 | 0.672 | 0.849 | 0.212 |
| case3_c2a | 1 | 0.194 | 0.783 | 0.169 |
| stress | 2 | 0.373 | 0.777 | 0.001 |

### Content blocks

No model blocked any pair, including the 2 child-photo pair(s) (case 3).

## Decision

`PRIMARY_GENERATOR = 'fal-ai/bytedance/seedream/v4.5/edit'` because it had the highest mean likeness (0.706 against
0.393 and 0.272), the best score in every case group except case 1 including both case-2 directions (0.887, 0.843),
blocked no pair including the child pairs, and is the cheapest at $0.04 per image.

`REFINE_MODEL = 'fal-ai/face-swap'` because it raised seedream's mean likeness by +0.069 (0.706 to 0.774) and its minimum
from 0.000 to 0.708 for $0.01 per image, so no pair stays below the same-person threshold after "Fix the face".

Known weakness: on the frontal control pair (`frontal-man-same`) seedream kept the template man's face instead of the
user's (likeness 0.0001) and also changed his sweater into a sleeveless top. With 3 candidates per round, ranking by
identity usually hides one such miss, and face-swap fixed this one (0.708). This is one run at one seed, so watch the
failure rate in the acceptance runs.

## Dropped

One example per dropped model, showing its typical failure. Use photos of people who agreed to be published, or
describe the failure in words. Never commit bake-off photos of real faces without consent.

- `fal-ai/nano-banana-pro/edit`: mean likeness 0.393 at almost 4× seedream's price. Its result was not
  recognisably the user on the man-to-woman pair (0.029) or the child-to-adult pair (0.194), so it was weakest exactly
  where the app most needs it. Its p50 latency was 24.7 s.
- `fal-ai/flux-pro/kontext/max/multi`: mean likeness 0.272. It won the easy frontal control (0.933) but fell apart on
  everything harder: 0.187 with the held guitar, 0.073 backlit and -0.071 on the wide shot. It also takes only the
  template and the reference photo, so the user's other photos are never used.

## Consequences

- **Cost:** one round is `CANDIDATES_PER_ROUND` = 3 × $0.04 = $0.12 in fal list price, plus the Claude analysis, and
  up to $0.24 if every candidate is auto-retried once. "Fix the face" adds $0.01. At the default `GLOBAL_DAILY_UNITS` =
  150 that is about $18 a day in generation ($36 worst case), against $67.50 with nano-banana-pro, so the cap stays as is.
- **Waiting time:** seedream is the slowest of the three (p50 44.6 s, max 56.3 s in the bake-off). The 3 candidates run
  in parallel, so a round should take about a minute, well inside `JOB_TIMEOUT_MS` (6 min). The waiting screen copy
  should not promise less than a minute.
- **Child photos:** seedream blocked neither case-3 pair. If it starts blocking, the job fails with `CONTENT_BLOCKED`,
  which is not retried (Assumption 9); there is no automatic fallback to another generator.
- **Seeds:** `buildInput` sends `seed` to seedream, which accepts it. The bake-off ran one seed per cell, so it did not
  check that the same seed gives the same image; candidates differ either way because each gets its own random seed.
