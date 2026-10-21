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
