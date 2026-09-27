import type { Place } from '../types';
import { useNav } from '../store/nav';
import { getSettings } from '../store/session';
import { logEvent } from '../store/activity';
import { analyse, pointAt, route, UNIT_M, headingDeg } from '../sim/geo';
import { announce } from '../ai/voiceOut';
import { P } from '../ai/phrases';
import { haptics } from '../feedback/haptics';
import { earcon } from '../feedback/earcons';
import { userSurfaceActive } from '../surfaces';

/** Walking speed: 1.4 m/s = 0.7 map units per second (before demo speed-up). */
const WALK_U_PER_S = 0.7;
/** Pre-announce a turn this many map units ahead (≈ 24 m). */
const PRE_U = 12;

let resetTimer: ReturnType<typeof setTimeout> | undefined;

export function startNavigation(place: Place) {
  clearTimeout(resetTimer);
  const from = useNav.getState().userPos;
  const path = route(from, place.pos);
  const { cum, total, steps } = analyse(path);
  useNav.setState({
    active: true,
    place,
    path,
    cum,
    total,
    travelled: 0,
    steps,
    stepIdx: 0,
    preAnnounced: -1,
    arrived: false,
    headingDeg: path.length > 1 ? headingDeg(path[0], path[1]) : 0,
  });
  const lengthM = total * UNIT_M;
  const minutes = Math.max(1, Math.round(lengthM / 1.4 / 60));
  logEvent({ kind: 'navigation', severity: 'info', title: `Started directions to ${place.name}`, detail: `${Math.round(lengthM)} m, about ${minutes} min` });
  return { lengthM, minutes, first: steps[0] };
}

export function stopNavigation() {
  const s = useNav.getState();
  if (!s.active) return;
  if (!s.arrived) logEvent({ kind: 'navigation', severity: 'info', title: `Stopped directions to ${s.place?.name ?? 'destination'}` });
  useNav.setState({ active: false, place: null, path: [], cum: [], steps: [], total: 0, travelled: 0, arrived: false });
}

function turnFeedback(turn: 'left' | 'right') {
  if (!userSurfaceActive()) return;
  haptics.play(turn);
  earcon('turn');
}

export function tickNavigation(dt: number) {
  const s = useNav.getState();
  if (!s.active || s.arrived || s.path.length < 2) return;
  const travelled = Math.min(s.total, s.travelled + WALK_U_PER_S * getSettings().simSpeed * dt);
  const { pos, heading } = pointAt(s.path, s.cum, travelled);
  let stepIdx = s.stepIdx;
  while (stepIdx + 1 < s.steps.length && s.steps[stepIdx + 1].startAt <= travelled) stepIdx++;
  let preAnnounced = s.preAnnounced;

  const next = s.steps[stepIdx + 1];
  if (next && next.turn !== 'start' && next.turn !== 'arrive' && preAnnounced !== stepIdx + 1 && next.startAt - travelled <= PRE_U) {
    preAnnounced = stepIdx + 1;
    announce(P.turnSoon(next.turn, next.street, (next.startAt - travelled) * UNIT_M));
  }
  if (stepIdx !== s.stepIdx) {
    const step = s.steps[stepIdx];
    if (step.turn === 'left' || step.turn === 'right') {
      turnFeedback(step.turn);
      announce(P.turnNow(step.turn));
    }
  }

  const arrived = travelled >= s.total - 0.01;
  useNav.setState({ travelled, userPos: pos, headingDeg: heading, stepIdx, preAnnounced, arrived });

  if (arrived && s.place) {
    const place = s.place;
    if (userSurfaceActive()) {
      haptics.play('arrive');
      earcon('arrive');
    }
    announce(P.arrive(place));
    logEvent({ kind: 'navigation', severity: 'success', title: `Arrived at ${place.name}`, detail: `Walked ${Math.round(s.total * UNIT_M)} m` });
    resetTimer = setTimeout(() => {
      if (useNav.getState().arrived) stopNavigation();
    }, 6000);
  }
}
