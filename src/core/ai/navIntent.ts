import { create } from 'zustand';
import type { PlaceResult } from '../maps/mapsService';
import { startRealNavigation } from '../navigation/realNavigator';
import { useNavView } from '../navigation/navView';
import { log } from '../log';

/**
 * Voice navigation hand-off, deterministic:
 *
 *   "Take me to the nearest barber" → search tool picks a real place → OFFER (structured place)
 *   assistant: "I found Boy's Hairstyle, about 500 metres away. Should I take you there?"
 *   user: "Yes" → the app starts navigation to exactly the offered place.
 *
 * The model's own start_navigation call (if it makes one) is idempotent with this: it never starts a
 * second route and never searches again. Offers expire so a stale "yes" cannot start anything.
 */
const OFFER_TTL_MS = 120_000;

interface NavIntentState {
  offer: PlaceResult | null;
  offeredAt: number;
  starting: boolean;
}

export const useNavIntent = create<NavIntentState>(() => ({ offer: null, offeredAt: 0, starting: false }));

export function offerDestination(place: PlaceResult) {
  useNavIntent.setState({ offer: place, offeredAt: Date.now() });
}

export function clearOffer() {
  useNavIntent.setState({ offer: null, offeredAt: 0 });
}

export function pendingOffer(): PlaceResult | null {
  const s = useNavIntent.getState();
  if (!s.offer || Date.now() - s.offeredAt > OFFER_TTL_MS) return null;
  return s.offer;
}

const YES = /^(yes|yeah|yep|yup|sure|ok(ay)?|alright|go( ahead)?|start( it| navigation)?|let'?s go|take me( there)?|please( do)?|do it|of course|correct|right|haan?|ha|ji( haan)?|haan ji|chalo|theek hai|thik hai|hanji|bilkul|हाँ|हां|जी|जी हाँ|ठीक है|चलो|बिल्कुल)\b/i;
const NO = /^(no|nope|nah|don'?t|stop|cancel|not now|wait|nahi|nahin|mat|ruko|नहीं|मत|रुको)\b/i;

const clean = (t: string) => t.toLowerCase().replace(/[^\p{L}\p{N}' ]+/gu, ' ').replace(/\s+/g, ' ').trim();

/** A short confirmation ("yes", "haan, chalo", "okay take me there"), not a new request. */
export function isAffirmative(text: string) {
  const t = clean(text);
  return !!t && t.split(' ').length <= 6 && YES.test(t) && !NO.test(t);
}

export function isNegative(text: string) {
  const t = clean(text);
  return !!t && t.split(' ').length <= 6 && NO.test(t);
}

/** True when a route to this place is already running (or starting). */
export function navigatingTo(placeId: string) {
  const n = useNavView.getState();
  return (n.active && n.destination?.placeId === placeId) || (useNavIntent.getState().starting && useNavIntent.getState().offer?.placeId === placeId);
}

/** Starts navigation to `place` unless a route to it is already running. */
export async function startNavigationTo(place: PlaceResult) {
  if (navigatingTo(place.placeId)) return { started: false as const, alreadyNavigating: true as const };
  useNavIntent.setState({ starting: true });
  try {
    const route = await startRealNavigation(place);
    log.info('voice navigation started', { placeId: place.placeId });
    return { started: true as const, route };
  } finally {
    useNavIntent.setState({ starting: false, offer: null, offeredAt: 0 });
  }
}

/** The user said yes to the pending offer. */
export async function confirmPendingOffer() {
  const place = pendingOffer();
  if (!place) return null;
  return { place, ...(await startNavigationTo(place)) };
}
