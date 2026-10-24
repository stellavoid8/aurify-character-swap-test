import { describe, expect, it } from 'vitest';
import type { TemplateAnalysis } from '@/lib/ai/schemas';
import { detectCases } from '@/lib/pipeline/cases';
import { buildPrompt, PROMPT_MAX_CHARS } from '@/lib/pipeline/prompt';
import { makeAnalysis } from './helpers/analysis';

const BODY = "Do not transfer the original subject's body";

function build(analysis: TemplateAnalysis, userPhotoCount = 2, peopleCount = analysis.template.people_count) {
  return buildPrompt({ analysis, cases: detectCases(analysis), userPhotoCount, peopleCount });
}

describe('buildPrompt', () => {
  it('case 1 (same gender and age) has no body clause', () => {
    const prompt = build(makeAnalysis());
    expect(prompt).not.toContain(BODY);
    expect(prompt).toContain('Images 2–3 all show the same real person');
    expect(prompt).toContain('The new subject is a man aged 30-40, slim build, short dark hair.');
    expect(prompt).not.toContain('hair hair');
    expect(prompt).toMatchSnapshot();
  });

  it('case 2 (cross-gender) adds the body clause', () => {
    const prompt = build(makeAnalysis({ user: { gender: 'female', hair: 'long blonde' } }));
    expect(prompt).toContain(BODY);
    expect(prompt).toContain('own proportions as a woman, in the same pose.');
    expect(prompt).toMatchSnapshot();
  });

  it('case 3 adult_to_child describes a child body', () => {
    const prompt = build(makeAnalysis({ user: { gender: 'female', age_group: 'child', age_range: '7-9' } }));
    expect(prompt).toContain(BODY);
    expect(prompt).toContain("a child's height, head-to-body ratio and limb length");
    expect(prompt).toContain('The new subject is a girl aged 7-9');
    expect(prompt).toMatchSnapshot();
  });

  it('case 3 child_to_adult keeps the adult age in the face', () => {
    const prompt = build(makeAnalysis({ subject: { age_group: 'child', age_range: '8-10' } }));
    expect(prompt).toContain(BODY);
    expect(prompt).toContain('not de-aged');
    expect(prompt).toMatchSnapshot();
  });

  it('teen direction adds the body clause without a child or adult detail', () => {
    const prompt = build(makeAnalysis({ user: { age_group: 'teen', age_range: '14-16' } }));
    expect(prompt).toContain(`${BODY}. Rebuild the body with the new subject's own proportions as a boy, in the same pose.`);
  });

  it('lists held objects', () => {
    const prompt = build(makeAnalysis({ subject: { held_objects: ['tennis racket', 'yellow ball'] } }));
    expect(prompt).toContain(', the tennis racket and yellow ball in their hands,');
    expect(prompt).toMatchSnapshot();
  });

  it('a 2-person template leaves the other person alone', () => {
    const prompt = build(makeAnalysis({ template: { people_count: 2 }, subject: { label: 'the woman on the left' } }));
    expect(prompt).toContain('Replace the woman on the left in image 1');
    expect(prompt).toContain('Leave every other person');
    expect(prompt).toMatchSnapshot();
  });

  it('uses singular wording for one photo and "a person" for unclear gender', () => {
    const prompt = build(makeAnalysis({ user: { gender: 'unclear' } }), 1);
    expect(prompt).toContain('Image 2 shows a real person: the new subject.');
    expect(prompt).toContain('exactly as in image 2.');
    expect(prompt).toContain('The new subject is a person aged');
  });

  it('omits empty fill-ins instead of leaving empty brackets', () => {
    const prompt = build(makeAnalysis({ subject: { pose: '', action: ' ' }, user: { build: '', hair: '' } }));
    expect(prompt).toContain('exactly: the pose, the action, the camera angle (');
    expect(prompt).toContain('The new subject is a man aged 30-40.');
    expect(prompt).not.toContain('()');
  });

  it(`stays within ${PROMPT_MAX_CHARS} chars with 500-char fill-ins and keeps identity and body clauses`, () => {
    const long = (word: string) => `${word} `.repeat(500).slice(0, 500);
    const analysis = makeAnalysis({
      template: { people_count: 3, camera_angle: long('angle'), framing: long('frame'), lighting: long('light'), scene: long('scene') },
      subject: { label: long('label'), pose: long('pose'), action: long('act'), held_objects: [long('bat'), long('ball')] },
      user: { gender: 'female', age_group: 'child', age_range: long('age'), build: long('build'), hair: long('hair') },
    });
    const prompt = build(analysis, 4);
    expect(prompt.length).toBeLessThanOrEqual(PROMPT_MAX_CHARS);
    expect(prompt).toContain('Leave every other person in image 1 unchanged.');
    expect(prompt).toContain('Show their real face, facial structure, skin tone, hair, body build and age exactly as in images 2–5.');
    expect(prompt).toContain("Do not blend their face with the original person's face.");
    expect(prompt).toContain('Do not make them broader, more muscular, slimmer or taller than they are.');
    expect(prompt).toContain('Do not move the camera');
    expect(prompt).toContain(BODY);
    expect(prompt).toContain("a child's height, head-to-body ratio and limb length");
    expect(prompt).toContain('Photorealistic, matching the grain');
  });

  it('only trims scene fill-ins while they are enough to fit', () => {
    const analysis = makeAnalysis({ template: { scene: 'beach '.repeat(150) } });
    const prompt = build(analysis);
    expect(prompt.length).toBeLessThanOrEqual(PROMPT_MAX_CHARS);
    expect(prompt).toContain('aged 30-40, slim build, short dark hair.');
  });
});
