import { useCallback, useEffect, useRef, useState } from 'react';
import type { PlaceResult } from './mapsService';
import { resolveDestination, searchBias, searchErrorText, suggestDestinations, type DestinationSuggestion, type SearchSource } from './destinationSearch';

const newToken = () => (typeof crypto !== 'undefined' && crypto.randomUUID ? crypto.randomUUID() : `${Date.now()}-${Math.random().toString(36).slice(2)}`);

export interface DestinationSearch {
  query: string;
  setQuery: (q: string) => void;
  items: DestinationSuggestion[];
  /** A request is in flight (debounce passed). */
  searching: boolean;
  /** Still searching after SLOW_MS (the server is starting up): say so instead of a silent wait. */
  slow: boolean;
  /** Where the shown items came from ('osm' → show the OpenStreetMap attribution). */
  source: SearchSource | null;
  /** Why there are no results (search failed, nothing found). null while typing/fine. */
  error: string | null;
  setError: (e: string | null) => void;
  /** pick() is resolving the place. */
  busy: boolean;
  /** Full place for a suggestion (null on failure; `error` then says why). Ends the Places session. */
  pick: (s: DestinationSuggestion) => Promise<PlaceResult | null>;
  clear: () => void;
}

/** After this long without an answer the UI says the search is still running. */
const SLOW_MS = 5000;

/**
 * Debounced, stale-response-safe destination search for the map screen (and setup's place step).
 * Works without GPS (the newest position of any age only biases results). Cloud Function and the
 * in-app Google Places search race (hedged); OpenStreetMap is the last resort
 * (core/maps/destinationSearch.ts). `enabled: false` (demo mode) turns the real search off; the
 * caller supplies its own items.
 */
export function useDestinationSearch(opts: { enabled?: boolean; debounceMs?: number; minChars?: number } = {}): DestinationSearch {
  const enabled = opts.enabled ?? true;
  const debounceMs = opts.debounceMs ?? 300;
  const minChars = opts.minChars ?? 2;
  const [query, setQuery] = useState('');
  const [items, setItems] = useState<DestinationSuggestion[]>([]);
  const [searching, setSearching] = useState(false);
  const [slow, setSlow] = useState(false);
  const [source, setSource] = useState<SearchSource | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const token = useRef(newToken());
  /** Only the newest request may change the list (an older, slower answer is dropped). */
  const seq = useRef(0);

  useEffect(() => {
    if (!enabled) return;
    const text = query.trim();
    const my = ++seq.current;
    setError(null);
    setSlow(false);
    if (text.length < minChars) {
      setItems([]);
      setSource(null);
      setSearching(false);
      return;
    }
    let slowTimer: ReturnType<typeof setTimeout> | undefined;
    const t = setTimeout(() => {
      setSearching(true);
      slowTimer = setTimeout(() => my === seq.current && setSlow(true), SLOW_MS);
      suggestDestinations(text, token.current, searchBias())
        .then((r) => {
          if (my !== seq.current) return;
          setItems(r.suggestions);
          setSource(r.source);
          if (!r.suggestions.length) setError(`No places found for “${text}”.`);
        })
        .catch((e) => {
          if (my !== seq.current) return;
          setItems([]);
          setSource(null);
          setError(searchErrorText(e));
        })
        .finally(() => {
          clearTimeout(slowTimer);
          if (my !== seq.current) return;
          setSearching(false);
          setSlow(false);
        });
    }, debounceMs);
    return () => {
      clearTimeout(t);
      clearTimeout(slowTimer);
    };
  }, [query, enabled, debounceMs, minChars]);

  const pick = useCallback(async (s: DestinationSuggestion) => {
    setBusy(true);
    setError(null);
    try {
      const place = await resolveDestination(s, token.current);
      token.current = newToken(); // a Places session ends with the details call
      return place;
    } catch (e) {
      setError(`Could not open that place. ${searchErrorText(e).replace(/^Search unavailable\. /, '')}`);
      return null;
    } finally {
      setBusy(false);
    }
  }, []);

  const clear = useCallback(() => {
    seq.current++;
    setQuery('');
    setItems([]);
    setSource(null);
    setError(null);
    setSearching(false);
    setSlow(false);
  }, []);

  return { query, setQuery, items, searching, slow, source, error, setError, busy, pick, clear };
}
