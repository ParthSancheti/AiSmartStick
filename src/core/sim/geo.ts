import type { Place, PlaceCategory, Point, RouteStep, Turn } from '../types';

/**
 * Demo world: a small street grid used by the mock map, navigation and "where am I".
 * In production this module is replaced by a maps provider (Google Maps / MapLibre)
 * behind the same function signatures.
 */
export const MAP_W = 400;
export const MAP_H = 600;
/** 1 map unit = 2 metres */
export const UNIT_M = 2;

export const AVENUES = [
  { x: 60, name: 'Hill Road' },
  { x: 150, name: 'Lake Road' },
  { x: 250, name: 'Station Road' },
  { x: 340, name: 'College Road' },
];
export const STREETS = [
  { y: 90, name: 'Market Street' },
  { y: 200, name: 'Park Street' },
  { y: 320, name: 'Temple Street' },
  { y: 440, name: 'Garden Lane' },
  { y: 540, name: 'River Road' },
];

export const START: Point = { x: 150, y: 500 };

export const PLACES: Place[] = [
  { id: 'aurora', name: 'Aurora Mall', nameHi: 'ऑरोरा मॉल', category: 'mall', pos: { x: 340, y: 130 }, address: 'College Road' },
  { id: 'pharmacy', name: 'City Pharmacy', nameHi: 'सिटी फ़ार्मेसी', category: 'pharmacy', pos: { x: 210, y: 440 }, address: 'Garden Lane' },
  { id: 'hospital', name: 'Lifeline Hospital', nameHi: 'लाइफ़लाइन हॉस्पिटल', category: 'hospital', pos: { x: 60, y: 250 }, address: 'Hill Road' },
  { id: 'bus', name: 'Temple Street bus stop', nameHi: 'टेम्पल स्ट्रीट बस स्टॉप', category: 'bus', pos: { x: 200, y: 320 }, address: 'Temple Street' },
  { id: 'atm', name: 'City Bank ATM', nameHi: 'सिटी बैंक एटीएम', category: 'atm', pos: { x: 150, y: 380 }, address: 'Lake Road' },
  { id: 'cafe', name: 'Brew Corner café', nameHi: 'ब्रू कॉर्नर कैफ़े', category: 'cafe', pos: { x: 300, y: 440 }, address: 'Garden Lane' },
  { id: 'home', name: 'Home', nameHi: 'घर', category: 'home', pos: { x: 110, y: 540 }, address: 'River Road' },
];
export const HOME = PLACES.find((p) => p.category === 'home')!;

const dist = (a: Point, b: Point) => Math.hypot(a.x - b.x, a.y - b.y);
const key = (p: Point) => `${Math.round(p.x)},${Math.round(p.y)}`;
const near = (a: number, b: number) => Math.abs(a - b) < 0.5;
const between = (v: number, a: number, b: number) => v >= Math.min(a, b) - 0.5 && v <= Math.max(a, b) + 0.5;

type Graph = Map<string, { p: Point; adj: Map<string, number> }>;

function baseGraph(): Graph {
  const g: Graph = new Map();
  const add = (p: Point) => {
    const k = key(p);
    if (!g.has(k)) g.set(k, { p, adj: new Map() });
    return k;
  };
  const link = (a: Point, b: Point) => {
    const ka = add(a);
    const kb = add(b);
    const d = dist(a, b);
    g.get(ka)!.adj.set(kb, d);
    g.get(kb)!.adj.set(ka, d);
  };
  for (const s of STREETS) for (let i = 0; i < AVENUES.length - 1; i++) link({ x: AVENUES[i].x, y: s.y }, { x: AVENUES[i + 1].x, y: s.y });
  for (const a of AVENUES) for (let i = 0; i < STREETS.length - 1; i++) link({ x: a.x, y: STREETS[i].y }, { x: a.x, y: STREETS[i + 1].y });
  return g;
}

export function snapToGrid(p: Point): Point {
  const minX = AVENUES[0].x, maxX = AVENUES[AVENUES.length - 1].x;
  const minY = STREETS[0].y, maxY = STREETS[STREETS.length - 1].y;
  const cands: Point[] = [
    ...AVENUES.map((a) => ({ x: a.x, y: Math.min(maxY, Math.max(minY, p.y)) })),
    ...STREETS.map((s) => ({ x: Math.min(maxX, Math.max(minX, p.x)), y: s.y })),
  ];
  return cands.reduce((best, c) => (dist(c, p) < dist(best, p) ? c : best), cands[0]);
}

function insertPoint(g: Graph, raw: Point): string {
  const p = snapToGrid(raw);
  const k = key(p);
  if (g.has(k)) return k;
  for (const [ka, na] of g) {
    for (const kb of na.adj.keys()) {
      const nb = g.get(kb)!;
      const onVertical = near(na.p.x, nb.p.x) && near(p.x, na.p.x) && between(p.y, na.p.y, nb.p.y);
      const onHorizontal = near(na.p.y, nb.p.y) && near(p.y, na.p.y) && between(p.x, na.p.x, nb.p.x);
      if (onVertical || onHorizontal) {
        na.adj.delete(kb);
        nb.adj.delete(ka);
        const node = { p, adj: new Map<string, number>() };
        g.set(k, node);
        const da = dist(p, na.p);
        const db = dist(p, nb.p);
        na.adj.set(k, da);
        node.adj.set(ka, da);
        nb.adj.set(k, db);
        node.adj.set(kb, db);
        return k;
      }
    }
  }
  return k;
}

function dijkstra(g: Graph, from: string, to: string): Point[] {
  const d = new Map<string, number>();
  const prev = new Map<string, string>();
  const open = new Set(g.keys());
  for (const k of g.keys()) d.set(k, Infinity);
  d.set(from, 0);
  while (open.size) {
    let u = '';
    let best = Infinity;
    for (const k of open) if (d.get(k)! < best) { best = d.get(k)!; u = k; }
    if (!u || u === to) break;
    open.delete(u);
    for (const [v, w] of g.get(u)!.adj) {
      const alt = best + w;
      if (alt < d.get(v)!) { d.set(v, alt); prev.set(v, u); }
    }
  }
  const out: Point[] = [];
  let cur: string | undefined = to;
  while (cur) { out.unshift(g.get(cur)!.p); cur = prev.get(cur); }
  return out;
}

function simplify(path: Point[]): Point[] {
  if (path.length < 3) return path;
  const out = [path[0]];
  for (let i = 1; i < path.length - 1; i++) {
    const a = out[out.length - 1], b = path[i], c = path[i + 1];
    const collinear = (near(a.x, b.x) && near(b.x, c.x)) || (near(a.y, b.y) && near(b.y, c.y));
    if (!collinear) out.push(b);
  }
  out.push(path[path.length - 1]);
  return out;
}

export function route(from: Point, to: Point): Point[] {
  const g = baseGraph();
  const a = insertPoint(g, from);
  const b = insertPoint(g, to);
  if (a === b) return [g.get(a)!.p, g.get(b)!.p];
  return simplify(dijkstra(g, a, b));
}

export function streetOf(a: Point, b: Point): string {
  if (near(a.x, b.x)) return AVENUES.find((v) => near(v.x, a.x))?.name ?? 'the road';
  return STREETS.find((s) => near(s.y, a.y))?.name ?? 'the road';
}

export function streetAt(p: Point): string {
  const s = snapToGrid(p);
  const av = AVENUES.find((v) => near(v.x, s.x));
  const st = STREETS.find((v) => near(v.y, s.y));
  return (av ?? st)?.name ?? 'an unnamed road';
}

const headingName = (a: Point, b: Point): RouteStep['heading'] => {
  const dx = b.x - a.x, dy = b.y - a.y;
  if (Math.abs(dx) > Math.abs(dy)) return dx > 0 ? 'east' : 'west';
  return dy > 0 ? 'south' : 'north';
};

export const headingDeg = (a: Point, b: Point) => (Math.atan2(b.y - a.y, b.x - a.x) * 180) / Math.PI + 90;

export function analyse(path: Point[]) {
  const cum = [0];
  for (let i = 1; i < path.length; i++) cum.push(cum[i - 1] + dist(path[i - 1], path[i]));
  const steps: RouteStep[] = [];
  for (let i = 0; i < path.length - 1; i++) {
    const a = path[i], b = path[i + 1];
    let turn: Turn = 'start';
    if (i > 0) {
      const p = path[i - 1];
      const cross = (a.x - p.x) * (b.y - a.y) - (a.y - p.y) * (b.x - a.x);
      turn = cross > 0 ? 'right' : 'left';
    }
    steps.push({ startAt: cum[i], turn, street: streetOf(a, b), lengthU: cum[i + 1] - cum[i], heading: headingName(a, b) });
  }
  return { cum, total: cum[cum.length - 1], steps };
}

export function pointAt(path: Point[], cum: number[], d: number): { pos: Point; heading: number } {
  if (path.length < 2) return { pos: path[0] ?? START, heading: 0 };
  let i = 0;
  while (i < cum.length - 2 && cum[i + 1] < d) i++;
  const a = path[i], b = path[i + 1];
  const seg = cum[i + 1] - cum[i] || 1;
  const t = Math.min(1, Math.max(0, (d - cum[i]) / seg));
  return { pos: { x: a.x + (b.x - a.x) * t, y: a.y + (b.y - a.y) * t }, heading: headingDeg(a, b) };
}

export function routeLengthM(from: Point, to: Point) {
  const p = route(from, to);
  return analyse(p).total * UNIT_M;
}

export function nearestPlace(category: PlaceCategory, from: Point): Place | null {
  const list = PLACES.filter((p) => p.category === category);
  if (!list.length) return null;
  return list.reduce((best, p) => (routeLengthM(from, p.pos) < routeLengthM(from, best.pos) ? p : best), list[0]);
}

export function nearestLandmark(from: Point): { place: Place; meters: number } {
  const list = PLACES.filter((p) => p.category !== 'home');
  const place = list.reduce((best, p) => (dist(from, p.pos) < dist(from, best.pos) ? p : best), list[0]);
  return { place, meters: dist(from, place.pos) * UNIT_M };
}
