# 0001: Primary generator and refinement model

Status: **accepted**, 2026-10-23, after `npm run bakeoff` and a by-eye review of `bakeoff/out/grid.html`.
Revised the same day: the generator is now picked per case (`GENERATOR_BY_CASE`), from one bake-off execution per case.
Revised again the same day: every round now makes one image on each of the three generators, and the result screen
shows each with its model and likeness score. `GENERATOR_BY_CASE` is kept as the record of the per-case winners but no
longer routes jobs. See the last consequence below.

## Context

Character Swap puts the user into a template photo. The result must be unmistakably the user (identity) while keeping
the template's pose, action, held objects, camera, light and scene (action). The generator is the single biggest factor
in both, and it also sets most of the per-job cost and the waiting time. A second, cheaper model refines the face of a
chosen result ("Fix the face"). Both are set as constants in `lib/fal/models.ts` (`GENERATOR_BY_CASE`, `REFINE_MODEL`).

The spec has five cases, and each one has to be tested on its own to find its best model: case 1 (man to man), case 2 in
both directions (man to woman, woman to man) and case 3 in both directions (adult to child, child to adult). At run time
`swapCase()` in `lib/pipeline/cases.ts` reads the case from the template analysis and `generate.ts` submits every
candidate to that case's generator. Age outranks gender (an adult man's template with a girl as the user is case 3).
A teen on either side has no bake-off pair yet and falls back to `PRIMARY_GENERATOR`.

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

Run 2026-10-23: 8 pairs, seed 42, one image per model per pair. Each case was then run as its own execution
(`npm run bakeoff -- --case <case>`, five runs, reports in `bakeoff/out/summary-<case>.md`). They cover case 1 (frontal control, held guitar), case 2
in both directions (man to woman, woman to man), case 3 in both directions (adult to child with a consented child photo,
child to adult), and two stress shots (backlit with lens flare, very wide with a small face). Claude case detection
matched the label on all 8 pairs.

### Generators

| Model | Runs | Mean likeness | Min likeness | p50 latency | Mean cost / image | Failed | Blocked | No face found | Collage |
| --- | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: |
| `fal-ai/nano-banana-pro/edit` | 8 | 0.422 | 0.029 | 24.7 s | $0.150 | 0 | 0 | 0 | 1 |
| `fal-ai/bytedance/seedream/v4.5/edit` | 8 | 0.706 | 0.000 | 44.6 s | $0.040 | 0 | 0 | 0 | 0 |
| `fal-ai/flux-pro/kontext/max/multi` | 8 | 0.219 | 0.072 | 19.0 s | $0.080 | 0 | 0 | 0 | 2 |

"Collage" counts results with more faces than the template. Their likeness is left out: flux answered the man-to-man
pair with a 2×2 contact sheet, and one panel matched the user at 0.933, which first read as a win. The check is a
heuristic. It also caught a printed face on a T-shirt (nano, `umbrella-c2a`) and generated passers-by (flux,
`street-wide`), neither of which changes a winner.

### Refinement

Top generator by mean likeness: `fal-ai/bytedance/seedream/v4.5/edit`. `fal-ai/face-swap` was run on its result for each pair, with the reference photo as the source face.

| Model | Runs | Mean likeness | Min likeness | p50 latency | Mean cost / image | Failed | Blocked | No face found |
| --- | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: |
| `fal-ai/face-swap on fal-ai/bytedance/seedream/v4.5/edit` | 8 | 0.774 | 0.708 | 32.0 s | $0.010 | 0 | 0 | 0 |

Mean likeness change from refinement: +0.069 over 8 pairs.

### Mean likeness by case

| Case | Pairs | `fal-ai/nano-banana-pro/edit` | `fal-ai/bytedance/seedream/v4.5/edit` | `fal-ai/flux-pro/kontext/max/multi` |
| --- | ---: | ---: | ---: | ---: |
| case1 | 2 | 0.462 | 0.365 | 0.187 |
| case2_m2f | 1 | 0.029 | 0.887 | 0.271 |
| case2_f2m | 1 | 0.583 | 0.843 | 0.403 |
| case3_a2c | 1 | 0.672 | 0.849 | 0.212 |
| case3_c2a | 1 | – | 0.783 | 0.169 |
| stress | 2 | 0.373 | 0.777 | 0.072 |

### Content blocks

No model blocked any pair, including the 2 child-photo pair(s) (case 3).

### By-eye review per case

- **case1, man to man** (`frontal-man-same`): nano-banana-pro is the only real swap: the user in the template's sweater,
  pose and background. Seedream kept the template man's face (0.0001) and changed his sweater into a sleeveless top.
  Flux returned a collage. On the woman-to-woman pair (`guitar-same`) seedream scored higher (0.730 against 0.416) but
  re-staged the scene onto a bench; nano kept the scene.
- **case2_m2f** (`shutter-m2f`): seedream. Nano drew a different woman in a different street; flux kept the scene, but
  the face is not the user's.
- **case2_f2m** (`cornfield-f2m`): seedream has the best likeness, but it gave the user a broader, more muscular build and
  opened the shirt. Nano keeps the composition closest (0.583) and is the runner-up.
- **case3_a2c** (`frontal-man-a2c`): seedream, which kept the scene and the child's likeness. Flux drew a different child.
- **case3_c2a** (`umbrella-c2a`): seedream is the only result that is the user. It re-staged the shot from above, but she
  still holds the umbrella. Flux put the adult face on the child's body; nano drew a different woman.

## Decision

`GENERATOR_BY_CASE`, used by `generate.ts` for every candidate of a job:

| Case | Generator | Likeness | Why |
| --- | --- | ---: | --- |
| case1 | `fal-ai/nano-banana-pro/edit` | 0.462 | Only real man-to-man swap; best case-1 mean once the collage is excluded |
| case2_m2f | `fal-ai/bytedance/seedream/v4.5/edit` | 0.887 | Only recognisable result |
| case2_f2m | `fal-ai/bytedance/seedream/v4.5/edit` | 0.843 | Best likeness; nano is the runner-up |
| case3_a2c | `fal-ai/bytedance/seedream/v4.5/edit` | 0.849 | Best likeness and scene |
| case3_c2a | `fal-ai/bytedance/seedream/v4.5/edit` | 0.783 | Only result that is the user |
| other (teen) | `PRIMARY_GENERATOR` (seedream) | – | No pair yet; best overall |

The evidence is one pair per case at one seed (two for case 1), so treat case 1 in particular as provisional:
its two pairs disagree (nano won man to man, seedream won woman to woman on likeness).

The original single-generator decision is kept below as `PRIMARY_GENERATOR`, the fallback for unmeasured cases:

`PRIMARY_GENERATOR = 'fal-ai/bytedance/seedream/v4.5/edit'` because it had the highest mean likeness (0.706 against
0.422 and 0.219), the best score in every case group except case 1 including both case-2 directions (0.887, 0.843),
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

- `fal-ai/nano-banana-pro/edit` (kept for case 1 only): mean likeness 0.422 at almost 4× seedream's price. Its result was not
  recognisably the user on the man-to-woman pair (0.029) or the child-to-adult pair (0.194), so it was weakest exactly
  where the app most needs it. Its p50 latency was 24.7 s.
- `fal-ai/flux-pro/kontext/max/multi`: mean likeness 0.219, best in no case. Its apparent 0.933 on the frontal control
  was a 2×2 collage, not a swap. It scored 0.187 with the held guitar and 0.073 backlit, and it drew extra people into the
  wide shot. It also takes only the
  template and the reference photo, so the user's other photos are never used.

## Consequences

- **Superseded, one image per model:** each round now submits one candidate per model in `GENERATOR_CANDIDATES`
  (`generate.ts`), ranked by likeness. A round costs $0.27 in fal list price ($0.15 + $0.04 + $0.08) whatever the case,
  and finishes when the slowest model does (seedream, p50 44.6 s). The two bullets below on cost and one image per
  round describe the earlier setup.
- **One image per round (earlier):** `CANDIDATES_PER_ROUND` = 1, on the case's generator. There is no ranking safety net any more:
  a miss such as seedream keeping the template face goes straight to the user, who can use Try again or Fix the face.
  The fan-in code still handles several candidates per round, and its tests pin the count to 3.
- **Cost:** a round is $0.15 in fal list price for case 1 (nano-banana-pro) and $0.04 for every other case (seedream),
  plus the Claude analysis, and double if the image is auto-retried once. "Fix the face" adds $0.01. At the default
  `GLOBAL_DAILY_UNITS` = 150 that is between $6 and $22.50 a day in generation depending on the case mix ($45 worst
  case), so the cap stays as is.
- **Waiting time:** p50 latency in the bake-off was 24.7 s for nano-banana-pro (case 1) and 44.6 s for seedream (max
  56.3 s), well inside `JOB_TIMEOUT_MS` (6 min). The waiting screen copy should not promise less than a minute.
- **Child photos:** seedream blocked neither case-3 pair. If it starts blocking, the job fails with `CONTENT_BLOCKED`,
  which is not retried (Assumption 9); there is no automatic fallback to another generator.
- **Seeds:** `buildInput` sends `seed` to seedream, which accepts it. The bake-off ran one seed per cell, so it did not
  check that the same seed gives the same image; each Try again gets a new random seed, so it gives a different image.
