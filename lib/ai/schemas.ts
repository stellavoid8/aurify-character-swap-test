import { z } from 'zod';

/**
 * Vision-LLM output shapes. Each schema is both the runtime validator and the input schema of the
 * strict `submit` tool, so the model is constrained to exactly these fields.
 * Photo and candidate `index` values are 1-based and match the "User photo N" / "Candidate N" labels.
 */

const Gender = z.enum(['male', 'female', 'unclear']);
const AgeGroup = z.enum(['child', 'teen', 'adult']);
export const Occlusion = z.enum(['sunglasses', 'hat', 'mask', 'hand_over_face', 'heavy_shadow', 'none']);

export const TemplateAnalysis = z.object({
  template: z.object({
    people_count: z.number().int().min(0),
    subject: z.object({
      /** Plain words, e.g. "the man in the red shirt on the left". */
      label: z.string(),
      gender: Gender,
      age_group: AgeGroup,
      age_range: z.string(),
      pose: z.string(),
      action: z.string(),
      held_objects: z.array(z.string()),
      clothing: z.string(),
    }),
    camera_angle: z.string(),
    framing: z.string(),
    lighting: z.string(),
    scene: z.string(),
  }),
  user: z.object({
    gender: Gender,
    age_group: AgeGroup,
    age_range: z.string(),
    build: z.string(),
    hair: z.string(),
    photos: z.array(
      z.object({
        index: z.number().int().min(1),
        occlusions: z.array(Occlusion),
      }),
    ),
  }),
});
export type TemplateAnalysis = z.infer<typeof TemplateAnalysis>;

export const ActionRating = z.object({
  scores: z.array(
    z.object({
      index: z.number().int().min(1),
      score: z.union([z.literal(1), z.literal(2), z.literal(3), z.literal(4), z.literal(5)]),
      reason: z.string(),
    }),
  ),
});
export type ActionRating = z.infer<typeof ActionRating>;
