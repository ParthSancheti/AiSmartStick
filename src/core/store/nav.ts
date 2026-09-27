import { create } from 'zustand';
import type { Place, Point, RouteStep } from '../types';
import { START } from '../sim/geo';

export interface NavState {
  active: boolean;
  place: Place | null;
  path: Point[];
  cum: number[];
  total: number;
  travelled: number;
  steps: RouteStep[];
  stepIdx: number;
  preAnnounced: number;
  userPos: Point;
  headingDeg: number;
  arrived: boolean;
}

export const useNav = create<NavState>(() => ({
  active: false,
  place: null,
  path: [],
  cum: [],
  total: 0,
  travelled: 0,
  steps: [],
  stepIdx: 0,
  preAnnounced: -1,
  userPos: START,
  headingDeg: 0,
  arrived: false,
}));
