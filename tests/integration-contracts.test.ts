import { describe, expect, it } from 'vitest';
import { geofenceStep, initialFence } from '../functions/src/geofence';
import { sosLifecycle } from '../src/core/store/safety';
import { buildDeviceConfig, SENSITIVITY } from '../src/core/device/deviceConfig';
import { defaultSettings } from '../src/core/store/session';
import { fuseScene, measuredSuffix } from '../src/core/vision/fusion';
import { friendlyError } from '../src/core/errors';
import { log } from '../src/core/log';
import { validatePacket } from '../src/core/telemetry/pipeline';
import { orbPhaseFor } from '../src/components/AiOrb';
import { MockTransport } from '../src/core/transport/mockTransport';
import type { TelemetryPacket } from '../shared/deviceProtocol';

describe('geofence debounce', () => {
  it('needs two outside readings over ≥ 30 s to fire EXIT, ignores GPS jitter', () => {
    let st = initialFence();
    let r = geofenceStep(st, 260, 10, 200, 0); // first outside
    expect(r.event).toBeNull();
    st = r.state;
    r = geofenceStep(st, 150, 10, 200, 10_000); // jitter back inside (not clearly inside) → resets candidate
    st = r.state;
    r = geofenceStep(st, 260, 10, 200, 20_000);
    st = r.state;
    r = geofenceStep(st, 270, 10, 200, 35_000); // only 15 s since candidate started
    expect(r.event).toBeNull();
    st = r.state;
    r = geofenceStep(st, 280, 10, 200, 55_000);
    expect(r.event).toBe('exit');
    st = r.state;
    // Hovering around the edge does not re-enter
    r = geofenceStep(st, 190, 10, 200, 60_000);
    expect(r.event).toBeNull();
    st = r.state;
    r = geofenceStep(st, 120, 10, 200, 70_000);
    st = r.state;
    r = geofenceStep(st, 110, 10, 200, 80_000);
    expect(r.event).toBe('enter');
  });
  it('ignores inaccurate fixes', () => {
    expect(geofenceStep(initialFence(), 5000, 120, 200, 0).event).toBeNull();
  });
});

describe('SOS lifecycle', () => {
  const base = { phase: 'active' as const, delivery: 'pending' as const, guardianAck: false, dispatchFailed: false };
  it('maps states honestly', () => {
    expect(sosLifecycle({ ...base, phase: 'countdown' })).toBe('TRIGGERED');
    expect(sosLifecycle(base)).toBe('DISPATCHING');
    expect(sosLifecycle({ ...base, dispatchFailed: true })).toBe('FAILED');
    expect(sosLifecycle({ ...base, delivery: 'cloud' })).toBe('DELIVERED');
    expect(sosLifecycle({ ...base, delivery: 'cloud', guardianAck: true })).toBe('ACKNOWLEDGED');
    expect(sosLifecycle({ ...base, phase: 'resolved' })).toBe('RESOLVED');
  });
});

describe('canonical device config', () => {
  it('every sensitivity preset satisfies the ECU validator (SafetyLogic.h validObstacleParams)', () => {
    for (const k of Object.keys(SENSITIVITY) as (keyof typeof SENSITIVITY)[]) {
      const c = buildDeviceConfig({ ...defaultSettings, obstacleSensitivity: k }, 1);
      const o = c.obstacle;
      // Mirror of the C++ rule — keep in sync.
      expect(o.dangerCm >= 20 && o.dangerCm < o.warningCm && o.warningCm < o.awarenessCm && o.awarenessCm <= 350).toBe(true);
      expect(o.hysteresisCm >= 5 && o.hysteresisCm <= 50 && o.confirmSamples >= 1 && o.confirmSamples <= 6).toBe(true);
    }
  });
  it('clamps haptics and sleep, follows the fall-SOS setting', () => {
    const c = buildDeviceConfig({ ...defaultSettings, hapticStrength: 5, autoSleepMin: 999, sosTriggers: { button: true, voice: true, fall: false } }, 7);
    expect(c.haptics.intensity).toBe(20);
    expect(c.power.autoSleepMin).toBe(240);
    expect(c.fall.enabled).toBe(false);
    expect(c.configVersion).toBe(7);
  });
});

describe('mock transport honours the ECU command contract', () => {
  it('is idempotent and rejects stale config versions', async () => {
    const t = new MockTransport({ startLinked: true });
    await t.connect();
    const cfg = buildDeviceConfig(defaultSettings, 10);
    expect((await t.send({ type: 'setConfig', config: cfg }, { commandId: 'a1' })).status).toBe('completed');
    expect((await t.send({ type: 'setConfig', config: cfg }, { commandId: 'a1' })).status).toBe('duplicate');
    expect((await t.send({ type: 'setConfig', config: { ...cfg, configVersion: 9 } }, { commandId: 'a2' })).status).toBe('rejected');
    t.disconnect();
  });
});

describe('sensor fusion', () => {
  const sensors = { forwardDistanceCm: 118, ultrasonicStatus: 'ok', zone: 'warning', pitchDeg: 3, rollDeg: 0, headingDeg: null, speedMps: 1.1, measuredAt: 0 };
  it('ranges only the centre object with the measured distance', () => {
    const f = fuseScene({ hazards: [{ type: 'person', position: 'center', distance: 'near', confidence: 'high' }, { type: 'pole', position: 'left', distance: 'near', confidence: 'medium' }] }, sensors, 0);
    expect(f.objects[0]).toMatchObject({ label: 'person', radarDistanceCm: 118, source: ['vision', 'ultrasonic'], confidence: 0.9 });
    expect(f.objects[1].radarDistanceCm).toBeNull();
    expect(measuredSuffix(f)).toMatch(/1\.2 meters/);
  });
  it('reports a measured obstacle the camera did not explain', () => {
    const f = fuseScene({ hazards: [] }, sensors, 0);
    expect(f.objects[0]).toMatchObject({ label: 'unidentified obstacle', source: ['ultrasonic'] });
  });
  it('never invents a distance without a fresh reading', () => {
    const f = fuseScene({ hazards: [{ type: 'person', position: 'center', distance: 'near', confidence: 'high' }] }, { ...sensors, forwardDistanceCm: null, zone: 'unknown' }, 0);
    expect(f.objects[0].radarDistanceCm).toBeNull();
    expect(measuredSuffix(f)).toBe('');
  });
});

describe('telemetry validation rejects poisoned packets', () => {
  const good: TelemetryPacket = {
    v: 1, deviceId: 'AISS-ABC123', seq: 1, uptimeMs: 10,
    battery: { busV: 3.9, shuntMv: 1, currentMa: 10, charging: null, chargeSource: 'current', ok: true },
    imu: { ax: 0, ay: 0, az: 1, gx: 0, gy: 0, gz: 0, pitch: 0, roll: 0, ok: true },
    ultrasonic: { distanceCm: 100, echoUs: 5800, status: 'ok', sampleAgeMs: 0, zone: 'warning' },
    button: [], rssi: -50, health: { camera: 'ok', i2c: 'ok', motor: 'idle' },
  };
  it.each([
    ['impossible distance', { ...good, ultrasonic: { ...good.ultrasonic, distanceCm: 5000 } }],
    ['infinite voltage', { ...good, battery: { ...good.battery, busV: Infinity } }],
    ['impossible voltage', { ...good, battery: { ...good.battery, busV: 99 } }],
    ['angle out of range', { ...good, imu: { ...good.imu, pitch: 720 } }],
    ['unknown status', { ...good, ultrasonic: { ...good.ultrasonic, status: 'great' } }],
    ['unknown zone', { ...good, ultrasonic: { ...good.ultrasonic, zone: 'safe' } }],
    ['bad device id', { ...good, deviceId: 'x"; DROP' }],
    ['negative seq', { ...good, seq: -1 }],
    ['flood of events', { ...good, button: Array.from({ length: 40 }, (_, i) => ({ id: i, kind: 'press', atMs: i })) }],
  ])('rejects %s', (_n, p) => {
    expect(validatePacket(p)).toBe(false);
  });
  it('accepts a good packet', () => expect(validatePacket(good)).toBe(true));
});

describe('user-facing errors and logs', () => {
  it('turns Firebase codes into plain language', () => {
    const e = Object.assign(new Error('Missing or insufficient permissions.'), { code: 'permission-denied' });
    expect(friendlyError(e)).not.toMatch(/Firebase|PERMISSION/);
    expect(friendlyError(new Error('functions/unavailable'))).toMatch(/internet/i);
  });
  it('redacts secrets and medical data', () => {
    expect(log.redactForTest({ idToken: 'abc', deviceKey: 'k', allergies: 'nuts', deviceId: 'AISS-1' })).toEqual({ idToken: '[redacted]', deviceKey: '[redacted]', allergies: '[redacted]', deviceId: 'AISS-1' });
  });
});

describe('AI orb state mapping', () => {
  it('reflects real state only', () => {
    expect(orbPhaseFor({ assistant: 'idle', sosActive: true, internet: true, navigating: false, unavailable: null })).toBe('sos');
    expect(orbPhaseFor({ assistant: 'idle', sosActive: false, internet: false, navigating: false, unavailable: null })).toBe('offline');
    expect(orbPhaseFor({ assistant: 'vision', sosActive: false, internet: true, navigating: false, unavailable: null })).toBe('vision');
    expect(orbPhaseFor({ assistant: 'idle', sosActive: false, internet: true, navigating: true, unavailable: null })).toBe('navigating');
    expect(orbPhaseFor({ assistant: 'idle', sosActive: false, internet: true, navigating: false, unavailable: null })).toBe('ready');
  });
});
