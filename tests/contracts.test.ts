import { describe, expect, it } from 'vitest';
import { validateArgs, toGeminiParameters } from '../shared/validate';
import { TOOLS, TOOL_BY_NAME } from '../shared/tools';
import { decodePolyline } from '../src/core/maps/mapsService';
import { evaluateSafety, type SafetyInput } from '../src/core/safety/safetyState';
import { progressOnPath } from '../src/core/navigation/realNavigator';
import { unknownBattery, unknownUltrasonic } from '../src/core/telemetry/types';

describe('tool registry + validation', () => {
  it('every tool has a unique Gemini-safe name and a dotted action type', () => {
    const names = new Set<string>();
    for (const t of TOOLS) {
      expect(t.name).toMatch(/^[a-z_]+$/);
      expect(t.type).toMatch(/^[a-z]+\.[A-Za-z]+$/);
      expect(names.has(t.name)).toBe(false);
      names.add(t.name);
      expect(toGeminiParameters(t.params).type).toBe('object');
    }
  });
  it('rejects unknown and malformed arguments', () => {
    const spec = TOOL_BY_NAME.get('send_sms_to_guardian')!.params;
    expect(validateArgs(spec, { text: 'Reached home' }).ok).toBe(true);
    expect(validateArgs(spec, {}).ok).toBe(false);
    expect(validateArgs(spec, { text: 'x', to: '+911234' }).ok).toBe(false);
    expect(validateArgs(spec, { text: 42 }).ok).toBe(false);
    expect(validateArgs(TOOL_BY_NAME.get('set_assistant_volume')!.params, { level: 150 }).ok).toBe(false);
    expect(validateArgs(TOOL_BY_NAME.get('change_setting')!.params, { key: 'sosTriggers', value: 'off' }).ok).toBe(false);
  });
  it('sensitive actions require confirmation', () => {
    expect(TOOL_BY_NAME.get('send_sms_to_guardian')!.confirm).toBe(true);
  });
});

describe('decodePolyline', () => {
  it('decodes the reference polyline', () => {
    const p = decodePolyline('_p~iF~ps|U_ulLnnqC_mqNvxq`@');
    expect(p).toEqual([
      [38.5, -120.2],
      [40.7, -120.95],
      [43.252, -126.453],
    ]);
  });
});

describe('evaluateSafety', () => {
  const base: SafetyInput = {
    sosPhase: 'idle',
    link: 'connected',
    everConnected: true,
    battery: { ...unknownBattery(), status: 'ok', percent: 80, charging: false, measuredAt: 0 },
    ultrasonic: { ...unknownUltrasonic(), status: 'no_echo', measuredAt: 0 },
    lowBatteryAt: 20,
    internet: true,
    locationStatus: 'ok',
    bootedAt: 0,
    now: 60_000,
  };
  it('healthy needs positive evidence', () => {
    expect(evaluateSafety(base).state).toBe('healthy');
    expect(evaluateSafety({ ...base, battery: unknownBattery() }).state).toBe('warning');
    expect(evaluateSafety({ ...base, ultrasonic: unknownUltrasonic() }).state).toBe('warning');
  });
  it('missing stick is never safe', () => {
    expect(evaluateSafety({ ...base, link: 'unpaired' }).state).toBe('unknown');
    expect(evaluateSafety({ ...base, link: 'disconnected' }).state).toBe('connectionLost');
    expect(evaluateSafety({ ...base, link: 'auth_failed' }).state).toBe('critical');
  });
  it('SOS dominates', () => {
    expect(evaluateSafety({ ...base, sosPhase: 'countdown' }).state).toBe('sos');
  });
  it('critical battery and sensor error escalate', () => {
    expect(evaluateSafety({ ...base, battery: { ...base.battery, percent: 4 } }).state).toBe('critical');
    expect(evaluateSafety({ ...base, ultrasonic: { ...base.ultrasonic, status: 'error' } }).state).toBe('critical');
  });
});

describe('navigator progress', () => {
  it('projects a position onto the route', () => {
    const path: [number, number][] = [
      [18.52, 73.85],
      [18.521, 73.85],
      [18.521, 73.851],
    ];
    const cum = [0, 111, 216];
    const r = progressOnPath(path, cum, { lat: 18.5205, lng: 73.85001 });
    expect(r.along).toBeGreaterThan(40);
    expect(r.along).toBeLessThan(70);
    expect(r.off).toBeLessThan(5);
  });
});
