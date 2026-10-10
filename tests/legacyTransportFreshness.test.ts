import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { LegacyTransport } from '../src/core/transport/legacyTransport';
import { configurePipeline, ingestPacket, resetPipeline } from '../src/core/telemetry/pipeline';
import { initialDevice, useDevice } from '../src/core/store/device';
import { getCurrentSensorContext } from '../src/core/vision/sensorConditioning';
import type { PacketTiming } from '../src/core/transport/types';

const transports: LegacyTransport[] = [];
beforeEach(() => {
  vi.useFakeTimers({ toFake: ['Date', 'setTimeout', 'clearTimeout', 'setInterval', 'clearInterval', 'performance'] });
  vi.setSystemTime(10000);
  resetPipeline(); configurePipeline({ onButton: () => {}, onFall: () => {} });
  useDevice.setState({ ...initialDevice(), link: 'connected' });
});
afterEach(() => {
  transports.splice(0).forEach(t => t.disconnect());
  vi.clearAllTimers(); vi.useRealTimers(); vi.unstubAllGlobals();
});

describe('unverified legacy transport freshness', () => {
  it('propagates full request/body delay without pretending synthetic uptime proves sample identity', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue({ json: async () => {
      await new Promise<void>(resolve => setTimeout(resolve, 1600));
      return { distance_cm: 250, pitch: 0, roll: 0 };
    } }));
    const transport = new LegacyTransport('192.168.4.1'); transports.push(transport);
    let timing: PacketTiming | undefined;
    transport.on('packet', (packet, at, metadata) => {
      timing = metadata;
      ingestPacket(packet, at, metadata);
    });
    const connected = transport.connect();
    await vi.advanceTimersByTimeAsync(1600);
    expect(timing).toEqual({ requestStartedAt: 10000, roundTripMs: 1600 });
    const context = getCurrentSensorContext();
    expect(context.ultrasonic).toMatchObject({ state: 'stale', ageMs: 1600 });
    expect(context.motion).toBe('UNKNOWN'); // Missing raw MPU vectors remain untrusted.
    expect(context.ultrasonicApproach?.timeToWarningMs).toBeNull();
    expect(useDevice.getState().lastPacketAt).toBe(11600);
    transport.disconnect(); await vi.advanceTimersByTimeAsync(300); await connected;
  });

  it('does not publish a response whose JSON completes after disconnect', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue({ json: async () => {
      await new Promise<void>(resolve => setTimeout(resolve, 200));
      return { distance_cm: 20, pitch: 0, roll: 0 };
    } }));
    const transport = new LegacyTransport('192.168.4.1'); transports.push(transport);
    const packet = vi.fn(); transport.on('packet', packet);
    const connected = transport.connect();
    await vi.advanceTimersByTimeAsync(100); transport.disconnect();
    await vi.advanceTimersByTimeAsync(100); await connected;
    expect(packet).not.toHaveBeenCalled();
  });
});
