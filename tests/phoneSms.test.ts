import { describe, test, expect, beforeEach, vi } from 'vitest';

const { native } = vi.hoisted(() => ({
  native: {
    requestPermissions: vi.fn(),
    sendSms: vi.fn(async (_o: unknown) => ({ result: 'composer_opened' })),
    placeCall: vi.fn(),
  },
}));
vi.mock('../src/core/native/aissNative', () => ({ AissNative: native }));

import { sendSms, SOS_SMS_PERMISSION_WAIT_MS } from '../src/core/phone';
import { useRuntime } from '../src/core/runtime/mode';

describe('SMS permission dialog', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    useRuntime.setState({ mode: 'real' });
  });

  test('SOS never waits forever on an unanswered SMS permission dialog: it sends (composer fallback) after a few seconds', async () => {
    native.requestPermissions.mockImplementation(() => new Promise(() => undefined)); // nobody answers
    vi.useFakeTimers();
    const p = sendSms('Dad', '+919876543210', 'Emergency!', { direct: true, permissionWaitMs: SOS_SMS_PERMISSION_WAIT_MS });
    await vi.advanceTimersByTimeAsync(SOS_SMS_PERMISSION_WAIT_MS - 100);
    expect(native.sendSms).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(200);
    vi.useRealTimers();
    expect(await p).toBe('composer_opened');
    expect(native.sendSms).toHaveBeenCalledWith({ number: '+919876543210', body: 'Emergency!', direct: true });
  });

  test('an answered dialog sends at once', async () => {
    native.requestPermissions.mockResolvedValue({ sms: 'granted' });
    native.sendSms.mockResolvedValueOnce({ result: 'sent' });
    expect(await sendSms('Dad', '+919876543210', 'Hi', { direct: true, permissionWaitMs: 5000 })).toBe('sent');
  });
});
