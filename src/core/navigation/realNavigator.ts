import type { Fix } from '../location/locationService';
import { haversineM, onFix, useLocation } from '../location/locationService';
import { walkingRoute, type PlaceResult, type RouteResult } from '../maps/mapsService';
import { emptyNav, maneuverFrom, useNavView } from './navView';
import { logEvent } from '../store/activity';
import { announce } from '../ai/voiceOut';
import { haptics } from '../feedback/haptics';
import { earcon } from '../feedback/earcons';

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
  if (!fix) throw new Error('location-unavailable');
  const route = await walkingRoute({ origin: { lat: fix.lat, lng: fix.lng }, destination: { placeId: place.placeId } });
  if (!route.path.length) throw new Error('no-route');
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
  onLocation(fix);
  return route;
}

export function stopRealNavigation(reason: 'user' | 'arrived' = 'user') {
  unsubFix?.();
  unsubFix = null;
  if (active && reason === 'user') logEvent({ kind: 'navigation', severity: 'info', title: `Stopped directions to ${active.place.name}` });
  active = null;
  useNavView.setState(emptyNav());
}

export async function reroute() {
  const a = active;
  const fix = useLocation.getState().fix;
  if (!a || !fix) return;
  a.lastReroute = Date.now();
  useNavView.setState({ rerouting: true, state: 'REROUTING' });
  try {
    const route = await walkingRoute({ origin: { lat: fix.lat, lng: fix.lng }, destination: { placeId: a.place.placeId } });
    active = build(a.place, route);
    useNavView.setState({ path: route.path, totalM: route.distanceM, remainingM: route.distanceM, etaSec: route.durationS, offRoute: false, rerouting: false, error: null, state: 'NAVIGATING' });
    announce({ en: 'New route found.', hi: 'New route found.' }, { high: true, dedupeKey: 'nav-reroute' });
  } catch {
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
    haptics.play('arrive');
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
    }
    if (toNext <= NOW_M && a.nowAnnounced !== nextIdx) {
      a.nowAnnounced = nextIdx;
      if (man === 'left' || man === 'right') haptics.play(man);
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
export const currentDestination = () => active?.place ?? null;
