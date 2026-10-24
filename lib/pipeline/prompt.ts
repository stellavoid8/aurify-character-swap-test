import type { TemplateAnalysis } from '../ai/schemas';
import type { Cases } from './cases';

/**
 * The generation prompt, built deterministically from the analysis. Identity (who) comes from
 * the user photos and everything else (what is happening) from the template. Images are numbered
 * as they are sent: 1 = template, 2..n+1 = the user photos that were used.
 */

export const PROMPT_MAX_CHARS = 1500;
/** The subject label is never trimmed by the budget search, so it gets its own fixed cap. */
const LABEL_MAX_CHARS = 120;

export type BuildPromptInput = {
  analysis: TemplateAnalysis;
  cases: Cases;
  userPhotoCount: number;
  peopleCount: number;
};

type SceneFill = {
  pose: string;
  action: string;
  held: string;
  cameraAngle: string;
  framing: string;
  lighting: string;
  scene: string;
};
type UserFill = { ageRange: string; build: string; hair: string };

/** Collapses whitespace and drops trailing punctuation so a fill-in sits cleanly inside a sentence. */
function clean(text: string, suffix?: string): string {
  let out = text.replace(/\s+/g, ' ').trim().replace(/[\s.,;:]+$/, '');
  // "short dark hair" must not become "short dark hair hair".
  if (suffix) out = out.replace(new RegExp(`\\s*\\b${suffix}$`, 'i'), '');
  return out;
}

/** Cuts at a word boundary. `max` 0 empties the fill-in, which omits its clause. */
function truncate(text: string, max: number): string {
  if (text.length <= max) return text;
  if (max <= 0) return '';
  const cut = text.slice(0, max);
  const space = cut.lastIndexOf(' ');
  return clean(space > max / 2 ? cut.slice(0, space) : cut);
}

function capAll<T extends Record<string, string>>(fill: T, max: number): T {
  return Object.fromEntries(Object.entries(fill).map(([k, v]) => [k, truncate(v, max)])) as T;
}

function joinList(items: string[]): string {
  if (items.length <= 1) return items.join('');
  return `${items.slice(0, -1).join(', ')} and ${items.at(-1)}`;
}

function genderWord(analysis: TemplateAnalysis): string {
  const { gender, age_group } = analysis.user;
  if (gender === 'unclear') return 'a person';
  const adult = age_group === 'adult';
  if (gender === 'male') return adult ? 'a man' : 'a boy';
  return adult ? 'a woman' : 'a girl';
}

/** "the pose (standing)", or just "the pose" when the fill-in is empty. */
function part(name: string, value: string): string {
  return value ? `the ${name} (${value})` : `the ${name}`;
}

function render(input: BuildPromptInput, label: string, s: SceneFill, u: UserFill): string {
  const { cases, userPhotoCount: n, peopleCount } = input;
  const refs = n === 1 ? 'image 2' : `images 2–${n + 1}`;
  const person = genderWord(input.analysis);

  const lines: string[] = [];
  lines.push(
    n === 1
      ? 'Image 1 is the scene. Image 2 shows a real person: the new subject.'
      : `Image 1 is the scene. Images 2–${n + 1} all show the same real person: the new subject.`,
  );
  lines.push(
    `Replace ${label} in image 1 with the person from ${refs}.` +
      (peopleCount > 1 ? ' Leave every other person in image 1 unchanged.' : ''),
  );
  lines.push(
    `Keep everything else from image 1 exactly: ${part('pose', s.pose)}, ${part('action', s.action)}` +
      (s.held ? `, the ${s.held} in their hands` : '') +
      `, ${part('camera angle', s.cameraAngle)}, ${part('framing', s.framing)}, ${part('lighting', s.lighting)}` +
      ` and ${part('background', s.scene)}.`,
  );
  lines.push('Do not move the camera: keep the viewpoint, height and distance of image 1, without re-staging the shot.');

  const traits = [
    u.ageRange && `aged ${u.ageRange}`,
    u.build && `${u.build} build`,
    u.hair && `${u.hair} hair`,
  ].filter(Boolean);
  lines.push(
    `The new subject is ${person}${traits.length ? ` ${traits.join(', ')}` : ''}.` +
      ` Show their real face, facial structure, skin tone, hair, body build and age exactly as in ${refs}.` +
      ' Do not make them broader, more muscular, slimmer or taller than they are.' +
      " Do not blend their face with the original person's face.",
  );

  if (cases.crossGender || cases.crossAge) {
    const detail =
      cases.direction === 'adult_to_child'
        ? ": a child's height, head-to-body ratio and limb length"
        : cases.direction === 'child_to_adult'
          ? ": an adult's height and proportions, with the adult's real age in the face, not de-aged"
          : '';
    lines.push(
      `Do not transfer the original subject's body. Rebuild the body with the new subject's own proportions as ${person}${detail}, in the same pose.`,
    );
  }

  lines.push("Clothing may be adjusted to fit the new subject's body while keeping its style and colours. The hairstyle follows the new subject.");
  lines.push('Photorealistic, matching the grain, sharpness and colour of image 1.');
  return lines.join('\n');
}

/** Largest per-fill-in cap in [0, hi] whose render fits, or -1 if even 0 does not. */
function fitCap(hi: number, fits: (cap: number) => boolean): number {
  if (fits(hi)) return hi;
  if (!fits(0)) return -1;
  let lo = 0;
  while (lo < hi - 1) {
    const mid = Math.floor((lo + hi) / 2);
    if (fits(mid)) lo = mid;
    else hi = mid;
  }
  return lo;
}

/**
 * Builds the prompt, at most PROMPT_MAX_CHARS. Over budget, the scene fill-ins are trimmed first
 * (one shared cap per fill-in), then the user's descriptive traits. The identity and body
 * clauses are fixed text and never trimmed.
 */
export function buildPrompt(input: BuildPromptInput): string {
  const t = input.analysis.template;
  const user = input.analysis.user;

  const label = truncate(clean(t.subject.label), LABEL_MAX_CHARS) || 'the main person';
  const scene: SceneFill = {
    pose: clean(t.subject.pose),
    action: clean(t.subject.action),
    held: joinList(t.subject.held_objects.map((o) => clean(o)).filter(Boolean)),
    cameraAngle: clean(t.camera_angle),
    framing: clean(t.framing),
    lighting: clean(t.lighting),
    scene: clean(t.scene),
  };
  const traits: UserFill = { ageRange: clean(user.age_range), build: clean(user.build, 'build'), hair: clean(user.hair, 'hair') };

  const fits = (text: string) => text.length <= PROMPT_MAX_CHARS;
  const longest = (fill: Record<string, string>) => Math.max(0, ...Object.values(fill).map((v) => v.length));

  const sceneCap = fitCap(longest(scene), (cap) => fits(render(input, label, capAll(scene, cap), traits)));
  if (sceneCap >= 0) return render(input, label, capAll(scene, sceneCap), traits);

  const emptyScene = capAll(scene, 0);
  const traitCap = fitCap(longest(traits), (cap) => fits(render(input, label, emptyScene, capAll(traits, cap))));
  return render(input, label, emptyScene, capAll(traits, Math.max(0, traitCap)));
}
