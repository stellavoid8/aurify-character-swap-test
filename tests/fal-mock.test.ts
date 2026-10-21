import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest';

/** Local HTTP server standing in for /api/webhooks/fal. Resolves each POST body in arrival order. */
let server: Server;
let baseUrl: string;
const received: { url: string; body: unknown }[] = [];
let onReceive: (() => void) | null = null;

beforeAll(async () => {
  server = createServer((req, res) => {
    let raw = '';
    req.on('data', (chunk) => (raw += chunk));
    req.on('end', () => {
      received.push({ url: req.url ?? '', body: JSON.parse(raw) });
      res.writeHead(200).end('{}');
      onReceive?.();
    });
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  baseUrl = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});

afterAll(() => new Promise<void>((resolve) => server.close(() => resolve())));

afterEach(() => {
  received.length = 0;
  vi.unstubAllEnvs();
});

async function loadClient(failureMode: 'none' | 'once' | 'always' = 'none') {
  vi.resetModules();
  vi.stubEnv('DATABASE_URL', 'postgres://localhost:5432/test');
  vi.stubEnv('FAL_KEY', '');
  vi.stubEnv('MOCK_FAL_FAILURE_MODE', failureMode);
  return import('@/lib/fal/client');
}

function nextWebhook(): Promise<{ url: string; body: unknown }> {
  const count = received.length;
  return new Promise((resolve) => {
    onReceive = () => {
      if (received.length > count) {
        onReceive = null;
        resolve(received[count]);
      }
    };
  });
}

const input = { prompt: 'p', image_urls: ['https://img.example/template.jpg', 'https://img.example/me.jpg'] };

describe('mock fal submitToQueue', () => {
  it('returns a mock request id and POSTs the first input image to the webhook within 5 s', async () => {
    const { submitToQueue } = await loadClient();
    const started = Date.now();
    const arrived = nextWebhook();
    const { requestId } = await submitToQueue({
      model: 'fal-ai/nano-banana-pro/edit',
      input,
      webhookUrl: `${baseUrl}/api/webhooks/fal?cid=c1&a=1&t=x`,
    });
    expect(requestId).toMatch(/^mock-[0-9a-f-]{36}$/);

    const hook = await arrived;
    expect(Date.now() - started).toBeLessThan(5000);
    expect(hook.url).toBe('/api/webhooks/fal?cid=c1&a=1&t=x');
    expect(hook.body).toEqual({
      request_id: requestId,
      status: 'OK',
      payload: { images: [{ url: 'https://img.example/template.jpg' }] },
    });
  }, 8000);

  it('MOCK_FAL_FAILURE_MODE=once fails attempt 1 only', async () => {
    await loadClient('once');
    const { mockWebhookBody } = await import('@/lib/fal/mock');
    expect(mockWebhookBody('r', input, 1)).toMatchObject({ status: 'ERROR', error: 'mock provider error' });
    expect(mockWebhookBody('r', input, 2)).toMatchObject({ status: 'OK' });
  });

  it('MOCK_FAL_FAILURE_MODE=always fails every attempt', async () => {
    await loadClient('always');
    const { mockWebhookBody } = await import('@/lib/fal/mock');
    expect(mockWebhookBody('r', input, 1).status).toBe('ERROR');
    expect(mockWebhookBody('r', input, 3).status).toBe('ERROR');
  });

  it('uses the face-swap target image when there is no image_urls', async () => {
    await loadClient();
    const { mockWebhookBody } = await import('@/lib/fal/mock');
    expect(mockWebhookBody('r', { base_image_url: 'https://img.example/result.jpg', swap_image_url: 'x' }, 1)).toEqual({
      request_id: 'r',
      status: 'OK',
      payload: { images: [{ url: 'https://img.example/result.jpg' }] },
    });
  });
});

describe('mock ai', () => {
  it('returns schema-valid analysis with no key, with cross-gender/age overrides', async () => {
    vi.resetModules();
    vi.stubEnv('DATABASE_URL', 'postgres://localhost:5432/test');
    vi.stubEnv('ANTHROPIC_API_KEY', '');
    const { ai, TemplateAnalysis } = await import('@/lib/ai');

    const plain = await ai.analyze({ templateUrl: 'https://x/t.jpg', subjectBox: null, userPhotoUrls: ['a', 'b'] });
    expect(TemplateAnalysis.parse(plain.result)).toEqual(plain.result);
    expect(plain.result.template.subject).toMatchObject({ gender: 'male', age_group: 'adult', label: 'the person in the centre' });
    expect(plain.result.user.photos).toEqual([
      { index: 1, occlusions: ['none'] },
      { index: 2, occlusions: ['none'] },
    ]);
    expect(plain.usage).toEqual({ inputTokens: 0, outputTokens: 0, costUsdMicros: 0 });

    const gender = await ai.analyze({ templateUrl: 'https://x/t.jpg?mock=crossGender', subjectBox: null, userPhotoUrls: ['a'] });
    expect(gender.result.template.subject.gender).toBe('female');
    const age = await ai.analyze({ templateUrl: 'https://x/t.jpg?mock=crossAge', subjectBox: null, userPhotoUrls: ['a'] });
    expect(age.result.template.subject.age_group).toBe('child');

    const rating = await ai.rateAction({ templateUrl: 'https://x/t.jpg', candidateUrls: ['a', 'b', 'c'] });
    expect(rating.result.scores.map((s) => s.score)).toEqual([3, 3, 3]);
  });
});
