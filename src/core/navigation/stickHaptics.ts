import { getTransport } from '../device/bridge';
import { useDevice, isLinked } from '../store/device';
import { getSettings } from '../store/session';
import type { HapticSemantic } from '../../../shared/deviceProtocol';

/**
 * Turn-by-turn on the STICK MOTOR (the phone also vibrates via feedback/haptics).
 * Uses only the protocol's named patterns, so any firmware that implements DEVICE_PROTOCOL.md works:
 *   turn coming up  → tap                 (1 short pulse)
 *   turn LEFT now   → tap, tap            (2 pulses)   ← same rhythm as the phone
 *   turn RIGHT now  → confirm             (3 pulses)
 *   off route       → warning
 *   arrived         → locate              (long rhythm)
 * The firmware never lets these pre-empt an obstacle (safety) pattern.
 */
export type NavCue = 'upcoming' | 'left' | 'right' | 'off_route' | 'arrive';

async function send(pattern: HapticSemantic) {
  const t = getTransport();
  if (!t || !isLinked(useDevice.getState().link)) return;
  try {
    await t.send({ type: 'haptic', pattern }, { ttlMs: 3000 });
  } catch {
    /* stick busy/offline: the phone vibration and speech still happen */
  }
}

export async function stickNavCue(cue: NavCue) {
  if (!getSettings().haptics) return;
  switch (cue) {
    case 'upcoming':
      return send('tap');
    case 'left':
      await send('tap');
      await new Promise((r) => setTimeout(r, 350));
      return send('tap');
    case 'right':
      return send('confirm');
    case 'off_route':
      return send('warning');
    case 'arrive':
      return send('locate');
  }
}
