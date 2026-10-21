import 'server-only';
import type { AiAdapter, AiUsage } from './index';
import { ActionRating, TemplateAnalysis } from './schemas';

/**
 * Deterministic stand-in for the vision LLM. A template URL with `?mock=crossGender` makes the
 * template subject female; `?mock=crossAge` makes it a child. Everything else is a fixed adult male.
 */

const ZERO_USAGE: AiUsage = { inputTokens: 0, outputTokens: 0, costUsdMicros: 0 };

function mockFlag(url: string): string | null {
  try {
    return new URL(url).searchParams.get('mock');
  } catch {
    return null;
  }
}

export const mockAi: AiAdapter = {
  async analyze({ templateUrl, userPhotoUrls }) {
    const flag = mockFlag(templateUrl);
    const result = TemplateAnalysis.parse({
      template: {
        people_count: 1,
        subject: {
          label: 'the person in the centre',
          gender: flag === 'crossGender' ? 'female' : 'male',
          age_group: flag === 'crossAge' ? 'child' : 'adult',
          age_range: flag === 'crossAge' ? '8-10' : '30-40',
          pose: 'standing, facing the camera',
          action: 'smiling at the camera',
          held_objects: [],
          clothing: 'casual clothes',
        },
        camera_angle: 'eye level',
        framing: 'medium shot',
        lighting: 'soft daylight',
        scene: 'outdoors',
      },
      user: {
        gender: 'male',
        age_group: 'adult',
        age_range: '30-40',
        build: 'average',
        hair: 'short dark hair',
        photos: userPhotoUrls.map((_, i) => ({ index: i + 1, occlusions: ['none'] })),
      },
    });
    return { result, usage: ZERO_USAGE };
  },

  async rateAction({ candidateUrls }) {
    const result = ActionRating.parse({
      scores: candidateUrls.map((_, i) => ({ index: i + 1, score: 3, reason: 'mock rating' })),
    });
    return { result, usage: ZERO_USAGE };
  },
};
