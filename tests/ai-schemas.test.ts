import { describe, expect, it } from 'vitest';
import { ActionRating, TemplateAnalysis } from '@/lib/ai/schemas';

const valid = {
  template: {
    people_count: 2,
    subject: {
      label: 'the man in the red shirt on the left',
      gender: 'male',
      age_group: 'adult',
      age_range: '25-35',
      pose: 'mid-air, knees tucked',
      action: 'jumping off a pier into the sea',
      held_objects: [],
      clothing: 'red t-shirt, blue swim shorts',
    },
    camera_angle: 'low angle from the water',
    framing: 'full body, subject in left third',
    lighting: 'late afternoon sun from the right',
    scene: 'wooden pier over calm water',
  },
  user: {
    gender: 'female',
    age_group: 'adult',
    age_range: '30-40',
    build: 'slim',
    hair: 'shoulder-length brown hair',
    photos: [
      { index: 1, occlusions: ['none'] },
      { index: 2, occlusions: ['sunglasses', 'hat'] },
    ],
  },
};

describe('TemplateAnalysis', () => {
  it('accepts the documented shape', () => {
    expect(TemplateAnalysis.parse(valid)).toEqual(valid);
  });

  it("rejects age_group 'baby'", () => {
    const bad = structuredClone(valid);
    (bad.template.subject as { age_group: string }).age_group = 'baby';
    expect(TemplateAnalysis.safeParse(bad).success).toBe(false);
  });

  it('rejects an unknown occlusion and a missing field', () => {
    const badOcclusion = structuredClone(valid);
    (badOcclusion.user.photos[0] as { occlusions: string[] }).occlusions = ['scarf'];
    expect(TemplateAnalysis.safeParse(badOcclusion).success).toBe(false);

    const missing = structuredClone(valid) as Partial<typeof valid>;
    delete missing.user;
    expect(TemplateAnalysis.safeParse(missing).success).toBe(false);
  });
});

describe('ActionRating', () => {
  it('accepts scores 1-5 and rejects others', () => {
    expect(ActionRating.safeParse({ scores: [{ index: 1, score: 5, reason: 'same pose' }] }).success).toBe(true);
    expect(ActionRating.safeParse({ scores: [{ index: 1, score: 6, reason: 'x' }] }).success).toBe(false);
    expect(ActionRating.safeParse({ scores: [{ index: 1, score: 2.5, reason: 'x' }] }).success).toBe(false);
  });
});
