import { beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('../src/core/backend/api', () => ({ call: vi.fn(), BackendError: class extends Error {} }));
vi.mock('../src/core/vision/relay', () => ({ captureFrame: vi.fn() }));
vi.mock('../src/core/ai/voiceOut', () => ({ speakReply: vi.fn(async () => {}), resolveLang: () => 'en' }));
vi.mock('../src/core/feedback/earcons', () => ({ loopEarcon: vi.fn(() => () => {}), earcon: vi.fn() }));

import { realDescribeScene } from '../src/core/ai/realAssistant';
import { call } from '../src/core/backend/api';
import { captureFrame } from '../src/core/vision/relay';
import { speakReply } from '../src/core/ai/voiceOut';
import { useDevice, initialDevice } from '../src/core/store/device';
import { useAssistant } from '../src/core/store/assistant';

describe('direct scene button uses the same server diagnostics as the camera tool', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    useDevice.setState({ ...initialDevice(), link: 'connected', internet: true });
    useAssistant.setState({ phase: 'idle', unavailable: null, thread: [] });
    vi.mocked(captureFrame).mockResolvedValue({ blob: new Blob([new Uint8Array([0xff, 0xd8])], { type: 'image/jpeg' }), ts: Date.now(), scene: -1, origin: 'assistant' });
  });

  it('speaks upstream timeout as an AI analysis timeout and records the actual category', async () => {
    vi.mocked(call).mockRejectedValue(Object.assign(new Error('safe server message'), { code: 'functions/deadline-exceeded', details: { service: 'vision-model', reason: 'timeout' } }));
    await realDescribeScene('en');
    expect(speakReply).toHaveBeenCalledWith(expect.stringContaining('AI picture service took too long'), 'en');
    expect(useAssistant.getState()).toMatchObject({ phase: 'error', unavailable: expect.stringContaining('AI picture service took too long') });
    expect(useAssistant.getState().thread.at(-1)?.text).toContain('AI picture service took too long');
  });

  it('attempts analysis while phone connectivity is unknown', async () => {
    useDevice.setState({ internet: null });
    vi.mocked(call).mockResolvedValue({ spoken: 'A chair on the image left.', hazards: [], uncertain: true, imageQuality: 'good' });
    await realDescribeScene('en');
    expect(call).toHaveBeenCalledWith('assistantVision', expect.any(Object), 40000);
    expect(speakReply).toHaveBeenCalledWith(expect.stringContaining('chair'), 'en', 'vision');
  });

  it('explicit offline status avoids capture and server calls', async () => {
    useDevice.setState({ internet: false });
    await realDescribeScene('en');
    expect(captureFrame).not.toHaveBeenCalled();
    expect(call).not.toHaveBeenCalled();
    expect(speakReply).toHaveBeenCalledWith(expect.stringContaining('No internet'), 'en');
  });
});
