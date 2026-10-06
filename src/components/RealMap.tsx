import { useEffect, useRef, useState } from 'react';
import { loadMaps } from '../core/maps/mapsLoader';
import { ENV } from '../core/runtime/env';
import { LocateFixed } from 'lucide-react';

export interface MapPoint {
  lat: number;
  lng: number;
  accuracyM?: number | null;
}

export function RealMap({ position, path, progressIdx, destination, className = '', stale, paddingBottom = 0 }: { position: MapPoint | null; path?: [number, number][]; progressIdx?: number; destination?: MapPoint | null; className?: string; stale?: boolean; paddingBottom?: number }) {
  const el = useRef<HTMLDivElement>(null);
  const map = useRef<google.maps.Map | null>(null);
  const me = useRef<google.maps.Circle | null>(null);
  const dot = useRef<google.maps.marker.AdvancedMarkerElement | null>(null);
  const dest = useRef<google.maps.marker.AdvancedMarkerElement | null>(null);
  const routeLine = useRef<google.maps.Polyline | null>(null);
  const travelledLine = useRef<google.maps.Polyline | null>(null);
  
  const [err, setErr] = useState<string | null>(ENV.mapsBrowserKey ? null : 'Map unavailable: Google Maps is not configured.');
  const [follow, setFollow] = useState(true);

  useEffect(() => {
    if (!ENV.mapsBrowserKey || !el.current) return;
    let alive = true;
    loadMaps()
      .then(({ maps }) => {
        if (!alive || !el.current) return;
        const m = new maps.Map(el.current, {
          center: position ?? { lat: 18.5204, lng: 73.8567 },
          zoom: position ? 17 : 12,
          disableDefaultUI: true,
          clickableIcons: false,
          mapId: ENV.mapsMapId ?? 'DEMO_MAP_ID',
          gestureHandling: 'greedy',
        });
        
        m.addListener('dragstart', () => setFollow(false));
        map.current = m;
      })
      .catch((e) => setErr(`Map unavailable: ${(e as Error).message}`));
    return () => { alive = false; };
  }, []);

  // Update padding so center is visually correct when bottom sheet is active
  useEffect(() => {
    if (map.current) {
      (map.current as any).setOptions({ padding: { bottom: paddingBottom, top: 0, left: 0, right: 0 } });
    }
  }, [paddingBottom]);

  // Position puck
  useEffect(() => {
    const m = map.current;
    if (!m || !position) return;
    const pos = { lat: position.lat, lng: position.lng };
    if (!me.current) me.current = new google.maps.Circle({ map: m, strokeWeight: 0, fillColor: '#0a8576', fillOpacity: 0.15 });
    me.current.setCenter(pos);
    me.current.setRadius(Math.max(5, position.accuracyM ?? 10));
    
    if (!dot.current) {
      const d = document.createElement('div');
      d.style.cssText = 'width:20px;height:20px;border-radius:50%;background:#0a8576;border:3px solid #fff;box-shadow:0 3px 8px rgba(0,0,0,.4); transition: transform 0.3s;';
      dot.current = new google.maps.marker.AdvancedMarkerElement({ map: m, position: pos, content: d, title: 'Current position' });
    } else {
      dot.current.position = pos;
    }
    
    (dot.current.content as HTMLElement).style.opacity = stale ? '0.5' : '1';
    
    if (follow) {
      m.panTo(pos);
    }
  }, [position?.lat, position?.lng, position?.accuracyM, stale, follow]);

  // Destination & Route
  useEffect(() => {
    const m = map.current;
    if (!m) return;
    
    // Draw remaining route
    if (path && path.length > 1) {
      const pIdx = progressIdx ?? 0;
      
      const travelledPath = path.slice(0, pIdx + 1).map(([lat, lng]) => ({ lat, lng }));
      const remainingPath = path.slice(pIdx).map(([lat, lng]) => ({ lat, lng }));
      
      if (!routeLine.current) {
        routeLine.current = new google.maps.Polyline({ map: m, strokeColor: '#0a8576', strokeWeight: 6, strokeOpacity: 0.8 });
      }
      routeLine.current.setPath(remainingPath);
      
      if (!travelledLine.current) {
        travelledLine.current = new google.maps.Polyline({ map: m, strokeColor: '#9ca3af', strokeWeight: 6, strokeOpacity: 0.4 });
      }
      travelledLine.current.setPath(travelledPath);
      
    } else {
      routeLine.current?.setMap(null);
      routeLine.current = null;
      travelledLine.current?.setMap(null);
      travelledLine.current = null;
    }
    
    // Destination marker
    if (destination) {
      if (!dest.current) {
        const d = document.createElement('div');
        d.innerHTML = '<svg xmlns="http://www.w3.org/2000/svg" width="32" height="32" viewBox="0 0 24 24" fill="#0a8576" stroke="white" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M21 10c0 7-9 13-9 13s-9-6-9-13a9 9 0 0 1 18 0z"></path><circle cx="12" cy="10" r="3" fill="white"></circle></svg>';
        d.style.cssText = 'filter: drop-shadow(0 4px 6px rgba(0,0,0,0.3)); transform: translateY(-50%);';
        dest.current = new google.maps.marker.AdvancedMarkerElement({ map: m, position: { lat: destination.lat, lng: destination.lng }, content: d, title: 'Destination' });
      } else {
        dest.current.position = { lat: destination.lat, lng: destination.lng };
      }
    } else {
      if (dest.current) {
        dest.current.map = null;
        dest.current = null;
      }
    }
    
    // Auto-fit bounds if we just got a route and we are in follow mode
    if (follow && path && path.length > 1 && !routeLine.current?.get('fitted')) {
      const bounds = new google.maps.LatLngBounds();
      path.forEach(([lat, lng]) => bounds.extend({ lat, lng }));
      m.fitBounds(bounds, { bottom: paddingBottom + 20, top: 20, left: 20, right: 20 });
      if (routeLine.current) routeLine.current.set('fitted', true);
    }
  }, [path, destination?.lat, destination?.lng, progressIdx, follow, paddingBottom]);

  return (
    <div className={`relative bg-map-bg ${className}`}>
      <div ref={el} className="absolute inset-0" />
      
      {!follow && position && !err && (
        <button 
          onClick={() => {
            setFollow(true);
            map.current?.panTo({ lat: position.lat, lng: position.lng });
            map.current?.setZoom(17);
          }}
          className="absolute top-4 right-4 bg-surface text-teal p-3 rounded-full shadow-lg border border-glass-border interactive"
        >
          <LocateFixed size={24} />
        </button>
      )}

      {(err || !position) && (
        <div className="absolute inset-0 grid place-items-center p-4 text-center z-10 pointer-events-none">
          <p className="rounded-full bg-surface/85 px-4 py-2 text-[13.5px] font-semibold text-ink-2 backdrop-blur-sm shadow-md">
            {err ?? 'Waiting for location...'}
          </p>
        </div>
      )}
    </div>
  );
}
