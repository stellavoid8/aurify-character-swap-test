import { describe, expect, it } from 'vitest';
import { GENERATOR_BY_CASE, GENERATOR_CANDIDATES } from '@/lib/fal/models';
import { detectCases, swapCase } from '@/lib/pipeline/cases';
import { makeAnalysis } from './helpers/analysis';

describe('detectCases', () => {
  it('case 1: same gender and age group sets no flags', () => {
    expect(detectCases(makeAnalysis())).toEqual({ crossGender: false, crossAge: false, direction: null });
  });

  it('male template + female user is crossGender', () => {
    const cases = detectCases(makeAnalysis({ user: { gender: 'female' } }));
    expect(cases).toEqual({ crossGender: true, crossAge: false, direction: null });
  });

  it('adult template + child user is crossAge, adult_to_child', () => {
    const cases = detectCases(makeAnalysis({ user: { age_group: 'child', age_range: '7-9' } }));
    expect(cases).toEqual({ crossGender: false, crossAge: true, direction: 'adult_to_child' });
  });

  it('child template + adult user is crossAge, child_to_adult', () => {
    const cases = detectCases(makeAnalysis({ subject: { age_group: 'child' } }));
    expect(cases).toMatchObject({ crossAge: true, direction: 'child_to_adult' });
  });

  it('any teen side gives direction teen', () => {
    expect(detectCases(makeAnalysis({ user: { age_group: 'teen' } })).direction).toBe('teen');
    expect(detectCases(makeAnalysis({ subject: { age_group: 'teen' }, user: { age_group: 'child' } })).direction).toBe('teen');
  });

  it('unclear gender never sets a flag', () => {
    expect(detectCases(makeAnalysis({ user: { gender: 'unclear' } })).crossGender).toBe(false);
    expect(detectCases(makeAnalysis({ subject: { gender: 'unclear' }, user: { gender: 'female' } })).crossGender).toBe(false);
    expect(detectCases(makeAnalysis({ subject: { gender: 'unclear' }, user: { gender: 'unclear' } }))).toEqual({
      crossGender: false,
      crossAge: false,
      direction: null,
    });
  });
});

describe('swapCase', () => {
  it('maps each bake-off case', () => {
    expect(swapCase(makeAnalysis())).toBe('case1');
    expect(swapCase(makeAnalysis({ user: { gender: 'female' } }))).toBe('case2_m2f');
    expect(swapCase(makeAnalysis({ subject: { gender: 'female' } }))).toBe('case2_f2m');
    expect(swapCase(makeAnalysis({ user: { age_group: 'child' } }))).toBe('case3_a2c');
    expect(swapCase(makeAnalysis({ subject: { age_group: 'child' } }))).toBe('case3_c2a');
  });

  it('same-gender women and unclear gender are case1', () => {
    expect(swapCase(makeAnalysis({ subject: { gender: 'female' }, user: { gender: 'female' } }))).toBe('case1');
    expect(swapCase(makeAnalysis({ user: { gender: 'unclear' } }))).toBe('case1');
  });

  it('age outranks gender, and a teen side is other', () => {
    expect(swapCase(makeAnalysis({ user: { gender: 'female', age_group: 'child' } }))).toBe('case3_a2c');
    expect(swapCase(makeAnalysis({ subject: { gender: 'female', age_group: 'child' } }))).toBe('case3_c2a');
    expect(swapCase(makeAnalysis({ user: { age_group: 'teen' } }))).toBe('other');
  });

  it('every case has a generator from the candidates', () => {
    for (const model of Object.values(GENERATOR_BY_CASE)) expect(GENERATOR_CANDIDATES).toContain(model);
  });
});
