import { describe, expect, it, vi } from 'vitest';
import { VIDEO_MAX_LONG_EDGE, VIDEO_TARGET_FPS } from '@/lib/limits';

vi.mock('@/lib/telemetry', () => ({ recordCall: vi.fn() }));
vi.stubEnv('DATABASE_URL', 'postgres://localhost:5432/test');
vi.stubEnv('APP_URL', 'http://localhost:3000');
vi.stubEnv('SESSION_SECRET', 'test-secret');
vi.stubEnv('WEBHOOK_SECRET', 'test-webhook-secret');
vi.stubEnv('FAL_KEY', '');

const { encodeArgs } = await import('@/lib/videos');

describe('encodeArgs', () => {
  it('re-encodes to the target fps, caps the long edge, and keeps audio only when there is some', () => {
    const args = encodeArgs();
    const filter = args[args.indexOf('-vf') + 1];
    expect(filter.startsWith(`fps=${VIDEO_TARGET_FPS},`)).toBe(true);
    expect(filter).toContain(`min(iw,${VIDEO_MAX_LONG_EDGE})`);
    expect(filter).toContain(`min(ih,${VIDEO_MAX_LONG_EDGE})`);
    expect(args).toContain('0:a:0?');
    expect(args.join(' ')).toContain('-movflags +faststart');
  });
});
