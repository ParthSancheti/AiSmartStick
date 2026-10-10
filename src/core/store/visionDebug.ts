import { create } from 'zustand';
import type { DetectionSnapshot } from '../vision/types';
import type { DetectorStatus } from '../vision/detector';

export type VisionRunState = 'stopped' | 'waiting_for_stick' | 'loading_model' | 'running' | 'paused' | 'error';

interface VisionDebugState {
  latestSnapshot: DetectionSnapshot | null;
  debugFrameUrl: string | null;
  detectorInitTime: number;
  detectorStatus: DetectorStatus;
  detectorError: string | null;
  runState: VisionRunState;
  lastFrameError: string | null;
  setDebugFrameUrl: (url: string | null) => void;
  setSnapshot: (s: DetectionSnapshot) => void;
  setInitTime: (t: number) => void;
}

export const useVisionDebug = create<VisionDebugState>((set) => ({
  latestSnapshot: null,
  debugFrameUrl: null,
  detectorInitTime: 0,
  detectorStatus: 'idle',
  detectorError: null,
  runState: 'stopped',
  lastFrameError: null,
  setSnapshot: (s) => set({ latestSnapshot: s }),
  setInitTime: (t) => set({ detectorInitTime: t }),
  setDebugFrameUrl: (url) => set({ debugFrameUrl: url }),
}));
