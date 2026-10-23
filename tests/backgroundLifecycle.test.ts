import { beforeEach, afterEach, describe, expect, it, vi } from 'vitest';

const native = vi.hoisted(() => ({ start: vi.fn(), stop: vi.fn(), remove: vi.fn(), listener: null as null | ((s: { isActive: boolean }) => void) }));
vi.mock('@capacitor/core', () => ({ Capacitor: { isNativePlatform: () => true, getPlatform: () => 'android' }, registerPlugin: () => ({}) }));
vi.mock('@capacitor/app', () => ({ App: { addListener: vi.fn(async (_: string, listener: typeof native.listener) => { native.listener = listener; return { remove: native.remove }; }) } }));
vi.mock('../src/core/native/aissNative', () => ({ AissNative: { startBackgroundService: native.start, stopBackgroundService: native.stop } }));
const { startBackgroundController, stopBackground, useBackground } = await import('../src/core/native/background');
const { useSession, defaultSettings } = await import('../src/core/store/session');
const { useAuth } = await import('../src/core/auth/authStore');
const { useNavView, emptyNav } = await import('../src/core/navigation/navView');
const { useDevice } = await import('../src/core/store/device');
const { useAssistant } = await import('../src/core/store/assistant');
const { useSafety } = await import('../src/core/store/safety');
const flush = async () => { for (let i = 0; i < 15; i++) await Promise.resolve(); };

beforeEach(async () => {
  native.stop.mockResolvedValue({ running: false });
  await stopBackground();
  vi.clearAllMocks();
  native.start.mockResolvedValue({ running: true });
  native.stop.mockResolvedValue({ running: false });
  useSession.setState({ entryRole: 'user', settings: { ...defaultSettings, runInBackground: true } });
  useAuth.setState({ status: 'signedIn', role: 'user' });
  useDevice.setState({ link: 'unpaired' });
  useNavView.setState(emptyNav());
  useAssistant.setState({ phase: 'idle' });
  useSafety.setState({ phase: 'idle' });
});
afterEach(async () => { await stopBackground(); });

describe('background service ownership', () => {
  it('serializes a pending start before sign-out stop and never resurrects through old subscriptions', async () => {
    let release!: () => void;
    native.start.mockImplementationOnce(() => new Promise<void>((resolve) => { release = resolve; }));
    startBackgroundController();
    await flush();
    expect(native.start).toHaveBeenCalledTimes(1);
    const stopped = stopBackground();
    release();
    await stopped;
    expect(native.stop).toHaveBeenCalledTimes(1);
    expect(useBackground.getState().running).toBe(false);
    useSession.setState({ settings: { ...defaultSettings, runInBackground: false } });
    useSession.setState({ settings: { ...defaultSettings, runInBackground: true } });
    native.listener?.({ isActive: true });
    await flush();
    expect(native.start).toHaveBeenCalledTimes(1);
  });

  it('does not start before role verification or for a Guardian account', async () => {
    useAuth.setState({ role: null });
    startBackgroundController();
    await flush();
    expect(native.start).not.toHaveBeenCalled();
    useAuth.setState({ role: 'guardian' });
    await flush();
    expect(native.start).not.toHaveBeenCalled();
    useAuth.setState({ role: 'user' });
    await flush();
    expect(native.start).toHaveBeenCalledTimes(1);
  });

  it('can be started again after teardown with exactly one listener set', async () => {
    startBackgroundController();
    await flush();
    await stopBackground();
    startBackgroundController();
    await flush();
    expect(native.start).toHaveBeenCalledTimes(2);
    expect(native.remove).toHaveBeenCalledTimes(1);
    useSession.setState({ settings: { ...defaultSettings, runInBackground: false } });
    await flush();
    expect(native.stop).toHaveBeenCalledTimes(2);
  });

  it('stops a surviving native service when background is disabled after WebView recreation', async () => {
    useSession.setState({ settings: { ...defaultSettings, runInBackground: false } });
    expect(useBackground.getState().running).toBe(false);
    startBackgroundController();
    await flush();
    expect(native.stop).toHaveBeenCalledOnce();
    expect(native.start).not.toHaveBeenCalled();
  });

  it('releases the permanent CPU lock for activity-only tracking and acquires it for navigation', async () => {
    startBackgroundController();
    await flush();
    expect(native.start.mock.calls.at(-1)?.[0]).toMatchObject({ keepAwake: false });
    useNavView.setState({ active: true });
    await flush();
    expect(native.start.mock.calls.at(-1)?.[0]).toMatchObject({ keepAwake: true });
    useNavView.setState({ active: false });
    await flush();
    expect(native.start.mock.calls.at(-1)?.[0]).toMatchObject({ keepAwake: false });
  });
});
