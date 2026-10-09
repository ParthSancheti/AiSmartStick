import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const callable = vi.hoisted(() => ({ fn: vi.fn(), opts: [] as unknown[] }));
vi.mock('firebase/functions', () => ({
  httpsCallable: (_f: unknown, _name: string, opts: unknown) => {
    callable.opts.push(opts);
    return callable.fn;
  },
}));
vi.mock('../src/core/firebase/app', () => ({ fb: () => ({ functions: {} }) }));

import { BackendError, call, OUTER_EXTRA_MS } from '../src/core/backend/api';

describe('call(): one log line per call, codes passed through, never hangs', () => {
  let info: ReturnType<typeof vi.spyOn>;
  let warn: ReturnType<typeof vi.spyOn>;
  beforeEach(() => {
    callable.fn.mockReset();
    callable.opts.length = 0;
    info = vi.spyOn(console, 'info').mockImplementation(() => {});
    warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
  });
  afterEach(() => {
    vi.useRealTimers();
    vi.restoreAllMocks();
  });

  it('returns the data and logs "[SERVER] <name> ok <ms>ms" without the payload', async () => {
    callable.fn.mockResolvedValue({ data: { places: [1, 2] } });
    const r = await call<{ query: string }, { places: number[] }>('mapsSearch', { query: 'SECRET-PLACE' }, 15000);
    expect(r).toEqual({ places: [1, 2] });
    expect(callable.opts[0]).toEqual({ timeout: 15000 });
    expect(info).toHaveBeenCalledTimes(1);
    const line = String(info.mock.calls[0][0]);
    expect(line).toMatch(/^\[SERVER\] mapsSearch ok \d+ms$/);
    expect(line).not.toMatch(/SECRET/);
  });

  it('keeps the Firebase error code and message (BackendError) and logs the code', async () => {
    callable.fn.mockRejectedValue(Object.assign(new Error('Unauthenticated'), { code: 'functions/unauthenticated' }));
    const e = await call('assistantVision', { imageBase64: 'AAAA' }).catch((x) => x);
    expect(e).toBeInstanceOf(BackendError);
    expect(e.code).toBe('functions/unauthenticated');
    expect(e.message).toBe('Unauthenticated');
    expect(String(warn.mock.calls[0][0])).toMatch(/^\[SERVER\] assistantVision functions\/unauthenticated \d+ms$/);
    expect(String(warn.mock.calls[0][0])).not.toMatch(/AAAA/);
  });

  it('an error without a code becomes code "unknown"', async () => {
    callable.fn.mockRejectedValue(new Error('boom'));
    await expect(call('x', {})).rejects.toMatchObject({ code: 'unknown', message: 'boom' });
  });

  it('a call stuck before the SDK timeout starts (App Check, sign-in token) fails after timeout + 10 s', async () => {
    vi.useFakeTimers();
    callable.fn.mockImplementation(() => new Promise(() => {}));
    const caught = call('getLiveToken', {}, 15000).catch((x) => x);
    await vi.advanceTimersByTimeAsync(15000 + OUTER_EXTRA_MS - 50);
    let settled = false;
    void caught.then(() => (settled = true));
    await Promise.resolve();
    expect(settled).toBe(false);
    await vi.advanceTimersByTimeAsync(100);
    const e = await caught;
    expect(e).toBeInstanceOf(BackendError);
    expect(e.code).toBe('deadline-exceeded');
    expect(e.message).toBe('The server did not answer in 25 s (slow first start, App Check, or functions not deployed).');
    expect(String(warn.mock.calls[0][0])).toMatch(/^\[SERVER\] getLiveToken deadline-exceeded \d+ms$/);
    expect(vi.getTimerCount()).toBe(0);
  });
});
