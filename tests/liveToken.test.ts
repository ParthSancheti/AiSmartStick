import { describe, expect, it, vi } from 'vitest';
const { createToken } = vi.hoisted(() => ({ createToken: vi.fn(async () => ({ name: 'auth_tokens/test' })) }));
vi.mock('../functions/node_modules/@google/genai', () => ({ ThinkingLevel: { LOW: 'LOW' }, GoogleGenAI: class { authTokens = { create: createToken }; } }));
vi.mock('../functions/src/common', () => ({
  CALLABLE: {}, GEMINI_API_KEY: { value: () => 'test-key' },
  GEMINI_LIVE_MODEL: { value: () => 'test-live-model' }, GEMINI_FLASH_MODEL: { value: () => 'test-flash' },
  GEMINI_VISION_MODEL: { value: () => 'test-vision' }, db: {}, quota: vi.fn(), requireAuth: () => 'test-uid', str: vi.fn(),
}));
import { getLiveToken } from '../functions/src/assistant';

describe('Live token setup contract', () => {
  it('locks the model while permitting client tools, instructions and transcription', async () => {
    const result = await getLiveToken.run({ auth: { uid: 'test-uid' }, data: {} } as any);
    expect(result.token).toBe('auth_tokens/test');
    expect(createToken).toHaveBeenCalledWith({ config: expect.objectContaining({
      uses: 1, liveConnectConstraints: { model: 'test-live-model' }, lockAdditionalFields: [],
    }) });
  });
});
