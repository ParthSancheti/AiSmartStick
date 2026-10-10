import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const state = vi.hoisted(() => ({
  phase: 'idle' as string,
  live: false,
  pcm: false,
  valid: true,
  surface: true,
  say: vi.fn(async () => 'spoken'),
  discard: vi.fn(),
  abort: vi.fn(),
}));
vi.mock('../src/core/store/assistant', () => ({ useAssistant: { getState: () => ({ phase: state.phase, lang: 'en' }), setState: vi.fn() } }));
vi.mock('../src/core/store/session', () => ({ getSettings: () => ({ replyLang: 'auto' }) }));
vi.mock('../src/core/audio/audioManager', () => ({ say: state.say, liveAudioActive: () => state.live, livePcmPlaying: () => state.pcm, discardInvalidSpeech: state.discard }));
vi.mock('../src/core/surfaces', () => ({ userSurfaceActive: () => state.surface }));
vi.mock('../src/core/voice/recognition', () => ({ abortRecognition: state.abort }));
import { announce, cancelInvalidAnnouncements } from '../src/core/ai/voiceOut';

describe('announcement validity across existing Live and recognition retries', () => {
  beforeEach(() => {
    vi.useFakeTimers();
    state.valid = false;
    cancelInvalidAnnouncements();
    vi.clearAllTimers();
    vi.clearAllMocks();
    state.phase = 'idle';
    state.live = state.pcm = false;
    state.valid = state.surface = true;
  });
  afterEach(() => {
    state.valid = false;
    cancelInvalidAnnouncements();
    vi.clearAllTimers();
    vi.useRealTimers();
  });
  const options = () => ({ nav: true, dedupeKey: 'nav-next', isCurrent: () => state.valid });

  it('drops a delayed Live turn if its route becomes invalid before PCM finishes', async () => {
    state.live = state.pcm = true;
    announce('Turn left', options());
    expect(vi.getTimerCount()).toBe(1);
    state.valid = false;
    state.pcm = false;
    await vi.advanceTimersByTimeAsync(800);
    expect(state.say).not.toHaveBeenCalled();
    expect(vi.getTimerCount()).toBe(0);
  });

  it.each(['listening', 'thinking'])('drops a recognition-delayed turn after its owner changes during %s', async (phase) => {
    state.phase = phase;
    announce('Turn right', options());
    expect(vi.getTimerCount()).toBe(1);
    state.valid = false;
    state.phase = 'idle';
    await vi.advanceTimersByTimeAsync(1200);
    expect(state.say).not.toHaveBeenCalled();
    expect(state.abort).not.toHaveBeenCalled();
    expect(vi.getTimerCount()).toBe(0);
  });

  it('rechecks validity on every Live retry and stops retrying as soon as invalid', async () => {
    state.live = state.pcm = true;
    announce('Turn left', options());
    await vi.advanceTimersByTimeAsync(2400);
    expect(state.say).not.toHaveBeenCalled();
    expect(vi.getTimerCount()).toBe(1);
    state.valid = false;
    await vi.advanceTimersByTimeAsync(800);
    expect(state.say).not.toHaveBeenCalled();
    expect(vi.getTimerCount()).toBe(0);
  });

  it('preserves valid Live turn priority and forwards its guard to the unified queue', async () => {
    state.live = state.pcm = true;
    const opts = options();
    announce('Turn left', opts);
    state.pcm = false;
    await vi.advanceTimersByTimeAsync(800);
    expect(state.say).toHaveBeenCalledExactlyOnceWith('Turn left', { lang: 'en', priority: 'nav', dedupeKey: 'nav-next', isCurrent: opts.isCurrent });
    await vi.advanceTimersByTimeAsync(10_000);
    expect(state.say).toHaveBeenCalledTimes(1);
    expect(state.abort).not.toHaveBeenCalled();
  });

  it('preserves a valid recognition-delayed announcement once recognition finishes', async () => {
    state.phase = 'listening';
    announce('Turn right', options());
    state.phase = 'idle';
    await vi.advanceTimersByTimeAsync(1200);
    expect(state.say).toHaveBeenCalledTimes(1);
    expect(state.say).toHaveBeenCalledWith('Turn right', expect.objectContaining({ priority: 'nav', isCurrent: expect.any(Function) }));
  });

  it('does not abort recognition or queue invalid high-priority speech', () => {
    state.phase = 'listening';
    state.valid = false;
    announce('Old warning', { high: true, dedupeKey: 'warning', isCurrent: () => state.valid });
    expect(state.abort).not.toHaveBeenCalled();
    expect(state.say).not.toHaveBeenCalled();
    expect(vi.getTimerCount()).toBe(0);
  });

  it('supersedes retry timers with the same dedupe key and speaks only the newest turn', async () => {
    state.live = state.pcm = true;
    announce('Turn in 30 metres', options());
    await vi.advanceTimersByTimeAsync(200);
    announce('Turn in 20 metres', options());
    expect(vi.getTimerCount()).toBe(1);
    state.pcm = false;
    await vi.advanceTimersByTimeAsync(1000);
    expect(state.say).toHaveBeenCalledExactlyOnceWith('Turn in 20 metres', expect.objectContaining({ dedupeKey: 'nav-next' }));
    expect(vi.getTimerCount()).toBe(0);
  });

  it('does not let an invalid replacement cancel a still-valid pending announcement', async () => {
    state.live = state.pcm = true;
    announce('Current turn', options());
    announce('Obsolete turn', { nav: true, dedupeKey: 'nav-next', isCurrent: () => false });
    expect(vi.getTimerCount()).toBe(1);
    state.pcm = false;
    await vi.advanceTimersByTimeAsync(800);
    expect(state.say).toHaveBeenCalledExactlyOnceWith('Current turn', expect.objectContaining({ dedupeKey: 'nav-next' }));
  });

  it('cancels invalid timers immediately and delegates owned active/queued speech invalidation', async () => {
    state.live = state.pcm = true;
    announce('Turn left', options());
    expect(vi.getTimerCount()).toBe(1);
    state.valid = false;
    cancelInvalidAnnouncements();
    expect(vi.getTimerCount()).toBe(0);
    expect(state.discard).toHaveBeenCalledTimes(1);
    state.pcm = false;
    await vi.advanceTimersByTimeAsync(10_000);
    expect(state.say).not.toHaveBeenCalled();
  });

  it('leaves valid retry timers running when other owned speech becomes invalid', async () => {
    state.live = state.pcm = true;
    announce('Current turn', options());
    cancelInvalidAnnouncements();
    expect(vi.getTimerCount()).toBe(1);
    state.pcm = false;
    await vi.advanceTimersByTimeAsync(800);
    expect(state.say).toHaveBeenCalledTimes(1);
  });

  it('does not speak on the guardian surface when a delayed turn becomes ready', async () => {
    state.live = state.pcm = true;
    announce('Turn left', options());
    state.surface = false;
    state.pcm = false;
    await vi.advanceTimersByTimeAsync(800);
    expect(state.say).not.toHaveBeenCalled();
  });
});
