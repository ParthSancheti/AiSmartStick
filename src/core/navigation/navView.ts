import { create } from 'zustand';

/**
 * Normalised navigation state for every screen, whatever the source
 * (demo street grid or real Google route). UI reads only this.
 */
export type Maneuver = 'left' | 'right' | 'straight' | 'uturn' | 'arrive' | 'other';

export type NavState = 
  | 'IDLE' 
  | 'ROUTE_READY' 
  | 'NAVIGATING' 
  | 'APPROACHING_MANEUVER' 
  | 'MANEUVER_NOW' 
  | 'NEXT_STEP' 
  | 'OFF_ROUTE' 
  | 'REROUTING' 
  | 'ARRIVED' 
  | 'NAVIGATION_ERROR';

export interface NavView {
  state: NavState;
  active: boolean;
  source: 'demo' | 'real' | null;
  destination: { name: string; placeId: string | null; lat: number | null; lng: number | null } | null;
  totalM: number | null;
  remainingM: number | null;
  etaSec: number | null;
  next: { text: string; maneuver: Maneuver; inM: number | null; stepIdx?: number } | null;
  arrived: boolean;
  offRoute: boolean;
  rerouting: boolean;
  error: string | null;
  path: [number, number][]; // Raw full path polyline
  progressIdx: number;       // Current index on the path
  updatedAt: number | null;
}

export const emptyNav = (): NavView => ({
  state: 'IDLE',
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
  progressIdx: 0,
  updatedAt: null,
});

export const useNavView = create<NavView>(() => emptyNav());

export function maneuverFrom(m: string | null | undefined, text = ''): Maneuver {
  const s = `${m ?? ''} ${text}`.toUpperCase();
  if (s.includes('ARRIVE') || s.includes('DESTINATION')) return 'arrive';
  if (s.includes('UTURN') || s.includes('U-TURN')) return 'uturn';
  if (s.includes('LEFT')) return 'left';
  if (s.includes('RIGHT')) return 'right';
  if (s.includes('STRAIGHT') || s.includes('DEPART') || s.includes('CONTINUE')) return 'straight';
  return 'other';
}
