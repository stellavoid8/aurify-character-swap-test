# Failure captures

Image pairs for the README's "Where it fails" section. Each mode has a template and result pair, and its counts come from the acceptance runs.

## Consent first

Commit only photos of people who agreed in writing to be published, or synthetic faces. Never commit a real child's photo, even with consent for testing: describe that failure in words. Bake-off and acceptance outputs stay in `bakeoff/out/` (gitignored).

## Checklist per mode

For each mode below:

- [ ] Run it through the deployed app (real providers, not mocks) at least 5 times. Write down N attempts and n failures.
- [ ] Save `<mode>-template.jpg` and `<mode>-result.jpg` here, resized to a 1024 px long edge, with EXIF stripped.
- [ ] Note the job id. Its `provider_calls` and `candidates` rows give the model, seed, likeness score and cost.
- [ ] Write in the README: what happened, how often (n/N), why, and what the app does about it.

| Mode | Files | Job ids | n/N |
| --- | --- | --- | --- |
| Adult ↔ child | `adult-child-*.jpg` | | |
| Held objects | `held-object-*.jpg` | | |
| Backlighting | `backlit-*.jpg` | | |
| Skin-tone drift | `skin-tone-*.jpg` | | |
| Occlusion | `occlusion-*.jpg` | | |
| Multiple people | `multi-person-*.jpg` | | |
| Waxy face after Fix the face | `waxy-refine-*.jpg` (before and after) | | |
| Child photos and safety filters | words only, or the error screen | | |

## Useful queries

```sql
-- Likeness per version for one job
select c.round_id, c.kind, c.model, c.seed, c.identity_score, c.action_score, c.rank, c.error_code
from candidates c where c.job_id = '<job id>' order by c.submitted_at;

-- Content refusals across all real runs
select model, count(*) from candidates where error_code = 'CONTENT_BLOCKED' group by model;
```
