import { create } from 'zustand';
import { log } from '../log';

/**
 * Hop-by-hop proof that real stick data is flowing (not just that a connection object exists):
 *
 *   CONNECTED → PACKET RECEIVED → PACKET VALID → TELEMETRY PARSED → DEVICE STORE UPDATED
 *   FRAME REQUESTED → FRAME RECEIVED → FRAME VALID → FRAME DECODED → DETECTOR RAN
 *
 * Counters only (no payloads, no keys). Shown in the detection debug view and the diagnostics
 * screen. Console tracing is opt-in on a device: `localStorage.setItem('aiss.trace', '1')`.
 */
export type TraceStage =
  | 'connected'
  | 'auth_failed'
  | 'packet_received'
  | 'packet_valid'
  | 'packet_rejected'
  | 'telemetry_parsed'
  | 'store_updated'
  | 'button_event'
  | 'frame_requested'
  | 'frame_received'
  | 'frame_rejected'
  | 'frame_decoded'
  | 'detector_ran';

export interface DeviceTrace {
  counts: Record<TraceStage, number>;
  last: Partial<Record<TraceStage, number>>;
  lastError: string | null;
  lastFrameBytes: number | null;
}

const zero = (): Record<TraceStage, number> => ({
  connected: 0,
  auth_failed: 0,
  packet_received: 0,
  packet_valid: 0,
  packet_rejected: 0,
  telemetry_parsed: 0,
  store_updated: 0,
  button_event: 0,
  frame_requested: 0,
  frame_received: 0,
  frame_rejected: 0,
  frame_decoded: 0,
  detector_ran: 0,
});

export const useDeviceTrace = create<DeviceTrace>(() => ({ counts: zero(), last: {}, lastError: null, lastFrameBytes: null }));

const traceConsole = (() => {
  try {
    return typeof localStorage !== 'undefined' && localStorage.getItem('aiss.trace') === '1';
  } catch {
    return false;
  }
})();

/** Rare stages are always logged; per-packet stages only when tracing is switched on. */
const NOISY = new Set<TraceStage>(['packet_received', 'packet_valid', 'telemetry_parsed', 'store_updated', 'frame_requested', 'frame_received', 'frame_decoded', 'detector_ran']);

export function trace(stage: TraceStage, detail?: { error?: string; bytes?: number; [k: string]: unknown }) {
  const now = Date.now();
  useDeviceTrace.setState((s) => ({
    counts: { ...s.counts, [stage]: s.counts[stage] + 1 },
    last: { ...s.last, [stage]: now },
    lastError: detail?.error ?? s.lastError,
    lastFrameBytes: detail?.bytes ?? s.lastFrameBytes,
  }));
  if (!NOISY.has(stage)) log.info(`device: ${stage.toUpperCase()}`, detail);
  else if (traceConsole) console.info(`[TRACE] ${stage.toUpperCase()}`, detail ?? '');
}

export function resetTrace() {
  useDeviceTrace.setState({ counts: zero(), last: {}, lastError: null, lastFrameBytes: null });
}
