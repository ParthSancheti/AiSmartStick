/** Deterministic QR-looking pattern for the pairing screen (real QR generation comes with the backend). */
export function QrMock({ seed, size = 148 }: { seed: string; size?: number }) {
  const n = 25;
  let h = 0;
  for (const ch of seed) h = (h * 31 + ch.charCodeAt(0)) >>> 0;
  const rand = () => {
    h ^= h << 13;
    h ^= h >>> 17;
    h ^= h << 5;
    return ((h >>> 0) % 1000) / 1000;
  };
  const cells: [number, number][] = [];
  const finder = (x: number, y: number) => x < 8 && y < 8;
  for (let y = 0; y < n; y++)
    for (let x = 0; x < n; x++) {
      if (finder(x, y) || finder(n - 1 - x, y) || finder(x, n - 1 - y)) continue;
      if (rand() > 0.52) cells.push([x, y]);
    }
  const F = ({ x, y }: { x: number; y: number }) => (
    <g>
      <rect x={x} y={y} width="7" height="7" rx="1.6" fill="#10242a" />
      <rect x={x + 1} y={y + 1} width="5" height="5" rx="1.1" fill="#fff" />
      <rect x={x + 2} y={y + 2} width="3" height="3" rx=".8" fill="#10242a" />
    </g>
  );
  return (
    <svg viewBox={`-1 -1 ${n + 2} ${n + 2}`} width={size} height={size} role="img" aria-label="Pairing QR code">
      <rect x="-1" y="-1" width={n + 2} height={n + 2} rx="2" fill="#fff" />
      {cells.map(([x, y]) => (
        <rect key={`${x}-${y}`} x={x + 0.08} y={y + 0.08} width=".84" height=".84" rx=".25" fill="#10242a" />
      ))}
      <F x={0} y={0} />
      <F x={n - 7} y={0} />
      <F x={0} y={n - 7} />
    </svg>
  );
}
