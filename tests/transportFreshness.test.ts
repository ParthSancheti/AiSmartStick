import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { TelemetryPacket } from '../shared/deviceProtocol';
import type { PacketTiming } from '../src/core/transport/types';

const h = vi.hoisted(() => ({ delayMs: 1600, request: vi.fn() }));
vi.mock('../src/core/transport/stickHttp', () => ({
  isNativeApp: () => false, stickRequest: h.request, stickBinary: vi.fn(), stickLog: vi.fn(),
  withTimeout: (p: Promise<unknown>) => p,
  useStickRoute: { getState: () => ({ results: {}, preferred: null }) },
}));

import { HttpTransport } from '../src/core/transport/httpTransport';
import { initialDevice, useDevice } from '../src/core/store/device';
import { configurePipeline, ingestPacket, resetPipeline } from '../src/core/telemetry/pipeline';
import { getCurrentSensorContext } from '../src/core/vision/sensorConditioning';

const transports: HttpTransport[] = [];
beforeEach(() => {
  vi.useFakeTimers({ toFake: ['Date', 'setTimeout', 'clearTimeout', 'setInterval', 'clearInterval', 'performance'] });
  vi.setSystemTime(10000);
  useDevice.setState({ ...initialDevice(), link: 'connected' });
  resetPipeline(); configurePipeline({ onButton: () => {}, onFall: () => {} });
  h.delayMs = 1600;
  h.request.mockReset().mockImplementation(async (_method: string, path: string) => {
    if (path.endsWith('/device')) return { status: 200, text: JSON.stringify({
      deviceId: 'AISS-TIME', model: 'AISS-ESP32CAM-1', firmware: '1.2.0', protocolVersion: 1, paired: false, auth: false, uptimeMs: 1000,
    }) };
    const packet: TelemetryPacket = {
      v: 1, deviceId: 'AISS-TIME', seq: 1, uptimeMs: 1000,
      battery: { busV: 4, shuntMv: 1, currentMa: 100, charging: false, chargeSource: 'current', ok: true },
      imu: { ax: 0, ay: 0, az: 1, gx: 0, gy: 0, gz: 0, pitch: 0, roll: 0, ok: true },
      ultrasonic: { distanceCm: 250, echoUs: 14500, status: 'ok', sampleAgeMs: 40, zone: 'normal' },
      button: [], rssi: -50, health: { camera: 'ok', i2c: 'ok', motor: 'idle' },
    };
    // The snapshot is prepared before the response is delayed, as a buffered real reply can be.
    await new Promise<void>(resolve => setTimeout(resolve, h.delayMs));
    return { status: 200, text: JSON.stringify(packet) };
  });
});
afterEach(() => {
  transports.splice(0).forEach(t => t.disconnect());
  vi.clearAllTimers(); vi.useRealTimers();
});

describe('actual HTTP transport telemetry timing propagation', () => {
  it.each([1600, 250])('charges the %s ms delayed response to sensor age without changing wire timestamps', async (delayMs) => {
    h.delayMs = delayMs;
    const transport = new HttpTransport({ deviceId: 'AISS-TIME', model: 'AISS-ESP32CAM-1', firmware: '1.2.0', protocolVersion: 1, host: '192.168.4.1' }, 500);
    transports.push(transport);
    const events: { receivedAt: number; timing?: PacketTiming; packet: TelemetryPacket }[] = [];
    transport.on('packet', (packet, receivedAt, timing) => {
      events.push({ packet, receivedAt, timing });
      ingestPacket(packet, receivedAt, timing);
    });
    await transport.connect();
    await vi.advanceTimersByTimeAsync(delayMs);
    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({ receivedAt: 10000 + delayMs,
      timing: { requestStartedAt: 10000, roundTripMs: delayMs },
      packet: { uptimeMs: 1000, ultrasonic: { sampleAgeMs: 40 } },
    });
    const context = getCurrentSensorContext();
    expect(context.ultrasonic.ageMs).toBe(delayMs + 40);
    expect(context.gyro.ageMs).toBe(delayMs);
    expect(context.ultrasonic.state).toBe(delayMs > 1500 ? 'stale' : 'valid');
    expect(useDevice.getState().lastPacketAt).toBe(10000 + delayMs);
    expect(transport.getStats().lastPacketAt).toBe(10000 + delayMs);
    transport.disconnect();
  });
});
