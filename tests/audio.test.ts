import { beforeEach, describe, expect, it, vi } from 'vitest';

const spoken: string[] = [];
let release: (() => void)[] = [];
vi.mock('../src/core/audio/tts', () => ({
  ttsEngine: () => ({
    name: 'none',
    speak: (text: string) =>
      new Promise<void>((r) => {
        spoken.push(text);
        release.push(r);
      }),
    stop: async () => {
      release.forEach((r) => r());
      release = [];
    },
  }),
}));

const { say, stopAll, useAudio } = await import('../src/core/audio/audioManager');
const flush = () => new Promise((r) => setTimeout(r, 0));
const finishCurrent = async () => {
  const r = release.shift();
  r?.();
  await flush();
  await flush();
};

describe('audio manager priorities', () => {
  beforeEach(async () => {
    await stopAll();
    spoken.length = 0;
    release = [];
  });

  it('queues normal messages in order', async () => {
    void say('one', { lang: 'en' });
    void say('two', { lang: 'en' });
    await flush();
    expect(spoken).toEqual(['one']);
    await finishCurrent();
    expect(spoken).toEqual(['one', 'two']);
  });

  it('critical interrupts normal speech, then the normal item resumes', async () => {
    const normal = say('assistant reply', { lang: 'en' });
    await flush();
    const crit = say('SOS sent', { lang: 'en', priority: 'critical' });
    await flush();
    await flush();
    expect(spoken[spoken.length - 1]).toBe('SOS sent');
    await finishCurrent();
    expect(await crit).toBe('spoken');
    expect(spoken[spoken.length - 1]).toBe('assistant reply'); // resumed (replayed)
    await finishCurrent();
    expect(await normal).toBe('spoken');
  });

  it('P2 user reply interrupts P4 navigation; interrupted navigation is discarded (stale)', async () => {
    const nav = say('In 30 meters turn left', { lang: 'en', priority: 'nav' });
    await flush();
    void say('Here is your answer', { lang: 'en', priority: 'user' });
    await flush();
    await flush();
    expect(spoken[spoken.length - 1]).toBe('Here is your answer');
    expect(await nav).toBe('interrupted');
    await finishCurrent();
  });

  it('lower priority never interrupts higher (P5 during P0)', async () => {
    void say('SOS sent', { lang: 'en', priority: 'critical' });
    await flush();
    void say('Battery at 60 percent', { lang: 'en', priority: 'normal' });
    await flush();
    expect(spoken[spoken.length - 1]).toBe('SOS sent');
    await finishCurrent();
    await finishCurrent();
  });

  it('drops background items when something else is playing', async () => {
    void say('talking', { lang: 'en' });
    await flush();
    expect(await say('hint', { lang: 'en', priority: 'background' })).toBe('dropped');
    await finishCurrent();
  });

  it('dedupe key replaces a queued duplicate', async () => {
    void say('first', { lang: 'en' });
    await flush();
    const a = say('turn left in 30 m', { lang: 'en', dedupeKey: 'turn' });
    void say('turn left in 20 m', { lang: 'en', dedupeKey: 'turn' });
    expect(await a).toBe('dropped');
    expect(useAudio.getState().queueLength).toBe(1);
    await finishCurrent();
    await finishCurrent();
  });
});
