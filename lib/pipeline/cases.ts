import type { TemplateAnalysis } from '../ai/schemas';

/**
 * Case 1: same gender and age group. Case 2 (crossGender): both genders known and different.
 * Case 3 (crossAge): the age groups differ. `unclear` gender never sets a flag.
 */

export type AgeDirection = 'adult_to_child' | 'child_to_adult' | 'teen';

export type Cases = { crossGender: boolean; crossAge: boolean; direction: AgeDirection | null };

export function detectCases(analysis: TemplateAnalysis): Cases {
  const subject = analysis.template.subject;
  const user = analysis.user;

  const crossGender = subject.gender !== 'unclear' && user.gender !== 'unclear' && subject.gender !== user.gender;
  const crossAge = subject.age_group !== user.age_group;

  let direction: AgeDirection | null = null;
  if (crossAge) {
    if (subject.age_group === 'teen' || user.age_group === 'teen') direction = 'teen';
    else direction = user.age_group === 'child' ? 'adult_to_child' : 'child_to_adult';
  }

  return { crossGender, crossAge, direction };
}

/**
 * The bake-off case a job falls into, which picks its generator (GENERATOR_BY_CASE in lib/fal/models.ts).
 * Age outranks gender: an adult man's template with a girl as the user is case3_a2c, since the age
 * change is the larger edit. Any teen side is `other` (no bake-off pair); `unclear` gender counts as case1.
 */
export type SwapCase = 'case1' | 'case2_m2f' | 'case2_f2m' | 'case3_a2c' | 'case3_c2a' | 'other';

export function swapCase(analysis: TemplateAnalysis, cases: Cases = detectCases(analysis)): SwapCase {
  if (cases.direction === 'adult_to_child') return 'case3_a2c';
  if (cases.direction === 'child_to_adult') return 'case3_c2a';
  if (cases.direction === 'teen') return 'other';
  if (!cases.crossGender) return 'case1';
  return analysis.template.subject.gender === 'male' ? 'case2_m2f' : 'case2_f2m';
}
