import { useCallback, useEffect, useRef, useState } from 'react';
import type { PlaceResult } from './mapsService';
import { resolveDestination, searchBias, searchErrorText, suggestDestinations, type DestinationSuggestion } from './destinationSearch';

const newToken = () => (typeof crypto !== 'undefined' && crypto.randomUUID ? crypto.randomUUID() : `${Date.now()}-${Math.random().toString(36).slice(2)}`);

export interface DestinationSearch {
  query: string;
  setQuery: (q: string) => void;
  items: DestinationSuggestion[];
  /** A request is in flight (debounce passed). */
  searching: boolean;
  /** Why there are no results (search failed, nothing found). null while typing/fine. */
  error: string | null;
  setError: (e: string | null) => void;
  /** pick() is resolving the place. */
  busy: boolean;
  /** Full place for a suggestion (null on failure; `error` then says why). Ends the Places session. */
  pick: (s: DestinationSuggestion) => Promise<PlaceResult | null>;
  clear: () => void;
}

/**
 * Debounced, stale-response-safe destination search for the map screen (and setup's place step).
 * Works without GPS (the newest position of any age only biases results); falls back from the
 * Cloud Function to the in-app Google Maps Places search (core/maps/destinationSearch.ts).
 * `enabled: false` (demo mode) turns the real search off; the caller supplies its own items.
 */
export function useDestinationSearch(opts: { enabled?: boolean; debounceMs?: number; minChars?: number } = {}): DestinationSearch {
  const enabled = opts.enabled ?? true;
  const debounceMs = opts.debounceMs ?? 300;
  const minChars = opts.minChars ?? 2;
  const [query, setQuery] = useState('');
  const [items, setItems] = useState<DestinationSuggestion[]>([]);
  const [searching, setSearching] = useState(false);
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
    if (text.length < minChars) {
      setItems([]);
      setSearching(false);
      return;
    }
    const t = setTimeout(() => {
      setSearching(true);
      suggestDestinations(text, token.current, searchBias())
        .then((r) => {
          if (my !== seq.current) return;
          setItems(r.suggestions);
          if (!r.suggestions.length) setError(`No places found for “${text}”.`);
        })
        .catch((e) => {
          if (my !== seq.current) return;
          setItems([]);
          setError(searchErrorText(e));
        })
        .finally(() => {
          if (my === seq.current) setSearching(false);
        });
    }, debounceMs);
    return () => clearTimeout(t);
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
    setError(null);
    setSearching(false);
  }, []);

  return { query, setQuery, items, searching, error, setError, busy, pick, clear };
}
