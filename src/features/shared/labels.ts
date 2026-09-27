import type { LinkState } from '../../core/types';
import type { BatteryState } from '../../core/telemetry/types';
import type { SafetyStateName } from '../../../shared/firestoreSchema';

/** One vocabulary for status text + tone, so every screen says the same thing about the same state. */
export type Tone = 'ok' | 'warn' | 'sos' | 'muted' | 'brand';

export const TONE_TEXT: Record<Tone, string> = { ok: 'text-ok', warn: 'text-amber', sos: 'text-sos', muted: 'text-ink-3', brand: 'text-teal' };

export function linkLabel(l: LinkState | 'unknown'): { text: string; tone: Tone } {
  switch (l) {
    case 'connected':
      return { text: 'Connected', tone: 'ok' };
    case 'searching':
    case 'connecting':
      return { text: 'Connecting…', tone: 'brand' };
    case 'degraded':
      return { text: 'Connected (weak)', tone: 'warn' };
    case 'reconnecting':
      return { text: 'Reconnecting…', tone: 'warn' };
    case 'protocol_mismatch':
      return { text: 'Update firmware', tone: 'sos' };
    case 'disconnected':
      return { text: 'Disconnected', tone: 'sos' };
    case 'auth_failed':
      return { text: 'Not verified', tone: 'sos' };
    case 'unpaired':
      return { text: 'Not set up', tone: 'muted' };
    default:
      return { text: 'Unknown', tone: 'muted' };
  }
}

export function batteryLabel(b: Pick<BatteryState, 'status' | 'percent' | 'charging'> | null): { text: string; sub: string; tone: Tone } {
  if (!b || b.status === 'unknown' || b.status === 'unavailable') return { text: '—', sub: 'No reading', tone: 'muted' };
  if (b.status === 'sensor_error') return { text: 'Error', sub: 'Battery sensor', tone: 'warn' };
  if (b.percent == null) return { text: '—', sub: 'No reading', tone: 'muted' };
  const tone: Tone = b.status === 'stale' ? 'muted' : b.charging ? 'ok' : b.percent <= 8 ? 'sos' : b.percent <= 20 ? 'warn' : 'ok';
  return { text: `${b.percent}%`, sub: b.status === 'stale' ? 'Last known' : b.charging ? 'Charging' : 'Estimated', tone };
}

export function safetyLabel(s: SafetyStateName): { text: string; tone: Tone } {
  switch (s) {
    case 'healthy':
      return { text: 'ACTIVE', tone: 'ok' };
    case 'warning':
      return { text: 'CHECK', tone: 'warn' };
    case 'critical':
      return { text: 'ATTENTION', tone: 'sos' };
    case 'sos':
      return { text: 'SOS', tone: 'sos' };
    case 'connectionLost':
      return { text: 'STICK OFF', tone: 'sos' };
    case 'stale':
      return { text: 'NO UPDATE', tone: 'muted' };
    case 'initializing':
      return { text: 'STARTING', tone: 'brand' };
    default:
      return { text: 'UNKNOWN', tone: 'muted' };
  }
}

export const km = (m: number) => (m >= 1000 ? `${(m / 1000).toFixed(1)} km` : `${Math.round(m)} m`);
export const mins = (s: number) => (s >= 3600 ? `${Math.floor(s / 3600)} h ${Math.round((s % 3600) / 60)} min` : `${Math.max(0, Math.round(s / 60))} min`);
