import { beforeEach, describe, expect, it, vi } from 'vitest';

const push = vi.hoisted(() => ({
  permission: vi.fn(), token: vi.fn(), channel: vi.fn(), remove: vi.fn(), listener: vi.fn(),
  save: vi.fn(), toast: vi.fn(), ui: vi.fn(), callbacks: new Map<string, (event: any) => void>(),
}));
vi.mock('@capacitor/core', () => ({ Capacitor: { isNativePlatform: () => true } }));
vi.mock('@capacitor-firebase/messaging', () => ({
  Importance: { Max: 5, High: 4 },
  FirebaseMessaging: {
    requestPermissions: push.permission, getToken: push.token, createChannel: push.channel,
    removeAllListeners: push.remove, addListener: push.listener,
  },
}));
vi.mock('firebase/messaging', () => ({ getMessaging: vi.fn(), getToken: vi.fn(), isSupported: vi.fn(), onMessage: vi.fn() }));
vi.mock('firebase/firestore', () => ({ doc: (_db: unknown, path: string, token: string) => ({ path, token }), setDoc: push.save }));
vi.mock('../src/core/firebase/app', () => ({ fb: () => ({ db: {} }) }));
vi.mock('../src/core/runtime/env', () => ({ ENV: {} }));
vi.mock('../src/core/store/ui', () => ({ toastGuardian: push.toast, useUI: { setState: push.ui } }));

import { registerPush } from '../src/core/native/notifications';

describe('push registration account lifecycle', () => {
  beforeEach(() => {
    vi.clearAllMocks(); push.callbacks.clear();
    push.permission.mockResolvedValue({ receive: 'granted' });
    push.token.mockResolvedValue({ token: 'this-phone-token' });
    push.channel.mockResolvedValue(undefined); push.remove.mockResolvedValue(undefined); push.save.mockResolvedValue(undefined);
    push.listener.mockImplementation(async (event: string, callback: (event: any) => void) => {
      push.callbacks.set(event, callback); return { remove: async () => undefined };
    });
  });

  it('does not request permission for an invalidated account', async () => {
    expect(await registerPush('old-user', 'user', () => false)).toBe('cancelled');
    expect(push.permission).not.toHaveBeenCalled();
  });

  it('does not get or save a token after sign-out during a permission dialog', async () => {
    let current = true;
    let answer!: (value: { receive: string }) => void;
    push.permission.mockImplementationOnce(() => new Promise(resolve => { answer = resolve; }));
    const registration = registerPush('old-user', 'user', () => current);
    current = false; answer({ receive: 'granted' });
    expect(await registration).toBe('cancelled');
    expect(push.channel).not.toHaveBeenCalled(); expect(push.token).not.toHaveBeenCalled(); expect(push.save).not.toHaveBeenCalled();
  });

  it('does not associate a late FCM token with the previous account', async () => {
    let current = true;
    let answer!: (value: { token: string }) => void;
    push.token.mockImplementationOnce(() => new Promise(resolve => { answer = resolve; }));
    const registration = registerPush('old-user', 'guardian', () => current);
    await vi.waitFor(() => expect(push.token).toHaveBeenCalled());
    current = false; answer({ token: 'late-token' });
    expect(await registration).toBe('cancelled');
    expect(push.save).not.toHaveBeenCalled(); expect(push.remove).not.toHaveBeenCalled(); expect(push.listener).not.toHaveBeenCalled();
  });

  it('does not replace current account listeners after a previous account write completes late', async () => {
    let current = true;
    let complete!: () => void;
    push.save.mockImplementationOnce(() => new Promise<void>(resolve => { complete = resolve; }));
    const registration = registerPush('old-user', 'guardian', () => current);
    await vi.waitFor(() => expect(push.save).toHaveBeenCalled());
    current = false; complete();
    expect(await registration).toBe('cancelled');
    expect(push.remove).not.toHaveBeenCalled(); expect(push.listener).not.toHaveBeenCalled();
  });

  it('ignores old guardian notification callbacks after the account changes', async () => {
    let current = true;
    expect(await registerPush('guardian', 'guardian', () => current)).toBe('registered');
    expect(push.save).toHaveBeenCalledWith(expect.objectContaining({ token: 'this-phone-token' }), expect.objectContaining({ role: 'guardian' }), { merge: true });
    current = false;
    push.callbacks.get('notificationActionPerformed')?.({ notification: { data: { kind: 'snapshot' } } });
    push.callbacks.get('notificationReceived')?.({ notification: { title: 'Old account alert' } });
    expect(push.ui).not.toHaveBeenCalled(); expect(push.toast).not.toHaveBeenCalled();
  });
});
