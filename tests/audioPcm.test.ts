import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const tts = vi.hoisted(() => ({ speak: vi.fn(), stop: vi.fn(async () => {}) }));
vi.mock('../src/core/audio/tts', () => ({ ttsEngine: () => tts }));
vi.mock('../src/core/audio/audioContext', () => ({ sharedAudioContext: () => ctx }));

class FakeSource {
  buffer: { duration: number; getChannelData: () => Float32Array } | null = null;
  onended: (() => void) | null = null;
  connect = vi.fn();
  disconnect = vi.fn();
  start = vi.fn();
  stop = vi.fn();
}

const sources: FakeSource[] = [];
const gain = { gain: { value: 1 }, connect: vi.fn() };
const ctx = {
  currentTime: 1,
  destination: {},
  createGain: vi.fn(() => gain),
  createBuffer: vi.fn((_channels: number, length: number, rate: number) => {
    const data = new Float32Array(length);
    return { duration: length / rate, getChannelData: () => data };
  }),
  createBufferSource: vi.fn(() => {
    const source = new FakeSource();
    sources.push(source);
    return source;
  }),
};

import { interruptPcm, livePcmPlaying, playPcmChunk, say, setLiveSessionOpen, stopAll } from '../src/core/audio/audioManager';
import { useSession } from '../src/core/store/session';

function pcm(samples: number[]) {
  const bytes = new Uint8Array(samples.length * 2);
  const view = new DataView(bytes.buffer);
  samples.forEach((sample, i) => view.setInt16(i * 2, sample, true));
  return btoa(String.fromCharCode(...bytes));
}

describe('Live PCM output in the unified audio owner', () => {
  beforeEach(async () => {
    await stopAll();
    sources.length = 0;
    vi.clearAllMocks();
    tts.speak.mockResolvedValue(undefined);
    useSession.getState().updateSettings({ voiceOut: true, assistantVolume: 75 });
  });

  afterEach(async () => {
    await stopAll();
  });

  it('preserves signed little-endian samples, sample rate, volume, and contiguous scheduling', () => {
    const samples = [-32768, -16384, 0, 16384, 32767];
    playPcmChunk(pcm(samples), 24000);
    playPcmChunk(pcm([0]), 24000);
    expect(ctx.createBuffer).toHaveBeenNthCalledWith(1, 1, samples.length, 24000);
    expect(Array.from(sources[0].buffer!.getChannelData())).toEqual(samples.map((s) => s / 32768));
    expect(gain.gain.value).toBe(0.75);
    expect(sources[0].start).toHaveBeenCalledWith(1.02);
    expect(sources[1].start).toHaveBeenCalledWith(1.02 + samples.length / 24000);
    expect(livePcmPlaying()).toBe(true);
  });

  it('disconnects a completed source and clears its completion callback', () => {
    playPcmChunk(pcm([123]));
    sources[0].onended!();
    expect(sources[0].disconnect).toHaveBeenCalledTimes(1);
    expect(sources[0].onended).toBeNull();
    expect(livePcmPlaying()).toBe(false);
  });

  it('releases every interrupted source and restarts scheduling without obsolete audio', () => {
    playPcmChunk(pcm([123]));
    playPcmChunk(pcm([456]));
    interruptPcm();
    for (const source of sources) {
      expect(source.stop).toHaveBeenCalledTimes(1);
      expect(source.disconnect).toHaveBeenCalledTimes(1);
      expect(source.onended).toBeNull();
    }
    expect(livePcmPlaying()).toBe(false);
    interruptPcm();
    expect(sources[0].disconnect).toHaveBeenCalledTimes(1);
    playPcmChunk(pcm([789]));
    expect(sources[2].start).toHaveBeenCalledWith(1.02);
  });

  it('still disconnects sources when the browser reports them already stopped', () => {
    playPcmChunk(pcm([123]));
    sources[0].stop.mockImplementationOnce(() => { throw new Error('already stopped'); });
    expect(() => interruptPcm()).not.toThrow();
    expect(sources[0].disconnect).toHaveBeenCalledTimes(1);
    expect(livePcmPlaying()).toBe(false);
  });

  it('releases pending PCM when the existing Live session closes', () => {
    setLiveSessionOpen(true);
    playPcmChunk(pcm([123]));
    setLiveSessionOpen(false);
    expect(sources[0].stop).toHaveBeenCalledTimes(1);
    expect(sources[0].disconnect).toHaveBeenCalledTimes(1);
    expect(livePcmPlaying()).toBe(false);
  });

  it('keeps critical speech ahead of Live output and respects the existing mute setting', async () => {
    let finish: () => void = () => {};
    tts.speak.mockReturnValueOnce(new Promise<void>((resolve) => { finish = resolve; }));
    playPcmChunk(pcm([123]));
    const alert = say('SOS sent', { lang: 'en', priority: 'critical' });
    expect(sources[0].stop).toHaveBeenCalledTimes(1);
    expect(sources[0].disconnect).toHaveBeenCalledTimes(1);
    playPcmChunk(pcm([456]));
    expect(sources).toHaveLength(1);
    finish();
    await alert;
    useSession.getState().updateSettings({ voiceOut: false });
    playPcmChunk(pcm([789]));
    expect(sources).toHaveLength(1);
  });
});
