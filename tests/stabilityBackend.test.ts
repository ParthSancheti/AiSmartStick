import { beforeEach, describe, expect, it, vi } from 'vitest';

const h = vi.hoisted(() => ({
  apiKey: 'single-key',
  visionModel: 'gemini-3.8-flash',
  liveModel: 'gemini-3.8-live',
  clientCalls: [] as { apiKey?: string; apiVersion?: string }[],
  generate: vi.fn(),
  authCreate: vi.fn(),
  quota: vi.fn(async () => {}),
  stats: vi.fn(async () => {}),
}));

vi.mock('../functions/node_modules/@google/genai', () => ({
  ThinkingLevel: { LOW: 'LOW', MINIMAL: 'MINIMAL' },
  GoogleGenAI: class {
    models = { generateContent: h.generate };
    authTokens = { create: h.authCreate };
    constructor(opts: { apiKey?: string; httpOptions?: { apiVersion?: string } }) {
      h.clientCalls.push({ apiKey: opts?.apiKey, apiVersion: opts?.httpOptions?.apiVersion });
    }
  },
}));

vi.mock('../functions/src/common', () => ({
  CALLABLE: {},
  GEMINI_API_KEY: { value: () => h.apiKey },
  GEMINI_LIVE_MODEL: { value: () => h.liveModel },
  GEMINI_FLASH_MODEL: { value: () => 'gemini-3.8-flash' },
  GEMINI_VISION_MODEL: { value: () => h.visionModel },
  db: { collection: () => ({ doc: () => ({ set: h.stats }) }) },
  quota: h.quota,
  requireAuth: () => 'test-uid',
  str: (v: unknown, max: number) => (typeof v === 'string' ? v.trim().slice(0, max) : ''),
}));

import { assistantVision, getLiveToken, parseGeminiApiKeys } from '../functions/src/assistant';

describe('Gemini backend key pool, Live v1beta token, and vision model compatibility', () => {
  beforeEach(() => {
    h.apiKey = 'single-key';
    h.visionModel = 'gemini-3.8-flash';
    h.liveModel = 'gemini-3.8-live';
    h.clientCalls.length = 0;
    h.generate.mockReset();
    h.authCreate.mockReset();
    h.quota.mockClear();
    h.stats.mockClear();
  });

  it('supports a single key cleanly and parses optional comma/newline-separated keys without duplicates', () => {
    expect(parseGeminiApiKeys('key-only')).toEqual(['key-only']);
    expect(parseGeminiApiKeys('key-1, key-2\nkey-1; key-3')).toEqual(['key-1', 'key-2', 'key-3']);
    expect(parseGeminiApiKeys('', 'backup-1')).toEqual(['backup-1']);
  });

  it('mints ephemeral Live tokens on v1beta and fails over on multi-key quota errors', async () => {
    h.apiKey = 'key-a, key-b';
    h.authCreate
      .mockRejectedValueOnce(Object.assign(new Error('RESOURCE_EXHAUSTED'), { status: 429 }))
      .mockResolvedValueOnce({ name: 'auth_tokens/ok-token' });

    const out = await getLiveToken.run({ auth: { uid: 'test-uid' }, data: {} } as any);
    expect(out).toEqual({ token: 'auth_tokens/ok-token', liveModel: 'gemini-3.8-live', flashModel: 'gemini-3.8-flash' });
    expect(h.clientCalls.every((c) => c.apiVersion === 'v1beta')).toBe(true);
    expect(h.authCreate).toHaveBeenCalledTimes(2);
  });

  it('uses LOW thinking level (not MINIMAL) when vision model is gemini-3.8-flash and rotates backup key on 429', async () => {
    h.apiKey = 'key-1, key-2';
    h.generate
      .mockRejectedValueOnce(Object.assign(new Error('RESOURCE_EXHAUSTED'), { status: 429 }))
      .mockResolvedValueOnce({
        text: JSON.stringify({ spoken: 'A wooden desk is ahead.', hazards: [], imageQuality: 'good', uncertain: false }),
        candidates: [{ finishReason: 'STOP' }],
      });

    const res = await assistantVision.run({
      auth: { uid: 'test-uid' },
      data: { task: 'describe_scene', lang: 'en', imageBase64: '/9j/4AAQ' },
    } as any);

    expect(res.spoken).toBe('A wooden desk is ahead.');
    expect(h.generate).toHaveBeenCalledTimes(2);
    expect(h.generate).toHaveBeenLastCalledWith(expect.objectContaining({
      model: 'gemini-3.8-flash',
      config: expect.objectContaining({ thinkingConfig: { thinkingLevel: 'LOW' } }),
    }));
  });
});
