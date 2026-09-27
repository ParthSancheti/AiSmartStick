import { useNav } from '../core/store/nav';
import { AVENUES, HOME, MAP_H, MAP_W, PLACES, STREETS } from '../core/sim/geo';
import type { Point } from '../core/types';
import { clamp } from '../core/util';

const pts = (p: Point[]) => p.map((q) => `${q.x},${q.y}`).join(' ');

/**
 * Stand-in for Google Maps / MapLibre. Same props the real map component will
 * take: follow the user, draw the active route, show the destination and home.
 */
export function MockMap({ mode = 'full', className }: { mode?: 'full' | 'mini'; className?: string }) {
  const user = useNav((s) => s.userPos);
  const heading = useNav((s) => s.headingDeg);
  const path = useNav((s) => s.path);
  const cum = useNav((s) => s.cum);
  const travelled = useNav((s) => s.travelled);
  const place = useNav((s) => s.place);
  const active = useNav((s) => s.active);

  // remaining part of the route, from the user onward
  let remaining: Point[] = [];
  if (active && path.length > 1) {
    let i = 0;
    while (i < cum.length - 2 && cum[i + 1] <= travelled) i++;
    remaining = [user, ...path.slice(i + 1)];
  }

  const mini = mode === 'mini';
  // Follow the user: mini keeps them centred; full keeps them in the upper-middle,
  // clear of the floating card at the bottom of the Map screen.
  const vbW = mini ? 200 : 280;
  const vbH = mini ? 150 : 460;
  const tx = mini ? 100 - user.x : vbW / 2 - clamp(user.x, 90, MAP_W - 90);
  const ty = mini ? 75 - user.y : 175 - clamp(user.y, 60, MAP_H - 40);

  const blocks: { x: number; y: number; w: number; h: number; kind: 'block' | 'park' | 'mall' }[] = [];
  const xs = [0, ...AVENUES.map((a) => a.x), MAP_W];
  const ys = [80, ...STREETS.map((s) => s.y), MAP_H];
  for (let i = 0; i < xs.length - 1; i++)
    for (let j = 0; j < ys.length - 1; j++) {
      const x = xs[i] + 9, y = ys[j] + 9, w = xs[i + 1] - xs[i] - 18, h = ys[j + 1] - ys[j] - 18;
      if (w < 8 || h < 8) continue;
      const kind = i === 1 && j === 1 ? 'park' : i === 3 && j === 1 ? 'mall' : 'block';
      blocks.push({ x, y, w, h, kind });
    }

  return (
    <svg
      className={className}
      viewBox={`0 0 ${vbW} ${vbH}`}
      preserveAspectRatio="xMidYMid slice"
      role="img"
      aria-label={place ? `Map showing the route to ${place.name}` : 'Map showing current location'}
    >
      <rect width={vbW} height={vbH} fill="var(--map-bg)" />
      <g style={{ transform: `translate(${tx}px, ${ty}px)`, transition: 'transform .35s linear' }}>
        <path d="M-40 -40 H440 V52 C 360 70 300 58 220 72 C 140 86 80 60 -40 74 Z" fill="var(--map-water)" />
        <text x="190" y="40" fontSize="11" fill="var(--map-label)" fontWeight="600">Lake</text>
        {blocks.map((b, i) => (
          <rect
            key={i}
            x={b.x}
            y={b.y}
            width={b.w}
            height={b.h}
            rx="7"
            fill={b.kind === 'park' ? 'var(--map-park)' : 'var(--map-block)'}
            stroke={b.kind === 'mall' ? 'var(--teal)' : 'none'}
            strokeOpacity=".35"
          />
        ))}
        {[118, 132, 104].map((x, i) => (
          <circle key={i} cx={x - 10 + i * 8} cy={130 + i * 18} r="9" fill="var(--map-park)" stroke="rgba(21,146,74,.25)" />
        ))}
        {STREETS.map((s) => (
          <g key={s.name}>
            <line x1={AVENUES[0].x - 60} x2={AVENUES[AVENUES.length - 1].x + 60} y1={s.y} y2={s.y} stroke="var(--map-edge)" strokeWidth="15" strokeLinecap="round" />
            <line x1={AVENUES[0].x - 60} x2={AVENUES[AVENUES.length - 1].x + 60} y1={s.y} y2={s.y} stroke="var(--map-road)" strokeWidth="12" strokeLinecap="round" />
          </g>
        ))}
        {AVENUES.map((a) => (
          <g key={a.name}>
            <line x1={a.x} x2={a.x} y1={STREETS[0].y - 30} y2={STREETS[STREETS.length - 1].y + 60} stroke="var(--map-edge)" strokeWidth="15" />
            <line x1={a.x} x2={a.x} y1={STREETS[0].y - 30} y2={STREETS[STREETS.length - 1].y + 60} stroke="var(--map-road)" strokeWidth="12" />
          </g>
        ))}
        {!mini &&
          STREETS.map((s) => (
            <text key={s.name} x={AVENUES[1].x + 12} y={s.y - 9} fontSize="8.5" fill="var(--map-label)" fontWeight="600">
              {s.name}
            </text>
          ))}
        {!mini &&
          AVENUES.map((a) => (
            <text key={a.name} x={a.x + 3} y={STREETS[3].y - 16} fontSize="8.5" fill="var(--map-label)" fontWeight="600" transform={`rotate(-90 ${a.x + 3} ${STREETS[3].y - 16})`}>
              {a.name}
            </text>
          ))}

        {remaining.length > 1 && (
          <>
            <polyline points={pts(path)} fill="none" stroke="var(--teal)" strokeOpacity=".22" strokeWidth="9" strokeLinejoin="round" strokeLinecap="round" />
            <polyline points={pts(remaining)} fill="none" stroke="var(--teal)" strokeWidth="6" strokeLinejoin="round" strokeLinecap="round" />
            <polyline points={pts(remaining)} fill="none" stroke="#ffffff" strokeOpacity=".7" strokeWidth="1.6" strokeDasharray="1 7" strokeLinecap="round" />
          </>
        )}

        {!mini &&
          PLACES.filter((p) => p.id !== place?.id && p.category !== 'home').map((p) => (
            <g key={p.id}>
              <circle cx={p.pos.x} cy={p.pos.y} r="4.5" fill="var(--surface)" stroke="var(--ink-3)" strokeWidth="1.5" />
              <text x={p.pos.x + 8} y={p.pos.y + 3} fontSize="8" fill="var(--ink-2)" fontWeight="600">
                {p.name}
              </text>
            </g>
          ))}

        <g transform={`translate(${HOME.pos.x} ${HOME.pos.y})`}>
          <circle r="9" fill="var(--surface)" stroke="var(--ink)" strokeWidth="1.5" />
          <path d="M-4.5 1 L0 -3.5 L4.5 1 V4.5 H-4.5 Z" fill="var(--ink)" />
        </g>

        {place && active && (
          <g transform={`translate(${place.pos.x} ${place.pos.y})`}>
            <path d="M0 0 C -9 -12 -11 -16 -11 -21 A 11 11 0 1 1 11 -21 C 11 -16 9 -12 0 0 Z" fill="var(--teal)" stroke="#fff" strokeWidth="2" />
            <circle cy="-21" r="4" fill="#fff" />
            {!mini && (
              <text x="14" y="-18" fontSize="10" fontWeight="700" fill="var(--ink)">
                {place.name}
              </text>
            )}
          </g>
        )}

        <g style={{ transform: `translate(${user.x}px, ${user.y}px)`, transition: 'transform .3s linear' }}>
          <circle r="10" fill="var(--teal)" opacity=".35" className="map-pulse" />
          <g transform={`rotate(${heading})`}>
            <path d="M0 0 L-12 -30 A 32 32 0 0 1 12 -30 Z" fill="var(--teal)" opacity=".22" />
          </g>
          <circle r="7.5" fill="var(--teal)" stroke="#fff" strokeWidth="3" />
        </g>
      </g>
    </svg>
  );
}
