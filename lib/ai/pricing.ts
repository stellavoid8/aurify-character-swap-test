/** USD per million tokens, from Anthropic's pricing page. */
export const ANTHROPIC_PRICES: Record<string, { inPerMTokUsd: number; outPerMTokUsd: number }> = {
  'claude-opus-5-5': { inPerMTokUsd: 4, outPerMTokUsd: 20 },
};

export const ANALYSIS_MODEL = 'claude-opus-5-5';
