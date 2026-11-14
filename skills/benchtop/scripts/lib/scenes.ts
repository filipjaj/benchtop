// Scene builders shared by the guide and the landing page: the parts laid out on the
// bench with their wires, the enclosure open and closed, the carrier PCB.
//
// Every builder that draws something a builder has to act on comes in two forms: the
// original one returning SVG, and an `...Art` one that also returns the geometry that
// was drawn, which guide.ts hands to the drawing check.

import type { EnclosureLayout, Opening } from "./enclosure-layout";
import { type HoverItem, type HoverPlaced, liftSolid, planHover } from "./explode";
import { inflate, isHidden, isHiddenBy, pointInConvex, polylineHitsConvex, silhouette, textQuad, textWidth } from "./geom";
import {
  type BBox,
  type DrawnLabel,
  type FreeText,
  type Pt,
  type Rendered,
  type Scene,
  type SceneGeom,
  type Solid,
  type V3,
  type Wire3,
  FREE_FONT,
  WIRE_HALF,
  arrowPoly,
  esc,
  footprint,
  partSolids,
  pinWorld,
  proj,
  renderScene,
  solderPoint,
  toSvg,
  zoomBubble,
} from "./iso";
import type { PcbLayout } from "./pcb-layout";
import { type Loaded, findPin, parseEnd } from "./project";
import type { Connection, Decal, PlacedPart } from "./types";

export interface WireEnd {
  ref: string;
  pin: string;
  part: PlacedPart;
  at: V3;
}

/** A drawing together with the geometry it was made from. */
export interface Art {
  svg: string;
  geom: SceneGeom;
}

/** An exploded drawing, with the refs of the parts it shows hovering. */
export interface HoverArt extends Art {
  refs: string[];
}

// ---------------------------------------------------------------------------
// The bench as the booklet shows it
// ---------------------------------------------------------------------------

const views = new WeakMap<Loaded, Loaded>();
const isView = new WeakSet<Loaded>();

/** Names of the pins each part has a wire on. */
function wiredPins(loaded: Loaded): Map<string, Set<string>> {
  const out = new Map<string, Set<string>>();
  for (const c of loaded.project.connections) {
    for (const end of [c.from, c.to]) {
      const { ref, pin } = parseEnd(end);
      const part = loaded.byRef.get(ref);
      const def = part && findPin(part.def, pin);
      if (!def) continue;
      if (!out.has(ref)) out.set(ref, new Set());
      out.get(ref)!.add(def.name);
    }
  }
  return out;
}

const benchSolids = (parts: readonly PlacedPart[]): Solid[] => parts.flatMap((p) => partSolids(p, { labels: false, leads: true }));

/**
 * The bench layout as the booklet draws it. The layout in project.ts turns each module
 * so its pads face the controller; that can leave a pin that has a wire on it behind
 * one of the part's own tall shapes (the far legs of a push button behind its stem).
 * A part whose `bench` gives no `rot` (no `bench` at all, or only x and y) is turned,
 * about its own centre, to the quarter turn that hides the fewest of its wired pins. A
 * part whose `bench` gives `rot` is left exactly as the project put it; the drawing
 * check reports a hidden pad on it with the turn that would show it. Every page draws
 * the bench from this one viewpoint.
 */
export function benchView(loaded: Loaded): Loaded {
  if (isView.has(loaded)) return loaded;
  const cached = views.get(loaded);
  if (cached) return cached;
  const wired = wiredPins(loaded);
  const placed = loaded.placed.map((p) => ({ ...p, at: { ...p.at } }));
  const hiddenPins = (parts: readonly PlacedPart[], p: PlacedPart): number => {
    const blocks = benchSolids(parts);
    return [...(wired.get(p.use.ref) ?? [])].filter((pin) => isHidden(solderPoint(p, pin), blocks)).length;
  };
  for (let i = 0; i < placed.length; i++) {
    const p = placed[i]!;
    if (p.use.bench?.rot !== undefined || !wired.has(p.use.ref)) continue;
    let best = hiddenPins(placed, p);
    if (best === 0) continue;
    const fp = footprint(p);
    const cx = p.at.x + fp.w / 2;
    const cy = p.at.y + fp.d / 2;
    for (const turn of [90, 270, 180] as const) {
      const turned: PlacedPart = { ...p, at: { ...p.at, rot: ((p.at.rot + turn) % 360) as 0 | 90 | 180 | 270 } };
      const tf = footprint(turned);
      turned.at.x = cx - tf.w / 2;
      turned.at.y = cy - tf.d / 2;
      // Keep working room between parts: a turn that brings two outlines within 5 mm is not taken.
      const crowds = placed.some((q, k) => {
        if (k === i) return false;
        const qf = footprint(q);
        return turned.at.x < q.at.x + qf.w + 5 && q.at.x < turned.at.x + tf.w + 5 && turned.at.y < q.at.y + qf.d + 5 && q.at.y < turned.at.y + tf.d + 5;
      });
      if (crowds) continue;
      const trial = placed.map((q, k) => (k === i ? turned : q));
      const n = hiddenPins(trial, turned);
      if (n < best) {
        best = n;
        placed[i] = turned;
      }
    }
  }
  const view: Loaded = { ...loaded, placed, byRef: new Map(placed.map((p) => [p.use.ref, p])) };
  isView.add(view);
  views.set(loaded, view);
  return view;
}

type Rot = 0 | 90 | 180 | 270;
const toRot = (r: number): Rot => ((((Math.round(r) % 360) + 360) % 360) as Rot);

function asView(loaded: Loaded, placed: PlacedPart[]): Loaded {
  const v: Loaded = { ...loaded, placed, byRef: new Map(placed.map((p) => [p.use.ref, p])) };
  isView.add(v);
  return v;
}

/** One part turned by `turn` degrees about its own centre, the rest as they are. */
function turnPart(view: Loaded, ref: string, turn: 90 | 180 | 270): Loaded {
  const placed = view.placed.map((p) => {
    if (p.use.ref !== ref) return p;
    const fp = footprint(p);
    const turned: PlacedPart = { ...p, at: { ...p.at, rot: toRot(p.at.rot + turn) } };
    const tf = footprint(turned);
    turned.at.x = p.at.x + fp.w / 2 - tf.w / 2;
    turned.at.y = p.at.y + fp.d / 2 - tf.d / 2;
    return turned;
  });
  return asView(view, placed);
}

/** The solids that stand in front of a wired pad, by name; empty when it can be seen. */
function hidersOf(view: Loaded, ref: string, pin: string): string[] {
  const part = view.byRef.get(ref)!;
  const at = solderPoint(part, pin);
  return benchSolids(view.placed)
    .filter((s) => isHiddenBy(at, s))
    .map((s) => (s.part && s.tag && s.tag !== s.part ? `${s.part} ${s.tag}` : (s.part ?? s.tag ?? s.kind)));
}

const crowding = (view: Loaded, ref: string): boolean => {
  const p = view.byRef.get(ref)!;
  const f = footprint(p);
  return view.placed.some((q) => {
    if (q === p) return false;
    const g = footprint(q);
    return Math.min(p.at.x + f.w, q.at.x + g.w) - Math.max(p.at.x, q.at.x) > 0.3 && Math.min(p.at.y + f.d, q.at.y + g.d) - Math.max(p.at.y, q.at.y) > 0.3;
  });
};

/** Everything `guide.ts --explain` says about one part of the bench. */
export interface BenchExplain {
  ref: string;
  part: string;
  /** What to write as `bench` to get exactly the drawing the booklet shows. */
  bench: { x: number; y: number; rot: number };
  /** Wired pads that are behind something in the overview, and behind what. */
  hides: { pin: string; by: string[] }[];
  /** Each turn about the part's own centre: the bench value and how many wired pads it still hides. */
  turns: { degrees: number; bench: { x: number; y: number; rot: number }; hides: number; hidden: string[]; overlaps: boolean }[];
}

const round2 = (n: number): number => Math.round(n * 100) / 100;

export function explainBench(loaded: Loaded): BenchExplain[] {
  const view = benchView(loaded);
  const wired = wiredPins(view);
  const hiddenIn = (v: Loaded, ref: string): string[] => [...(wired.get(ref) ?? [])].filter((pin) => hidersOf(v, ref, pin).length > 0);
  return view.placed.map((p) => {
    const ref = p.use.ref;
    const at = (q: PlacedPart) => ({ x: round2(q.at.x), y: round2(q.at.y), rot: q.at.rot });
    const turns = ([0, 90, 180, 270] as const).map((t) => {
      const v = t === 0 ? view : turnPart(view, ref, t);
      const hidden = hiddenIn(v, ref);
      return { degrees: t, bench: at(v.byRef.get(ref)!), hides: hidden.length, hidden, overlaps: crowding(v, ref) };
    });
    return {
      ref,
      part: p.def.id,
      bench: at(p),
      hides: [...(wired.get(ref) ?? [])].map((pin) => ({ pin, by: hidersOf(view, ref, pin) })).filter((h) => h.by.length),
      turns,
    };
  });
}

export function wireEnds(loaded: Loaded, c: Connection): [WireEnd, WireEnd] {
  const view = benchView(loaded);
  const end = (s: string): WireEnd => {
    const { ref, pin } = parseEnd(s);
    const part = view.byRef.get(ref)!;
    // Normalise aliases to the silkscreen name so the drawing and caption agree.
    const name = findPin(part.def, pin)!.name;
    return { ref, pin: name, part, at: solderPoint(part, name) };
  };
  return [end(c.from), end(c.to)];
}

/** Default wire colour by what the wire carries, so power is red and ground black without being told. */
export function wireColor(loaded: Loaded, c: Connection, index: number): string {
  if (c.color) return c.color;
  const [a, b] = wireEnds(loaded, c);
  const roles = [findPin(a.part.def, a.pin)!.role, findPin(b.part.def, b.pin)!.role];
  if (roles.includes("gnd")) return "black";
  if (roles.includes("power-out") || roles.includes("power-in")) return "red";
  return ["yellow", "blue", "green", "orange", "purple", "white"][index % 6]!;
}

/** Bench scene with the first `upTo` connections made and connection `now` being added. */
export function benchScene(loaded: Loaded, upTo: number, now: number | null): Scene {
  const view = benchView(loaded);
  const targets = new Map<string, string[]>();
  if (now !== null) {
    for (const e of wireEnds(view, view.project.connections[now]!)) {
      targets.set(e.ref, [...(targets.get(e.ref) ?? []), e.pin]);
    }
  }
  const solids = view.placed.flatMap((p) => partSolids(p, { targets: targets.get(p.use.ref), leads: true }));
  const wires: Wire3[] = [];
  view.project.connections.forEach((c, i) => {
    if (i >= upTo && i !== now) return;
    const [a, b] = wireEnds(view, c);
    wires.push({
      a: a.at,
      b: b.at,
      color: wireColor(view, c, i),
      state: i === now ? "now" : "done",
      ends: [
        { ref: a.ref, pin: a.pin },
        { ref: b.ref, pin: b.pin },
      ],
    });
  });
  return { solids, wires };
}

export function union(a: BBox, b: BBox): BBox {
  return {
    minX: Math.min(a.minX, b.minX),
    minY: Math.min(a.minY, b.minY),
    maxX: Math.max(a.maxX, b.maxX),
    maxY: Math.max(a.maxY, b.maxY),
  };
}

// ---------------------------------------------------------------------------
// Framing a step on the parts it joins
// ---------------------------------------------------------------------------

/** Room the locator takes at the foot of a step's drawing, in the drawing's millimetres. */
const LOCATOR = { w: 46, h: 26, gap: 4 };

/**
 * The part of the bench a step is about: the outlines of the two parts it joins and the
 * wire between them, with room around them for enough of their neighbours to tell where
 * they are. Seen from the same side as every other page.
 */
function stepRegion(view: Loaded, ends: readonly WireEnd[], main: Rendered): { core: BBox; region: BBox } {
  const bb = emptyBox();
  for (const ref of new Set(ends.map((e) => e.ref))) growBox(bb, partOutline(view, ref));
  for (const w of main.geom.wires.filter((x) => x.state === "now")) growBox(bb, w.path);
  const m = Math.max(14, 0.3 * Math.max(bb.maxX - bb.minX, bb.maxY - bb.minY));
  return { core: bb, region: { minX: bb.minX - m, minY: bb.minY - m, maxX: bb.maxX + m, maxY: bb.maxY + m } };
}

const emptyBox = (): BBox => ({ minX: Infinity, minY: Infinity, maxX: -Infinity, maxY: -Infinity });

function growBox(bb: BBox, pts: readonly Pt[]): BBox {
  for (const p of pts) {
    bb.minX = Math.min(bb.minX, p[0]);
    bb.maxX = Math.max(bb.maxX, p[0]);
    bb.minY = Math.min(bb.minY, p[1]);
    bb.maxY = Math.max(bb.maxY, p[1]);
  }
  return bb;
}

function partOutline(view: Loaded, ref: string): Pt[] {
  return partSolids(view.byRef.get(ref)!, { labels: false, leads: true }).flatMap((s) => [...silhouette(s)]);
}

/** A neighbour shown by less than this share of its outline reads as a stray mark, not as a part. */
const SLIVER = 0.2;
/** Room that stays between the frame and the two parts it is about, whatever is trimmed. */
const MIN_FRAME_MARGIN = 5;

/**
 * Pull the frame in past any neighbour it would show only a corner of. A frame cuts the
 * parts around a step, and a part cut down to a few millimetres of edge is a stray mark
 * on the page. Each such part is put outside the frame by moving the nearest edge, as long
 * as the edge stays clear of `core` (the two parts and the wire the step is about).
 */
export function trimSlivers(region: BBox, core: BBox, neighbours: readonly BBox[]): BBox {
  const r = { ...region };
  for (const n of neighbours) {
    const w = Math.min(r.maxX, n.maxX) - Math.max(r.minX, n.minX);
    const h = Math.min(r.maxY, n.maxY) - Math.max(r.minY, n.minY);
    const whole = (n.maxX - n.minX) * (n.maxY - n.minY);
    if (w <= 0 || h <= 0 || whole <= 0 || (w * h) / whole >= SLIVER) continue;
    // The four edges that would leave this neighbour outside, cheapest first.
    const moves: { loss: number; apply: () => void }[] = [];
    if (n.maxX <= core.minX - MIN_FRAME_MARGIN) moves.push({ loss: n.maxX - r.minX, apply: () => (r.minX = n.maxX) });
    if (n.minX >= core.maxX + MIN_FRAME_MARGIN) moves.push({ loss: r.maxX - n.minX, apply: () => (r.maxX = n.minX) });
    if (n.maxY <= core.minY - MIN_FRAME_MARGIN) moves.push({ loss: n.maxY - r.minY, apply: () => (r.minY = n.maxY) });
    if (n.minY >= core.maxY + MIN_FRAME_MARGIN) moves.push({ loss: r.maxY - n.minY, apply: () => (r.maxY = n.minY) });
    moves.sort((a, b) => a.loss - b.loss)[0]?.apply();
  }
  return r;
}

/** Grow `r` (never beyond `limit`) until its height is at least `aspect` of its width, so a framed step is not a strip. */
function expandToAspect(r: BBox, limit: BBox, aspect: number): BBox {
  const w = r.maxX - r.minX;
  const h = r.maxY - r.minY;
  const want = Math.min(w * aspect, limit.maxY - limit.minY);
  if (h >= want) return r;
  let minY = r.minY - (want - h) / 2;
  let maxY = r.maxY + (want - h) / 2;
  if (minY < limit.minY) [minY, maxY] = [limit.minY, limit.minY + want];
  if (maxY > limit.maxY) [minY, maxY] = [limit.maxY - want, limit.maxY];
  return { ...r, minY, maxY };
}

const benchRenders = new WeakMap<Loaded, Rendered>();

/**
 * A small drawing of the whole bench, from the same side as the step, with the part of it
 * the step shows framed and the two parts it joins shaded. It sits under a step that shows
 * only part of the bench, so the builder can tell where on the desk the step is.
 */
function locator(view: Loaded, region: BBox, refs: readonly string[], at: Pt): { svg: string; w: number; h: number } {
  let bench = benchRenders.get(view);
  if (!bench) benchRenders.set(view, (bench = renderScene({ solids: view.placed.flatMap((p) => partSolids(p, { labels: false })) })));
  const bw = bench.bbox.maxX - bench.bbox.minX;
  const bh = bench.bbox.maxY - bench.bbox.minY;
  const k = Math.min(LOCATOR.w / bw, LOCATOR.h / bh);
  const shade = refs
    .map((ref) => {
      const body = partSolids(view.byRef.get(ref)!, { labels: false })[0]!;
      return `<polygon points="${silhouette(body).map((p) => `${p[0].toFixed(2)},${p[1].toFixed(2)}`).join(" ")}" fill="#999" stroke="#111"/>`;
    })
    .join("");
  // The frame can reach past the bench (it keeps room around the two parts). Held inside
  // the bench's own outline here, or the page would show it with a side missing.
  const f = { minX: Math.max(region.minX, bench.bbox.minX), minY: Math.max(region.minY, bench.bbox.minY), maxX: Math.min(region.maxX, bench.bbox.maxX), maxY: Math.min(region.maxY, bench.bbox.maxY) };
  const frame = `<rect x="${f.minX.toFixed(2)}" y="${f.minY.toFixed(2)}" width="${(f.maxX - f.minX).toFixed(2)}" height="${(f.maxY - f.minY).toFixed(2)}" fill="none" stroke="#111" stroke-dasharray="4 2"/>`;
  const tx = at[0] - bench.bbox.minX * k;
  const ty = at[1] - bench.bbox.minY * k;
  return {
    svg: `<g class="bt-loc" transform="translate(${tx.toFixed(2)} ${ty.toFixed(2)}) scale(${k.toFixed(4)})">${bench.svg}${shade}${frame}</g>`,
    w: bw * k,
    h: bh * k,
  };
}

const stepRenders = new WeakMap<Loaded, Map<number, Rendered>>();

/** The bench with wire `index` being added, rendered once and kept. */
function stepRender(view: Loaded, index: number): Rendered {
  let cache = stepRenders.get(view);
  if (!cache) stepRenders.set(view, (cache = new Map()));
  let r = cache.get(index);
  if (!r) cache.set(index, (r = renderScene(benchScene(view, index, index))));
  return r;
}

/** One magnified bubble of a wiring step. */
export interface BubbleGeom {
  centre: Pt;
  radius: number;
  zoom: number;
  target: { ref: string; pin: string; at: V3; label: string };
  /** The scene shown inside the bubble: the step's own, or one redrawn with whatever hid the pad made see-through. */
  geom: SceneGeom;
  seeThrough: boolean;
  /** A separate, upright identification callout when a label cannot fit on a narrow lead. */
  detailCallout?: { label: DrawnLabel; anchor: Pt };
}

/** A wired pad of a step that is behind something in the step's main view. */
export interface HiddenPad {
  ref: string;
  pin: string;
  /** Names of what stands in front of it. */
  by: string[];
  /**
   * The turn of its part that shows it, as the `bench` value to write (in the project's
   * own coordinates), or null when no turn of the bench or the part does.
   */
  turn: { degrees: number; x: number; y: number; rot: number } | null;
}

export interface WiringStepGeom {
  /** What the drawing shows, in page millimetres. Text outside it is cut off by the drawing's frame and is not judged. */
  view?: BBox;
  /** Wired pads hidden in the main view, with what would clear each. */
  hidden?: HiddenPad[];
  main: SceneGeom;
  bubbles: BubbleGeom[];
  /** The two captions above the bubbles. */
  captions: DrawnLabel[];
}

export interface StepArt {
  svg: string;
  ends: [WireEnd, WireEnd];
  color: string;
  geom: WiringStepGeom;
  /** The drawing prints too small in half a page, so the booklet gives it a page of its own. */
  full: boolean;
  /** The part of the bench the drawing shows, in page millimetres (the whole bench unless the step is framed on its two parts). */
  area: BBox;
  /** Size of the drawing in its own millimetres, so the booklet can tell how small it will print in a given slot. */
  size: { w: number; h: number };
}

/** Room for the drawing of one step when it has a page to itself, in millimetres (the page less its number, caption and note). */
export const FULL_STEP = { w: 174, h: 190 };

/** A step drawing printed shorter than this (mm) in half a page takes a page of its own. */
const STEP_MIN_HEIGHT = 80;

/** Room for the drawing of one step when two steps share an A4 page, in millimetres. */
export const HALF_PAGE = { w: 174, h: 88 };

/** Height of the caption text above a bubble, in the drawing's own millimetres. */
export const STEP_CAPTION_SIZE = 3.4;

const CAPTION_SIZE = STEP_CAPTION_SIZE;
const BUBBLE = { r: 17, zoom: 2.6, gap: 7 };
/** A pad closer than this to its neighbour on the page (mm) gets a bubble magnified up to 1.9 times more. */
const DENSE_PAGE_MM = 3.2;

const blocksOf = (g: SceneGeom): Solid[] => g.solids.filter((s) => !s.ghost).map((s) => s.solid);

/**
 * A detail inset must identify its target even when the part has no face wide enough
 * for a label (a DIP lead is only about a millimetre wide). Keep the real solids,
 * pads and wire endpoints; remove the other labels in this inset only and place an
 * upright callout with a leader to the exact solder point. Never enlarge the part or
 * move its pins to make room. If no checked position fits, leave the failure visible.
 */
function targetDetail(scene: Scene, end: WireEnd, reach: number, zoom: number): { rendered: Rendered; callout?: BubbleGeom["detailCallout"] } {
  const rendered = renderScene({
    ...scene,
    solids: scene.solids.map((s) => ({ ...s, pads: s.pads?.map((p) => ({ ...p, label: undefined })) })),
    texts: [],
  });
  const anchor = proj(...end.at);
  const runs = rendered.geom.wires.filter((w) => w.state === "now").flatMap((w) => w.runs);
  // The usual places first (just above or below the pad), then rings of places all round
  // it out to the edge of the inset, so a name is only left out when the inset has no
  // clear spot for it anywhere.
  const spots: [number, number][] = [];
  for (const dy of [-2.5, 2.5, -4, 4, -1.5, 1.5]) for (const dx of [0, -2, 2, -3.5, 3.5]) spots.push([dx, dy]);
  for (let ring = 1.5; ring <= reach - 0.8; ring += 0.6) {
    for (let a = 0; a < 360; a += 20) spots.push([Math.cos((a * Math.PI) / 180) * ring, Math.sin((a * Math.PI) / 180) * ring]);
  }
  // A long name in a close-up (the inset is only a few millimetres across) does not fit at
  // the usual size: try smaller sizes, down to what still prints as large as a caption,
  // and for each size the clearance to the other pads: first generous, then tight.
  // The name is placed at the largest size and widest clearance that has a spot.
  const sizes: number[] = [];
  for (let s = 1.4; s * zoom >= CAPTION_SIZE * 0.85 - 1e-6 || s === 1.4; s -= 0.15) sizes.push(Math.round(s * 100) / 100);
  for (const [size, clear] of sizes.flatMap((s): [number, number][] => [[s, 0.65], [s, 0.25], [s, 0]])) {
    for (const [dx, dy] of spots) {
      const at: Pt = [anchor[0] + dx, anchor[1] + dy];
      const quad = textQuad(at, [1, 0], [0, 1], end.pin, size, "middle");
      const plate = inflate(quad, 0.35);
      if (plate.some((p) => Math.hypot(p[0] - anchor[0], p[1] - anchor[1]) > reach - 0.35)) continue;
      if (rendered.geom.pads.some((p) => pointInConvex(p.screen, inflate(plate, clear)))) continue;
      if (runs.some((run) => polylineHitsConvex(run, plate, WIRE_HALF + 0.2))) continue;
      const x0 = Math.min(...plate.map((p) => p[0]));
      const x1 = Math.max(...plate.map((p) => p[0]));
      const y0 = Math.min(...plate.map((p) => p[1]));
      const y1 = Math.max(...plate.map((p) => p[1]));
      const tip: Pt = [Math.max(x0, Math.min(x1, anchor[0])), Math.max(y0, Math.min(y1, anchor[1]))];
      const label: DrawnLabel = { text: end.pin, quad, kind: "free", part: end.ref, pin: end.pin, target: true };
      rendered.geom.labels.push(label);
      rendered.svg += `<g data-detail-callout="${esc(end.ref)}.${esc(end.pin)}">` +
        `<line x1="${anchor[0]}" y1="${anchor[1]}" x2="${tip[0]}" y2="${tip[1]}" stroke="#fff" stroke-width="0.65"/>` +
        `<line x1="${anchor[0]}" y1="${anchor[1]}" x2="${tip[0]}" y2="${tip[1]}" stroke="#111" stroke-width="0.17"/>` +
        `<polygon points="${plate.map((p) => p.join(",")).join(" ")}" fill="#fff" stroke="#111" stroke-width="0.12"/>` +
        `<text x="${at[0]}" y="${at[1]}" text-anchor="middle" font-size="${size}" ${FREE_FONT} fill="#111">${esc(end.pin)}</text></g>`;
      return { rendered, callout: { label, anchor } };
    }
  }
  return { rendered };
}

/**
 * One wiring step: the bench with the new wire in colour, earlier wires greyed, and a
 * magnified bubble over each end so the exact pad is unmistakable. A bubble whose pad
 * is behind something in the step's view is drawn again with that something as a
 * dashed outline, so the pad a caption names can always be seen in its bubble.
 */
export function wiringStepArt(loaded: Loaded, index: number, frame: BBox, onOwnPage = false): StepArt {
  const view = benchView(loaded);
  const c = view.project.connections[index]!;
  const ends = wireEnds(view, c);
  const scene = benchScene(view, index, index);
  const main = stepRender(view, index);
  const id = `s${index}`;
  const { r, gap } = BUBBLE;
  const label = (e: WireEnd): string => e.part.use.label ?? e.part.def.name;
  const order = [...ends].sort((p, q) => proj(...p.at)[0] - proj(...q.at)[0]);
  const widths = order.map((e) => textWidth(`${label(e)} ${e.pin}`, CAPTION_SIZE));
  // A step is printed in a wide half-page slot, or on a page of its own. The bubbles go
  // either side of the bench or above it, and the step is framed on the whole bench or on
  // the two parts it joins (with a small drawing of the whole bench to say where that is):
  // the arrangement that prints the drawing largest wins. Every page still looks at the
  // bench from the same side.
  const about = stepRegion(view, ends, main);
  const joined = new Set(ends.map((e) => e.ref));
  const neighbours = [...view.byRef.keys()].filter((ref) => !joined.has(ref)).map((ref) => growBox(emptyBox(), partOutline(view, ref)));
  const region = trimSlivers(expandToAspect(about.region, frame, 0.6), about.core, neighbours);
  const sizeOf = (a: BBox, framed: boolean, above: boolean): { w: number; h: number } => {
    const aw = a.maxX - a.minX;
    const ah = a.maxY - a.minY + (framed ? LOCATOR.h + LOCATOR.gap : 0);
    // The drawing's own margin (3 mm a side) and the room the captions take are part of its size.
    const o = above ? { w: Math.max(aw, 4 * r + 4), h: ah + 2 * r + 13 } : { w: aw + 2 * (gap + 2 * r), h: Math.max(ah, 2 * r + 7) };
    return { w: o.w + 6, h: o.h + 10 };
  };
  const options: { area: BBox; framed: boolean; above: boolean; w: number; h: number }[] = [];
  const frameArea = (frame.maxX - frame.minX) * (frame.maxY - frame.minY);
  const canFrame = (region.maxX - region.minX) * (region.maxY - region.minY) < 0.8 * frameArea;
  for (const above of [false, true]) {
    options.push({ area: frame, framed: false, above, ...sizeOf(frame, false, above) });
    if (canFrame) options.push({ area: region, framed: true, above, ...sizeOf(region, true, above) });
  }
  const scoreIn = (o: { w: number; h: number }, slot: { w: number; h: number }): number => Math.min(slot.w / o.w, slot.h / o.h);
  const MIN_W = 0.7 * HALF_PAGE.w;
  // An arrangement that prints at least 70 % of the page wide and 80 mm tall is
  // good enough; among those the one that prints largest wins. When none is, the one that
  // comes closest does. Showing less of the bench has to pay for itself: 15 % larger.
  const quality = (o: { w: number; h: number; framed: boolean }, slot: { w: number; h: number }): number => {
    const s = scoreIn(o, slot);
    const fill = Math.min((o.w * s) / MIN_W, (o.h * s) / STEP_MIN_HEIGHT);
    return fill >= 1 ? 10 + s * (o.framed ? 1 : 1.15) : fill;
  };
  const best = (slot: { w: number; h: number }) => options.reduce((x, y) => (quality(y, slot) > quality(x, slot) ? y : x));
  let chosen = best(HALF_PAGE);
  let fullPage = false;
  // A drawing that would print too small in half a page takes a page to itself, and so does
  // one the booklet has to put on a page alone anyway (its neighbour has a page of its own).
  if (onOwnPage || quality(chosen, HALF_PAGE) < 10) {
    chosen = best(FULL_STEP);
    fullPage = true;
  }
  const cropped = chosen.framed;
  const area = chosen.area;
  const wide = chosen.above;
  const cy = wide ? area.minY - r - 6 : Math.min((area.minY + area.maxY) / 2, area.minY + r + 4);
  let left = wide ? area.minX + r : area.minX - gap - r;
  let right = wide ? area.maxX - r : area.maxX + gap + r;
  // The bubbles must not touch, and the two captions, which grow inward from the
  // bubbles' outer edges, must not meet in the middle. Move the bubbles apart until both hold.
  const apart = Math.max(2 * r + 4, widths[0]! + widths[1]! + 5 - 2 * r);
  if (right - left < apart) {
    const mid = (left + right) / 2;
    left = mid - apart / 2;
    right = mid + apart / 2;
  }
  const centres: Pt[] = [
    [left, cy],
    [right, cy],
  ];
  let defs = "";
  let extra = "";
  const bubbles: BubbleGeom[] = [];
  const captions: DrawnLabel[] = [];
  // Wired pads that are behind something in the main view, and what would show each.
  const hiddenPads: HiddenPad[] = [];
  const base = benchView(loaded);
  const wiredAll = wiredPins(base);
  for (const e of ends) {
    if (!isHidden(e.at, blocksOf(main.geom))) continue;
    const by = hidersOf(view, e.ref, e.pin);
    let turn: HiddenPad["turn"] = null;
    for (const degrees of [90, 270, 180] as const) {
      const turnedBase = turnPart(base, e.ref, degrees);
      if (crowding(turnedBase, e.ref)) continue;
      // A turn that only swaps which of the part's wired pads are hidden (a DIP's two rows) is no fix.
      const wiredNow = [...(wiredAll.get(e.ref) ?? [])].filter((p) => hidersOf(base, e.ref, p).length > 0).length;
      const wiredTurned = [...(wiredAll.get(e.ref) ?? [])].filter((p) => hidersOf(turnedBase, e.ref, p).length > 0).length;
      if (wiredTurned < wiredNow && hidersOf(turnedBase, e.ref, e.pin).length === 0) {
        const q = turnedBase.byRef.get(e.ref)!;
        turn = { degrees, x: round2(q.at.x), y: round2(q.at.y), rot: q.at.rot };
        break;
      }
    }
    hiddenPads.push({ ref: e.ref, pin: e.pin, by, turn });
  }
  order.forEach((e, i) => {
    const ctr = centres[i]!;
    let sceneId = id;
    let inside = main.geom;
    const hidden = isHidden(e.at, blocksOf(main.geom));
    const insetScene = hidden ? { ...scene, seeThrough: [e.at] } : scene;
    let detail = hidden ? renderScene(insetScene) : main;
    const target = proj(...e.at);
    // Pads a couple of millimetres apart (a DIP's neighbouring legs) need a closer look
    // for the wire to one of them to be told from the wire to the next.
    const nearest = Math.min(
      Infinity,
      ...main.geom.pads.filter((p) => !(p.part === e.ref && p.pin === e.pin)).map((p) => Math.hypot(p.screen[0] - target[0], p.screen[1] - target[1])),
    );
    let zoom = BUBBLE.zoom * Math.min(1.9, Math.max(1, DENSE_PAGE_MM / nearest));
    const targetLabel = detail.geom.labels.find((l) => l.part === e.ref && l.pin === e.pin);
    const labelFits = targetLabel && targetLabel.quad.every((p) => Math.hypot(p[0] - target[0], p[1] - target[1]) <= r / zoom - 0.35);
    let detailCallout: BubbleGeom["detailCallout"];
    if (!labelFits) {
      let fallback = targetDetail(insetScene, e, r / zoom, zoom);
      // The name of the wired pad outranks the close look: when the magnified inset has no
      // clear place for it, look less closely (a wider inset) until it has, down to the
      // ordinary magnification.
      while (!fallback.callout && zoom > BUBBLE.zoom + 0.01) {
        zoom = Math.max(BUBBLE.zoom, zoom * 0.85);
        fallback = targetDetail(insetScene, e, r / zoom, zoom);
      }
      detail = fallback.rendered;
      detailCallout = fallback.callout;
    }
    if (hidden || !labelFits) {
      sceneId = `${id}d${i}`;
      defs += `<g id="${sceneId}">${detail.svg}</g>`;
      inside = detail.geom;
    }
    extra += zoomBubble(sceneId, `${id}c${i}`, e.at, ctr, r, zoom);
    bubbles.push({ centre: ctr, radius: r, zoom, target: { ref: e.ref, pin: e.pin, at: e.at, label: label(e) }, geom: inside, seeThrough: hidden, detailCallout });
    // Captions grow inward from each bubble's outer edge, so a long part label can
    // never run off the side of the drawing.
    const tx = i === 0 ? ctr[0] - r : ctr[0] + r;
    const ty = ctr[1] - r - 2.6;
    const anchor = i === 0 ? "start" : "end";
    extra +=
      `<text x="${tx.toFixed(2)}" y="${ty.toFixed(2)}" text-anchor="${anchor}" class="bt-cap">` +
      `<tspan class="bt-cap-part">${esc(label(e))} </tspan><tspan class="bt-cap-pin">${esc(e.pin)}</tspan></text>`;
    const w = widths[i]!;
    const x0 = i === 0 ? tx : tx - w;
    captions.push({
      text: `${label(e)} ${e.pin}`,
      kind: "free",
      part: e.ref,
      pin: e.pin,
      quad: [
        [x0, ty - CAPTION_SIZE * 0.74],
        [x0 + w, ty - CAPTION_SIZE * 0.74],
        [x0 + w, ty + CAPTION_SIZE * 0.08],
        [x0, ty + CAPTION_SIZE * 0.08],
      ],
    });
  });
  const bubbleBox: BBox = { minX: left - r, maxX: right + r, minY: cy - r - 7, maxY: cy + r };
  let bb: BBox = cropped ? union(region, bubbleBox) : union(union(frame, main.bbox), bubbleBox);
  if (cropped) {
    const loc = locator(view, region, [...new Set(ends.map((e) => e.ref))], [bb.minX, bb.maxY + LOCATOR.gap]);
    extra += loc.svg;
    bb = { ...bb, maxY: bb.maxY + LOCATOR.gap + loc.h };
  }
  const style = `<style>.bt-loc *{vector-effect:non-scaling-stroke;stroke-width:1px!important}.bt-cap{font-family:"Noto Sans","Helvetica Neue",Arial,sans-serif;font-size:${CAPTION_SIZE}px}.bt-cap-part{fill:#555}.bt-cap-pin{font-weight:800;fill:#111}</style>`;
  // A cropped step shows only its region of the bench: what lies outside is cut by the frame, so it is not drawn.
  if (cropped) defs += `<clipPath id="${id}clip"><rect x="${region.minX.toFixed(2)}" y="${region.minY.toFixed(2)}" width="${(region.maxX - region.minX).toFixed(2)}" height="${(region.maxY - region.minY).toFixed(2)}"/></clipPath>`;
  const svg = toSvg(`${defs ? `<defs>${defs}</defs>` : ""}<g id="${id}"${cropped ? ` clip-path="url(#${id}clip)"` : ""}>${main.svg}</g>`, bb, 3, style + extra);
  const size = { w: bb.maxX - bb.minX + 6, h: bb.maxY - bb.minY + 6 };
  return { svg, ends, color: wireColor(view, c, index), geom: { main: main.geom, bubbles, captions, hidden: hiddenPads, view: cropped ? region : bb }, size, area, full: fullPage };
}

/** Bounding frame of the bench across every wiring step, so all steps share one framing. */
export function benchFrame(loaded: Loaded): BBox {
  const view = benchView(loaded);
  const n = view.project.connections.length;
  const scene = benchScene(view, n, null);
  for (const w of scene.wires ?? []) w.state = "now";
  let frame = renderScene(scene).bbox;
  // Pin labels move out of the way of the wire being added, so each step is measured too.
  for (let i = 0; i < n; i++) frame = union(frame, stepRender(view, i).bbox);
  return frame;
}

export function benchArt(loaded: Loaded): Art {
  const view = benchView(loaded);
  const scene = benchScene(view, view.project.connections.length, null);
  for (const w of scene.wires ?? []) w.state = "now";
  const r = renderScene(scene);
  return { svg: toSvg(r.svg, r.bbox), geom: r.geom };
}

export const benchSvg = (loaded: Loaded): string => benchArt(loaded).svg;

/** A single part on its own, for the parts inventory. */
export function partSvg(p: PlacedPart): { svg: string; width: number; height: number; geom: SceneGeom } {
  const alone: PlacedPart = { ...p, at: { x: 0, y: 0, z: 0, rot: 0 } };
  const r = renderScene({ solids: partSolids(alone, { leads: true }) });
  return { svg: toSvg(r.svg, r.bbox, 1.5), width: r.bbox.maxX - r.bbox.minX + 3, height: r.bbox.maxY - r.bbox.minY + 3, geom: r.geom };
}

// ---------------------------------------------------------------------------
// Enclosure
// ---------------------------------------------------------------------------

function wallDecal(o: Opening, L: EnclosureLayout): Decal | null {
  if (o.face === "lid") return null;
  const top = L.outer.h;
  const v = top - o.v;
  // Right-face u counts back from the near (+y) edge; left-face u counts along +x.
  const onX = o.face === "x-" || o.face === "x+";
  const u = onX ? L.outer.d - L.wall - o.u : o.u;
  const face = onX ? "right" : "left";
  if (o.shape === "round") return { kind: "circle", face, x: u, y: v, r: o.w / 2 };
  return { kind: "rect", face, x: u - o.w / 2, y: v - o.h / 2, w: o.w, h: o.h };
}

/** Open body: floor, four walls, standoffs. Walls carry their openings as outlines. */
export function bodySolids(L: EnclosureLayout): Solid[] {
  const { w: W, d: D, h: H } = L.outer;
  const t = L.wall;
  const wallH = H - L.floor;
  const decalsFor = (face: Opening["face"]) =>
    L.openings
      .filter((o) => o.face === face)
      .map((o) => wallDecal(o, L))
      .filter((d): d is Decal => d !== null);
  const solids: Solid[] = [
    { kind: "box", x: 0, y: 0, z: 0, w: W, d: D, h: L.floor, tag: "floor" },
    { kind: "box", x: 0, y: 0, z: L.floor, w: W, d: t, h: wallH, decals: decalsFor("y-"), tag: "wall" },
    { kind: "box", x: 0, y: D - t, z: L.floor, w: W, d: t, h: wallH, decals: decalsFor("y+"), tag: "wall" },
    { kind: "box", x: 0, y: t, z: L.floor, w: t, d: D - 2 * t, h: wallH, decals: decalsFor("x-"), tag: "wall" },
    { kind: "box", x: W - t, y: t, z: L.floor, w: t, d: D - 2 * t, h: wallH, decals: decalsFor("x+"), tag: "wall" },
  ];
  for (const s of L.standoffs.filter((q) => q.from === "floor")) {
    solids.push({ kind: "cyl", x: s.x - s.dia / 2, y: s.y - s.dia / 2, z: L.floor, w: s.dia, d: s.dia, h: s.h, r: s.dia / 2, tag: "standoff" });
  }
  // The posts capped buttons stand on, drawn up to the surface the part rests on.
  for (const s of L.seats ?? []) {
    solids.push({ kind: "box", x: s.x0, y: s.y0, z: L.floor, w: s.x1 - s.x0, d: s.y1 - s.y0, h: s.z - L.floor, tag: "standoff" });
  }
  return solids;
}

/** Lid plate at height z with its openings drawn on the top face. */
export function lidSolids(L: EnclosureLayout, z: number): Solid[] {
  const decals: Decal[] = L.openings
    .filter((o) => o.face === "lid")
    .map((o) =>
      o.shape === "round"
        ? { kind: "circle", face: "top", x: o.u, y: o.v, r: o.w / 2 }
        : { kind: "rect", face: "top", x: o.u - o.w / 2, y: o.v - o.h / 2, w: o.w, h: o.h, r: 0 },
    );
  for (const s of L.screws) decals.push({ kind: "circle", face: "top", x: s.x, y: s.y, r: s.dia / 2 + 0.8 });
  return [{ kind: "box", x: 0, y: 0, z, w: L.outer.w, d: L.outer.d, h: L.lidThickness, decals, tag: "lid" }];
}

const lift = (p: PlacedPart, dz: number): PlacedPart => ({ ...p, at: { ...p.at, z: p.at.z + dz } });

function mountOf(loaded: Loaded, ref: string): "floor" | "lid" {
  // A mount can also be "wire" (a part hanging in the wiring): for drawing purposes that is not the lid.
  return loaded.project.enclosure?.mounts.find((m) => m.ref === ref)?.on === "lid" ? "lid" : "floor";
}

type Guide = NonNullable<Scene["guides"]>[number];

/** Guide lines from the four bottom corners of a hovering box straight down to where it lands. */
function boxGuides(landed: Solid, dz: number): Guide[] {
  const corners: [number, number][] = [
    [landed.x, landed.y],
    [landed.x + landed.w, landed.y],
    [landed.x, landed.y + landed.d],
    [landed.x + landed.w, landed.y + landed.d],
  ];
  return corners.map(([x, y]) => ({ a: [x, y, landed.z + dz] as V3, b: [x, y, landed.z] as V3 }));
}

/** Dashed outline of where a hovering box lands, so each part can be matched to its place. */
function landingOutline(landed: Solid): Guide[] {
  const { x, y, z, w, d } = landed;
  const c: V3[] = [
    [x, y, z],
    [x + w, y, z],
    [x + w, y + d, z],
    [x, y + d, z],
  ];
  return c.map((p, i) => ({ a: p, b: c[(i + 1) % 4]!, dash: true }));
}

/** Guide lines from a hovering part straight down to where it lands. */
function dropGuides(p: PlacedPart, dz: number): Guide[] {
  const fp = footprint(p);
  return boxGuides({ kind: "box", x: p.at.x, y: p.at.y, z: p.at.z, w: fp.w, d: fp.d, h: p.def.body.h }, dz);
}

/**
 * An exploded step: `base` is what is already there, `placed` the parts hovering above
 * where they land, each at the height planHover gave it. Every part gets its corner
 * guides and a dashed outline of its landing place. Guides and outlines stop wherever
 * a solid is in front of them, which renderScene sees to.
 */
function explodedScene(base: Solid[], placed: readonly HoverPlaced[], group: string, arrows: boolean): Scene {
  const solids: Solid[] = [...base];
  const guides: Guide[] = [];
  const texts: FreeText[] = [];
  const arrowList: { a: V3; b: V3 }[] = [];
  for (const p of placed) {
    const body = p.item.solids[0]!;
    for (const s of p.item.solids) solids.push({ ...liftSolid(s, p.dz), hover: { group, item: p.item.id } });
    guides.push(...boxGuides(body, p.dz), ...landingOutline(body));
    if (p.text) texts.push(p.text);
    if (arrows) arrowList.push(arrowFor(body, p.dz));
  }
  return { solids, guides, texts, arrows: arrowList };
}

/** The block arrow beside a hovering part, pointing the way it moves. */
function arrowFor(body: Solid, dz: number): { a: V3; b: V3 } {
  const x = body.x + body.w / 2;
  const y = body.y + body.d + 4;
  return { a: [x, y, body.z + dz - 2], b: [x, y, body.z + dz - 12] };
}

const partLabel = (p: PlacedPart): string => p.use.label ?? p.use.ref;

/** The floor parts lowered onto their posts, in as many drawings as it takes to keep them apart on the page. */
export function enclosureFloorArts(loaded: Loaded, L: EnclosureLayout): HoverArt[] {
  const parts = L.parts.filter((p) => mountOf(loaded, p.use.ref) === "floor");
  const items: HoverItem[] = parts.map((p) => {
    const solids = partSolids(p, { labels: false });
    const a = arrowFor(solids[0]!, 0);
    const arrow = arrowPoly(a.a, a.b);
    // A name is only needed when there is more than one part to tell apart.
    return { id: p.use.ref, label: parts.length > 1 ? partLabel(p) : undefined, solids, extras: arrow ? [arrow] : [] };
  });
  // High enough that the lowest part clears the walls.
  const base = L.outer.h + 14;
  const groups = planHover(items, { base, max: base + 40 });
  const seated: Solid[] = [];
  return groups.map((group) => {
    const r = renderScene(explodedScene([...bodySolids(L), ...seated], group, "floor", true));
    for (const p of group) for (const s of p.item.solids) seated[seated.length] = s;
    return { svg: toSvg(r.svg, r.bbox), geom: r.geom, refs: group.map((p) => p.item.id) };
  });
}

export const enclosureFloorStep = (loaded: Loaded, L: EnclosureLayout): string => enclosureFloorArts(loaded, L)[0]?.svg ?? "";

/** The lid parts seated in the turned-over lid, in as many drawings as it takes to keep them apart on the page. */
export function enclosureLidArts(loaded: Loaded, L: EnclosureLayout): HoverArt[] {
  // The lid lies outer face down on the bench; its parts lower onto it face down, so
  // only the plain back of each board shows.
  const parts = L.parts.filter((p) => mountOf(loaded, p.use.ref) === "lid");
  const D = L.outer.d;
  // Turning the lid over mirrors it front to back, so its openings and screw holes
  // mirror with it and line up with the parts drawn above them.
  const turned: EnclosureLayout = {
    ...L,
    openings: L.openings.map((o) => (o.face === "lid" ? { ...o, v: D - o.v } : o)),
    screws: L.screws.map((s) => ({ ...s, y: D - s.y })),
  };
  const items: HoverItem[] = parts.map((p) => {
    const fp = footprint(p);
    const body: Solid = { kind: "box", x: p.at.x, y: D - p.at.y - fp.d, z: L.lidThickness, w: fp.w, d: fp.d, h: p.def.body.h, tag: p.use.ref, part: p.use.ref };
    return { id: p.use.ref, label: partLabel(p), solids: [body] };
  });
  const groups = planHover(items, { base: 22, max: 62 });
  const seated: Solid[] = [];
  return groups.map((group) => {
    const r = renderScene(explodedScene([...lidSolids(turned, 0), ...seated], group, "lid parts", false));
    for (const p of group) for (const s of p.item.solids) seated[seated.length] = s;
    return { svg: toSvg(r.svg, r.bbox), geom: r.geom, refs: group.map((p) => p.item.id) };
  });
}

export const enclosureLidStep = (loaded: Loaded, L: EnclosureLayout): string => enclosureLidArts(loaded, L)[0]?.svg ?? "";

export function enclosureCloseArt(loaded: Loaded, L: EnclosureLayout): Art {
  const hover = 20;
  const lidZ = L.outer.h + hover;
  const floorParts = L.parts.filter((p) => mountOf(loaded, p.use.ref) === "floor");
  const solids: Solid[] = [
    ...bodySolids(L),
    ...floorParts.flatMap((p) => partSolids(p, { labels: false })),
    ...lidSolids(L, lidZ).map((s): Solid => ({ ...s, hover: { group: "lid", item: "lid" } })),
  ];
  const guides: Guide[] = [];
  L.screws.forEach((s, i) => {
    const top = lidZ + L.lidThickness + 12;
    const hoverTag = { group: "screws", item: `screw ${i + 1}` };
    solids.push({ kind: "cyl", x: s.x - 1.6, y: s.y - 1.6, z: top, w: 3.2, d: 3.2, h: 1.6, r: 1.6, tag: "screw-head", hover: hoverTag });
    solids.push({ kind: "cyl", x: s.x - 0.8, y: s.y - 0.8, z: top - 6, w: 1.6, d: 1.6, h: 6, r: 0.8, tag: "screw", hover: hoverTag });
    guides.push({ a: [s.x, s.y, top - 6], b: [s.x, s.y, L.outer.h] });
  });
  const r = renderScene({ solids, guides });
  return { svg: toSvg(r.svg, r.bbox), geom: r.geom };
}

export const enclosureCloseStep = (loaded: Loaded, L: EnclosureLayout): string => enclosureCloseArt(loaded, L).svg;

/** The finished object: closed case, or the wired bench when there is no enclosure. */
export function closedArt(L: EnclosureLayout): Art {
  const r = renderScene({ solids: [...bodySolids(L), ...lidSolids(L, L.outer.h)] });
  return { svg: toSvg(r.svg, r.bbox), geom: r.geom };
}

export const closedSvg = (L: EnclosureLayout): string => closedArt(L).svg;

/**
 * The same enclosure turned half a turn, so the walls that face away in the standard
 * view (where a USB socket usually is) face the viewer.
 */
export function turnedLayout(L: EnclosureLayout): EnclosureLayout {
  const { w: W, d: D } = L.outer;
  const flip: Record<Opening["face"], Opening["face"]> = { "x-": "x+", "x+": "x-", "y-": "y+", "y+": "y-", lid: "lid" };
  return {
    ...L,
    parts: L.parts.map((p) => {
      const fp = footprint(p);
      const rot = ((p.at.rot + 180) % 360) as 0 | 90 | 180 | 270;
      return { ...p, at: { ...p.at, x: W - p.at.x - fp.w, y: D - p.at.y - fp.d, rot } };
    }),
    standoffs: L.standoffs.map((s) => ({ ...s, x: W - s.x, y: D - s.y })),
    seats: (L.seats ?? []).map((s) => ({
      ...s,
      x0: W - s.x1,
      x1: W - s.x0,
      y0: D - s.y1,
      y1: D - s.y0,
      pocket: s.pocket && { x0: W - s.pocket.x1, x1: W - s.pocket.x0, y0: D - s.pocket.y1, y1: D - s.pocket.y0 },
    })),
    caps: (L.caps ?? []).map((c) => ({ ...c, x: W - c.x, y: D - c.y })),
    screws: L.screws.map((s) => ({ ...s, x: W - s.x, y: D - s.y })),
    openings: L.openings.map((o) => {
      if (o.face === "lid") return { ...o, u: W - o.u, v: D - o.v };
      const along = o.face === "x-" || o.face === "x+" ? D : W;
      return { ...o, face: flip[o.face], u: along - o.u };
    }),
  };
}

// ---------------------------------------------------------------------------
// Carrier PCB
// ---------------------------------------------------------------------------

function boardSolid(P: PcbLayout, placedSoFar: PlacedPart[]): Solid {
  const decals: Decal[] = P.holes.map((h) => ({ kind: "circle", face: "top", x: h.x, y: h.y, r: h.dia / 2 }));
  return {
    kind: "box",
    x: 0,
    y: 0,
    z: 0,
    w: P.board.w,
    d: P.board.d,
    h: P.board.t,
    decals,
    tag: "board",
    // Pads for parts not yet fitted, so the empty footprints are visible on the board.
    pads: P.parts
      .filter((p) => !placedSoFar.includes(p))
      .flatMap((p) => p.def.pins.map((pin) => pinWorld(p, pin.name)).map(([x, y]) => ({ x, y }))),
  };
}

/** PCB assembly order: lowest parts first, so the board lies flat while soldering. */
export function pcbOrder(P: PcbLayout): PlacedPart[] {
  return [...P.parts].sort((a, b) => a.def.maxHeight - b.def.maxHeight);
}

export function pcbStepArt(P: PcbLayout, index: number): Art {
  const order = pcbOrder(P);
  const done = order.slice(0, index);
  const now = order[index]!;
  const hover = 20;
  const scene: Scene = {
    solids: [
      boardSolid(P, done),
      ...done.flatMap((p) => partSolids(p, { labels: false })),
      ...partSolids(lift(now, hover), { labels: false }).map((s): Solid => ({ ...s, hover: { group: "pcb part", item: now.use.ref } })),
    ],
    guides: dropGuides(now, hover),
  };
  const r = renderScene(scene);
  return { svg: toSvg(r.svg, r.bbox), geom: r.geom };
}

export const pcbStepSvg = (P: PcbLayout, index: number): string => pcbStepArt(P, index).svg;

export function pcbDoneArt(P: PcbLayout): Art {
  const r = renderScene({ solids: [boardSolid(P, P.parts), ...P.parts.flatMap((p) => partSolids(p, { labels: false }))] });
  return { svg: toSvg(r.svg, r.bbox), geom: r.geom };
}

export const pcbDoneSvg = (P: PcbLayout): string => pcbDoneArt(P).svg;
