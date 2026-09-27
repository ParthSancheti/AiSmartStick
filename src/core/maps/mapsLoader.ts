import { importLibrary, setOptions } from '@googlemaps/js-api-loader';
import { ENV } from '../runtime/env';

/** Maps JavaScript API for rendering only (restricted browser key). */
let configured = false;

export async function loadMaps() {
  if (!ENV.mapsBrowserKey) throw new Error('Google Maps is not configured (VITE_GOOGLE_MAPS_BROWSER_KEY).');
  if (!configured) {
    setOptions({ key: ENV.mapsBrowserKey, v: 'weekly', language: 'en', region: 'IN' });
    configured = true;
  }
  const [maps, marker] = await Promise.all([importLibrary('maps'), importLibrary('marker')]);
  return { maps, marker };
}
