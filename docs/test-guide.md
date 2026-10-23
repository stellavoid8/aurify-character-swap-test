# Character Swap — Test Guide for Uncovered Areas

Oct 23, 2026 · @Arelle Sanchez

## Scope

Everything tested so far ran on mocks, so no real picture has been generated yet. This guide covers what the 34 Vitest files and the 3 Playwright specs did not reach.

**Already covered (don't repeat):** gate and session cookie, step 1 and 2 happy path, 3 versions, choose + reload, download, Try again, keyboard nav (Chromium), PDF / >25 MB / no-face / group-photo rejection, 21st-unit limit, webhook replay, provider-always-fails, timed-out job. All on mock fal, mock Claude, local storage and mock face engine (`e2e/env.ts` forces them).

| Gap | Area | Why it is untested | Priority |
| --- | --- | --- | --- |
| 1 | Real fal generation + bake-off | `FAL_KEY` returned Unauthorized on 2026-10-22 | Blocker |
| 2 | Live providers end to end, incl. Fix the face and Share | e2e forces every mock; no spec touches Fix the face or Share | Blocker |
| 3 | Safari / WebKit and real phones | WebKit libs missing locally | High |
| 4 | Job flows on the hosted Supabase pooler | Pooler hangs locally; CI uses plain `postgres:16` | High |
| 5 | Redesigned interface (commit `f61ba6c`, 25 files) | Landed after the last full run | High |
| 6 | Failure-mode acceptance runs | Need real providers | Medium |
| 7 | Production deploy: env guard, cron, limits, retention, cost | Not deployed with real keys yet | Medium |

## Prerequisites

Get these in place once; every section below assumes them.

- [ ] **Valid `FAL_KEY`** in `.env.local`. The last one returned Unauthorized; generate a fresh key in the fal dashboard and copy it whole. The bake-off's first pair (Gap 1, step 1) is the cheapest check that it works.
- [ ] **`ANTHROPIC_API_KEY`** and **`BLOB_READ_WRITE_TOKEN`** set, with credit on both fal and Anthropic.
- [ ] **Tunnel** for fal webhooks: `cloudflared tunnel --url http://localhost:3000`, then set `APP_URL` to the tunnel URL and restart `npm run dev`.
- [ ] **Face models** present: `ls models public/models/mediapipe`, then `npm run face:smoke` passes.
- [ ] **Database**: `npm run db:migrate && npm run db:seed`. Check pooler latency first with a one-off `select 1`; over ~2 s means the pooler is in its hanging state, so retry later.
- [ ] **Playwright system deps** (needs sudo): `sudo npx playwright install-deps`.
- [ ] **Test photos**: the 8 pairs in `bakeoff/pairs.json`, plus synthetic or consented photos for each failure mode. Never use real children's photos from the web.
- [ ] **Devices**: one iPhone (Safari) and one Android phone (Chrome) on the tunnel URL or a Vercel preview.

## Gap 1: Real generation and the bake-off

This is the decision gate: the generator in production is still a placeholder (`GENERATOR_CANDIDATES[0]`) until the bake-off runs.

1. Run `npm run bakeoff`. It is resume-safe, so stop it after the first pair, open `bakeoff/out/<pair>/`, and confirm 3 model images exist before spending on the rest.
2. Let it finish all 8 pairs. Expect 8 × 3 generator calls plus refine calls (roughly $2–3 at list prices).
3. Open `bakeoff/out/grid.html` and review by eye. Per pair, judge: is it clearly the user? Is the pose, held object, light and scene kept?
4. Read `bakeoff/out/summary.md`: mean / min likeness, p50 latency, cost, failures, content blocks per model. Check the **Case detection** table: every pair's detected case matches its label.
5. Run each spec case on its own, one execution per case: `npm run bakeoff -- --case case1` (man to man), then `case2_m2f`, `case2_f2m`, `case3_a2c` and `case3_c2a`. Finished cells are cached, so add `--rescore` to re-score saved images without paid calls. Check each `bakeoff/out/grid-<case>.html` by eye, and treat a `collage` result as a failure, not a likeness score.
6. Set `GENERATOR_BY_CASE` from the **Best model per case** tables (after the by-eye check), `PRIMARY_GENERATOR` as the fallback for teens, and, if face-swap looked waxy, `REFINE_MODEL`, all in `lib/fal/models.ts`.
7. Fill `docs/decisions/0001-generator.md` and paste `summary.md` between the `BAKEOFF` markers in the README.
8. `npm run lint && npm test && npm run build`.

**Pass:** the chosen model has no content blocks on adult pairs, the best mean likeness or within 0.02 of it at lower cost, and keeps the action in the by-eye review.

## Gap 2: Live providers end to end

Run the full flow by hand with `FAL_KEY`, `ANTHROPIC_API_KEY`, `BLOB_READ_WRITE_TOKEN` set, `FACE_ENGINE=onnx`, and `APP_URL` on the tunnel. Watch the dev server log alongside.

| # | Step | Expected | Where to verify |
| --- | --- | --- | --- |
| 2.1 | Pick a template, add 2 user photos | Upload goes straight to Blob; photo check finishes in < 1.5 s | Network tab: PUT to `*.blob.vercel-storage.com`; `uploads` row has a Blob URL |
| 2.2 | Make my picture | `POST /api/jobs` returns in < 1 s | Network timing |
| 2.3 | Waiting screen | Stages move through all 3 labels; result appears well under 6 min | Server log shows Claude call, then 3 fal submits |
| 2.4 | fal webhooks arrive | 3 webhook POSTs via the tunnel, each 200 | `webhook_events` has 3 rows; `candidates` have identity scores |
| 2.5 | Result | Version 1 is tagged Best match and has the highest identity score | `select rank, identity_score from candidates where job_id = '…'` |
| 2.6 | Fix the face | New version tagged Fixed face; slider compares before/after; likeness before → after shown | Drag slider and use arrow keys; if likeness dropped, the app recommends keeping the original |
| 2.7 | Keep the fixed face / keep original | Choice persists after reload | Reload page |
| 2.8 | Try again | 3 new versions with new seeds; earlier ones under Earlier versions | `candidates.seed` differs |
| 2.9 | Download | JPEG named `character-swap-<8 hex>-<n>.jpg`, full resolution | Open the file |
| 2.10 | Share | Phone: system share sheet with the image. Desktop: "Link copied" | Paste the link in a private window |
| 2.11 | Cost logged | `provider_calls` rows for Claude and fal with non-zero `cost_usd_micros` | `npm run report` |

**Also check** webhook security against the live server: a webhook POST with a wrong token gets rejected before the body is read, and a reused token for an old attempt changes nothing.

## Gap 3: Safari, WebKit and real phones

WebKit has only run in CI; emulated iPhones don't exercise HEIC, the camera roll or the share sheet.

**Automated (local):** after `sudo npx playwright install-deps`, run `npx playwright test --project="Mobile Safari" --project="Desktop Safari"`. All specs should pass, except the keyboard test, which is skipped on WebKit by design.

**Manual, on a real iPhone (Safari) and Android (Chrome):**

- [ ] Upload a HEIC straight from the iPhone camera roll; it is accepted and shows upright.
- [ ] Upload a portrait photo taken sideways (EXIF rotation); the thumbnail and result are upright.
- [ ] Take a photo with the camera from the picker.
- [ ] Live face check (MediaPipe) flags a no-face and a two-face photo before upload finishes.
- [ ] Lock the phone or switch apps during the waiting screen, then return: polling resumes and the result shows, or "Connection lost. We'll keep trying." clears by itself.
- [ ] Share opens the system share sheet and sends the image itself, not just a link.
- [ ] Download saves to Photos / Downloads.
- [ ] Fix the face slider works by touch drag.
- [ ] No horizontal scroll on any screen at 375 px width; primary button visible without scrolling on steps 1 and 2.
- [ ] Slow network (Chrome DevTools "Slow 4G" or a weak signal): uploads of a 10 MB photo still complete.

## Gap 4: Job flows on the hosted Supabase pooler

CI proves the logic on plain `postgres:16`; production runs on Supavisor's transaction pooler (port 6543), where job-creating specs stalled locally.

1. Check latency: run `select 1` five times through `DATABASE_URL`. All should return in under 500 ms.
2. With latency healthy, run `npx playwright test --project="Desktop Chrome"` against the hosted DB. Core flow, webhook replay and timeout specs must pass.
3. **Concurrent fan-in:** start a job and let all 3 webhooks land within the same second (mock fal does this). Exactly one `job_rounds` row moves from `running`; the job never shows twice-ranked or stuck.
4. **Last unit race:** set a session to 19 units used, then fire two `POST /api/jobs` at once (two tabs or `curl &`). One succeeds, one gets the limit message. The advisory lock must hold through the transaction pooler.
5. **Pooler hang:** if a query times out mid-job, the job should still end on a clear screen (failed or timed out), not spin forever. Confirm by checking the job after 6 minutes.

**If step 1 fails repeatedly**, record it as an environment issue, not a regression, and check it again from the Vercel deployment (same region as the database).

## Gap 5: Redesigned interface

Commit `f61ba6c` changed 25 files after the last full test run. The main risk is that the page no longer scrolls: `html` and `body` are `overflow-hidden`, and content scrolls inside `#app-scroll` with a hidden scrollbar.

**First, rerun the suite:** `npm run lint && npm test && npm run test:e2e -- --project="Desktop Chrome"`, and check CI on this branch for the two Safari projects. **Known blind spot:** `expectNoHorizontalScroll` (`e2e/helpers/flow.ts:102`) measures `document.documentElement`, but overflow now stays inside `#app-scroll`, so that check can no longer fail. Point it at `#app-scroll` before trusting a pass.

**Manual checks:**

- [ ] Long result screen (6+ versions after Try again) scrolls to the bottom with mouse wheel, trackpad, touch, and keyboard (Space, Page Down) once focus is in the content.
- [ ] Moving between steps and onto the result scrolls the content back to the top.
- [ ] iPhone Safari: address bar collapsing/expanding doesn't cut off the bottom button (`h-dvh`).
- [ ] Gate on a phone: the on-screen keyboard doesn't hide the code field or the submit button.
- [ ] Sticky header stays on top and the "New picture" button works from every screen; on phones it shows only the + icon but still has an accessible name.
- [ ] Contrast: muted text (`#b4abd6`), warnings and errors are readable over the backdrop glows (aim for WCAG AA 4.5:1). Check with the DevTools contrast picker.
- [ ] Toasts ("Link copied", errors) are readable in the dark theme.
- [ ] Error, not-found and loading screens use the new look and have no layout gaps.
- [ ] Low-end Android: the blurred backdrop doesn't make scrolling or the compare slider stutter.
- [ ] Zoom to 200 % on desktop: no clipped or overlapping content.
- [ ] Fonts: Urbanist loads; no flash of a fallback font that shifts layout.

## Gap 6: Failure-mode acceptance runs

The README's "Where it fails" section and `docs/failures/README.md` are all `TODO(real run)`. Run each mode at least 5 times through the deployed app with real providers and record n failures of N attempts.

| Mode | Template to use | What to look for | App behaviour to confirm |
| --- | --- | --- | --- |
| Adult ↔ child | Adult template + consented child photo, and the reverse | Body proportions, face age | Case detected as `case3_*` |
| Held objects | Person holding a phone, cup or bat | Object size and grip on the user's body | Object kept |
| Backlighting | Subject against a sunset or window | Face too dark, likeness drop | Likeness score in `candidates` |
| Skin-tone drift | User and template subject with different skin tones | Result matches the user, not the template | — |
| Occlusion | Sunglasses, hand over face, hair across face | Face replaced correctly or not | — |
| Multiple people | Template with 2–3 people | Right subject swapped | Subject outlined and named in a notice |
| Waxy face after Fix the face | Any result with low likeness | Plastic-looking skin | Before/after likeness shown; recommends keeping original when it dropped |
| Child photos and safety filters | Consented child photo | Content refusal | Not retried; clear message on the failed screen |

For each mode save the job id, the template/result pair (1024 px, EXIF stripped, consented or synthetic only) and the n/N in `docs/failures/README.md`. The SQL queries in that file give likeness, seed and cost per version.

## Gap 7: Production deploy checks

Run these on the Vercel deployment with real keys; unit tests cover the logic but not the platform wiring.

| # | Check | How | Pass |
| --- | --- | --- | --- |
| 7.1 | Env guard | Deploy a preview with `CRON_SECRET` unset | Build or boot fails with a message naming the variable; restore it after |
| 7.2 | Cron registered | Vercel → Settings → Cron Jobs | `/api/cron/cleanup` daily at 04:00 UTC |
| 7.3 | Cron auth | `curl` the route with no bearer, then with `CRON_SECRET` | 401, then 200 with a summary |
| 7.4 | Stuck-job sweep | Leave a job unfinished past 6 min, then trigger the cron | Job marked timed out |
| 7.5 | Retention | Set `RETENTION_DAYS=0` on a preview, trigger cron | Old Blob files and rows deleted; unused uploads gone after 24 h |
| 7.6 | Session limit | 20 rounds in one session (mix of new jobs, Try again, Fix the face) | 21st gets the polite limit message |
| 7.7 | Global limit | Set `GLOBAL_DAILY_UNITS=2` on a preview | 3rd round from any session is refused |
| 7.8 | Webhook URL | Inspect a fal request in the fal dashboard | Webhook points at the production `APP_URL`, not localhost or the tunnel |
| 7.9 | Image optimisation | After a day of use, Vercel → Usage | Image transformations within plan quota |
| 7.10 | Cost reconciliation | `npm run report` for a date range vs. fal dashboard usage | Totals agree within a few percent; paste into README |
| 7.11 | Budget | `npm run report -- --budget-usd <daily budget>` | Set `GLOBAL_DAILY_UNITS` to the suggested value |
| 7.12 | Function limits | Vercel logs for `normalizeUpload` and the webhook | No timeouts or out-of-memory from the ONNX models |

## Sign-off

Work top to bottom: Gap 1 unblocks 2, 6 and 7. Gaps 3, 4 and 5 can run now on mocks.

- [ ] Gap 1: bake-off run, generator chosen, decision record filled
- [ ] Gap 2: all 11 live steps pass
- [ ] Gap 3: Safari projects green locally; phone checklist done on iPhone and Android
- [ ] Gap 4: hosted-pooler specs pass; both race checks hold
- [ ] Gap 5: scroll helper fixed; redesign checklist done
- [ ] Gap 6: every mode has n/N, job ids and a pair in `docs/failures/`
- [ ] Gap 7: all 12 deploy checks pass; README `TODO(real run)` lines filled

**Recording results:** log each failure as a GitHub issue with the job id, browser/device, and screenshot. When everything passes, `grep -rn --exclude=test-guide.md 'TODO(real run)' README.md docs` should return nothing.
