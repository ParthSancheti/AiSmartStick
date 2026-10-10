import { useRuntime } from '../core/runtime/mode';
import { MockMap } from './MockMap';
import { RealMap, type MapPoint } from './RealMap';

export function MapView(props: { position: MapPoint | null; path?: [number, number][]; progressIdx?: number; destination?: MapPoint | null; className?: string; stale?: boolean; mini?: boolean; paddingBottom?: number; focus?: MapPoint | null; onMapClick?: (p: MapPoint) => void }) {
  const mode = useRuntime((s) => s.mode);
  if (mode === 'demo') return <MockMap mode={props.mini ? 'mini' : 'full'} className={props.className} />;
  return <RealMap {...props} mini={props.mini} />;
}
