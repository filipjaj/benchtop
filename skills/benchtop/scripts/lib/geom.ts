// Geometry behind the isometric drawings: the projection, what hides what, the shape
// a piece of text takes on the page, and the path of a wire.
//
// Everything here is a pure function of millimetres. The renderer (iso.ts) uses these
// to decide what to draw; the drawing check (drawing-check.ts) uses the same functions
// to decide whether what was drawn can be read. Neither looks at pixels.

export type Pt = [number, number];
export type V3 = [number, number, number];

// Orthographic view from 45 degrees round and ELEVATION degrees up. Flat-pack
// booklets sit near 21 degrees, which makes receding edges shallow; true isometric
// is 35.26. 30 keeps that flatter look while leaving the top face of a board open
// enough to read its pads, which matters more here than on a bookcase.
const ELEVATION = (30 * Math.PI) / 180;
export const C = Math.SQRT1_2;
export const S = Math.sin(ELEVATION) * Math.SQRT1_2;
export const Z = Math.cos(ELEVATION);

export const proj = (x: number, y: number, z: number): Pt => [(x - y) * C, (x + y) * S - z * Z];

/**
 * Direction from any point toward the camera. Moving along it does not change where a
 * point lands on the page, so two points on one such line hide each other, and the one
 * further along is in front.
 */
export const VIEW: V3 = [1, 1, Math.SQRT2 * Math.tan(ELEVATION)];

/**
 * Lift a page offset back into space. `side` moves a point sideways on the page and
 * `up` moves it up the page, neither changing the other, so any page point near a
 * world point can be given a world position.
 */
export const SIDE: V3 = [C, -C, 0];
export const unproject = (base: V3, dx: number, dy: number): V3 => [base[0] + SIDE[0] * dx, base[1] + SIDE[1] * dx, base[2] - dy / Z];

// ---------------------------------------------------------------------------
// Blocks: what can hide something
// ---------------------------------------------------------------------------

/** An upright box, or an upright cylinder standing in the middle of that box. */
export interface Block {
  kind: "box" | "cyl";
  x: number;
  y: number;
  z: number;
  w: number;
  d: number;
  h: number;
  r?: number;
}

/**
 * How much of the line from `p` toward the camera lies inside `b`, in millimetres of
 * that line. Zero means `b` does not hide `p`. A point on the surface of a block is
 * not hidden by it: a pad on a board's top face is in front of the board.
 */
export function hiddenDepth(p: V3, b: Block): number {
  let t0 = 0;
  let t1 = Infinity;
  const lo = [b.x, b.y, b.z];
  const hi = [b.x + b.w, b.y + b.d, b.z + b.h];
  for (let k = 0; k < 3; k++) {
    t0 = Math.max(t0, (lo[k]! - p[k]!) / VIEW[k]!);
    t1 = Math.min(t1, (hi[k]! - p[k]!) / VIEW[k]!);
  }
  if (t1 <= t0) return 0;
  if (b.kind === "cyl") {
    // (px + t - cx)^2 + (py + t - cy)^2 < r^2, since VIEW moves x and y equally.
    const r = b.r ?? b.w / 2;
    const dx = p[0] - (b.x + b.w / 2);
    const dy = p[1] - (b.y + b.d / 2);
    const disc = (dx + dy) * (dx + dy) - 2 * (dx * dx + dy * dy - r * r);
    if (disc <= 0) return 0;
    const root = Math.sqrt(disc);
    t0 = Math.max(t0, (-(dx + dy) - root) / 2);
    t1 = Math.min(t1, (-(dx + dy) + root) / 2);
    if (t1 <= t0) return 0;
  }
  return (t1 - t0) * Math.hypot(...VIEW);
}

/** Less than this much of a block in front of a point is a graze, not a hiding. */
export const HIDE_EPS = 0.02;

export const isHiddenBy = (p: V3, b: Block): boolean => hiddenDepth(p, b) > HIDE_EPS;

/** Indices of the blocks that hide `p`. */
export function occluders(p: V3, blocks: readonly Block[]): number[] {
  const out: number[] = [];
  for (let i = 0; i < blocks.length; i++) if (isHiddenBy(p, blocks[i]!)) out.push(i);
  return out;
}

export const isHidden = (p: V3, blocks: readonly Block[]): boolean => blocks.some((b) => isHiddenBy(p, b));

/** True when `p` is inside `b` by more than `margin` on every side. */
export function isInside(p: V3, b: Block, margin = 0): boolean {
  if (p[2] < b.z + margin || p[2] > b.z + b.h - margin) return false;
  if (b.kind === "cyl") {
    const r = (b.r ?? b.w / 2) - margin;
    return r > 0 && Math.hypot(p[0] - (b.x + b.w / 2), p[1] - (b.y + b.d / 2)) < r;
  }
  return p[0] > b.x + margin && p[0] < b.x + b.w - margin && p[1] > b.y + margin && p[1] < b.y + b.d - margin;
}

/** The outline a block makes on the page, as a convex polygon. */
export function silhouette(b: Block): Pt[] {
  if (b.kind === "cyl") {
    const r = b.r ?? b.w / 2;
    const cx = b.x + b.w / 2;
    const cy = b.y + b.d / 2;
    const top = proj(cx, cy, b.z + b.h);
    const bot = proj(cx, cy, b.z);
    const ry = r * Math.SQRT2 * S;
    const out: Pt[] = [];
    const n = 12;
    // Upper half of the top ellipse, then lower half of the bottom one.
    for (let i = 0; i <= n; i++) {
      const a = Math.PI + (i / n) * Math.PI;
      out.push([top[0] + Math.cos(a) * r, top[1] + Math.sin(a) * ry]);
    }
    for (let i = 0; i <= n; i++) {
      const a = (i / n) * Math.PI;
      out.push([bot[0] + Math.cos(a) * r, bot[1] + Math.sin(a) * ry]);
    }
    return out;
  }
  const { x, y, z, w, d, h } = b;
  return [proj(x, y, z + h), proj(x + w, y, z + h), proj(x + w, y, z), proj(x + w, y + d, z), proj(x, y + d, z), proj(x, y + d, z + h)];
}

// ---------------------------------------------------------------------------
// Convex polygons on the page
// ---------------------------------------------------------------------------

function span(poly: readonly Pt[], ax: number, ay: number): [number, number] {
  let lo = Infinity;
  let hi = -Infinity;
  for (const p of poly) {
    const v = p[0] * ax + p[1] * ay;
    lo = Math.min(lo, v);
    hi = Math.max(hi, v);
  }
  return [lo, hi];
}

/**
 * How deeply two convex polygons overlap, in millimetres: the shortest distance one
 * would have to move to clear the other. Negative when they are apart, by that gap
 * (measured along the best separating edge direction, so never more than the true gap).
 */
export function overlapDepth(a: readonly Pt[], b: readonly Pt[]): number {
  let best = Infinity;
  for (const poly of [a, b]) {
    for (let i = 0; i < poly.length; i++) {
      const p = poly[i]!;
      const q = poly[(i + 1) % poly.length]!;
      const len = Math.hypot(q[0] - p[0], q[1] - p[1]);
      if (len < 1e-9) continue;
      const ax = -(q[1] - p[1]) / len;
      const ay = (q[0] - p[0]) / len;
      const [a0, a1] = span(a, ax, ay);
      const [b0, b1] = span(b, ax, ay);
      best = Math.min(best, Math.min(a1, b1) - Math.max(a0, b0));
    }
  }
  return best;
}

export const polysOverlap = (a: readonly Pt[], b: readonly Pt[], clearance = 0): boolean => overlapDepth(a, b) > -clearance + 1e-9;

export function pointInConvex(p: Pt, poly: readonly Pt[]): boolean {
  let sign = 0;
  for (let i = 0; i < poly.length; i++) {
    const a = poly[i]!;
    const b = poly[(i + 1) % poly.length]!;
    const cross = (b[0] - a[0]) * (p[1] - a[1]) - (b[1] - a[1]) * (p[0] - a[0]);
    if (Math.abs(cross) < 1e-9) continue;
    if (sign === 0) sign = Math.sign(cross);
    else if (Math.sign(cross) !== sign) return false;
  }
  return true;
}

/** The part of segment a-b inside a convex polygon, as [t0, t1] along the segment, or null. */
export function clipToConvex(a: Pt, b: Pt, poly: readonly Pt[]): [number, number] | null {
  let area = 0;
  for (let i = 0; i < poly.length; i++) {
    const p = poly[i]!;
    const q = poly[(i + 1) % poly.length]!;
    area += p[0] * q[1] - q[0] * p[1];
  }
  const orient = area >= 0 ? 1 : -1;
  let t0 = 0;
  let t1 = 1;
  const dx = b[0] - a[0];
  const dy = b[1] - a[1];
  for (let i = 0; i < poly.length; i++) {
    const p = poly[i]!;
    const q = poly[(i + 1) % poly.length]!;
    // Inward normal of edge p-q.
    const nx = -(q[1] - p[1]) * orient;
    const ny = (q[0] - p[0]) * orient;
    const num = (a[0] - p[0]) * nx + (a[1] - p[1]) * ny;
    const den = dx * nx + dy * ny;
    if (Math.abs(den) < 1e-12) {
      if (num < 0) return null;
      continue;
    }
    const t = -num / den;
    if (den > 0) t0 = Math.max(t0, t);
    else t1 = Math.min(t1, t);
    if (t1 < t0) return null;
  }
  return [t0, t1];
}

/** Grow a convex polygon outward by `m` millimetres (approximately, by pushing each corner from the centre). */
export function inflate(poly: readonly Pt[], m: number): Pt[] {
  const cx = poly.reduce((s, p) => s + p[0], 0) / poly.length;
  const cy = poly.reduce((s, p) => s + p[1], 0) / poly.length;
  return poly.map((p) => {
    const len = Math.hypot(p[0] - cx, p[1] - cy) || 1;
    return [p[0] + ((p[0] - cx) / len) * m, p[1] + ((p[1] - cy) / len) * m] as Pt;
  });
}

/** True when a polyline (with a stroke of half-width `half`) touches a convex polygon. */
export function polylineHitsConvex(line: readonly Pt[], poly: readonly Pt[], half = 0): boolean {
  const target = half > 0 ? inflate(poly, half) : poly;
  for (let i = 0; i + 1 < line.length; i++) {
    if (clipToConvex(line[i]!, line[i + 1]!, target)) return true;
  }
  return line.length === 1 && pointInConvex(line[0]!, target);
}

export function circlePoly(c: Pt, r: number, n = 16): Pt[] {
  const out: Pt[] = [];
  for (let i = 0; i < n; i++) {
    const a = (i / n) * Math.PI * 2;
    out.push([c[0] + Math.cos(a) * r, c[1] + Math.sin(a) * r]);
  }
  return out;
}

export function polyBounds(poly: readonly Pt[]): { minX: number; minY: number; maxX: number; maxY: number } {
  let minX = Infinity;
  let minY = Infinity;
  let maxX = -Infinity;
  let maxY = -Infinity;
  for (const p of poly) {
    minX = Math.min(minX, p[0]);
    maxX = Math.max(maxX, p[0]);
    minY = Math.min(minY, p[1]);
    maxY = Math.max(maxY, p[1]);
  }
  return { minX, minY, maxX, maxY };
}

// ---------------------------------------------------------------------------
// Text
// ---------------------------------------------------------------------------

// Advance widths in ems for a semibold grotesque (Helvetica Neue, Arial, Noto Sans).
// Slightly generous, so a box computed here is never smaller than the printed word.
function glyphEm(ch: string): number {
  if (ch === " ") return 0.3;
  if ("il.,:;'|!".includes(ch)) return 0.32;
  if ("fjrt()-/".includes(ch)) return 0.42;
  if ("mwMW".includes(ch)) return 0.92;
  if (ch >= "0" && ch <= "9") return 0.62;
  if (ch >= "A" && ch <= "Z") return 0.76;
  if (ch >= "a" && ch <= "z") return 0.62;
  return 0.74;
}

/** Width of a word set at `size` millimetres. */
export const textWidth = (text: string, size: number): number => [...text].reduce((w, ch) => w + glyphEm(ch), 0) * size;

/** Part of the font size a capital letter rises above the baseline, and how far a descender drops. */
export const CAP = 0.74;
export const DESCENT = 0.08;

/**
 * The quadrilateral a line of text covers. `origin` is the anchor point on the page,
 * `eu` the page vector of one millimetre along the text and `ev` of one millimetre
 * down from the baseline, so the same function serves upright text and text lying on
 * a face of a solid.
 */
export function textQuad(origin: Pt, eu: Pt, ev: Pt, text: string, size: number, anchor: "start" | "middle" | "end"): Pt[] {
  const w = textWidth(text, size);
  const x0 = anchor === "start" ? 0 : anchor === "end" ? -w : -w / 2;
  const at = (x: number, y: number): Pt => [origin[0] + eu[0] * x + ev[0] * y, origin[1] + eu[1] * x + ev[1] * y];
  return [at(x0, -CAP * size), at(x0 + w, -CAP * size), at(x0 + w, DESCENT * size), at(x0, DESCENT * size)];
}

// ---------------------------------------------------------------------------
// Curves
// ---------------------------------------------------------------------------

export function bezier<T extends number[]>(p: readonly [T, T, T, T], t: number): T {
  const u = 1 - t;
  const k = [u * u * u, 3 * u * u * t, 3 * u * t * t, t * t * t];
  // The result has the arity of the control points; map() cannot express that.
  return p[0].map((_, i) => k[0]! * p[0][i]! + k[1]! * p[1][i]! + k[2]! * p[2][i]! + k[3]! * p[3][i]!) as T;
}

/**
 * The sharpest change of direction a path makes inside any `window` millimetres of
 * travel, in degrees. A gentle arc turns a long way over a long distance and scores
 * low; a wire that doubles back on itself turns 180 degrees in almost no distance.
 */
export function sharpestTurn(path: readonly Pt[], window: number): number {
  const heads: number[] = [];
  const at: number[] = [];
  let travelled = 0;
  for (let i = 0; i + 1 < path.length; i++) {
    const dx = path[i + 1]![0] - path[i]![0];
    const dy = path[i + 1]![1] - path[i]![1];
    const len = Math.hypot(dx, dy);
    if (len < 1e-9) continue;
    heads.push(Math.atan2(dy, dx));
    at.push(travelled + len / 2);
    travelled += len;
  }
  let worst = 0;
  let j = 0;
  for (let i = 0; i < heads.length; i++) {
    if (j < i) j = i;
    while (j + 1 < heads.length && at[j + 1]! - at[i]! <= window) j++;
    for (let k = i + 1; k <= j; k++) {
      let d = Math.abs(heads[k]! - heads[i]!);
      if (d > Math.PI) d = 2 * Math.PI - d;
      worst = Math.max(worst, d);
    }
  }
  return (worst * 180) / Math.PI;
}

/** How far a path travels backwards along the straight line between its ends, in millimetres. */
export function backtrack(path: readonly Pt[]): number {
  if (path.length < 2) return 0;
  const a = path[0]!;
  const b = path[path.length - 1]!;
  const len = Math.hypot(b[0] - a[0], b[1] - a[1]);
  if (len < 1e-9) return 0;
  const ux = (b[0] - a[0]) / len;
  const uy = (b[1] - a[1]) / len;
  let back = 0;
  let overshoot = 0;
  let prev = 0;
  for (const p of path) {
    const s = (p[0] - a[0]) * ux + (p[1] - a[1]) * uy;
    back += Math.max(0, prev - s);
    overshoot = Math.max(overshoot, -s, s - len);
    prev = s;
  }
  return Math.max(back, overshoot);
}
