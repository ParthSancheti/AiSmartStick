import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

// Android build: the native App Check plugin is mocked (no Play Integrity in tests).
vi.mock('@capacitor/core', () => ({ Capacitor: { isNativePlatform: () => true, getPlatform: () => 'android', isPluginAvailable: () => true } }));
const plugin = vi.hoisted(() => ({ initialize: vi.fn(), getToken: vi.fn() }));
vi.mock('@capacitor-firebase/app-check', () => ({ FirebaseAppCheck: plugin }));

import { APP_CHECK_TIMEOUT_MS, nativeAppCheckToken, startNativeAppCheck, __resetAppCheckForTests } from '../src/core/firebase/app';
import { useAppCheckStatus, withAppCheckTimeout } from '../src/core/firebase/appCheckStatus';

const never = () => new Promise<never>(() => {});

describe('App Check never hangs a server call', () => {
  beforeEach(() => {
    vi.useFakeTimers();
    __resetAppCheckForTests();
    plugin.initialize.mockReset();
    plugin.getToken.mockReset();
    useAppCheckStatus.setState({ provider: 'play-integrity', initError: null, lastOkAt: null, lastError: null, lastMs: null });
    vi.spyOn(console, 'warn').mockImplementation(() => {});
    vi.spyOn(console, 'error').mockImplementation(() => {});
  });
  afterEach(() => {
    vi.useRealTimers();
    vi.restoreAllMocks();
  });

  it('a token request that never answers fails with clear words after 8 s', async () => {
    plugin.initialize.mockResolvedValue(undefined);
    plugin.getToken.mockImplementation(never);
    const p = nativeAppCheckToken();
    const caught = p.catch((e: Error) => e);
    await vi.advanceTimersByTimeAsync(APP_CHECK_TIMEOUT_MS - 100);
    expect(useAppCheckStatus.getState().lastError).toBeNull(); // still waiting
    await vi.advanceTimersByTimeAsync(200);
    const e = await caught;
    expect(e).toBeInstanceOf(Error);
    expect((e as Error).message).toMatch(/App Check \(Play Integrity\) did not answer in 8 s/);
    const st = useAppCheckStatus.getState();
    expect(st.lastError).toMatch(/did not answer/);
    expect(st.lastOkAt).toBeNull();
    expect(st.lastMs).toBeGreaterThanOrEqual(APP_CHECK_TIMEOUT_MS);
  });

  it('a native start that never finishes is also cut at 8 s and recorded', async () => {
    plugin.initialize.mockImplementation(never);
    plugin.getToken.mockImplementation(never);
    const caught = nativeAppCheckToken().catch((e: Error) => e);
    await vi.advanceTimersByTimeAsync(APP_CHECK_TIMEOUT_MS + 10);
    expect(((await caught) as Error).message).toMatch(/did not answer in 8 s/);
    expect(useAppCheckStatus.getState().initError).toMatch(/did not start in 8 s/);
    // The start is not retried per call: the same (finished) start promise is reused.
    await startNativeAppCheck();
    expect(plugin.initialize).toHaveBeenCalledTimes(1);
  });

  it('after a failure, the next calls fail at once instead of waiting 8 s each', async () => {
    plugin.initialize.mockResolvedValue(undefined);
    plugin.getToken.mockRejectedValue(new Error('Integrity API error (-1): API not available'));
    await expect(nativeAppCheckToken()).rejects.toThrow(/App Check \(Play Integrity\) failed: Integrity API error/);
    plugin.getToken.mockClear();
    await expect(nativeAppCheckToken()).rejects.toThrow(/Integrity API error/);
    expect(plugin.getToken).not.toHaveBeenCalled();
    // After the pause it asks the plugin again.
    await vi.advanceTimersByTimeAsync(16_000);
    plugin.getToken.mockResolvedValue({ token: 'a.b.c', expireTimeMillis: 123 });
    await expect(nativeAppCheckToken()).resolves.toEqual({ token: 'a.b.c', expireTimeMillis: 123 });
    expect(plugin.getToken).toHaveBeenCalledTimes(1);
  });

  it('a good token is returned and recorded', async () => {
    plugin.initialize.mockResolvedValue(undefined);
    plugin.getToken.mockResolvedValue({ token: 'h.p.s' });
    const r = await nativeAppCheckToken();
    expect(r.token).toBe('h.p.s');
    expect(r.expireTimeMillis).toBeGreaterThan(Date.now());
    const st = useAppCheckStatus.getState();
    expect(st.lastOkAt).not.toBeNull();
    expect(st.lastError).toBeNull();
  });

  it('an empty token counts as a failure', async () => {
    plugin.initialize.mockResolvedValue(undefined);
    plugin.getToken.mockResolvedValue({ token: '' });
    await expect(nativeAppCheckToken()).rejects.toThrow(/empty token/);
  });

  it('withAppCheckTimeout clears its timer when the promise wins', async () => {
    await expect(withAppCheckTimeout(Promise.resolve(5), 1000, 'late')).resolves.toBe(5);
    expect(vi.getTimerCount()).toBe(0);
  });
});
