import type { Fix } from '../location/locationService';
import { ensureLocation, haversineM, onFix, useLocation, LOCATION_STALE_MS } from '../location/locationService';
import type { PlaceResult, RouteResult } from '../maps/mapsService';
import { routeWalking } from '../maps/destinationSearch';
import { emptyNav, maneuverFrom, useNavView } from './navView';
import { logEvent } from '../store/activity';
import { announce } from '../ai/voiceOut';
import { haptics } from '../feedback/haptics';
import { earcon } from '../feedback/earcons';
import { stickNavCue } from './stickHaptics';

/** The destination survives process death / activity recreation; the route is recomputed on resume. */
const SAVED_KEY = 'aiss.nav.active.v1';
const RESUME_WINDOW_MS = 2 * 60 * 60_000;
function saveActive(place: PlaceResult | null) {
  try {
    if (place) localStorage.setItem(SAVED_KEY, JSON.stringify({ place, savedAt: Date.now() }));
    else localStorage.removeItem(SAVED_KEY);
  } catch {
    /* storage unavailable: navigation still works, it just won't resume after a restart */
  }
}
export function savedNavigation(): PlaceResult | null {
  try {
    const raw = localStorage.getItem(SAVED_KEY);
    if (!raw) return null;
    const v = JSON.parse(raw) as { place: PlaceResult; savedAt: number };
    return Date.now() - v.savedAt < RESUME_WINDOW_MS && v.place?.placeId ? v.place : null;
  } catch {
    return null;
  }
}

const OFF_ROUTE_M = 35;
const ARRIVE_M = 15;
const PRE_ANNOUNCE_M = 30;
const NOW_M = 8;

interface Active {
  place: PlaceResult;
  route: RouteResult;
  cum: number[];
  stepEndsAt: number[];
  lastStep: number;
  preAnnounced: number;
  nowAnnounced: number;
  offCount: number;
  lastReroute: number;
  startedAt: number;
}

let active: Active | null = null;
let unsubFix: (() => void) | null = null;

/**
 * Destination chosen while there is no live GPS position yet (indoors, GPS just started): the
 * route starts by itself from the first good fix. Shown as an active route "waiting for GPS".
 */
let pending: PlaceResult | null = null;
let pendingUnsub: (() => void) | null = null;
let pendingTimer: ReturnType<typeof setInterval> | undefined;
let pendingStarting = false;
let pendingLastTry = 0;
let pendingSince = 0;
/** A fix this rough is still a fine start point for a walking route (Wi-Fi/cell positions are ~30–100 m). */
const START_ACCURACY_M = 100;
/**
 * After waiting this long, a rougher fix is accepted (a phone with only cell/Wi-Fi positions never
 * gets to 100 m; the route is recomputed as the position improves / the user goes off route).
 */
const SETTLE_AFTER_MS = 30_000;
const SETTLED_ACCURACY_M = 500;
const PENDING_RETRY_MS = 20_000;
export const WAITING_FOR_GPS_TEXT = 'Waiting for your GPS position. Directions start automatically.';
export const NEED_PRECISE_TEXT = 'Precise location is needed for walking directions. Turn on Precise location for this app.';

/** Whether this fix is good enough to start the pending route now. */
export function pendingFixUsable(accuracyM: number, waitedMs: number) {
  return accuracyM <= START_ACCURACY_M || (waitedMs >= SETTLE_AFTER_MS && accuracyM <= SETTLED_ACCURACY_M);
}

const freshFix = () => {
  const f = useLocation.getState().fix;
  return f && Date.now() - f.ts <= LOCATION_STALE_MS ? f : null;
};

function clearPending() {
  pending = null;
  pendingUnsub?.();
  pendingUnsub = null;
  clearInterval(pendingTimer);
  pendingTimer = undefined;
}

function project(p: { lat: number; lng: number }, a: [number, number], b: [number, number]) {
  const k = Math.cos((p.lat * Math.PI) / 180) * 111320;
  const ax = a[1] * k, ay = a[0] * 110540, bx = b[1] * k, by = b[0] * 110540, px = p.lng * k, py = p.lat * 110540;
  const dx = bx - ax, dy = by - ay;
  const len2 = dx * dx + dy * dy || 1;
  const t = Math.max(0, Math.min(1, ((px - ax) * dx + (py - ay) * dy) / len2));
  const qx = ax + t * dx, qy = ay + t * dy;
  return { t, dist: Math.hypot(px - qx, py - qy) };
}

export function progressOnPath(path: [number, number][], cum: number[], p: { lat: number; lng: number }) {
  let best = { along: 0, off: Infinity };
  for (let i = 0; i < path.length - 1; i++) {
    const r = project(p, path[i], path[i + 1]);
    if (r.dist < best.off) best = { off: r.dist, along: cum[i] + r.t * (cum[i + 1] - cum[i]) };
  }
  return best;
}

function build(place: PlaceResult, route: RouteResult): Active {
  const cum = [0];
  for (let i = 1; i < route.path.length; i++) cum.push(cum[i - 1] + haversineM({ lat: route.path[i - 1][0], lng: route.path[i - 1][1] }, { lat: route.path[i][0], lng: route.path[i][1] }));
  const stepEndsAt: number[] = [];
  let acc = 0;
  for (const s of route.steps) stepEndsAt.push((acc += s.distanceM));
  return { place, route, cum, stepEndsAt, lastStep: -1, preAnnounced: -1, nowAnnounced: -1, offCount: 0, lastReroute: 0, startedAt: Date.now() };
}

export async function startRealNavigation(place: PlaceResult) {
  const fix = useLocation.getState().fix;
  // A cached position (location off, indoors for long) would route from the wrong place.
  if (!fix || Date.now() - fix.ts > LOCATION_STALE_MS) throw new Error('location-unavailable');
  // Cloud Function (Routes API) / in-app Maps DirectionsService (hedged), else OpenStreetMap.
  const route = await routeWalking({ lat: fix.lat, lng: fix.lng }, place);
  if (!route.path.length) throw new Error('no-route');
  clearPending();
  active = build(place, route);
  unsubFix?.();
  unsubFix = onFix(onLocation);
  useNavView.setState({
    ...emptyNav(),
    state: 'ROUTE_READY',
    active: true,
    source: 'real',
    destination: { name: place.name, placeId: place.placeId, lat: place.lat, lng: place.lng },
    totalM: route.distanceM,
    remainingM: route.distanceM,
    etaSec: route.durationS,
    path: route.path,
    next: route.steps[0] ? { text: route.steps[0].instruction, maneuver: maneuverFrom(route.steps[0].maneuver, route.steps[0].instruction), inM: 0 } : null,
    updatedAt: Date.now(),
  });
  logEvent({ kind: 'navigation', severity: 'info', title: `Started directions to ${place.name}`, detail: `${Math.round(route.distanceM)} m, about ${Math.max(1, Math.round(route.durationS / 60))} min` });
  saveActive(place);
  // Spoken start for every entry point (map tap, voice, resume): where, how far, first instruction.
  const mins = Math.max(1, Math.round(route.durationS / 60));
  const first = route.steps[0]?.instruction;
  announce(
    { en: `Walking to ${place.name}, ${Math.round(route.distanceM / 10) * 10} metres, about ${mins} minute${mins === 1 ? '' : 's'}.${first ? ` ${first}.` : ''}`, hi: `${place.name} तक पैदल, ${Math.round(route.distanceM / 10) * 10} मीटर, लगभग ${mins} मिनट।${first ? ` ${first}.` : ''}` },
    { nav: true, dedupeKey: 'nav-start' },
  );
  onLocation(fix);
  return route;
}

export function stopRealNavigation(reason: 'user' | 'arrived' = 'user') {
  unsubFix?.();
  unsubFix = null;
  if (active && reason === 'user') logEvent({ kind: 'navigation', severity: 'info', title: `Stopped directions to ${active.place.name}` });
  else if (pending && reason === 'user') logEvent({ kind: 'navigation', severity: 'info', title: `Cancelled directions to ${pending.name}` });
  clearPending();
  active = null;
  saveActive(null);
  useNavView.setState(emptyNav());
}

export async function reroute() {
  const a = active;
  const fix = useLocation.getState().fix;
  if (!a || !fix) return;
  a.lastReroute = Date.now();
  useNavView.setState({ rerouting: true, state: 'REROUTING' });
  try {
    const route = await routeWalking({ lat: fix.lat, lng: fix.lng }, a.place);
    if (active !== a) return; // stopped (or restarted) while the route was being computed
    active = build(a.place, route);
    useNavView.setState({ path: route.path, totalM: route.distanceM, remainingM: route.distanceM, etaSec: route.durationS, offRoute: false, rerouting: false, error: null, state: 'NAVIGATING' });
    announce({ en: 'New route found.', hi: 'New route found.' }, { high: true, dedupeKey: 'nav-reroute' });
  } catch {
    if (active !== a) return;
    useNavView.setState({ rerouting: false, error: 'Could not get a new route. Directions may be out of date.', state: 'NAVIGATION_ERROR' });
  }
}

function onLocation(fix: Fix) {
  const a = active;
  if (!a) return;
  if (fix.accuracyM > 40) return;
  const { along, off } = progressOnPath(a.route.path, a.cum, fix);
  const total = a.cum[a.cum.length - 1] || a.route.distanceM;
  const remaining = Math.max(0, total - along);
  const toDest = haversineM(fix, { lat: a.place.lat, lng: a.place.lng });

  if (toDest <= Math.max(ARRIVE_M, fix.accuracyM * 0.6) || remaining < 5) {
    if (useNavView.getState().arrived) return; // already announced; waiting for the grace period to end
    haptics.play('arrive');
    void stickNavCue('arrive');
    earcon('arrive');
    announce({ en: `You have arrived near ${a.place.name}. Please confirm the entrance with the camera or someone nearby.`, hi: `You have arrived near ${a.place.name}.` }, { high: true });
    logEvent({ kind: 'navigation', severity: 'success', title: `Arrived near ${a.place.name}`, detail: `Walked about ${Math.round(total)} m` });
    useNavView.setState({ arrived: true, remainingM: 0, etaSec: 0, next: { text: 'Arrived', maneuver: 'arrive', inM: 0 }, updatedAt: Date.now(), state: 'ARRIVED' });
    const done = a;
    setTimeout(() => active === done && stopRealNavigation('arrived'), 8000);
    return;
  }

  if (off > OFF_ROUTE_M) {
    a.offCount++;
    if (a.offCount === 2) {
      haptics.play('warning');
      void stickNavCue('off_route');
      announce({ en: 'You are off the route. Finding a new one.', hi: 'आप रास्ते से हट गए हैं। नया रास्ता ढूँढ रही हूँ।' }, { nav: true, dedupeKey: 'nav-off' });
    }
    useNavView.setState({ offRoute: a.offCount >= 2, state: a.offCount >= 2 ? 'OFF_ROUTE' : 'NAVIGATING' });
    if (a.offCount >= 3 && Date.now() - a.lastReroute > 20000) void reroute();
  } else {
    a.offCount = 0;
  }

  let stepIdx = a.stepEndsAt.findIndex((end) => along < end);
  if (stepIdx === -1) stepIdx = a.route.steps.length - 1;
  const nextIdx = Math.min(stepIdx + 1, a.route.steps.length - 1);
  const nextStep = a.route.steps[nextIdx];
  const toNext = Math.max(0, a.stepEndsAt[stepIdx] - along);
  const man = maneuverFrom(nextStep?.maneuver, nextStep?.instruction);

  let currentState: any = 'NAVIGATING';

  if (nextStep && nextIdx !== stepIdx) {
    if (toNext <= PRE_ANNOUNCE_M) currentState = 'APPROACHING_MANEUVER';
    if (toNext <= NOW_M) currentState = 'MANEUVER_NOW';

    if (toNext <= PRE_ANNOUNCE_M && a.preAnnounced !== nextIdx) {
      a.preAnnounced = nextIdx;
      announce({ en: `In ${Math.round(toNext / 5) * 5 || 5} meters, ${nextStep.instruction}`, hi: `In ${Math.round(toNext / 5) * 5 || 5} meters, ${nextStep.instruction}` }, { nav: true, dedupeKey: 'nav-next' });
      void stickNavCue('upcoming');
    }
    if (toNext <= NOW_M && a.nowAnnounced !== nextIdx) {
      a.nowAnnounced = nextIdx;
      if (man === 'left' || man === 'right') {
        haptics.play(man);
        void stickNavCue(man);
      }
      earcon('turn');
    }
  }

  const speed = fix.speedMps && fix.speedMps > 0.3 ? fix.speedMps : 1.2;
  useNavView.setState({
    state: a.offCount >= 2 ? 'OFF_ROUTE' : currentState,
    remainingM: remaining,
    etaSec: Math.round(remaining / speed),
    next: nextStep ? { text: nextStep.instruction, maneuver: man, inM: toNext, stepIdx: nextIdx } : null,
    progressIdx: a.cum.findIndex(c => c >= along),
    updatedAt: Date.now(),
  });
}

export const realNavActive = () => active !== null;
/** Whose map data the active route uses ('osm' → the map must show the OpenStreetMap attribution). */
export const activeRouteProvider = (): 'google' | 'osm' | null => (active ? (active.route.provider ?? 'google') : null);
export const currentDestination = () => active?.place ?? pending ?? null;
/** Destination set while waiting for the first GPS fix (null when none). */
export const pendingDestination = () => pending;

export type NavStart = { status: 'started'; route: RouteResult } | { status: 'waiting_for_gps' };

/**
 * Every "go there" entry point (map search, assistant, voice yes): starts walking directions now
 * when there is a live position, otherwise sets the destination and starts them by itself as soon
 * as GPS delivers one. Route errors (no route, maps down) are thrown only when starting now.
 */
export async function navigateTo(place: PlaceResult, opts: { announce?: boolean } = {}): Promise<NavStart> {
  const fix = freshFix();
  if (fix && fix.accuracyM <= START_ACCURACY_M) return { status: 'started', route: await startRealNavigation(place) };
  armNavigation(place, opts);
  return { status: 'waiting_for_gps' };
}

/**
 * Destination set, directions start from the first good fix (see navigateTo). announce:false when
 * the assistant model says it itself (otherwise the user hears the same sentence twice).
 */
export function armNavigation(place: PlaceResult, opts: { announce?: boolean } = {}) {
  unsubFix?.();
  unsubFix = null;
  active = null;
  clearPending();
  pending = place;
  pendingLastTry = 0;
  pendingSince = Date.now();
  saveActive(place);
  const needPrecise = useLocation.getState().precise === false;
  useNavView.setState({
    ...emptyNav(),
    state: 'ROUTE_READY',
    active: true,
    source: 'real',
    destination: { name: place.name, placeId: place.placeId, lat: place.lat, lng: place.lng },
    next: { text: 'Waiting for GPS', maneuver: 'straight', inM: null },
    error: needPrecise ? NEED_PRECISE_TEXT : WAITING_FOR_GPS_TEXT,
    updatedAt: Date.now(),
  });
  logEvent({ kind: 'navigation', severity: 'info', title: `Destination set: ${place.name}`, detail: 'Directions start when GPS has a position' });
  if (opts.announce !== false) {
    announce(
      needPrecise
        ? { en: `Destination set: ${place.name}. Walking directions need Precise location. Please turn on Precise location for this app.`, hi: `मंज़िल तय: ${place.name}। रास्ते के लिए Precise location चालू करें।` }
        : { en: `Destination set: ${place.name}. Directions will start as soon as GPS finds your position.`, hi: `मंज़िल तय: ${place.name}। GPS मिलते ही रास्ता बताना शुरू करूँगी।` },
      { nav: true, dedupeKey: 'nav-wait' },
    );
  }
  void ensureLocation({ request: false }).catch(() => undefined);
  const tryStart = () => void startPending();
  pendingUnsub = onFix(tryStart);
  pendingTimer = setInterval(tryStart, 3000);
  tryStart();
}

async function startPending() {
  const place = pending;
  const fix = freshFix();
  if (place && !pendingStarting) {
    // Keep the waiting text honest: an Approximate-only grant needs the user to act.
    const err = useNavView.getState().error;
    const want = useLocation.getState().precise === false ? NEED_PRECISE_TEXT : WAITING_FOR_GPS_TEXT;
    if ((err === WAITING_FOR_GPS_TEXT || err === NEED_PRECISE_TEXT) && err !== want) useNavView.setState({ error: want, updatedAt: Date.now() });
  }
  if (!place || pendingStarting || !fix || !pendingFixUsable(fix.accuracyM, Date.now() - pendingSince)) return;
  if (pendingLastTry && Date.now() - pendingLastTry < PENDING_RETRY_MS) return;
  pendingStarting = true;
  pendingLastTry = Date.now();
  try {
    await startRealNavigation(place);
  } catch (e) {
    if (pending !== place) return; // cancelled meanwhile
    const m = (e as Error)?.message;
    useNavView.setState({ error: m === 'no-route' ? 'No walking route found to this place.' : 'Could not get walking directions yet. Trying again…', updatedAt: Date.now() });
  } finally {
    pendingStarting = false;
  }
}

/** After a restart: resume directions to the saved destination from the current position (route recomputed). */
export async function resumeSavedNavigation() {
  const place = savedNavigation();
  if (!place || active || pending) return false;
  try {
    await navigateTo(place);
    logEvent({ kind: 'navigation', severity: 'info', title: `Resumed directions to ${place.name}` });
    return true;
  } catch {
    return false;
  }
}
