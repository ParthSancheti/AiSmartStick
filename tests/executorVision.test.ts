import { beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('../src/core/vision/relay', () => ({ captureFrame: vi.fn() }));
vi.mock('../src/core/backend/api', () => ({ call: vi.fn() }));

import { executeAction, visionFailureReason } from '../src/core/ai/executor';
import { captureFrame } from '../src/core/vision/relay';
import { call } from '../src/core/backend/api';
import { useDevice, initialDevice } from '../src/core/store/device';
import { useUI } from '../src/core/store/ui';

const act = (name: string, type: string, args: Record<string, unknown> = {}) => ({ id: 'v1', name, type, arguments: args });
const coded = (code: string, message: string) => Object.assign(new Error(message), { code });
const jpeg = () => new Blob([new Uint8Array([0xff, 0xd8, 0xff, 0xe0, 1, 2, 3, 0xff, 0xd9])], { type: 'image/jpeg' });

describe('vision tool failures are clear reasons the assistant can say', () => {
  it('opens the existing camera preview without a cloud call', async () => {
    useUI.setState({ cameraOpen: false, liveAiOpen: true });
    useDevice.setState({ internet: false });
    const result = await executeAction(act('open_camera', 'vision.openCamera'));
    expect(result.ok).toBe(true);
    expect(useUI.getState()).toMatchObject({ cameraOpen: true, liveAiOpen: false });
    expect(call).not.toHaveBeenCalled();
    expect(captureFrame).not.toHaveBeenCalled();
  });
  beforeEach(() => {
    vi.mocked(captureFrame).mockReset();
    vi.mocked(call).mockReset();
    vi.spyOn(console, 'warn').mockImplementation(() => {});
    useDevice.setState({ ...initialDevice(), link: 'connected', internet: true });
  });

  it('maps stick camera problems', () => {
    expect(visionFailureReason(new Error('stick-offline'))).toMatch(/camera is offline/);
    expect(visionFailureReason(new Error('camera: busy'))).toMatch(/busy/);
    expect(visionFailureReason(new Error('HTTP 409'))).toMatch(/busy/);
    expect(visionFailureReason(new Error('camera: unavailable'))).toMatch(/camera did not answer/);
    expect(visionFailureReason(new Error('GET /api/v1/capture timed out after 8.5 s'))).toMatch(/camera did not answer/);
    expect(visionFailureReason(new Error('no path to the stick'))).toMatch(/camera did not answer/);
    // A fetch timeout is a DOMException with a NUMBER code (23): still the camera, not a server code.
    expect(visionFailureReason(new DOMException('signal timed out', 'TimeoutError'))).toMatch(/camera did not answer/);
  });

  it('maps server and App Check problems (with or without the functions/ prefix)', () => {
    expect(visionFailureReason(coded('functions/unauthenticated', 'Unauthenticated'))).toMatch(/App Check/);
    expect(visionFailureReason(coded('unauthenticated', 'Sign in required.'))).toMatch(/not signed in/);
    expect(visionFailureReason(coded('deadline-exceeded', 'The server did not answer in 50 s'))).toMatch(/did not answer in time/);
    expect(visionFailureReason(coded('functions/unavailable', 'unavailable'))).toMatch(/could not reach the server/);
    expect(visionFailureReason(coded('functions/not-found', 'NOT_FOUND'))).toMatch(/not installed on the server/);
    expect(visionFailureReason(coded('functions/resource-exhausted', 'Too many requests.'))).toMatch(/Too many/);
  });

  it('maps Gemini key problems', () => {
    expect(visionFailureReason(coded('functions/failed-precondition', 'Gemini is not configured on the server.'))).toMatch(/Gemini key missing/);
    expect(visionFailureReason(coded('functions/internal', 'API key not valid. Please pass a valid API key.'))).toMatch(/key problem/);
    expect(visionFailureReason(coded('functions/internal', 'INTERNAL'))).toMatch(/server error/);
  });

  it.each([
    ['deadline-exceeded', 'timeout', /AI picture service took too long/],
    ['unavailable', 'upstream', /AI picture service is temporarily unavailable/],
    ['resource-exhausted', 'quota', /AI picture service is busy/],
    ['failed-precondition', 'configuration', /configuration needs attention/],
    ['internal', 'request', /could not process this photo request/],
  ])('keeps model %s separate from phone connectivity or Google sign-in', (code, reason, expected) => {
    const error = Object.assign(coded(`functions/${code}`, 'server message'), { details: { service: 'vision-model', reason } });
    expect(visionFailureReason(error)).toMatch(expected);
    expect(visionFailureReason(error)).not.toMatch(/phone could not reach|Check the internet/);
  });

  it('recognizes the deployed legacy upstream failure message', () => {
    expect(visionFailureReason(coded('functions/unavailable', 'Photo analysis did not finish. Please try again.'))).toMatch(/AI picture service is temporarily unavailable/);
  });

  it('describe_scene returns a tool failure (not a throw) when the camera is busy', async () => {
    vi.mocked(captureFrame).mockRejectedValue(new Error('camera: busy'));
    const r = await executeAction(act('describe_scene', 'vision.describeScene'));
    expect(r.ok).toBe(false);
    expect(r.error).toMatch(/busy/);
    expect(call).not.toHaveBeenCalled();
  });

  it('describe_scene says App Check refused when the server answers unauthenticated', async () => {
    vi.mocked(captureFrame).mockResolvedValue({ blob: jpeg(), ts: Date.now(), scene: -1, origin: 'assistant' });
    vi.mocked(call).mockRejectedValue(coded('functions/unauthenticated', 'Unauthenticated'));
    const r = await executeAction(act('describe_scene', 'vision.describeScene'));
    expect(r.ok).toBe(false);
    expect(r.error).toMatch(/App Check/);
    expect(vi.mocked(call).mock.calls[0][0]).toBe('assistantVision');
  });

  it('describe_scene still succeeds normally', async () => {
    vi.mocked(captureFrame).mockResolvedValue({ blob: jpeg(), ts: Date.now(), scene: -1, origin: 'assistant' });
    vi.mocked(call).mockResolvedValue({ spoken: 'A door ahead.', uncertain: false, hazards: [], imageQuality: 'good' });
    const r = await executeAction(act('describe_scene', 'vision.describeScene'));
    expect(r.ok).toBe(true);
    expect(String((r.data as { spoken: string }).spoken)).toMatch(/^A door ahead\./);
  });

  it('unknown connectivity does not deny camera access before trying the backend', async () => {
    useDevice.setState({ internet: null });
    vi.mocked(captureFrame).mockResolvedValue({ blob: jpeg(), ts: Date.now(), scene: -1, origin: 'assistant' });
    vi.mocked(call).mockResolvedValue({ spoken: 'A chair on the left.', uncertain: true, hazards: [], imageQuality: 'good' });
    const result = await executeAction(act('describe_scene', 'vision.describeScene'));
    expect(result.ok).toBe(true);
    expect(call).toHaveBeenCalledWith('assistantVision', expect.objectContaining({ task: 'describe_scene', imageBase64: expect.any(String) }), 40000);
    expect(result.data).toMatchObject({ spoken: expect.stringContaining('chair on the left'), uncertain: true });
  });

  it('capture_scene reports an offline camera as a tool failure', async () => {
    vi.mocked(captureFrame).mockRejectedValue(new Error('stick-offline'));
    const r = await executeAction(act('capture_scene', 'vision.captureScene'));
    expect(r.ok).toBe(false);
    expect(r.error).toMatch(/camera is offline/);
  });
});
