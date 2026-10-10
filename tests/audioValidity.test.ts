import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const state = vi.hoisted(() => ({
  spoken: [] as string[],
  finishes: [] as (() => void)[],
  stopBarrier: null as Promise<void> | null,
  failStop: false,
  stop: vi.fn(),
}));
vi.mock('../src/core/store/session', () => ({ getSettings: () => ({ voiceOut: true, voiceRate: 1, assistantVolume: 100 }) }));
vi.mock('../src/core/audio/tts', () => ({
  ttsEngine: () => ({
    name: 'native',
    speak: (text: string) => new Promise<void>((resolve) => {
      state.spoken.push(text);
      state.finishes.push(resolve);
    }),
    stop: async () => {
      state.stop();
      state.finishes.splice(0).forEach(finish => finish());
      await state.stopBarrier;
      if (state.failStop) {
        state.failStop = false;
        throw new Error('Native TTS stop failed');
      }
    },
  }),
}));
vi.mock('../src/core/audio/audioContext', () => ({ sharedAudioContext: () => ctx }));

const sources: { stop: ReturnType<typeof vi.fn>; disconnect: ReturnType<typeof vi.fn>; onended: (() => void) | null }[] = [];
const ctx = {
  currentTime: 1,
  destination: {},
  createGain: () => ({ gain: { value: 1 }, connect: vi.fn() }),
  createBuffer: (_channels: number, length: number, rate: number) => {
    const data = new Float32Array(length);
    return { duration: length / rate, getChannelData: () => data };
  },
  createBufferSource: () => {
    const source = { buffer: null, connect: vi.fn(), start: vi.fn(), stop: vi.fn(), disconnect: vi.fn(), onended: null as (() => void) | null };
    sources.push(source);
    return source;
  },
};

import { discardInvalidSpeech, livePcmPlaying, playPcmChunk, say, stopAll, useAudio } from '../src/core/audio/audioManager';

const flush = () => vi.advanceTimersByTimeAsync(0);
async function finishCurrent() {
  state.finishes.shift()?.();
  await flush();
}

describe('validity in the existing unified audio queue', () => {
  beforeEach(async () => {
    vi.useFakeTimers();
    state.stopBarrier = null;
    state.failStop = false;
    await stopAll();
    await flush();
    state.spoken.length = 0;
    state.finishes.length = 0;
    sources.length = 0;
    vi.clearAllMocks();
  });
  afterEach(async () => {
    state.stopBarrier = null;
    await stopAll();
    await flush();
    vi.useRealTimers();
  });

  it.each(['hazard', 'route stop'] as const)('drops navigation queued behind critical speech after %s', async (reason) => {
    let active = true;
    let obstacleClear = true;
    const critical = say('Emergency alert', { lang: 'en', priority: 'critical' });
    const nav = say('Turn left', { lang: 'en', priority: 'nav', isCurrent: () => active && obstacleClear });
    expect(useAudio.getState().queueLength).toBe(1);
    if (reason === 'hazard') obstacleClear = false;
    else active = false;
    await finishCurrent();
    expect(await critical).toBe('spoken');
    expect(await nav).toBe('dropped');
    expect(state.spoken).toEqual(['Emergency alert']);
    expect(useAudio.getState().queueLength).toBe(0);
  });

  it.each(['high', 'critical'] as const)('an invalid %s item neither stops PCM nor interrupts current speech', async (priority) => {
    const conversation = say('Conversation response', { lang: 'en', priority: 'user' });
    playPcmChunk('AAAA');
    expect(livePcmPlaying()).toBe(true);
    expect(await say('Obsolete alert', { lang: 'en', priority, isCurrent: () => false })).toBe('dropped');
    expect(sources[0].stop).not.toHaveBeenCalled();
    expect(state.stop).not.toHaveBeenCalled();
    expect(state.spoken).toEqual(['Conversation response']);
    await finishCurrent();
    expect(await conversation).toBe('spoken');
  });

  it('does not replay a resumable item whose owner became invalid while interruption completed', async () => {
    let current = true;
    const old = say('Old scene description', { lang: 'en', priority: 'normal', isCurrent: () => current });
    const critical = say('Stop. Obstacle ahead.', { lang: 'en', priority: 'critical' });
    current = false;
    await flush();
    expect(await old).toBe('interrupted');
    expect(state.spoken).toEqual(['Old scene description', 'Stop. Obstacle ahead.']);
    await finishCurrent();
    expect(await critical).toBe('spoken');
    expect(state.spoken).toHaveLength(2);
    expect(useAudio.getState().queueLength).toBe(0);
  });

  it('preserves one replay of a still-valid interrupted message', async () => {
    const normal = say('Current information', { lang: 'en', isCurrent: () => true });
    const critical = say('Emergency alert', { lang: 'en', priority: 'critical' });
    await flush();
    expect(state.spoken).toEqual(['Current information', 'Emergency alert']);
    await finishCurrent();
    expect(await critical).toBe('spoken');
    expect(state.spoken).toEqual(['Current information', 'Emergency alert', 'Current information']);
    await finishCurrent();
    expect(await normal).toBe('spoken');
  });

  it('deduplicates queued updates, then rechecks the replacement at dequeue', async () => {
    let current = true;
    const critical = say('Emergency alert', { lang: 'en', priority: 'critical' });
    const older = say('Turn left in 30 metres', { lang: 'en', priority: 'nav', dedupeKey: 'turn', isCurrent: () => true });
    const latest = say('Turn left in 20 metres', { lang: 'en', priority: 'nav', dedupeKey: 'turn', isCurrent: () => current });
    expect(await older).toBe('dropped');
    expect(useAudio.getState().queueLength).toBe(1);
    current = false;
    await finishCurrent();
    expect(await critical).toBe('spoken');
    expect(await latest).toBe('dropped');
    expect(state.spoken).toEqual(['Emergency alert']);
  });

  it('does not let an invalid replacement discard a valid queued message', async () => {
    const critical = say('Emergency alert', { lang: 'en', priority: 'critical' });
    const valid = say('Turn right', { lang: 'en', priority: 'nav', dedupeKey: 'turn', isCurrent: () => true });
    expect(await say('Old left turn', { lang: 'en', priority: 'nav', dedupeKey: 'turn', isCurrent: () => false })).toBe('dropped');
    expect(useAudio.getState().queueLength).toBe(1);
    await finishCurrent();
    expect(await critical).toBe('spoken');
    expect(state.spoken).toEqual(['Emergency alert', 'Turn right']);
    await finishCurrent();
    expect(await valid).toBe('spoken');
  });

  it('keeps one queued navigation update during a burst instead of duplicating work', async () => {
    const critical = say('Emergency alert', { lang: 'en', priority: 'critical' });
    const updates = Array.from({ length: 50 }, (_, i) => say(`Turn update ${i}`, { lang: 'en', priority: 'nav', dedupeKey: 'turn', isCurrent: () => true }));
    expect(useAudio.getState().queueLength).toBe(1);
    await finishCurrent();
    expect(await critical).toBe('spoken');
    expect(state.spoken).toEqual(['Emergency alert', 'Turn update 49']);
    await finishCurrent();
    const results = await Promise.all(updates);
    expect(results.filter(result => result === 'dropped')).toHaveLength(49);
    expect(results.filter(result => result === 'spoken')).toHaveLength(1);
  });

  it('stops invalid active navigation without stopping PCM or dropping an unowned reply', async () => {
    let valid = true;
    const nav = say('Turn left now', { lang: 'en', priority: 'nav', isCurrent: () => valid });
    const reply = say('Conversation information', { lang: 'en', priority: 'normal' });
    playPcmChunk('AAAA');
    valid = false;
    discardInvalidSpeech();
    expect(await nav).toBe('interrupted');
    await flush();
    expect(state.stop).toHaveBeenCalledTimes(1);
    expect(sources[0].stop).not.toHaveBeenCalled();
    expect(livePcmPlaying()).toBe(true);
    expect(state.spoken).toEqual(['Turn left now', 'Conversation information']);
    await finishCurrent();
    expect(await reply).toBe('spoken');
  });

  it('preserves valid active conversation while discarding invalid queued navigation', async () => {
    let valid = true;
    const conversation = say('Conversation reply', { lang: 'en', priority: 'user' });
    const nav = say('Turn right', { lang: 'en', priority: 'nav', isCurrent: () => valid });
    valid = false;
    discardInvalidSpeech();
    expect(await nav).toBe('dropped');
    expect(state.stop).not.toHaveBeenCalled();
    expect(useAudio.getState()).toMatchObject({ speaking: true, queueLength: 0 });
    await finishCurrent();
    expect(await conversation).toBe('spoken');
  });

  it('allows one critical alert after asynchronous invalidation, without reviving old speech', async () => {
    let valid = true;
    let finishStop: () => void = () => {};
    state.stopBarrier = new Promise<void>(resolve => { finishStop = resolve; });
    const nav = say('Old turn', { lang: 'en', priority: 'nav', isCurrent: () => valid });
    valid = false;
    discardInvalidSpeech();
    const critical = say('Stop. Obstacle ahead.', { lang: 'en', priority: 'critical' });
    discardInvalidSpeech();
    expect(await nav).toBe('interrupted');
    expect(useAudio.getState().queueLength).toBe(1);
    expect(state.spoken).toEqual(['Old turn']);
    finishStop();
    state.stopBarrier = null;
    await flush();
    expect(state.spoken).toEqual(['Old turn', 'Stop. Obstacle ahead.']);
    expect(state.stop).toHaveBeenCalledTimes(1);
    await finishCurrent();
    expect(await critical).toBe('spoken');
    expect(useAudio.getState().queueLength).toBe(0);
  });

  it('does not stall critical speech when the native stop request rejects during invalidation', async () => {
    let valid = true;
    const nav = say('Old turn', { lang: 'en', priority: 'nav', isCurrent: () => valid });
    valid = false;
    state.failStop = true;
    discardInvalidSpeech();
    const critical = say('Emergency alert', { lang: 'en', priority: 'critical' });
    expect(await nav).toBe('interrupted');
    await flush();
    expect(state.spoken).toEqual(['Old turn', 'Emergency alert']);
    await finishCurrent();
    expect(await critical).toBe('spoken');
    expect(useAudio.getState().queueLength).toBe(0);
  });

  it('does not publish unchanged audio state during repeated guidance validity checks', async () => {
    let valid = true;
    const conversation = say('Conversation reply', { lang: 'en', priority: 'user' });
    const nav = say('Turn right', { lang: 'en', priority: 'nav', isCurrent: () => valid });
    const changed = vi.fn();
    const unsubscribe = useAudio.subscribe(changed);
    try {
      for (let i = 0; i < 20; i++) discardInvalidSpeech();
      expect(changed).not.toHaveBeenCalled();
      valid = false;
      discardInvalidSpeech();
      expect(await nav).toBe('dropped');
      expect(changed).toHaveBeenCalledTimes(1);
      for (let i = 0; i < 20; i++) discardInvalidSpeech();
      expect(changed).toHaveBeenCalledTimes(1);
      expect(state.stop).not.toHaveBeenCalled();
    } finally {
      unsubscribe();
    }
    await finishCurrent();
    expect(await conversation).toBe('spoken');
  });
});
