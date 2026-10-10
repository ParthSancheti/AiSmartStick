import type { SafetyStateName } from '../../../shared/firestoreSchema';
import type { LinkState } from '../types';
import type { BatteryState, UltrasonicState } from '../telemetry/types';

/**
 * Real safety state. "Healthy" requires positive evidence (verified stick link, a fresh
 * battery reading, a working obstacle sensor). Missing or stale data is never "safe".
 */
export interface SafetyInput {
  sosPhase: 'idle' | 'countdown' | 'active' | 'resolved';
  link: LinkState;
  everConnected: boolean;
  battery: BatteryState;
  ultrasonic: UltrasonicState;
  lowBatteryAt: number;
  internet: boolean | null;
  locationStatus: 'idle' | 'acquiring' | 'ok' | 'stale' | 'poor' | 'error' | 'unavailable';
  bootedAt: number;
  now: number;
}

export interface SafetyEvaluation {
  state: SafetyStateName;
  reasons: string[];
}

export function evaluateSafety(i: SafetyInput): SafetyEvaluation {
  if (i.sosPhase === 'countdown' || i.sosPhase === 'active') return { state: 'sos', reasons: ['SOS in progress'] };
  if (i.link === 'unpaired') return { state: 'unknown', reasons: ['No stick paired yet'] };
  if (!i.everConnected && i.now - i.bootedAt < 15000 && ['searching', 'connecting'].includes(i.link)) return { state: 'initializing', reasons: ['Connecting to the stick'] };
  if (i.link === 'auth_failed') return { state: 'critical', reasons: ['Stick needs firmware 1.2'] };
  if (i.link === 'protocol_mismatch') return { state: 'critical', reasons: ['Stick firmware needs an update'] };
  if (i.link !== 'connected' && i.link !== 'degraded') return { state: i.everConnected ? 'connectionLost' : 'unknown', reasons: [i.everConnected ? 'Stick disconnected from the phone' : 'Stick not connected'] };

  const reasons: string[] = [];
  let level: 'healthy' | 'warning' | 'critical' = 'healthy';
  const bump = (l: 'warning' | 'critical', r: string) => {
    reasons.push(r);
    if (l === 'critical' || level === 'healthy') level = l;
  };

  const b = i.battery;
  if (b.status === 'sensor_error') bump('warning', 'Battery sensor not reading');
  else if (b.status === 'stale') bump('warning', 'Battery reading is out of date');
  else if (b.status !== 'ok' || b.percent == null) bump('warning', 'No battery reading yet');
  else if (!b.charging && b.percent <= 5) bump('critical', `Stick battery almost empty (about ${b.percent}%)`);
  else if (!b.charging && b.percent <= i.lowBatteryAt) bump('warning', `Stick battery low (about ${b.percent}%)`);

  const u = i.ultrasonic;
  if (u.status === 'error') bump('critical', 'Obstacle sensor error');
  else if (u.status === 'stale' || u.status === 'unknown') bump('warning', 'Obstacle sensor not reporting');
  else if (u.status === 'invalid') bump('warning', 'Obstacle sensor giving invalid readings');

  if (i.internet === false) bump('warning', 'Phone is offline: alerts and the assistant are limited');
  if (i.locationStatus === 'error' || i.locationStatus === 'unavailable') bump('warning', 'Location unavailable');
  else if (i.locationStatus === 'stale') bump('warning', 'Location is out of date');

  return { state: level, reasons };
}
