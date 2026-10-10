import { beforeEach, describe, expect, it } from 'vitest';
import type { TelemetryPacket } from '../shared/deviceProtocol';
import { configurePipeline, explainPacket, ingestPacket, resetPipeline, validatePacket } from '../src/core/telemetry/pipeline';
import { useDevice, initialDevice } from '../src/core/store/device';
import type { ButtonPattern } from '../src/core/types';

const pkt = (seq: number, uptimeMs: number, extra: Partial<TelemetryPacket> = {}): TelemetryPacket => ({
  v: 1,
  deviceId: 'AISS-TEST01',
  seq,
  uptimeMs,
  battery: { busV: 3.9, shuntMv: 17, currentMa: 170, charging: null, chargeSource: 'current', ok: true },
  imu: { ax: null, ay: null, az: null, gx: null, gy: null, gz: null, pitch: 3, roll: 0, ok: true },
  ultrasonic: { distanceCm: 120, echoUs: 6960, status: 'ok', sampleAgeMs: 20 },
  button: [],
  rssi: -50,
  health: { camera: 'ok', i2c: 'ok', motor: 'idle' },
  ...extra,
});

describe('telemetry pipeline', () => {
  const buttons: ButtonPattern[] = [];
  let falls = 0;
  const rejected: string[] = [];
  beforeEach(() => {
    resetPipeline();
    useDevice.setState({ ...initialDevice(), identity: { deviceId: 'AISS-TEST01', model: 'm', firmware: 'f', protocolVersion: 1 } });
    buttons.length = 0;
    falls = 0;
    rejected.length = 0;
    configurePipeline({ onButton: (b) => buttons.push(b), onFall: () => falls++, onRejected: (r) => void (r && rejected.push(r)) });
  });

  it('validates packet shape', () => {
    expect(validatePacket(pkt(1, 1000))).toBe(true);
    expect(validatePacket({ ...pkt(1, 1000), v: 2 })).toBe(false);
    expect(validatePacket({ ...pkt(1, 1000), button: null })).toBe(false);
  });

  it('says WHICH field made a packet invalid', () => {
    expect(explainPacket(pkt(1, 1000))).toBeNull();
    expect(explainPacket({ ...pkt(1, 1000), v: 2 })).toMatch(/^v = 2/);
    expect(explainPacket({ ...pkt(1, 1000), deviceId: 'x' })).toMatch(/deviceId/);
    expect(explainPacket(pkt(1, 1000, { ultrasonic: { distanceCm: 120, echoUs: 1, status: 'stale' as never, sampleAgeMs: 1 } }))).toMatch(/ultrasonic\.status = "stale"/);
    expect(explainPacket(pkt(1, 1000, { battery: { busV: 99, shuntMv: 0, currentMa: 0, charging: null, chargeSource: 'current', ok: true } }))).toMatch(/battery\.busV = 99/);
    expect(explainPacket(pkt(1, 1000, { imu: { ax: null, ay: null, az: null, gx: null, gy: null, gz: null, pitch: 400, roll: 0, ok: true } }))).toMatch(/imu\.pitch/);
    expect(explainPacket({ ...pkt(1, 1000), button: [{ id: 1.5, kind: 'press', atMs: 1 }] })).toMatch(/button\[0\]/);
    expect(explainPacket({ ...pkt(1, 1000), health: undefined })).toBe('health missing');
    expect(explainPacket(null)).toMatch(/not an object/);
  });

  it('a rejection is reported with its reason and cleared once data is accepted again', () => {
    const seen: (string | null)[] = [];
    configurePipeline({ onButton: () => {}, onFall: () => {}, onRejected: (r) => seen.push(r) });
    ingestPacket({ ...pkt(1, 1000), v: 3 } as unknown as TelemetryPacket, Date.now());
    ingestPacket(pkt(2, 1100), Date.now());
    expect(seen).toEqual(['Stick data rejected: v = 3 (expected 1)', null]);
  });

  it('turns a raw packet into filtered domain state', () => {
    ingestPacket(pkt(1, 1000), Date.now());
    const d = useDevice.getState();
    expect(d.battery.status).toBe('ok');
    expect(d.battery.percent).toBeGreaterThan(50);
    expect(d.ultrasonic.distanceCm).toBe(120);
    expect(d.imu.pitch).toBe(3);
  });

  it('rejects packets from another device and malformed packets', () => {
    ingestPacket(pkt(1, 1000, { deviceId: 'AISS-OTHER' }), Date.now());
    ingestPacket({ v: 1 } as unknown as TelemetryPacket, Date.now());
    expect(rejected).toHaveLength(2);
    expect(useDevice.getState().battery.status).toBe('unknown');
  });

  it('ignores duplicates, handles reboot, delivers ECU fall events once', () => {
    const fall = { id: 5, type: 'fall' as const, atMs: 900, value: 2.8, confidence: 0.9 };
    ingestPacket(pkt(10, 1000, { safety: [fall] }), Date.now());
    ingestPacket(pkt(10, 1000, { safety: [fall] }), Date.now()); // duplicate poll
    expect(falls).toBe(1);
    ingestPacket(pkt(1, 50, { safety: [{ ...fall, id: 1 }] }), Date.now()); // reboot: uptime went back, ids restart
    expect(falls).toBe(2);
  });

  it('button gestures from the stick reach the handler', () => {
    ingestPacket(pkt(1, 1000, { button: [{ id: 1, kind: 'press', atMs: 900 }, { id: 2, kind: 'release', atMs: 980 }] }), Date.now());
    ingestPacket(pkt(2, 1500), Date.now());
    expect(buttons).toEqual(['single']);
  });
});
