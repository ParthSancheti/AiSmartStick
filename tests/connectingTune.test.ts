import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('../src/core/audio/tts', () => ({ ttsEngine: () => ({ name: 'none', speak: async () => {}, stop: async () => {} }) }));

class FakeParam {
  value: number;
  constructor(v: number) {
    this.value = v;
  }
  cancelScheduledValues = vi.fn();
  setValueAtTime = vi.fn((v: number) => {
    this.value = v;
  });
  linearRampToValueAtTime = vi.fn((v: number) => {
    this.value = v;
  });
  exponentialRampToValueAtTime = vi.fn();
}

const sources: FakeSource[] = [];
class FakeSource {
  buffer: unknown = null;
  loop = false;
  onended: (() => void) | null = null;
  started = false;
  stopped = false;
  connect = vi.fn((n: unknown) => n);
  disconnect = vi.fn();
  start = vi.fn(() => {
    this.started = true;
  });
  stop = vi.fn(() => {
    this.stopped = true;
  });
  constructor() {
    sources.push(this);
  }
}

let ctxState: AudioContextState = 'running';
const contexts: FakeCtx[] = [];
class FakeCtx {
  state: AudioContextState = ctxState;
  sampleRate = 48000;
  currentTime = 1;
  destination = {};
  gains: { gain: FakeParam }[] = [];
  constructor() {
    contexts.push(this);
  }
  resume = vi.fn(() => Promise.resolve());
  createBuffer = vi.fn((_ch: number, len: number, rate: number) => {
    const data = new Float32Array(len);
    return { duration: len / rate, getChannelData: () => data };
  });
  createBufferSource = vi.fn(() => new FakeSource());
  createGain = vi.fn(() => {
    const g = { gain: new FakeParam(1), connect: vi.fn((n: unknown) => n), disconnect: vi.fn() };
    this.gains.push(g);
    return g;
  });
}

const elements: FakeAudio[] = [];
class FakeAudio {
  loop = false;
  volume = 1;
  paused = true;
  constructor(public src: string) {
    elements.push(this);
  }
  play = vi.fn(() => {
    this.paused = false;
    return Promise.resolve();
  });
  pause = vi.fn(() => {
    this.paused = true;
  });
  removeAttribute = vi.fn();
  load = vi.fn();
}

const g = globalThis as unknown as Record<string, unknown>;
g.window = { AudioContext: FakeCtx, addEventListener: vi.fn(), matchMedia: () => ({ matches: false, addEventListener: () => {} }) };
g.Audio = FakeAudio;

const { __resetAudioContextForTests } = await import('../src/core/audio/audioContext');
const tune = await import('../src/core/audio/connectingTune');
const { useAudio } = await import('../src/core/audio/audioManager');
const { useSession } = await import('../src/core/store/session');

describe('connecting tune', () => {
  beforeEach(() => {
    vi.useFakeTimers();
    __resetAudioContextForTests();
    sources.length = 0;
    elements.length = 0;
    contexts.length = 0;
    ctxState = 'running';
    (g.window as Record<string, unknown>).AudioContext = FakeCtx;
    useAudio.setState({ speaking: false });
    useSession.getState().updateSettings({ earcons: true, assistantVolume: 100 });
  });

  afterEach(() => {
    tune.stopConnectingTune();
    vi.useRealTimers();
  });

  it('renders a soft, click-free phrase of ~1.6 s', () => {
    const p = tune.renderPhrase(22050);
    expect(p.length).toBe(Math.round(tune.PHRASE_S * 22050));
    let peak = 0;
    for (const v of p) peak = Math.max(peak, Math.abs(v));
    expect(peak).toBeCloseTo(0.9, 2);
    expect(Math.abs(p[0])).toBeLessThan(0.01);
    expect(Math.abs(p[p.length - 1])).toBeLessThan(0.001);
  });

  it('encodes a valid 16-bit mono WAV data URI', () => {
    const uri = tune.encodeWavDataUri(new Float32Array([0, 0.5, -0.5, 1]), 22050);
    expect(uri.startsWith('data:audio/wav;base64,')).toBe(true);
    const bin = atob(uri.split(',')[1]);
    expect(bin.slice(0, 4)).toBe('RIFF');
    expect(bin.slice(8, 12)).toBe('WAVE');
    expect(bin.length).toBe(44 + 8);
  });

  it('loops a buffer on the shared Web Audio context and stops cleanly', () => {
    const stop = tune.startConnectingTune();
    expect(tune.connectingTunePlaying()).toBe(true);
    expect(tune.connectingTuneEngine()).toBe('webaudio');
    expect(sources).toHaveLength(1);
    expect(sources[0].loop).toBe(true);
    expect(sources[0].started).toBe(true);
    expect(contexts[0].gains.at(-1)!.gain.value).toBeCloseTo(tune.TUNE_GAIN);
    stop();
    expect(sources[0].stopped).toBe(true);
    expect(tune.connectingTunePlaying()).toBe(false);
    stop(); // idempotent
    expect(sources[0].stop).toHaveBeenCalledTimes(1);
  });

  it('only one tune at a time: starting again stops the previous one', () => {
    tune.startConnectingTune();
    tune.startConnectingTune();
    expect(sources).toHaveLength(2);
    expect(sources[0].stopped).toBe(true);
    expect(sources[1].stopped).toBe(false);
  });

  it('falls back to an <audio> element when Web Audio stays locked', () => {
    ctxState = 'suspended';
    const stop = tune.startConnectingTune();
    expect(tune.connectingTuneEngine()).toBe('webaudio');
    vi.advanceTimersByTime(tune.FALLBACK_AFTER_MS + 10);
    expect(sources[0].stopped).toBe(true);
    expect(elements).toHaveLength(1);
    expect(elements[0].src.startsWith('data:audio/wav;base64,')).toBe(true);
    expect(elements[0].loop).toBe(true);
    expect(elements[0].play).toHaveBeenCalled();
    expect(tune.connectingTuneEngine()).toBe('element');
    stop();
    expect(elements[0].pause).toHaveBeenCalled();
  });

  it('uses the <audio> element when there is no Web Audio at all', () => {
    (g.window as Record<string, unknown>).AudioContext = undefined;
    tune.startConnectingTune();
    expect(tune.connectingTuneEngine()).toBe('element');
    expect(elements[0].volume).toBeCloseTo(tune.TUNE_GAIN);
  });

  it('respects the sounds setting and the assistant volume', () => {
    useSession.getState().updateSettings({ earcons: false });
    tune.startConnectingTune();
    expect(tune.connectingTunePlaying()).toBe(false);
    useSession.getState().updateSettings({ earcons: true, assistantVolume: 0 });
    tune.startConnectingTune();
    expect(tune.connectingTunePlaying()).toBe(false);
    useSession.getState().updateSettings({ assistantVolume: 50 });
    tune.startConnectingTune();
    expect(contexts[0].gains.at(-1)!.gain.value).toBeCloseTo(tune.TUNE_GAIN * 0.5);
  });

  it('goes silent while the app is speaking, and comes back after', () => {
    tune.startConnectingTune();
    const gain = contexts[0].gains.at(-1)!.gain;
    useAudio.setState({ speaking: true });
    expect(gain.value).toBe(0);
    useAudio.setState({ speaking: false });
    expect(gain.value).toBeCloseTo(tune.TUNE_GAIN);
  });

  it('never rings forever (hard cap)', () => {
    tune.startConnectingTune();
    vi.advanceTimersByTime(tune.MAX_TUNE_MS + 1);
    expect(tune.connectingTunePlaying()).toBe(false);
    expect(sources[0].stopped).toBe(true);
  });
});
