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

/** Whole phrases that mean "yes" (matched token by token, so Hindi script works too). */
const YES_PHRASES = [
  'yes', 'yeah', 'yep', 'yup', 'sure', 'ok', 'okay', 'alright', 'go', 'go ahead', 'start', 'start it', 'start navigation',
  'lets go', "let's go", 'take me', 'take me there', 'please', 'please do', 'do it', 'of course', 'correct', 'right',
  'haan', 'han', 'ha', 'ji', 'ji haan', 'haan ji', 'hanji', 'chalo', 'theek hai', 'thik hai', 'bilkul', 'kar do', 'karo',
  'हाँ', 'हां', 'जी', 'जी हाँ', 'हाँ जी', 'ठीक है', 'चलो', 'बिल्कुल', 'कर दो', 'करो',
].map((p) => p.split(' '));
/** Words that may surround a "yes" without changing it ("yes please, go there now"). */
const FILLER = new Set(['please', 'there', 'now', 'then', 'thanks', 'thank', 'you', 'sir', 'it', 'that', 'one', 'and', 'so', 'just', 'abhi', 'wahan', 'वहाँ', 'अभी']);
const NO_WORDS = new Set(['no', 'nope', 'nah', "don't", 'dont', 'stop', 'cancel', 'wait', 'not', 'never', 'nahi', 'nahin', 'mat', 'ruko', 'नहीं', 'मत', 'रुको', 'ना']);

// \p{M}: Devanagari vowel signs and the chandrabindu are marks, not letters ("हाँ" must survive).
const tokens = (t: string) => t.toLowerCase().replace(/[^\p{L}\p{M}\p{N}' ]+/gu, ' ').replace(/\s+/g, ' ').trim().split(' ').filter(Boolean);

/**
 * A short confirmation ("yes", "haan, chalo", "okay take me there") and nothing else.
 * "Okay, what about a hospital?" is a new request, not a yes.
 */
export function isAffirmative(text: string) {
  const w = tokens(text);
  if (!w.length || w.length > 6 || w.some((x) => NO_WORDS.has(x))) return false;
  let i = 0;
  let matched = false;
  while (i < w.length) {
    const hit = YES_PHRASES.filter((p) => p.every((t, k) => w[i + k] === t)).sort((a, b) => b.length - a.length)[0];
    if (hit) {
      matched = true;
      i += hit.length;
    } else if (FILLER.has(w[i])) i++;
    else return false;
  }
  return matched;
}

export function isNegative(text: string) {
  const w = tokens(text);
  return w.length > 0 && w.length <= 6 && (NO_WORDS.has(w[0]) || (w[0] === 'not' && w[1] === 'now'));
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
