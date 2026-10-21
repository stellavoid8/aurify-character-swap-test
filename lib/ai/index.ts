import 'server-only';
import { useMockAi } from '../env';
import { anthropicAi } from './anthropic';
import { mockAi } from './mock';
import type { ActionRating, TemplateAnalysis } from './schemas';

/**
 * Vision LLM behind one small interface. The pipeline imports `ai` from here and never the
 * vendor SDK. Without ANTHROPIC_API_KEY the deterministic mock is used.
 */

export type AiUsage = { inputTokens: number; outputTokens: number; costUsdMicros: number };

/** Ids attached to the provider_calls row. All optional (scripts and tests run without a job). */
export type AiCallContext = { jobId?: string | null; roundId?: string | null };

export type AnalyzeInput = {
  templateUrl: string;
  /** Normalized [x, y, w, h] of the face to describe when the template shows several people. */
  subjectBox: [number, number, number, number] | null;
  userPhotoUrls: string[];
  context?: AiCallContext;
};

export type RateActionInput = {
  templateUrl: string;
  candidateUrls: string[];
  context?: AiCallContext;
};

export interface AiAdapter {
  analyze(input: AnalyzeInput): Promise<{ result: TemplateAnalysis; usage: AiUsage }>;
  rateAction(input: RateActionInput): Promise<{ result: ActionRating; usage: AiUsage }>;
}

export const ai: AiAdapter = useMockAi ? mockAi : anthropicAi;

export { ActionRating, TemplateAnalysis } from './schemas';
