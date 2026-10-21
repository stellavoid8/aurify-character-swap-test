import { describe, expect, it } from 'vitest';
import { formatUsd, microsFromTokens, microsFromUsd, sumMicros } from '@/lib/money';

describe('formatUsd', () => {
  it('uses three decimals below $1 and two from $1 up', () => {
    expect(formatUsd(39000)).toBe('$0.039');
    expect(formatUsd(1_250_000)).toBe('$1.25');
    expect(formatUsd(0)).toBe('$0.000');
    expect(formatUsd(500_000)).toBe('$0.500');
    expect(formatUsd(1_000_000)).toBe('$1.00');
    expect(formatUsd(1_234_567_890)).toBe('$1,234.57');
  });

  it('switches to two decimals when rounding reaches $1', () => {
    expect(formatUsd(999_600)).toBe('$1.00');
  });

  it('never shows a real cost as zero', () => {
    expect(formatUsd(400)).toBe('<$0.001');
    expect(formatUsd(500)).toBe('$0.001');
  });

  it('handles negatives', () => {
    expect(formatUsd(-39000)).toBe('-$0.039');
  });
});

describe('microsFromTokens', () => {
  it('prices tokens per million', () => {
    // 1,000 in × $4/MTok + 500 out × $20/MTok = $0.004 + $0.01 = $0.014
    expect(microsFromTokens({ inputTokens: 1000, outputTokens: 500, inPerMTokUsd: 4, outPerMTokUsd: 20 })).toBe(14_000);
  });

  it('returns an integer for fractional prices', () => {
    const micros = microsFromTokens({ inputTokens: 333, outputTokens: 7, inPerMTokUsd: 0.075, outPerMTokUsd: 0.3 });
    expect(Number.isInteger(micros)).toBe(true);
    expect(micros).toBe(27);
  });
});

describe('sumMicros', () => {
  it('sums and treats missing costs as zero', () => {
    expect(sumMicros(39000, null, 1, undefined, 14_000)).toBe(53_001);
    expect(sumMicros()).toBe(0);
  });
});

describe('microsFromUsd', () => {
  it('converts without float drift', () => {
    expect(microsFromUsd(0.039)).toBe(39000);
    expect(microsFromUsd(0.1 + 0.2)).toBe(300_000);
  });
});
