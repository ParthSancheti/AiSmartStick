import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const state = vi.hoisted(() => ({ allowed: true, current: true, haptics: true, linked: true, send: vi.fn(async () => {}) }));
vi.mock('../src/core/device/bridge', () => ({ getTransport: () => ({ send: state.send }) }));
vi.mock('../src/core/store/device', () => ({ useDevice: { getState: () => ({ link: state.linked ? 'connected' : 'disconnected' }) }, isLinked: (link: string) => link === 'connected' }));
vi.mock('../src/core/store/session', () => ({ getSettings: () => ({ haptics: state.haptics }) }));
vi.mock('../src/core/guidance/guidanceState', () => ({ routeManeuverAllowed: () => state.allowed }));
import { stickNavCue } from '../src/core/navigation/stickHaptics';

describe('navigation haptic lifecycle and safety hold', () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.clearAllMocks();
    state.allowed = state.current = state.haptics = state.linked = true;
  });
  afterEach(() => { vi.useRealTimers(); });

  it('preserves the two-tap left cue while current and permitted', async () => {
    const cue = stickNavCue('left', () => state.current);
    await vi.advanceTimersByTimeAsync(350);
    await cue;
    expect(state.send).toHaveBeenCalledTimes(2);
    expect(state.send).toHaveBeenCalledWith({ type: 'haptic', pattern: 'tap' }, { ttlMs: 3000 });
  });

  it.each(['obstacle', 'stopped', 'setting'] as const)('drops a delayed second left tap after %s', async (reason) => {
    const cue = stickNavCue('left', () => state.current);
    await vi.advanceTimersByTimeAsync(0);
    if (reason === 'obstacle') state.allowed = false;
    if (reason === 'stopped') state.current = false;
    if (reason === 'setting') state.haptics = false;
    await vi.advanceTimersByTimeAsync(350);
    await cue;
    expect(state.send).toHaveBeenCalledTimes(1);
  });

  it('does not issue navigation motor commands during a safety hold', async () => {
    state.allowed = false;
    for (const cue of ['upcoming', 'left', 'right', 'off_route', 'arrive'] as const) await stickNavCue(cue);
    expect(state.send).not.toHaveBeenCalled();
    expect(vi.getTimerCount()).toBe(0);
  });

  it('does not allocate a left-tap delay when the stick is unavailable', async () => {
    state.linked = false;
    await stickNavCue('left');
    expect(state.send).not.toHaveBeenCalled();
    expect(vi.getTimerCount()).toBe(0);
  });
});
