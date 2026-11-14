#!/usr/bin/env bun
// Flat, measured drawings generated from project.json and the part files: a top-down
// wiring plan to keep on the bench, a dimensioned three-view drawing of the printed
// case, and a table of the controller pins in use.
//
// Usage: bun drawing.ts <projectDir> [--debug]
// Writes <projectDir>/out/drawings/{wiring.svg, wiring-legend.svg, enclosure.svg, pinmap.svg, fitcheck.svg, index.html}.
// enclosure.svg is written only when the project has an enclosure, wiring-legend.svg only
// when the legend does not fit under the wiring plan without shrinking it.
// --debug prints where each part stands in the wiring plan, in the coordinates `plan` takes.

import { mkdir } from "node:fs/promises";
import { join } from "node:path";
import { unverifiedNotes, warnUnresolvedGeometry } from "./lib/geometry-evidence";
import { type EnclosureLayout, type Opening, closedHeight, layoutEnclosure } from "./lib/enclosure-layout";
import {
  type Box,
  type Dir,
  FLAT,
  FONT,
  fanLayout,
  hopOf,
  scaledPart,
  type FlatPad,
  type FlatPart,
  OPPOSITE,
  type PartLabel,
  type PinLabel,
  type Pt,
  Sheet,
  type SheetItem,
  checkLanes,
  checkSheet,
  overhangingShapes,
  textBox,
  crossingPoints,
  dimHoriz,
  dimVert,
  flatPart,
  fmt,
  grow,
  overlap,
  partBody,
  partLabel,
  partLabelWidth,
  partPads,
  pinLabelMarkup,
  pinLabels,
  rectBox,
  textWidth,
  tidy,
  unionBox,
} from "./lib/flat";
import { HEAVY, THIN, WIRE_HEX, esc, footprint } from "./lib/iso";
import { type Loaded, type Net, type NetPin, findPin, loadProject, main, parseEnd } from "./lib/project";
import { wireColor } from "./lib/scenes";
import type { Connection, PartDef, PartUse, PinRole, PlacedPart } from "./lib/types";

// ---------------------------------------------------------------------------
// Page furniture
// ---------------------------------------------------------------------------

const PAGE = { w: 297, h: 210, margin: 12, top: 31, bottom: 198 } as const;
const f = (n: number): string => (Math.round(n * 100) / 100).toString();

/** Largest of the usual drawing scales that fits, as a number and as the text printed in the title block. */
const SCALES = [5, 4, 3, 2.5, 2, 1.5, 1.25, 1, 0.75, 2 / 3, 0.5, 0.4, 0.33, 0.25, 0.2];
export function scaleText(s: number): string {
  if (s >= 1) return `${fmt(s)} : 1`;
  return `1 : ${fmt(1 / s)}`;
}
function pickScale(fits: (s: number) => boolean): number {
  for (const s of SCALES) if (fits(s)) return s;
  return SCALES[SCALES.length - 1]!;
}

const STYLE =
  `<style>` +
  `text{font-family:${FONT};fill:#111}` +
  `.pin{font-weight:600}.part{font-weight:800}.ref{font-weight:400;fill:#666}` +
  `.dim-text{font-weight:400}.t-name{font-weight:800}.t-sub{font-weight:400}.small{font-weight:400;fill:#444}` +
  `.th{font-weight:800}.mono{font-weight:600}` +
  `.lane-name{font-weight:700;letter-spacing:.04em}.tag-text{font-weight:700}` +
  `</style>`;

function svgOpen(): string {
  return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${PAGE.w} ${PAGE.h}" width="${PAGE.w}mm" height="${PAGE.h}mm" role="img">${STYLE}<rect width="${PAGE.w}" height="${PAGE.h}" fill="#fff"/>`;
}

const NOT_TO_SCALE = "none: shrunk to fit";

function titleBlock(project: Loaded["project"], title: string, scale?: string, notes: string[] = []): string {
  const right = PAGE.w - PAGE.margin;
  let out =
    `<text x="${PAGE.margin}" y="20.5" font-size="9" class="t-name">${esc(project.name.toUpperCase())}</text>` +
    `<text x="${PAGE.margin}" y="27" font-size="4" class="t-sub">${esc(title)}</text>`;
  const lines = [...(scale ? [`Scale ${scale}   (A4, print at 100 %, dimensions in mm)`] : ["Dimensions in mm"]), "Generated from project.json", ...notes];
  // The strip above the rule holds three lines at the normal spacing. A fourth (the
  // unverified-geometry note) closes the spacing up rather than crossing the rule.
  const step = lines.length > 3 ? (26.2 - 17) / (lines.length - 1) : 4.6;
  lines.forEach((l, i) => {
    // The one line that must not be skimmed past is set in the sheet's bold weight.
    const cls = l.startsWith("LAYOUT NOT VERIFIED") ? "th" : "small";
    out += `<text x="${right}" y="${f(17 + i * step)}" font-size="3" text-anchor="end" class="${cls}">${esc(l)}</text>`;
  });
  out += `<line x1="${PAGE.margin}" y1="29.5" x2="${right}" y2="29.5" stroke="#111" stroke-width="0.5"/>`;
  return out;
}

// ---------------------------------------------------------------------------
// Connections
// ---------------------------------------------------------------------------

interface End {
  ref: string;
  pin: string;
}

function ends(loaded: Loaded, c: Connection): [End, End] {
  const one = (s: string): End => {
    const { ref, pin } = parseEnd(s);
    return { ref, pin: findPin(loaded.byRef.get(ref)!.def, pin)!.name };
  };
  return [one(c.from), one(c.to)];
}

const isPassive = (p: PlacedPart): boolean => p.def.kind === "passive" && p.def.pins.length === 2;
const labelOf = (p: PlacedPart): string => p.use.label ?? p.def.name;

export interface Row {
  step: number;
  hex: string;
  from: string;
  to: string;
  why: string;
}

const LEGEND_FONT_BASE = 2.8;
const WHY_FONT_BASE = 2.6;
const wrap = (text: string, width: number, fs: number): string[] => {
  const lines: string[] = [];
  let cur = "";
  for (const word of text.split(/\s+/).filter(Boolean)) {
    const next = cur ? `${cur} ${word}` : word;
    if (cur && textWidth(next, fs, false) > width) {
      lines.push(cur);
      cur = word;
    } else cur = next;
  }
  if (cur) lines.push(cur);
  return lines;
};

interface LegendLayout {
  height: number;
  markup: string;
}

/** `k` enlarges the table (and drops the rule above it) when it has a sheet to itself. */
function legend(rows: Row[], top: number, k = 1): LegendLayout {
  const LEGEND_FONT = LEGEND_FONT_BASE * k;
  const WHY_FONT = WHY_FONT_BASE * k;
  const width = PAGE.w - 2 * PAGE.margin;
  const cols = k > 1 ? (rows.length > 20 ? 2 : 1) : rows.length > 16 ? 3 : rows.length > 6 ? 2 : 1;
  const gutter = 8;
  const cw = (width - gutter * (cols - 1)) / cols;
  const numW = 7 * k;
  const swW = 9 * k;
  const fromW = Math.max(...rows.map((r) => textWidth(r.from, LEGEND_FONT)), 8);
  const toW = Math.max(...rows.map((r) => textWidth(r.to, LEGEND_FONT)), 8);
  const whyX = numW + swW + 2 + fromW + 7 + toW + 4;
  const whyW = Math.max(20, cw - whyX);
  const laid = rows.map((r) => {
    const lines = wrap(r.why, whyW, WHY_FONT);
    return { r, lines, h: Math.max(5.2 * k, lines.length * 3.5 * k + 1.7) };
  });
  const sum = laid.reduce((t, l) => t + l.h, 0);
  // Fill columns top to bottom, each up to an even share of the height.
  const share = sum / cols;
  const colsOf: (typeof laid)[] = Array.from({ length: cols }, () => []);
  let c = 0;
  let acc = 0;
  for (const l of laid) {
    if (acc + l.h / 2 > share * (c + 1) && c < cols - 1) c++;
    colsOf[c]!.push(l);
    acc += l.h;
  }
  let markup = k > 1 ? "" : `<line x1="${PAGE.margin}" y1="${f(top)}" x2="${PAGE.w - PAGE.margin}" y2="${f(top)}" stroke="#111" stroke-width="0.3"/>`;
  let height = 0;
  colsOf.forEach((list, ci) => {
    const x0 = PAGE.margin + ci * (cw + gutter);
    let y = top + 2;
    for (const l of list) {
      const mid = y + 2.6 * k;
      markup +=
        `<g class="row" data-step="${l.r.step}">` +
        `<text x="${f(x0)}" y="${f(mid + 1 * k)}" font-size="${f(LEGEND_FONT)}" class="th">${l.r.step}</text>` +
        `<rect x="${f(x0 + numW)}" y="${f(mid - 1 * k)}" width="${f(swW)}" height="${f(2 * k)}" rx="${f(k)}" fill="${l.r.hex}" stroke="#111" stroke-width="0.3"/>` +
        `<text x="${f(x0 + numW + swW + 2)}" y="${f(mid + 1 * k)}" font-size="${f(LEGEND_FONT)}" class="mono">${esc(l.r.from)}</text>` +
        `<text x="${f(x0 + numW + swW + 2 + fromW + 1.5)}" y="${f(mid + 1 * k)}" font-size="${f(LEGEND_FONT)}">→</text>` +
        `<text x="${f(x0 + numW + swW + 2 + fromW + 7)}" y="${f(mid + 1 * k)}" font-size="${f(LEGEND_FONT)}" class="mono">${esc(l.r.to)}</text>` +
        l.lines.map((t, n) => `<text x="${f(x0 + whyX)}" y="${f(mid + 1 * k + n * 3.5 * k)}" font-size="${f(WHY_FONT)}" class="small">${esc(t)}</text>`).join("") +
        `</g>`;
      y += l.h;
    }
    height = Math.max(height, y - top);
  });
  return { height: height + 2, markup };
}

export function legendRows(loaded: Loaded): Row[] {
  return loaded.project.connections.map((c, i) => {
    const [a, b] = ends(loaded, c);
    const col = wireColor(loaded, c, i);
    return { step: i + 1, hex: WIRE_HEX[col] ?? col, from: `${a.ref}.${a.pin}`, to: `${b.ref}.${b.pin}`, why: c.why ?? "" };
  });
}

// ---------------------------------------------------------------------------
// Wiring plan: a row of parts, a band of lanes, the controller below
// ---------------------------------------------------------------------------
//
// Every net is one straight horizontal lane. A wire is a stub from its pad to the lane, a
// run along the lane, and a stub from the lane to its other pad. Crossings can only be a
// vertical stub over a lane of another net, and the lane is broken there.

type Rot = 0 | 90 | 180 | 270;
const ROTS: Rot[] = [0, 90, 180, 270];

const at0 = (p: PlacedPart, rot: Rot): PlacedPart => ({ ...p, at: { x: 0, y: 0, z: 0, rot } });
const key = (e: End): string => `${e.ref}.${e.pin}`;
const near = (a: number, b: number): boolean => Math.abs(a - b) < 1e-6;

/** Sizes that follow the sheet scale: print millimetres divided by the scale give model millimetres. */
interface Dims {
  S: number;
  px: (printMm: number) => number;
  /** Pin-name cap height. */
  cap: number;
  /** Distance between lanes. */
  pitch: number;
  /** Distance between the channels of wires that wrap round a part. */
  chan: number;
  /** First channel's distance from a part edge. */
  edge: number;
  wo: number;
  wc: number;
  dotR: number;
  /** Half-width of the gap cut in a lane where another net's stub crosses it. */
  gap: number;
  /** Space between neighbouring parts beyond their channels. */
  gapMin: number;
}

/**
 * Cap height of a pin name on the printed sheet, mm. A property of the sheet, not of the scale:
 * 1.6 mm is the smallest a soldering eye reads, 1.7 keeps a margin for rounding.
 */
export const PIN_CAP_PRINT = 1.7;
/** Cap height of a Noto Sans capital, in em. */
const CAP_EM = 0.714;

function dimsAt(S: number): Dims {
  const px = (mm: number): number => mm / S;
  const wo = Math.min(FLAT.wireOutline, px(0.8));
  return {
    S,
    px,
    cap: px(PIN_CAP_PRINT),
    pitch: px(4),
    chan: Math.max(0.9, px(1.7)),
    edge: Math.max(1, px(1.6)),
    wo,
    wc: wo * 0.64,
    dotR: Math.min(FLAT.dot, px(0.8)),
    gap: wo / 2 + px(0.5),
    gapMin: Math.max(2, px(3)),
  };
}

interface Conn {
  i: number;
  a: End;
  b: End;
  net: number;
}

interface RowSpec {
  part: PlacedPart;
  used: Set<string>;
  /** Rotations worth trying: those that turn the most used pads toward the lanes, narrowest first. */
  rots: Rot[];
  /** `plan.x` of the part, when the project pins it. */
  pinX: number | undefined;
}

interface Prep {
  conns: Conn[];
  /** The step number of each connection: its place in the whole project, which a sheet showing only some of them keeps. */
  steps: number[];
  netNames: string[];
  netOf: (ref: string, pin: string) => number;
  /** Pads with a wire, by part ref. */
  usedByRef: Map<string, Set<string>>;
  ctrl: PlacedPart;
  ctrlRot: Rot;
  ctrlUsed: Set<string>;
  ctrlPinX: number | undefined;
  row: RowSpec[];
}

/** The part every other part is wired to: the board with most connections, else the busiest non-passive part. */
export function pickController(loaded: Loaded): PlacedPart {
  const ordered = loaded.project.parts.map((u) => loaded.byRef.get(u.ref)!);
  const conns = loaded.project.connections.map((c) => ends(loaded, c));
  const degree = (p: PlacedPart): number => conns.filter(([a, b]) => a.ref === p.use.ref || b.ref === p.use.ref).length;
  const boards = ordered.filter((p) => p.def.kind === "board");
  const pool = boards.length ? boards : ordered.filter((p) => !isPassive(p));
  return [...(pool.length ? pool : ordered)].sort((a, b) => degree(b) - degree(a))[0]!;
}

function prepare(loaded: Loaded, ctrlRef?: string, steps?: number[], flat = false): Prep {
  const raw = loaded.project.connections.map((c) => ends(loaded, c));
  const idx = new Map<string, number>();
  loaded.nets.forEach((n, i) => n.pins.forEach((p) => idx.set(`${p.ref}.${p.pin.name}`, i)));
  const netOf = (ref: string, pin: string): number => idx.get(`${ref}.${pin}`)!;
  const conns = raw.map(([a, b], i): Conn => ({ i, a, b, net: netOf(a.ref, a.pin) }));
  const usedOf = (ref: string): Set<string> => {
    const s = new Set<string>();
    for (const [a, b] of raw) for (const e of [a, b]) if (e.ref === ref) s.add(e.pin);
    return s;
  };
  const ctrl = ctrlRef ? loaded.byRef.get(ctrlRef)! : pickController(loaded);
  const ctrlUsed = usedOf(ctrl.use.ref);

  // The controller is turned so its two long pad rows are its top and bottom edges, the row
  // with more used pads on top, where a wire drops straight to its lane.
  const shape = (rot: Rot): { rows: number; top: number } => {
    const fp = flatPart(at0(ctrl, rot));
    return { rows: fp.pads.filter((q) => q.dir === "N" || q.dir === "S").length, top: fp.pads.filter((q) => q.dir === "N" && ctrlUsed.has(q.name)).length };
  };
  let ctrlRot: Rot = ctrl.use.plan ? (ctrl.use.plan.rot ?? 0) : 0;
  if (!ctrl.use.plan) {
    let best = -1;
    for (const rot of ROTS) {
      const s = shape(rot);
      const score = s.rows * 1000 + s.top;
      if (score > best) {
        best = score;
        ctrlRot = rot;
      }
    }
  }

  const row = loaded.project.parts
    .map((u) => loaded.byRef.get(u.ref)!)
    .filter((p) => p.use.ref !== ctrl.use.ref)
    .map((part): RowSpec => {
      const used = usedOf(part.use.ref);
      const plan = part.use.plan;
      if (plan) return { part, used, rots: [plan.rot ?? 0], pinX: plan.x };
      const cand = ROTS.map((rot) => {
        const fp = flatPart(at0(part, rot));
        return { rot, down: fp.pads.filter((q) => used.has(q.name) && q.dir === "S").length, w: fp.rect.w, d: fp.rect.d };
      });
      // Lying flat: the turns that make the part shortest, whichever way its pads then face. A tall part (a 3.5 inch
      // screen standing in the row) otherwise sets the height of the whole plan; its wires then wrap round its side.
      const pool = flat ? cand.filter((c) => near(c.d, Math.min(...cand.map((x) => x.d)))) : cand;
      const most = Math.max(...pool.map((c) => c.down));
      const top = pool.filter((c) => c.down === most);
      const narrow = Math.min(...top.map((c) => c.w));
      return { part, used, rots: top.filter((c) => near(c.w, narrow)).map((c) => c.rot), pinX: undefined };

    });
  const usedByRef = new Map(loaded.project.parts.map((u) => [u.ref, usedOf(u.ref)]));
  return { conns, steps: steps ?? loaded.project.connections.map((_, i) => i + 1), netNames: loaded.nets.map((n) => n.name), netOf, usedByRef, ctrl, ctrlRot, ctrlUsed, ctrlPinX: ctrl.use.plan?.x, row };
}

/** The pin names of one part as the plan prints them: the wired pads always, the others when they all fit. */
function pinLabelsOf(fp: FlatPart, wired: Set<string>, d: Dims, keys?: Map<string, string> | null): PinLabel[] {
  return pinLayoutOf(fp, wired, d, keys).labels;
}
function pinLayoutOf(fp: FlatPart, wired: Set<string>, d: Dims, keys?: Map<string, string> | null): { labels: PinLabel[]; clean: boolean } {
  return fanLayout(fp, { cap: d.cap, wired, lead: d.px(0.9), overhang: d.edge * 0.5, leaderWidth: d.px(0.15), names: keys ?? undefined });
}

/**
 * The pin key of a part whose names cannot stand at its pads: its wired pads are numbered in the part file's order,
 * the numbers are printed at the pads, and this block, set in free space beside the part, says which name each
 * number is. Text is the sheet's size (2.4 mm of font, 1.7 mm of capital), so the block costs the same room at any scale.
 */
export interface PinKey {
  /** Box and entries in the part's own frame, mm of the object: top-left at (x, y). */
  x: number;
  y: number;
  w: number;
  h: number;
  font: number;
  entries: { x: number; y: number; n: string; name: string }[];
}

function buildKey(names: { n: string; name: string }[], d: Dims, maxW: number): PinKey {
  const font = d.px(2.4);
  const pitch = d.px(3.6);
  const gap = d.px(4);
  const pad = d.px(1);
  const entries: PinKey["entries"] = [];
  let x = pad;
  let line = 0;
  let w = 0;
  for (const e of names) {
    const ew = textWidth(`${e.n} ${e.name}`, font) + font * 0.4;
    if (x > pad && x + ew > maxW) {
      x = pad;
      line++;
    }
    entries.push({ x, y: pad + (line + 1) * pitch - pitch * 0.25, n: e.n, name: e.name });
    x += ew + gap;
    w = Math.max(w, x - gap + pad);
  }
  return { x: 0, y: 0, w, h: pad * 2 + (line + 1) * pitch, font, entries };
}

/** Drawing scales a part may be drawn at when the sheet's own is too small for its pads, smallest first. */
const PART_SCALES = [0.5, 2 / 3, 0.75, 1, 1.25, 1.5, 2, 2.5, 3, 4, 5];
/** Nearest two wired pads of a part, on paper, never closer than this: two wires side by side need that much. */
const WIRED_APART = 1.6;
/** Names larger than this make a part bigger than the picture can hold: numbers and a pin key are used instead when they need less. */
const NAME_ZOOM_MAX = 2.5;

/**
 * A part at the sheet's scale if its wired pads can be named inside its body and its wires leave
 * apart; otherwise at the nearest larger drawing scale where they can. It is drawn larger than
 * the rest, the sheet says so beside its name, and every length of it, pads included, grows alike.
 *
 * A part whose names would have to be drawn very large (a 2 x N header with four-letter names needs 4 : 1)
 * is drawn with numbers at its pads instead and a pin key beside it: the numbers are short enough
 * for a modest size, the key carries the names at the sheet's text size.
 */
function zoomTemplate(p: PlacedPart, role: "row" | "ctrl", used: Set<string>, d: Dims, netOf: (ref: string, pin: string) => number): Tpl {
  // A controller is the biggest part on the sheet: it is enlarged only a little, or the sheet outgrows the paper.
  const topNames = role === "ctrl" ? 1.5 : 5;
  const topNumbers = role === "ctrl" ? 3 : 5;
  const ladderTo = (top: number): number[] => [1, ...PART_SCALES.filter((z) => z > d.S * 1.001 && z <= top).map((z) => z / d.S)];
  const wiredPads = p.def.pins.filter((q) => used.has(q.name));
  const keys = new Map(wiredPads.map((q, i) => [q.name, String(i + 1)]));
  const climb = (ladder: number[], numbered: boolean): { clean: Tpl | null; routable: Tpl | null; first: Tpl } => {
    let first: Tpl | null = null;
    let routable: Tpl | null = null;
    for (const k of ladder) {
      const tpl = template(scaledPart(p, k), role, used, d, netOf, numbered ? keys : null);
      tpl.k = k;
      first ??= tpl;
      const wired = tpl.fp.pads.filter((q) => used.has(q.name));
      let apart = Infinity;
      for (let i = 0; i < wired.length; i++) for (let j = i + 1; j < wired.length; j++) apart = Math.min(apart, Math.hypot(wired[i]!.x - wired[j]!.x, wired[i]!.y - wired[j]!.y) * d.S);
      const spaced = tpl.routable && apart >= WIRED_APART;
      if (spaced) routable ??= tpl;
      if (tpl.clean && spaced) return { clean: tpl, routable, first };
    }
    return { clean: null, routable, first: first! };
  };
  // Names, up to a size where a part is still a part of the picture.
  const small = climb(ladderTo(Math.min(topNames, role === "ctrl" ? 1.5 : NAME_ZOOM_MAX)), false);
  if (small.clean) return small.clean;
  const numbered = wiredPads.length >= 2 ? climb(ladderTo(topNumbers), true) : null;
  const big = topNames > NAME_ZOOM_MAX ? climb(ladderTo(topNames), false) : null;
  const cleans = [numbered?.clean, big?.clean].filter((t): t is Tpl => !!t);
  // The smaller of the two; the names win a tie.
  if (cleans.length) return cleans.reduce((a, b) => (b.k < a.k ? b : a));
  // Nothing is clean: the smallest size where the wires at least leave apart, with numbers when they are what comes closest.
  const chosen = numbered?.routable ?? big?.routable ?? small.routable ?? small.first;
  return chosen;
}


/** How one used pad leaves its part, in the part's own frame (origin at its top-left corner). */
interface Escape {
  ref: string;
  pin: string;
  net: number;
  /** From the pad to the foot of the vertical run that ends on the lane. */
  pre: Pt[];
  /** x of that vertical run. */
  xv: number;
  /** The run comes down from above (a row part) or rises from below (the controller). */
  above: boolean;
  /** The pad first hops sideways between two pads of its part (see `hopOf`). */
  hopped: boolean;
}

interface Tpl {
  rot: Rot;
  fp: FlatPart;
  w: number;
  d: number;
  esc: Escape[];
  /** Distance of the outermost channel beyond the left and right edge; 0 when none. */
  left: number;
  right: number;
  /** Room the part needs between its lane-facing edge and the lanes. */
  nearGap: number;
  /** How far pin names stand out past the left and right edge; 0 when none does. */
  reachL: number;
  reachR: number;
  /** Every wired pad can leave its part without crossing another pad or wire of the same part. */
  routable: boolean;
  /** Every wired name found its place inside the body at this size. */
  clean: boolean;
  /** Wired pads carry numbers and the names are in `key`; null when the names stand at the pads. */
  keys: Map<string, string> | null;
  key: PinKey | null;
  /** How much larger than the sheet's scale the part is drawn; 1 when it is not. */
  k: number;
}

/**
 * Where each used pad of a part goes. A pad on the edge that faces the lane band drops
 * straight. Any other leaves perpendicular to its edge, runs round the nearest side of the
 * part in a channel of its own, and joins the band from the side. Channels are nested so
 * that two wrapping wires of one part never cross: the wire nearest the band is innermost.
 */
function template(p: PlacedPart, role: "row" | "ctrl", used: Set<string>, d: Dims, netOf: (ref: string, pin: string) => number, keys: Map<string, string> | null = null): Tpl {
  const fp = flatPart(p);
  const W = fp.rect.w;
  const D = fp.rect.d;
  // A name stands on the inward side of its pad, so it only reaches past the outline on a part too small to hold it:
  // the channels start beyond whatever sticks out.
  const outLen: Record<Dir, number> = { E: 0, W: 0, N: 0, S: 0 };
  const layout = pinLayoutOf(fp, used, d, keys);
  for (const l of layout.labels) {
    outLen.W = Math.max(outLen.W, fp.rect.x - l.box.x0);
    outLen.E = Math.max(outLen.E, l.box.x1 - (fp.rect.x + fp.rect.w));
    outLen.N = Math.max(outLen.N, fp.rect.y - l.box.y0);
    outLen.S = Math.max(outLen.S, l.box.y1 - (fp.rect.y + fp.rect.d));
  }
  const edgeOf = (dir: Dir): number => Math.max(d.edge, outLen[dir] > 0 ? outLen[dir] + d.px(0.9) : 0);
  const facing: Dir = role === "row" ? "S" : "N";
  const away: Dir = OPPOSITE[facing];
  const esc: Escape[] = [];
  const push = (q: FlatPad, pre: Pt[], xv: number, hopped = false): void => {
    esc.push({ ref: p.use.ref, pin: q.name, net: netOf(p.use.ref, q.name), pre, xv, above: role === "row", hopped });
  };
  const pads = fp.pads.filter((q) => used.has(q.name));
  // A pad with another pad straight out from it (the inner row of a 2 x N header) hops half a column sideways first,
  // between two pads of the outer row (`hopOf`), then leaves from there.
  let routable = true;
  const hop = (q: FlatPad): { ax: number; ay: number; via: Pt[] } => {
    const { hop: [hx, hy], spacing } = hopOf(fp, q);
    if (!hx && !hy) return { ax: q.x, ay: q.y, via: [] };
    // Room for the hops: each clear of the rings of the pads it passes, and the corridors apart on paper.
    if (spacing < FLAT.padRing + d.wo / 2 + 0.15 || spacing * d.S < 0.9) routable = false;
    return { ax: q.x + hx, ay: q.y + hy, via: [[q.x + hx, q.y + hy]] };
  };
  for (const q of pads.filter((q) => q.dir === facing)) {
    const h = hop(q);
    push(q, [[q.x, q.y], ...h.via], h.ax, h.via.length > 0);
  }

  const wrapped = pads.filter((q) => q.dir !== facing);
  let left = 0;
  let awayReach = edgeOf(away);
  let right = 0;
  for (const side of ["L", "R"] as const) {
    const mine = wrapped.filter((q) => (q.dir === "W" ? "L" : q.dir === "E" ? "R" : q.x <= W / 2 ? "L" : "R") === side);
    // Side pads first, the one nearest the band innermost; then the pads that wrap over the far edge, nearest corner first.
    const sidePads = mine.filter((q) => q.dir !== away).sort((a, b) => (role === "row" ? b.y - a.y : a.y - b.y));
    const awayPads = mine.filter((q) => q.dir === away).sort((a, b) => (side === "L" ? a.x - b.x : b.x - a.x));
    const first = edgeOf(side === "L" ? "W" : "E");
    [...sidePads, ...awayPads].forEach((q, k) => {
      const c = first + k * d.chan;
      const x = side === "L" ? -c : W + c;
      const h = hop(q);
      if (q.dir !== away) push(q, [[q.x, q.y], ...h.via, [x, h.ay]], x, h.via.length > 0);
      else {
        const o = edgeOf(away) + awayPads.indexOf(q) * d.chan;
        awayReach = Math.max(awayReach, o);
        const y = role === "row" ? -o : D + o;
        push(q, [[q.x, q.y], ...h.via, [h.ax, y], [x, y]], x, h.via.length > 0);
      }
      if (side === "L") left = Math.max(left, c);
      else right = Math.max(right, c);
    });
  }
  // The pin key, in free space on the side of the part away from the lanes, clear of the channels that wrap over it.
  let key: PinKey | null = null;
  if (keys) {
    const entries = [...keys].map(([name, n]) => ({ n, name })).sort((a, b) => Number(a.n) - Number(b.n));
    const k = buildKey(entries, d, Math.max(d.px(60), W));
    const gap = d.px(2);
    key = { ...k, x: (W - k.w) / 2, y: role === "row" ? -(awayReach + gap) - k.h : D + awayReach + gap };
  }
  return { rot: p.at.rot, fp, w: W, d: D, esc, left, right, reachL: outLen.W, reachR: outLen.E, nearGap: edgeOf(facing), clean: layout.clean, routable, keys, key, k: 1 };

}

interface Stub {
  ref: string;
  pin: string;
  net: number;
  above: boolean;
  hopped: boolean;
  /** World coordinates, pad to the foot of the vertical run. */
  pre: Pt[];
  x: number;
  /** Pad to lane, once the lane is known. */
  path: Pt[];
  y: number;
}

export interface WireModel {
  /** The connection's index plus one, the number the booklet's step carries. */
  step: number;
  color: string;
  from: End;
  to: End;
  why: string | undefined;
  net: number;
  /** Pad to pad, corner points only. */
  path: Pt[];
  /** The lane run as drawn: pieces broken where another net's stub crosses. */
  pieces: [number, number][];
  /** y of the lane. */
  laneY: number;
}

export interface LaneModel {
  net: number;
  name: string;
  y: number;
  x0: number;
  x1: number;
}

interface TextBox {
  box: Box;
  text: string;
}

export interface LaneLabelModel extends TextBox {
  net: number;
  /** Anchor of the text on its baseline: its right end when `anchor` is "end". */
  x: number;
  y: number;
  fontSize: number;
  /** "end": the name sits left of its lane. "start": right of it. */
  anchor: "end" | "start";
  /** Set when the name had to move away from the lane's end: a thin line joins them. */
  leader?: { x0: number; x1: number };
}

export interface TagModel extends TextBox {
  step: number;
  net: number;
  x: number;
  y: number;
  fontSize: number;
}

/** One sheet of the wiring plan. */
export interface PlanSheet {
  parts: FlatPart[];
  wires: WireModel[];
  lanes: LaneModel[];
  pinLabels: PinLabel[];
  partLabels: PartLabel[];
  laneLabels: LaneLabelModel[];
  tags: TagModel[];
  /** Pin keys of parts whose pads carry numbers instead of names. */
  keys: PlacedKey[];
  scale: number;
  /** One line per problem the geometry check found; empty when the plan is clean. */
  checks: string[];
  /** Places where a stub crosses the lane of another net. */
  crossings: number;
  svg: string;
}

/** The wiring plan: its first sheet's fields at the top, every sheet in `sheets`, `checks` of all of them. */
export interface WiringModel extends PlanSheet {
  /** One sheet when the plan reads at 1 : 1.5 or larger as it is; else the plan split by subsystem (wiring.svg, wiring-2.svg, ...). */
  sheets: PlanSheet[];
  /** The connections list as a sheet of its own (wiring-legend.svg), when the plan is drawn larger without it or split; null when it stays under the plan. */
  legendSheet: string | null;
  /** Every page of that list; more than one past about 40 rows. */
  legendPages: string[];
}

/** A part's pin key as placed on the plan: top-left corner in plan coordinates. */
export interface PlacedKey {
  ref: string;
  x: number;
  y: number;
  key: PinKey;
}

interface Plan {
  d: Dims;
  parts: FlatPart[];
  stubs: Stub[];
  wires: WireModel[];
  lanes: LaneModel[];
  pinLabels: PinLabel[];
  partLabels: PartLabel[];
  laneLabels: LaneLabelModel[];
  tags: TagModel[];
  keys: PlacedKey[];
  box: Box;
  checks: string[];
  crossings: number;
}

type Span = [number, number];

function unionOf(spans: Span[]): Span[] {
  const sorted = [...spans].sort((a, b) => a[0] - b[0]);
  const out: Span[] = [];
  for (const s of sorted) {
    const last = out[out.length - 1];
    if (last && s[0] <= last[1] + 1e-9) last[1] = Math.max(last[1], s[1]);
    else out.push([s[0], s[1]]);
  }
  return out;
}
const lengthOf = (spans: Span[]): number => unionOf(spans).reduce((t, s) => t + (s[1] - s[0]), 0);

/** Permutations of `items` in lexicographic order of position, so a tie keeps the project's order. */
function eachOrder(items: number[], visit: (order: number[]) => void): void {
  const rec = (cur: number[], rest: number[]): void => {
    if (!rest.length) visit(cur);
    else for (let k = 0; k < rest.length; k++) rec([...cur, rest[k]!], rest.filter((_, j) => j !== k));
  };
  rec([], items);
}

/**
 * Lane order, top (nearest the row of parts) to bottom (nearest the controller): the order
 * with the fewest stub-over-lane crossings, then the shortest stubs. Every order up to eight
 * nets; above that, a barycentre order improved by swapping neighbours.
 */
export function orderLanes(n: number, cross: number[][], above: number[], below: number[]): number[] {
  // cross[i][j]: crossings when lane i lies above lane j.
  const stubCost = (net: number, rank: number): number => above[net]! * rank + below[net]! * (n - 1 - rank);
  const total = (order: number[]): [number, number] => {
    let c = 0;
    let s = 0;
    order.forEach((j, rank) => {
      s += stubCost(j, rank);
      for (let r = 0; r < rank; r++) c += cross[order[r]!]![j]!;
    });
    return [c, s];
  };
  const less = (a: [number, number], b: [number, number]): boolean => a[0] < b[0] || (a[0] === b[0] && a[1] < b[1]);
  const all = Array.from({ length: n }, (_, i) => i);
  if (n <= 8) {
    let best = all;
    let bestCost: [number, number] = [Infinity, Infinity];
    const rec = (cur: number[], rest: number[], c: number, s: number): void => {
      if (c > bestCost[0]) return;
      if (!rest.length) {
        if (less([c, s], bestCost)) {
          bestCost = [c, s];
          best = cur;
        }
        return;
      }
      for (let k = 0; k < rest.length; k++) {
        const j = rest[k]!;
        let add = 0;
        for (const i of cur) add += cross[i]![j]!;
        rec([...cur, j], rest.filter((_, m) => m !== k), c + add, s + stubCost(j, cur.length));
      }
    };
    rec([], all, 0, 0);
    return best;
  }
  const bary = (j: number): number => below[j]! / Math.max(1, above[j]! + below[j]!);
  let order = [...all].sort((a, b) => bary(a) - bary(b) || a - b);
  for (let pass = 0; pass < 50; pass++) {
    let changed = false;
    for (let k = 0; k + 1 < n; k++) {
      const swapped = [...order];
      [swapped[k], swapped[k + 1]] = [swapped[k + 1]!, swapped[k]!];
      if (less(total(swapped), total(order))) {
        order = swapped;
        changed = true;
      }
    }
    if (!changed) break;
  }
  return order;
}

const isNaNx = (n: number): boolean => Number.isNaN(n);

function planAt(prep: Prep, loaded: Loaded, S: number): Plan {
  const d = dimsAt(S);
  const { conns, netOf } = prep;
  const nNets = prep.netNames.length;
  const fs = d.px(3.4);

  // ---- 1. templates for every part and every rotation worth trying
  const rowT: Tpl[][] = prep.row.map((r) => r.rots.map((rot) => zoomTemplate(at0(r.part, rot), "row", r.used, d, netOf)));
  const ctrlT = zoomTemplate(at0(prep.ctrl, prep.ctrlRot), "ctrl", prep.ctrlUsed, d, netOf);
  /** What the sheet says beside a part drawn larger than the rest. */
  const noteOf = (t: Tpl): string | undefined => (t.k > 1.001 ? `drawn ${scaleText(S * t.k)}` : undefined);
  const cellOf = (t: Tpl): { L: number; R: number } => {
    const over = Math.max(0, (partLabelWidth(t.fp, fs, noteOf(t)) - t.w) / 2 + d.px(1), t.key ? (t.key.w - t.w) / 2 + d.px(1) : 0);
    return {
      L: Math.max(t.left ? t.left + 0.6 * d.chan : 0, t.reachL ? t.reachL + d.px(1) : 0, over),
      R: Math.max(t.right ? t.right + 0.6 * d.chan : 0, t.reachR ? t.reachR + d.px(1) : 0, over),
    };
  };
  const pinned = prep.row.map((r, i) => (r.pinX !== undefined ? i : -1)).filter((i) => i >= 0);
  const free = prep.row.map((_, i) => i).filter((i) => !pinned.includes(i));
  const degree = (i: number): number => conns.filter((c) => c.a.ref === prep.row[i]!.part.use.ref || c.b.ref === prep.row[i]!.part.use.ref).length;

  // ---- 2. order the row to minimise lane length
  const layoutFor = (pick: number[]) => {
    const tpl = prep.row.map((_, i) => rowT[i]![pick[i]!]!);
    const cell = tpl.map(cellOf);
    const info = new Map<string, { owner: number; xv: number }>();
    tpl.forEach((t, i) => t.esc.forEach((e) => info.set(`${e.ref}.${e.pin}`, { owner: i, xv: e.xv })));
    ctrlT.esc.forEach((e) => info.set(`${e.ref}.${e.pin}`, { owner: -1, xv: e.xv }));
    /** Left edges of the parts for an order of the free ones; pinned parts stay where the project put them. */
    const pack = (order: number[]): number[] => {
      const xs = prep.row.map(() => NaN);
      const fixed = pinned.map((i) => {
        xs[i] = prep.row[i]!.pinX!;
        return { lo: xs[i]! - cell[i]!.L, hi: xs[i]! + tpl[i]!.w + cell[i]!.R };
      });
      let cursor = 0;
      for (const i of order) {
        for (;;) {
          const x = cursor + cell[i]!.L;
          const hi = x + tpl[i]!.w + cell[i]!.R;
          const hit = fixed.find((f) => cursor < f.hi + d.gapMin && hi > f.lo - d.gapMin);
          if (hit) {
            cursor = hit.hi + d.gapMin;
            continue;
          }
          xs[i] = x;
          cursor = hi + d.gapMin;
          break;
        }
      }
      return xs;
    };
    /** Controller left edge: centred under the row of parts placed so far. */
    const ctrlAt = (xs: number[]): number => {
      if (prep.ctrlPinX !== undefined) return prep.ctrlPinX;
      let lo = Infinity;
      let hi = -Infinity;
      xs.forEach((x, i) => {
        if (isNaNx(x)) return;
        lo = Math.min(lo, x);
        hi = Math.max(hi, x + tpl[i]!.w);
      });
      return (lo === Infinity ? 0 : (lo + hi) / 2) - ctrlT.w / 2;
    };
    const cost = (order: number[]): number => {
      const xs = pack(order);
      const cx = ctrlAt(xs);
      const spans = new Map<number, Span[]>();
      for (const c of conns) {
        const A = info.get(key(c.a))!;
        const B = info.get(key(c.b))!;
        const xa = (A.owner < 0 ? cx : xs[A.owner]!) + A.xv;
        const xb = (B.owner < 0 ? cx : xs[B.owner]!) + B.xv;
        if (isNaNx(xa) || isNaNx(xb)) continue;
        spans.set(c.net, [...(spans.get(c.net) ?? []), [Math.min(xa, xb), Math.max(xa, xb)]]);
      }
      let t = 0;
      for (const list of spans.values()) t += lengthOf(list);
      return t;
    };
    return { tpl, cell, pack, ctrlAt, cost };
  };
  type Layout = ReturnType<typeof layoutFor>;
  const searchOrder = (L: Layout): number[] => {
    if (free.length <= 7) {
      let best = free;
      let bestCost = Infinity;
      eachOrder(free, (order) => {
        const c = L.cost(order);
        if (c < bestCost - 1e-9) {
          bestCost = c;
          best = order;
        }
      });
      return best;
    }
    const seq: number[] = [];
    for (const i of [...free].sort((a, b) => degree(b) - degree(a))) {
      let at = 0;
      let bestCost = Infinity;
      for (let pos = 0; pos <= seq.length; pos++) {
        const c = L.cost([...seq.slice(0, pos), i, ...seq.slice(pos)]);
        if (c < bestCost - 1e-9) {
          bestCost = c;
          at = pos;
        }
      }
      seq.splice(at, 0, i);
    }
    return seq;
  };
  let pick = prep.row.map(() => 0);
  let L = layoutFor(pick);
  let order = searchOrder(L);
  // A part that can stand two equally narrow ways (a resistor, which end faces down) takes the way with the shorter lanes.
  for (let pass = 0; pass < 2; pass++) {
    let changed = false;
    for (let i = 0; i < prep.row.length; i++) {
      if (rowT[i]!.length < 2) continue;
      let bestK = pick[i]!;
      let bestCost = layoutFor(pick).cost(order);
      for (let k = 0; k < rowT[i]!.length; k++) {
        const trial = [...pick];
        trial[i] = k;
        const c = layoutFor(trial).cost(order);
        if (c < bestCost - 1e-9) {
          bestCost = c;
          bestK = k;
        }
      }
      if (bestK !== pick[i]) {
        pick[i] = bestK;
        changed = true;
      }
    }
    if (!changed) break;
    L = layoutFor(pick);
    order = searchOrder(L);
  }
  const xs = L.pack(order);
  let cx = L.ctrlAt(xs);

  // ---- 3. bands: row parts sit on y = 0, lanes below, the controller below the lanes
  const rowNear = Math.max(0, ...L.tpl.map((t) => t.nearGap));
  const y0 = Math.max(d.pitch, d.edge, rowNear > d.edge ? rowNear + d.px(1.6) : 0);
  const lastLane = nNets ? y0 + (nNets - 1) * d.pitch : y0;
  const yC = lastLane + Math.max(d.pitch, ctrlT.nearGap > d.edge ? ctrlT.nearGap + d.px(1.6) : 0);

  // Keep the controller's verticals clear of the row's: slide it sideways until none is within `clear` of another.
  if (prep.ctrlPinX === undefined) {
    const clear = Math.min(d.chan, 1.2);
    const rv: number[] = [];
    L.tpl.forEach((t, i) => t.esc.forEach((e) => rv.push(xs[i]! + e.xv)));
    const bad = (s: number): number => {
      let n = 0;
      for (const e of ctrlT.esc) for (const r of rv) if (Math.abs(r - (cx + e.xv + s)) < clear) n++;
      return n;
    };
    let best = 0;
    let bestBad = bad(0);
    for (let k = 1; k <= 400 && bestBad > 0; k++) {
      for (const s of [k * 0.25, -k * 0.25]) {
        const b = bad(s);
        if (b < bestBad) {
          bestBad = b;
          best = s;
        }
        if (bestBad === 0) break;
      }
    }
    cx += best;
  }

  // ---- 4. the placed parts and their stubs
  const placed = new Map<string, PlacedPart>();
  const stubs: Stub[] = [];
  const addStubs = (t: Tpl, at: Pt): void => {
    for (const e of t.esc) {
      stubs.push({ ref: e.ref, pin: e.pin, net: e.net, above: e.above, hopped: e.hopped, pre: e.pre.map((p): Pt => [p[0] + at[0], p[1] + at[1]]), x: e.xv + at[0], path: [], y: 0 });
    }
  };
  prep.row.forEach((r, i) => {
    const t = L.tpl[i]!;
    placed.set(r.part.use.ref, { ...t.fp.placed, at: { x: xs[i]!, y: -t.d, z: 0, rot: t.rot } });
    addStubs(t, [xs[i]!, -t.d]);
  });
  placed.set(prep.ctrl.use.ref, { ...ctrlT.fp.placed, at: { x: cx, y: yC, z: 0, rot: ctrlT.rot } });
  addStubs(ctrlT, [cx, yC]);
  const parts = loaded.project.parts.map((u) => flatPart(placed.get(u.ref)!));
  const stubOf = new Map(stubs.map((s) => [`${s.ref}.${s.pin}`, s]));

  // ---- 5. order the lanes to minimise crossings
  const spans: Span[][] = Array.from({ length: nNets }, () => []);
  for (const c of conns) {
    const a = stubOf.get(key(c.a))!;
    const b = stubOf.get(key(c.b))!;
    spans[c.net]!.push([Math.min(a.x, b.x), Math.max(a.x, b.x)]);
  }
  const merged = spans.map(unionOf);
  const inside = (net: number, x: number): boolean => merged[net]!.some(([lo, hi]) => x > lo + 1e-6 && x < hi - 1e-6);
  const aboveN = Array.from({ length: nNets }, () => 0);
  const belowN = Array.from({ length: nNets }, () => 0);
  const cross = Array.from({ length: nNets }, () => Array.from({ length: nNets }, () => 0));
  for (const s of stubs) {
    if (s.above) aboveN[s.net]!++;
    else belowN[s.net]!++;
    for (let i = 0; i < nNets; i++) {
      if (i === s.net || !inside(i, s.x)) continue;
      // A stub from above crosses the lanes above its own; one from below, the lanes below it.
      if (s.above) cross[i]![s.net]!++;
      else cross[s.net]![i]!++;
    }
  }
  const laneOrder = orderLanes(nNets, cross, aboveN, belowN);
  const laneY = (net: number): number => y0 + laneOrder.indexOf(net) * d.pitch;
  for (const s of stubs) {
    s.y = laneY(s.net);
    s.path = tidy([...s.pre, [s.x, s.y]]);
  }

  // ---- 6. wires
  const verticals: { x: number; y0: number; y1: number; net: number }[] = [];
  for (const s of stubs) {
    for (let k = 0; k + 1 < s.path.length; k++) {
      const a = s.path[k]!;
      const b = s.path[k + 1]!;
      if (near(a[0], b[0])) verticals.push({ x: a[0], y0: Math.min(a[1], b[1]), y1: Math.max(a[1], b[1]), net: s.net });
    }
  }
  const wires: WireModel[] = conns.map((c) => {
    const a = stubOf.get(key(c.a))!;
    const b = stubOf.get(key(c.b))!;
    const cfg = loaded.project.connections[c.i]!;
    const y = laneY(c.net);
    const lo = Math.min(a.x, b.x);
    const hi = Math.max(a.x, b.x);
    // The lane run is broken either side of every stub of another net that crosses it.
    const cuts = verticals
      .filter((v) => v.net !== c.net && v.x > lo + 1e-6 && v.x < hi - 1e-6 && v.y0 < y - 1e-6 && v.y1 > y + 1e-6)
      .map((v): Span => [v.x - d.gap, v.x + d.gap]);
    const pieces: Span[] = [];
    let at = lo;
    for (const [c0, c1] of unionOf(cuts)) {
      if (c0 > at + 1e-6) pieces.push([at, c0]);
      at = Math.max(at, c1);
    }
    if (hi > at + 1e-6) pieces.push([at, hi]);
    return {
      step: prep.steps[c.i]!,
      color: wireColor(loaded, cfg, prep.steps[c.i]! - 1),
      from: c.a,
      to: c.b,
      why: cfg.why,
      net: c.net,
      path: tidy([...a.path, ...[...b.path].reverse()]),
      pieces,
      laneY: y,
    };
  });
  const lanes: LaneModel[] = laneOrder.map((net) => {
    const m = merged[net]!;
    return { net, name: prep.netNames[net]!, y: laneY(net), x0: m.length ? m[0]![0] : 0, x1: m.length ? m[m.length - 1]![1] : 0 };
  });

  // ---- 7. labels: pin names, lane names, step tags, part names
  const keysOf = new Map<string, Map<string, string> | null>([[prep.ctrl.use.ref, ctrlT.keys], ...prep.row.map((r, i): [string, Map<string, string> | null] => [r.part.use.ref, L.tpl[i]!.keys])]);
  const pins = parts.flatMap((fp) => pinLabelsOf(fp, prep.usedByRef.get(fp.ref) ?? new Set<string>(), d, keysOf.get(fp.ref)));
  /** Pin keys, placed: top-left corner in plan coordinates. */
  const keys: PlacedKey[] = [];
  prep.row.forEach((r, i) => {
    const t = L.tpl[i]!;
    if (t.key) keys.push({ ref: r.part.use.ref, x: xs[i]! + t.key.x, y: -t.d + t.key.y, key: t.key });
  });
  if (ctrlT.key) keys.push({ ref: prep.ctrl.use.ref, x: cx + ctrlT.key.x, y: yC + ctrlT.key.y, key: ctrlT.key });
  const keyBoxes: Box[] = keys.map((k) => ({ x0: k.x, y0: k.y, x1: k.x + k.key.w, y1: k.y + k.key.h }));
  const rects = parts.map((p) => p.rect);
  const boxes: Box[] = [];
  const clash = (b: Box, ignoreNet = -1, wireMargin = d.wo / 2 + d.px(0.15)): boolean => {
    if (parts.some((p) => overlap(b, grow(rectBox(p.rect), 0.1)))) return true;
    if (boxes.some((o) => overlap(b, o, d.px(0.2)))) return true;
    return verticals.some((v) => v.net !== ignoreNet && v.x > b.x0 - wireMargin && v.x < b.x1 + wireMargin && v.y0 < b.y1 && v.y1 > b.y0);
  };

  const laneLabels: LaneLabelModel[] = [];
  // Lane names and step tags print at the pin-name size or larger: 2.4 mm of font is 1.7 mm of capital.
  const laneFs = d.px(2.4);
  for (const ln of lanes) {
    const text = ln.name.toUpperCase();
    const w = textWidth(text, laneFs) * 1.04 + text.length * laneFs * 0.04;
    const h = laneFs * 0.714 * 1.4;
    // A name belongs at an end of its lane. Stubs of other nets can block that spot, so
    // try both ends, take the one that needs the smaller move, and join a name that had
    // to move to its lane with a thin line: a name a centimetre away from the line it
    // names, with other wires in between, reads as naming one of those.
    const gap = d.dotR + d.px(0.7);
    const slide = (dir: -1 | 1): { box: Box; x: number; moved: number } => {
      let x = dir < 0 ? ln.x0 - gap : ln.x1 + gap;
      const at = (): Box => (dir < 0 ? { x0: x - w, y0: ln.y - h / 2, x1: x, y1: ln.y + h / 2 } : { x0: x, y0: ln.y - h / 2, x1: x + w, y1: ln.y + h / 2 });
      let box = at();
      let k = 0;
      for (; k < 80 && clash(box, ln.net); k++) {
        x += dir * d.px(0.4);
        box = at();
      }
      return { box, x, moved: k * d.px(0.4) };
    };
    const left = slide(-1);
    const right = left.moved > 0 ? slide(1) : left;
    const useRight = right.moved < left.moved;
    const pick = useRight ? right : left;
    boxes.push(pick.box);
    const leader =
      pick.moved > d.px(1.2)
        ? useRight
          ? { x0: ln.x1, x1: pick.x - d.px(0.5) }
          : { x0: pick.x + d.px(0.5), x1: ln.x0 }
        : undefined;
    laneLabels.push({ net: ln.net, text, box: pick.box, x: pick.x, y: ln.y + laneFs * 0.714 * 0.5, fontSize: laneFs, anchor: useRight ? "start" : "end", leader });
  }

  const tags: TagModel[] = [];
  const tagFs = d.px(2.4);
  const tagH = d.px(3);
  for (const w of wires) {
    const text = String(w.step);
    const tw = Math.max(tagH, textWidth(text, tagFs) + d.px(1));
    const a = stubOf.get(key(w.from))!;
    const b = stubOf.get(key(w.to))!;
    const lo = Math.min(a.x, b.x);
    const hi = Math.max(a.x, b.x);
    const mid = (lo + hi) / 2;
    const boxAt = (x: number): Box => ({ x0: x - tw / 2, y0: w.laneY - tagH / 2, x1: x + tw / 2, y1: w.laneY + tagH / 2 });
    const dots = (b0: Box): boolean => stubs.some((s) => s.net === w.net && s.y === w.laneY && s.x > b0.x0 - d.dotR - d.px(0.2) && s.x < b0.x1 + d.dotR + d.px(0.2));
    let pickX: number | null = null;
    for (const strict of [true, false]) {
      const step = d.px(0.15);
      const reach = (hi - lo) / 2;
      for (let k = 0; k * step <= reach + 1e-9 && pickX === null; k++) {
        for (const x of k === 0 ? [mid] : [mid - k * step, mid + k * step]) {
          const bx = boxAt(x);
          if (strict && (x - tw / 2 < lo + d.dotR || x + tw / 2 > hi - d.dotR)) continue;
          if (clash(bx, w.net) || (strict && dots(bx))) continue;
          pickX = x;
          break;
        }
      }
      if (pickX !== null) break;
    }
    // A run too short for its tag (two pads side by side): the tag stands just past the end of the run, on the lane's own line.
    for (let k = 0; k < 60 && pickX === null; k++) {
      const off = d.dotR + d.px(0.4) + tw / 2 + k * d.px(0.3);
      for (const x of [hi + off, lo - off]) {
        if (clash(boxAt(x), w.net)) continue;
        pickX = x;
        break;
      }
    }
    const x = pickX ?? mid;
    const box = boxAt(x);
    boxes.push(box);
    tags.push({ step: w.step, net: w.net, text, box, x, y: w.laneY + tagFs * 0.714 * 0.5, fontSize: tagFs });
  }

  const wireBoxes: Box[] = [];
  for (const s of stubs) for (let k = 0; k + 1 < s.path.length; k++) wireBoxes.push(grow({ x0: Math.min(s.path[k]![0], s.path[k + 1]![0]), y0: Math.min(s.path[k]![1], s.path[k + 1]![1]), x1: Math.max(s.path[k]![0], s.path[k + 1]![0]), y1: Math.max(s.path[k]![1], s.path[k + 1]![1]) }, d.wo / 2 + 0.2));
  for (const l of lanes) wireBoxes.push(grow({ x0: l.x0, y0: l.y, x1: l.x1, y1: l.y }, d.wo / 2 + 0.2));
  const taken: Box[] = [...rects.map((r) => grow(rectBox(r), 0.2)), ...pins.map((l) => l.box), ...wireBoxes, ...boxes, ...keyBoxes];
  const partLabels: PartLabel[] = [];
  const zoomNotes = new Map<string, string>();
  prep.row.forEach((r, i) => {
    const n = noteOf(L.tpl[i]!);
    if (n) zoomNotes.set(r.part.use.ref, n);
  });
  const cn = noteOf(ctrlT);
  if (cn) zoomNotes.set(prep.ctrl.use.ref, cn);
  for (const fp of parts) {
    const l = partLabel(fp, fs, taken, fp.ref === prep.ctrl.use.ref, zoomNotes.get(fp.ref));
    taken.push(l.box);
    partLabels.push(l);
  }

  // ---- 8. the check, and the box the drawing fills
  const pads = new Map<string, Pt>();
  for (const fp of parts) for (const q of fp.pads) pads.set(`${fp.ref}.${q.name}`, [q.x, q.y]);
  const laneWires = wires.map((w) => ({ step: w.step, net: String(w.net), from: w.from, to: w.to, path: w.path, hopFrom: stubOf.get(key(w.from))!.hopped, hopTo: stubOf.get(key(w.to))!.hopped }));
  const checks = checkLanes({
    parts: parts.map((p) => ({ ref: p.ref, rect: p.rect })),
    labels: [
      ...pins.map((l) => ({ id: `${l.ref}.${l.pad}`, box: l.box, inside: l.ref })),
      ...partLabels.map((l) => ({ id: `${l.ref} name`, box: l.box })),
      ...keys.map((k, i) => ({ id: `${k.ref} pin key`, box: keyBoxes[i]! })),
      ...laneLabels.map((l) => ({ id: `lane ${l.text}`, box: l.box })),
      ...tags.map((t) => ({ id: `tag ${t.step}`, box: t.box, net: String(t.net) })),
    ],
    wires: laneWires,
    pads,
    steps: conns.map((c) => ({ step: prep.steps[c.i]!, from: c.a, to: c.b })),
    wire: d.wo,
  });
  const crossings = crossingPoints(laneWires, d.wo).length;

  let box = rects.map(rectBox).reduce(unionBox);
  const add = (b: Box): void => {
    box = unionBox(box, b);
  };
  pins.forEach((l) => add(l.box));
  partLabels.forEach((l) => add(l.box));
  keyBoxes.forEach(add);
  laneLabels.forEach((l) => add(l.box));
  tags.forEach((t) => add(t.box));
  wireBoxes.forEach(add);
  box = grow(box, d.px(2));
  return { d, parts, stubs, wires, lanes, pinLabels: pins, partLabels, laneLabels, tags, keys, box, checks, crossings };
}

const polyline = (pts: Pt[]): string => pts.map((p, i) => `${i ? "L" : "M"}${f(p[0])},${f(p[1])}`).join(" ");

/** Everything inside the scaled group, in model millimetres. */
function artOf(plan: Plan): string {
  const { d } = plan;
  let art = "";
  for (const fp of plan.parts) art += `<g class="part-art" data-ref="${esc(fp.ref)}">${partBody(fp, "#9a9a9a")}${partPads(fp)}</g>`;
  for (const l of plan.pinLabels) art += pinLabelMarkup(l);
  for (const l of plan.partLabels) art += l.markup;
  // A pin key: a thin box, the part's numbers bold, the names beside them.
  for (const k of plan.keys) {
    art += `<g class="pin-key" data-ref="${esc(k.ref)}"><rect x="${f(k.x)}" y="${f(k.y)}" width="${f(k.key.w)}" height="${f(k.key.h)}" rx="${f(d.px(0.8))}" fill="#fff" stroke="#888" stroke-width="${f(d.px(0.15))}"/>`;
    for (const e of k.key.entries) art += `<text x="${f(k.x + e.x)}" y="${f(k.y + e.y)}" font-size="${f(k.key.font)}" class="pin"><tspan font-weight="800">${esc(e.n)}</tspan> ${esc(e.name)}</text>`;
    art += `</g>`;
  }
  const stubOf = new Map(plan.stubs.map((s) => [`${s.ref}.${s.pin}`, s]));
  const paths = plan.wires.map((w) => {
    const a = stubOf.get(key(w.from))!;
    const b = stubOf.get(key(w.to))!;
    const run = w.pieces.map(([x0, x1]) => `M${f(x0)},${f(w.laneY)} L${f(x1)},${f(w.laneY)}`).join(" ");
    return { w, dd: `${polyline(a.path)} ${run} ${polyline([...b.path].reverse())}` };
  });
  // Outlines first, then cores, so wires of one net join without seams.
  art += `<g class="wire-outlines" fill="none" stroke="#111" stroke-width="${f(d.wo)}" stroke-linejoin="round">`;
  for (const { w, dd } of paths) art += `<path d="${dd}" data-step="${w.step}"/>`;
  art += `</g><g class="wire-cores" fill="none" stroke-width="${f(d.wc)}" stroke-linejoin="round">`;
  for (const { w, dd } of paths) art += `<path d="${dd}" stroke="${WIRE_HEX[w.color] ?? w.color}" class="wire" data-step="${w.step}"/>`;
  art += `</g>`;
  for (const s of plan.stubs) {
    const pad = s.pre[0]!;
    art += `<circle cx="${f(pad[0])}" cy="${f(pad[1])}" r="${f(d.dotR)}" fill="#111" class="pad-dot"/>`;
    art += `<circle cx="${f(s.x)}" cy="${f(s.y)}" r="${f(d.dotR)}" fill="#111" class="junction"/>`;
  }
  const halo = `paint-order="stroke" stroke="#fff" stroke-width="${f(d.px(0.7))}" stroke-linejoin="round"`;
  for (const l of plan.laneLabels) {
    const lane = plan.lanes.find((x) => x.net === l.net)!;
    if (l.leader) art += `<line x1="${f(l.leader.x0)}" y1="${f(lane.y)}" x2="${f(l.leader.x1)}" y2="${f(lane.y)}" stroke="#111" stroke-width="${f(d.px(0.18))}" stroke-dasharray="${f(d.px(0.5))} ${f(d.px(0.5))}" class="lane-leader"/>`;
    art += `<text x="${f(l.x)}" y="${f(l.y)}" text-anchor="${l.anchor}" font-size="${f(l.fontSize)}" class="lane-name" data-net="${esc(plan.lanes.find((x) => x.net === l.net)!.name)}" ${halo}>${esc(l.text)}</text>`;
  }
  for (const t of plan.tags) {
    const b = t.box;
    art += `<g class="tag" data-step="${t.step}"><rect x="${f(b.x0)}" y="${f(b.y0)}" width="${f(b.x1 - b.x0)}" height="${f(b.y1 - b.y0)}" rx="${f((b.y1 - b.y0) / 2)}" fill="#fff" stroke="#111" stroke-width="${f(d.px(0.2))}"/>`;
    art += `<text x="${f(t.x)}" y="${f(t.y)}" text-anchor="middle" font-size="${f(t.fontSize)}" class="tag-text">${esc(t.text)}</text></g>`;
  }
  return art;
}

/**
 * The legend keeps its place under the plan unless that is what holds the scale down: when the
 * plan would draw at least a third larger (and the sheet is below 1 : 1) with the whole sheet to
 * itself, the legend goes to a sheet of its own.
 */
const LEGEND_SHEET_GAIN = 1.3;

/** Smallest scale a sheet is worth printing at: a plan below this is split over sheets instead. */
const MIN_SHEET_SCALE = 2 / 3;

/** Height kept under a split sheet's plan for its notes, mm. */
const SPLIT_FOOTER = 12;

/** No sheet is drawn larger than this: a plan of two parts at 4 : 1 is no easier to read than at 2 : 1. */
const MAX_SHEET_SCALE = 2;

/** One sheet's worth of the project: some parts and the connections between and to them, always with the controller. */
interface SheetView {
  loaded: Loaded;
  /** Step number of each connection in `loaded`, as the whole project numbers them. */
  steps: number[];
  ctrl: string;
  /** Names of the parts on it, for the title block. */
  names: string[];
}

function wholeView(loaded: Loaded): SheetView {
  const ctrl = pickController(loaded).use.ref;
  return { loaded, steps: loaded.project.connections.map((_, i) => i + 1), ctrl, names: [] };
}

/**
 * A block standing for the other end of a wire that is drawn on another sheet: one pad per such wire,
 * named after the pad it goes to (`R4.1`). It is an ordinary part to the plan.
 */
function terminalPart(ref: string, title: string, pads: { name: string; role: PinRole }[]): PlacedPart {
  const pitch = 3.6;
  const def: PartDef = {
    id: `sheet-edge-${ref}`,
    name: title,
    kind: "connector",
    blurb: "",
    body: { w: pads.length * pitch + 2, d: 9, h: 1 },
    maxHeight: 1,
    pins: pads.map((p, i) => ({ name: p.name, role: p.role, x: 1 + pitch * (i + 0.5), y: 1.5 })),
    electrical: {},
    sourcing: { search: [], priceUsd: 0 },
    sources: [],
    confidence: "typical",
  };
  return { use: { ref, part: def.id, label: title }, def, at: { x: 0, y: 0, z: 0, rot: 0 } };
}

/**
 * Sheet `j` of a project split over sheets: its parts and the controller, and every connection with an
 * end on one of its parts. A connection whose other end is on another sheet ends at a terminal block
 * ("to sheet 3") on this one, at a pad named for the pad it goes to; the same step is drawn from the
 * other side on that sheet.
 */
function subView(full: Loaded, ctrl: string, sheetOf: Map<string, number>, j: number): SheetView {
  const mine = new Set([...sheetOf].filter(([, s]) => s === j).map(([r]) => r));
  const on = (ref: string): boolean => ref === ctrl || mine.has(ref);
  const conns: number[] = [];
  const connections: Connection[] = [];
  const terminals = new Map<number, { part: PlacedPart | null; pads: Map<string, PinRole> }>();
  const translated = new Map<string, { term: string; pin: string }[]>();
  full.project.connections.forEach((c, i) => {
    const [a, b] = ends(full, c);
    const owners = new Set([a, b].filter((e) => e.ref !== ctrl).map((e) => sheetOf.get(e.ref)!));
    if (!owners.size) owners.add(0);
    if (!owners.has(j)) return;
    const side = (e: End): string => {
      if (on(e.ref)) return `${e.ref}.${e.pin}`;
      const remote = sheetOf.get(e.ref)!;
      const t = terminals.get(remote) ?? { part: null, pads: new Map<string, PinRole>() };
      terminals.set(remote, t);
      const pad = String(i + 1);
      t.pads.set(pad, findPin(full.byRef.get(e.ref)!.def, e.pin)!.role);
      translated.set(`${e.ref}.${findPin(full.byRef.get(e.ref)!.def, e.pin)!.name}`, [...(translated.get(`${e.ref}.${findPin(full.byRef.get(e.ref)!.def, e.pin)!.name}`) ?? []), { term: `to${remote + 1}`, pin: pad }]);
      return `to${remote + 1}.${pad}`;
    };
    conns.push(i);
    connections.push({ ...c, from: side(a), to: side(b) });
  });
  const byRef = new Map(full.byRef);
  const termUses: PartUse[] = [];
  const termPlaced: PlacedPart[] = [];
  for (const [remote, t] of [...terminals].sort((p, q) => p[0] - q[0])) {
    const part = terminalPart(`to${remote + 1}`, `to sheet ${remote + 1}`, [...t.pads].map(([name, role]) => ({ name, role })));
    t.part = part;
    byRef.set(part.use.ref, part);
    termUses.push(part.use);
    termPlaced.push(part);
  }
  const uses = [...full.project.parts.filter((u) => on(u.ref)), ...termUses];
  // The pads this sheet draws, then the nets that touch one; a remote pad is the terminal pad that stands for it.
  const used = new Set<string>();
  for (const c of connections) for (const s of [c.from, c.to]) {
    const e = parseEnd(s);
    used.add(`${e.ref}.${findPin(byRef.get(e.ref)!.def, e.pin)!.name}`);
  }
  const nets: Net[] = [];
  for (const n of full.nets) {
    const pins: NetPin[] = [];
    for (const p of n.pins) {
      if (on(p.ref)) pins.push(p);
      else {
        for (const tr of translated.get(`${p.ref}.${p.pin.name}`) ?? []) {
          const term = byRef.get(tr.term);
          const pin = term?.def.pins.find((q) => q.name === tr.pin);
          if (term && pin) pins.push({ ref: term.use.ref, pin, part: term });
        }
      }
    }
    if (pins.some((p) => used.has(`${p.ref}.${p.pin.name}`))) nets.push({ ...n, pins });
  }
  const names = uses.filter((u) => u.ref !== ctrl && !termUses.includes(u)).map((u) => u.label ?? u.ref);
  return {
    loaded: { ...full, project: { ...full.project, parts: uses, connections }, byRef, placed: [...full.placed.filter((p) => on(p.use.ref)), ...termPlaced], nets },
    steps: conns.map((i) => i + 1),
    ctrl,
    names,
  };
}

/** Sheets for `k` bins by parts that hold together: connected parts share a bin as far as the bins' size allows. */
function partition(full: Loaded, ctrl: string, k: number): Map<string, number> {
  const refs = full.project.parts.map((u) => u.ref).filter((r) => r !== ctrl);
  const link = new Map<string, Map<string, number>>(refs.map((r) => [r, new Map()]));
  for (const c of full.project.connections) {
    const [a, b] = ends(full, c);
    if (a.ref === ctrl || b.ref === ctrl || a.ref === b.ref) continue;
    link.get(a.ref)!.set(b.ref, (link.get(a.ref)!.get(b.ref) ?? 0) + 1);
    link.get(b.ref)!.set(a.ref, (link.get(b.ref)!.get(a.ref) ?? 0) + 1);
  }
  const weight = (r: string): number => 1 + [...link.get(r)!.values()].reduce((t, n) => t + n, 0);
  const cap = Math.ceil((refs.length * 1.25) / k);
  const sheetOf = new Map<string, number>();
  const size = Array.from({ length: k }, () => 0);
  for (const r of [...refs].sort((a, b) => weight(b) - weight(a))) {
    let best = 0;
    let bestScore = -Infinity;
    for (let j = 0; j < k; j++) {
      if (size[j]! >= cap) continue;
      let together = 0;
      for (const [o, n] of link.get(r)!) if (sheetOf.get(o) === j) together += n;
      const score = together * 10 - size[j]!;
      if (score > bestScore) {
        bestScore = score;
        best = j;
      }
    }
    sheetOf.set(r, best);
    size[best]!++;
  }
  return sheetOf;
}

/** The same, but whole clusters (see `clustersOf`) go to one bin, so no wire is cut; null when that cannot be made to k bins. */
function clusterPartition(full: Loaded, ctrl: string, k: number): Map<string, number> | null {
  const clusters = clustersOf(full, ctrl);
  if (clusters.length < k) return null;
  const sheetOf = new Map<string, number>();
  const weight = Array.from({ length: k }, () => 0);
  for (const c of [...clusters].sort((a, b) => b.refs.length * 2 + b.conns.length - (a.refs.length * 2 + a.conns.length))) {
    const j = weight.indexOf(Math.min(...weight));
    for (const r of c.refs) sheetOf.set(r, j);
    weight[j]! += c.refs.length * 2 + c.conns.length;
  }
  return sheetOf;
}


/**
 * The parts that cannot be on different sheets: parts joined by a connection that does not go through
 * the controller stay together (a resistor and the strip it feeds). Every connection to the controller
 * belongs to the sheet of its other end.
 */
function clustersOf(full: Loaded, ctrl: string): { refs: string[]; conns: number[] }[] {
  const refs = full.project.parts.map((u) => u.ref).filter((r) => r !== ctrl);
  const parent = new Map(refs.map((r) => [r, r]));
  const find = (r: string): string => {
    let x = r;
    while (parent.get(x) !== x) x = parent.get(x)!;
    return x;
  };
  const ends2 = full.project.connections.map((c) => ends(full, c));
  for (const [a, b] of ends2) if (a.ref !== ctrl && b.ref !== ctrl) parent.set(find(a.ref), find(b.ref));
  const groups = new Map<string, { refs: string[]; conns: number[] }>();
  for (const r of refs) {
    const g = groups.get(find(r)) ?? { refs: [], conns: [] };
    g.refs.push(r);
    groups.set(find(r), g);
  }
  ends2.forEach(([a, b], i) => {
    const owner = a.ref !== ctrl ? a.ref : b.ref;
    if (owner === ctrl) return;
    groups.get(find(owner))!.conns.push(i);
  });
  const list = [...groups.values()];
  // A connection from the controller to itself goes on the first sheet.
  ends2.forEach(([a, b], i) => {
    if (a.ref === ctrl && b.ref === ctrl && list[0]) list[0].conns.push(i);
  });
  return list;
}

interface Solved {
  S: number;
  plan: Plan;
  /** The plan fits the area and has no check line. */
  ok: boolean;
  fits: boolean;
  areaH: number;
}

/**
 * The largest scale from `maxS` down to `minS` at which the view's plan fits `areaH` and is clean; else the largest where it fits;
 * else the one that overflows least. Parts stand upright with their pads toward the lanes; when that does not work out,
 * the same again with every part lying as flat as it can, which brings a tall part down to the height of the rest.
 */
type Posture = "upright" | "flat" | "auto";

function solveView(view: SheetView, areaH: number, minS: number, maxS = MAX_SHEET_SCALE, posture: Posture = "auto"): Solved {
  const upright = posture === "flat" ? null : solveWith(view, prepare(view.loaded, view.ctrl, view.steps), areaH, minS, maxS);
  if (posture === "upright" || upright?.ok) return upright!;
  const flat = solveWith(view, prepare(view.loaded, view.ctrl, view.steps, true), areaH, minS, maxS);
  if (!upright) return flat;
  const rank = (s: Solved): number => (s.ok ? 2 : s.fits ? 1 : 0);
  if (rank(flat) !== rank(upright)) return rank(flat) > rank(upright) ? flat : upright;
  if (flat.fits && upright.fits) return flat.plan.checks.length < upright.plan.checks.length ? flat : upright;
  return overflow(flat, areaH) < overflow(upright, areaH) ? flat : upright;
}

/** How many times the sheet's area a plan is too big in its worse direction; 1 or less when it fits. */
function overflow(s: Solved, areaH: number): number {
  const areaW = PAGE.w - 2 * PAGE.margin;
  return Math.max(((s.plan.box.x1 - s.plan.box.x0) * s.S) / areaW, ((s.plan.box.y1 - s.plan.box.y0) * s.S) / areaH);
}

function solveWith(view: SheetView, prep: Prep, areaH: number, minS: number, maxS: number): Solved {
  const areaW = PAGE.w - 2 * PAGE.margin;
  let fallback: Solved | null = null;
  // When no scale fits, the one that overflows least. A smaller scale is not a better
  // fallback: parts with close pads are enlarged to stay readable, so the plan can grow
  // on paper as the scale shrinks.
  let nearest: { over: number; solved: Solved } | null = null;
  for (const s of SCALES) {
    if (s > maxS + 1e-9) continue;
    if (s < minS - 1e-9) break;
    const plan = planAt(prep, view.loaded, s);
    const over = Math.max(((plan.box.x1 - plan.box.x0) * s) / areaW, ((plan.box.y1 - plan.box.y0) * s) / areaH);
    const fits = over <= 1;
    const solved: Solved = { S: s, plan, ok: fits && plan.checks.length === 0, fits, areaH };
    if (solved.ok) return solved;
    if (fits) fallback ??= solved;
    else if (!nearest || over < nearest.over) nearest = { over, solved };
  }
  return fallback ?? nearest?.solved ?? { S: minS, plan: planAt(prep, view.loaded, minS), ok: false, fits: false, areaH };
}

/** Longest string of `text` that fits `width` mm at `fs`, with an ellipsis when it was cut. */
function clip(text: string, width: number, fs: number): string {
  if (textWidth(text, fs, false) <= width) return text;
  let t = text;
  while (t.length > 1 && textWidth(`${t}…`, fs, false) > width) t = t.slice(0, -1);
  return `${t}…`;
}

function drawSheet(full: Loaded, view: SheetView, s: Solved, title: string, notes: string[], legendRowsUnder: Row[] | null, footer: string[] = []): { svg: string; model: PlanSheet } {
  const { plan, areaH } = s;
  const areaTop = PAGE.top + 2;
  const areaW = PAGE.w - 2 * PAGE.margin;
  const b = plan.box;
  // A plan that no scale holds is shrunk to the sheet, so it never runs over the title or
  // the connections list. It is then not to scale: the title says so and a check line is printed.
  const S = s.fits ? s.S : s.S * Math.min(1, areaW / ((b.x1 - b.x0) * s.S), areaH / ((b.y1 - b.y0) * s.S));
  const dw = (b.x1 - b.x0) * S;
  const dh = (b.y1 - b.y0) * S;
  const tx = PAGE.margin + (areaW - dw) / 2 - b.x0 * S;
  const ty = areaTop + (areaH - dh) / 2 - b.y0 * S;
  let svg = svgOpen() + titleBlock(full.project, title, s.fits ? scaleText(S) : NOT_TO_SCALE, [...notes, ...unverifiedNotes(full)]);
  svg += `<g class="drawing" transform="translate(${f(tx)} ${f(ty)}) scale(${S})">${artOf(plan)}</g>`;
  footer.forEach((t, i) => {
    svg += `<text x="${PAGE.margin}" y="${f(PAGE.bottom - 2 - (footer.length - 1 - i) * 3.8)}" font-size="2.8" class="small">${esc(t)}</text>`;
  });
  if (legendRowsUnder) {
    const leg = legend(legendRowsUnder, 0);
    svg += legend(legendRowsUnder, PAGE.bottom - leg.height).markup;
  }
  svg += `</svg>`;
  const checks = [...plan.checks];
  if (!s.fits) checks.push(`the plan fits the sheet at no scale, so it is shrunk to fit and is not to scale: pad names may be too small to read`);
  return {
    svg,
    model: {
      svg,
      scale: S,
      parts: plan.parts,
      wires: plan.wires,
      lanes: plan.lanes,
      pinLabels: plan.pinLabels,
      partLabels: plan.partLabels,
      laneLabels: plan.laneLabels,
      tags: plan.tags,
      keys: plan.keys,
      checks,
      crossings: plan.crossings,
    },
  };
}

/** The connections list as sheets of its own: one when it fits, as large as it can be, else as many as it takes. */
export function legendPages(full: Loaded, rows: Row[]): { svg: string; over: boolean }[] {
  const fitsPage = (list: Row[], k: number): boolean => PAGE.top + 3 + legend(list, PAGE.top + 3, k).height <= PAGE.bottom;
  const page = (list: Row[], k: number, n: number, of: number): string =>
    svgOpen() + titleBlock(full.project, of > 1 ? `Wiring, connections (${n} of ${of})` : "Wiring, connections", undefined, unverifiedNotes(full)) + legend(list, PAGE.top + 3, k).markup + `</svg>`;
  for (const k of [1.45, 1.2, 1]) if (fitsPage(rows, k)) return [{ svg: page(rows, k, 1, 1), over: false }];
  // Past what one sheet holds at the smallest size: as many rows to a sheet as fit.
  let per = rows.length;
  while (per > 1 && !fitsPage(rows.slice(0, per), 1)) per--;
  const chunks: Row[][] = [];
  for (let i = 0; i < rows.length; i += per) chunks.push(rows.slice(i, i + per));
  return chunks.map((c, i) => ({ svg: page(c, 1, i + 1, chunks.length), over: !fitsPage(c, 1) }));
}

/** Plan the sheet at the largest drawing scale at which everything fits, and draw it; split over sheets when one cannot be read. */
export function buildWiring(loaded: Loaded): WiringModel {
  warnUnresolvedGeometry(loaded, "physical wiring drawings");
  const rows = legendRows(loaded);
  const leg = legend(rows, 0);
  const areaTop = PAGE.top + 2;
  const areaHWith = PAGE.bottom - leg.height - 6 - areaTop;
  const areaHAlone = PAGE.bottom - 2 - areaTop;
  const whole = wholeView(loaded);

  const layout = (flatPass: boolean) => {
    // One sheet first. Under the plan the legend costs height; on its own sheet it costs none.
    // Parts stand upright; only a plan that cannot be read that way is tried with them lying flat (the second pass).
    const posture: Posture = flatPass ? "flat" : "upright";
    const alone = solveView(whole, areaHAlone, 0, MAX_SHEET_SCALE, posture);
    const withLeg = solveView(whole, areaHWith, 0, alone.S, posture);
    // The legend gets its own sheet when the plan does not fit above it at any scale, or
    // when the plan is drawn clearly larger without it. (A plan that does not fit reports
    // the scale that overflows least, so its scale alone cannot decide this.)
    const legendOwn = !withLeg.fits || (withLeg.S < 1 && alone.S / withLeg.S >= LEGEND_SHEET_GAIN);
    const single = legendOwn ? alone : withLeg;
    const readable = single.ok && single.S >= MIN_SHEET_SCALE - 1e-9;

    let sheets: { svg: string; model: PlanSheet }[] = [];
    let split = false;
    let note = "";
    if (!readable) {
      // The plan cannot be read as one sheet: by subsystem, with the controller on every sheet. Whole groups of
      // parts first (no wire is cut); else the parts split where fewest wires cross, a cut wire ending at a
      // "to sheet N" block on each of its two sheets.
      const nParts = loaded.project.parts.length - 1;
      for (let k = 2; k <= Math.min(Math.max(nParts, 2), 8) && !split; k++) {
        for (const sheetOf of [clusterPartition(loaded, whole.ctrl, k), partition(loaded, whole.ctrl, k)]) {
          if (!sheetOf || split) continue;
          const used = [...new Set(sheetOf.values())].sort((a, b) => a - b);
          if (used.length < 2) continue;
          // Renumber so sheets are 0..n-1 in the order of their first part in the project.
          const order = new Map(used.map((s, i) => [s, i]));
          const compact = new Map([...sheetOf].map(([r, s]) => [r, order.get(s)!]));
          const views = used.map((_, j) => subView(loaded, whole.ctrl, compact, j));
          const solved = views.map((v) => solveView(v, areaHAlone - SPLIT_FOOTER, MIN_SHEET_SCALE, MAX_SHEET_SCALE, flatPass ? "auto" : "upright"));
          if (!solved.every((x) => x.ok)) continue;
          split = true;
          const netSheets = new Map<string, number[]>();
          views.forEach((v, i) => v.loaded.nets.forEach((n) => netSheets.set(n.name, [...(netSheets.get(n.name) ?? []), i + 1])));
          sheets = views.map((v, i) => {
            // Several nets can carry one name (two grounds joined at the controller): name each once.
            const shared = [...new Set(v.loaded.nets.filter((n) => (netSheets.get(n.name) ?? []).length > 1).map((n) => n.name))];
            const cut = v.loaded.project.parts.some((u) => u.part.startsWith("sheet-edge-"));
            const footer = [
              `Sheet ${i + 1} of ${views.length}: ${clip(v.names.join(", "), 255, 2.8)}`,
              ...(shared.length ? [clip(`Nets that continue on other sheets: ${shared.join(", ")}`, 255, 2.8)] : []),
              ...(cut ? ["A block \"to sheet N\" is the other end of a wire drawn on sheet N; its pads are numbered like the wire's step."] : []),
            ];
            return drawSheet(loaded, v, solved[i]!, `Wiring, top view, sheet ${i + 1} of ${views.length}`, ["Step numbers: see the connections sheets"], null, footer);
          });

          note = `split over ${views.length} sheets`;
        }
      }
      if (!split) note = `no split of its ${nParts} parts over up to 8 sheets draws every sheet cleanly at 1 : 1.5 or larger`;
    }

    if (!split) {
      const s = single;
      const legendUnder = !legendOwn;
      sheets = [drawSheet(loaded, whole, s, "Wiring, top view", legendOwn ? ["Step numbers: see the connections sheet"] : [], legendUnder ? rows : null)];
      if (!readable && note) sheets[0]!.model.checks.push(`the wiring plan is ${s.fits ? `drawn at ${scaleText(s.S)}` : "on one sheet"}: ${note}`);
    }

    return { sheets, split, legendOwn, readable, note, single };
  };
  let lay = layout(false);
  if (!lay.readable && !lay.split) {
    const again = layout(true);
    if (again.readable || again.split) lay = again;
  }
  const { sheets, split, legendOwn } = lay;
  const needLegendSheets = split || legendOwn;
  const pages = needLegendSheets ? legendPages(loaded, rows) : [];
  const checks = sheets.flatMap((x) => x.model.checks);
  if (pages.some((p) => p.over)) checks.push("the connections list does not fit its sheet");
  const first = sheets[0]!.model;
  return {
    ...first,
    checks,
    sheets: sheets.map((x) => x.model),
    legendSheet: pages[0]?.svg ?? null,
    legendPages: pages.map((p) => p.svg),
  };
}


// ---------------------------------------------------------------------------
// Pin map
// ---------------------------------------------------------------------------

export interface PinRow {
  ref: string;
  pin: string;
  gpio: string;
  net: string;
  other: string;
  colors: string[];
}

export function pinRows(loaded: Loaded): PinRow[] {
  const netOf = new Map<string, string>();
  for (const n of loaded.nets) for (const p of n.pins) netOf.set(`${p.ref}.${p.pin.name}`, n.name);
  const rows: PinRow[] = [];
  const boards = loaded.placed.filter((p) => p.def.kind === "board");
  const controllers = boards.length ? boards : [pickController(loaded)];
  for (const c of controllers) {
    for (const pin of c.def.pins) {
      const touching: { other: End; i: number }[] = [];
      loaded.project.connections.forEach((conn, i) => {
        const [a, b] = ends(loaded, conn);
        if (a.ref === c.use.ref && a.pin === pin.name) touching.push({ other: b, i });
        else if (b.ref === c.use.ref && b.pin === pin.name) touching.push({ other: a, i });
      });
      if (!touching.length) continue;
      rows.push({
        ref: c.use.ref,
        pin: pin.name,
        gpio: pin.gpio === undefined ? "–" : String(pin.gpio),
        net: netOf.get(`${c.use.ref}.${pin.name}`) ?? "",
        other: touching.map((t) => `${t.other.ref}.${t.other.pin}`).join(", "),
        colors: touching.map((t) => wireColor(loaded, loaded.project.connections[t.i]!, t.i)),
      });
    }
  }
  return rows;
}

export function pinmapSvg(loaded: Loaded): string {
  const rows = pinRows(loaded);
  const x0 = PAGE.margin;
  const cols = { pin: x0, gpio: x0 + 48, net: x0 + 78, other: x0 + 128, wire: x0 + 232 };
  let svg = svgOpen() + titleBlock(loaded.project, "Controller pin map", undefined, unverifiedNotes(loaded));
  const rowH = Math.min(11, (PAGE.bottom - 52) / Math.max(rows.length, 1));
  let y = 40;
  for (const [x, t] of [[cols.pin, "Pin"], [cols.gpio, "GPIO"], [cols.net, "Net"], [cols.other, "Other end"], [cols.wire, "Wire"]] as [number, string][]) {
    svg += `<text x="${x}" y="${y}" font-size="3.4" class="th">${t}</text>`;
  }
  svg += `<line x1="${x0}" y1="${y + 2.5}" x2="${PAGE.w - PAGE.margin}" y2="${y + 2.5}" stroke="#111" stroke-width="0.5"/>`;
  y += 4 + rowH * 0.62;
  for (const r of rows) {
    svg += `<g class="row" data-pin="${esc(r.pin)}">`;
    svg += `<text x="${cols.pin}" y="${f(y)}" font-size="5.2" class="th">${esc(r.pin)}</text>`;
    svg += `<text x="${cols.pin + textWidth(r.pin, 5.2) + 2}" y="${f(y)}" font-size="3" class="small">${esc(r.ref)}</text>`;
    svg += `<text x="${cols.gpio}" y="${f(y)}" font-size="4.6">${esc(r.gpio)}</text>`;
    svg += `<text x="${cols.net}" y="${f(y)}" font-size="4.2" class="mono">${esc(r.net)}</text>`;
    svg += `<text x="${cols.other}" y="${f(y)}" font-size="3.8">${esc(r.other)}</text>`;
    r.colors.forEach((col, k) => {
      svg += `<rect x="${f(cols.wire + k * 13)}" y="${f(y - 2.2)}" width="11" height="3" rx="1.5" fill="${WIRE_HEX[col] ?? col}" stroke="#111" stroke-width="0.35"/>`;
    });
    svg += `<line x1="${x0}" y1="${f(y + rowH * 0.38)}" x2="${PAGE.w - PAGE.margin}" y2="${f(y + rowH * 0.38)}" stroke="#bbb" stroke-width="0.25"/></g>`;
    y += rowH;
  }
  return svg + `</svg>`;
}

// ---------------------------------------------------------------------------
// Enclosure
// ---------------------------------------------------------------------------

interface ViewOpening {
  name: string;
  /** Centre from the view's left edge and from its top edge, mm of the object. */
  a: number;
  b: number;
  w: number;
  h: number;
  shape: "rect" | "round";
}

type ViewKey = "top" | "front" | "right" | "back" | "left";

interface ViewDef {
  key: ViewKey;
  title: string;
  w: number;
  h: number;
  openings: ViewOpening[];
}

export interface EnclosureDrawing {
  svg: string;
  scale: number;
  /** Everything the drawing prints as an overall dimension. */
  overall: { width: number; depth: number; height: number; body: number; lid: number };
  /** One line per overlap the sheet check found; empty when the sheet is clean. */
  checks: string[];
}

const openingName = (o: Opening): string => (o.ref ? o.port : o.port);

function viewsOf(L: EnclosureLayout): ViewDef[] {
  const W = L.outer.w;
  const D = L.outer.d;
  const Ht = closedHeight(L);
  const on = (face: Opening["face"], conv: (o: Opening) => { a: number; b: number }): ViewOpening[] =>
    L.openings
      .filter((o) => o.face === face)
      .map((o) => ({ name: openingName(o), ...conv(o), w: o.w, h: o.shape === "round" ? o.w : o.h, shape: o.shape }));
  return [
    { key: "top", title: "Top", w: W, h: D, openings: on("lid", (o) => ({ a: o.u, b: D - o.v })) },
    { key: "front", title: "Front", w: W, h: Ht, openings: on("y-", (o) => ({ a: o.u, b: Ht - o.v })) },
    { key: "right", title: "Right side", w: D, h: Ht, openings: on("x+", (o) => ({ a: o.u, b: Ht - o.v })) },
    { key: "back", title: "Back", w: W, h: Ht, openings: on("y+", (o) => ({ a: W - o.u, b: Ht - o.v })) },
    { key: "left", title: "Left side", w: D, h: Ht, openings: on("x-", (o) => ({ a: D - o.u, b: Ht - o.v })) },
  ];
}

const LANE = 6.4;
const NOTE_FONT = 2.8;
const NOTE_PITCH = 4.4;

/** A box of `w` x `h` as near as the sheet allows to the wanted top-left corner; null when nothing is free. */
function placeNear(sheet: Sheet, item: Omit<SheetItem, "box">, w: number, h: number, want: Pt, within: Box): Box | null {
  const step = 1;
  const cands: { x: number; y: number; d: number }[] = [];
  for (let y = within.y0; y + h <= within.y1; y += step) {
    for (let x = within.x0; x + w <= within.x1; x += step) cands.push({ x, y, d: (x - want[0]) ** 2 + (y - want[1]) ** 2 });
  }
  cands.sort((a, b) => a.d - b.d);
  for (const c of cands) {
    const box = { x0: c.x, y0: c.y, x1: c.x + w, y1: c.y + h };
    if (sheet.free({ ...item, box })) return box;
  }
  return null;
}

export function buildEnclosure(loaded: Loaded, L: EnclosureLayout = layoutEnclosure(loaded)): EnclosureDrawing {
  warnUnresolvedGeometry(loaded, "dimensioned enclosure drawings");
  const W = L.outer.w;
  const D = L.outer.d;
  const Ht = closedHeight(L);
  const views = viewsOf(L);
  const view = (k: ViewKey): ViewDef => views.find((v) => v.key === k)!;
  const aux = views.filter((v) => (v.key === "back" || v.key === "left") && v.openings.length);
  const top = view("top");
  const front = view("front");
  const right = view("right");

  // Lane counts: horizontal-position dimensions go above a view, vertical ones to its left.
  const laneH = (v: ViewDef): number => v.openings.length + (v.key === "top" && L.screws.length ? 1 : 0);
  const laneV = laneH;
  const need = (S: number) => {
    const leftG = 10 + LANE * Math.max(laneV(top), laneV(front));
    const gapH = 20 + LANE * Math.max(laneV(right), 0) + 2;
    const rightG = 16;
    const topG = 8 + LANE * Math.max(laneH(top), laneH(right), aux.length ? 1 : 0);
    const gapV = 11 + LANE * Math.max(laneH(front), laneH(right));
    const botG = 16;
    const auxW = aux.reduce((t, v) => t + v.w * S + 12 + LANE * laneV(v), 0);
    const width = Math.max(leftG + W * S + gapH + D * S + rightG, leftG + W * S + gapH + auxW);
    const height = topG + D * S + gapV + Ht * S + botG;
    return { leftG, gapH, rightG, topG, gapV, botG, width, height };
  };
  const areaW = PAGE.w - 2 * PAGE.margin;
  const areaH = PAGE.bottom - PAGE.top - 2;
  const pageBox: Box = { x0: PAGE.margin, y0: PAGE.top + 1, x1: PAGE.w - PAGE.margin, y1: PAGE.bottom };

  /** Draw the sheet at scale S. `complete` is false when a note or label found no free place on it. */
  const render = (S: number) => {
    const n = need(S);
    const sheet = new Sheet();
    const ox = PAGE.margin + (areaW - n.width) / 2;
    const oy = PAGE.top + 2 + (areaH - n.height) / 2;
    const frontX = ox + n.leftG;
    const rightX = frontX + W * S + n.gapH;
    const topY = oy + n.topG;
    const frontY = topY + D * S + n.gapV;
    const topX = frontX;
    let complete = true;

    const pos = (k: ViewKey): { x: number; y: number } => {
      if (k === "top") return { x: topX, y: topY };
      if (k === "front") return { x: frontX, y: frontY };
      if (k === "right") return { x: rightX, y: frontY };
      const i = aux.findIndex((v) => v.key === k);
      let x = rightX;
      for (let j = 0; j < i; j++) x += aux[j]!.w * S + 12 + LANE * laneV(aux[j]!);
      return { x: x + LANE * laneV(aux[i]!), y: topY + (D - aux[i]!.h) * S };
    };

    const keyLines: string[] = [];
    let art = "";
    /** Texts that wait until every outline, opening and dimension is down, so they are placed against all of them. */
    const jobs: (() => void)[] = [];
    let late = "";
    const rect = (x: number, y: number, w: number, h: number, extra: string): string => `<rect x="${f(x)}" y="${f(y)}" width="${f(w)}" height="${f(h)}" ${extra}/>`;
    const rx = Math.min(L.radius, W / 2, D / 2) * S;
    const textAt = (id: string, text: string, x: number, base: number, fs: number, cls: string, moves: string, attrs = ""): string => {
      sheet.add({ id, kind: "text", box: textBox(x, base, text, fs), moves });
      return `<text x="${f(x)}" y="${f(base)}" font-size="${fs}" class="${cls}"${attrs}>${esc(text)}</text>`;
    };

    const drawView = (v: ViewDef): void => {
      const { x, y } = pos(v.key);
      const w = v.w * S;
      const h = v.h * S;
      art += `<g class="view" data-view="${v.key}">`;
      art += rect(x, y, w, h, `rx="${v.key === "top" ? f(rx) : 0}" fill="#fff" stroke="#111" stroke-width="${HEAVY}" stroke-linejoin="round"`);
      sheet.add({ id: `${v.title} view outline`, kind: "outline", box: { x0: x, y0: y, x1: x + w, y1: y + h }, moves: "the case size" });
      if (v.key !== "top") {
        art += `<line x1="${f(x)}" y1="${f(y + L.lidThickness * S)}" x2="${f(x + w)}" y2="${f(y + L.lidThickness * S)}" stroke="#111" stroke-width="${THIN * 1.4}"/>`;
      } else {
        // Hidden cavity wall, and the lid screws.
        art += rect(x + L.wall * S, y + L.wall * S, w - 2 * L.wall * S, h - 2 * L.wall * S, `rx="${f(Math.max(0, rx - L.wall * S))}" fill="none" stroke="#777" stroke-width="${THIN}" stroke-dasharray="1.6 1.2"`);
        for (const p of L.parts) {
          const fp = footprint(p);
          const px = x + p.at.x * S;
          const py = y + (D - p.at.y - fp.d) * S;
          const lidPart = loaded.project.enclosure?.mounts.find((m) => m.ref === p.use.ref)?.on === "lid";
          art += rect(px, py, fp.w * S, fp.d * S, `fill="none" stroke="#111" stroke-width="${THIN * 1.6}" stroke-dasharray="${lidPart ? "0.9 0.9" : "3 1.5"}"`);
          sheet.add({ id: `part ${p.use.ref} outline`, kind: "outline", box: { x0: px, y0: py, x1: px + fp.w * S, y1: py + fp.d * S }, moves: `the mount of ${p.use.ref}` });
          const name = p.use.label ?? p.use.ref;
          const tw = textWidth(name, 2.5, false);
          jobs.push(() => {
            // Corners of the part's own outline first; a part too small for its name gets a number, and the name goes in the notes.
            const rw = fp.w * S;
            const rh = fp.d * S;
            const spots: [number, number, "start" | "end"][] = [[px + 1.2, py + 3.4, "start"], [px + rw - 1.2, py + 3.4, "end"], [px + 1.2, py + rh - 1.2, "start"], [px + rw - 1.2, py + rh - 1.2, "end"]];
            if (tw + 2.4 <= rw && rh >= 6) {
              for (const [sx, sy, an] of spots) {
                const item: SheetItem = { id: `part name ${name}`, kind: "text", box: textBox(sx, sy, name, 2.5, an), moves: `the mount of ${p.use.ref}` };
                if (!sheet.free(item)) continue;
                sheet.add(item);
                late += `<text x="${f(sx)}" y="${f(sy)}" font-size="2.5" text-anchor="${an}" class="small" data-part="${esc(p.use.ref)}">${esc(name)}</text>`;
                return;
              }
            }
            keyLines.push(name);
            const k = keyLines.length;
            // A number: inside its own outline if it fits, else the nearest free place, tied to the part by a short line.
            const circle = (c: Pt): Box => ({ x0: c[0] - 1.9, y0: c[1] - 1.9, x1: c[0] + 1.9, y1: c[1] + 1.9 });
            const cspots: Pt[] = [[px + 3, py + 3], [px + rw - 3, py + 3], [px + 3, py + rh - 3], [px + rw - 3, py + rh - 3], [px + rw / 2, py + rh / 2]];
            const item = { id: `part number ${k}`, kind: "text" as const, moves: `the mount of ${p.use.ref}` };
            let at: Pt | null = cspots.find((c) => sheet.free({ ...item, box: circle(c) })) ?? null;
            let tie = false;
            if (!at) {
              const b = placeNear(sheet, item, 3.8, 3.8, [px - 4, py - 4], pageBox);
              if (b) {
                at = [(b.x0 + b.x1) / 2, (b.y0 + b.y1) / 2];
                tie = true;
              }
            }
            if (!at) {
              complete = false;
              at = cspots[0]!;
            }
            sheet.add({ ...item, box: circle(at) });
            if (tie) {
              const tx = Math.min(Math.max(at[0], px), px + rw);
              const ty = Math.min(Math.max(at[1], py), py + rh);
              late += `<line x1="${f(at[0])}" y1="${f(at[1])}" x2="${f(tx)}" y2="${f(ty)}" stroke="#111" stroke-width="0.2"/><circle cx="${f(tx)}" cy="${f(ty)}" r="0.5" fill="#111"/>`;
            }

            late += `<circle cx="${f(at[0])}" cy="${f(at[1])}" r="1.9" fill="#fff" stroke="#111" stroke-width="0.25"/><text x="${f(at[0])}" y="${f(at[1] + 0.9)}" font-size="2.4" text-anchor="middle" data-part="${esc(p.use.ref)}">${k}</text>`;
          });
        }
        for (const s of L.screws) {
          const cx = x + s.x * S;
          const cy = y + (D - s.y) * S;
          const r = (s.dia / 2) * S;
          art += `<circle cx="${f(cx)}" cy="${f(cy)}" r="${f(r)}" fill="#fff" stroke="#111" stroke-width="${THIN * 1.6}"/>`;
          art += `<path d="M${f(cx - r - 1.2)},${f(cy)} H${f(cx + r + 1.2)} M${f(cx)},${f(cy - r - 1.2)} V${f(cy + r + 1.2)}" stroke="#111" stroke-width="${THIN}"/>`;
          sheet.add({ id: "lid screw", kind: "solid", box: { x0: cx - r - 1.2, y0: cy - r - 1.2, x1: cx + r + 1.2, y1: cy + r + 1.2 }, moves: "the screw layout" });
        }
      }
      // Openings first, then the dimensions that locate them. Dimension lines are nested, shortest
      // nearest the view, so no line crosses another's number.
      interface PlacedDim {
        span: number;
        draw: (lane: number) => string;
      }
      const dimsH: PlacedDim[] = [];
      const dimsV: PlacedDim[] = [];
      for (const o of v.openings) {
        const cx = x + o.a * S;
        const cy = y + o.b * S;
        const sw = o.w * S;
        const sh = o.h * S;
        art +=
          o.shape === "round"
            ? `<circle cx="${f(cx)}" cy="${f(cy)}" r="${f(sw / 2)}" fill="#fff" stroke="#111" stroke-width="${HEAVY}"/>`
            : rect(cx - sw / 2, cy - sh / 2, sw, sh, `rx="0.4" fill="#fff" stroke="#111" stroke-width="${HEAVY}"`);
        const hh = o.shape === "round" ? sw : sh;
        sheet.add({ id: `opening ${o.name}`, kind: "solid", box: { x0: cx - sw / 2 - 0.2, y0: cy - hh / 2 - 0.2, x1: cx + sw / 2 + 0.2, y1: cy + hh / 2 + 0.2 }, moves: `the position of the ${o.name} opening` });
        const size = o.shape === "round" ? `Ø${fmt(o.w)}` : `${fmt(o.w)} × ${fmt(o.h)}`;
        const label = `${o.name}  ${size}`;
        jobs.push(() => {
          const lw = textWidth(label, 2.7, false);
          const lh = 3.2;
          const item = { id: `opening label ${o.name}`, kind: "text" as const, moves: `the position or name of the ${o.name} opening` };
          // Beside the opening when there is room; otherwise the nearest free place, tied to the opening by a leader.
          const beside: Box = { x0: cx + sw / 2 + 1.4, y0: cy - lh / 2, x1: cx + sw / 2 + 1.4 + lw, y1: cy + lh / 2 };
          const onTop = v.key === "top";
          let box: Box | null = onTop ? null : sheet.free({ ...item, box: beside }) ? beside : null;
          let leader = false;
          if (!box) {
            const want: Pt = onTop ? [x + w + 9, cy - lh / 2] : [beside.x0, beside.y0];
            box = placeNear(sheet, item, lw, lh, want, pageBox);
            leader = true;
          }
          if (!box) {
            complete = false;
            box = beside;
            leader = false;
          }
          sheet.add({ ...item, box });
          if (leader) {
            const ex = box.x0 >= cx ? cx + sw / 2 : box.x1 <= cx ? cx - sw / 2 : cx;
            const ey = box.x0 >= cx || box.x1 <= cx ? cy : box.y0 > cy ? cy + hh / 2 : cy - hh / 2;
            const tx = box.x0 >= cx ? box.x0 - 0.8 : box.x1 <= cx ? box.x1 + 0.8 : (box.x0 + box.x1) / 2;
            const ty = box.x0 >= cx || box.x1 <= cx ? (box.y0 + box.y1) / 2 : box.y0 > cy ? box.y0 - 0.4 : box.y1 + 0.4;
            late += `<polyline points="${f(ex)},${f(ey)} ${f(tx)},${f(ty)}" fill="none" stroke="#111" stroke-width="0.2"/><circle cx="${f(ex)}" cy="${f(ey)}" r="0.55" fill="#111"/>`;
          }
          late += `<text x="${f(box.x0)}" y="${f(box.y1 - 0.8)}" font-size="2.7" class="small" data-opening="${esc(o.name)}" paint-order="stroke" stroke="#fff" stroke-width="0.7">${esc(label)}</text>`;
        });
        const xl = o.a - o.w / 2;
        const xr = o.a + o.w / 2;
        const yt = o.b - o.h / 2;
        const yb = o.b + o.h / 2;
        const fromLeft = xl <= v.w - xr;
        const dxv = fromLeft ? xl : v.w - xr;
        dimsH.push({
          span: dxv,
          draw: (lane) =>
            fromLeft
              ? dimHoriz(x, x + xl * S, y, y + yt * S, y - LANE * lane, { value: dxv, kind: `${v.key}-x`, sheet, id: `${v.key} ${o.name} x` })
              : dimHoriz(x + xr * S, x + w, y + yt * S, y, y - LANE * lane, { value: dxv, kind: `${v.key}-x`, sheet, id: `${v.key} ${o.name} x` }),
        });
        const fromTop = yt <= v.h - yb;
        const dyv = fromTop ? yt : v.h - yb;
        dimsV.push({
          span: dyv,
          draw: (lane) =>
            fromTop
              ? dimVert(y, y + yt * S, x, x + xl * S, x - LANE * lane, { value: dyv, kind: `${v.key}-y`, sheet, id: `${v.key} ${o.name} y` })
              : dimVert(y + yb * S, y + h, x + xl * S, x, x - LANE * lane, { value: dyv, kind: `${v.key}-y`, sheet, id: `${v.key} ${o.name} y` }),
        });
      }
      if (v.key === "top" && L.screws.length) {
        const sc = [...L.screws].sort((p, q) => p.x - q.x || p.y - q.y)[0]!;
        const cx = x + sc.x * S;
        const cy = y + (D - sc.y) * S;
        dimsH.push({ span: sc.x, draw: (lane) => dimHoriz(x, cx, y, cy, y - LANE * lane, { value: sc.x, kind: "screw-x", sheet, id: "screw x" }) });
        dimsV.push({ span: sc.y, draw: (lane) => dimVert(cy, y + h, cx, x, x - LANE * lane, { value: sc.y, kind: "screw-y", sheet, id: "screw y" }) });
      }
      [...dimsH].sort((p, q) => p.span - q.span).forEach((d, i) => (art += d.draw(i + 1)));
      [...dimsV].sort((p, q) => p.span - q.span).forEach((d, i) => (art += d.draw(i + 1)));
      art += textAt(`${v.title} title`, v.title, x + 1.4, y + h + 4.6, 3.2, "th", "the layout");
      art += `</g>`;
    };
    drawView(top);
    drawView(front);
    drawView(right);
    for (const v of aux) drawView(v);

    // Overall dimensions, once each.
    const fp = pos("front");
    const rp = pos("right");
    const lineY = fp.y + Ht * S + 11;
    art += dimHoriz(fp.x, fp.x + W * S, fp.y + Ht * S, fp.y + Ht * S, lineY, { value: W, kind: "width", sheet, id: "width" });
    art += dimHoriz(rp.x, rp.x + D * S, rp.y + Ht * S, rp.y + Ht * S, lineY, { value: D, kind: "depth", sheet, id: "depth" });
    art += dimVert(rp.y, rp.y + Ht * S, rp.x + D * S, rp.x + D * S, rp.x + D * S + 11, { value: Ht, kind: "height", sheet, id: "height" });
    // Body and lid, between the front and right views.
    const splitX = fp.x + W * S + 9;
    art += dimVert(fp.y, fp.y + L.lidThickness * S, fp.x + W * S, fp.x + W * S, splitX, { value: L.lidThickness, kind: "lid", sheet, id: "lid" });
    art += dimVert(fp.y + L.lidThickness * S, fp.y + Ht * S, fp.x + W * S, fp.x + W * S, splitX, { value: L.outer.h, kind: "body", sheet, id: "body" });

    // Part names, opening labels and callouts go down against everything above, then the notes in whatever room is left.
    for (const job of jobs) job();
    const notes = [
      "Third-angle projection. All dimensions in mm.",
      `Wall ${fmt(L.wall)} mm. Floor ${fmt(L.floor)} mm. Lid ${fmt(L.lidThickness)} mm.`,
      `Outside corner radius ${fmt(Math.min(L.radius, W / 2, D / 2))} mm.`,
      L.screws.length ? `${L.screws.length} × Ø${fmt(L.screws[0]!.dia)} lid screws, positions in the top view.` : "No lid screws.",
      "Long dashes: parts on the floor. Short dashes: parts on the lid.",
      ...keyLines.map((t, i) => `${i + 1}  ${t}`),
    ];
    // One column when it fits somewhere, else two side by side: a long, flat case leaves a wide, short gap.
    const noteLayouts = [1, 2, 3].map((cols) => {
      const per = Math.ceil(notes.length / cols);
      const colsOf = Array.from({ length: cols }, (_, c) => notes.slice(c * per, (c + 1) * per)).filter((c) => c.length);
      const widths = colsOf.map((c) => Math.max(...c.map((t) => textWidth(t, NOTE_FONT, false))) + 1);
      return { colsOf, widths, w: widths.reduce((a, b) => a + b, 0) + 6 * (colsOf.length - 1), h: per * NOTE_PITCH + 1 };
    });
    let nb: Box | null = null;
    let nl = noteLayouts[0]!;
    for (const lay of noteLayouts) {
      nb = placeNear(sheet, { id: "notes", kind: "text", moves: "the case size" }, lay.w, lay.h, [PAGE.w - PAGE.margin - lay.w, PAGE.top + 2], pageBox);
      if (nb) {
        nl = lay;
        break;
      }
    }
    if (!nb) {
      complete = false;
      nb = { x0: PAGE.w - PAGE.margin - nl.w, y0: PAGE.top + 2, x1: PAGE.w - PAGE.margin, y1: PAGE.top + 2 + nl.h };
    }
    sheet.add({ id: "notes", kind: "text", box: nb, moves: "the case size (a smaller drawing leaves room)" });
    let cx0 = nb.x0;
    nl.colsOf.forEach((c, ci) => {
      c.forEach((t, i) => {
        late += `<text x="${f(cx0)}" y="${f(nb!.y0 + 3 + i * NOTE_PITCH)}" font-size="${NOTE_FONT}" class="small">${esc(t)}</text>`;
      });
      cx0 += nl.widths[ci]! + 6;
    });
    return { S, art: art + late, sheet, complete };
  };

  const fitting = SCALES.filter((s) => {
    const n = need(s);
    return n.width <= areaW && n.height <= areaH;
  });
  let r = null as ReturnType<typeof render> | null;
  for (const s of fitting) {
    r = render(s);
    if (r.complete) break;
  }
  if (!r) r = render(SCALES[SCALES.length - 1]!);
  const checks = checkSheet(r.sheet, "enclosure.svg");
  if (!r.complete) checks.push("enclosure.svg: a note or label found no free place on the sheet even at the smallest scale; shorten opening names or part labels");
  const svg = svgOpen() + titleBlock(loaded.project, "Case, three views", scaleText(r.S), unverifiedNotes(loaded)) + r.art + `</svg>`;
  return { svg, scale: r.S, overall: { width: W, depth: D, height: Ht, body: L.outer.h, lid: L.lidThickness }, checks };
}


// ---------------------------------------------------------------------------
// Fit check, 1:1
// ---------------------------------------------------------------------------

/** First sentence of a part's `verify` note, kept to one short paragraph. */
export function firstSentence(text: string | undefined, max = 150): string {
  if (!text) return "No verify note in the part file: measure the part before you print.";
  const one = text.split(/(?<=[.!?])\s+/)[0] ?? text;
  return one.length > max ? `${one.slice(0, max - 1).trimEnd()}…` : one;
}

/**
 * Every distinct part of the project in plan at exactly true size, on A4 pages that are 297 by
 * 210 user units wide and tall, one unit one millimetre, with a 100 mm ruler to check the print.
 * Lay a real part on its outline: if the edges, holes or pin order differ, the part file is wrong.
 */
export function buildFitCheck(loaded: Loaded): string[] {
  return buildFitCheckSheets(loaded).pages;
}

export function buildFitCheckSheets(loaded: Loaded): { pages: string[]; checks: string[] } {
  warnUnresolvedGeometry(loaded, "1:1 physical fit checks");
  const groups = new Map<string, { part: PlacedPart; refs: string[] }>();
  for (const p of loaded.placed) {
    const g = groups.get(p.def.id);
    if (g) g.refs.push(p.use.ref);
    else groups.set(p.def.id, { part: { ...p, at: { x: 0, y: 0, z: 0, rot: 0 } }, refs: [p.use.ref] });
  }
  interface Cell {
    markup: (x: number, y: number, sheet: Sheet) => string;
    w: number;
    h: number;
  }
  const cells: Cell[] = [];
  for (const { part, refs } of groups.values()) {
    const fp = flatPart(part);
    const pins = pinLabels(fp, () => 1, 2);
    const sentence = firstSentence(part.def.verify);
    const noteW = Math.max(fp.rect.w, 58);
    const noteLines = wrap(`${sentence} [${part.def.confidence}]`, noteW, 2.6);
    const title = `${part.def.name}`;
    const sub = `${refs.join(", ")}   ${fmt(part.def.body.w)} × ${fmt(part.def.body.d)} mm`;
    // Everything the part draws counts: names outside the outline, and the connectors and antennas that stand out past it.
    const outside = pins.filter((l) => !l.inside).map((l) => l.box);
    const over = overhangingShapes(fp);
    const pad = 3;
    const ext = [...outside, ...over].reduce(unionBox, rectBox(fp.rect));
    const top = 9.5;
    const extH = ext.y1 - ext.y0;
    const w = Math.max(noteW, ext.x1 - ext.x0, textWidth(title, 3.2)) + 2 * pad;
    const h = top + extH + 2 + noteLines.length * 3.4 + 4;
    const moves = `the part file of ${part.def.id}`;
    cells.push({
      w,
      h,
      markup: (x, y, sheet) => {
        const dx = x + pad - ext.x0;
        const dy = y + top - ext.y0;
        const shift = (b: Box): Box => ({ x0: b.x0 + dx, y0: b.y0 + dy, x1: b.x1 + dx, y1: b.y1 + dy });
        sheet.add({ id: `${part.def.id} outline`, kind: "outline", box: shift(rectBox(fp.rect)), moves });
        for (const b of over) sheet.add({ id: `${part.def.id} component outline`, kind: "solid", box: shift(b), moves });
        for (const l of pins.filter((q) => !q.inside)) sheet.add({ id: `${part.def.id} pin ${l.pad}`, kind: "text", box: shift(l.box), moves });
        sheet.add({ id: `${part.def.id} title`, kind: "text", box: textBox(x + pad, y + 3.4, title, 3.2, "start", true), moves });
        sheet.add({ id: `${part.def.id} size`, kind: "text", box: textBox(x + pad, y + 7, sub, 2.6), moves });
        noteLines.forEach((t, i) => sheet.add({ id: `${part.def.id} note`, kind: "text", box: textBox(x + pad, y + top + extH + 4 + i * 3.4, t, 2.6), moves }));
        return (
          `<g class="fit-part" data-part="${esc(part.def.id)}" transform="translate(${f(dx)} ${f(dy)})">` +
          `${partBody(fp)}${partPads(fp)}${pins.map(pinLabelMarkup).join("")}</g>` +
          `<text x="${f(x + pad)}" y="${f(y + 3.4)}" font-size="3.2" class="th">${esc(title)}</text>` +
          `<text x="${f(x + pad)}" y="${f(y + 7)}" font-size="2.6" class="small">${esc(sub)}</text>` +
          noteLines.map((t, i) => `<text x="${f(x + pad)}" y="${f(y + top + extH + 4 + i * 3.4)}" font-size="2.6" class="small">${esc(t)}</text>`).join("")
        );
      },
    });
  }

  const pages: string[] = [];
  const checks: string[] = [];
  const top0 = 62;
  const bottom = PAGE.bottom - 2;
  const header = (n: number, sheet: Sheet): string => {
    const r0 = PAGE.margin;
    let ruler = `<g class="ruler" data-length="100"><line x1="${r0}" y1="43" x2="${r0 + 100}" y2="43" stroke="#111" stroke-width="0.35"/>`;
    for (let i = 0; i <= 100; i += 5) {
      ruler += `<line x1="${r0 + i}" y1="43" x2="${r0 + i}" y2="${i % 10 === 0 ? 39.5 : 41}" stroke="#111" stroke-width="0.25"/>`;
      if (i % 10 === 0) {
        ruler += `<text x="${r0 + i}" y="38.4" font-size="2.4" text-anchor="middle">${i}</text>`;
        sheet.add({ id: `ruler ${i}`, kind: "text", box: textBox(r0 + i, 38.4, String(i), 2.4, "middle"), moves: "the fit-check header" });
      }
    }
    ruler += `<text x="${r0}" y="47.5" font-size="2.6" class="small">100 mm. Measure this line on the paper: it must read exactly 100 mm.</text></g>`;
    sheet.add({ id: "ruler caption", kind: "text", box: textBox(r0, 47.5, "100 mm. Measure this line on the paper: it must read exactly 100 mm.", 2.6), moves: "the fit-check header" });
    const lines = [
      "Print at 100 % (not “fit to page”). Check the ruler before you trust the page.",
      "Lay each real part on its outline. If the edges, holes or pin order do not match,",
      "the part file is wrong for this part, and the case and guide will be too.",
    ];
    lines.forEach((t, i) => sheet.add({ id: `print note ${i + 1}`, kind: "text", box: textBox(130, 37 + i * 4.4, t, 2.9, "start", i === 0), moves: "the fit-check header" }));
    const text = lines.map((t, i) => `<text x="130" y="${f(37 + i * 4.4)}" font-size="2.9" class="${i ? "small" : "th"}">${esc(t)}</text>`).join("");
    const markText = `Thin boxes and circles inside a part: its tall components.${n > 1 ? `   Page ${n}` : ""}`;
    sheet.add({ id: "legend note", kind: "text", box: textBox(PAGE.margin, 52.5, markText, 2.6), moves: "the fit-check header" });
    const mark = `<text x="${PAGE.margin}" y="52.5" font-size="2.6" class="small">${esc(markText)}</text>`;
    return svgOpen() + titleBlock(loaded.project, "Fit check, 1:1", "1 : 1", unverifiedNotes(loaded)) + ruler + text + mark;
  };
  let x = PAGE.margin;
  let y = top0;
  let rowH = 0;
  let sheet = new Sheet();
  let svg = header(1, sheet);
  const close = (): void => {
    pages.push(svg + `</svg>`);
    checks.push(...checkSheet(sheet, pages.length > 1 ? `fitcheck-${pages.length}.svg` : "fitcheck.svg"));
  };
  const sorted = [...cells].sort((a, b) => b.h - a.h);
  for (const c of sorted) {
    if (x + c.w > PAGE.w - PAGE.margin && x > PAGE.margin) {
      x = PAGE.margin;
      y += rowH + 4;
      rowH = 0;
    }
    if (y + c.h > bottom && y > top0) {
      close();
      sheet = new Sheet();
      svg = header(pages.length + 1, sheet);
      x = PAGE.margin;
      y = top0;
      rowH = 0;
    }
    svg += c.markup(x, y, sheet);
    x += c.w + 4;
    rowH = Math.max(rowH, c.h);
  }
  close();
  return { pages, checks };
}


// ---------------------------------------------------------------------------
// Document
// ---------------------------------------------------------------------------

const CSS = `
@import url("https://fonts.googleapis.com/css2?family=Noto+Sans:wght@400;600;800&display=swap");
*{box-sizing:border-box}html{background:#e9e9e6}
body{margin:0;font-family:"Noto Sans","Helvetica Neue",Arial,sans-serif;color:#111}
.page{width:297mm;height:210mm;margin:8mm auto;background:#fff;position:relative;overflow:hidden;box-shadow:0 1mm 6mm rgba(0,0,0,.12)}
.page svg{display:block;width:297mm;height:210mm}
.page footer{position:absolute;left:12mm;right:12mm;bottom:8mm;display:flex;justify-content:space-between;font-size:8pt}
.page footer span:first-child{font-weight:800;font-size:10pt}
@page{size:A4 landscape;margin:0}
@media print{html{background:#fff}.page{margin:0;box-shadow:none;break-after:page}}
@media screen and (max-width:300mm){.page{width:100%;height:auto}.page svg{width:100%;height:auto}}
`;

export interface DrawingSet {
  wiring: WiringModel;
  enclosure: EnclosureDrawing | null;
  pinmap: string;
  /** Fit-check pages; the first is fitcheck.svg. */
  fitcheck: string[];
  /** Every check line of every sheet, as main prints them. */
  checks: string[];
  html: string;
}

export function buildDrawings(loaded: Loaded): DrawingSet {
  warnUnresolvedGeometry(loaded, "physical drawings, pin maps and 1:1 fit checks");
  const wiring = buildWiring(loaded);
  const enclosure = loaded.project.enclosure ? buildEnclosure(loaded) : null;
  const pinmap = pinmapSvg(loaded);
  const fit = buildFitCheckSheets(loaded);
  const fitcheck = fit.pages;
  const code = `${loaded.project.slug.toUpperCase()}-${loaded.project.build.path.toUpperCase()}-1`;
  const pages = [...wiring.sheets.map((s) => s.svg), ...wiring.legendPages, ...(enclosure ? [enclosure.svg] : []), pinmap, ...fitcheck];
  const html =
    `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">` +
    `<title>${esc(loaded.project.name)} drawings</title><style>${CSS}</style></head><body>` +
    pages.map((svg, i) => `<section class="page">${svg}<footer><span>${i + 1}</span><span>${esc(code)}</span></footer></section>`).join("") +
    // index.html?only=2 shows page 2 alone, which is how shoot.ts captures one page per image.
    `<script>{const o=new URLSearchParams(location.search).get("only");if(o)document.querySelectorAll(".page").forEach((p,i)=>{if(String(i+1)!==o)p.remove()})}</script>` +
    `</body></html>`;
  return { wiring, enclosure, pinmap, fitcheck, checks: [...wiring.checks, ...(enclosure?.checks ?? []), ...fit.checks], html };
}

/**
 * Where each part stands in the wiring plan, in the coordinates `plan` takes: mm of the object,
 * x to the right, y down the page. `x` and `rot` are what a part's `plan` pins; `y` is printed
 * for reading the picture and is ignored on input.
 */
export function debugLines(loaded: Loaded, w: WiringModel): string[] {
  const out = [`wiring plan: ${w.sheets.length} sheet${w.sheets.length > 1 ? "s" : ""}, legend ${w.legendSheet ? `on ${w.legendPages.length} sheet${w.legendPages.length > 1 ? "s" : ""} of its own` : "under the plan"}`];
  const ctrl = pickController(loaded).use.ref;
  w.sheets.forEach((sh, n) => {
    out.push(`sheet ${n + 1}: scale ${scaleText(sh.scale)}, ${sh.parts.length} parts, ${sh.lanes.length} lanes`);
    for (const p of sh.parts) {
      const pinned = loaded.byRef.get(p.ref)?.use.plan;
      const r = p.rect;
      // A part drawn larger than the rest has its size grown, so its x and rot are what a plan override pins, its size is not the real one.
      const real = loaded.byRef.get(p.ref)?.def.body;
      const zoom = real && r.w * r.d > 0 ? Math.sqrt((r.w * r.d) / (real.w * real.d)) : 1;
      out.push(
        `  ${p.ref.padEnd(8)} ${p.placed.def.id.padEnd(28)} ${p.ref === ctrl ? "controller" : "row part "}  x=${fmt(r.x)} y=${fmt(r.y)} rot=${p.placed.at.rot}  size ${fmt(r.w)} x ${fmt(r.d)}${zoom > 1.02 ? ` (drawn ${fmt(zoom * sh.scale)} : 1)` : ""}  ->  "plan": { "x": ${fmt(r.x)}, "y": 0, "rot": ${p.placed.at.rot} }${pinned ? "  (pinned by project.json)" : ""}`,
      );
    }
  });
  return out;
}

if (import.meta.main) {
  await main(async () => {
    const dir = process.argv[2];
    if (!dir) {
      console.error("usage: bun drawing.ts <projectDir>");
      process.exit(2);
    }
    const loaded = await loadProject(dir);
    const out = join(loaded.dir, "out", "drawings");
    await mkdir(out, { recursive: true });
    const set = buildDrawings(loaded);
    const files: [string, string][] = set.wiring.sheets.map((s, i): [string, string] => [i ? `wiring-${i + 1}.svg` : "wiring.svg", s.svg]);
    set.wiring.legendPages.forEach((svg, i) => files.push([i ? `wiring-legend-${i + 1}.svg` : "wiring-legend.svg", svg]));
    if (set.enclosure) files.push(["enclosure.svg", set.enclosure.svg]);
    files.push(["pinmap.svg", set.pinmap]);
    set.fitcheck.forEach((svg, i) => files.push([i ? `fitcheck-${i + 1}.svg` : "fitcheck.svg", svg]));
    files.push(["index.html", set.html]);
    for (const [name, text] of files) {
      await Bun.write(join(out, name), text);
      console.log(join(out, name));
    }
    for (const c of set.checks) console.warn(`check: ${c}`);
    if (process.argv.includes("--debug")) for (const line of debugLines(loaded, set.wiring)) console.log(line);
  });
}
