# 0001: Primary generator and refinement model

Status: **proposed**. Fill in after `npm run bakeoff` has run and `bakeoff/out/grid.html` has been reviewed by eye.

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

TODO: run date, number of pairs, and which cases they covered (case 1, case 2 both directions, case 3 both directions,
held object, backlit, wide shot).

TODO: summary tables.

## Decision

TODO: `PRIMARY_GENERATOR = '…'` because … (one sentence, citing likeness, blocks and cost from the evidence).

TODO: `REFINE_MODEL = '…'` because … (one sentence, citing the mean likeness change from refinement).

## Dropped

One example per dropped model, showing its typical failure. Use photos of people who agreed to be published, or
describe the failure in words. Never commit bake-off photos of real faces without consent.

- TODO `model`: what went wrong (e.g. blended face, lost the held object, blocked the child pair). ![example](img/0001-…jpg)
- TODO `model`: …

## Consequences

TODO: per-job cost at `CANDIDATES_PER_ROUND` candidates, expected waiting time, whether `GLOBAL_DAILY_UNITS` needs
changing, what happens if the chosen model blocks child photos, and whether seeds are honoured (see Assumption 8).
