import { describe, expect, it, vi } from 'vitest';

vi.mock('../src/core/maps/osmFallback', () => ({ osmSearch: vi.fn(), OSM_ATTRIBUTION: '© OpenStreetMap contributors' }));

import { appCheckAdvice, bytesToBase64, errLine, googleAdvice, isJpeg, pingOutcome, serverAdvice, serverReport, SETUP_DOC, todo, type PingResult } from '../src/features/user/ServerTest';

const coded = (code: string, message: string) => Object.assign(new Error(message), { code });
const section = (s: string | null) => /"(\d [^"]+)"/.exec(s ?? '')?.[1] ?? null;

describe('Server test helpers', () => {
  it('names the setup section in "what to do"', () => {
    expect(todo('Do it.', '2 Enable APIs')).toBe(`Do it. See ${SETUP_DOC}, "2 Enable APIs".`);
    expect(todo('Just this.')).toBe('Just this.');
  });

  it("reads Google's errors (the field report: Places API (New) disabled for the browser key)", () => {
    const fieldReport =
      'Places API (New) has not been used in project 599970506387 before or it is disabled. Enable it by visiting https://console.developers.google.com/apis/api/places.googleapis.com/overview?project=599970506387 then retry.';
    const a = googleAdvice(fieldReport, 'browser');
    expect(section(a)).toBe('2 Enable APIs');
    expect(a).toMatch(/"Places API \(New\)"/);
    expect(a).toMatch(/browser key/);
    expect(section(googleAdvice('403 PERMISSION_DENIED: Routes API has not been used in project 1 before or it is disabled', 'server'))).toBe('2 Enable APIs');
    expect(section(googleAdvice('200 REQUEST_DENIED: This API project is not authorized to use this API.', 'server'))).toBe('2 Enable APIs');
    expect(section(googleAdvice('400 INVALID_ARGUMENT: API key not valid. Please pass a valid API key.', 'server'))).toBe('4 Server key');
    expect(section(googleAdvice('400 INVALID_ARGUMENT: API key not valid. Please pass a valid API key.', 'gemini'))).toBe('5 Gemini key');
    expect(section(googleAdvice('403 PERMISSION_DENIED: Requests to this API places.googleapis.com method google.maps.places.v1.Places.SearchText are blocked.', 'server'))).toBe('4 Server key');
    expect(section(googleAdvice('403 PERMISSION_DENIED: This API method requires billing to be enabled.', 'server'))).toBe('1 Billing');
    expect(section(googleAdvice('RefererNotAllowedMapError', 'browser'))).toBe('3 Browser key');
    expect(googleAdvice('something else entirely', 'server')).toBeNull();
  });

  it('turns callable errors into what to do', () => {
    expect(section(serverAdvice(coded('functions/not-found', 'NOT_FOUND')))).toBe('7 Deploy functions');
    expect(section(serverAdvice(coded('functions/unauthenticated', 'Unauthenticated')))).toBe('6 App Check');
    expect(serverAdvice(coded('functions/unauthenticated', 'Sign in required.'))).toMatch(/^Sign in/);
    expect(section(serverAdvice(coded('deadline-exceeded', 'The server did not answer in 25 s')))).toBe('7 Deploy functions');
    expect(section(serverAdvice(coded('functions/failed-precondition', 'Maps is not configured on the server.'), 'maps'))).toBe('4 Server key');
    expect(section(serverAdvice(coded('functions/internal', 'Could not generate Live session token.'), 'gemini'))).toBe('5 Gemini key');
    // mapsSearch answers "unavailable" when Google refuses the server key: not an internet problem.
    expect(section(serverAdvice(coded('functions/unavailable', 'Maps request failed (403).'), 'maps'))).toBe('2 Enable APIs');
    // ...and now 'failed-precondition' with Google's reason: the advice names the API, not "set the key".
    const off = serverAdvice(coded('functions/failed-precondition', 'Maps request failed (403). Google says: PERMISSION_DENIED: Places API (New) has not been used in project 1 before or it is disabled.'), 'maps');
    expect(off).toMatch(/Enable "Places API \(New\)"/);
    expect(section(off)).toBe('2 Enable APIs');
    expect(serverAdvice(coded('functions/unavailable', 'unavailable'))).toMatch(/Could not reach the server/);
  });

  it('serverPing: all good is PASS, problems give the first thing to fix', () => {
    const good: PingResult = { ok: true, region: 'asia-south1', signedIn: true, appCheckValid: true, appCheckRequired: true, mapsKeySet: true, geminiKeySet: true, checks: { places: 'ok', routes: 'ok', geocode: 'ok', gemini: 'ok' } };
    const g = pingOutcome(good);
    expect(g.status).toBe('pass');
    expect(g.fix).toBeNull();
    expect(g.detail).toMatch(/places ok · routes ok · geocode ok · gemini ok/);

    const noAppCheck = pingOutcome({ ...good, appCheckValid: false });
    expect(noAppCheck.status).toBe('fail');
    expect(section(noAppCheck.fix ?? null)).toBe('6 App Check');
    expect(pingOutcome({ ...good, appCheckValid: false, appCheckRequired: false }).status).toBe('pass');

    expect(section(pingOutcome({ ...good, mapsKeySet: false, checks: { places: '0 NO_KEY: the key is not set on the server' } }).fix ?? null)).toBe('4 Server key');
    expect(section(pingOutcome({ ...good, geminiKeySet: false }).fix ?? null)).toBe('5 Gemini key');
    const places = pingOutcome({ ...good, checks: { ...good.checks, places: '403 PERMISSION_DENIED: Places API (New) has not been used in project 5 before or it is disabled.' } });
    expect(places.status).toBe('fail');
    expect(section(places.fix ?? null)).toBe('2 Enable APIs');
    expect(pingOutcome({ ...good, signedIn: false, checks: undefined }).detail).toMatch(/Google checks need sign-in/);
  });

  it('App Check advice depends on the provider', () => {
    expect(appCheckAdvice('debug')).toMatch(/debug token/);
    expect(appCheckAdvice('play-integrity')).toMatch(/sideloaded/);
    expect(section(appCheckAdvice('none'))).toBe('6 App Check');
  });

  it('errLine shows code and message once', () => {
    expect(errLine(coded('functions/internal', 'INTERNAL'))).toBe('internal: INTERNAL');
    expect(errLine(coded('deadline-exceeded', 'deadline-exceeded'))).toBe('deadline-exceeded');
    expect(errLine(new Error('plain'))).toBe('plain');
  });

  it('JPEG check and base64 (large photos too)', () => {
    expect(isJpeg(new Uint8Array([0xff, 0xd8, 0xff, 0xe0, 0]))).toBe(true);
    expect(isJpeg(new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0]))).toBe(false);
    const big = new Uint8Array(70_000).map((_, i) => i % 251);
    expect(Buffer.from(bytesToBase64(big), 'base64').equals(Buffer.from(big))).toBe(true);
  });

  it('report lists every step with its "to do" line', () => {
    const r = serverReport(
      [
        { id: 'a', label: 'Internet', status: 'pass', detail: 'Google answered', fix: null, ms: 120 },
        { id: 'b', label: 'Server ping', status: 'fail', detail: 'not-found: NOT_FOUND', fix: todo('Deploy.', '7 Deploy functions'), ms: 2300 },
      ],
      ['time: x'],
    );
    expect(r).toMatch(/^AI SmartStick server & maps test\ntime: x/);
    expect(r).toMatch(/PASS {4}Internet \(120 ms\)/);
    expect(r).toMatch(/FAIL {4}Server ping \(2\.3 s\)\n {8}not-found: NOT_FOUND\n {8}TO DO: Deploy\./);
  });
});
