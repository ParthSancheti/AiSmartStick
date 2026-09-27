import { describe, expect, it } from 'vitest';
import { ButtonClassifier, BUTTON_TIMING } from '../src/core/telemetry/button';
import type { ButtonEvent } from '../shared/deviceProtocol';

let id = 0;
const press = (at: number): ButtonEvent => ({ id: ++id, kind: 'press', atMs: at });
const release = (at: number): ButtonEvent => ({ id: ++id, kind: 'release', atMs: at });

describe('ButtonClassifier (device timestamps)', () => {
  it('single press fires only after the multi-press window', () => {
    const c = new ButtonClassifier();
    expect(c.ingest([press(1000), release(1100)], 1200)).toEqual([]);
    expect(c.ingest([], 1100 + BUTTON_TIMING.multiPressWindowMs + 1)).toEqual(['single']);
  });

  it('double and triple presses split across polls stay one gesture', () => {
    const c = new ButtonClassifier();
    expect(c.ingest([press(0), release(90)], 150)).toEqual([]);
    expect(c.ingest([press(250), release(340)], 400)).toEqual([]);
    expect(c.ingest([], 800)).toEqual(['double']);
    const t = new ButtonClassifier();
    t.ingest([press(0), release(80), press(200), release(280)], 300);
    t.ingest([press(420), release(500)], 520);
    expect(t.ingest([], 1000)).toEqual(['triple']);
  });

  it('long press fires while still held, once, and release does not add a tap', () => {
    const c = new ButtonClassifier();
    expect(c.ingest([press(0)], 1000)).toEqual([]);
    expect(c.ingest([], BUTTON_TIMING.longPressMs + 10)).toEqual(['hold']);
    expect(c.ingest([release(BUTTON_TIMING.longPressMs + 500)], BUTTON_TIMING.longPressMs + 600)).toEqual([]);
    expect(c.ingest([], BUTTON_TIMING.longPressMs + 2000)).toEqual([]);
  });

  it('ignores duplicate events from overlapping polls', () => {
    const c = new ButtonClassifier();
    const p = press(0);
    const r = release(100);
    c.ingest([p, r], 150);
    c.ingest([p, r], 200); // same ids again
    expect(c.ingest([], 1000)).toEqual(['single']);
  });

  it('passes firmware-classified gestures straight through', () => {
    const c = new ButtonClassifier();
    expect(c.ingest([{ id: ++id, kind: 'gesture', gesture: 'double', atMs: 5 }], 10)).toEqual(['double']);
    expect(c.ingest([{ id: ++id, kind: 'gesture', gesture: 'setup', atMs: 20 }], 25)).toEqual(['setup-hold']);
  });
});
