import { beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({ generate: vi.fn(), stats: vi.fn(async () => {}) }));
vi.mock('../functions/node_modules/@google/genai', () => ({
  ThinkingLevel: { LOW: 'LOW', MINIMAL: 'MINIMAL' },
  GoogleGenAI: class { models = { generateContent: mocks.generate }; },
}));
vi.mock('../functions/src/common', () => ({
  CALLABLE: {}, GEMINI_API_KEY: { value: () => 'test-key' },
  GEMINI_LIVE_MODEL: { value: () => 'test-live' }, GEMINI_FLASH_MODEL: { value: () => 'test-flash' },
  GEMINI_VISION_MODEL: { value: () => 'gemini-3.5-flash-lite' },
  db: { collection: () => ({ doc: () => ({ set: mocks.stats }) }) },
  quota: vi.fn(), requireAuth: () => 'test-uid',
  str: (v: unknown, max: number) => typeof v === 'string' ? v.trim().slice(0, max) : '',
}));
import { assistantVision, visionModelFailure } from '../functions/src/assistant';
const request = { auth: { uid: 'test-uid' }, data: { task: 'describe_scene', lang: 'en', imageBase64: '/9j/4AAQ' } } as any;

describe('bounded vision backend', () => {
  beforeEach(() => { mocks.generate.mockReset(); mocks.stats.mockClear(); });
  it('returns the actual model description with a bounded single request', async () => {
    mocks.generate.mockResolvedValue({ text: JSON.stringify({ spoken: 'A chair is on the image left.', hazards: [], imageQuality: 'good', uncertain: false }), candidates: [{ finishReason: 'STOP' }] });
    const result = await assistantVision.run(request);
    expect(result.spoken).toBe('A chair is on the image left.');
    expect(mocks.generate).toHaveBeenCalledTimes(1);
    expect(mocks.generate).toHaveBeenCalledWith(expect.objectContaining({
      model: 'gemini-3.5-flash-lite', config: expect.objectContaining({
        thinkingConfig: { thinkingLevel: 'MINIMAL' },
        httpOptions: { timeout: 20000, retryOptions: { attempts: 1 } },
      }),
    }));
  });
  it('reports model failure without a second slow request or success metadata', async () => {
    mocks.generate.mockRejectedValue(new Error('504 deadline exceeded'));
    await expect(assistantVision.run(request)).rejects.toMatchObject({ code: 'deadline-exceeded', details: { service: 'vision-model', reason: 'timeout' } });
    expect(mocks.generate).toHaveBeenCalledTimes(1);
    expect(mocks.stats).not.toHaveBeenCalled();
  });
  it.each([
    [429, 'resource-exhausted', 'quota'], [401, 'failed-precondition', 'configuration'],
    [403, 'failed-precondition', 'configuration'], [404, 'failed-precondition', 'configuration'],
    [400, 'internal', 'request'], [503, 'unavailable', 'upstream'], [504, 'deadline-exceeded', 'timeout'],
  ])('classifies upstream HTTP %i without exposing SDK details or retrying', async (status, code, reason) => {
    mocks.generate.mockRejectedValue(Object.assign(new Error('API_KEY=[private] request-image=[private]'), { status }));
    const error = await assistantVision.run(request).catch(e => e);
    expect(error).toMatchObject({ code, details: { service: 'vision-model', reason } });
    expect(JSON.stringify(error)).not.toContain('[private]');
    expect(error.message).not.toContain('[private]');
    expect(mocks.generate).toHaveBeenCalledTimes(1);
    expect(mocks.stats).not.toHaveBeenCalled();
  });
  it('recognizes API JSON timeout bodies and transport timeouts', () => {
    expect(visionModelFailure(new Error('{"error":{"code":504,"message":"upstream deadline"}}'))).toMatchObject({ code: 'deadline-exceeded' });
    expect(visionModelFailure(Object.assign(new Error('operation ended'), { name: 'TimeoutError' }))).toMatchObject({ code: 'deadline-exceeded' });
  });
});
