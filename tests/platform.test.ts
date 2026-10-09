import { describe, expect, it } from 'vitest';
import { platformFlags } from '../src/util/platform';

const ANDROID_WEBVIEW = 'Mozilla/5.0 (Linux; Android 14; SM-A546E Build/UP1A; wv) AppleWebKit/537.36 (KHTML, like Gecko) Version/4.0 Chrome/141.0.0.0 Mobile Safari/537.36';
const DESKTOP = 'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/141.0.0.0 Safari/537.36';

describe('platformFlags (html.android / html.low-power)', () => {
  it('Capacitor Android app is native, android and low-power', () => {
    expect(platformFlags('android', ANDROID_WEBVIEW)).toEqual({ native: true, android: true, lowPower: true });
  });

  it('desktop website keeps the full effects', () => {
    expect(platformFlags('web', DESKTOP)).toEqual({ native: false, android: false, lowPower: false });
  });

  it('website opened in an Android phone browser also gets the cheap effects', () => {
    expect(platformFlags('web', ANDROID_WEBVIEW)).toEqual({ native: false, android: true, lowPower: true });
  });

  it('?lowpower=1 forces, ?lowpower=0 disables, for testing', () => {
    expect(platformFlags('web', DESKTOP, '?lowpower=1').lowPower).toBe(true);
    expect(platformFlags('android', ANDROID_WEBVIEW, '?lowpower=0').lowPower).toBe(false);
    expect(platformFlags('web', DESKTOP, '', true).lowPower).toBe(true);
  });
});
