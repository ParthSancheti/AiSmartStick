import { getTransport } from '../device/bridge';
import { useDevice, isLinked } from '../store/device';
import { getSettings } from '../store/session';
import type { HapticSemantic } from '../../../shared/deviceProtocol';
import { routeManeuverAllowed } from '../guidance/guidanceState';

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

async function send(pattern: HapticSemantic, isCurrent: () => boolean) {
  if (!getSettings().haptics || !routeManeuverAllowed() || !isCurrent()) return false;
  const t = getTransport();
  if (!t || !isLinked(useDevice.getState().link)) return false;
  try {
    await t.send({ type: 'haptic', pattern }, { ttlMs: 3000 });
    return true;
  } catch {
    /* stick busy/offline: the phone vibration and speech still happen */
    return false;
  }
}

export async function stickNavCue(cue: NavCue, isCurrent: () => boolean = () => true) {
  if (!getSettings().haptics) return;
  switch (cue) {
    case 'upcoming':
      return send('tap', isCurrent);
    case 'left':
      if (!await send('tap', isCurrent)) return;
      await new Promise((r) => setTimeout(r, 350));
      return send('tap', isCurrent);
    case 'right':
      return send('confirm', isCurrent);
    case 'off_route':
      return send('warning', isCurrent);
    case 'arrive':
      return send('locate', isCurrent);
  }
}
