import { create } from 'zustand';
import type { DetectionSnapshot } from '../vision/types';

interface VisionDebugState {
  latestSnapshot: DetectionSnapshot | null;
  debugFrameUrl: string | null;
  detectorInitTime: number;
  setDebugFrameUrl: (url: string | null) => void;
  setSnapshot: (s: DetectionSnapshot) => void;
  setInitTime: (t: number) => void;
}

export const useVisionDebug = create<VisionDebugState>((set) => ({
  latestSnapshot: null,
  debugFrameUrl: null,
  detectorInitTime: 0,
  setSnapshot: (s) => set({ latestSnapshot: s }),
  setInitTime: (t) => set({ detectorInitTime: t }),
  setDebugFrameUrl: (url) => set({ debugFrameUrl: url }),
}));
