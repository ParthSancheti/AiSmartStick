import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('../src/core/vision/relay', () => ({ captureFrame: vi.fn() }));
vi.mock('../src/core/backend/api', () => ({ call: vi.fn() }));

import type { SensorContext } from '../shared/assistantContract';
import { fuseScene, measuredSuffix, sensorContext } from '../src/core/vision/fusion';
import { runVision } from '../src/core/ai/executor';
import { captureFrame } from '../src/core/vision/relay';
import { call } from '../src/core/backend/api';
import { initialDevice, useDevice } from '../src/core/store/device';
import { useSession } from '../src/core/store/session';

const AT = 10_000;
const sensors: SensorContext = {
  forwardDistanceCm: 118, ultrasonicStatus: 'ok', zone: 'warning',
  pitchDeg: 0, rollDeg: 0, headingDeg: null, speedMps: null, measuredAt: AT,
};
const hazards = [
  { type: 'person', position: 'center', distance: 'near', confidence: 'high' },
  { type: 'chair', position: 'center', distance: 'near', confidence: 'high' },
] as const;

beforeEach(() => {
  vi.useFakeTimers();
  vi.setSystemTime(AT);
  vi.mocked(call).mockReset();
  vi.mocked(captureFrame).mockReset();
  useDevice.setState({ ...initialDevice(), link: 'connected', internet: true,
    ultrasonic: { ...initialDevice().ultrasonic, distanceCm: 118, status: 'ok', measuredAt: AT },
  });
  useSession.setState({ settings: { ...useSession.getState().settings, replyLang: 'en' } });
});
afterEach(() => vi.useRealTimers());

describe('independent image and ultrasonic evidence', () => {
  it('does not assign one front reflection to either of two center camera objects', () => {
    const fused = fuseScene({ hazards: [...hazards] }, sensors, AT, AT - 100);
    expect(fused.objects.filter(object => object.source.includes('vision')))
      .toEqual(expect.arrayContaining([
        expect.objectContaining({ label: 'person', radarDistanceCm: null, source: ['vision'], timestamp: AT - 100 }),
        expect.objectContaining({ label: 'chair', radarDistanceCm: null, source: ['vision'], timestamp: AT - 100 }),
      ]));
    const sonar = fused.objects.filter(object => object.source.includes('ultrasonic'));
    expect(sonar).toEqual([expect.objectContaining({ label: 'unidentified obstacle', radarDistanceCm: 118, timestamp: AT })]);
    expect(measuredSuffix(fused, AT)).toMatch(/separate stick reading was.*identity is uncertain/);
  });

  it.each([
    ['expired', { measuredAt: AT - 1000 }],
    ['future', { measuredAt: AT + 1 }],
    ['no echo', { ultrasonicStatus: 'no_echo' }],
    ['invalid range', { forwardDistanceCm: NaN }],
    ['beyond sensor range', { forwardDistanceCm: 14_000 }],
    ['missing range', { forwardDistanceCm: null }],
  ])('does not add a measured object for %s evidence', (_name, override) => {
    const fused = fuseScene({ hazards: [...hazards] }, { ...sensors, ...override }, AT);
    expect(fused.objects).toHaveLength(2);
    expect(fused.objects.every(object => object.radarDistanceCm === null)).toBe(true);
    expect(measuredSuffix(fused, AT)).toBe('');
  });

  it('rechecks sonar freshness when a previously fused scene is spoken later', () => {
    const fused = fuseScene({ hazards: [] }, sensors, AT);
    expect(measuredSuffix(fused, AT + 999)).not.toBe('');
    expect(measuredSuffix(fused, AT + 1000)).toBe('');
    expect(measuredSuffix(fused, AT - 1)).toBe('');
  });

  it('does not use a disconnected, future or expired device sample', () => {
    expect(sensorContext().forwardDistanceCm).toBe(118);
    expect(sensorContext().measuredAt).toBe(AT);
    useDevice.setState({ link: 'disconnected' });
    expect(sensorContext().forwardDistanceCm).toBeNull();
    useDevice.setState({ link: 'connected' });
    expect(sensorContext(AT - 1).forwardDistanceCm).toBeNull();
    expect(sensorContext(AT + 1000).forwardDistanceCm).toBeNull();
    expect(sensorContext(AT + 1000).zone).toBe('unknown');
  });
});

describe('explicit cloud scene request timing', () => {
  const frame = () => ({ blob: new Blob([new Uint8Array([0xff, 0xd8, 0xff, 0xe0, 1, 2, 3, 0xff, 0xd9])], { type: 'image/jpeg' }), ts: AT, scene: -1, origin: 'assistant' as const });
  const result = () => ({ spoken: 'A person is visible on the left.', hazards: [], uncertain: false, imageQuality: 'good' as const });

  it('labels an earlier photo and omits its expired captured sonar after a slow response', async () => {
    vi.mocked(captureFrame).mockResolvedValue(frame());
    vi.mocked(call).mockImplementation(async () => {
      vi.setSystemTime(AT + 40_000);
      return result();
    });
    const response = await runVision('describe_scene');
    expect(response.spoken).toMatch(/^In the earlier photo:/);
    expect(response.spoken).toContain('current scene may have changed');
    expect(response.spoken).not.toMatch(/1\.2 meters/);
    expect(response.uncertain).toBe(true);
    expect(response.fused?.timestamp).toBe(AT);
    expect(response.fused?.objects).toHaveLength(0);
    expect(call).toHaveBeenCalledTimes(1);
  });

  it('preserves an immediate scene description with a separately attributed captured reading', async () => {
    vi.mocked(captureFrame).mockResolvedValue(frame());
    vi.mocked(call).mockResolvedValue(result());
    const response = await runVision('describe_scene');
    expect(response.spoken).toMatch(/^A person is visible on the left\./);
    expect(response.spoken).toContain('separate stick reading was');
    expect(response.spoken).not.toMatch(/measures it/);
    expect(response.uncertain).toBe(false);
  });
});
