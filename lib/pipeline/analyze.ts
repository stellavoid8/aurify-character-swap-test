import 'server-only';
import { ai, type TemplateAnalysis } from '../ai';
import type { Upload } from '../db/schema';
import { AppError } from '../errors';
import { timeStage } from '../telemetry';

/**
 * One vision-LLM call per round: describes the template subject, scene and the user. The adapter
 * records its own `provider_calls` row and throws ANALYSIS_FAILED on any provider error.
 */

export type AnalyzeJobInput = {
  jobId: string;
  roundId: string;
  template: Upload;
  /** In the order they should be labelled "User photo 1", "User photo 2", … */
  userPhotos: Upload[];
};

export async function analyzeJob({ jobId, roundId, template, userPhotos }: AnalyzeJobInput): Promise<TemplateAnalysis> {
  const templateUrl = template.url;
  const userPhotoUrls = userPhotos.map((p) => p.url);
  if (!templateUrl || userPhotoUrls.some((url) => !url)) {
    throw new AppError('ANALYSIS_FAILED', { detail: 'analyzeJob: an upload has no normalized url' });
  }
  const subjectBox = template.subjectFaceIndex == null ? null : (template.faces[template.subjectFaceIndex]?.box ?? null);

  return timeStage(roundId, 'analyzing', async () => {
    const { result } = await ai.analyze({
      templateUrl,
      subjectBox,
      userPhotoUrls: userPhotoUrls as string[],
      context: { jobId, roundId },
    });
    return result;
  });
}
