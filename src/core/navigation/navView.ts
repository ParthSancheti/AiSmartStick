import { create } from 'zustand';

/**
 * Normalised navigation state for every screen, whatever the source
 * (demo street grid or real Google route). UI reads only this.
 */
export type Maneuver = 'left' | 'right' | 'straight' | 'uturn' | 'arrive' | 'other';

export interface NavView {
  active: boolean;
  source: 'demo' | 'real' | null;
  destination: { name: string; placeId: string | null; lat: number | null; lng: number | null } | null;
  totalM: number | null;
  remainingM: number | null;
  etaSec: number | null;
  next: { text: string; maneuver: Maneuver; inM: number | null } | null;
  arrived: boolean;
  offRoute: boolean;
  rerouting: boolean;
  error: string | null;
  path: [number, number][];
  updatedAt: number | null;
}

export const emptyNav = (): NavView => ({
  active: false,
  source: null,
  destination: null,
  totalM: null,
  remainingM: null,
  etaSec: null,
  next: null,
  arrived: false,
  offRoute: false,
  rerouting: false,
  error: null,
  path: [],
  updatedAt: null,
});

export const useNavView = create<NavView>(() => emptyNav());

export function maneuverFrom(m: string | null | undefined, text = ''): Maneuver {
  const s = `${m ?? ''} ${text}`.toUpperCase();
  if (s.includes('UTURN') || s.includes('U-TURN')) return 'uturn';
  if (s.includes('LEFT')) return 'left';
  if (s.includes('RIGHT')) return 'right';
  if (s.includes('STRAIGHT') || s.includes('DEPART') || s.includes('CONTINUE')) return 'straight';
  return 'other';
}
