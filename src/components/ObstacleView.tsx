import { useNow } from '../hooks/useNow';
import type { UltrasonicState } from '../core/telemetry/types';

/**
 * Forward obstacle view driven ONLY by the stick's ultrasonic sensor (single forward beam,
 * 2–400 cm). It draws what is measured — one distance straight ahead — and nothing else.
 * No echo is shown as "no echo", never as "clear".
 */
export function ObstacleView({ us, live, label }: { us: Pick<UltrasonicState, 'status' | 'distanceCm' | 'measuredAt'> | null; live: boolean; label?: string }) {
  const now = useNow(1000);
  const d = us?.status === 'ok' ? us.distanceCm : null;
  const fresh = !!us?.measuredAt && now - us.measuredAt < 3000;
  const status = !us || !live ? 'No sensor data' : us.status === 'ok' ? `${d} cm ahead` : us.status === 'no_echo' ? 'No echo (nothing detected in range)' : us.status === 'out_of_range' ? 'Beyond 4 m' : us.status === 'stale' ? 'Sensor not reporting' : us.status === 'invalid' ? 'Invalid reading' : us.status === 'error' ? 'Sensor error' : 'Waiting for sensor';
  // Map 0–400 cm onto the drawn corridor (y 280 → 90).
  const y = d == null ? null : 280 - Math.min(1, d / 400) * 190;
  const scale = y == null ? 1 : 0.45 + ((y - 90) / 190) * 0.75;
  const danger = d != null && d < 60;
  const near = d != null && d < 150;
  return (
    <div className="relative w-full overflow-hidden rounded-[20px] border border-white/5" style={{ background: '#0a1a1f' }}>
      <svg viewBox="0 0 400 320" className="block w-full" role="img" aria-label={`Obstacle sensor: ${status}`}>
        <defs>
          <linearGradient id="ov-bg" x1="0" y1="0" x2="0" y2="1">
            <stop offset="0%" stopColor="#0d2b35" />
            <stop offset="100%" stopColor="#071318" />
          </linearGradient>
          <linearGradient id="ov-beam" x1="0" y1="1" x2="0" y2="0">
            <stop offset="0%" stopColor="rgba(15,160,142,0.35)" />
            <stop offset="100%" stopColor="rgba(15,160,142,0.02)" />
          </linearGradient>
        </defs>
        <rect width="400" height="320" fill="url(#ov-bg)" />
        {[...Array(10)].map((_, i) => (
          <line key={i} x1="0" y1={100 + i * 20} x2="400" y2={100 + i * 20} stroke="rgba(255,255,255,0.05)" strokeWidth="0.5" />
        ))}
        {/* The ultrasonic beam: ~15° cone, 4 m */}
        <polygon points="200,286 150,90 250,90" fill="url(#ov-beam)" />
        {[100, 200, 300, 400].map((cm) => {
          const yy = 280 - (cm / 400) * 190;
          return (
            <g key={cm}>
              <line x1="120" y1={yy} x2="280" y2={yy} stroke="rgba(255,255,255,0.12)" strokeDasharray="4 6" />
              <text x="290" y={yy + 4} fill="rgba(255,255,255,0.45)" fontSize="10">{cm / 100} m</text>
            </g>
          );
        })}
        {y != null && live && (
          <g transform={`translate(200 ${y}) scale(${scale})`} opacity={fresh ? 1 : 0.4}>
            <rect x="-40" y="-26" width="80" height="30" rx="5" fill={danger ? 'var(--sos)' : near ? 'var(--amber)' : 'rgba(200,210,220,0.8)'} />
            <text x="0" y="-6" textAnchor="middle" fill="#fff" fontSize="14" fontWeight="bold">{d} cm</text>
          </g>
        )}
        <g transform="translate(193 272)">
          <rect x="0" y="0" width="14" height="40" rx="3" fill="#0fa08e" />
          <polygon points="7,-12 0,-2 14,-2" fill="rgba(15,160,142,0.9)" />
        </g>
      </svg>
      <div className="absolute left-3 top-3 flex items-center gap-2 rounded-full bg-black/50 px-3 py-1.5 text-[12px] font-bold text-white backdrop-blur-md">
        <span className={`h-2 w-2 rounded-full ${live && fresh ? 'bg-ok animate-pulse' : 'bg-white/40'}`} />
        {label ?? 'Ultrasonic sensor'} · {live && fresh ? 'Live' : 'Not live'}
      </div>
      <p className="absolute bottom-3 left-3 right-3 rounded-[12px] bg-black/50 px-3 py-2 text-center text-[13px] font-semibold text-white backdrop-blur-md">{status}</p>
    </div>
  );
}
