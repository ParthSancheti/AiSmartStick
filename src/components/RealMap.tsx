import { useEffect, useRef, useState } from 'react';
import { loadMaps } from '../core/maps/mapsLoader';
import { ENV } from '../core/runtime/env';
import { LocateFixed } from 'lucide-react';

export interface MapPoint {
  lat: number;
  lng: number;
  accuracyM?: number | null;
}

/**
 * The one Google map (walking navigation, location setup). The map instance lives in state so every
 * overlay effect re-runs once the SDK has loaded — overlays set before load are never lost.
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
}) {
  const el = useRef<HTMLDivElement>(null);
  const [map, setMap] = useState<google.maps.Map | null>(null);
  const me = useRef<google.maps.Circle | null>(null);
  const dot = useRef<google.maps.marker.AdvancedMarkerElement | null>(null);
  const dest = useRef<google.maps.marker.AdvancedMarkerElement | null>(null);
  const routeLine = useRef<google.maps.Polyline | null>(null);
  const travelledLine = useRef<google.maps.Polyline | null>(null);
  const fittedPath = useRef<[number, number][] | null>(null);
  const clickCb = useRef(onMapClick);
  clickCb.current = onMapClick;

  const [err, setErr] = useState<string | null>(ENV.mapsBrowserKey ? null : 'Map unavailable: Google Maps is not configured.');
  const [follow, setFollow] = useState(!focus);

  useEffect(() => {
    if (!ENV.mapsBrowserKey || !el.current) return;
    let alive = true;
    loadMaps()
      .then(({ maps }) => {
        if (!alive || !el.current) return;
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
        setMap(m);
      })
      .catch((e) => setErr(`Map unavailable: ${(e as Error).message}`));
    return () => {
      alive = false;
    };
  }, []);

  // Position puck
  useEffect(() => {
    if (!map || !position) return;
    const pos = { lat: position.lat, lng: position.lng };
    if (!me.current) me.current = new google.maps.Circle({ map, strokeWeight: 0, fillColor: '#0a8576', fillOpacity: 0.15, clickable: false });
    me.current.setCenter(pos);
    me.current.setRadius(Math.max(5, position.accuracyM ?? 10));
    if (!dot.current) {
      const d = document.createElement('div');
      d.style.cssText = 'width:20px;height:20px;border-radius:50%;background:#0a8576;border:3px solid #fff;box-shadow:0 3px 8px rgba(0,0,0,.4);transition:opacity .3s;';
      dot.current = new google.maps.marker.AdvancedMarkerElement({ map, position: pos, content: d, title: 'Current position' });
    } else {
      dot.current.position = pos;
    }
    (dot.current.content as HTMLElement).style.opacity = stale ? '0.5' : '1';
    if (follow && !focus) map.panTo(pos);
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
    if (path && path.length > 1) {
      const pIdx = Math.max(0, progressIdx ?? 0);
      if (!routeLine.current) routeLine.current = new google.maps.Polyline({ map, strokeColor: '#0a8576', strokeWeight: 6, strokeOpacity: 0.85, clickable: false });
      if (!travelledLine.current) travelledLine.current = new google.maps.Polyline({ map, strokeColor: '#9ca3af', strokeWeight: 6, strokeOpacity: 0.4, clickable: false });
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
      if (!dest.current) {
        const d = document.createElement('div');
        d.innerHTML =
          '<svg xmlns="http://www.w3.org/2000/svg" width="36" height="36" viewBox="0 0 24 24" fill="#0a8576" stroke="white" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M21 10c0 7-9 13-9 13s-9-6-9-13a9 9 0 0 1 18 0z"></path><circle cx="12" cy="10" r="3" fill="white"></circle></svg>';
        d.style.cssText = 'filter:drop-shadow(0 4px 6px rgba(0,0,0,.3));animation:aiss-drop .45s cubic-bezier(.2,1.4,.4,1);';
        dest.current = new google.maps.marker.AdvancedMarkerElement({ map, position: { lat: destination.lat, lng: destination.lng }, content: d, title: 'Destination' });
      } else {
        dest.current.position = { lat: destination.lat, lng: destination.lng };
      }
    } else if (dest.current) {
      dest.current.map = null;
      dest.current = null;
    }
  }, [map, path, destination?.lat, destination?.lng, progressIdx, paddingBottom]);

  return (
    <div className={`relative bg-map-bg ${className}`}>
      <div ref={el} className="absolute inset-0" />

      {(!follow || focus) && position && !err && (
        <button
          type="button"
          aria-label="Centre on my location"
          onClick={() => {
            setFollow(true);
            map?.panTo({ lat: position.lat, lng: position.lng });
            map?.setZoom(17);
            onMapClick?.({ lat: position.lat, lng: position.lng });
          }}
          className="glass interactive absolute right-4 top-4 z-10 rounded-full p-3 text-teal shadow-lg"
        >
          <LocateFixed size={24} />
        </button>
      )}

      {(err || (!position && !focus)) && (
        <div className="pointer-events-none absolute inset-0 z-10 grid place-items-center p-4 text-center">
          <p className="rounded-full bg-surface/85 px-4 py-2 text-[13.5px] font-semibold text-ink-2 shadow-md backdrop-blur-sm">{err ?? 'Waiting for location…'}</p>
        </div>
      )}
    </div>
  );
}
