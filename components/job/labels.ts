import type { CandidateView } from '@/lib/types';

const KIND_LABELS: Partial<Record<CandidateView['kind'], string>> = { refinement: 'Fixed face', animation: 'Video' };

/** Which model made a version; Fix the face and animation results say what they are instead. */
export function versionLabel(c: CandidateView): string {
  return c.modelLabel ?? KIND_LABELS[c.kind] ?? 'Unknown model';
}

/** Likeness as people read it: cosine similarity clamped to 0–1, as a whole percentage. */
export function likenessPct(cosine: number | null): string {
  if (cosine === null) return 'not measured';
  return `${Math.round(Math.min(1, Math.max(0, cosine)) * 100)}%`;
}
