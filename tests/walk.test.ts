import { beforeEach, describe, expect, it } from 'vitest';
import { walkFix, useWalking, pauseWalk, resumeWalk, endWalk, startWalk, onWalkEnded, resetWalkTracker, type WalkSession } from '../src/core/walking/walkTracker';

// ~1.11 m per 0.00001° latitude
const at = (i: number, dLatM: number, acc = 5, t0 = 1_700_000_000_000) => ({ lat: 18.52 + (dLatM / 111_320), lng: 73.85, accuracyM: acc, altitude: null, speedMps: null, headingDeg: null, ts: t0 + i * 10_000 });

describe('walk tracker (GPS noise filtering)', () => {
  beforeEach(() => resetWalkTracker());

  it('counts real walking and ignores jitter', () => {
    walkFix(at(0, 0));
    walkFix(at(1, 1)); // 1 m jitter → ignored
    walkFix(at(2, 14)); // 14 m in 20 s from the reference → counted
    walkFix(at(3, 28));
    const d = useWalking.getState().today.distanceM;
    expect(d).toBeGreaterThan(25);
    expect(d).toBeLessThan(31);
  });

  it('rejects impossible jumps and inaccurate fixes', () => {
    walkFix(at(0, 0));
    walkFix(at(1, 300)); // 300 m in 10 s = 30 m/s → not walking
    walkFix(at(2, 310, 80)); // 80 m accuracy → ignored
    expect(useWalking.getState().today.distanceM).toBe(0);
  });

  it('pause stops counting; resume does not add the paused gap', () => {
    walkFix(at(0, 0));
    walkFix(at(1, 12));
    const before = useWalking.getState().today.distanceM;
    pauseWalk();
    walkFix(at(2, 200));
    resumeWalk();
    walkFix(at(3, 205)); // new reference after resume
    walkFix(at(4, 217));
    const after = useWalking.getState().today.distanceM;
    expect(after - before).toBeGreaterThan(10);
    expect(after - before).toBeLessThan(14);
  });

  it('manual start/end emits a session', () => {
    let ended: WalkSession | null = null;
    const off = onWalkEnded((s) => (ended = s));
    startWalk(1000);
    expect(useWalking.getState().current).not.toBeNull();
    endWalk(61_000);
    off();
    expect(ended).not.toBeNull();
    expect(ended!.durationS).toBe(60);
    expect(useWalking.getState().current).toBeNull();
  });
});
