import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { NativeWalkingState } from '../src/core/native/aissLocation';

const bridge = vi.hoisted(() => ({
  platform: 'android',
  available: true,
  configure: vi.fn(),
  state: vi.fn(),
  control: vi.fn(),
  walking: new Set<(state: NativeWalkingState) => void>(),
  app: new Set<(state: { isActive: boolean }) => void>(),
}));
vi.mock('@capacitor/core', () => ({
  Capacitor: {
    getPlatform: () => bridge.platform,
    isNativePlatform: () => bridge.platform === 'android',
    isPluginAvailable: () => bridge.available,
  },
  registerPlugin: () => ({
    configureWalking: bridge.configure,
    getWalkingState: bridge.state,
    controlWalking: bridge.control,
    addListener: vi.fn(async (_event: string, callback: (state: NativeWalkingState) => void) => {
      bridge.walking.add(callback);
      return { remove: vi.fn(async () => { bridge.walking.delete(callback); }) };
    }),
  }),
}));
vi.mock('@capacitor/app', () => ({
  App: { addListener: vi.fn(async (_event: string, callback: (state: { isActive: boolean }) => void) => {
    bridge.app.add(callback);
    return { remove: vi.fn(async () => { bridge.app.delete(callback); }) };
  }) },
}));

const storage = new Map<string, string>();
let backend: NativeWalkingState;
const snapshot = (owner = 'alice', distanceM = 0, revision = 1): NativeWalkingState => ({
  owner, enabled: true, tracking: true, paused: false, error: null, revision,
  today: { day: '2026-10-18', distanceM, durationS: distanceM, sessions: 0 }, current: null,
});
const deferred = <T>() => {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>(done => { resolve = done; });
  return { promise, resolve };
};
const emit = (state: NativeWalkingState) => bridge.walking.forEach(callback => callback(state));
const fix = (distanceM: number, ts: number) => ({ lat: 18.52 + distanceM / 111_320, lng: 73.85, accuracyM: 5, altitude: null, speedMps: null, headingDeg: null, ts });

describe('native walking ownership and lifecycle', () => {
  beforeEach(() => {
    vi.resetModules(); vi.clearAllMocks(); vi.useFakeTimers(); vi.setSystemTime(new Date(2026, 9, 18, 12));
    storage.clear(); bridge.walking.clear(); bridge.app.clear(); bridge.platform = 'android'; bridge.available = true;
    vi.stubGlobal('localStorage', {
      getItem: (key: string) => storage.get(key) ?? null,
      setItem: (key: string, value: string) => storage.set(key, value),
      removeItem: (key: string) => storage.delete(key),
    });
    backend = snapshot();
    bridge.configure.mockImplementation(async ({ owner, seed }) => {
      if (backend.owner !== owner) backend = snapshot(owner, seed.distanceM);
      backend = { ...backend, enabled: true };
      return structuredClone(backend);
    });
    bridge.state.mockImplementation(async () => structuredClone(backend));
    bridge.control.mockImplementation(async ({ command, owner }) => {
      if (owner && owner !== backend.owner) return structuredClone(backend);
      if (command === 'stop' || command === 'clear') backend = { ...backend, enabled: false, tracking: false };
      if (command === 'clear') backend = { ...snapshot('', 0), enabled: false, tracking: false };
      if (command === 'pause') backend = { ...backend, paused: true };
      if (command === 'resume' || command === 'start') backend = { ...backend, paused: false };
      return structuredClone(backend);
    });
  });
  afterEach(() => { vi.useRealTimers(); vi.unstubAllGlobals(); });

  it('uses the native total after restart and never counts its GPS segments again in JS', async () => {
    backend = snapshot('alice', 120);
    const tracker = await import('../src/core/walking/walkTracker');
    expect(await tracker.startNativeWalking('alice')).toBe(true);
    tracker.walkFix(fix(0, Date.now())); tracker.walkFix(fix(12, Date.now() + 10_000));
    expect(tracker.useWalking.getState()).toMatchObject({ owner: 'alice', today: { distanceM: 120 } });
    expect(tracker.useWalkingTracking.getState()).toMatchObject({ native: true, background: true, error: null });
  });

  it('does not migrate unscoped legacy totals or another account into a new native owner', async () => {
    const tracker = await import('../src/core/walking/walkTracker');
    tracker.useWalking.setState({ owner: null, source: 'gps', today: { day: tracker.dayKey(), distanceM: 987, durationS: 800, sessions: 5 } });
    await tracker.startNativeWalking('bob');
    expect(bridge.configure).toHaveBeenCalledWith(expect.objectContaining({ owner: 'bob', seed: expect.objectContaining({ owner: 'bob', distanceM: 0, sessions: 0 }) }));
    expect(tracker.useWalking.getState().today.distanceM).toBe(0);
    await tracker.startNativeWalking('charlie');
    expect(tracker.useWalking.getState()).toMatchObject({ owner: 'charlie', today: { distanceM: 0 } });
  });

  it('reads again after subscribing so service progress during bridge setup is visible', async () => {
    const tracker = await import('../src/core/walking/walkTracker');
    bridge.configure.mockResolvedValue(snapshot('alice', 5));
    bridge.state.mockResolvedValue(snapshot('alice', 22, 2));
    await tracker.startNativeWalking('alice');
    expect(tracker.useWalking.getState().today.distanceM).toBe(22);
  });

  it('preserves legacy progress only when the account remembered before startup matches', async () => {
    storage.set('aiss.profilePhoto.account.v1', JSON.stringify({ uid: 'alice', name: 'Alice' }));
    backend = snapshot('', 0);
    const tracker = await import('../src/core/walking/walkTracker');
    tracker.useWalking.setState({ owner: null, source: 'gps', today: { day: tracker.dayKey(), distanceM: 45, durationS: 40, sessions: 2 } });
    await tracker.startNativeWalking('alice');
    expect(bridge.configure).toHaveBeenCalledWith(expect.objectContaining({ owner: 'alice', seed: expect.objectContaining({ owner: 'alice', distanceM: 45, sessions: 2 }) }));
    expect(tracker.useWalking.getState().today.distanceM).toBe(45);
  });

  it('does not attribute another remembered account legacy progress to the new account', async () => {
    storage.set('aiss.profilePhoto.account.v1', JSON.stringify({ uid: 'alice', name: 'Alice' }));
    const tracker = await import('../src/core/walking/walkTracker');
    tracker.useWalking.setState({ owner: null, source: 'gps', today: { day: tracker.dayKey(), distanceM: 45, durationS: 40, sessions: 2 } });
    await tracker.startNativeWalking('bob');
    expect(tracker.useWalking.getState().today.distanceM).toBe(0);
  });

  it('rejects old responses, another account and invalid native totals', async () => {
    const tracker = await import('../src/core/walking/walkTracker');
    await tracker.startNativeWalking('alice');
    emit(snapshot('alice', 35, 10));
    emit({ ...snapshot('alice', 3, 5), tracking: false });
    emit(snapshot('bob', 500, 11));
    emit(snapshot('alice', Number.NaN, 12));
    expect(tracker.useWalking.getState().today.distanceM).toBe(35);
    expect(tracker.useWalkingTracking.getState().background).toBe(true);
  });

  it('refreshes service-only progress when the WebView returns to the foreground', async () => {
    const tracker = await import('../src/core/walking/walkTracker');
    await tracker.startNativeWalking('alice');
    backend = snapshot('alice', 400, 2);
    bridge.app.forEach(callback => callback({ isActive: false }));
    expect(tracker.useWalking.getState().today.distanceM).toBe(0);
    bridge.app.forEach(callback => callback({ isActive: true }));
    await vi.advanceTimersByTimeAsync(0);
    expect(tracker.useWalking.getState().today.distanceM).toBe(400);
  });

  it('shares one in-flight configuration for repeated starts of the same account', async () => {
    const tracker = await import('../src/core/walking/walkTracker');
    const result = deferred<NativeWalkingState>();
    bridge.configure.mockReturnValueOnce(result.promise);
    const first = tracker.startNativeWalking('alice');
    const second = tracker.startNativeWalking('alice');
    expect(second).toBe(first);
    await vi.advanceTimersByTimeAsync(0);
    expect(bridge.configure).toHaveBeenCalledTimes(1);
    result.resolve(snapshot());
    expect(await first).toBe(true);
    expect(bridge.walking.size).toBe(1);
    expect(bridge.app.size).toBe(1);
  });

  it('orders sign-out clearing before a new account while an old configuration is pending', async () => {
    const tracker = await import('../src/core/walking/walkTracker');
    const result = deferred<NativeWalkingState>();
    bridge.configure.mockImplementationOnce(async () => {
      const state = await result.promise; backend = state; return structuredClone(state);
    });
    const alice = tracker.startNativeWalking('alice');
    await vi.advanceTimersByTimeAsync(0);
    const stop = tracker.stopNativeWalking(true);
    const bob = tracker.startNativeWalking('bob');
    result.resolve(snapshot('alice', 250));
    expect(await alice).toBe(false);
    await stop;
    expect(await bob).toBe(true);
    expect(bridge.control).toHaveBeenCalledWith({ command: 'clear', owner: 'alice' });
    expect(backend).toMatchObject({ owner: 'bob', enabled: true, today: { distanceM: 0 } });
    expect(tracker.useWalking.getState()).toMatchObject({ owner: 'bob', today: { distanceM: 0 } });
    expect(tracker.useWalkingTracking.getState().native).toBe(true);
    expect(bridge.walking.size).toBe(1);
  });

  it('invalidates native callbacks immediately on sign-out and removes both listeners', async () => {
    const tracker = await import('../src/core/walking/walkTracker');
    await tracker.startNativeWalking('alice');
    const callbacks = [...bridge.walking];
    await tracker.stopNativeWalking(true);
    callbacks.forEach(callback => callback(snapshot('alice', 900, 10)));
    expect(tracker.useWalking.getState().today.distanceM).toBe(0);
    expect(tracker.useWalkingTracking.getState()).toMatchObject({ native: false, background: false });
    expect(bridge.walking.size).toBe(0); expect(bridge.app.size).toBe(0);
  });

  it('falls back to fresh foreground-only JS anchors after a native bridge failure', async () => {
    const tracker = await import('../src/core/walking/walkTracker');
    bridge.configure.mockRejectedValueOnce(new Error('Native tracker unavailable'));
    expect(await tracker.startNativeWalking('alice')).toBe(false);
    expect(bridge.control).toHaveBeenCalledWith({ command: 'stop', owner: 'alice' });
    tracker.walkFix(fix(0, Date.now())); tracker.walkFix(fix(12, Date.now() + 10_000));
    expect(tracker.useWalking.getState().today.distanceM).toBeGreaterThan(11);
    expect(tracker.useWalkingTracking.getState()).toMatchObject({ native: false, error: 'Native tracker unavailable' });
  });

  it('preserves owner scoping and foreground tracking in web/older APK fallback', async () => {
    bridge.platform = 'web';
    const tracker = await import('../src/core/walking/walkTracker');
    expect(await tracker.startNativeWalking('alice')).toBe(false);
    tracker.walkFix(fix(0, Date.now())); tracker.walkFix(fix(12, Date.now() + 10_000));
    expect(tracker.useWalking.getState()).toMatchObject({ owner: 'alice', source: 'gps' });
    expect(tracker.useWalking.getState().today.distanceM).toBeGreaterThan(11);
    await tracker.startNativeWalking('bob');
    expect(tracker.useWalking.getState()).toMatchObject({ owner: 'bob', today: { distanceM: 0 } });
    expect(bridge.configure).not.toHaveBeenCalled();
  });

  it('accepts a native day rollover and ignores an older response from yesterday', async () => {
    const tracker = await import('../src/core/walking/walkTracker');
    backend = snapshot('alice', 250);
    await tracker.startNativeWalking('alice');
    vi.setSystemTime(new Date(2026, 9, 19, 0, 1));
    const newDay = snapshot('alice', 0, 2); newDay.today.day = '2026-10-19';
    emit(newDay);
    emit(snapshot('alice', 250, 1));
    expect(tracker.useWalking.getState().today).toMatchObject({ day: '2026-10-19', distanceM: 0 });
  });

  it('routes manual pause and resume to the active native owner', async () => {
    const tracker = await import('../src/core/walking/walkTracker');
    await tracker.startNativeWalking('alice');
    tracker.pauseWalk(); await vi.advanceTimersByTimeAsync(0);
    expect(tracker.useWalking.getState().paused).toBe(true);
    tracker.resumeWalk(); await vi.advanceTimersByTimeAsync(0);
    expect(tracker.useWalking.getState().paused).toBe(false);
    expect(bridge.control).toHaveBeenNthCalledWith(1, { command: 'pause', owner: 'alice' });
    expect(bridge.control).toHaveBeenNthCalledWith(2, { command: 'resume', owner: 'alice' });
  });
});
