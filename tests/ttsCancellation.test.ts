import { beforeEach, describe, expect, it, vi } from 'vitest';

const native = vi.hoisted(() => ({
  getSupportedVoices: vi.fn(), speak: vi.fn(), stop: vi.fn(async () => {}),
}));
vi.mock('@capacitor/core', () => ({ Capacitor: { isNativePlatform: () => true } }));
vi.mock('@capacitor-community/text-to-speech', () => ({ TextToSpeech: native }));

const options = { lang: 'en' as const, rate: 1, volume: 1 };

describe('native TTS cancellation at asynchronous boundaries', () => {
  beforeEach(() => {
    vi.resetModules();
    vi.clearAllMocks();
    native.speak.mockResolvedValue(undefined);
  });

  it('does not speak a cancelled route after delayed voice discovery finishes', async () => {
    let voices!: (value: unknown) => void;
    native.getSupportedVoices.mockReturnValueOnce(new Promise(resolve => { voices = resolve; }));
    const { ttsEngine } = await import('../src/core/audio/tts');
    const old = ttsEngine().speak('Turn left', options);
    await ttsEngine().stop();
    voices({ voices: [{ lang: 'en-IN', name: 'local' }] });
    await old;
    expect(native.speak).not.toHaveBeenCalled();
    await ttsEngine().speak('Stop. Obstacle ahead.', options);
    expect(native.speak).toHaveBeenCalledExactlyOnceWith(expect.objectContaining({ text: 'Stop. Obstacle ahead.' }));
  });

  it('does not retry a cancelled utterance with the default voice when Android rejects it', async () => {
    native.getSupportedVoices.mockResolvedValueOnce({ voices: [{ lang: 'en-IN', name: 'local' }] });
    let reject!: (error: Error) => void;
    native.speak.mockReturnValueOnce(new Promise((_resolve, fail) => { reject = fail; }));
    const { ttsEngine } = await import('../src/core/audio/tts');
    const old = ttsEngine().speak('Old direction', options);
    await vi.waitFor(() => expect(native.speak).toHaveBeenCalledTimes(1));
    await ttsEngine().stop();
    reject(new Error('utterance cancelled'));
    await old;
    expect(native.speak).toHaveBeenCalledTimes(1);
  });
});
