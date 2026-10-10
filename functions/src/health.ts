import { onCall } from 'firebase-functions/v2/https';
import { CALLABLE, GEMINI_API_KEY, GEMINI_LIVE_MODEL, GEMINI_VISION_MODEL, MAPS_SERVER_KEY, quota } from './common';

/**
 * serverPing: the Server test page in the app asks "is the server there, and is it set up?".
 * App Check is NOT enforced here, so the answer also says whether the phone's App Check token was
 * valid (appCheckValid) and whether the other callables require one (appCheckRequired).
 * Key VALUES are never returned, only whether they are set. Signed-in callers also get cheap live
 * checks of the Maps server key (Places, Routes, Geocoding) and the Gemini key (model lookup, free).
 */
const CHECK_TIMEOUT_MS = 6000;
// Two fixed points in Pune (Shaniwar Wada → Pune railway station), about 2.5 km apart.
const FROM = { latitude: 18.5195, longitude: 73.8553 };
const TO = { latitude: 18.5289, longitude: 73.8744 };

export type CheckResult = string; // 'ok' or '<HTTP status> <Google error status>: <message>'

const short = (s: string, key: string) => (key ? s.split(key).join('[key]') : s).replace(/\s+/g, ' ').trim().slice(0, 200);

/** Google REST error body → '<HTTP status> <Google status>: <message>'. */
async function googleError(r: Response, key: string): Promise<string> {
  let status = '';
  let message = '';
  try {
    const j = (await r.json()) as { error?: { status?: string; message?: string }; status?: string; error_message?: string };
    status = j.error?.status ?? j.status ?? '';
    message = j.error?.message ?? j.error_message ?? '';
  } catch {
    /* not JSON */
  }
  return `${r.status} ${status || r.statusText || 'ERROR'}: ${short(message || 'no message', key)}`;
}

async function check(key: string, fn: (signal: AbortSignal) => Promise<CheckResult>): Promise<CheckResult> {
  if (!key) return '0 NO_KEY: the key is not set on the server';
  try {
    return await fn(AbortSignal.timeout(CHECK_TIMEOUT_MS));
  } catch (e) {
    const name = (e as Error)?.name;
    if (name === 'TimeoutError' || name === 'AbortError') return `0 TIMEOUT: no answer from Google in ${CHECK_TIMEOUT_MS / 1000} s`;
    return `0 FETCH_FAILED: ${short(String((e as Error)?.message ?? e), key)}`;
  }
}

const post = (url: string, key: string, fieldMask: string, body: unknown, signal: AbortSignal) =>
  fetch(url, { method: 'POST', headers: { 'content-type': 'application/json', 'x-goog-api-key': key, 'x-goog-fieldmask': fieldMask }, body: JSON.stringify(body), signal });

export async function liveChecks(mapsKey: string, geminiKey: string, visionModel: string) {
  const [places, routes, geocode, gemini] = await Promise.all([
    check(mapsKey, async (signal) => {
      const r = await post('https://places.googleapis.com/v1/places:searchText', mapsKey, 'places.id', { textQuery: 'hospital', maxResultCount: 1 }, signal);
      return r.ok ? 'ok' : googleError(r, mapsKey);
    }),
    check(mapsKey, async (signal) => {
      const r = await post(
        'https://routes.googleapis.com/directions/v2:computeRoutes',
        mapsKey,
        'routes.distanceMeters',
        { origin: { location: { latLng: FROM } }, destination: { location: { latLng: TO } }, travelMode: 'WALK' },
        signal,
      );
      return r.ok ? 'ok' : googleError(r, mapsKey);
    }),
    check(mapsKey, async (signal) => {
      const r = await fetch(`https://maps.googleapis.com/maps/api/geocode/json?address=Pune&region=in&key=${encodeURIComponent(mapsKey)}`, { signal });
      if (!r.ok) return googleError(r, mapsKey);
      const j = (await r.json()) as { status?: string; error_message?: string };
      return j.status === 'OK' || j.status === 'ZERO_RESULTS' ? 'ok' : `${r.status} ${j.status ?? 'ERROR'}: ${short(j.error_message ?? 'no message', mapsKey)}`;
    }),
    check(geminiKey, async (signal) => {
      // Model lookup: checks the key and the model name, generates nothing (free).
      const r = await fetch(`https://generativelanguage.googleapis.com/v1beta/models/${encodeURIComponent(visionModel.replace(/^models\//, ''))}`, { headers: { 'x-goog-api-key': geminiKey }, signal });
      return r.ok ? 'ok' : googleError(r, geminiKey);
    }),
  ]);
  return { places, routes, geocode, gemini };
}

export const serverPing = onCall({ cors: true, enforceAppCheck: false, secrets: [MAPS_SERVER_KEY, GEMINI_API_KEY] }, async (req) => {
  const mapsKey = MAPS_SERVER_KEY.value() ?? '';
  const geminiKey = GEMINI_API_KEY.value() ?? '';
  const visionModel = GEMINI_VISION_MODEL.value();
  const out: Record<string, unknown> = {
    ok: true,
    region: process.env.FUNCTION_REGION || 'asia-south1',
    now: Date.now(),
    signedIn: !!req.auth,
    appCheckValid: !!req.app,
    appCheckRequired: CALLABLE.enforceAppCheck,
    mapsKeySet: !!mapsKey,
    geminiKeySet: !!geminiKey,
    liveModel: GEMINI_LIVE_MODEL.value(),
    visionModel,
  };
  const uid = req.auth?.uid;
  if (uid) {
    try {
      // Live checks call paid Google APIs: a few per minute is plenty for a test page.
      await quota(uid, 'ping', 6, 120);
      out.checks = await liveChecks(mapsKey, geminiKey, visionModel);
    } catch (e) {
      out.checksError = String((e as Error)?.message ?? e).slice(0, 200);
    }
  }
  return out;
});
