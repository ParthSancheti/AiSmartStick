import { describe, expect, it } from 'vitest';
import { cameraChip, cameraEmptyText, describeErrorText, fpsText, frameStale, streamInfoLine, STALE_MS } from '../src/components/liveCameraText';

const NOW = 1_000_000;
const base = { status: 'off' as const, fps: 0, source: null, error: null, frameAt: null, frameUrl: null };

describe('camera view texts', () => {
  it('formats the frame rate', () => {
    expect(fpsText(0)).toBe('');
    expect(fpsText(Number.NaN)).toBe('');
    expect(fpsText(0.54)).toBe('0.5 fps');
    expect(fpsText(6.4)).toBe('6 fps');
    expect(fpsText(7.6)).toBe('8 fps');
  });

  it('marks a frame stale only after STALE_MS without a new one', () => {
    expect(frameStale({ frameUrl: null, frameAt: null }, NOW)).toBe(false);
    expect(frameStale({ frameUrl: 'blob:1', frameAt: NOW - STALE_MS }, NOW)).toBe(false);
    expect(frameStale({ frameUrl: 'blob:1', frameAt: NOW - STALE_MS - 1 }, NOW)).toBe(true);
  });

  it('chip: live video, snapshots, connecting, errors, stale', () => {
    const live = { ...base, status: 'live' as const, fps: 6.2, source: 'stream' as const, frameUrl: 'blob:1', frameAt: NOW - 100 };
    expect(cameraChip(live, true, NOW)).toEqual({ text: 'Live · 6 fps', tone: 'live' });
    expect(cameraChip({ ...live, source: 'snapshots', fps: 2.1 }, true, NOW)).toEqual({ text: 'Snapshots · 2 fps', tone: 'live' });
    expect(cameraChip({ ...live, fps: 0 }, true, NOW).text).toBe('Live');
    expect(cameraChip({ ...base, status: 'connecting' }, true, NOW)).toEqual({ text: 'Connecting to camera…', tone: 'wait' });
    expect(cameraChip({ ...live, frameAt: NOW - 5000 }, true, NOW)).toEqual({ text: 'No new frames', tone: 'warn' });
    expect(cameraChip({ ...live, status: 'stalled' }, true, NOW).text).toBe('No new frames');
    expect(cameraChip({ ...live, status: 'error', error: 'Camera stream busy.' }, true, NOW)).toEqual({ text: 'Camera stream busy.', tone: 'warn' });
    expect(cameraChip({ ...live, status: 'error' }, true, NOW).text).toBe('Camera not working');
    expect(cameraChip(base, true, NOW)).toEqual({ text: 'Camera off', tone: 'off' });
  });

  it('never claims a live picture while the stick is not linked', () => {
    const live = { ...base, status: 'live' as const, fps: 6, source: 'stream' as const, frameUrl: 'blob:1', frameAt: NOW };
    expect(cameraChip(live, false, NOW).text).toBe('Stick not connected');
    expect(cameraEmptyText(live, false)).toBe('Connect the stick to see the camera');
    expect(streamInfoLine({ ...live, width: 320, height: 240, hasFrame: true }, false)).toBe('Stick not connected');
  });

  it('empty picture message', () => {
    expect(cameraEmptyText({ status: 'connecting', error: null }, true)).toBe('Connecting to camera…');
    expect(cameraEmptyText({ status: 'error', error: 'No camera frames from the stick.' }, true)).toBe('No camera frames from the stick.');
    expect(cameraEmptyText({ status: 'stalled', error: null }, true)).toBe('Waiting for the camera…');
    expect(cameraEmptyText({ status: 'off', error: null }, true)).toBe('Camera off');
  });

  it('info line: source, rate and size', () => {
    const s = { status: 'live' as const, source: 'stream' as const, fps: 5.8, width: 320, height: 240, hasFrame: true };
    expect(streamInfoLine(s, true)).toBe('Live video · 6 fps · 320×240');
    expect(streamInfoLine({ ...s, source: 'snapshots', fps: 2, width: null, height: null }, true)).toBe('Snapshots (one photo at a time) · 2 fps');
    expect(streamInfoLine({ ...s, hasFrame: false, status: 'connecting' }, true)).toBe('Connecting to camera…');
    expect(streamInfoLine({ ...s, hasFrame: false, status: 'off' }, true)).toBe('No picture yet');
  });

  it('turns describe failures into simple words', () => {
    const be = (code: string, message: string) => Object.assign(new Error(message), { code });
    expect(describeErrorText(new Error('stick-offline'))).toMatch(/not connected/);
    expect(describeErrorText(new Error('camera: busy'))).toMatch(/camera did not answer/);
    expect(describeErrorText(new Error('GET /api/v1/capture timed out after 8.5 s'))).toMatch(/camera did not answer/);
    expect(describeErrorText(new Error('no path to the stick'))).toMatch(/camera did not answer/);
    expect(describeErrorText(new Error('describe-timeout'))).toMatch(/took too long/);
    expect(describeErrorText(be('functions/deadline-exceeded', 'deadline-exceeded'))).toMatch(/took too long/);
    expect(describeErrorText(be('functions/unavailable', 'unavailable'))).toMatch(/Could not reach the server/);
    expect(describeErrorText(be('functions/unauthenticated', 'Sign in required.'))).toBe('Please sign in again.');
    expect(describeErrorText(be('functions/unauthenticated', 'Unauthenticated'))).toMatch(/did not accept this app/);
    expect(describeErrorText(be('functions/failed-precondition', 'Gemini not configured'))).toMatch(/not set up/);
    expect(describeErrorText(be('functions/resource-exhausted', 'quota'))).toMatch(/Too many requests/);
    expect(describeErrorText('weird')).toBe('Could not describe the picture. Try again.');
  });
});
