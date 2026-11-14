// Plan-view drawing primitives: a part seen from straight above at true scale, its
// pad labels, the dimension lines of a mechanical drawing, and the geometry checks that
// the lane-style wiring plan runs on every build.
//
// Everything here works in millimetres of the real object. The caller decides the scale
// and wraps the markup in a transform (wiring) or multiplies coordinates (enclosure).
//
// Coordinates follow iso.ts: x runs right, y runs down the page, a part's origin is its
// top-left corner. Directions are named by where they point on the page: E = +x, W = -x,
// N = -y (up the page), S = +y.

import { HEAVY, THIN, esc, footprint, rotPoint } from "./iso";
import type { PinDef, PlacedPart } from "./types";

export type Pt = [number, number];
export type Dir = "E" | "W" | "N" | "S";

export interface Box {
  x0: number;
  y0: number;
  x1: number;
  y1: number;
}

export interface Rect {
  x: number;
  y: number;
  w: number;
  d: number;
}

export const FONT = `"Noto Sans","Helvetica Neue",Arial,sans-serif`;

/** Fixed drawing constants, all in mm of the real object. */
export const FLAT = {
  /** Cap height of a pin label. At 2:1 on A4 this prints as 2.6 mm. */
  pinCap: 1.1,
  /** Wire outline and core widths. */
  wireOutline: 0.5,
  wireCore: 0.32,
  /** Centre-to-centre distance of two wires that share one pad. */
  lane: 0.6,
  /** Radius of the pad ring and of the filled dot that marks a wire end. */
  padRing: 0.85,
  dot: 0.62,
} as const;

const f = (n: number): string => (Math.round(n * 100) / 100).toString();

/** One decimal, trailing ".0" dropped: 70 -> "70", 70.04 -> "70", 70.46 -> "70.5". */
export const fmt = (n: number): string => (Math.round(n * 10) / 10).toString();

// ---------------------------------------------------------------------------
// Text measurement
// ---------------------------------------------------------------------------

/** Width of a string in em, from rough per-glyph widths of Noto Sans / Arial. Errs wide. */
export function textWidth(text: string, fontSize: number, bold = true): number {
  let em = 0;
  for (const ch of text) {
    if ("il.,:;'|!1 ".includes(ch)) em += 0.32;
    else if ("mwMW".includes(ch)) em += 0.92;
    else if (/[A-Z]/.test(ch)) em += 0.7;
    else if (/[0-9]/.test(ch)) em += 0.6;
    else em += 0.56;
  }
  return em * fontSize * (bold ? 1.06 : 1);
}

export const overlap = (a: Box, b: Box, gap = 0): boolean =>
  a.x0 < b.x1 + gap && b.x0 < a.x1 + gap && a.y0 < b.y1 + gap && b.y0 < a.y1 + gap;

export const rectBox = (r: Rect): Box => ({ x0: r.x, y0: r.y, x1: r.x + r.w, y1: r.y + r.d });

export const grow = (b: Box, m: number): Box => ({ x0: b.x0 - m, y0: b.y0 - m, x1: b.x1 + m, y1: b.y1 + m });

export const unionBox = (a: Box, b: Box): Box => ({
  x0: Math.min(a.x0, b.x0),
  y0: Math.min(a.y0, b.y0),
  x1: Math.max(a.x1, b.x1),
  y1: Math.max(a.y1, b.y1),
});

// ---------------------------------------------------------------------------
// A part from above
// ---------------------------------------------------------------------------

export interface FlatPad {
  name: string;
  /** Pad centre in plan coordinates. */
  x: number;
  y: number;
  /** The way a wire leaves this pad: toward the part edge the pad is nearest. */
  dir: Dir;
  /** Distance from the pad centre to that edge. */
  edge: number;
  pin: PinDef;
}

export interface FlatPart {
  ref: string;
  /** Short human name for the drawing: the project's label, else the part name. */
  label: string;
  placed: PlacedPart;
  rect: Rect;
  pads: FlatPad[];
}

export const DIR_VEC: Record<Dir, Pt> = { E: [1, 0], W: [-1, 0], N: [0, -1], S: [0, 1] };
export const OPPOSITE: Record<Dir, Dir> = { E: "W", W: "E", N: "S", S: "N" };
export const isHoriz = (d: Dir): boolean => d === "E" || d === "W";

/** What the drawing calls a part: a resistor by its value ("1 k\u03a9"), anything else by its label. */
export function drawnName(p: PlacedPart): string {
  if (p.def.kind === "passive" && p.use.value) {
    return p.use.value
      .replace(/\s*(k|M)\s*ohms?/i, (_m, u: string) => ` ${u}\u03a9`)
      .replace(/\s*ohms?/i, " \u03a9")
      .trim();
  }
  return p.use.label ?? p.def.name;
}

export function flatPart(p: PlacedPart): FlatPart {
  const fp = footprint(p);
  const rect: Rect = { x: p.at.x, y: p.at.y, w: fp.w, d: fp.d };
  const pads = p.def.pins.map((pin): FlatPad => {
    const [dx, dy] = rotPoint(pin.x, pin.y, p.def.body.w, p.def.body.d, p.at.rot);
    const x = p.at.x + dx;
    const y = p.at.y + dy;
    const dist: [number, Dir][] = [
      [x - rect.x, "W"],
      [rect.x + rect.w - x, "E"],
      [y - rect.y, "N"],
      [rect.y + rect.d - y, "S"],
    ];
    dist.sort((a, b) => a[0] - b[0]);
    return { name: pin.name, x, y, dir: dist[0]![1], edge: dist[0]![0], pin };
  });
  // Pads in a straight row of three or more leave sideways from the row, even a pad that sits
  // nearer the end of the part than its side: a strip's corner pad still exits with the others.
  const nearest = new Map(pads.map((q) => [q, q.edge]));
  const line = (axis: "x" | "y"): void => {
    for (const a of pads) {
      const row = pads.filter((b) => Math.abs(b[axis] - a[axis]) < 0.3);
      if (row.length < 3) continue;
      const pair: [Dir, number][] =
        axis === "x"
          ? [["W", a.x - rect.x], ["E", rect.x + rect.w - a.x]]
          : [["N", a.y - rect.y], ["S", rect.y + rect.d - a.y]];
      pair.sort((m, n) => m[1] - n[1]);
      // A pad leaves with its row only when that edge is about as near as its own: a block of pads close to a side is not a row along the top.
      if (pair[0]![1] > nearest.get(a)! + 2) continue;
      a.dir = pair[0]![0];
      a.edge = pair[0]![1];
    }
  };
  line("x");
  line("y");
  return { ref: p.use.ref, label: drawnName(p), placed: p, rect, pads };
}

/** The same part turned to a new rotation, with its position kept at the top-left corner. */
export function turnedTo(p: PlacedPart, rot: 0 | 90 | 180 | 270): PlacedPart {
  return { ...p, at: { ...p.at, rot } };
}

/** Outline, footprints of every shape, mounting holes. Pads are drawn separately, on top. */
/**
 * `detail` is the stroke of the shapes inside the outline. A sheet that prints pin names
 * inside the part passes a grey, so the names read first and the chips and connectors
 * stay recognisable behind them.
 */
export function partBody(fp: FlatPart, detail = "#111"): string {
  const { def, at } = fp.placed;
  const W = def.body.w;
  const D = def.body.d;
  const r = fp.rect;
  let out = `<rect x="${f(r.x)}" y="${f(r.y)}" width="${f(r.w)}" height="${f(r.d)}" rx="0.7" fill="#fff" stroke="#111" stroke-width="${HEAVY}" stroke-linejoin="round"/>`;
  for (const sh of def.shapes ?? []) {
    if (sh.kind === "box") {
      const a = rotPoint(sh.x, sh.y, W, D, at.rot);
      const b = rotPoint(sh.x + sh.w, sh.y + sh.d, W, D, at.rot);
      out += `<rect x="${f(at.x + Math.min(a[0], b[0]))}" y="${f(at.y + Math.min(a[1], b[1]))}" width="${f(Math.abs(a[0] - b[0]))}" height="${f(Math.abs(a[1] - b[1]))}" fill="none" stroke="${detail}" stroke-width="${THIN}"/>`;
    } else {
      const c = rotPoint(sh.x, sh.y, W, D, at.rot);
      out += `<circle cx="${f(at.x + c[0])}" cy="${f(at.y + c[1])}" r="${f(sh.r)}" fill="none" stroke="${detail}" stroke-width="${THIN}"/>`;
    }
  }
  for (const h of def.holes ?? []) {
    const c = rotPoint(h.x, h.y, W, D, at.rot);
    out += `<circle cx="${f(at.x + c[0])}" cy="${f(at.y + c[1])}" r="${f(h.dia / 2)}" fill="#fff" stroke="#111" stroke-width="${THIN}"/>`;
  }
  return out;
}

/** Every pad as a ring with a small hole. */
export function partPads(fp: FlatPart): string {
  return fp.pads
    .map(
      (p) =>
        `<circle cx="${f(p.x)}" cy="${f(p.y)}" r="${FLAT.padRing}" fill="#fff" stroke="#111" stroke-width="${THIN}"/>` +
        `<circle cx="${f(p.x)}" cy="${f(p.y)}" r="0.35" fill="#111"/>`,
    )
    .join("");
}

// ---------------------------------------------------------------------------
// Labels
// ---------------------------------------------------------------------------

export interface PinLabel {
  ref: string;
  pad: string;
  text: string;
  /** Everything the label occupies, descenders included. */
  box: Box;
  /** SVG attributes of the <text> element. */
  transform: string;
  anchor: "start" | "end";
  dir: Dir;
  /** Inside the part outline next to its pad, as silkscreen is. False: no room, so it sits outside, beside the wire's corridor. */
  inside: boolean;
  /** Outside labels only: how far the label runs away from the part edge. */
  length: number;
  fontSize: number;
  /** Fan labels: a thin line from the pad to a label that stands away from it. */
  leader?: { a: Pt; b: Pt; width: number };
  /** Fan labels: false for the name of a pad no wire is soldered to. */
  wired?: boolean;
  /** Set by `fanLabels`: the name sits on a white halo whether or not it is inside the outline. */
  fan?: boolean;
}

const GLYPH = 0.714;
const EDGE_GAP = 0.35;
const f2 = (n: number): string => (Math.round(n * 100) / 100).toString();

/**
 * Pin names, like silkscreen: inside the outline beside the pad, on a white halo, turned to
 * read upward for pads on a top or bottom edge. Wires stay outside the outline, so they never
 * cross a name. A name that does not fit inside (a small part, pads close together) goes
 * outside instead, resting on its wire's line; `lanes` is how many wires leave each pad.
 */
export function pinLabels(fp: FlatPart, lanes: (pad: string) => number, cap: number = FLAT.pinCap): PinLabel[] {
  const out: PinLabel[] = [];
  const r = fp.rect;
  const fs = cap / GLYPH;
  const boxH = cap * 1.2;
  const inner = grow(rectBox(r), -0.12);
  const ring = FLAT.padRing + 0.1;
  const taken: Box[] = fp.pads.map((q) => ({ x0: q.x - ring, y0: q.y - ring, x1: q.x + ring, y1: q.y + ring }));
  const within = (b: Box): boolean => b.x0 >= inner.x0 && b.y0 >= inner.y0 && b.x1 <= inner.x1 && b.y1 <= inner.y1;
  fp.pads.forEach((p, idx) => {
    const w = textWidth(p.name, fs);
    let box: Box;
    let transform: string;
    let anchor: "start" | "end";
    if (p.dir === "E" || p.dir === "W") {
      const base = f2(p.y + cap * 0.5);
      if (p.dir === "E") {
        const x1 = p.x - ring - 0.05;
        box = { x0: x1 - w, y0: p.y - boxH / 2, x1, y1: p.y + boxH / 2 };
        transform = `translate(${f2(x1)} ${base})`;
        anchor = "end";
      } else {
        const x0 = p.x + ring + 0.05;
        box = { x0, y0: p.y - boxH / 2, x1: x0 + w, y1: p.y + boxH / 2 };
        transform = `translate(${f2(x0)} ${base})`;
        anchor = "start";
      }
    } else if (p.dir === "N") {
      const y0 = p.y + ring + 0.05;
      box = { x0: p.x - boxH / 2, y0, x1: p.x + boxH / 2, y1: y0 + w };
      transform = `translate(${f2(p.x + cap * 0.5)} ${f2(y0)}) rotate(-90)`;
      anchor = "end";
    } else {
      const y1 = p.y - ring - 0.05;
      box = { x0: p.x - boxH / 2, y0: y1 - w, x1: p.x + boxH / 2, y1 };
      transform = `translate(${f2(p.x + cap * 0.5)} ${f2(y1)}) rotate(-90)`;
      anchor = "start";
    }
    const clash = (): boolean =>
      taken.some((t, k) => k !== idx && overlap(box, t, -0.02)) || out.some((o) => o.inside && overlap(box, o.box, 0.1));
    if (within(box) && !clash()) {
      out.push({ ref: fp.ref, pad: p.name, text: p.name, box, transform, anchor, dir: p.dir, inside: true, length: 0, fontSize: fs });
      return;
    }
    // No room inside: outside, beside the corridor the wire takes, resting on the wire's line.
    const n = Math.max(1, lanes(p.name));
    const spread = ((n - 1) / 2) * FLAT.lane;
    const off = spread + FLAT.wireOutline / 2 + 0.08;
    const desc = cap * 0.2;
    const obox = cap * 1.18;
    let ob: Box;
    let ot: string;
    let oa: "start" | "end";
    if (p.dir === "E" || p.dir === "W") {
      const y1 = p.y - off;
      const y0 = y1 - obox;
      if (p.dir === "E") {
        const x0 = r.x + r.w + EDGE_GAP;
        ob = { x0, y0, x1: x0 + w, y1 };
        ot = `translate(${f2(x0)} ${f2(y1 - desc)})`;
        oa = "start";
      } else {
        const x1 = r.x - EDGE_GAP;
        ob = { x0: x1 - w, y0, x1, y1 };
        ot = `translate(${f2(x1)} ${f2(y1 - desc)})`;
        oa = "end";
      }
    } else {
      const x1 = p.x - off;
      const x0 = x1 - obox;
      if (p.dir === "N") {
        const y1 = r.y - EDGE_GAP;
        ob = { x0, y0: y1 - w, x1, y1 };
        ot = `translate(${f2(x1 - desc)} ${f2(y1)}) rotate(-90)`;
        oa = "start";
      } else {
        const y0 = r.y + r.d + EDGE_GAP;
        ob = { x0, y0, x1, y1: y0 + w };
        ot = `translate(${f2(x1 - desc)} ${f2(y0)}) rotate(-90)`;
        oa = "end";
      }
    }
    out.push({ ref: fp.ref, pad: p.name, text: p.name, box: ob, transform: ot, anchor: oa, dir: p.dir, inside: false, length: w + EDGE_GAP, fontSize: fs });
  });
  return out;
}

export function pinLabelMarkup(l: PinLabel): string {
  const halo = l.inside || l.fan ? ` paint-order="stroke" stroke="#fff" stroke-width="${f2(l.fontSize * 0.35)}" stroke-linejoin="round"` : "";
  const lead = l.leader
    ? `<line x1="${f2(l.leader.a[0])}" y1="${f2(l.leader.a[1])}" x2="${f2(l.leader.b[0])}" y2="${f2(l.leader.b[1])}" stroke="#111" stroke-width="${f2(l.leader.width)}" class="pin-leader"/>`
    : "";
  const cls = l.wired === false ? "pin pin-off" : "pin";
  return `${lead}<text transform="${l.transform}" text-anchor="${l.anchor}" font-size="${f2(l.fontSize)}" class="${cls}" data-ref="${esc(l.ref)}" data-pad="${esc(l.pad)}"${halo}>${esc(l.text)}</text>`;
}

// ---------------------------------------------------------------------------
// Fan labels: the names of the wired pads on the wiring plan
// ---------------------------------------------------------------------------
//
// A wire always leaves its pad outward, perpendicular to the nearest edge, and stays outside
// the part's outline from there on. A name therefore goes on the other side of its pad, into
// the body, where no stub of this or any other pad can come: the two never meet, whatever the
// pad pitch. When names of neighbouring pads would touch each other they are spread sideways
// along the edge, each kept in the order of its pad, and joined to their pads by thin leaders
// that cannot cross (equal rows, same order). Text size is the caller's: print size does not
// follow the drawing scale, so the pitch of the pads is not allowed to shrink it.

export interface FanOptions {
  /** Cap height of the names, mm of the object. */
  cap: number;
  /** Pads a wire is soldered to: these are named whatever it takes. */
  wired: Set<string>;
  /** Gap between a pad's ring and the start of its name, mm of the object. */
  lead: number;
  /** How far a name may stick out past the side of the outline, mm of the object. */
  overhang: number;
  /** Stroke of a leader, mm of the object. */
  leaderWidth: number;
  /** Text printed instead of a pad's own name (its number in the part's pin key); missing pads keep their name. */
  names?: Map<string, string>;
}

/** Positions nearest to `a` that keep order and stay `s` apart inside [lo, hi]; null when they cannot. Isotonic regression, then clamped. */
export function spreadOut(a: number[], lo: number, hi: number, s: number): number[] | null {
  const k = a.length;
  if (k === 0) return [];
  if (hi - lo < (k - 1) * s - 1e-9) return null;
  const blocks: { sum: number; n: number }[] = [];
  a.forEach((x, i) => {
    blocks.push({ sum: x - i * s, n: 1 });
    while (blocks.length > 1) {
      const last = blocks[blocks.length - 1]!;
      const prev = blocks[blocks.length - 2]!;
      if (prev.sum / prev.n <= last.sum / last.n) break;
      blocks.splice(blocks.length - 2, 2, { sum: prev.sum + last.sum, n: prev.n + last.n });
    }
  });
  const base: number[] = [];
  for (const b of blocks) for (let j = 0; j < b.n; j++) base.push(b.sum / b.n);
  return base.map((m, i) => Math.min(Math.max(m, lo), hi - (k - 1) * s) + i * s);
}

/**
 * Where a pad's wire first goes: nowhere (0, 0) when no pad stands straight out from it, else a hop sideways along
 * the edge, between two columns of pads. A pad with pads straight out from it (the inner row of a 2 x N header,
 * the middle row of a 3 x N block) would run through them. With `n` pads in its column and `r` of them outside it,
 * it hops r/n of a column: every pad of the column gets its own corridor, and `spacing` is the distance between
 * two corridors. Every hop goes toward +x or +y, so hops of neighbouring columns never meet.
 */
export function hopOf(fp: FlatPart, q: FlatPad): { hop: Pt; spacing: number } {
  const alongX = q.dir === "N" || q.dir === "S";
  const u = (p: FlatPad): number => (alongX ? p.x : p.y);
  const v = (p: FlatPad): number => (alongX ? p.y : p.x);
  // Distance out along the leaving direction: bigger is nearer the edge the wire leaves by.
  const outAt = (p: FlatPad): number => (q.dir === "S" || q.dir === "E" ? v(p) : -v(p));
  // The stack: pads in the same column, side by side at the usual pitch (a block of rows; another block further along the column is not in the way of this one).
  const column = fp.pads.filter((r) => Math.abs(u(r) - u(q)) < 0.3).sort((a, b) => outAt(a) - outAt(b));
  const gaps = column.slice(1).map((p, i) => outAt(p) - outAt(column[i]!)).filter((g) => g > 0.3);
  const pitch = gaps.length ? Math.min(...gaps) : Infinity;
  const at = column.indexOf(q);
  let lo = at;
  while (lo > 0 && outAt(column[lo]!) - outAt(column[lo - 1]!) <= pitch * 1.6) lo--;
  let hi = at;
  while (hi < column.length - 1 && outAt(column[hi + 1]!) - outAt(column[hi]!) <= pitch * 1.6) hi++;
  const stack = hi - lo + 1;
  const r = hi - at;
  if (!r) {
    // Not in line with any pad, but close enough to one that the wire would touch its ring (an inner row offset half a
    // column from the outer row): it steps to the middle of the gap between the two outer pads beside it.
    const clear = FLAT.padRing + FLAT.wireOutline / 2 + 0.2;
    const outward = fp.pads.filter((p) => p !== q && outAt(p) > outAt(q) && Math.abs(u(p) - u(q)) < clear);
    if (!outward.length) return { hop: [0, 0], spacing: Infinity };
    const ahead = [...new Set(fp.pads.filter((p) => p !== q && outAt(p) > outAt(q) && Math.abs(v(p) - v(outward[0]!)) < 0.3).map(u))].sort((a, b) => a - b);
    const below = ahead.filter((x) => x <= u(q) + 1e-9).pop();
    const above = ahead.find((x) => x > u(q) + 1e-9);
    let centre: number;
    let room: number;
    if (below !== undefined && above !== undefined) {
      centre = (below + above) / 2;
      room = (above - below) / 2;
    } else {
      // Beside the end of the row: clear of its last pad.
      centre = below !== undefined ? below + clear + 0.2 : above! - clear - 0.2;
      room = clear + 0.2;
    }
    return { hop: alongX ? [centre - u(q), 0] : [0, centre - u(q)], spacing: room };
  }
  // The column pitch is read off the pads that leave by the same edge: pads of another edge sit at unrelated positions.
  const us = fp.pads.filter((p) => p.dir === q.dir).map(u).sort((a, b) => a - b);
  let gap = Infinity;
  for (let i = 1; i < us.length; i++) if (us[i]! - us[i - 1]! > 0.3) gap = Math.min(gap, us[i]! - us[i - 1]!);
  const g = Number.isFinite(gap) ? gap : 1.5 * stack;
  const h = (g * r) / stack;
  return { hop: alongX ? [h, 0] : [0, h], spacing: g / stack };
}

/** The names, and whether every group of wired names found a place inside the part's own body. */
export function fanLayout(fp: FlatPart, o: FanOptions): { labels: PinLabel[]; clean: boolean } {
  let clean = true;
  const r = fp.rect;
  const fs = o.cap / GLYPH;
  const boxH = o.cap * 1.2;
  /** Centre to centre of two names side by side. */
  const sp = boxH + o.cap * 0.3;
  const ring = FLAT.padRing + 0.1;
  const inner = grow(rectBox(r), -0.12);
  const rings: Box[] = fp.pads.map((q) => ({ x0: q.x - ring, y0: q.y - ring, x1: q.x + ring, y1: q.y + ring }));
  // The part of a stub inside the outline: pad to the edge it leaves through.
  const stubs: Box[] = fp.pads
    .filter((q) => o.wired.has(q.name))
    .flatMap((q) => {
      const [hx, hy] = hopOf(fp, q).hop;
      const ax = q.x + hx;
      const ay = q.y + hy;
      const e: Pt = q.dir === "N" ? [ax, r.y] : q.dir === "S" ? [ax, r.y + r.d] : q.dir === "W" ? [r.x, ay] : [r.x + r.w, ay];
      const seg = (p: Pt, s: Pt): Box => grow({ x0: Math.min(p[0], s[0]), y0: Math.min(p[1], s[1]), x1: Math.max(p[0], s[0]), y1: Math.max(p[1], s[1]) }, FLAT.wireOutline / 2);
      return hx || hy ? [seg([q.x, q.y], [ax, ay]), seg([ax, ay], e)] : [seg([q.x, q.y], e)];
    });

  interface Cand {
    pad: FlatPad;
    box: Box;
    transform: string;
    anchor: "start" | "end";
    leader?: { a: Pt; b: Pt; width: number };
  }
  const shown = (p: FlatPad): string => o.names?.get(p.name) ?? p.name;
  const textLen = (p: FlatPad): number => textWidth(shown(p), fs);
  /** A name on the inward side of its pad, centred at `b` along the edge, its near end `v` from the origin of the inward axis. */
  const build = (p: FlatPad, b: number, row: number): Cand => {
    const w = textLen(p);
    const off = ring + o.lead + row;
    let box: Box;
    let transform: string;
    let anchor: "start" | "end";
    let tip: Pt;
    if (p.dir === "N") {
      const y0 = p.y + off;
      box = { x0: b - boxH / 2, y0, x1: b + boxH / 2, y1: y0 + w };
      transform = `translate(${f2(b + o.cap * 0.5)} ${f2(y0)}) rotate(-90)`;
      anchor = "end";
      tip = [b, y0];
    } else if (p.dir === "S") {
      const y1 = p.y - off;
      box = { x0: b - boxH / 2, y0: y1 - w, x1: b + boxH / 2, y1 };
      transform = `translate(${f2(b + o.cap * 0.5)} ${f2(y1)}) rotate(-90)`;
      anchor = "start";
      tip = [b, y1];
    } else if (p.dir === "W") {
      const x0 = p.x + off;
      box = { x0, y0: b - boxH / 2, x1: x0 + w, y1: b + boxH / 2 };
      transform = `translate(${f2(x0)} ${f2(b + o.cap * 0.5)})`;
      anchor = "start";
      tip = [x0, b];
    } else {
      const x1 = p.x - off;
      box = { x0: x1 - w, y0: b - boxH / 2, x1, y1: b + boxH / 2 };
      transform = `translate(${f2(x1)} ${f2(b + o.cap * 0.5)})`;
      anchor = "end";
      tip = [x1, b];
    }
    const out: Cand = { pad: p, box, transform, anchor };
    // A leader only where the name stands off its pad sideways or in a second row.
    const side = p.dir === "N" || p.dir === "S" ? Math.abs(b - p.x) : Math.abs(b - p.y);
    if (side > o.cap * 0.25 || row > 0) {
      const dx = tip[0] - p.x;
      const dy = tip[1] - p.y;
      const len = Math.hypot(dx, dy);
      out.leader = { a: [p.x + (dx / len) * ring * 0.8, p.y + (dy / len) * ring * 0.8], b: tip, width: o.leaderWidth };
    }
    return out;
  };

  const seg = (c: Cand): Seg | undefined => (c.leader ? [c.leader.a, c.leader.b] : undefined);
  const clash = (c: Cand, others: Cand[]): boolean => {
    if (rings.some((t) => overlap(c.box, t, -0.02))) return true;
    if (stubs.some((t) => overlap(c.box, t, -0.02))) return true;
    for (const x of others) {
      if (overlap(c.box, x.box, o.cap * 0.1)) return true;
      const s = seg(x);
      if (s && clipLength(s[0], s[1], grow(c.box, 0.05)) > 1e-3) return true;
      const t = seg(c);
      if (t && clipLength(t[0], t[1], grow(x.box, 0.05)) > 1e-3) return true;
      if (s && t && relate(s, t, 0).kind !== "none") return true;
    }
    return false;
  };
  /** Along the edge a name may overhang the outline by `over`; strict also keeps it between the edges, so it never leaves the body. */
  const fitsOutline = (b: Box, dir: Dir, strict: boolean, over: number): boolean => {
    const alongX = dir === "N" || dir === "S";
    const acrossOk = alongX ? b.x0 >= inner.x0 - over && b.x1 <= inner.x1 + over : b.y0 >= inner.y0 - over && b.y1 <= inner.y1 + over;
    const depthOk = alongX ? b.y0 >= inner.y0 && b.y1 <= inner.y1 : b.x0 >= inner.x0 && b.x1 <= inner.x1;
    return acrossOk && (!strict || depthOk);
  };
  /** A narrow part cannot hold the names of its pads side by side: they may stand out past its ends, and the plan leaves room there. */
  const wide = o.cap * 5;

  const horiz = (d: Dir): boolean => d === "E" || d === "W";
  const placed: Cand[] = [];
  const wiredPads = fp.pads.filter((q) => o.wired.has(q.name));
  for (const dir of ["N", "S", "W", "E"] as Dir[]) {
    const group = wiredPads.filter((q) => q.dir === dir).sort((p, q) => (horiz(dir) ? p.y - q.y : p.x - q.x));
    if (!group.length) continue;
    const pos = (q: FlatPad): number => (horiz(dir) ? q.y : q.x);
    const attempt = (rows: 1 | 2, strict: boolean, over: number): Cand[] | null => {
      const lo = (horiz(dir) ? r.y : r.x) - over + boxH / 2;
      const hi = (horiz(dir) ? r.y + r.d : r.x + r.w) + over - boxH / 2;
      const cands: Cand[] = [];
      const row0 = group.filter((_, i) => rows === 1 || i % 2 === 0);
      const row1 = group.filter((_, i) => rows === 2 && i % 2 === 1);
      const longest = Math.max(...row0.map(textLen));
      for (const [list, off] of [[row0, 0], [row1, longest + o.cap * 0.4]] as [FlatPad[], number][]) {
        const b = spreadOut(list.map(pos), lo, hi, sp);
        if (!b) return null;
        list.forEach((q, i) => cands.push(build(q, b[i]!, off)));
      }
      for (let i = 0; i < cands.length; i++) {
        const c = cands[i]!;
        if (!fitsOutline(c.box, dir, strict, over) || clash(c, [...placed, ...cands.slice(0, i)])) return null;
      }
      return cands;
    };
    // In order of preference: one row inside the outline; one row standing out a little past its ends;
    // two rows; and last, a row that also runs past the far edge.
    let got = attempt(1, true, o.overhang) ?? attempt(1, true, wide) ?? attempt(2, true, o.overhang) ?? attempt(2, true, wide);
    if (!got) {
      // Not in the body at this size: the caller may draw the part larger. The rest runs the names past the far edge.
      clean = false;
      got = attempt(1, false, wide) ?? attempt(2, false, wide);
    }
    if (!got) {
      // Nothing is clean. Print the names under their pads anyway: the check on the plan says what they touch.
      got = group.map((q) => build(q, pos(q), 0));
    }
    placed.push(...got);
  }

  const toLabel = (c: Cand, wired: boolean): PinLabel => ({
    ref: fp.ref,
    pad: c.pad.name,
    text: shown(c.pad),
    box: c.box,
    transform: c.transform,
    anchor: c.anchor,
    dir: c.pad.dir,
    inside: c.box.x0 >= r.x && c.box.x1 <= r.x + r.w && c.box.y0 >= r.y && c.box.y1 <= r.y + r.d,
    length: 0,
    fontSize: fs,
    leader: c.leader,
    wired,
    fan: true,
  });
  const out = placed.map((c) => toLabel(c, true));

  // Names of pads nothing is soldered to: only when every one of them fits beside its pad.
  const rest = fp.pads.filter((q) => !o.wired.has(q.name));
  const extra: Cand[] = [];
  let all = rest.length > 0;
  for (const q of rest) {
    const c = build(q, horiz(q.dir) ? q.y : q.x, 0);
    if (!fitsOutline(c.box, q.dir, true, o.overhang) || clash(c, [...placed, ...extra])) {
      all = false;
      break;
    }
    extra.push(c);
  }
  if (all) out.push(...extra.map((c) => toLabel(c, false)));
  return { labels: out, clean };
}

export function fanLabels(fp: FlatPart, o: FanOptions): PinLabel[] {
  return fanLayout(fp, o).labels;
}

/** The same part with every length multiplied by k, for a part that has to be drawn larger than the sheet's scale. */
export function scaledPart(p: PlacedPart, k: number): PlacedPart {
  if (k === 1) return p;
  const def = p.def;
  return {
    ...p,
    def: {
      ...def,
      body: { ...def.body, w: def.body.w * k, d: def.body.d * k },
      pins: def.pins.map((q) => ({ ...q, x: q.x * k, y: q.y * k })),
      shapes: def.shapes?.map((sh) =>
        sh.kind === "box" ? { ...sh, x: sh.x * k, y: sh.y * k, w: sh.w * k, d: sh.d * k } : { ...sh, x: sh.x * k, y: sh.y * k, r: sh.r * k },
      ),
      holes: def.holes?.map((h) => ({ x: h.x * k, y: h.y * k, dia: h.dia * k })),
    },
  };
}

export interface PartLabel {
  ref: string;
  box: Box;
  markup: string;
}

/** Width of a part's name and ref as `partLabel` sets them. */
export function partLabelWidth(fp: FlatPart, fontSize: number, note?: string): number {
  return textWidth(fp.label, fontSize) + textWidth(`  ${fp.ref}`, fontSize * 0.85, false) + (note ? textWidth(`  ${note}`, fontSize * 0.7, false) : 0);
}

/**
 * Name and ref above the part (below it with `below`). Starts just clear of the outline and
 * moves away until it clears every box in `taken` (pin labels, other parts, wires, other labels).
 */
export function partLabel(fp: FlatPart, fontSize: number, taken: Box[], below = false, note?: string): PartLabel {
  const name = fp.label;
  const ref = fp.ref;
  const w = partLabelWidth(fp, fontSize, note);
  const h = fontSize * 1.2;
  const cx = fp.rect.x + fp.rect.w / 2;
  const at = (y1: number): Box => ({ x0: cx - w / 2, y0: y1 - h, x1: cx + w / 2, y1 });
  let y1 = below ? fp.rect.y + fp.rect.d + 1.1 + h : fp.rect.y - 1.1;
  let box = at(y1);
  for (let i = 0; i < 120 && taken.some((t) => overlap(box, t, 0.15)); i++) {
    y1 += below ? 0.5 : -0.5;
    box = at(y1);
  }
  const base = box.y1 - fontSize * 0.28;
  const markup =
    `<text x="${f(box.x0)}" y="${f(base)}" font-size="${f(fontSize)}" class="part" data-ref="${esc(ref)}">${esc(name)}` +
    `<tspan class="ref" font-size="${f(fontSize * 0.85)}" dx="${f(fontSize * 0.5)}">${esc(ref)}</tspan>` +
    (note ? `<tspan class="ref" font-size="${f(fontSize * 0.7)}" dx="${f(fontSize * 0.5)}">${esc(note)}</tspan>` : "") +
    `</text>`;
  return { ref, box, markup };
}

// ---------------------------------------------------------------------------
// Wire geometry
// ---------------------------------------------------------------------------

/** Merge repeated points and drop vertices that lie on a straight run. */
export function tidy(points: Pt[]): Pt[] {
  const out: Pt[] = [];
  for (const p of points) {
    const last = out[out.length - 1];
    if (last && Math.abs(last[0] - p[0]) < 1e-6 && Math.abs(last[1] - p[1]) < 1e-6) continue;
    out.push(p);
  }
  for (let i = out.length - 2; i > 0; i--) {
    const a = out[i - 1]!;
    const b = out[i]!;
    const c = out[i + 1]!;
    const cross = (b[0] - a[0]) * (c[1] - b[1]) - (b[1] - a[1]) * (c[0] - b[0]);
    const dot = (b[0] - a[0]) * (c[0] - b[0]) + (b[1] - a[1]) * (c[1] - b[1]);
    if (Math.abs(cross) < 1e-6 && dot > 0) out.splice(i, 1);
  }
  return out;
}
// ---------------------------------------------------------------------------
// Dimensions (paper millimetres)
// ---------------------------------------------------------------------------

export const DIM = { font: 2.9, arrow: 2.1, gap: 1, over: 1.6, stroke: 0.18 } as const;

function arrowHead(x: number, y: number, dx: number, dy: number): string {
  const l = DIM.arrow;
  const w = DIM.arrow * 0.17;
  const bx = x - dx * l;
  const by = y - dy * l;
  return `<polygon points="${f(x)},${f(y)} ${f(bx - dy * w)},${f(by + dx * w)} ${f(bx + dy * w)},${f(by - dx * w)}" fill="#111"/>`;
}

// ---------------------------------------------------------------------------
// The sheet ledger: what is already on a sheet, in paper millimetres
// ---------------------------------------------------------------------------
//
// Every text, outline and dimension line of a case or fit-check sheet is entered here as it is
// placed. A new text asks `free` before it goes down, and `checkSheet` runs over the finished
// sheet, so a sheet with an overlap cannot print as clean.

export type ItemKind =
  /** Text: must touch nothing else on the sheet. */
  | "text"
  /** A heavy outline (a view, a part): text may lie wholly inside or wholly outside it, never across its line. */
  | "outline"
  /** Something drawn solid (an opening, a screw): no text on it. */
  | "solid"
  /** A dimension or extension line: no text on it but its own. */
  | "line";

export interface SheetItem {
  id: string;
  kind: ItemKind;
  box: Box;
  /** Items of one group (a dimension's line and number) may touch each other. */
  group?: string;
  /** The project input that moves this item, named in the message when it is part of an overlap. */
  moves: string;
}

/** Half-width of the band a heavy outline occupies, with its stroke. */
const OUTLINE_BAND = 0.3;

/** The conflict between two items, or null. */
function conflict(a: SheetItem, b: SheetItem, gap: number): boolean {
  if (a.group !== undefined && a.group === b.group) return false;
  const text = (i: SheetItem): boolean => i.kind === "text";
  if (!text(a) && !text(b)) return false;
  const [t, o] = text(a) ? [a, b] : [b, a];
  if (o.kind === "outline") {
    const band = grow(o.box, OUTLINE_BAND + gap);
    const inner = grow(o.box, -(OUTLINE_BAND + gap));
    const inside = t.box.x0 >= inner.x0 && t.box.x1 <= inner.x1 && t.box.y0 >= inner.y0 && t.box.y1 <= inner.y1;
    return overlap(t.box, band) && !inside;
  }
  return overlap(t.box, o.box, gap > 0 ? gap : -0.02);
}

export class Sheet {
  readonly items: SheetItem[] = [];

  add(item: SheetItem): void {
    this.items.push(item);
  }

  /** Whether `item` could be placed without touching what is here. */
  free(item: SheetItem, gap = 0.3): boolean {
    return !this.items.some((o) => conflict(item, o, gap));
  }
}

/** One line per overlap on a finished sheet; empty when it is clean. */
export function checkSheet(sheet: Sheet, name: string): string[] {
  const out: string[] = [];
  const s = sheet.items;
  for (let i = 0; i < s.length; i++) {
    for (let j = i + 1; j < s.length; j++) {
      const a = s[i]!;
      const b = s[j]!;
      if (!conflict(a, b, 0)) continue;
      const what = a.kind === "text" && b.kind === "text" ? "overlaps" : "is drawn on";
      const [x, y] = a.kind === "text" ? [a, b] : [b, a];
      out.push(`${name}: "${x.id}" ${what} "${y.id}"; to clear it move ${x.moves}${y.moves !== x.moves ? `, or ${y.moves}` : ""}`);
    }
  }
  return out;
}

/** Box of a text drawn with its baseline at y, anchored at x, in paper mm. Errs a little large. */
export function textBox(x: number, baseline: number, text: string, fontSize: number, anchor: "start" | "middle" | "end" = "start", bold = false): Box {
  const w = textWidth(text, fontSize, bold);
  const x0 = anchor === "start" ? x : anchor === "middle" ? x - w / 2 : x - w;
  return { x0, y0: baseline - fontSize * 0.8, x1: x0 + w, y1: baseline + fontSize * 0.22 };
}

/** The shapes a part draws that stand out past its outline (a connector, an antenna), each as a box. */
export function overhangingShapes(fp: FlatPart): Box[] {
  const { def, at } = fp.placed;
  const W = def.body.w;
  const D = def.body.d;
  const out: Box[] = [];
  for (const sh of def.shapes ?? []) {
    let b: Box;
    if (sh.kind === "box") {
      const p = rotPoint(sh.x, sh.y, W, D, at.rot);
      const q = rotPoint(sh.x + sh.w, sh.y + sh.d, W, D, at.rot);
      b = { x0: at.x + Math.min(p[0], q[0]), y0: at.y + Math.min(p[1], q[1]), x1: at.x + Math.max(p[0], q[0]), y1: at.y + Math.max(p[1], q[1]) };
    } else {
      const c = rotPoint(sh.x, sh.y, W, D, at.rot);
      b = { x0: at.x + c[0] - sh.r, y0: at.y + c[1] - sh.r, x1: at.x + c[0] + sh.r, y1: at.y + c[1] + sh.r };
    }
    const r = fp.rect;
    if (b.x0 < r.x - 0.01 || b.y0 < r.y - 0.01 || b.x1 > r.x + r.w + 0.01 || b.y1 > r.y + r.d + 0.01) out.push(grow(b, 0.2));
  }
  return out;
}

/** Box of everything a part draws: its outline and the shapes that stand out past it. */
export function partExtent(fp: FlatPart): Box {
  return overhangingShapes(fp).reduce(unionBox, grow(rectBox(fp.rect), 0.2));
}

export interface DimOpts {
  /** Machine-readable tag, so a test can find the number a drawing prints. */
  kind?: string;
  value: number;
  /** Text printed instead of the value, e.g. "4 x 3". */
  text?: string;
  /** Where to enter the dimension's number and lines, so nothing else is put on them. */
  sheet?: Sheet;
  /** Names the dimension in a check message and ties its number to its lines. */
  id?: string;
}

function dimItems(o: DimOpts, label: string, text: Box, lines: Box[]): void {
  if (!o.sheet) return;
  const group = `dim:${o.id ?? label}:${o.sheet.items.length}`;
  const name = `dimension ${o.id ?? label}`;
  o.sheet.add({ id: name, kind: "text", box: text, group, moves: "the dimensioned feature" });
  for (const b of lines) o.sheet.add({ id: `${name} line`, kind: "line", box: b, group, moves: "the dimensioned feature" });
}

/** Horizontal dimension between x0 and x1, measured from the object at yObj, line drawn at yLine. */
export function dimHoriz(x0: number, x1: number, yObj0: number, yObj1: number, yLine: number, o: DimOpts): string {
  const [a, b] = x0 < x1 ? [x0, x1] : [x1, x0];
  const sgn = yLine < Math.min(yObj0, yObj1) ? -1 : 1;
  const ext = (x: number, yObj: number): string =>
    `<line x1="${f(x)}" y1="${f(yObj + sgn * DIM.gap)}" x2="${f(x)}" y2="${f(yLine + sgn * DIM.over)}"/>`;
  const label = o.text ?? fmt(o.value);
  const tw = textWidth(label, DIM.font, false);
  const inside = b - a >= DIM.arrow * 2 + 1;
  let out = `<g class="dim" stroke="#111" stroke-width="${DIM.stroke}" fill="none">${ext(a, yObj0)}${ext(b, yObj1)}`;
  if (inside) {
    out += `<line x1="${f(a)}" y1="${f(yLine)}" x2="${f(b)}" y2="${f(yLine)}"/></g>`;
    out += arrowHead(a, yLine, -1, 0) + arrowHead(b, yLine, 1, 0);
  } else {
    out += `<line x1="${f(a - DIM.arrow - 2)}" y1="${f(yLine)}" x2="${f(b + DIM.arrow + 2)}" y2="${f(yLine)}"/></g>`;
    out += arrowHead(a, yLine, 1, 0) + arrowHead(b, yLine, -1, 0);
  }
  const textX = tw + 1 <= b - a ? (a + b) / 2 : b + DIM.arrow + 3 + tw / 2;
  const hl = inside ? [a, b] : [a - DIM.arrow - 2, b + DIM.arrow + 2];
  const extBox = (x: number, yObj: number): Box => ({ x0: x - 0.1, x1: x + 0.1, y0: Math.min(yObj + sgn * DIM.gap, yLine + sgn * DIM.over), y1: Math.max(yObj + sgn * DIM.gap, yLine + sgn * DIM.over) });
  dimItems(o, label, textBox(textX, yLine - 0.9, label, DIM.font, "middle"), [{ x0: hl[0]!, x1: hl[1]!, y0: yLine - 0.1, y1: yLine + 0.1 }, extBox(a, yObj0), extBox(b, yObj1)]);
  out += `<text x="${f(textX)}" y="${f(yLine - 0.9)}" text-anchor="middle" font-size="${DIM.font}" class="dim-text"${o.kind ? ` data-dim="${esc(o.kind)}"` : ""} data-value="${fmt(o.value)}" paint-order="stroke" stroke="#fff" stroke-width="1.1">${esc(label)}</text>`;
  return out;
}

/** Vertical dimension between y0 and y1, measured from the object at xObj, line drawn at xLine. */
export function dimVert(y0: number, y1: number, xObj0: number, xObj1: number, xLine: number, o: DimOpts): string {
  const [a, b] = y0 < y1 ? [y0, y1] : [y1, y0];
  const sgn = xLine < Math.min(xObj0, xObj1) ? -1 : 1;
  const ext = (y: number, xObj: number): string =>
    `<line x1="${f(xObj + sgn * DIM.gap)}" y1="${f(y)}" x2="${f(xLine + sgn * DIM.over)}" y2="${f(y)}"/>`;
  const label = o.text ?? fmt(o.value);
  const tw = textWidth(label, DIM.font, false);
  const inside = b - a >= DIM.arrow * 2 + 1;
  let out = `<g class="dim" stroke="#111" stroke-width="${DIM.stroke}" fill="none">${ext(a, xObj0)}${ext(b, xObj1)}`;
  if (inside) {
    out += `<line x1="${f(xLine)}" y1="${f(a)}" x2="${f(xLine)}" y2="${f(b)}"/></g>`;
    out += arrowHead(xLine, a, 0, -1) + arrowHead(xLine, b, 0, 1);
  } else {
    out += `<line x1="${f(xLine)}" y1="${f(a - DIM.arrow - 2)}" x2="${f(xLine)}" y2="${f(b + DIM.arrow + 2)}"/></g>`;
    out += arrowHead(xLine, a, 0, 1) + arrowHead(xLine, b, 0, -1);
  }
  // The text runs along the line, reading upward. A span too short for it puts it past the far arrow.
  const ty = tw + 1 <= b - a ? (a + b) / 2 : a - DIM.arrow - 3 - tw / 2;
  const vl = inside ? [a, b] : [a - DIM.arrow - 2, b + DIM.arrow + 2];
  const extBox = (y: number, xObj: number): Box => ({ y0: y - 0.1, y1: y + 0.1, x0: Math.min(xObj + sgn * DIM.gap, xLine + sgn * DIM.over), x1: Math.max(xObj + sgn * DIM.gap, xLine + sgn * DIM.over) });
  dimItems(o, label, { x0: xLine - 0.9 - DIM.font * 0.8, x1: xLine - 0.9 + DIM.font * 0.22, y0: ty - tw / 2, y1: ty + tw / 2 }, [{ x0: xLine - 0.1, x1: xLine + 0.1, y0: vl[0]!, y1: vl[1]! }, extBox(a, xObj0), extBox(b, xObj1)]);
  out += `<text transform="translate(${f(xLine - 0.9)} ${f(ty)}) rotate(-90)" text-anchor="middle" font-size="${DIM.font}" class="dim-text"${o.kind ? ` data-dim="${esc(o.kind)}"` : ""} data-value="${fmt(o.value)}" paint-order="stroke" stroke="#fff" stroke-width="1.1">${esc(label)}</text>`;
  return out;
}

// ---------------------------------------------------------------------------
// Checks over the finished geometry
// ---------------------------------------------------------------------------

export type Seg = [Pt, Pt];

const EPS = 1e-6;
const cross2 = (a: Pt, b: Pt): number => a[0] * b[1] - a[1] * b[0];
const sub = (a: Pt, b: Pt): Pt => [a[0] - b[0], a[1] - b[1]];

/** Length of the part of segment a-b that lies inside the open box (Liang-Barsky clip). */
export function clipLength(a: Pt, b: Pt, box: Box): number {
  let t0 = 0;
  let t1 = 1;
  const dx = b[0] - a[0];
  const dy = b[1] - a[1];
  const p = [-dx, dx, -dy, dy];
  const q = [a[0] - box.x0, box.x1 - a[0], a[1] - box.y0, box.y1 - a[1]];
  for (let i = 0; i < 4; i++) {
    const pi = p[i]!;
    const qi = q[i]!;
    if (Math.abs(pi) < EPS) {
      if (qi <= 0) return 0;
      continue;
    }
    const r = qi / pi;
    if (pi < 0) {
      if (r > t1) return 0;
      if (r > t0) t0 = r;
    } else {
      if (r < t0) return 0;
      if (r < t1) t1 = r;
    }
  }
  return Math.max(0, t1 - t0) * Math.hypot(dx, dy);
}

export type Relation =
  | { kind: "none" }
  | { kind: "cross"; at: Pt; perpendicular: boolean }
  | { kind: "touch"; at: Pt }
  | { kind: "overlap" };

/**
 * How two wire segments meet. Parallel segments within `clear` of each other that share more
 * than a hair of length overlap; segments that meet end-on touch; the rest cross, at a right
 * angle or not.
 */
export function relate(a: Seg, b: Seg, clear: number): Relation {
  const ua = sub(a[1], a[0]);
  const ub = sub(b[1], b[0]);
  const la = Math.hypot(ua[0], ua[1]);
  const lb = Math.hypot(ub[0], ub[1]);
  if (la < EPS || lb < EPS) return { kind: "none" };
  const d = cross2(ua, ub);
  const w = sub(b[0], a[0]);
  if (Math.abs(d) < 1e-9 * la * lb) {
    if (Math.abs(cross2(ua, w)) / la >= clear) return { kind: "none" };
    const t0 = (w[0] * ua[0] + w[1] * ua[1]) / la;
    const t1 = t0 + (ub[0] * ua[0] + ub[1] * ua[1]) / la;
    const lo = Math.max(0, Math.min(t0, t1));
    const hi = Math.min(la, Math.max(t0, t1));
    return hi - lo > 1e-3 ? { kind: "overlap" } : { kind: "none" };
  }
  const t = cross2(w, ub) / d;
  const u = cross2(w, ua) / d;
  const tol = 1e-6;
  if (t < -tol / la || t > 1 + tol / la || u < -tol / lb || u > 1 + tol / lb) return { kind: "none" };
  const at: Pt = [a[0][0] + ua[0] * t, a[0][1] + ua[1] * t];
  const ends = t * la < tol || (1 - t) * la < tol || u * lb < tol || (1 - u) * lb < tol;
  if (ends) return { kind: "touch", at };
  return { kind: "cross", at, perpendicular: Math.abs(ua[0] * ub[0] + ua[1] * ub[1]) / (la * lb) < 1e-3 };
}

export interface LaneWire {
  step: number;
  /** Wires of different nets must not meet; wires of one net may share a stub and a lane. */
  net: string;
  from: { ref: string; pin: string };
  to: { ref: string; pin: string };
  /** Pad to pad, straight segments. */
  path: Pt[];
  /** The wire leaves its first pad by a hop sideways first (see `hopOf`): its first two runs are inside the part. */
  hopFrom?: boolean;
  /** The same at its last pad. */
  hopTo?: boolean;
}

export interface LaneLabel {
  id: string;
  box: Box;
  /** Wires of this net may run under the label: a step tag sits on its own lane. */
  net?: string;
  /** The part whose outline the label may lie in. Any other part must stay clear of it. */
  inside?: string;
}

export interface LaneCheck {
  parts: { ref: string; rect: Rect }[];
  labels: LaneLabel[];
  wires: LaneWire[];
  /** "ref.pin" to the pad centre. */
  pads: Map<string, Pt>;
  /** Every connection of the project: each must be drawn once, pad to pad. */
  steps: { step: number; from: { ref: string; pin: string }; to: { ref: string; pin: string } }[];
  /** Wire outline width, mm. */
  wire: number;
}

const segsOf = (path: Pt[]): Seg[] => path.slice(0, -1).map((p, i) => [p, path[i + 1]!]);

/** Distinct places where wires of different nets cross, for counting. */
export function crossingPoints(wires: LaneWire[], wire: number): Pt[] {
  const seen = new Map<string, Pt>();
  for (let i = 0; i < wires.length; i++) {
    for (let j = i + 1; j < wires.length; j++) {
      const wi = wires[i]!;
      const wj = wires[j]!;
      if (wi.net === wj.net) continue;
      for (const a of segsOf(wi.path)) {
        for (const b of segsOf(wj.path)) {
          const r = relate(a, b, wire);
          if (r.kind !== "cross") continue;
          const [n1, n2] = wi.net < wj.net ? [wi.net, wj.net] : [wj.net, wi.net];
          seen.set(`${n1}|${n2}|${r.at[0].toFixed(3)}|${r.at[1].toFixed(3)}`, r.at);
        }
      }
    }
  }
  return [...seen.values()];
}

/**
 * Everything wrong with a lane plan, one line per problem; empty when it is clean. Pure
 * geometry: parts as rectangles, labels as boxes, wires as polylines. A wire of one net
 * crossing a wire of another at a right angle is how the plan is meant to read, so it is not
 * a problem; anything else where two nets meet is.
 */
export function checkLanes(c: LaneCheck): string[] {
  const out = new Set<string>();
  const near = (a: Pt, b: Pt): boolean => Math.hypot(a[0] - b[0], a[1] - b[1]) < 1e-3;

  // Every connection drawn once, from its own pad to its own pad.
  for (const s of c.steps) {
    const ws = c.wires.filter((w) => w.step === s.step);
    if (ws.length !== 1) {
      out.add(`step ${s.step} is drawn ${ws.length} times, not once`);
      continue;
    }
    const w = ws[0]!;
    const a = c.pads.get(`${s.from.ref}.${s.from.pin}`);
    const b = c.pads.get(`${s.to.ref}.${s.to.pin}`);
    if (!a || !w.path[0] || !near(w.path[0], a)) out.add(`step ${s.step}: the wire does not start on pad ${s.from.ref}.${s.from.pin}`);
    if (!b || !w.path[w.path.length - 1] || !near(w.path[w.path.length - 1]!, b)) out.add(`step ${s.step}: the wire does not end on pad ${s.to.ref}.${s.to.pin}`);
  }
  for (const w of c.wires) if (!c.steps.some((s) => s.step === w.step)) out.add(`a wire is drawn for step ${w.step}, which is not a connection of the project`);

  // A wire runs through no part but its own, and only on its first and last run, out of its own pad.
  for (const w of c.wires) {
    const segs = segsOf(w.path);
    // A wire runs inside its own part only on its first run out of the pad, or its first two when the pad hops sideways
    // between two pads of its own part first (the inner row of a 2 x N header). The same, backwards, into its end part.
    const inFrom = w.hopFrom ? 2 : 1;
    const inTo = w.hopTo ? 2 : 1;
    segs.forEach(([a, b], k) => {
      for (const p of c.parts) {
        if ((k < inFrom && p.ref === w.from.ref) || (k >= segs.length - inTo && p.ref === w.to.ref)) continue;

        if (clipLength(a, b, grow(rectBox(p.rect), -0.05)) > 0.05) out.add(`the wire of step ${w.step} runs through ${p.ref}`);
      }
    });
  }

  // Where two nets meet: only a clean crossing is allowed.
  for (let i = 0; i < c.wires.length; i++) {
    for (let j = i + 1; j < c.wires.length; j++) {
      const wi = c.wires[i]!;
      const wj = c.wires[j]!;
      if (wi.net === wj.net) continue;
      for (const a of segsOf(wi.path)) {
        for (const b of segsOf(wj.path)) {
          const r = relate(a, b, c.wire);
          if (r.kind === "overlap") out.add(`wires of steps ${wi.step} and ${wj.step} overlap along a run`);
          else if (r.kind === "touch") out.add(`the wire of step ${wi.step} touches the wire of step ${wj.step}`);
          else if (r.kind === "cross" && !r.perpendicular) out.add(`the wire of step ${wi.step} crosses the wire of step ${wj.step} at an angle`);
        }
      }
    }
  }

  // Labels: not on each other, not on a part that is not theirs, not under a wire.
  for (let i = 0; i < c.labels.length; i++) {
    const l = c.labels[i]!;
    for (let j = i + 1; j < c.labels.length; j++) {
      if (overlap(l.box, c.labels[j]!.box, -0.02)) out.add(`label ${l.id} overlaps label ${c.labels[j]!.id}`);
    }
    for (const p of c.parts) {
      if (p.ref !== l.inside && overlap(l.box, rectBox(p.rect), -0.02)) out.add(`label ${l.id} overlaps part ${p.ref}`);
    }
    const hit = grow(l.box, c.wire / 2);
    for (const w of c.wires) {
      if (w.net === l.net) continue;
      if (segsOf(w.path).some(([a, b]) => clipLength(a, b, hit) > 1e-3)) out.add(`label ${l.id} is overlapped by the wire of step ${w.step}`);
    }
  }
  return [...out];
}
