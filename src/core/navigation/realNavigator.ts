import type { Fix } from '../location/locationService';
import { ensureLocation, haversineM, onFix, useLocation, LOCATION_STALE_MS } from '../location/locationService';
import type { PlaceResult, RouteResult } from '../maps/mapsService';
import { routeWalking } from '../maps/destinationSearch';
import { emptyNav, maneuverFrom, useNavView, type NavState } from './navView';
import { logEvent } from '../store/activity';
import { announce, cancelInvalidAnnouncements } from '../ai/voiceOut';
import { haptics } from '../feedback/haptics';
import { earcon } from '../feedback/earcons';
import { stickNavCue } from './stickHaptics';
import { routeManeuverAllowed, useWalkingGuidance } from '../guidance/guidanceState';

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
const GPS_MANEUVER_ACCURACY_M = 15;
const REROUTE_RETRY_MS = 20_000;
const GPS_DIRECTION_ACCURACY_M = 40;
const GPS_UNAVAILABLE_TEXT = 'Waiting for a fresh GPS position. Walking directions are paused.';
const GPS_INACCURATE_TEXT = 'GPS accuracy is too low for turn instructions. Waiting for a more accurate position.';

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
  lastFix: Fix | null;
  directionsPaused?: boolean;
  lastProgressAt?: number;
  lastProgressM?: number;
  walkingSpeedMps: number;
  matched: { along: number; fix: Fix };
}

let active: Active | null = null;
let unsubFix: (() => void) | null = null;
let unsubLocation: (() => void) | null = null;
let unsubGuidance: (() => void) | null = null;
let navigationGeneration = 0;
let startingRoute: { generation: number; place: PlaceResult; promise: Promise<RouteResult> } | null = null;
let reroutingRoute: { active: Active; promise: Promise<void> } | null = null;
let arrivalTimer: ReturnType<typeof setTimeout> | undefined;

/**
 * Destination chosen while there is no live GPS position yet (indoors, GPS just started): the
 * route starts by itself from the first good fix. Shown as an active route "waiting for GPS".
 */
let pending: PlaceResult | null = null;
let pendingUnsub: (() => void) | null = null;
let pendingTimer: ReturnType<typeof setInterval> | undefined;
let pendingStarting: object | null = null;
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

function fixIsFresh(f: Fix, now = Date.now()) {
  return Number.isFinite(f.lat) && Math.abs(f.lat) <= 90 && Number.isFinite(f.lng) && Math.abs(f.lng) <= 180
    && Number.isFinite(f.accuracyM) && f.accuracyM >= 0 && Number.isFinite(f.ts)
    && f.ts <= now + 2000 && now - f.ts <= LOCATION_STALE_MS;
}

const freshFix = () => {
  const f = useLocation.getState().fix;
  return f && fixIsFresh(f) ? f : null;
};

function clearPending() {
  pending = null;
  pendingUnsub?.();
  pendingUnsub = null;
  clearInterval(pendingTimer);
  pendingTimer = undefined;
  pendingStarting = null;
}

function sameDestination(a: PlaceResult, b: PlaceResult) {
  return a.placeId === b.placeId && a.lat === b.lat && a.lng === b.lng;
}

function validateRoute(route: RouteResult) {
  if (route.path.length < 2 || !Number.isFinite(route.distanceM) || route.distanceM < 0
    || !Number.isFinite(route.durationS) || route.durationS < 0
    || route.path.some(([lat, lng]) => !Number.isFinite(lat) || Math.abs(lat) > 90 || !Number.isFinite(lng) || Math.abs(lng) > 180)
    || route.steps.some((s) => !Number.isFinite(s.distanceM) || s.distanceM < 0)) throw new Error('no-route');
}

function pauseForGps(fix: Fix | null) {
  if (active) {
    active.directionsPaused = true;
    active.preAnnounced = -1;
    active.nowAnnounced = -1;
  }
  const error = fix && fixIsFresh(fix) ? GPS_INACCURATE_TEXT : GPS_UNAVAILABLE_TEXT;
  const changed = useNavView.getState().error !== error;
  useNavView.setState({ state: 'NAVIGATION_ERROR', next: null, error });
  cancelInvalidAnnouncements();
  if (changed) {
    const owner = active;
    announce(error, { nav: true, dedupeKey: 'nav-gps-paused', isCurrent: () => active === owner && !!active && useNavView.getState().error === error });
  }
}

function pauseForGuidance() {
  if (!active || useNavView.getState().arrived) return;
  active.directionsPaused = true;
  active.preAnnounced = -1;
  active.nowAnnounced = -1;
  const severity = useWalkingGuidance.getState().severity;
  const error = severity === 'warning' || severity === 'danger'
    ? 'Obstacle warning active. Walking directions are paused.'
    : 'Obstacle distance cannot be confirmed. Walking directions are paused.';
  const view = useNavView.getState();
  if (view.state === 'NAVIGATION_ERROR' && view.next === null && view.error === error) return;
  useNavView.setState({ state: 'NAVIGATION_ERROR', next: null, error, updatedAt: Date.now() });
  cancelInvalidAnnouncements();
}

function directionIsCurrent(a: Active) {
  const fix = freshFix();
  const view = useNavView.getState();
  return !startingRoute && active === a && view.state !== 'NAVIGATION_ERROR' && view.next !== null && !view.arrived && !view.rerouting && !view.offRoute && !!fix
    && fix.accuracyM <= GPS_DIRECTION_ACCURACY_M && routeManeuverAllowed();
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

export function progressOnPath(path: [number, number][], cum: number[], p: { lat: number; lng: number }, continuity?: { along: number; maxTravelM: number }) {
  let best = { along: continuity?.along ?? 0, off: Infinity };
  for (let i = 0; i < path.length - 1; i++) {
    const r = project(p, path[i], path[i + 1]);
    const along = cum[i] + r.t * (cum[i + 1] - cum[i]);
    // A physically nearby parallel/crossing leg can be hundreds of route metres away.
    // Exclude impossible progress before comparing lateral GPS distance.
    if (continuity && Math.abs(along - continuity.along) > continuity.maxTravelM) continue;
    if (continuity
      ? r.dist < best.off - 1 || (Math.abs(r.dist - best.off) <= 1 && Math.abs(along - continuity.along) < Math.abs(best.along - continuity.along))
      : r.dist < best.off) best = { off: r.dist, along };
  }
  return best;
}

function build(place: PlaceResult, route: RouteResult, origin: Fix): Active {
  const cum = [0];
  for (let i = 1; i < route.path.length; i++) cum.push(cum[i - 1] + haversineM({ lat: route.path[i - 1][0], lng: route.path[i - 1][1] }, { lat: route.path[i][0], lng: route.path[i][1] }));
  const stepEndsAt: number[] = [];
  let acc = 0;
  const total = cum[cum.length - 1];
  const stepDistance = route.steps.reduce((sum, step) => sum + step.distanceM, 0);
  for (const s of route.steps) {
    acc += s.distanceM;
    const expected = stepDistance ? acc / stepDistance * total : total;
    // Provider distances follow detailed geometry; the displayed polyline can be simplified.
    // Locate the actual junction instead of comparing those different distance scales.
    let boundary = { along: expected, off: Infinity };
    for (let i = 0; i < route.path.length - 1; i++) {
      const p = project(s.end, route.path[i], route.path[i + 1]);
      const along = cum[i] + p.t * (cum[i + 1] - cum[i]);
      if (along < (stepEndsAt[stepEndsAt.length - 1] ?? 0)) continue;
      if (p.dist < boundary.off - 1 || (Math.abs(p.dist - boundary.off) <= 1 && Math.abs(along - expected) < Math.abs(boundary.along - expected))) boundary = { along, off: p.dist };
    }
    stepEndsAt.push(boundary.off <= OFF_ROUTE_M ? boundary.along : Math.max(stepEndsAt[stepEndsAt.length - 1] ?? 0, expected));
  }
  return { place, route, cum, stepEndsAt, lastStep: -1, preAnnounced: -1, nowAnnounced: -1, offCount: 0, lastReroute: 0, startedAt: Date.now(), lastFix: null, walkingSpeedMps: 1.2, matched: { along: 0, fix: origin } };
}

export function startRealNavigation(place: PlaceResult, opts: { announce?: boolean } = {}): Promise<RouteResult> {
  if (startingRoute?.generation === navigationGeneration && sameDestination(startingRoute.place, place)) return startingRoute.promise;
  const fix = freshFix();
  // A cached position (location off, indoors for long) would route from the wrong place.
  if (!fix) return Promise.reject(new Error('location-unavailable'));
  const generation = ++navigationGeneration;
  const promise = computeStart(place, fix, generation, opts);
  const request = { generation, place, promise };
  startingRoute = request;
  clearTimeout(arrivalTimer);
  arrivalTimer = undefined;
  if (active) {
    active.preAnnounced = -1;
    active.nowAnnounced = -1;
  }
  cancelInvalidAnnouncements();
  const clear = () => { if (startingRoute === request) startingRoute = null; };
  void promise.then(clear, clear);
  return promise;
}

async function computeStart(place: PlaceResult, fix: Fix, generation: number, opts: { announce?: boolean }) {
  // Cloud Function (Routes API) / in-app Maps DirectionsService (hedged), else OpenStreetMap.
  const route = await routeWalking({ lat: fix.lat, lng: fix.lng }, place);
  if (generation !== navigationGeneration) throw new Error('navigation-cancelled');
  validateRoute(route);
  startingRoute = null;
  clearPending();
  clearTimeout(arrivalTimer);
  arrivalTimer = undefined;
  active = build(place, route, fix);
  const started = active;
  unsubFix?.();
  unsubFix = onFix(onLocation);
  unsubLocation?.();
  unsubLocation = useLocation.subscribe(() => {
    if (!active || useNavView.getState().arrived) return;
    const current = freshFix();
    if (!current || current.accuracyM > GPS_DIRECTION_ACCURACY_M) pauseForGps(current);
  });
  unsubGuidance?.();
  unsubGuidance = useWalkingGuidance.subscribe(() => {
    if (!routeManeuverAllowed()) pauseForGuidance();
    // A released hold permits the next fresh GPS update to recompute the maneuver.
  });
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
  const currentFix = freshFix() ?? fix;
  const first = fixIsFresh(currentFix) && currentFix.accuracyM <= GPS_DIRECTION_ACCURACY_M ? route.steps[0]?.instruction : undefined;
  if (opts.announce !== false) announce(
    { en: `Walking to ${place.name}, ${Math.round(route.distanceM / 10) * 10} metres, about ${mins} minute${mins === 1 ? '' : 's'}.${first ? ` ${first}.` : ''}`, hi: `${place.name} तक पैदल, ${Math.round(route.distanceM / 10) * 10} मीटर, लगभग ${mins} मिनट।${first ? ` ${first}.` : ''}` },
    { nav: true, dedupeKey: 'nav-start', isCurrent: () => directionIsCurrent(started) },
  );
  onLocation(currentFix);
  return route;
}

export function stopRealNavigation(reason: 'user' | 'arrived' = 'user') {
  navigationGeneration++;
  startingRoute = null;
  reroutingRoute = null;
  clearTimeout(arrivalTimer);
  arrivalTimer = undefined;
  unsubFix?.();
  unsubFix = null;
  unsubLocation?.();
  unsubLocation = null;
  unsubGuidance?.();
  unsubGuidance = null;
  if (active && reason === 'user') logEvent({ kind: 'navigation', severity: 'info', title: `Stopped directions to ${active.place.name}` });
  else if (pending && reason === 'user') logEvent({ kind: 'navigation', severity: 'info', title: `Cancelled directions to ${pending.name}` });
  clearPending();
  active = null;
  saveActive(null);
  useNavView.setState(emptyNav());
  cancelInvalidAnnouncements();
}

export function reroute(): Promise<void> {
  const a = active;
  if (!a || useNavView.getState().arrived) return Promise.resolve();
  if (reroutingRoute?.active === a) return reroutingRoute.promise;
  const fix = freshFix();
  if (!fix || fix.accuracyM > GPS_DIRECTION_ACCURACY_M) {
    pauseForGps(fix);
    return Promise.resolve();
  }
  const promise = computeReroute(a, fix);
  const request = { active: a, promise };
  reroutingRoute = request;
  const clear = () => { if (reroutingRoute === request) reroutingRoute = null; };
  void promise.then(clear, clear);
  return promise;
}

async function computeReroute(a: Active, fix: Fix) {
  const generation = navigationGeneration;
  a.lastReroute = Date.now();
  a.preAnnounced = -1;
  a.nowAnnounced = -1;
  useNavView.setState({ rerouting: true, next: null, error: null, state: 'REROUTING' });
  cancelInvalidAnnouncements();
  try {
    const route = await routeWalking({ lat: fix.lat, lng: fix.lng }, a.place);
    if (active !== a || generation !== navigationGeneration || useNavView.getState().arrived) return;
    validateRoute(route);
    active = build(a.place, route, fix);
    active.lastReroute = a.lastReroute;
    const replacement = active;
    useNavView.setState({ path: route.path, totalM: route.distanceM, remainingM: route.distanceM, etaSec: route.durationS, next: null, offRoute: false, rerouting: false, error: null, state: 'NAVIGATING' });
    const current = freshFix();
    if (current) onLocation(current);
    else pauseForGps(null);
    announce({ en: 'New route found.', hi: 'New route found.' }, { high: true, dedupeKey: 'nav-reroute', isCurrent: () => directionIsCurrent(replacement) });
  } catch {
    if (active !== a || generation !== navigationGeneration || useNavView.getState().arrived) return;
    useNavView.setState({ rerouting: false, error: 'Could not get a new route. Directions may be out of date.', state: 'NAVIGATION_ERROR' });
    cancelInvalidAnnouncements();
  }
}

function onLocation(fix: Fix) {
  const a = active;
  if (!a) return;
  if (useNavView.getState().arrived) return;
  if (!fixIsFresh(fix) || fix.accuracyM > GPS_DIRECTION_ACCURACY_M) {
    pauseForGps(fixIsFresh(fix) ? fix : null);
    return;
  }
  if (a.lastFix && (fix.ts < a.lastFix.ts || (fix.ts === a.lastFix.ts && fix.lat === a.lastFix.lat && fix.lng === a.lastFix.lng))) return;
  a.lastFix = fix;
  if (startingRoute) {
    useNavView.setState({ next: null, updatedAt: Date.now() });
    cancelInvalidAnnouncements();
    return;
  }
  const elapsedS = Math.max(0, (fix.ts - a.matched.fix.ts) / 1000);
  const uncertaintyM = Math.min(30, Math.max(15, a.matched.fix.accuracyM + fix.accuracyM));
  const { along, off } = progressOnPath(a.route.path, a.cum, fix, { along: a.matched.along, maxTravelM: elapsedS * 3 + uncertaintyM });
  // Rejected fixes never become the next anchor: repeated spikes cannot ratchet progress.
  if (off <= OFF_ROUTE_M) a.matched = { along, fix };
  const total = a.cum[a.cum.length - 1] || a.route.distanceM;
  const remaining = Math.max(0, total - along);
  const toDest = haversineM(fix, { lat: a.place.lat, lng: a.place.lng });

  if (!routeManeuverAllowed()) {
    pauseForGuidance();
    return;
  }

  const arriveWithin = Math.max(ARRIVE_M, fix.accuracyM * 0.6);
  if (toDest <= arriveWithin && remaining <= arriveWithin && off <= OFF_ROUTE_M) {
    if (useNavView.getState().arrived) return; // already announced; waiting for the grace period to end
    useNavView.setState({ arrived: true, remainingM: 0, etaSec: 0, next: { text: 'Arrived', maneuver: 'arrive', inM: 0 }, updatedAt: Date.now(), state: 'ARRIVED' });
    cancelInvalidAnnouncements();
    haptics.play('arrive');
    const arrivalIsCurrent = () => !startingRoute && active === a && useNavView.getState().arrived && !!freshFix() && routeManeuverAllowed();
    void stickNavCue('arrive', arrivalIsCurrent);
    earcon('arrive');
    announce({ en: `You have arrived near ${a.place.name}. Please confirm the entrance with the camera or someone nearby.`, hi: `You have arrived near ${a.place.name}.` }, { high: true, isCurrent: arrivalIsCurrent });
    logEvent({ kind: 'navigation', severity: 'success', title: `Arrived near ${a.place.name}`, detail: `Walked about ${Math.round(total)} m` });
    const done = a;
    arrivalTimer = setTimeout(() => active === done && stopRealNavigation('arrived'), 8000);
    return;
  }

  if (remaining < 5 && off <= arriveWithin) {
    useNavView.setState({ state: 'NAVIGATION_ERROR', next: null, remainingM: remaining, etaSec: null, error: 'The mapped route ends before the destination. Please confirm the entrance with someone nearby.', updatedAt: Date.now() });
    cancelInvalidAnnouncements();
    return;
  }

  if (off > OFF_ROUTE_M) {
    a.offCount++;
    if (a.offCount === 2) {
      haptics.play('warning');
      const offRouteIsCurrent = () => !startingRoute && active === a && a.offCount >= 2 && !useNavView.getState().arrived && !!freshFix() && routeManeuverAllowed();
      void stickNavCue('off_route', offRouteIsCurrent);
      announce({ en: 'You are off the route. Finding a new one.', hi: 'आप रास्ते से हट गए हैं। नया रास्ता ढूँढ रही हूँ।' }, { nav: true, dedupeKey: 'nav-off', isCurrent: offRouteIsCurrent });
    }
    useNavView.setState({ offRoute: a.offCount >= 2 });
    if (a.offCount >= 3 && Date.now() - a.lastReroute > REROUTE_RETRY_MS) void reroute();
  } else {
    a.offCount = 0;
  }

  // A map projection still yields a nearby turn while off-route. Do not issue that turn until
  // the user is back on the route or the replacement route has actually finished loading.
  if (off > OFF_ROUTE_M || useNavView.getState().rerouting) {
    a.preAnnounced = -1;
    a.nowAnnounced = -1;
    useNavView.setState({ state: useNavView.getState().rerouting ? 'REROUTING' : a.offCount >= 2 ? 'OFF_ROUTE' : 'NAVIGATING', next: null, error: null, remainingM: remaining, etaSec: null, updatedAt: Date.now() });
    cancelInvalidAnnouncements();
    return;
  }

  let stepIdx = a.stepEndsAt.findIndex((end) => along < end);
  if (stepIdx === -1) stepIdx = a.route.steps.length - 1;
  // A GPS sample may skip over the junction itself. Keep that maneuver through its
  // short departure window rather than immediately announcing the following turn.
  const atLegStart = stepIdx > 0 && along - a.stepEndsAt[stepIdx - 1] <= NOW_M;
  const nextIdx = atLegStart ? stepIdx : Math.min(stepIdx + 1, a.route.steps.length - 1);
  const nextStep = a.route.steps[nextIdx];
  const toNext = atLegStart ? 0 : Math.max(0, a.stepEndsAt[stepIdx] - along);
  const man = maneuverFrom(nextStep?.maneuver, nextStep?.instruction);
  const finalLeg = nextIdx === stepIdx && !atLegStart;
  const pastLastTurn = along - (a.stepEndsAt[stepIdx - 1] ?? 0) > NOW_M;
  const nextInstruction = finalLeg && pastLastTurn ? `Continue along the mapped route toward ${a.place.name}` : nextStep?.instruction;

  // Ignore non-walking GPS speed spikes and smooth valid samples so ETA/lead time do not
  // jump on every location update. A stationary fix retains the last walking estimate.
  if (fix.speedMps != null && Number.isFinite(fix.speedMps) && fix.speedMps >= 0.35 && fix.speedMps <= 3) {
    a.walkingSpeedMps = a.lastStep === -1 ? fix.speedMps : a.walkingSpeedMps * 0.7 + fix.speedMps * 0.3;
  }
  a.lastStep = stepIdx;
  const speed = a.walkingSpeedMps;
  const preAnnounceM = Math.max(PRE_ANNOUNCE_M, Math.min(50, speed * 20));
  const maneuverNow = toNext <= NOW_M && fix.accuracyM <= GPS_MANEUVER_ACCURACY_M;
  let currentState: NavState = 'NAVIGATING';

  if (nextStep && !finalLeg) {
    if (toNext <= preAnnounceM) currentState = 'APPROACHING_MANEUVER';
    if (maneuverNow) currentState = 'MANEUVER_NOW';
  }

  useNavView.setState({
    offRoute: false,
    error: null,
    state: currentState,
    remainingM: remaining,
    etaSec: Math.round(remaining / speed),
    next: nextStep ? { text: nextInstruction!, maneuver: finalLeg && pastLastTurn ? 'straight' : man, inM: finalLeg ? 0 : toNext, stepIdx: nextIdx } : null,
    progressIdx: Math.max(0, a.cum.findIndex(c => c >= along)),
    updatedAt: Date.now(),
  });
  cancelInvalidAnnouncements();

  if (a.directionsPaused || (Date.now() - (a.lastProgressAt ?? a.startedAt) >= 90_000 && along - (a.lastProgressM ?? 0) >= 50)) {
    a.directionsPaused = false;
    a.lastProgressAt = Date.now();
    a.lastProgressM = along;
    const nextText = nextStep ? finalLeg ? ` ${nextInstruction}.` : ` In ${Math.max(0, Math.round(toNext))} metres, ${nextStep.instruction}.` : '';
    if (currentState === 'NAVIGATING') announce(`${Math.round(remaining)} metres remaining, about ${Math.max(1, Math.round(remaining / speed / 60))} minutes.${nextText}`, {
      nav: true, dedupeKey: 'nav-progress', isCurrent: () => directionIsCurrent(a) && useNavView.getState().next?.stepIdx === nextIdx,
    });
  }

  if (nextStep && !finalLeg) {
    if (toNext <= preAnnounceM && !maneuverNow && a.preAnnounced !== nextIdx) {
      a.preAnnounced = nextIdx;
      const upcomingIsCurrent = () => directionIsCurrent(a) && a.preAnnounced === nextIdx && useNavView.getState().next?.stepIdx === nextIdx && useNavView.getState().state === 'APPROACHING_MANEUVER';
      announce({ en: `In ${Math.round(toNext / 5) * 5 || 5} meters, ${nextStep.instruction}`, hi: `In ${Math.round(toNext / 5) * 5 || 5} meters, ${nextStep.instruction}` }, { nav: true, dedupeKey: 'nav-next', isCurrent: upcomingIsCurrent });
      void stickNavCue('upcoming', () => directionIsCurrent(a) && a.preAnnounced === nextIdx);
    }
    if (maneuverNow && a.nowAnnounced !== nextIdx) {
      a.nowAnnounced = nextIdx;
      announce(`Now, ${nextStep.instruction}`, { nav: true, high: true, dedupeKey: 'nav-now',
        isCurrent: () => directionIsCurrent(a) && a.nowAnnounced === nextIdx && useNavView.getState().next?.stepIdx === nextIdx && useNavView.getState().state === 'MANEUVER_NOW' });
      if (man === 'left' || man === 'right') {
        haptics.play(man);
        void stickNavCue(man, () => directionIsCurrent(a) && a.nowAnnounced === nextIdx && useNavView.getState().next?.stepIdx === nextIdx);
      }
      earcon('turn');
    }
  }

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
  if (fix && fix.accuracyM <= START_ACCURACY_M) return { status: 'started', route: await startRealNavigation(place, opts) };
  armNavigation(place, opts);
  return { status: 'waiting_for_gps' };
}

/**
 * Destination set, directions start from the first good fix (see navigateTo). announce:false when
 * the assistant model says it itself (otherwise the user hears the same sentence twice).
 */
export function armNavigation(place: PlaceResult, opts: { announce?: boolean } = {}) {
  navigationGeneration++;
  const generation = navigationGeneration;
  startingRoute = null;
  reroutingRoute = null;
  clearTimeout(arrivalTimer);
  arrivalTimer = undefined;
  unsubFix?.();
  unsubFix = null;
  unsubLocation?.();
  unsubLocation = null;
  unsubGuidance?.();
  unsubGuidance = null;
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
  cancelInvalidAnnouncements();
  logEvent({ kind: 'navigation', severity: 'info', title: `Destination set: ${place.name}`, detail: 'Directions start when GPS has a position' });
  if (opts.announce !== false) {
    announce(
      needPrecise
        ? { en: `Destination set: ${place.name}. Walking directions need Precise location. Please turn on Precise location for this app.`, hi: `मंज़िल तय: ${place.name}। रास्ते के लिए Precise location चालू करें।` }
        : { en: `Destination set: ${place.name}. Directions will start as soon as GPS finds your position.`, hi: `मंज़िल तय: ${place.name}। GPS मिलते ही रास्ता बताना शुरू करूँगी।` },
      { nav: true, dedupeKey: 'nav-wait', isCurrent: () => pending === place && generation === navigationGeneration },
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
  const attempt = {};
  pendingStarting = attempt;
  pendingLastTry = Date.now();
  try {
    await startRealNavigation(place);
  } catch (e) {
    if (pending !== place || pendingStarting !== attempt) return; // cancelled or replaced meanwhile
    const m = (e as Error)?.message;
    useNavView.setState({ error: m === 'no-route' ? 'No walking route found to this place.' : 'Could not get walking directions yet. Trying again…', updatedAt: Date.now() });
  } finally {
    if (pendingStarting === attempt) pendingStarting = null;
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
