import { useEffect, useMemo, useRef, useState } from 'react';
import { AnimatePresence, motion } from 'motion/react';
import { Check, Loader2, LocateFixed, MapPin, Search, X } from 'lucide-react';
import { LocationStatus } from '../../../components/LocationStatus';
import { MapView } from '../../../components/MapView';
import { GlassButton, cx } from '../../../components/glass';
import { useBackHandler } from '../../../core/backStack';
import { ensureLocation, useLocation } from '../../../core/location/locationService';
import { autocomplete, friendlyMapsError, placeDetails, reverseLookup, type Suggestion } from '../../../core/maps/mapsService';
import { useSession, type SavedPlace } from '../../../core/store/session';
import { useRuntime } from '../../../core/runtime/mode';

interface Picked {
  lat: number;
  lng: number;
  placeId: string | null;
  name: string;
  address: string;
}

const LABELS = ['Home', 'College', 'Work', 'Other'] as const;

/**
 * Pick a saved place on the real map: search ("SNJB" → nearby Places matches), tap the map, or use
 * the current position. The chosen point is saved exactly (lat, lng, placeId, formatted address,
 * label) — the phone and the server use these coordinates, never a re-geocoded guess.
 */
export function HomeLocationStep({ onSaved }: { onSaved: () => void }) {
  const demo = useRuntime((s) => s.mode) === 'demo';
  const fix = useLocation((s) => s.fix);
  const locStatus = useLocation((s) => s.status);
  // Only a live position can become "Home" (a cached one may be from somewhere else).
  const liveFix = fix && (locStatus === 'ok' || locStatus === 'poor') ? fix : null;
  const lookupSeq = useRef(0);
  const [q, setQ] = useState('');
  const [items, setItems] = useState<Suggestion[]>([]);
  const [searching, setSearching] = useState(false);
  const [picked, setPicked] = useState<Picked | null>(null);
  const [resolving, setResolving] = useState(false);
  const [label, setLabel] = useState<(typeof LABELS)[number]>('Home');
  const [err, setErr] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);
  const token = useMemo(() => (crypto.randomUUID ? crypto.randomUUID() : String(Date.now())), [picked?.placeId]);
  const near = fix ? `${fix.lat.toFixed(2)},${fix.lng.toFixed(2)}` : 'none';

  // Back: closes search results first, then un-picks, then leaves the step (parent handler).
  useBackHandler(items.length > 0 || !!picked, () => {
    if (items.length) {
      setItems([]);
      return;
    }
    setPicked(null);
  });

  useEffect(() => {
    const text = q.trim();
    if (text.length < 2 || (picked && text === picked.name)) {
      setItems([]);
      return;
    }
    setErr(null);
    const t = setTimeout(() => {
      setSearching(true);
      // Places biases results around the user (or India's centre before the first GPS fix).
      autocomplete(text, fix?.lat ?? 20.59, fix?.lng ?? 78.96, token)
        .then((r) => setItems(r.suggestions))
        .catch((e) => setErr(`Search unavailable: ${friendlyMapsError(e)} You can still use your current location or tap the map.`))
        .finally(() => setSearching(false));
    }, 300);
    return () => clearTimeout(t);
    // eslint-disable-next-line react-hooks/exhaustive-deps -- `near` stands in for fix
  }, [q, near, token]);

  const choose = async (s: Suggestion) => {
    setItems([]);
    setQ(s.main);
    setResolving(true);
    setErr(null);
    try {
      const { place } = await placeDetails(s.placeId, token);
      setPicked({ lat: place.lat, lng: place.lng, placeId: place.placeId, name: place.name, address: place.address ?? [s.main, s.secondary].filter(Boolean).join(', ') });
    } catch (e) {
      setErr(`Could not open that place: ${friendlyMapsError(e)}`);
    } finally {
      setResolving(false);
    }
  };

  /**
   * Picks a point immediately (the exact coordinates are what gets saved); the street address is
   * looked up in the background and only makes the label nicer. Saving never waits for it.
   */
  const pickPoint = async (p: { lat: number; lng: number }, name = 'Dropped pin') => {
    setItems([]);
    setErr(null);
    const seq = ++lookupSeq.current;
    const coords = `${p.lat.toFixed(5)}, ${p.lng.toFixed(5)}`;
    setPicked({ lat: p.lat, lng: p.lng, placeId: null, name, address: coords });
    setResolving(true);
    try {
      const r = await reverseLookup(p.lat, p.lng);
      if (seq !== lookupSeq.current) return; // a newer point was picked meanwhile
      setPicked((cur) =>
        cur && cur.lat === p.lat && cur.lng === p.lng
          ? { ...cur, name: r.landmark?.name && r.landmark.distanceM < 60 ? r.landmark.name : (r.address?.split(',')[0] ?? name), address: r.address ?? coords }
          : cur,
      );
    } catch {
      /* keep the coordinates; the address is just nicer */
    } finally {
      if (seq === lookupSeq.current) setResolving(false);
    }
  };

  const save = async () => {
    if (!picked) return;
    setSaving(true);
    setErr(null);
    const place: SavedPlace = { id: label.toLowerCase(), label, placeId: picked.placeId ?? '', name: picked.name, address: picked.address, lat: picked.lat, lng: picked.lng, updatedAt: Date.now() };
    useSession.setState((s) => ({
      person: {
        ...s.person,
        homeAddress: label === 'Home' ? picked.address : s.person.homeAddress,
        savedPlaces: [...s.person.savedPlaces.filter((x) => x.id !== place.id), place],
      },
    }));
    try {
      if (label === 'Home') {
        const { updateProfileFields } = await import('../../../core/auth/authService');
        // Saved on the phone already; the cloud copy syncs whenever there is internet (never blocks setup).
        void updateProfileFields({ homeAddress: picked.address, homePlace: { lat: picked.lat, lng: picked.lng, placeId: picked.placeId, address: picked.address, label } }).catch(() => undefined);
      }
      onSaved();
    } catch (e) {
      // Saved on the phone; tell the user the cloud copy is pending instead of pretending.
      setErr(`Saved on this phone. Cloud sync will retry (${(e as Error).message}).`);
      setTimeout(onSaved, 1600);
    } finally {
      setSaving(false);
    }
  };

  return (
    <div className="relative flex h-full flex-col">
      <div className="relative z-20 px-5 pt-2">
        <div className="glass flex h-14 items-center gap-3 rounded-[22px] px-4 shadow-lg">
          {searching || resolving ? <Loader2 size={20} className="shrink-0 animate-spin text-teal" /> : <Search size={20} className="shrink-0 text-ink-3" />}
          <input value={q} onChange={(e) => setQ(e.target.value)} placeholder="Search a place, e.g. SNJB" aria-label="Search a place" className="h-full min-w-0 flex-1 bg-transparent text-[16px] font-semibold text-ink outline-none placeholder:font-medium placeholder:text-ink-3" />
          {q && (
            <button type="button" aria-label="Clear search" onClick={() => (setQ(''), setItems([]))} className="grid h-8 w-8 place-items-center rounded-full text-ink-3">
              <X size={18} />
            </button>
          )}
        </div>
        <AnimatePresence>
          {items.length > 0 && (
            <motion.ul initial={{ opacity: 0, y: -6 }} animate={{ opacity: 1, y: 0 }} exit={{ opacity: 0, y: -6 }} className="glass mt-2 max-h-[46vh] overflow-y-auto rounded-[22px] p-1 shadow-xl" role="listbox" aria-label="Places">
              {items.map((it) => (
                <li key={it.placeId}>
                  <button type="button" onClick={() => void choose(it)} className="flex w-full items-start gap-3 rounded-[18px] px-3 py-3 text-left active:bg-ink/5">
                    <MapPin size={18} className="mt-0.5 shrink-0 text-teal" />
                    <span className="min-w-0">
                      <span className="block truncate text-[15.5px] font-bold text-ink">{it.main}</span>
                      {it.secondary && <span className="block truncate text-[13px] text-ink-3">{it.secondary}</span>}
                    </span>
                  </button>
                </li>
              ))}
            </motion.ul>
          )}
        </AnimatePresence>
        {err && <p className="mt-2 rounded-[14px] bg-amber/15 px-3 py-2 text-[13px] font-semibold text-amber-ink" role="status">{err}</p>}
      </div>

      <div className="absolute inset-0 z-0">
        <MapView className="absolute inset-0 h-full w-full" position={fix ? { lat: fix.lat, lng: fix.lng, accuracyM: fix.accuracyM } : null} focus={picked} destination={picked} onMapClick={(p) => void pickPoint(p)} paddingBottom={picked ? 260 : 0} />
      </div>

      <AnimatePresence>
        {picked && (
          <motion.div initial={{ y: '110%' }} animate={{ y: 0 }} exit={{ y: '110%' }} transition={{ type: 'spring', stiffness: 320, damping: 32 }} className="glass absolute inset-x-3 bottom-[calc(var(--sab)+12px)] z-20 rounded-[28px] p-5 shadow-2xl">
            <p className="text-[12px] font-bold uppercase tracking-[0.18em] text-teal">Selected place</p>
            <p className="mt-1 truncate text-[20px] font-extrabold text-ink">{picked.name}</p>
            <p className="mt-0.5 line-clamp-2 text-[14px] text-ink-2">{picked.address}</p>
            <div className="mt-4 flex gap-2" role="radiogroup" aria-label="Save as">
              {LABELS.map((l) => (
                <button key={l} type="button" role="radio" aria-checked={label === l} onClick={() => setLabel(l)} className={cx('h-9 flex-1 rounded-full text-[13.5px] font-bold transition-colors', label === l ? 'bg-teal text-on-teal' : 'bg-ink/5 text-ink-2')}>
                  {l}
                </button>
              ))}
            </div>
            <GlassButton variant="teal" className="mt-4 h-14 w-full rounded-[20px] text-[17px] font-bold" disabled={saving} onClick={() => void save()}>
              {saving ? <Loader2 size={20} className="animate-spin" /> : <Check size={20} className="mr-2" />} Use this location
            </GlassButton>
          </motion.div>
        )}
      </AnimatePresence>

      {!picked && (
        <div className="absolute inset-x-0 bottom-[calc(var(--sab)+20px)] z-10 flex flex-col items-stretch gap-3 px-5">
          {!demo && <LocationStatus />}
          {!demo && (
            <GlassButton
              variant="teal"
              className="h-14 w-full rounded-[20px] text-[16px] font-bold"
              onClick={() => {
                if (liveFix) void pickPoint({ lat: liveFix.lat, lng: liveFix.lng }, 'Current location');
                else void ensureLocation();
              }}
            >
              {liveFix ? <LocateFixed size={20} className="mr-2" /> : <Loader2 size={20} className="mr-2 animate-spin" />}
              {liveFix ? 'Use my current location' : 'Finding your location…'}
            </GlassButton>
          )}
          <p className="glass self-center rounded-full px-4 py-2 text-center text-[13.5px] font-semibold text-ink-2">{demo ? 'Demo mode: the map is simulated.' : 'Or search above, or tap the map to drop a pin.'}</p>
          {demo ? (
            <GlassButton variant="teal" className="h-12 self-center rounded-[18px] px-6 font-bold" onClick={onSaved}>
              Continue
            </GlassButton>
          ) : (
            <button type="button" onClick={onSaved} className="self-center rounded-full px-4 py-1.5 text-[13.5px] font-bold text-ink-3 underline-offset-4 active:underline">
              Skip for now
            </button>
          )}
        </div>
      )}
    </div>
  );
}
