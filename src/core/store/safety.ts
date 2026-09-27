import { create } from 'zustand';
import type { SosDelivery, SosPhase, SosTrigger } from '../types';

export interface SafetyState {
  phase: SosPhase;
  trigger: SosTrigger | null;
  countdown: number;
  startedAt: number;
  delivery: SosDelivery;
  guardianAck: boolean;
  guardianOnWay: boolean;
  resolvedBy: 'user' | 'guardian' | null;
  /** Backend-reported push result to the guardian's devices (null until the function reports). */
  guardianNotify: 'sent' | 'failed' | 'no_devices' | 'no_guardian' | null;
  /** Set when neither the cloud nor SMS could deliver within the dispatch window. */
  dispatchFailed: boolean;
}

export const initialSafety: SafetyState = {
  phase: 'idle',
  trigger: null,
  countdown: 0,
  startedAt: 0,
  delivery: 'pending',
  guardianAck: false,
  guardianOnWay: false,
  resolvedBy: null,
  guardianNotify: null,
  dispatchFailed: false,
};

export const useSafety = create<SafetyState>(() => initialSafety);

/**
 * Formal SOS lifecycle (SECURITY/SOS docs): derived, never stored twice.
 * TRIGGERED (countdown) → DISPATCHING → DELIVERED (server has it) → ACKNOWLEDGED → RESOLVED; FAILED.
 */
export type SosLifecycle = 'IDLE' | 'TRIGGERED' | 'DISPATCHING' | 'DELIVERED' | 'ACKNOWLEDGED' | 'RESOLVED' | 'FAILED';
export function sosLifecycle(s: Pick<SafetyState, 'phase' | 'delivery' | 'guardianAck' | 'dispatchFailed'>): SosLifecycle {
  if (s.phase === 'idle') return 'IDLE';
  if (s.phase === 'countdown') return 'TRIGGERED';
  if (s.phase === 'resolved') return 'RESOLVED';
  if (s.guardianAck) return 'ACKNOWLEDGED';
  if (s.delivery === 'cloud') return 'DELIVERED';
  if (s.dispatchFailed) return 'FAILED';
  return 'DISPATCHING';
}
