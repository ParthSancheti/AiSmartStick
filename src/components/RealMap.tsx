import { useEffect, useRef, useState } from 'react';
import { LocateFixed, MapPinned, RotateCcw, WifiOff } from 'lucide-react';
import { loadMaps, mapsErrorFrom, onMapsAuthFailure, type MapsError } from '../core/maps/mapsLoader';
import { ENV } from '../core/runtime/env';
import { locationProblem, useLocation } from '../core/location/locationService';

export interface MapPoint {
  lat: number;
  lng: number;
  accuracyM?: number | null;
}

type LatLng = { lat: number; lng: number };

/** A marker that works with or without Advanced Markers (missing marker library / invalid Map ID). */
interface Pin {
  set(p: LatLng): void;
  setDim(dim: boolean): void;
  remove(): void;
}

const TEAL = '#0a8576';

function makePin(map: google.maps.Map, pos: LatLng, kind: 'me' | 'dest', title: string): Pin {
  const Adv = google.maps.marker?.AdvancedMarkerElement;
  if (Adv) {
    try {
      const d = document.createElement('div');
      if (kind === 'me') {
        d.style.cssText = `width:20px;height:20px;border-radius:50%;background:${TEAL};border:3px solid #fff;box-shadow:0 3px 8px rgba(0,0,0,.4);transition:opacity .3s;`;
      } else {
        d.innerHTML = `<svg xmlns="http://www.w3.org/2000/svg" width="36" height="36" viewBox="0 0 24 24" fill="${TEAL}" stroke="white" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M21 10c0 7-9 13-9 13s-9-6-9-13a9 9 0 0 1 18 0z"></path><circle cx="12" cy="10" r="3" fill="white"></circle></svg>`;
        d.style.cssText = 'filter:drop-shadow(0 4px 6px rgba(0,0,0,.3));animation:aiss-drop .45s cubic-bezier(.2,1.4,.4,1);';
      }
      const m = new Adv({ map, position: pos, content: d, title, zIndex: kind === 'me' ? 2 : 1 });
      return {
        set: (p) => void (m.position = p),
        setDim: (dim) => void (d.style.opacity = dim ? '0.5' : '1'),
        remove: () => void (m.map = null),
      };
    } catch {
      /* fall back to a classic marker below */
    }
  }
  const icon: google.maps.Symbol | undefined =
    kind === 'me' ? { path: google.maps.SymbolPath.CIRCLE, scale: 9, fillColor: TEAL, fillOpacity: 1, strokeColor: '#ffffff', strokeWeight: 3 } : undefined;
  const m = new google.maps.Marker({ map, position: pos, title, icon, clickable: false, zIndex: kind === 'me' ? 2 : 1 });
  return {
    set: (p) => m.setPosition(p),
    setDim: (dim) => m.setOpacity(dim ? 0.5 : 1),
    remove: () => m.setMap(null),
  };
}

/**
 * The one Google map (walking navigation, location setup). The map instance lives in state so every
 * overlay effect re-runs once the SDK has loaded — overlays set before load are never lost.
 * When the map cannot load (no internet, key/referrer blocked) it says exactly why and still shows
 * the phone's real position; it never shows a silent grey box.
 */
export function RealMap({
  position,
  path,
  progressIdx,
  destination,
  className = '',
  stale,
  paddingBottom = 0,
  focus,
  onMapClick,
  mini,
}: {
  position: MapPoint | null;
  path?: [number, number][];
  progressIdx?: number;
  destination?: MapPoint | null;
  className?: string;
  stale?: boolean;
  paddingBottom?: number;
  /** Pan/zoom here whenever it changes (e.g. a chosen search result). Disables following the puck. */
  focus?: MapPoint | null;
  onMapClick?: (p: MapPoint) => void;
  /** Small card map: compact error card. */
  mini?: boolean;
}) {
  const el = useRef<HTMLDivElement>(null);
  const [map, setMap] = useState<google.maps.Map | null>(null);
  const me = useRef<google.maps.Circle | null>(null);
  const dot = useRef<Pin | null>(null);
  const dest = useRef<Pin | null>(null);
  const routeLine = useRef<google.maps.Polyline | null>(null);
  const travelledLine = useRef<google.maps.Polyline | null>(null);
  const fittedPath = useRef<[number, number][] | null>(null);
  const clickCb = useRef(onMapClick);
  clickCb.current = onMapClick;

  const [err, setErr] = useState<MapsError | null>(ENV.mapsBrowserKey ? null : mapsErrorFrom(new Error('not configured')));
  const [attempt, setAttempt] = useState(0);
  const [follow, setFollow] = useState(!focus);
  // A string selector: re-renders only when the explanation changes, not on every GPS fix.
  const ownGpsText = useLocation((s) => (s.source ? (locationProblem(s)?.text ?? null) : null));

  // Load + create the map (again on Retry / when the internet comes back).
  useEffect(() => {
    if (!ENV.mapsBrowserKey || !el.current) return;
    let alive = true;
    loadMaps()
      .then(({ maps }) => {
        if (!alive || !el.current) return;
        try {
          const m = new maps.Map(el.current, {
            center: focus ?? position ?? { lat: 18.5204, lng: 73.8567 },
            zoom: focus || position ? 17 : 12,
            disableDefaultUI: true,
            clickableIcons: false,
            // Advanced markers need a Map ID; an empty env value must fall back, not be passed through.
            mapId: ENV.mapsMapId || 'DEMO_MAP_ID',
            gestureHandling: 'greedy',
          });
          m.addListener('dragstart', () => setFollow(false));
          m.addListener('click', (e: google.maps.MapMouseEvent) => {
            if (e.latLng && clickCb.current) clickCb.current({ lat: e.latLng.lat(), lng: e.latLng.lng() });
          });
          setErr(null);
          setMap(m);
        } catch (e) {
          setErr(mapsErrorFrom(e));
        }
      })
      .catch((e) => alive && setErr(mapsErrorFrom(e)));
    return () => {
      alive = false;
    };
  }, [attempt]);

  // Google reports key/referrer problems asynchronously (even after the map was created).
  useEffect(() => onMapsAuthFailure((e) => setErr(e)), []);

  // Back online → try again by itself.
  useEffect(() => {
    if (err?.kind !== 'offline' && err?.kind !== 'load_failed') return;
    const retry = () => setAttempt((a) => a + 1);
    window.addEventListener('online', retry);
    return () => window.removeEventListener('online', retry);
  }, [err?.kind]);

  // Position puck
  useEffect(() => {
    if (!map || !position) return;
    const pos = { lat: position.lat, lng: position.lng };
    try {
      if (!me.current) me.current = new google.maps.Circle({ map, strokeWeight: 0, fillColor: TEAL, fillOpacity: 0.15, clickable: false });
      me.current.setCenter(pos);
      me.current.setRadius(Math.max(5, Math.min(position.accuracyM ?? 10, 3000)));
      if (!dot.current) dot.current = makePin(map, pos, 'me', 'Current position');
      else dot.current.set(pos);
      dot.current.setDim(!!stale);
      if (follow && !focus) map.panTo(pos);
    } catch {
      /* a broken overlay must not take the page down */
    }
  }, [map, position?.lat, position?.lng, position?.accuracyM, stale, follow, focus]);

  // External focus (search result, chosen place)
  useEffect(() => {
    if (!map || !focus) return;
    setFollow(false);
    map.panTo({ lat: focus.lat, lng: focus.lng });
    if ((map.getZoom() ?? 0) < 16) map.setZoom(17);
  }, [map, focus?.lat, focus?.lng]);

  // Route and destination
  useEffect(() => {
    if (!map) return;
    try {
      if (path && path.length > 1) {
        const pIdx = Math.max(0, progressIdx ?? 0);
        if (!routeLine.current) routeLine.current = new google.maps.Polyline({ map, strokeColor: TEAL, strokeWeight: 6, strokeOpacity: 0.85, clickable: false, zIndex: 1 });
        if (!travelledLine.current) travelledLine.current = new google.maps.Polyline({ map, strokeColor: '#9ca3af', strokeWeight: 6, strokeOpacity: 0.4, clickable: false, zIndex: 0 });
        routeLine.current.setPath(path.slice(pIdx).map(([lat, lng]) => ({ lat, lng })));
        travelledLine.current.setPath(path.slice(0, pIdx + 1).map(([lat, lng]) => ({ lat, lng })));
        // Frame each new route once (start and every reroute), then let the puck lead.
        if (fittedPath.current !== path) {
          fittedPath.current = path;
          const bounds = new google.maps.LatLngBounds();
          path.forEach(([lat, lng]) => bounds.extend({ lat, lng }));
          map.fitBounds(bounds, { bottom: paddingBottom + 24, top: 24, left: 24, right: 24 });
        }
      } else {
        routeLine.current?.setMap(null);
        routeLine.current = null;
        travelledLine.current?.setMap(null);
        travelledLine.current = null;
        fittedPath.current = null;
      }

      if (destination) {
        const p = { lat: destination.lat, lng: destination.lng };
        if (!dest.current) dest.current = makePin(map, p, 'dest', 'Destination');
        else dest.current.set(p);
      } else if (dest.current) {
        dest.current.remove();
        dest.current = null;
      }
    } catch {
      /* keep the map usable */
    }
  }, [map, path, destination?.lat, destination?.lng, progressIdx, paddingBottom]);

  // Only this phone's own GPS explains itself (the guardian app shows someone else's position).
  const waitingText = !position && !focus ? (ownGpsText ?? 'Waiting for location…') : null;
  const canRetry = err && err.kind !== 'not_configured';

  return (
    <div className={`relative overflow-hidden bg-map-bg ${className}`}>
      {/* z-0 = own stacking context, so Google's own "Oops" overlay can never sit above our error card. */}
      <div ref={el} className={`absolute inset-0 z-0 ${err ? 'invisible' : ''}`} />

      {(!follow || focus) && position && !err && map && (
        <button
          type="button"
          aria-label="Centre on my location"
          onClick={() => {
            setFollow(true);
            map.panTo({ lat: position.lat, lng: position.lng });
            map.setZoom(17);
            onMapClick?.({ lat: position.lat, lng: position.lng });
          }}
          className="glass interactive absolute right-4 top-4 z-10 rounded-full p-3 text-teal shadow-lg"
        >
          <LocateFixed size={24} />
        </button>
      )}

      {err && (
        <div className="absolute inset-0 z-10 grid place-items-center bg-map-bg p-3 text-center" role="alert">
          <div className={`flex w-full max-w-[340px] flex-col items-center rounded-[20px] bg-surface/95 shadow-md ${mini ? 'gap-1 px-3 py-2' : 'gap-2 px-4 py-4'}`}>
            {err.kind === 'offline' ? <WifiOff size={mini ? 18 : 24} className="text-amber" /> : <MapPinned size={mini ? 18 : 24} className="text-amber" />}
            <p className={`font-bold leading-snug text-ink ${mini ? 'text-[12.5px]' : 'text-[14px]'}`}>{err.message}</p>
            {!mini && err.hint && <p className="break-words text-[12px] leading-snug text-ink-3">{err.hint}</p>}
            {position && (
              <p className={`font-semibold text-ink-2 ${mini ? 'text-[11.5px]' : 'text-[12.5px]'}`}>
                Position: {position.lat.toFixed(5)}, {position.lng.toFixed(5)}
                {position.accuracyM != null ? ` (±${Math.round(position.accuracyM)} m)` : ''}
              </p>
            )}
            {canRetry && !mini && (
              <button
                type="button"
                onClick={() => {
                  // A rejected key is cached by Google's script until the page reloads.
                  if (err.kind === 'offline' || err.kind === 'load_failed') setAttempt((a) => a + 1);
                  else window.location.reload();
                }}
                className="mt-1 flex h-9 items-center gap-1.5 rounded-full bg-teal px-4 text-[13px] font-bold text-on-teal"
              >
                <RotateCcw size={15} /> {err.kind === 'offline' || err.kind === 'load_failed' ? 'Retry' : 'Reload'}
              </button>
            )}
          </div>
        </div>
      )}

      {!err && waitingText && (
        <div className="pointer-events-none absolute inset-0 z-10 grid place-items-center p-4 text-center">
          <p className="max-w-full rounded-full bg-surface/85 px-4 py-2 text-[13.5px] font-semibold text-ink-2 shadow-md backdrop-blur-sm">{waitingText}</p>
        </div>
      )}
    </div>
  );
}
