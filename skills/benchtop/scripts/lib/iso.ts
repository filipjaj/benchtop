// Isometric line-art renderer.
//
// Draws boxes and cylinders in the two-weight black line style of flat-pack assembly
// booklets: a heavy stroke on each solid's silhouette, a thin stroke on its interior
// edges, white fills, no shading. Everything is positioned in millimetres from real
// part dimensions, so a drawing is a scale view of the build, not an impression of it.
//
// Coordinates: x right, y away along the bench, z up. The camera sits at +x +y +z,
// so the visible faces of a box are its top, its +x face ("right") and its +y face
// ("left"). Output is SVG in projected millimetres; the caller sets the viewBox.
//
// Solids are painted back to front. Everything that is not a solid (wires, guide
// lines, pin labels) is tested against the solids before it is drawn: the part of a
// wire or guide that lies behind a solid is left out, a wire end gets its dot only
// where the pad can be seen, and a label is only placed where nothing covers it.
// renderScene returns the geometry it drew alongside the SVG, and drawing-check.ts
// reads that geometry to report what a builder would not be able to read.

import {
  type Block,
  C,
  type Pt,
  S,
  type V3,
  Z,
  backtrack,
  bezier,
  circlePoly,
  clipToConvex,
  inflate,
  isHidden,
  isHiddenBy,
  isInside,
  occluders,
  pointInConvex,
  polylineHitsConvex,
  polysOverlap,
  proj,
  sharpestTurn,
  silhouette,
  textQuad,
  textWidth,
  unproject,
  VIEW,
} from "./geom";
import type { Decal, Face, PartDef, PinDef, PlacedPart, Shape } from "./types";

export { proj } from "./geom";
export type { Pt, V3 } from "./geom";

export const HEAVY = 0.42;
export const THIN = 0.17;

export const WIRE_HEX: Record<string, string> = {
  red: "#d7282f",
  black: "#1a1a1a",
  yellow: "#f2b90c",
  green: "#2f9e4f",
  blue: "#1f6fd6",
  white: "#ffffff",
  orange: "#f07c1e",
  purple: "#8a4fc7",
  grey: "#9aa0a6",
  brown: "#8a5a2b",
};

export interface Pad {
  x: number;
  y: number;
  label?: string;
  /** Which way the silkscreen label runs from the pad, in solid-local terms. Tried first. */
  labelDir?: "x+" | "x-" | "y+" | "y-";
  mark?: "target";
  /** Pin name, so a wire end can be matched to the pad it claims to land on. */
  pin?: string;
  /** Ring radius. Defaults to a 2.54 mm header pad. */
  r?: number;
  /**
   * false: only the name is placed beside this spot; no ring is drawn and it is not a
   * pad of the drawing. Used on the board under a header, whose pins are drawn on the
   * header itself but whose names still read best on the board beside it.
   */
  ring?: false;
}

export interface Solid {
  kind: "box" | "cyl";
  x: number;
  y: number;
  z: number;
  w: number;
  d: number;
  h: number;
  /** cyl only */
  r?: number;
  decals?: Decal[];
  pads?: Pad[];
  /** ghost = dashed outline with no fill, used for "this is where it will end up". */
  style?: "solid" | "ghost";
  tag?: string;
  /** Ref of the part this solid belongs to, for messages. */
  part?: string;
  /**
   * Set on a solid that is hovering before it is fitted. Solids sharing `item` are one
   * hovering thing; things sharing `group` land side by side and must not overlap on
   * the page.
   */
  hover?: { group: string; item: string };
}

export interface PinRef {
  ref: string;
  pin: string;
}

export interface Wire3 {
  a: V3;
  b: V3;
  color: string;
  state: "now" | "done";
  /** Which pads the two ends claim, in the order a, b. */
  ends?: [PinRef, PinRef];
}

export interface Scene {
  solids: Solid[];
  wires?: Wire3[];
  /** Thin exploded-view lines joining a hovering part to where it lands. `dash` draws an outline of the landing place. */
  guides?: { a: V3; b: V3; dash?: boolean }[];
  /** Filled block arrows showing a movement direction. */
  arrows?: { a: V3; b: V3 }[];
  /**
   * Points that must be seen in this drawing. Any solid in front of one is drawn as a
   * dashed outline with no fill, so what is behind it shows through. A magnified
   * bubble uses this for its target pad.
   */
  seeThrough?: V3[];
  /** Upright captions placed by the scene builder, drawn last. */
  texts?: FreeText[];
}

/** Upright text on the page, not lying on any face. */
export interface FreeText {
  text: string;
  at: Pt;
  anchor: "start" | "middle" | "end";
  size: number;
  /** Ref of the part it names. */
  part?: string;
  /** Thin line from the text to the thing it names. */
  leader?: [Pt, Pt];
}

export interface BBox {
  minX: number;
  minY: number;
  maxX: number;
  maxY: number;
}

// ---------------------------------------------------------------------------
// What was drawn
// ---------------------------------------------------------------------------

export interface DrawnSolid {
  solid: Solid;
  /** Drawn as a dashed outline that hides nothing. */
  ghost: boolean;
  outline: Pt[];
}

export interface DrawnPad {
  part?: string;
  pin?: string;
  at: V3;
  screen: Pt;
  target: boolean;
}

export interface DrawnWireEnd {
  pad?: PinRef;
  at: V3;
  screen: Pt;
  /** Where the solder dot was painted, or null when the end is behind something. */
  dot: Pt | null;
}

export interface DrawnWire {
  color: string;
  state: "now" | "done";
  ends: [DrawnWireEnd, DrawnWireEnd];
  /** The whole path on the page, visible or not. */
  path: Pt[];
  /** The same path in space. */
  path3: V3[];
  /** The stretches that were painted. */
  runs: Pt[][];
}

export interface DrawnLabel {
  text: string;
  quad: Pt[];
  /** face: lying on a solid's top face. ground: lying on the bench beside a solid. free: upright on the page. */
  kind: "face" | "ground" | "free";
  part?: string;
  pin?: string;
  target?: boolean;
  /** face and ground labels: points on the text, in space, that must not be hidden. */
  samples?: V3[];
}

export interface DrawnGuide {
  a: V3;
  b: V3;
  /** The stretches no solid hides, in space. */
  runs: [V3, V3][];
  /** What was painted on the page: those stretches, less the gaps left for text. */
  drawn: [Pt, Pt][];
}

export interface SceneGeom {
  solids: DrawnSolid[];
  pads: DrawnPad[];
  wires: DrawnWire[];
  labels: DrawnLabel[];
  guides: DrawnGuide[];
  arrows: Pt[][];
  /** Pin labels that found no place free of pads, shapes, wires and other labels. */
  unplaced: { part?: string; pin?: string; text: string; target: boolean }[];
}

export interface Rendered {
  svg: string;
  bbox: BBox;
  geom: SceneGeom;
}

const f = (n: number): string => (Math.round(n * 100) / 100).toString();
const pts = (ps: readonly Pt[]): string => ps.map((p) => `${f(p[0])},${f(p[1])}`).join(" ");
export const esc = (s: string): string =>
  s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");

/** "btn button-cap", for messages. */
export const solidName = (s: Solid): string => (s.part && s.tag && s.tag !== s.part ? `${s.part} ${s.tag}` : (s.part ?? s.tag ?? s.kind));

// ---------------------------------------------------------------------------
// Depth ordering
// ---------------------------------------------------------------------------

// a can safely be painted before b when a plane separates them with a on the far
// side. If the same holds the other way round too, neither can hide the other.
function farSideOf(a: Solid, b: Solid): boolean {
  const e = 1e-6;
  return a.x + a.w <= b.x + e || a.y + a.d <= b.y + e || a.z + a.h <= b.z + e;
}

const depth = (s: Solid): number => s.x + s.w / 2 + s.y + s.d / 2 + s.z + s.h / 2;

export function paintOrder(solids: Solid[]): Solid[] {
  const n = solids.length;
  const indeg = new Array<number>(n).fill(0);
  const out: number[][] = Array.from({ length: n }, () => []);
  for (let i = 0; i < n; i++) {
    for (let j = i + 1; j < n; j++) {
      const ij = farSideOf(solids[i]!, solids[j]!);
      const ji = farSideOf(solids[j]!, solids[i]!);
      if (ij && !ji) {
        out[i]!.push(j);
        indeg[j]!++;
      } else if (ji && !ij) {
        out[j]!.push(i);
        indeg[i]!++;
      }
    }
  }
  const done = new Array<boolean>(n).fill(false);
  const order: Solid[] = [];
  for (let k = 0; k < n; k++) {
    // Lowest in-degree first, then farthest from the camera. Taking a non-zero
    // in-degree only happens on a cycle, where any choice is a compromise.
    let best = -1;
    for (let i = 0; i < n; i++) {
      if (done[i]) continue;
      if (
        best === -1 ||
        indeg[i]! < indeg[best]! ||
        (indeg[i] === indeg[best] && depth(solids[i]!) < depth(solids[best]!))
      ) {
        best = i;
      }
    }
    done[best] = true;
    order.push(solids[best]!);
    for (const j of out[best]!) indeg[j]!--;
  }
  return order;
}

// ---------------------------------------------------------------------------
// Faces and decals
// ---------------------------------------------------------------------------

// Face-local (u, v) to screen. u runs along the face from its left edge as drawn,
// v runs down the face (or away from the viewer on the top face).
function facePoint(s: Solid, face: Face, u: number, v: number): Pt {
  if (face === "top") return proj(s.x + u, s.y + v, s.z + s.h);
  if (face === "left") return proj(s.x + u, s.y + s.d, s.z + s.h - v);
  return proj(s.x + s.w, s.y + s.d - u, s.z + s.h - v);
}

function faceMatrix(s: Solid, face: Face, u: number, v: number, along: "x" | "y" = "x"): string {
  const o = facePoint(s, face, u, v);
  let eu: Pt;
  let ev: Pt;
  if (face === "top") {
    // Text along y has to run toward -y to read left to right on the page.
    eu = along === "x" ? [C, S] : [C, -S];
    ev = along === "x" ? [-C, S] : [C, S];
  } else if (face === "left") {
    eu = [C, S];
    ev = [0, Z];
  } else {
    eu = [C, -S];
    ev = [0, Z];
  }
  return `matrix(${f(eu[0])} ${f(eu[1])} ${f(ev[0])} ${f(ev[1])} ${f(o[0])} ${f(o[1])})`;
}

function circleOnFace(s: Solid, face: Face, cu: number, cv: number, r: number): Pt[] {
  const out: Pt[] = [];
  for (let i = 0; i < 28; i++) {
    const a = (i / 28) * Math.PI * 2;
    out.push(facePoint(s, face, cu + Math.cos(a) * r, cv + Math.sin(a) * r));
  }
  return out;
}

function drawDecal(s: Solid, d: Decal): string {
  if (d.kind === "rect") {
    const ps = [
      facePoint(s, d.face, d.x, d.y),
      facePoint(s, d.face, d.x + d.w, d.y),
      facePoint(s, d.face, d.x + d.w, d.y + d.h),
      facePoint(s, d.face, d.x, d.y + d.h),
    ];
    const fill = d.fill === "black" ? "#111" : d.fill === "hatch" ? "url(#bt-hatch)" : "none";
    return `<polygon points="${pts(ps)}" fill="${fill}" stroke="#111" stroke-width="${THIN}" stroke-linejoin="round"/>`;
  }
  if (d.kind === "circle") {
    const fill = d.fill === "black" ? "#111" : "none";
    return `<polygon points="${pts(circleOnFace(s, d.face, d.x, d.y, d.r))}" fill="${fill}" stroke="#111" stroke-width="${THIN}"/>`;
  }
  return `<text transform="${faceMatrix(s, d.face, d.x, d.y, d.along)}" font-size="${f(d.size)}" class="bt-silk">${esc(d.text)}</text>`;
}

const PAD_R = 0.85;

/** The ring of a pad, or the filled disc of the pad a wire is going to. The label is placed separately. */
function drawPad(s: Solid, p: Pad): string {
  if (p.ring === false) return "";
  const r = p.r ?? PAD_R;
  if (p.mark === "target") return `<polygon points="${pts(circleOnFace(s, "top", p.x, p.y, r * 1.47))}" fill="#111"/>`;
  return (
    `<polygon points="${pts(circleOnFace(s, "top", p.x, p.y, r))}" fill="#fff" stroke="#111" stroke-width="${THIN}"/>` +
    `<polygon points="${pts(circleOnFace(s, "top", p.x, p.y, r * 0.47))}" fill="#111"/>`
  );
}

// ---------------------------------------------------------------------------
// Solids
// ---------------------------------------------------------------------------

type Ghost = false | "landing" | "see-through";

function drawBox(s: Solid, ghost: Ghost): string {
  const { x, y, z, w, d, h } = s;
  const hex: Pt[] = [
    proj(x, y, z + h),
    proj(x + w, y, z + h),
    proj(x + w, y, z),
    proj(x + w, y + d, z),
    proj(x, y + d, z),
    proj(x, y + d, z + h),
  ];
  const near = proj(x + w, y + d, z + h);
  const inner = `M${pts([hex[1]!])} L${pts([near])} L${pts([hex[5]!])} M${pts([near])} L${pts([hex[3]!])}`;
  if (ghost) {
    let out = `<polygon points="${pts(hex)}" fill="none" stroke="#111" stroke-width="${THIN}" stroke-dasharray="1.2 0.9" stroke-linejoin="round"/>`;
    if (ghost === "see-through") {
      // A solid ghosted so that something behind it shows keeps its shape and its pads.
      out += `<path d="${inner}" fill="none" stroke="#111" stroke-width="${THIN}" stroke-dasharray="1.2 0.9" stroke-linecap="round"/>`;
      for (const pad of s.pads ?? []) out += drawPad(s, pad);
    }
    return out;
  }
  let out = `<polygon points="${pts(hex)}" fill="#fff" stroke="#111" stroke-width="${HEAVY}" stroke-linejoin="round"/>`;
  out += `<path d="${inner}" fill="none" stroke="#111" stroke-width="${THIN}" stroke-linecap="round"/>`;
  for (const dec of s.decals ?? []) out += drawDecal(s, dec);
  for (const pad of s.pads ?? []) out += drawPad(s, pad);
  return out;
}

function drawCyl(s: Solid, ghost: Ghost): string {
  const r = s.r ?? s.w / 2;
  const cx = s.x + s.w / 2;
  const cy = s.y + s.d / 2;
  const a = r * Math.SQRT2 * C;
  const b = r * Math.SQRT2 * S;
  const top = proj(cx, cy, s.z + s.h);
  const bot = proj(cx, cy, s.z);
  const body = `M${f(top[0] - a)},${f(top[1])} L${f(bot[0] - a)},${f(bot[1])} A${f(a)} ${f(b)} 0 0 0 ${f(bot[0] + a)},${f(bot[1])} L${f(top[0] + a)},${f(top[1])} A${f(a)} ${f(b)} 0 0 0 ${f(top[0] - a)},${f(top[1])} Z`;
  const rim = `M${f(top[0] - a)},${f(top[1])} A${f(a)} ${f(b)} 0 0 0 ${f(top[0] + a)},${f(top[1])}`;
  if (ghost) {
    return (
      `<path d="${body}" fill="none" stroke="#111" stroke-width="${THIN}" stroke-dasharray="1.2 0.9"/>` +
      (ghost === "see-through" ? `<path d="${rim}" fill="none" stroke="#111" stroke-width="${THIN}" stroke-dasharray="1.2 0.9"/>` : "")
    );
  }
  return (
    `<path d="${body}" fill="#fff" stroke="#111" stroke-width="${HEAVY}" stroke-linejoin="round"/>` +
    `<path d="${rim}" fill="none" stroke="#111" stroke-width="${THIN}"/>`
  );
}

function grow(bb: BBox, ps: readonly Pt[], m = 0): void {
  for (const p of ps) {
    bb.minX = Math.min(bb.minX, p[0] - m);
    bb.maxX = Math.max(bb.maxX, p[0] + m);
    bb.minY = Math.min(bb.minY, p[1] - m);
    bb.maxY = Math.max(bb.maxY, p[1] + m);
  }
}

function solidBBox(s: Solid, bb: BBox): void {
  for (const dx of [0, s.w]) {
    for (const dy of [0, s.d]) {
      for (const dz of [0, s.h]) grow(bb, [proj(s.x + dx, s.y + dy, s.z + dz)]);
    }
  }
}

// ---------------------------------------------------------------------------
// Wires
// ---------------------------------------------------------------------------

export interface WireCurve {
  ctrl: [V3, V3, V3, V3];
  path3: V3[];
  path: Pt[];
}

const WIRE_SAMPLES = 48;
/**
 * Two wire ends closer than this on the page leave no room to draw a wire between
 * them; the drawing check reports such a wire instead of trusting its shape.
 */
export const WIRE_MIN = 3;
/** From this length on the page a wire has room for a full arc. */
const WIRE_ROOM = 16;
/** Half the painted width of a wire, outline included. */
export const WIRE_HALF = 0.6;

/**
 * The path of a wire between two pads, as a cubic curve in space.
 *
 * It is designed on the page and then given depth. Measured along the straight line
 * between the two ends, the first control point never sits behind the start, the
 * second never beyond the finish, and the two never swap. A cubic built that way moves
 * steadily from one end to the other, so it cannot double back, loop or form a spike,
 * wherever the two pads happen to sit relative to each other. Within that rule each
 * end leaves its pad as close to straight up the page as it can, which is how a
 * soldered lead sits and keeps the two ends apart where several wires share a header;
 * an end whose other end is further down the page leans toward it instead of rising
 * and folding back.
 */
export function wireCurve(a: V3, b: V3, lift: number): WireCurve {
  const pa = proj(...a);
  const pb = proj(...b);
  const L = Math.hypot(pb[0] - pa[0], pb[1] - pa[1]);
  let ctrl: [V3, V3, V3, V3];
  if (L < 0.5) {
    // Two ends on one spot on the page. There is no line to follow; draw a small loop,
    // which the drawing check reports, since no drawing can show such a wire.
    ctrl = [a, unproject(a, -1.6, -3), unproject(b, 1.6, -3), b];
  } else {
    const cx = (pb[0] - pa[0]) / L;
    const cy = (pb[1] - pa[1]) / L;
    // Normal to the chord on the side that is up the page (sideways for a vertical chord).
    let nx = cy;
    let ny = -cx;
    if (ny > 1e-9 || (Math.abs(ny) <= 1e-9 && nx < 0)) {
      nx = -nx;
      ny = -ny;
    }
    const clamp = (v: number, lo: number, hi: number): number => Math.min(hi, Math.max(lo, v));
    // A long wire may stand up steeply from its pad and arc high; a short one has no
    // room to, and is kept flat so that it never bends tighter than a wire can be read.
    const short = clamp((WIRE_ROOM - L) / (WIRE_ROOM - WIRE_MIN), 0, 1);
    const maxRise = 0.75 - 0.5 * short;
    const minAlong = 0.08 + 0.2 * short;
    // "Straight up the page" split into along-chord and across-chord parts, per end.
    const rise = clamp(lift * -ny, 0.06 * L, maxRise * L);
    const alongA = clamp(lift * -cy, minAlong * L, 0.45 * L);
    const alongB = clamp(lift * cy, minAlong * L, 0.45 * L);
    const mix = (t: number): V3 => [a[0] + (b[0] - a[0]) * t, a[1] + (b[1] - a[1]) * t, a[2] + (b[2] - a[2]) * t];
    // The page position of each control point is now fixed; its depth is still free,
    // because sliding a point along the view direction does not move it on the page.
    // Depth is chosen the way a wire lies: in the upright plane over the straight line
    // between the two pads, risen above it. Only when that plane is seen nearly edge-on
    // (the pads one behind the other) is the bow put sideways instead.
    const hx = b[0] - a[0];
    const hy = b[1] - a[1];
    const hl = Math.hypot(hx, hy);
    // Page vector of one millimetre along the bench from a toward b.
    const q: Pt = hl > 1e-6 ? [((hx - hy) / hl) * C, ((hx + hy) / hl) * S] : [0, 0];
    const place = (base: V3, dx: number, dy: number): V3 => {
      if (Math.abs(q[0]) > 0.25) {
        const along = dx / q[0];
        const up = (along * q[1] - dy) / Z;
        if (up >= 0) return [base[0] + (hx / hl) * along, base[1] + (hy / hl) * along, base[2] + up];
      }
      return unproject(base, dx, dy);
    };
    // Hold the wire `lift` above its pads in space, so it passes over the low
    // components around a pad instead of behind them, without changing the drawn curve.
    const raise = (p: V3, floor: number): V3 => {
      const t = (floor - p[2]) / VIEW[2];
      return t > 0 ? [p[0] + VIEW[0] * t, p[1] + VIEW[1] * t, floor] : p;
    };
    ctrl = [
      a,
      raise(place(mix(alongA / L), nx * rise, ny * rise), a[2] + lift),
      raise(place(mix(1 - alongB / L), nx * rise, ny * rise), b[2] + lift),
      b,
    ];
  }
  const path3: V3[] = [];
  for (let i = 0; i <= WIRE_SAMPLES; i++) path3.push(bezier(ctrl, i / WIRE_SAMPLES));
  return { ctrl, path3, path: path3.map((p) => proj(...p)) };
}

/** Indices of the blocks a wire runs through, ignoring the first and last tenth where it meets its pads. */
function pierced(curve: WireCurve, blocks: readonly Block[]): number[] {
  const hit = new Set<number>();
  const n = curve.path3.length;
  for (let i = Math.ceil(n * 0.1); i < Math.floor(n * 0.9); i++) {
    blocks.forEach((b, k) => {
      if (isInside(curve.path3[i]!, b, 0.25)) hit.add(k);
    });
  }
  return [...hit];
}

/** The wire, lifted until it clears every solid between its ends where that is possible. */
function clearWire(a: V3, b: V3, lift: number, blocks: readonly Block[]): WireCurve {
  const first = wireCurve(a, b, lift);
  if (pierced(first, blocks).length === 0) return first;
  for (const k of [1.5, 2.2, 3.2]) {
    const higher = wireCurve(a, b, lift * k);
    if (pierced(higher, blocks).length === 0) return higher;
  }
  return first;
}

/** Split a sampled path into the stretches that are not behind any block, refining each boundary. */
function visibleRuns(curve: WireCurve, blocks: readonly Block[]): { runs: Pt[][]; all: boolean; hidden: [boolean, boolean] } {
  const n = curve.path3.length - 1;
  const vis = curve.path3.map((p) => !isHidden(p, blocks));
  if (vis.every(Boolean)) return { runs: [curve.path], all: true, hidden: [false, false] };
  const edge = (i: number, j: number): Pt => {
    // i visible, j hidden (or the reverse): bisect for the point where the wire disappears.
    let lo = i / n;
    let hi = j / n;
    for (let k = 0; k < 8; k++) {
      const mid = (lo + hi) / 2;
      if (!isHidden(bezier(curve.ctrl, mid), blocks)) lo = mid;
      else hi = mid;
    }
    return proj(...bezier(curve.ctrl, lo));
  };
  const runs: Pt[][] = [];
  let run: Pt[] | null = null;
  for (let i = 0; i <= n; i++) {
    if (vis[i]) {
      if (!run) {
        run = [];
        if (i > 0) run.push(edge(i, i - 1));
      }
      run.push(curve.path[i]!);
    } else if (run) {
      run.push(edge(i - 1, i));
      runs.push(run);
      run = null;
    }
  }
  if (run) runs.push(run);
  return { runs: runs.filter((r) => r.length > 1), all: false, hidden: [!vis[0], !vis[n]] };
}

const line = (ps: readonly Pt[]): string => `M${ps.map((p) => `${f(p[0])},${f(p[1])}`).join(" L")}`;

interface WireDraw {
  drawn: DrawnWire[];
  done: string;
  now: string;
}

function drawWires(wires: Wire3[], blocks: readonly Block[]): WireDraw {
  const out: WireDraw = { drawn: [], done: "", now: "" };
  // Finished wires first so the wire being added now is never under another wire.
  const sorted = [...wires].sort((p, q) => (p.state === q.state ? 0 : p.state === "done" ? -1 : 1));
  sorted.forEach((w, i) => {
    const a = proj(...w.a);
    const b = proj(...w.b);
    const span = Math.hypot(a[0] - b[0], a[1] - b[1]);
    // Stagger the arcs so parallel wires fan out instead of stacking on one curve.
    const lift = 4 + span * 0.1 + (i % 4) * 1.6;
    const curve = clearWire(w.a, w.b, lift, blocks);
    const v = visibleRuns(curve, blocks);
    const c = curve.ctrl.map((p) => proj(...p));
    const d = v.all
      ? `M${f(c[0]![0])},${f(c[0]![1])} C${f(c[1]![0])},${f(c[1]![1])} ${f(c[2]![0])},${f(c[2]![1])} ${f(c[3]![0])},${f(c[3]![1])}`
      : v.runs.map(line).join(" ");
    const ends: [DrawnWireEnd, DrawnWireEnd] = [
      { pad: w.ends?.[0], at: w.a, screen: a, dot: w.state === "now" && !v.hidden[0] ? a : null },
      { pad: w.ends?.[1], at: w.b, screen: b, dot: w.state === "now" && !v.hidden[1] ? b : null },
    ];
    out.drawn.push({ color: w.color, state: w.state, ends, path: curve.path, path3: curve.path3, runs: v.runs });
    if (!d) return;
    if (w.state === "done") {
      out.done += `<path d="${d}" fill="none" stroke="#b9bcc0" stroke-width="0.55" stroke-linecap="round" stroke-linejoin="round"/>`;
    } else {
      const hex = WIRE_HEX[w.color] ?? w.color;
      out.now += `<path d="${d}" fill="none" stroke="#111" stroke-width="${WIRE_HALF * 2}" stroke-linecap="round" stroke-linejoin="round"/>`;
      out.now += `<path d="${d}" fill="none" stroke="${hex}" stroke-width="0.74" stroke-linecap="round" stroke-linejoin="round"/>`;
      for (const e of ends) if (e.dot) out.now += `<circle cx="${f(e.dot[0])}" cy="${f(e.dot[1])}" r="0.8" fill="#111"/>`;
    }
  });
  return out;
}

// ---------------------------------------------------------------------------
// Guides and arrows
// ---------------------------------------------------------------------------

/** The stretches of the straight line a-b that no block hides. */
export function visibleSegments(a: V3, b: V3, blocks: readonly Block[]): [V3, V3][] {
  const len = Math.hypot(b[0] - a[0], b[1] - a[1], b[2] - a[2]);
  const n = Math.max(2, Math.ceil(len / 0.5));
  const at = (t: number): V3 => [a[0] + (b[0] - a[0]) * t, a[1] + (b[1] - a[1]) * t, a[2] + (b[2] - a[2]) * t];
  const vis: boolean[] = [];
  for (let i = 0; i <= n; i++) vis.push(!isHidden(at(i / n), blocks));
  const edge = (i: number, j: number): number => {
    let lo = i / n;
    let hi = j / n;
    for (let k = 0; k < 8; k++) {
      const mid = (lo + hi) / 2;
      if (!isHidden(at(mid), blocks)) lo = mid;
      else hi = mid;
    }
    return lo;
  };
  const out: [V3, V3][] = [];
  let start: number | null = null;
  for (let i = 0; i <= n; i++) {
    if (vis[i] && start === null) start = i === 0 ? 0 : edge(i, i - 1);
    if (!vis[i] && start !== null) {
      out.push([at(start), at(edge(i - 1, i))]);
      start = null;
    }
  }
  if (start !== null) out.push([at(start), b]);
  return out.filter(([p, q]) => Math.hypot(q[0] - p[0], q[1] - p[1], q[2] - p[2]) > 0.05);
}

/** Cut the parts of a page segment that pass under any of the given text boxes. */
function cutUnder(a: Pt, b: Pt, boxes: readonly Pt[][]): [Pt, Pt][] {
  let keep: [number, number][] = [[0, 1]];
  for (const box of boxes) {
    const hit = clipToConvex(a, b, box);
    if (!hit) continue;
    keep = keep.flatMap(([s, e]): [number, number][] => {
      if (hit[1] <= s || hit[0] >= e) return [[s, e]];
      const parts: [number, number][] = [];
      if (hit[0] > s) parts.push([s, hit[0]]);
      if (hit[1] < e) parts.push([hit[1], e]);
      return parts;
    });
  }
  const at = (t: number): Pt => [a[0] + (b[0] - a[0]) * t, a[1] + (b[1] - a[1]) * t];
  return keep.filter(([s, e]) => e - s > 1e-6).map(([s, e]) => [at(s), at(e)]);
}

/** The outline of a block arrow from a3 to b3 on the page. */
export function arrowPoly(a3: V3, b3: V3): Pt[] | null {
  const a = proj(...a3);
  const b = proj(...b3);
  const len = Math.hypot(b[0] - a[0], b[1] - a[1]);
  if (len < 0.01) return null;
  const ux = (b[0] - a[0]) / len;
  const uy = (b[1] - a[1]) / len;
  const nx = -uy;
  const ny = ux;
  const shaft = 1.1;
  const head = 2.8;
  const headLen = Math.min(4.2, len * 0.55);
  const neck: Pt = [b[0] - ux * headLen, b[1] - uy * headLen];
  return [
    [a[0] + nx * shaft, a[1] + ny * shaft],
    [neck[0] + nx * shaft, neck[1] + ny * shaft],
    [neck[0] + nx * head, neck[1] + ny * head],
    b,
    [neck[0] - nx * head, neck[1] - ny * head],
    [neck[0] - nx * shaft, neck[1] - ny * shaft],
    [a[0] - nx * shaft, a[1] - ny * shaft],
  ];
}

// ---------------------------------------------------------------------------
// Pin labels
// ---------------------------------------------------------------------------

export const LABEL_SIZE = 1.05;
const HALO = `stroke="#fff" stroke-width="0.3" paint-order="stroke" stroke-linejoin="round"`;

type Dir = NonNullable<Pad["labelDir"]>;

interface Rect {
  u0: number;
  v0: number;
  u1: number;
  v1: number;
}

const rectsTouch = (a: Rect, b: Rect, gap: number): boolean => a.u0 < b.u1 + gap && b.u0 < a.u1 + gap && a.v0 < b.v1 + gap && b.v0 < a.v1 + gap;

function rectTouchesCircle(r: Rect, cx: number, cy: number, rad: number): boolean {
  const dx = Math.max(r.u0 - cx, 0, cx - r.u1);
  const dy = Math.max(r.v0 - cy, 0, cy - r.v1);
  return dx * dx + dy * dy < rad * rad;
}

/** Bounds of a top-face decal in face coordinates, so labels can keep off it. */
function decalRect(d: Decal): Rect | null {
  if (d.face !== "top") return null;
  if (d.kind === "rect") return { u0: d.x, v0: d.y, u1: d.x + d.w, v1: d.y + d.h };
  if (d.kind === "circle") return { u0: d.x - d.r, v0: d.y - d.r, u1: d.x + d.r, v1: d.y + d.r };
  const len = textWidth(d.text, d.size);
  return d.along === "y" ? { u0: d.x - d.size, v0: d.y - len, u1: d.x, v1: d.y } : { u0: d.x, v0: d.y - d.size, u1: d.x + len, v1: d.y };
}

export interface Candidate {
  kind: "face" | "ground";
  rect: Rect;
  quad: Pt[];
  samples: V3[];
  svg: string;
}

/**
 * A pin label lying flat beside its pad: on the solid's top face, or on the bench at
 * the foot of the solid. `gap` is how far from the pad centre the text starts.
 */
function labelAt(s: Solid, p: Pad, dir: Dir, gap: number, kind: "face" | "ground", text: string): Candidate {
  const size = LABEL_SIZE;
  const len = textWidth(text, size);
  const z = kind === "face" ? s.z + s.h : s.z;
  const along = dir[0] === "x" ? "x" : "y";
  let u = p.x;
  let v = p.y;
  let anchor: "start" | "end" = "start";
  let rect: Rect;
  // The baseline sits a little past the pad centre so the capitals are centred on it.
  if (dir === "x+") {
    u += gap;
    v += size * 0.36;
    rect = { u0: p.x + gap, u1: p.x + gap + len, v0: p.y - size * 0.4, v1: p.y + size * 0.44 };
  } else if (dir === "x-") {
    u -= gap;
    v += size * 0.36;
    anchor = "end";
    rect = { u0: p.x - gap - len, u1: p.x - gap, v0: p.y - size * 0.4, v1: p.y + size * 0.44 };
  } else if (dir === "y+") {
    // Text runs toward -y, so a label lying further along +y ends at the pad.
    v += gap;
    u += size * 0.36;
    anchor = "end";
    rect = { u0: p.x - size * 0.4, u1: p.x + size * 0.44, v0: p.y + gap, v1: p.y + gap + len };
  } else {
    v -= gap;
    u += size * 0.36;
    rect = { u0: p.x - size * 0.4, u1: p.x + size * 0.44, v0: p.y - gap - len, v1: p.y - gap };
  }
  const origin = proj(s.x + u, s.y + v, z);
  const eu: Pt = along === "x" ? [C, S] : [C, -S];
  const ev: Pt = along === "x" ? [-C, S] : [C, S];
  const samples: V3[] = [];
  for (const fu of [0, 0.5, 1]) {
    for (const fv of [0, 0.5, 1]) samples.push([s.x + rect.u0 + (rect.u1 - rect.u0) * fu, s.y + rect.v0 + (rect.v1 - rect.v0) * fv, z]);
  }
  const m = `matrix(${f(eu[0])} ${f(eu[1])} ${f(ev[0])} ${f(ev[1])} ${f(origin[0])} ${f(origin[1])})`;
  return {
    kind,
    rect,
    quad: textQuad(origin, eu, ev, text, size, anchor),
    samples,
    svg: `<text transform="${m}" font-size="${size}" text-anchor="${anchor}" class="bt-silk" ${HALO}>${esc(text)}</text>`,
  };
}

const OPPOSITE: Record<Dir, Dir> = { "x+": "x-", "x-": "x+", "y+": "y-", "y-": "y+" };
const ACROSS: Record<Dir, [Dir, Dir]> = { "x+": ["y+", "y-"], "x-": ["y+", "y-"], "y+": ["x+", "x-"], "y-": ["x+", "x-"] };

/** Every place a pad's label may go, best first: on the face running inward, then along the row, then off the edge onto the bench. */
export function labelCandidates(s: Solid, p: Pad, text: string): Candidate[] {
  const r = p.r ?? PAD_R;
  const pref = p.labelDir ?? "x+";
  const out: Candidate[] = [];
  for (const dir of [pref, ...ACROSS[pref], OPPOSITE[pref]]) out.push(labelAt(s, p, dir, r + 0.65, "face", text));
  // Distance from the pad to the edge each direction runs toward.
  const toEdge: Record<Dir, number> = { "x+": s.w - p.x, "x-": p.x, "y+": s.d - p.y, "y-": p.y };
  // Bench text behind a solid only shows once it is clear of the solid's own height.
  const clear: Record<Dir, number> = { "x+": 0.9, "y+": 0.9, "x-": Math.max(0.9, s.h / VIEW[2] + 0.5), "y-": Math.max(0.9, s.h / VIEW[2] + 0.5) };
  const outward = (Object.keys(toEdge) as Dir[]).filter((d) => toEdge[d] <= 5).sort((m, n) => toEdge[m] - toEdge[n]);
  for (const dir of outward) out.push(labelAt(s, p, dir, toEdge[dir] + clear[dir], "ground", text));
  return out;
}

interface LabelContext {
  solids: readonly Solid[];
  blocks: readonly Block[];
  outlines: readonly Pt[][];
  wires: readonly DrawnWire[];
}

function placeLabels(ctx: LabelContext): { labels: DrawnLabel[]; svg: string; unplaced: SceneGeom["unplaced"] } {
  const labels: DrawnLabel[] = [];
  const unplaced: SceneGeom["unplaced"] = [];
  let svg = "";
  const nowRuns = ctx.wires.filter((w) => w.state === "now").flatMap((w) => w.runs);
  const doneRuns = ctx.wires.filter((w) => w.state === "done").flatMap((w) => w.runs);
  const dots = ctx.wires.flatMap((w) => w.ends.map((e) => e.dot).filter((d): d is Pt => d !== null));
  const onFace = new Map<Solid, Rect[]>();
  const jobs = ctx.solids.flatMap((s) => (s.pads ?? []).filter((p) => p.label).map((p) => ({ s, p })));
  // The pads a wire is going to are labelled first, so they get the best places.
  jobs.sort((m, n) => Number(n.p.mark === "target") - Number(m.p.mark === "target"));
  for (const { s, p } of jobs) {
    const text = p.label!;
    const ok = (c: Candidate, strict: boolean): boolean => {
      if (c.kind === "face") {
        if (c.rect.u0 < 0.2 || c.rect.v0 < 0.2 || c.rect.u1 > s.w - 0.2 || c.rect.v1 > s.d - 0.2) return false;
        for (const q of s.pads ?? []) {
          if (q !== p && rectTouchesCircle(c.rect, q.x, q.y, (q.r ?? PAD_R) * (q.mark === "target" ? 1.47 : 1) + 0.12)) return false;
        }
        for (const d of s.decals ?? []) {
          const dr = decalRect(d);
          if (dr && rectsTouch(c.rect, dr, 0.1)) return false;
        }
        for (const other of onFace.get(s) ?? []) if (rectsTouch(c.rect, other, 0.15)) return false;
      } else {
        // Bench text must not land on, or behind, any solid.
        for (const o of ctx.outlines) if (polysOverlap(c.quad, o, 0.15)) return false;
      }
      if (c.samples.some((q) => isHidden(q, ctx.blocks))) return false;
      for (const l of labels) if (polysOverlap(c.quad, l.quad, 0.1)) return false;
      for (const run of nowRuns) if (polylineHitsConvex(run, c.quad, WIRE_HALF + 0.15)) return false;
      const near = inflate(c.quad, 0.9);
      if (dots.some((d) => pointInConvex(d, near))) return false;
      if (strict) for (const run of doneRuns) if (polylineHitsConvex(run, c.quad, 0.3)) return false;
      return true;
    };
    const cands = labelCandidates(s, p, text);
    // First a place no wire touches at all; failing that, one only finished wires pass under.
    const pick = cands.find((c) => ok(c, true)) ?? cands.find((c) => ok(c, false));
    if (!pick) {
      unplaced.push({ part: s.part, pin: p.pin, text, target: p.mark === "target" });
      continue;
    }
    if (pick.kind === "face") onFace.set(s, [...(onFace.get(s) ?? []), pick.rect]);
    labels.push({ text, quad: pick.quad, kind: pick.kind, part: s.part, pin: p.pin, target: p.mark === "target", samples: pick.samples });
    svg += pick.svg;
  }
  return { labels, svg, unplaced };
}

// ---------------------------------------------------------------------------
// Scene
// ---------------------------------------------------------------------------

export const FREE_FONT = `font-family="Noto Sans, Helvetica Neue, Arial, sans-serif" font-weight="700"`;

/** The box an upright caption covers on the page. */
export const freeTextQuad = (t: FreeText): Pt[] => textQuad(t.at, [1, 0], [0, 1], t.text, t.size, t.anchor);

export function renderScene(scene: Scene): Rendered {
  const bb: BBox = { minX: Infinity, minY: Infinity, maxX: -Infinity, maxY: -Infinity };
  const see = scene.seeThrough ?? [];
  const ghostOf = (s: Solid): Ghost => (s.style === "ghost" ? "landing" : see.some((p) => isHiddenBy(p, s)) ? "see-through" : false);
  const opaque = scene.solids.filter((s) => !ghostOf(s));
  const ghosts = scene.solids.filter((s) => ghostOf(s));
  const geom: SceneGeom = { solids: [], pads: [], wires: [], labels: [], guides: [], arrows: [], unplaced: [] };

  let svg = "";
  for (const s of [...paintOrder(opaque), ...ghosts]) {
    const ghost = ghostOf(s);
    solidBBox(s, bb);
    svg += s.kind === "cyl" ? drawCyl(s, ghost) : drawBox(s, ghost);
    geom.solids.push({ solid: s, ghost: ghost !== false, outline: silhouette(s) });
    if (ghost === "landing") continue;
    for (const p of s.pads ?? []) {
      if (p.ring === false) continue;
      const at: V3 = [s.x + p.x, s.y + p.y, s.z + s.h];
      geom.pads.push({ part: s.part, pin: p.pin, at, screen: proj(...at), target: p.mark === "target" });
    }
  }

  const wires = drawWires(scene.wires ?? [], opaque);
  geom.wires = wires.drawn;
  for (const w of wires.drawn) for (const run of w.runs) grow(bb, run, 1);

  const placed = placeLabels({ solids: scene.solids.filter((s) => ghostOf(s) !== "landing"), blocks: opaque, outlines: geom.solids.map((s) => s.outline), wires: wires.drawn });
  geom.labels = placed.labels;
  geom.unplaced = placed.unplaced;
  let top = placed.svg;
  for (const t of scene.texts ?? []) {
    const quad = freeTextQuad(t);
    geom.labels.push({ text: t.text, quad, kind: "free", part: t.part });
    if (t.leader) top += `<line x1="${f(t.leader[0][0])}" y1="${f(t.leader[0][1])}" x2="${f(t.leader[1][0])}" y2="${f(t.leader[1][1])}" stroke="#111" stroke-width="${THIN}"/>`;
    top +=
      `<text x="${f(t.at[0])}" y="${f(t.at[1])}" text-anchor="${t.anchor}" font-size="${f(t.size)}" ${FREE_FONT} fill="#111" ` +
      `stroke="#fff" stroke-width="${f(t.size * 0.3)}" paint-order="stroke" stroke-linejoin="round">${esc(t.text)}</text>`;
  }
  for (const l of geom.labels) grow(bb, l.quad, 0.3);

  // Guide lines stop where a solid is in front of them and step aside for text.
  const boxes = geom.labels.map((l) => inflate(l.quad, 0.5));
  for (const g of scene.guides ?? []) {
    const runs = visibleSegments(g.a, g.b, opaque);
    const drawn = runs.flatMap(([p, q]) => cutUnder(proj(...p), proj(...q), boxes));
    geom.guides.push({ a: g.a, b: g.b, runs, drawn });
    for (const [a, b] of drawn) {
      svg += `<line x1="${f(a[0])}" y1="${f(a[1])}" x2="${f(b[0])}" y2="${f(b[1])}" stroke="#111" stroke-width="${THIN}"${g.dash ? ` stroke-dasharray="1.2 0.9"` : ""}/>`;
    }
  }
  svg += wires.done + wires.now + top;
  for (const a of scene.arrows ?? []) {
    const poly = arrowPoly(a.a, a.b);
    if (!poly) continue;
    geom.arrows.push(poly);
    svg += `<polygon points="${pts(poly)}" fill="#111"/>`;
  }
  if (!Number.isFinite(bb.minX)) return { svg, bbox: { minX: 0, minY: 0, maxX: 1, maxY: 1 }, geom };
  return { svg, bbox: bb, geom };
}

export const SVG_DEFS =
  `<defs><pattern id="bt-hatch" width="1.4" height="1.4" patternUnits="userSpaceOnUse" patternTransform="rotate(35)">` +
  `<line x1="0" y1="0" x2="0" y2="1.4" stroke="#111" stroke-width="0.22"/></pattern></defs>`;

export const SVG_STYLE = `.bt-silk{font-family:"Helvetica Neue",Arial,sans-serif;font-weight:600;fill:#111}`;

/** Wrap rendered scene markup in a standalone SVG sized to its content. */
export function toSvg(inner: string, bb: BBox, pad = 4, extra = ""): string {
  const x = bb.minX - pad;
  const y = bb.minY - pad;
  const w = bb.maxX - bb.minX + pad * 2;
  const h = bb.maxY - bb.minY + pad * 2;
  return (
    `<svg xmlns="http://www.w3.org/2000/svg" viewBox="${f(x)} ${f(y)} ${f(w)} ${f(h)}" role="img">` +
    `<style>${SVG_STYLE}</style>${SVG_DEFS}${inner}${extra}</svg>`
  );
}

// ---------------------------------------------------------------------------
// Parts to solids
// ---------------------------------------------------------------------------

type Rot = 0 | 90 | 180 | 270;

/** Rotate a part-local point clockwise (seen from above) inside a W x D outline. */
export function rotPoint(x: number, y: number, W: number, D: number, rot: Rot): Pt {
  if (rot === 90) return [D - y, x];
  if (rot === 180) return [W - x, D - y];
  if (rot === 270) return [y, W - x];
  return [x, y];
}

function rotRect(x: number, y: number, w: number, d: number, W: number, D: number, rot: Rot) {
  const a = rotPoint(x, y, W, D, rot);
  const b = rotPoint(x + w, y + d, W, D, rot);
  return { x: Math.min(a[0], b[0]), y: Math.min(a[1], b[1]), w: Math.abs(a[0] - b[0]), d: Math.abs(a[1] - b[1]) };
}

export function footprint(p: PlacedPart): { w: number; d: number } {
  const swap = p.at.rot === 90 || p.at.rot === 270;
  return swap ? { w: p.def.body.d, d: p.def.body.w } : { w: p.def.body.w, d: p.def.body.d };
}

/** World position of a pin's pad, on the top surface of the part body. */
export function pinWorld(p: PlacedPart, pinName: string): V3 {
  const pin = p.def.pins.find((q) => q.name === pinName || q.aliases?.includes(pinName));
  if (!pin) throw new Error(`${p.use.ref} (${p.def.id}) has no pin "${pinName}"`);
  const [x, y] = rotPoint(pin.x, pin.y, p.def.body.w, p.def.body.d, p.at.rot);
  return [p.at.x + x, p.at.y + y, p.at.z + p.def.body.h];
}

/**
 * Shapes where a wire ends: a pin header, a screw terminal, a plug socket. The pins
 * inside their footprint are what the shape terminates, so the pad is on it, not behind it.
 */
export const TERMINATION_TAGS: ReadonlySet<string> = new Set(["header", "screw-terminal", "connector"]);
/** A termination up to this tall (mm) is named on the board beside it; a taller one on its own top face. */
const LOW_TERMINATION = 3;

/**
 * The termination shape (see TERMINATION_TAGS) that stands over a pin, when there is one.
 * Below, "header" stands for all of them. On the modules
 * with a header (microphone, buzzer, amplifier, relay) the pins of the header ARE the
 * pads: with soldered leads the builder solders to the pad holes, with jumper leads the
 * lead pushes onto the pin. So the pad is drawn on top of the header and wires end on
 * its top face, instead of on the board under a box that would hide them (partSolids
 * and solderPoint are the two places that read this). A part file needs nothing beyond
 * tagging the shape "header".
 */
function headerOver(def: PartDef, pin: PinDef): Extract<Shape, { kind: "box" }> | undefined {
  if (pin.z !== undefined) return undefined;
  return def.shapes?.find(
    (s): s is Extract<Shape, { kind: "box" }> =>
      s.kind === "box" && s.tag !== undefined && TERMINATION_TAGS.has(s.tag) && pin.x >= s.x && pin.x <= s.x + s.w && pin.y >= s.y && pin.y <= s.y + s.d,
  );
}

/** A lead tab: shortest length drawn, width, thickness, pad radius, and how far the pad sits from the tab's outer end. */
const LEAD = { length: 1.4, width: 1, thick: 0.35, pad: 0.36, inset: 0.7 };

interface LeadBox {
  x: number;
  y: number;
  z: number;
  w: number;
  d: number;
  h: number;
  out: Dir;
  /** Solder point in the tab's own coordinates. */
  pad: Pt;
}

/**
 * The tab that stands for a lead leaving the body below its top face (PinDef.z): a
 * thin plate on the body edge nearest the pin, at the lead's height, with the solder
 * point near its outer end. It is drawn as short as possible, and lengthened, up to
 * the lead length the part file gives, until the solder point shows past the part's
 * own solids (`own`): the far lead of an axial resistor is long enough to be seen
 * behind its body, the far leg of a push button is not.
 */
function leadBox(p: PlacedPart, pin: PinDef, own: readonly Block[]): LeadBox {
  const fp = footprint(p);
  const [x, y] = rotPoint(pin.x, pin.y, p.def.body.w, p.def.body.d, p.at.rot);
  // The nearest edge; for a pin as near to two edges (a leg under the middle of the
  // body), the one that faces the viewer, listed first here.
  const edges: [number, Dir][] = [
    [fp.d - y, "y+"],
    [fp.w - x, "x+"],
    [x, "x-"],
    [y, "y-"],
  ];
  edges.sort((m, n) => (Math.abs(m[0] - n[0]) < 0.25 ? 0 : m[0] - n[0]));
  const out = edges[0]![1];
  const top = Math.min(p.at.z + p.def.body.h, Math.max(p.at.z + LEAD.thick, p.at.z + p.def.body.h + (pin.z ?? 0)));
  const z = top - LEAD.thick;
  const along = (c: number, size: number): number => Math.min(size - LEAD.width, Math.max(0, c - LEAD.width / 2));
  const make = (len: number): LeadBox => {
    const h = LEAD.thick;
    if (out === "x-") return { x: p.at.x - len, y: p.at.y + along(y, fp.d), z, w: len, d: LEAD.width, h, out, pad: [LEAD.inset, LEAD.width / 2] };
    if (out === "x+") return { x: p.at.x + fp.w, y: p.at.y + along(y, fp.d), z, w: len, d: LEAD.width, h, out, pad: [len - LEAD.inset, LEAD.width / 2] };
    if (out === "y-") return { x: p.at.x + along(x, fp.w), y: p.at.y - len, z, w: LEAD.width, d: len, h, out, pad: [LEAD.width / 2, LEAD.inset] };
    return { x: p.at.x + along(x, fp.w), y: p.at.y + fp.d, z, w: LEAD.width, d: len, h, out, pad: [LEAD.width / 2, len - LEAD.inset] };
  };
  const longest = Math.max(LEAD.length, pin.lead ?? 1.5);
  for (let len = LEAD.length; len <= longest + 1e-9; len += 0.5) {
    const b = make(len);
    if (!isHidden([b.x + b.pad[0], b.y + b.pad[1], b.z + b.h], own)) return b;
  }
  return make(LEAD.length);
}

/** The body of a placed part and the shapes standing on it, as plain blocks. */
function ownBlocks(p: PlacedPart): Block[] {
  return partSolids(p, { labels: false });
}

/**
 * Where a wire is soldered to a pin: the pad on the top face, or, for a pin whose part
 * file gives it a `z`, the end of its lead. This is the point the bench drawings end
 * a wire on; pinWorld stays the pad position used for PCB footprints.
 */
export function solderPoint(p: PlacedPart, pinName: string): V3 {
  const pin = p.def.pins.find((q) => q.name === pinName || q.aliases?.includes(pinName));
  if (!pin) throw new Error(`${p.use.ref} (${p.def.id}) has no pin "${pinName}"`);
  const header = headerOver(p.def, pin);
  if (header) {
    const [x, y, z] = pinWorld(p, pinName);
    return [x, y, z + (header.z ?? 0) + header.h];
  }
  if (pin.z === undefined) return pinWorld(p, pinName);
  const b = leadBox(p, pin, ownBlocks(p));
  return [b.x + b.pad[0], b.y + b.pad[1], b.z + b.h];
}

function rotDecal(d: Decal, W: number, D: number, rot: Rot): Decal {
  if (rot === 0 || d.face !== "top") return d;
  if (d.kind === "rect") {
    const r = rotRect(d.x, d.y, d.w, d.h, W, D, rot);
    return { ...d, x: r.x, y: r.y, w: r.w, h: r.d };
  }
  const [x, y] = rotPoint(d.x, d.y, W, D, rot);
  if (d.kind === "text" && (rot === 90 || rot === 270)) {
    return { ...d, x, y, along: d.along === "y" ? "x" : "y" };
  }
  return { ...d, x, y };
}

/**
 * Turn a placed part into drawable solids: the body with its pads and silkscreen,
 * then every component standing on it. `targets` names pins to draw as filled pads.
 * With `leads`, a pin that has a `z` in its part file is drawn as a lead tab on the
 * body edge instead of a pad on the top face; the tabs come after the shapes.
 */
export function partSolids(
  p: PlacedPart,
  opts: { targets?: string[]; labels?: boolean; style?: "solid" | "ghost"; leads?: boolean } = {},
): Solid[] {
  const { def, at } = p;
  const W = def.body.w;
  const D = def.body.d;
  const fp = footprint(p);
  const onLead = (pin: PinDef): boolean => opts.leads === true && pin.z !== undefined;
  // A pad on the top face of `host`, a box of size w x d whose corner is at (ox, oy) in
  // the part's turned frame. Pins inside a header shape are put on that shape (see headerOver).
  const padOn = (pin: PinDef, ox: number, oy: number, w: number, d: number): Pad => {
    const [px, py] = rotPoint(pin.x, pin.y, W, D, at.rot);
    const x = px - ox;
    const y = py - oy;
    // Label runs inward from whichever edge the pad is closest to.
    const edges: [number, Pad["labelDir"]][] = [
      [x, "x+"],
      [w - x, "x-"],
      [y, "y+"],
      [d - y, "y-"],
    ];
    edges.sort((m, n) => m[0] - n[0]);
    const isTarget = opts.targets?.includes(pin.name) ?? false;
    return {
      x,
      y,
      label: opts.labels === false ? undefined : pin.name,
      labelDir: edges[0]![1],
      mark: isTarget ? "target" : undefined,
      pin: pin.name,
    };
  };
  // A pin on a tall termination (a screw terminal) is named on the terminal's own top
  // face: a name on the board would sit too far below the pad to read as its name.
  // A low one (a header) is named on the board beside it.
  const tallOver = (pin: PinDef): boolean => {
    const t = headerOver(def, pin);
    return t !== undefined && t.tag === "screw-terminal" && t.h > LOW_TERMINATION;
  };
  const pads: Pad[] = def.pins
    .filter((pin) => !onLead(pin) && !tallOver(pin))
    .map((pin): Pad => (headerOver(def, pin) ? { ...padOn(pin, 0, 0, fp.w, fp.d), ring: false } : padOn(pin, 0, 0, fp.w, fp.d)));
  const solids: Solid[] = [
    {
      kind: "box",
      x: at.x,
      y: at.y,
      z: at.z,
      w: fp.w,
      d: fp.d,
      h: def.body.h,
      decals: (def.decals ?? []).map((d) => rotDecal(d, W, D, at.rot)),
      pads,
      style: opts.style,
      tag: p.use.ref,
      part: p.use.ref,
    },
  ];
  for (const sh of def.shapes ?? []) {
    const z = at.z + def.body.h + (sh.z ?? 0);
    if (sh.kind === "box") {
      const r = rotRect(sh.x, sh.y, sh.w, sh.d, W, D, at.rot);
      const headerPads = def.pins.filter((pin) => !onLead(pin) && headerOver(def, pin) === sh).map((pin): Pad => (tallOver(pin) ? padOn(pin, r.x, r.y, r.w, r.d) : { ...padOn(pin, r.x, r.y, r.w, r.d), label: undefined }));
      solids.push({
        kind: "box",
        x: at.x + r.x,
        y: at.y + r.y,
        z,
        w: r.w,
        d: r.d,
        h: sh.h,
        decals: sh.decals,
        pads: headerPads.length ? headerPads : undefined,
        style: opts.style,
        tag: sh.tag,
        part: p.use.ref,
      });
    } else {
      const [cx, cy] = rotPoint(sh.x, sh.y, W, D, at.rot);
      solids.push({
        kind: "cyl",
        x: at.x + cx - sh.r,
        y: at.y + cy - sh.r,
        z,
        w: sh.r * 2,
        d: sh.r * 2,
        h: sh.h,
        r: sh.r,
        style: opts.style,
        tag: sh.tag,
        part: p.use.ref,
      });
    }
  }
  // Leads are measured against the body and shapes only, never against each other.
  const own: Block[] = [...solids];
  for (const pin of def.pins.filter(onLead)) {
    const b = leadBox(p, pin, own);
    solids.push({
      kind: "box",
      x: b.x,
      y: b.y,
      z: b.z,
      w: b.w,
      d: b.d,
      h: b.h,
      pads: [
        {
          x: b.pad[0],
          y: b.pad[1],
          r: LEAD.pad,
          label: opts.labels === false ? undefined : pin.name,
          labelDir: b.out,
          mark: opts.targets?.includes(pin.name) ? "target" : undefined,
          pin: pin.name,
        },
      ],
      style: opts.style,
      tag: `lead ${pin.name}`,
      part: p.use.ref,
    });
  }
  return solids;
}

/**
 * Magnified circular inset of a scene centred on one world point, with a tail back
 * to that point. `sceneId` must be the id of a <g> holding the scene markup.
 */
export function zoomBubble(sceneId: string, id: string, target: V3, centre: Pt, radius: number, zoom: number): string {
  const t = proj(...target);
  const dx = t[0] - centre[0];
  const dy = t[1] - centre[1];
  const len = Math.hypot(dx, dy) || 1;
  const ux = dx / len;
  const uy = dy / len;
  // Tail: a narrow wedge from the bubble rim to the target, like a speech-bubble tail.
  const spread = 0.22;
  const rimA: Pt = [
    centre[0] + radius * Math.cos(Math.atan2(uy, ux) - spread),
    centre[1] + radius * Math.sin(Math.atan2(uy, ux) - spread),
  ];
  const rimB: Pt = [
    centre[0] + radius * Math.cos(Math.atan2(uy, ux) + spread),
    centre[1] + radius * Math.sin(Math.atan2(uy, ux) + spread),
  ];
  const tx = f(centre[0] - t[0] * zoom);
  const ty = f(centre[1] - t[1] * zoom);
  return (
    `<clipPath id="${id}"><circle cx="${f(centre[0])}" cy="${f(centre[1])}" r="${f(radius)}"/></clipPath>` +
    `<polygon points="${pts([rimA, t, rimB])}" fill="#fff" stroke="#111" stroke-width="${THIN * 1.6}" stroke-linejoin="round"/>` +
    `<circle cx="${f(centre[0])}" cy="${f(centre[1])}" r="${f(radius)}" fill="#fff"/>` +
    `<g clip-path="url(#${id})"><use href="#${sceneId}" transform="translate(${tx} ${ty}) scale(${zoom})"/></g>` +
    `<circle cx="${f(centre[0])}" cy="${f(centre[1])}" r="${f(radius)}" fill="none" stroke="#111" stroke-width="${HEAVY}"/>`
  );
}

// Re-exported so the drawing check and the tests measure with the renderer's own rulers.
export { backtrack, circlePoly, occluders, sharpestTurn };
