import { create } from 'zustand';
import type { VisionFrame } from '../types';

interface VisionState {
  /** Latest frame captured on the stick user's phone (any origin). */
  latest: VisionFrame | null;
  /** Latest frame relayed to the Guardian through the cloud. */
  guardianFrame: VisionFrame | null;
  guardianViewing: boolean;
  requesting: boolean;
  autoRefresh: boolean;
  error: string | null;
  /** Guardian camera session lifecycle (real mode WebRTC; demo uses requesting only). */
  session: CameraSessionState;
}

export type CameraSessionState = 'idle' | 'requesting' | 'waiting' | 'connecting' | 'active' | 'reconnecting' | 'ended' | 'failed';

export const useVision = create<VisionState>(() => ({
  latest: null,
  guardianFrame: null,
  guardianViewing: false,
  requesting: false,
  autoRefresh: false,
  error: null,
  session: 'idle',
}));
