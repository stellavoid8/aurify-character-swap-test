import Anthropic from '@anthropic-ai/sdk';
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { providerCalls } from '@/lib/db/schema';
import { createTestDb, type TestDb } from './helpers/db';

let testDb: TestDb;
let close: () => Promise<void>;
vi.mock('@/lib/db', () => ({
  get db() {
    return testDb;
  },
}));
// Keep the retry test fast.
vi.mock('@/lib/limits', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/lib/limits')>()),
  AI_RETRY_DELAY_MS: 1,
}));

beforeAll(async () => {
  ({ db: testDb, close } = await createTestDb());
});

afterAll(async () => {
  await close();
});

beforeEach(async () => {
  await testDb.delete(providerCalls);
});

vi.stubEnv('DATABASE_URL', 'postgres://localhost:5432/test');
const { createAnthropicAi } = await import('@/lib/ai/anthropic');

const analysis = {
  template: {
    people_count: 1,
    subject: {
      label: 'the woman on the right',
      gender: 'female',
      age_group: 'adult',
      age_range: '20-30',
      pose: 'serving',
      action: 'swinging a tennis racket',
      held_objects: ['tennis racket'],
      clothing: 'white tennis dress',
    },
    camera_angle: 'eye level',
    framing: 'full body',
    lighting: 'bright sun',
    scene: 'tennis court',
  },
  user: { gender: 'female', age_group: 'adult', age_range: '25-35', build: 'athletic', hair: 'long blonde', photos: [{ index: 1, occlusions: ['none'] }] },
};

function message(overrides: Record<string, unknown> = {}) {
  return {
    id: 'msg_123',
    model: 'claude-opus-5-5',
    stop_reason: 'end_turn',
    stop_details: null,
    usage: { input_tokens: 3000, output_tokens: 400, cache_creation_input_tokens: 0, cache_read_input_tokens: 0 },
    content: [],
    parsed_output: analysis,
    ...overrides,
  };
}

function stubbed(parse: ReturnType<typeof vi.fn>) {
  return createAnthropicAi(() => ({ beta: { messages: { parse } } }) as never);
}

const input = {
  templateUrl: 'https://store.public.blob.vercel-storage.com/t.jpg',
  subjectBox: [0.6, 0.2, 0.1, 0.15] as [number, number, number, number],
  userPhotoUrls: ['https://store.public.blob.vercel-storage.com/u1.jpg'],
};

describe('anthropicAi.analyze', () => {
  it('sends labelled URL images with the documented request options and writes exactly one provider_calls row', async () => {
    const parse = vi.fn().mockResolvedValue(message());
    const { result, usage } = await stubbed(parse).analyze(input);

    expect(result).toEqual(analysis);
    // 3000 × $4 + 400 × $20 per MTok = 12_000 + 8_000 micros.
    expect(usage).toEqual({ inputTokens: 3000, outputTokens: 400, costUsdMicros: 20_000 });

    const params = parse.mock.calls[0][0];
    expect(params).toMatchObject({
      model: 'claude-opus-5-5',
      max_tokens: 2000,
      betas: ['server-side-fallback-2026-07-01'],
      fallbacks: 'default',
      output_config: { effort: 'low' },
    });
    expect(params.output_config.format).toBeDefined();
    const content = params.messages[0].content;
    expect(content[0]).toEqual({ type: 'text', text: 'Template image' });
    expect(content[1]).toEqual({ type: 'image', source: { type: 'url', url: input.templateUrl } });
    expect(content[2]).toEqual({ type: 'text', text: 'User photo 1' });
    expect(content.at(-1).text).toContain('0.600, 0.200, 0.100, 0.150');

    const rows = await testDb.select().from(providerCalls);
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({
      provider: 'anthropic',
      model: 'claude-opus-5-5',
      stage: 'analyze',
      status: 'ok',
      requestId: 'msg_123',
      costUsdMicros: 20_000,
    });
    expect(rows[0].latencyMs).toBeGreaterThanOrEqual(0);
  });

  it('maps a refusal to ANALYSIS_FAILED and records it', async () => {
    const parse = vi.fn().mockResolvedValue(message({ stop_reason: 'refusal', parsed_output: null }));
    await expect(stubbed(parse).analyze(input)).rejects.toMatchObject({ code: 'ANALYSIS_FAILED' });
    const rows = await testDb.select().from(providerCalls);
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ status: 'error', costUsdMicros: 20_000 });
  });

  it('maps missing parsed output to ANALYSIS_FAILED', async () => {
    const parse = vi.fn().mockResolvedValue(message({ stop_reason: 'max_tokens', parsed_output: null }));
    await expect(stubbed(parse).analyze(input)).rejects.toMatchObject({ code: 'ANALYSIS_FAILED' });
  });

  it('retries once after a rate limit, then succeeds', async () => {
    const rateLimit = new Anthropic.RateLimitError(429, { type: 'error' }, 'rate limited', new Headers());
    const parse = vi.fn().mockRejectedValueOnce(rateLimit).mockResolvedValueOnce(message());
    await expect(stubbed(parse).analyze(input)).resolves.toMatchObject({ result: analysis });
    expect(parse).toHaveBeenCalledTimes(2);
    const rows = await testDb.select().from(providerCalls);
    expect(rows.map((r) => r.status).sort()).toEqual(['error', 'ok']);
  });

  it('gives up with ANALYSIS_FAILED after the second connection error', async () => {
    const parse = vi.fn().mockRejectedValue(new Anthropic.APIConnectionError({ message: 'socket hang up' }));
    await expect(stubbed(parse).analyze(input)).rejects.toMatchObject({ code: 'ANALYSIS_FAILED' });
    expect(parse).toHaveBeenCalledTimes(2);
  });

  it('does not retry a bad request', async () => {
    const bad = new Anthropic.BadRequestError(400, { type: 'error' }, 'bad', new Headers());
    const parse = vi.fn().mockRejectedValue(bad);
    await expect(stubbed(parse).analyze(input)).rejects.toMatchObject({ code: 'ANALYSIS_FAILED' });
    expect(parse).toHaveBeenCalledTimes(1);
  });
});

describe('anthropicAi.rateAction', () => {
  it('labels candidates and returns the parsed rating', async () => {
    const rating = { scores: [{ index: 1, score: 4, reason: 'same serve' }] };
    const parse = vi.fn().mockResolvedValue(message({ parsed_output: rating }));
    const { result } = await stubbed(parse).rateAction({ templateUrl: input.templateUrl, candidateUrls: [input.templateUrl] });
    expect(result).toEqual(rating);
    expect(parse.mock.calls[0][0].messages[0].content[2]).toEqual({ type: 'text', text: 'Candidate 1' });
    expect((await testDb.select().from(providerCalls))[0].stage).toBe('rate_action');
  });
});
