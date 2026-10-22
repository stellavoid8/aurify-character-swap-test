/** USD per million tokens, from Anthropic's pricing page. */
export const ANTHROPIC_PRICES: Record<string, { inPerMTokUsd: number; outPerMTokUsd: number }> = {
  'claude-opus-5-5': { inPerMTokUsd: 4, outPerMTokUsd: 20 },
  // Served instead of claude-opus-5-5 by some Anthropic-compatible gateways; usage is priced by the model that answered.
  'claude-opus-5': { inPerMTokUsd: 5, outPerMTokUsd: 25 },
};

export const ANALYSIS_MODEL = 'claude-opus-5-5';
