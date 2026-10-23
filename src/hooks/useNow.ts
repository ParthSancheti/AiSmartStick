import { useEffect, useState } from 'react';

export function useNow(intervalMs = 1000) {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    let id: ReturnType<typeof setInterval> | undefined;
    const sync = () => {
      if (id !== undefined) clearInterval(id);
      id = undefined;
      // These clocks only render freshness labels and counters. Native location,
      // navigation and SOS timers run independently of the presentation lifecycle.
      if (document.visibilityState === 'hidden') return;
      setNow(Date.now());
      id = setInterval(() => setNow(Date.now()), intervalMs);
    };
    sync();
    document.addEventListener('visibilitychange', sync);
    return () => {
      if (id !== undefined) clearInterval(id);
      document.removeEventListener('visibilitychange', sync);
    };
  }, [intervalMs]);
  return now;
}
