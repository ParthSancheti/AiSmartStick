import { describe, expect, it, vi } from 'vitest';

vi.mock('../src/core/navigation/realNavigator', () => {
  const startRealNavigation = vi.fn();
  // navigateTo = start now (a live fix is assumed here); the waiting-for-GPS path is tested in navigation.test.ts.
  return { startRealNavigation, navigateTo: vi.fn(async (p: unknown) => ({ status: 'started', route: await startRealNavigation(p) })) };
});

import { isAffirmative, isNegative } from '../src/core/ai/navIntent';

describe('voice confirmation', () => {
  it.each(['Yes', 'yes please', 'Okay, take me there', 'haan chalo', 'हाँ', 'हाँ जी, चलो', 'ठीक है', 'sure, go ahead now', 'Theek hai'])('"%s" is a yes', (t) => {
    expect(isAffirmative(t)).toBe(true);
  });

  it.each(['Okay, what about a hospital?', 'no', "don't send it", 'no, not okay', 'yes but not now', 'turn right', 'ok find a pharmacy instead', ''])('"%s" is not a yes', (t) => {
    expect(isAffirmative(t)).toBe(false);
  });

  it.each(['No', 'not now', 'नहीं', 'ruko', "Don't"])('"%s" is a no', (t) => {
    expect(isNegative(t)).toBe(true);
  });
});
