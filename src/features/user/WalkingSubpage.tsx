import { useState, useEffect } from 'react';
import { AnimatePresence, motion } from 'framer-motion';
import { ChevronLeft, Map, ArrowLeft, ArrowRight, ArrowUp, MapPin, Search, Navigation2, X, Loader2 } from 'lucide-react';
import { useNavView } from '../../core/navigation/navView';
import { useLocation } from '../../core/location/locationService';
import { useRuntime } from '../../core/runtime/mode';
import { useDevice } from '../../core/store/device';
import { useNow } from '../../hooks/useNow';
import { freshnessLabel } from '../../core/location/locationService';
import { MapView } from '../../components/MapView';
import { autocomplete, placeDetails, walkingRoute, type Suggestion, type PlaceResult, type RouteResult } from '../../core/maps/mapsService';
import { startRealNavigation, stopRealNavigation } from '../../core/navigation/realNavigator';
import { startNavigation as startDemoNavigation, stopNavigation as stopDemoNavigation } from '../../core/nav/navigation';
import { PLACES } from '../../core/sim/geo';
import { friendlyError } from '../../core/errors';

export function WalkingSubpage({ open, onClose }: { open: boolean; onClose: () => void }) {
  const nav = useNavView();
  const fix = useLocation((s) => s.fix);
  const locStatus = useLocation((s) => s.status);
  const internet = useDevice((s) => s.internet);
  const demo = useRuntime((s) => s.mode) === 'demo';
  const now = useNow(1000);
  const fresh = fix ? freshnessLabel(fix.ts, now) : '';
  const live = fresh === 'Live';

  const [q, setQ] = useState('');
  const [items, setItems] = useState<Suggestion[]>([]);
  const [err, setErr] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [token] = useState(() => (crypto.randomUUID ? crypto.randomUUID() : String(Date.now())));

  // Search Flow State
  const [searchFocused, setSearchFocused] = useState(false);
  const [previewPlace, setPreviewPlace] = useState<PlaceResult | null>(null);
  const [previewRoute, setPreviewRoute] = useState<RouteResult | null>(null);

  // Clear state when closed
  useEffect(() => {
    if (!open) {
      setSearchFocused(false);
      setPreviewPlace(null);
      setPreviewRoute(null);
      setQ('');
      setItems([]);
    }
  }, [open]);

  // Autocomplete
  useEffect(() => {
    setErr(null);
    const text = q.trim();
    if (text.length < 2) return setItems([]);
    if (demo) {
      setItems(PLACES.filter((p) => p.category !== 'home' && p.name.toLowerCase().includes(text.toLowerCase())).map((p) => ({ placeId: p.id, main: p.name, secondary: 'Demo place' })));
      return;
    }
    if (!fix) return setErr('Waiting for GPS before searching nearby.');
    if (internet === false) return setErr('Search needs internet.');
    const t = setTimeout(() => {
      autocomplete(text, fix.lat, fix.lng, token)
        .then((r) => setItems(r.suggestions))
        .catch((e) => setErr(`Search unavailable. ${friendlyError(e)}`));
    }, 300);
    return () => clearTimeout(t);
  }, [q, demo, fix?.lat, fix?.lng, internet, token]);

  const selectPlace = async (s: Suggestion) => {
    setBusy(true);
    setErr(null);
    setSearchFocused(false);
    try {
      if (demo) {
        const p = PLACES.find((x) => x.id === s.placeId);
        if (p) {
          const fakePlace: PlaceResult = { placeId: p.id, name: p.name, address: 'Demo Address', lat: p.pos.y, lng: p.pos.x, distanceM: 500, openNow: true, primaryType: 'store' };
          setPreviewPlace(fakePlace);
          // Bypass route fetch for demo mode mock
          startDemoNavigation(p);
          setPreviewPlace(null);
        }
      } else {
        const { place } = await placeDetails(s.placeId, token);
        setPreviewPlace(place);
        if (fix) {
          const route = await walkingRoute({ origin: { lat: fix.lat, lng: fix.lng }, destination: { placeId: place.placeId } });
          setPreviewRoute(route);
        }
      }
      setQ('');
      setItems([]);
    } catch (e) {
      setErr(`Could not preview route. ${friendlyError(e)}`);
      setPreviewPlace(null);
    } finally {
      setBusy(false);
    }
  };

  const beginNavigation = async () => {
    if (demo || !previewPlace) return;
    setBusy(true);
    try {
      await startRealNavigation(previewPlace);
      setPreviewPlace(null);
      setPreviewRoute(null);
    } catch (e) {
      setErr(`Start failed. ${friendlyError(e)}`);
    } finally {
      setBusy(false);
    }
  };

  const cancelNavigation = () => {
    if (demo) stopDemoNavigation();
    else stopRealNavigation('user');
  };

  // Determine what path and dest to show on the map
  let mapPath = nav.path;
  let mapDest: any = nav.destination;
  let pIdx = nav.progressIdx;

  if (previewRoute) {
    mapPath = previewRoute.path;
    pIdx = 0;
  }
  if (previewPlace) {
    mapDest = { lat: previewPlace.lat, lng: previewPlace.lng, name: previewPlace.name };
  }

  const bottomPadding = nav.active ? 220 : previewPlace ? 180 : 0;

  return (
    <AnimatePresence>
      {open && (
        <motion.div
          initial={{ clipPath: 'circle(0% at 50% 75%)' }}
          animate={{ clipPath: 'circle(150% at 50% 75%)' }}
          exit={{ clipPath: 'circle(0% at 50% 75%)' }}
          transition={{ duration: 0.4, ease: 'easeInOut' }}
          className="absolute inset-0 z-[80] bg-map-bg flex flex-col overflow-hidden"
        >
          {/* Map layer */}
          <div className="absolute inset-0 z-0">
            <MapView
              className="absolute inset-0 h-full w-full"
              position={fix ? { lat: fix.lat, lng: fix.lng, accuracyM: fix.accuracyM } : null}
              stale={!live}
              path={mapPath}
              progressIdx={pIdx}
              destination={mapDest?.lat != null && mapDest.lng != null ? { lat: mapDest.lat, lng: mapDest.lng } : null}
              paddingBottom={bottomPadding}
            />
          </div>

          {/* Top Bar Floating */}
          <div className="pt-12 px-4 z-10 shrink-0 pointer-events-none">
             <div className="glass bg-surface/90 backdrop-blur-md rounded-[28px] p-2 flex items-center justify-between shadow-[0_10px_30px_rgba(0,0,0,0.08)] pointer-events-auto border border-glass-border">
               <button onClick={onClose} aria-label="Back" className="h-12 w-12 rounded-full flex items-center justify-center text-ink hover:bg-black/5 transition-colors shrink-0 interactive">
                 <ChevronLeft size={24} />
               </button>
               <div className="flex-1 px-2">
                  <div className="flex items-center justify-center gap-2">
                    <div className={`w-2.5 h-2.5 rounded-full ${live ? 'bg-ok animate-pulse' : 'bg-ink-3'}`} />
                    <span className="text-[14px] font-bold tracking-widest text-ink uppercase">
                      {demo ? 'Demo walk' : fix ? (live ? 'Live location' : fresh) : locStatus === 'error' ? 'Location off' : 'Finding location'}
                    </span>
                  </div>
               </div>
               <div className="h-12 w-12 rounded-full bg-ink/5 flex items-center justify-center text-ink-3">
                 <Map size={20} />
               </div>
             </div>
          </div>

          {/* Overlays / Bottom Sheets */}
          <div className="flex-1 flex flex-col justify-end z-10 pointer-events-none">
            
            {/* 1. Active Navigation UI */}
            {nav.active && (
              <div className="bg-surface rounded-t-[32px] p-6 shadow-[0_-10px_40px_rgba(0,0,0,0.15)] pointer-events-auto flex flex-col gap-4">
                <div className="flex items-center justify-between">
                  <div className="flex-1 min-w-0 pr-4">
                    {nav.state === 'REROUTING' && <p className="text-[14px] text-sos font-bold uppercase tracking-wider mb-1 animate-pulse">Rerouting...</p>}
                    {nav.state === 'OFF_ROUTE' && <p className="text-[14px] text-warn font-bold uppercase tracking-wider mb-1">Off Route</p>}
                    {(nav.state === 'NAVIGATING' || nav.state === 'APPROACHING_MANEUVER' || nav.state === 'MANEUVER_NOW' || nav.state === 'ROUTE_READY') && (
                      <p className="text-[14px] text-ink-2 font-bold uppercase tracking-wider mb-1">Heading to</p>
                    )}
                    {nav.state === 'ARRIVED' && <p className="text-[14px] text-teal font-bold uppercase tracking-wider mb-1">Arrived</p>}
                    <p className="text-[22px] font-bold text-ink leading-tight truncate">{nav.destination?.name || 'Destination'}</p>
                  </div>
                  {nav.etaSec !== null && !nav.arrived && (
                    <div className="text-right shrink-0">
                      <p className="text-[26px] font-bold text-teal">{Math.max(1, Math.round(nav.etaSec / 60))} <span className="text-[16px] text-ink-2">min</span></p>
                      <p className="text-[14px] text-ink-3 font-semibold">{nav.remainingM != null ? Math.round(nav.remainingM) : 0} m</p>
                    </div>
                  )}
                </div>

                {nav.next ? (
                  <div className={`rounded-[24px] p-4 flex items-center gap-4 transition-colors ${nav.state === 'MANEUVER_NOW' ? 'bg-teal text-white' : 'bg-ink/5 text-ink'}`}>
                    <div className={`p-3 rounded-full shrink-0 ${nav.state === 'MANEUVER_NOW' ? 'bg-white/20 text-white' : 'bg-white shadow-sm text-ink'}`}>
                      {nav.next.maneuver === 'left' ? <ArrowLeft size={28}/> : nav.next.maneuver === 'right' ? <ArrowRight size={28}/> : nav.next.maneuver === 'arrive' ? <MapPin size={28}/> : <ArrowUp size={28}/>}
                    </div>
                    <div className="flex-1">
                      <p className="text-[18px] font-bold leading-tight">{nav.next.text}</p>
                      {nav.next.inM !== null && <p className={`text-[14px] font-semibold mt-1 ${nav.state === 'MANEUVER_NOW' ? 'text-white/90' : 'text-ink-2'}`}>In {Math.round(nav.next.inM)} m</p>}
                    </div>
                  </div>
                ) : nav.error ? (
                  <div className="bg-sos/10 text-sos rounded-[24px] p-4 font-semibold text-center">{nav.error}</div>
                ) : null}

                <button onClick={cancelNavigation} className="w-full bg-ink/10 text-ink rounded-[24px] py-4 font-bold text-[16px] interactive mt-2">
                  End Navigation
                </button>
              </div>
            )}

            {/* 2. Route Preview UI */}
            {!nav.active && previewPlace && (
              <div className="bg-surface rounded-t-[32px] p-6 shadow-[0_-10px_40px_rgba(0,0,0,0.15)] pointer-events-auto flex flex-col gap-4">
                <div className="flex justify-between items-start">
                  <div className="flex-1 min-w-0 pr-4">
                    <p className="text-[24px] font-bold text-ink truncate">{previewPlace.name}</p>
                    <p className="text-[14px] text-ink-3 truncate mt-1">{previewPlace.address}</p>
                  </div>
                  <button onClick={() => { setPreviewPlace(null); setPreviewRoute(null); }} className="w-10 h-10 rounded-full bg-ink/5 flex items-center justify-center text-ink shrink-0 interactive">
                    <X size={20} />
                  </button>
                </div>
                
                {previewRoute ? (
                  <div className="flex items-center gap-6 mt-2">
                    <div className="flex flex-col">
                      <span className="text-[13px] text-ink-3 font-bold uppercase tracking-wider">Distance</span>
                      <span className="text-[20px] font-bold text-ink">{Math.round(previewRoute.distanceM)} m</span>
                    </div>
                    <div className="flex flex-col">
                      <span className="text-[13px] text-ink-3 font-bold uppercase tracking-wider">Time</span>
                      <span className="text-[20px] font-bold text-ink">{Math.max(1, Math.round(previewRoute.durationS / 60))} min</span>
                    </div>
                  </div>
                ) : (
                  <div className="py-4 flex items-center justify-center gap-2 text-ink-3">
                    <Loader2 size={16} className="animate-spin" /> Calculating route...
                  </div>
                )}

                <button 
                  onClick={beginNavigation} 
                  disabled={!previewRoute || busy}
                  className="w-full bg-teal text-white rounded-[24px] py-4 font-bold text-[18px] interactive flex items-center justify-center gap-2 mt-4 disabled:opacity-50"
                >
                  <Navigation2 size={24} className="fill-white/20" /> Start Walking
                </button>
              </div>
            )}

            {/* 3. Search / Idle UI */}
            {!nav.active && !previewPlace && (
              <div className={`w-full pointer-events-auto bg-surface transition-all duration-300 ${searchFocused ? 'h-full pt-12 flex flex-col' : 'px-4 pb-6 bg-transparent'}`}>
                {searchFocused ? (
                  <div className="flex-1 flex flex-col bg-surface">
                    <div className="px-4 py-3 flex items-center gap-3 border-b border-ink/5 shrink-0">
                      <button onClick={() => setSearchFocused(false)} className="p-2 -ml-2 rounded-full interactive text-ink">
                        <ChevronLeft size={24} />
                      </button>
                      <input 
                        autoFocus
                        value={q}
                        onChange={(e) => setQ(e.target.value)}
                        placeholder="Search places or addresses..."
                        className="flex-1 bg-transparent border-none text-[18px] font-bold text-ink placeholder:text-ink-3 outline-none"
                      />
                      {q && (
                        <button onClick={() => setQ('')} className="p-2 -mr-2 rounded-full interactive text-ink-3">
                          <X size={20} />
                        </button>
                      )}
                    </div>
                    
                    <div className="flex-1 overflow-y-auto p-2">
                      {err && <div className="p-4 text-sos font-semibold text-center">{err}</div>}
                      {items.map((s) => (
                        <button key={s.placeId} onClick={() => selectPlace(s)} className="w-full text-left p-4 flex items-center gap-4 hover:bg-ink/5 rounded-[20px] transition-colors interactive">
                          <div className="w-12 h-12 rounded-full bg-ink/5 flex items-center justify-center text-ink-2 shrink-0">
                            <MapPin size={24} />
                          </div>
                          <div className="flex-1 min-w-0">
                            <p className="text-[16px] font-bold text-ink truncate">{s.main}</p>
                            {s.secondary && <p className="text-[14px] text-ink-3 truncate mt-0.5">{s.secondary}</p>}
                          </div>
                        </button>
                      ))}
                      {!q && items.length === 0 && (
                        <div className="p-8 text-center text-ink-3">
                          <Search size={32} className="mx-auto mb-4 opacity-50" />
                          <p className="font-semibold text-[16px]">Where do you want to go?</p>
                          <p className="text-[14px] mt-1">Search for places, shops, or addresses.</p>
                        </div>
                      )}
                    </div>
                  </div>
                ) : (
                  <button onClick={() => setSearchFocused(true)} className="w-full bg-surface shadow-xl rounded-[32px] p-4 flex items-center gap-4 border border-glass-border interactive">
                    <div className="bg-ink/5 p-3 rounded-full text-ink-2">
                      <Search size={24} />
                    </div>
                    <div className="text-left flex-1">
                      <p className="text-[16px] font-bold text-ink">Where to?</p>
                      <p className="text-[13px] text-ink-3 font-semibold mt-0.5">Search for places or addresses</p>
                    </div>
                  </button>
                )}
              </div>
            )}
          </div>
        </motion.div>
      )}
    </AnimatePresence>
  );
}
