import type { CandidateView } from '@/lib/types';

/** Which model made a version; Fix the face results say so instead. */
export function versionLabel(c: CandidateView): string {
  return c.modelLabel ?? (c.kind === 'refinement' ? 'Fixed face' : 'Unknown model');
}

/** Likeness as people read it: cosine similarity clamped to 0–1, as a whole percentage. */
export function likenessPct(cosine: number | null): string {
  if (cosine === null) return 'not measured';
  return `${Math.round(Math.min(1, Math.max(0, cosine)) * 100)}%`;
}
