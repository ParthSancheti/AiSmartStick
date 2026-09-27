import { tickNavigation } from '../nav/navigation';
import { useDevice } from '../store/device';

let started = false;

/** Runs the simulated world: walking along routes and cloud sync heartbeats. */
export function startWorld() {
  if (started) return;
  started = true;
  let last = performance.now();
  setInterval(() => {
    const now = performance.now();
    const dt = Math.min(1, (now - last) / 1000);
    last = now;
    tickNavigation(dt);
  }, 250);
  setInterval(() => {
    // The Guardian only sees fresh data while the stick user's phone has internet.
    if (useDevice.getState().internet) useDevice.setState({ lastSync: Date.now() });
  }, 1000);
}
