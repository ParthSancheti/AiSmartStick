import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('@capacitor/core', () => ({ Capacitor: { isNativePlatform: () => false } }));
vi.mock('@capacitor-community/text-to-speech', () => ({ TextToSpeech: {} }));

const options = { lang: 'en' as const, rate: 1, volume: 1 };
let synthesis: { getVoices: ReturnType<typeof vi.fn>; speak: ReturnType<typeof vi.fn>; cancel: ReturnType<typeof vi.fn> };

describe('browser TTS completion ownership', () => {
  beforeEach(() => {
    vi.resetModules();
    vi.useFakeTimers();
    synthesis = { getVoices: vi.fn(() => []), speak: vi.fn(), cancel: vi.fn() };
    vi.stubGlobal('window', { speechSynthesis: synthesis });
    vi.stubGlobal('SpeechSynthesisUtterance', class {
      onend: (() => void) | null = null;
      onerror: (() => void) | null = null;
      constructor(public text: string) {}
    });
  });
  afterEach(() => {
    vi.unstubAllGlobals();
    vi.useRealTimers();
  });

  it('cancels audible speech before releasing a stalled completion guard', async () => {
    const { ttsEngine } = await import('../src/core/audio/tts');
    const spoken = ttsEngine().speak('Turn left', options);
    await vi.advanceTimersByTimeAsync(3000);
    await spoken;
    expect(synthesis.cancel).toHaveBeenCalledTimes(1);
    expect(vi.getTimerCount()).toBe(0);
  });

  it('clears a cancelled utterance guard so it cannot cancel a later utterance', async () => {
    const { ttsEngine } = await import('../src/core/audio/tts');
    const first = ttsEngine().speak('Old', options);
    await ttsEngine().stop();
    await first;
    expect(vi.getTimerCount()).toBe(0);
    const next = ttsEngine().speak('A much longer route instruction that is still being spoken', options);
    await vi.advanceTimersByTimeAsync(2500);
    expect(synthesis.cancel).toHaveBeenCalledTimes(1);
    synthesis.speak.mock.calls[1][0].onend();
    await next;
    expect(vi.getTimerCount()).toBe(0);
  });
});
