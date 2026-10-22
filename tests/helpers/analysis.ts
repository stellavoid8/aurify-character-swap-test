import type { TemplateAnalysis } from '@/lib/ai/schemas';

type Subject = TemplateAnalysis['template']['subject'];
type User = TemplateAnalysis['user'];

/** A valid analysis: adult man in the template, adult man as the user, one clean photo. */
export function makeAnalysis(
  overrides: { subject?: Partial<Subject>; user?: Partial<User>; template?: Partial<Omit<TemplateAnalysis['template'], 'subject'>> } = {},
): TemplateAnalysis {
  return {
    template: {
      people_count: 1,
      camera_angle: 'low angle from the side',
      framing: 'full body, wide shot',
      lighting: 'late afternoon sun from the left',
      scene: 'a wooden pier over a lake',
      ...overrides.template,
      subject: {
        label: 'the man in the red shorts',
        gender: 'male',
        age_group: 'adult',
        age_range: '30-40',
        pose: 'mid-air, knees tucked, arms out',
        action: 'jumping off the end of the pier',
        held_objects: [],
        clothing: 'red swim shorts',
        ...overrides.subject,
      },
    },
    user: {
      gender: 'male',
      age_group: 'adult',
      age_range: '30-40',
      build: 'slim',
      hair: 'short dark hair',
      photos: [{ index: 1, occlusions: ['none'] }],
      ...overrides.user,
    },
  };
}
