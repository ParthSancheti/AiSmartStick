import { describe, test, expect, beforeEach } from 'vitest';
import { mapsErrorFrom, mapsErrorFromCode, onMapsAuthFailure, __resetMapsLoaderForTests, __simulateMapsAuthFailure } from '../src/core/maps/mapsLoader';

describe('Google Maps error reporting (never a silent grey map)', () => {
  beforeEach(() => __resetMapsLoaderForTests());

  test('referrer blocked names https://localhost (the Android WebView origin)', () => {
    const e = mapsErrorFromCode('RefererNotAllowedMapError');
    expect(e.kind).toBe('referrer');
    expect(e.hint).toContain('https://localhost/*');
  });

  test('API not enabled / billing / bad key are told apart', () => {
    expect(mapsErrorFromCode('ApiNotActivatedMapError').kind).toBe('api_not_enabled');
    expect(mapsErrorFromCode('ApiTargetBlockedMapError').kind).toBe('api_not_enabled');
    expect(mapsErrorFromCode('BillingNotEnabledMapError').kind).toBe('billing');
    expect(mapsErrorFromCode('InvalidKeyMapError').kind).toBe('invalid_key');
    expect(mapsErrorFromCode(null).kind).toBe('auth');
  });

  test('script load failure → offline (retryable), missing key → not configured', () => {
    expect(mapsErrorFrom(new Error('The Google Maps JavaScript API could not load.')).kind).toBe('offline');
    expect(mapsErrorFrom(new Error('Google Maps timed out')).kind).toBe('offline');
    expect(mapsErrorFrom(new Error('Google Maps is not configured (VITE_GOOGLE_MAPS_BROWSER_KEY).')).kind).toBe('not_configured');
    const already = mapsErrorFromCode('InvalidKeyMapError');
    expect(mapsErrorFrom(already)).toBe(already);
  });

  test('gm_authFailure reaches maps that are already on screen and ones created later', () => {
    const seen: string[] = [];
    onMapsAuthFailure((e) => seen.push(e.kind));
    __simulateMapsAuthFailure('RefererNotAllowedMapError');
    expect(seen).toEqual(['referrer']);
    const later: string[] = [];
    onMapsAuthFailure((e) => later.push(e.kind));
    expect(later).toEqual(['referrer']);
  });
});
