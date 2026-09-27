import { useRuntime } from '../core/runtime/mode';
import { MockMap } from './MockMap';
import { RealMap, type MapPoint } from './RealMap';

/** One map slot, two sources: MockMap in DEMO, Google Maps in REAL. Layout is unchanged. */
export function MapView(props: { position: MapPoint | null; path?: [number, number][]; destination?: MapPoint | null; className?: string; stale?: boolean; mini?: boolean }) {
  const mode = useRuntime((s) => s.mode);
  if (mode === 'demo') return <MockMap mode={props.mini ? 'mini' : 'full'} className={props.className} />;
  return <RealMap {...props} />;
}
