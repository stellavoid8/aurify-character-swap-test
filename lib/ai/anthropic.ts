import 'server-only';
import Anthropic from '@anthropic-ai/sdk';
import { transformJSONSchema } from '@anthropic-ai/sdk/lib/transform-json-schema';
import { z } from 'zod';
import { env } from '../env';
import { AppError } from '../errors';
import { sniffImageType } from '../images';
import { AI_MAX_TOKENS, AI_RETRY_DELAY_MS, AI_TIMEOUT_MS } from '../limits';
import { microsFromTokens } from '../money';
import { fetchObject } from '../storage';
import { recordCall } from '../telemetry';
import type { AiAdapter, AiCallContext, AiUsage } from './index';
import { ANALYSIS_MODEL, ANTHROPIC_PRICES } from './pricing';
import { ActionRating, TemplateAnalysis } from './schemas';

/**
 * Claude vision calls with structured output. Every HTTP attempt writes one provider_calls row.
 * Retries are ours, not the SDK's: one retry after AI_RETRY_DELAY_MS on 429 or a dropped
 * connection, then ANALYSIS_FAILED.
 *
 * The output comes back as the input of a strict `submit` tool and images are always inlined as
 * base64, because ANTHROPIC_BASE_URL may point at a gateway that ignores output_config.format and
 * rejects URL image sources.
 */

const ANALYZE_SYSTEM = `You describe photos for an app that puts a user into a template photo.
Rules:
- Describe only what is visible. Do not guess. When you are unsure of gender or age, use "unclear" or the closest age group and a wide age range.
- Never name, identify or speculate about who any real person is.
- Template: describe the subject's pose, action, held objects and clothing, and the camera angle, framing, lighting and scene, precisely enough to recreate the moment. Count every person visible.
- If a subject box is given (normalized x, y, width, height of the subject's face, origin top-left), the subject is the person whose face is inside that box. Otherwise the subject is the most prominent person.
- The subject label is a short plain-words phrase that picks out the subject, e.g. "the man in the red shirt on the left".
- User: judge gender, age, build and hair from all of the user's photos together. For each user photo, list what covers or hides the face, or "none".`;

const RATE_SYSTEM = `You compare generated images with a template photo.
For each candidate, rate 1-5 how well it keeps the template's pose, action, held objects, camera framing and lighting. 5 means the same moment; 1 means a different pose or action.
Ignore who the person is: identity, face and likeness are judged elsewhere and must not affect the score.
Give a one-sentence reason per candidate. Never name or identify real people.`;

type ImageBlock = Anthropic.Beta.BetaImageBlockParam;
type ContentBlock = Anthropic.Beta.BetaContentBlockParam;

const MEDIA_TYPES = { jpeg: 'image/jpeg', png: 'image/png', webp: 'image/webp', gif: 'image/gif' } as const;

async function imageBlock(url: string): Promise<ImageBlock> {
  const bytes = await fetchObject(url);
  const type = sniffImageType(bytes);
  if (!type || !(type in MEDIA_TYPES)) throw new Error(`imageBlock: unsupported image type ${type ?? 'unknown'}`);
  const media_type = MEDIA_TYPES[type as keyof typeof MEDIA_TYPES];
  return { type: 'image', source: { type: 'base64', media_type, data: bytes.toString('base64') } };
}

const SUBMIT_TOOL = 'submit';

function submitTool(schema: z.ZodType): Anthropic.Beta.BetaTool {
  const input_schema = transformJSONSchema(z.toJSONSchema(schema, { reused: 'ref' })) as Anthropic.Beta.BetaTool.InputSchema;
  return { name: SUBMIT_TOOL, description: 'Submit your answer. Call this exactly once.', input_schema, strict: true };
}

async function labelledImages(images: { label: string; url: string }[]): Promise<ContentBlock[]> {
  const blocks = await Promise.all(
    images.map(async ({ label, url }): Promise<ContentBlock[]> => [{ type: 'text', text: label }, await imageBlock(url)]),
  );
  return blocks.flat();
}

function usageFrom(message: Anthropic.Beta.BetaMessage, requestedModel: string): AiUsage {
  // A server-side fallback may serve the request on another model; price by the model that answered when we know it.
  const prices = ANTHROPIC_PRICES[message.model] ?? ANTHROPIC_PRICES[requestedModel];
  // No prompt caching is requested, so cache read/write tokens are always 0 here.
  const inputTokens = message.usage.input_tokens;
  const outputTokens = message.usage.output_tokens;
  return { inputTokens, outputTokens, costUsdMicros: microsFromTokens({ inputTokens, outputTokens, ...prices }) };
}

/** The model called submit with input that failed the schema; carries what the correction turn needs. */
class InvalidSubmit extends Error {
  constructor(
    readonly reply: Anthropic.Beta.BetaContentBlock[],
    readonly toolUseId: string,
    readonly issues: string,
    readonly usage: AiUsage,
  ) {
    super(issues);
  }
}

const addUsage = (a: AiUsage, b: AiUsage): AiUsage => ({
  inputTokens: a.inputTokens + b.inputTokens,
  outputTokens: a.outputTokens + b.outputTokens,
  costUsdMicros: a.costUsdMicros + b.costUsdMicros,
});

const isRetryable = (err: unknown) => err instanceof Anthropic.RateLimitError || err instanceof Anthropic.APIConnectionError;
const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

type CallSpec<S extends z.ZodType> = {
  stage: string;
  schema: S;
  system: string;
  content: ContentBlock[];
  context?: AiCallContext;
};

/** Narrow slice of the SDK client this adapter uses; tests pass a stub. */
export type AnthropicLike = { beta: { messages: Pick<Anthropic['beta']['messages'], 'create'> } };

export function createAnthropicAi(getClient: () => AnthropicLike): AiAdapter {
  async function attempt<S extends z.ZodType>(
    spec: CallSpec<S>,
    messages: Anthropic.Beta.BetaMessageParam[] = [{ role: 'user', content: spec.content }],
  ): Promise<{ result: z.infer<S>; usage: AiUsage }> {
    const model = ANALYSIS_MODEL;
    const started = performance.now();
    let message: Anthropic.Beta.BetaMessage | undefined;
    try {
      const response = await getClient().beta.messages.create({
        model,
        max_tokens: AI_MAX_TOKENS,
        betas: ['server-side-fallback-2026-07-01'],
        fallbacks: 'default',
        output_config: { effort: 'low' },
        // Forced tool_choice is rejected on this model, so the system prompt asks for the call.
        tools: [submitTool(spec.schema)],
        system: `${spec.system}\n\nAnswer only by calling the ${SUBMIT_TOOL} tool.`,
        messages,
      });
      message = response;
      const usage = usageFrom(response, model);
      const submitted = response.content.find((b) => b.type === 'tool_use' && b.name === SUBMIT_TOOL);
      const parsed = submitted?.type === 'tool_use' ? spec.schema.safeParse(submitted.input) : null;
      const failed = response.stop_reason === 'refusal' || !parsed?.success;
      await recordCall({
        jobId: spec.context?.jobId,
        roundId: spec.context?.roundId,
        provider: 'anthropic',
        model: response.model,
        stage: spec.stage,
        requestId: response.id,
        status: failed ? 'error' : 'ok',
        latencyMs: performance.now() - started,
        costUsdMicros: usage.costUsdMicros,
        meta: {
          inputTokens: usage.inputTokens,
          outputTokens: usage.outputTokens,
          stopReason: response.stop_reason,
          ...(response.stop_details ? { refusalCategory: response.stop_details.category } : {}),
        },
      });
      if (failed) {
        const issues = parsed?.error?.issues.map((i) => `${i.path.join('.')}: ${i.message}`).join('; ');
        if (issues && submitted?.type === 'tool_use' && response.stop_reason !== 'refusal') {
          throw new InvalidSubmit(response.content, submitted.id, issues, usage);
        }
        const reason = issues ? `invalid ${SUBMIT_TOOL} input (${issues})` : `no ${SUBMIT_TOOL} call`;
        throw new AppError('ANALYSIS_FAILED', { detail: `${spec.stage}: stop_reason ${response.stop_reason}, ${reason}` });
      }
      return { result: parsed.data as z.infer<S>, usage };
    } catch (err) {
      if (err instanceof AppError || err instanceof InvalidSubmit) throw err;
      if (!message) {
        // The request itself failed (HTTP error or timeout).
        await recordCall({
          jobId: spec.context?.jobId,
          roundId: spec.context?.roundId,
          provider: 'anthropic',
          model,
          stage: spec.stage,
          requestId: err instanceof Anthropic.APIError ? (err.requestID ?? null) : null,
          status: 'error',
          latencyMs: performance.now() - started,
          costUsdMicros: 0,
          meta: { error: err instanceof Error ? err.name : 'unknown', status: err instanceof Anthropic.APIError ? err.status : null },
        });
      }
      throw err;
    }
  }

  /**
   * The gateway in front of the API does not always enforce `strict`, so a submit call can fail the
   * schema. Hand the issues back as an error tool_result and let the model resubmit once.
   */
  async function withCorrection<S extends z.ZodType>(spec: CallSpec<S>) {
    try {
      return await attempt(spec);
    } catch (err) {
      if (!(err instanceof InvalidSubmit)) throw err;
      try {
        const { result, usage } = await attempt(spec, [
          { role: 'user', content: spec.content },
          { role: 'assistant', content: err.reply },
          {
            role: 'user',
            content: [{ type: 'tool_result', tool_use_id: err.toolUseId, is_error: true, content: `Invalid input: ${err.issues}. Call ${SUBMIT_TOOL} again with corrected input.` }],
          },
        ]);
        return { result, usage: addUsage(err.usage, usage) };
      } catch (retryErr) {
        if (!(retryErr instanceof InvalidSubmit)) throw retryErr;
        throw new AppError('ANALYSIS_FAILED', { detail: `${spec.stage}: invalid ${SUBMIT_TOOL} input after correction (${retryErr.issues})` });
      }
    }
  }

  async function call<S extends z.ZodType>(spec: CallSpec<S>) {
    try {
      try {
        return await withCorrection(spec);
      } catch (err) {
        if (!isRetryable(err)) throw err;
        await sleep(AI_RETRY_DELAY_MS);
        return await withCorrection(spec);
      }
    } catch (err) {
      if (err instanceof AppError) throw err;
      throw new AppError('ANALYSIS_FAILED', { detail: `${spec.stage}: ${err instanceof Error ? err.message : err}`, cause: err });
    }
  }

  return {
    async analyze({ templateUrl, subjectBox, userPhotoUrls, context }) {
      const images = await labelledImages([
        { label: 'Template image', url: templateUrl },
        ...userPhotoUrls.map((url, i) => ({ label: `User photo ${i + 1}`, url })),
      ]);
      const instruction = subjectBox
        ? `The template subject's face is inside this box (normalized x, y, width, height): [${subjectBox.map((n) => n.toFixed(3)).join(', ')}].`
        : 'No subject box is given; describe the most prominent person in the template.';
      return call({
        stage: 'analyze',
        schema: TemplateAnalysis,
        system: ANALYZE_SYSTEM,
        content: [...images, { type: 'text', text: `${instruction}\nThere are ${userPhotoUrls.length} user photos.` }],
        context,
      });
    },

    async rateAction({ templateUrl, candidateUrls, context }) {
      const images = await labelledImages([
        { label: 'Template image', url: templateUrl },
        ...candidateUrls.map((url, i) => ({ label: `Candidate ${i + 1}`, url })),
      ]);
      return call({
        stage: 'rate_action',
        schema: ActionRating,
        system: RATE_SYSTEM,
        content: [...images, { type: 'text', text: `Rate all ${candidateUrls.length} candidates.` }],
        context,
      });
    },
  };
}

let client: Anthropic | null = null;

export const anthropicAi = createAnthropicAi(() => {
  client ??= new Anthropic({ apiKey: env.ANTHROPIC_API_KEY, maxRetries: 0, timeout: AI_TIMEOUT_MS });
  return client;
});
