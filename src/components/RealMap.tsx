import { useEffect, useRef, useState } from 'react';
import { loadMaps } from '../core/maps/mapsLoader';
import { ENV } from '../core/runtime/env';

/**
 * Google Maps rendering (Maps JavaScript API). Data (position, route) comes from props;
 * this component only draws. Shows honest states when Maps or the position is unavailable.
 */
export interface MapPoint {
  lat: number;
  lng: number;
  accuracyM?: number | null;
}

export function RealMap({ position, path, destination, className = '', stale }: { position: MapPoint | null; path?: [number, number][]; destination?: MapPoint | null; className?: string; stale?: boolean }) {
  const el = useRef<HTMLDivElement>(null);
  const map = useRef<google.maps.Map | null>(null);
  const me = useRef<google.maps.Circle | null>(null);
  const dot = useRef<google.maps.marker.AdvancedMarkerElement | null>(null);
  const line = useRef<google.maps.Polyline | null>(null);
  const dest = useRef<google.maps.marker.AdvancedMarkerElement | null>(null);
  const [err, setErr] = useState<string | null>(ENV.mapsBrowserKey ? null : 'Map unavailable: Google Maps is not configured.');

  useEffect(() => {
    if (!ENV.mapsBrowserKey || !el.current) return;
    let alive = true;
    loadMaps()
      .then(({ maps }) => {
        if (!alive || !el.current) return;
        map.current = new maps.Map(el.current, {
          center: position ?? { lat: 18.5204, lng: 73.8567 },
          zoom: position ? 17 : 12,
          disableDefaultUI: true,
          clickableIcons: false,
          mapId: ENV.mapsMapId ?? 'DEMO_MAP_ID',
          gestureHandling: 'greedy',
        });
      })
      .catch((e) => setErr(`Map unavailable: ${(e as Error).message}`));
    return () => {
      alive = false;
    };
    // map is created once; position updates handled below
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  useEffect(() => {
    const m = map.current;
    if (!m || !position) return;
    const pos = { lat: position.lat, lng: position.lng };
    if (!me.current) me.current = new google.maps.Circle({ map: m, strokeWeight: 0, fillColor: '#0a8576', fillOpacity: 0.15 });
    me.current.setCenter(pos);
    me.current.setRadius(Math.max(5, position.accuracyM ?? 10));
    if (!dot.current) {
      const d = document.createElement('div');
      d.style.cssText = 'width:18px;height:18px;border-radius:50%;background:#0a8576;border:3px solid #fff;box-shadow:0 2px 6px rgba(0,0,0,.3)';
      dot.current = new google.maps.marker.AdvancedMarkerElement({ map: m, position: pos, content: d, title: 'Current position' });
    } else dot.current.position = pos;
    (dot.current.content as HTMLElement).style.opacity = stale ? '0.45' : '1';
    m.panTo(pos);
  }, [position?.lat, position?.lng, position?.accuracyM, stale]);

  useEffect(() => {
    const m = map.current;
    if (!m) return;
    line.current?.setMap(null);
    line.current = null;
    if (path && path.length > 1) line.current = new google.maps.Polyline({ map: m, path: path.map(([lat, lng]) => ({ lat, lng })), strokeColor: '#0a8576', strokeWeight: 6, strokeOpacity: 0.9 });
    if (dest.current) dest.current.map = null;
    dest.current = destination ? new google.maps.marker.AdvancedMarkerElement({ map: m, position: { lat: destination.lat, lng: destination.lng }, title: 'Destination' }) : null;
  }, [path, destination?.lat, destination?.lng]);

  return (
    <div className={`relative bg-map-bg ${className}`}>
      <div ref={el} className="absolute inset-0" />
      {(err || !position) && (
        <div className="absolute inset-0 grid place-items-center p-4 text-center">
          <p className="rounded-full bg-surface/85 px-4 py-2 text-[13.5px] font-semibold text-ink-2">{err ?? 'Waiting for location'}</p>
        </div>
      )}
    </div>
  );
}
