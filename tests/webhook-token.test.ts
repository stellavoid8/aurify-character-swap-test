import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const CID = '0f8fad5b-d9cb-469f-a165-70867728950e';
const OTHER = '7c9e6679-7425-40de-944b-e07fc1f90ae7';

const load = () => import('@/lib/webhook-token');

function tokenOf(url: string): string {
  return new URL(url).searchParams.get('t')!;
}

describe('lib/webhook-token', () => {
  beforeEach(() => {
    vi.resetModules();
    vi.stubEnv('DATABASE_URL', 'postgres://localhost:5432/test');
    vi.stubEnv('APP_URL', 'https://swap.example.com/');
    vi.stubEnv('WEBHOOK_SECRET', 'test-webhook-secret');
  });

  afterEach(() => {
    vi.unstubAllEnvs();
  });

  it('builds a callback URL with cid, attempt and a base64url token', async () => {
    const { webhookUrlFor } = await load();
    const url = new URL(webhookUrlFor(CID, 2));
    expect(`${url.origin}${url.pathname}`).toBe('https://swap.example.com/api/webhooks/fal');
    expect(url.searchParams.get('cid')).toBe(CID);
    expect(url.searchParams.get('a')).toBe('2');
    expect(url.searchParams.get('t')).toMatch(/^[A-Za-z0-9_-]{43}$/);
  });

  it('accepts its own token', async () => {
    const { webhookUrlFor, verifyWebhookToken } = await load();
    expect(verifyWebhookToken(CID, 1, tokenOf(webhookUrlFor(CID, 1)))).toBe(true);
  });

  it('rejects a token for another candidate or attempt', async () => {
    const { webhookUrlFor, verifyWebhookToken } = await load();
    const token = tokenOf(webhookUrlFor(CID, 1));
    expect(verifyWebhookToken(OTHER, 1, token)).toBe(false);
    expect(verifyWebhookToken(CID, 2, token)).toBe(false);
  });

  it('rejects truncated, empty and garbage tokens', async () => {
    const { webhookUrlFor, verifyWebhookToken } = await load();
    const token = tokenOf(webhookUrlFor(CID, 1));
    expect(verifyWebhookToken(CID, 1, token.slice(0, -1))).toBe(false);
    expect(verifyWebhookToken(CID, 1, token.slice(0, 10))).toBe(false);
    expect(verifyWebhookToken(CID, 1, '')).toBe(false);
    expect(verifyWebhookToken(CID, 1, 'not a token!')).toBe(false);
    expect(verifyWebhookToken(CID, Number.NaN, token)).toBe(false);
  });

  it('rejects a token signed with another secret', async () => {
    const { webhookUrlFor } = await load();
    const token = tokenOf(webhookUrlFor(CID, 1));
    vi.resetModules();
    vi.stubEnv('WEBHOOK_SECRET', 'rotated-secret');
    const { verifyWebhookToken } = await load();
    expect(verifyWebhookToken(CID, 1, token)).toBe(false);
  });
});
