import { create } from 'zustand';
import type { SafetyStateName } from '../../../shared/firestoreSchema';
import { useDevice } from '../store/device';
import { useSafety } from '../store/safety';
import { getSettings } from '../store/session';
import { useLocation } from '../location/locationService';
import { evaluateSafety } from './safetyState';
import { isDemo } from '../runtime/mode';

/** Live safety evaluation for this phone, recomputed when its inputs change (and every 5 s for staleness). */
interface SafetyEvalState {
  state: SafetyStateName;
  reasons: string[];
}

export const useSafetyEval = create<SafetyEvalState>(() => ({ state: 'initializing', reasons: [] }));

const bootedAt = Date.now();
let everConnected = false;

function recompute() {
  const d = useDevice.getState();
  if (d.link === 'connected' || d.link === 'degraded') everConnected = true;
  const loc = useLocation.getState();
  const r = evaluateSafety({
    sosPhase: useSafety.getState().phase,
    link: d.link,
    everConnected,
    battery: d.battery,
    ultrasonic: d.ultrasonic,
    lowBatteryAt: getSettings().lowBatteryAt,
    internet: d.internet,
    // Demo mode has no GPS; don't penalise it.
    locationStatus: isDemo() ? 'ok' : loc.status,
    bootedAt,
    now: Date.now(),
  });
  const cur = useSafetyEval.getState();
  if (cur.state !== r.state || cur.reasons.join() !== r.reasons.join()) useSafetyEval.setState(r);
}

let started = false;
export function startSafetyRuntime() {
  if (started) return;
  started = true;
  useDevice.subscribe(recompute);
  useSafety.subscribe(recompute);
  useLocation.subscribe(recompute);
  setInterval(recompute, 5000);
  recompute();
}
