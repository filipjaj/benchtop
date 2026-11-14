// Carrier-PCB layout: where each module and component sits on the board.
//
// Pure geometry, no I/O. Board coordinates: origin at the top-left corner seen from
// above, x right, y down, millimetres, the same frame as a part's own pin coordinates,
// so a placed part's pin lands at (at.x, at.y) + rotPoint(pin.x, pin.y, ...).
//
// Method: the controller board goes first with its USB end overhanging the y = 0 edge,
// parts that attach by wire get a pad row along the bottom edge, everything else is
// packed bottom-left-first with a fixed courtyard gap. The board size is searched over
// whole millimetres (smallest area that fits), with the four mounting holes in the
// corners and a keep-out around each.

import { rotPoint } from "./iso";
import type { Loaded } from "./project";
import type { PartDef, PinDef, PlacedPart } from "./types";

export interface PcbLayout {
  board: { w: number; d: number; t: number };
  /** Every part on the board, `at` in board coordinates with z = board.t. */
  parts: PlacedPart[];
  /** Four M3 mounting holes (clearance diameter). */
  holes: { x: number; y: number; dia: number }[];
  warnings: string[];
}

type Rot = 0 | 90 | 180 | 270;

export const BOARD_T = 1.6;
/** Gap between two part outlines. */
export const COURTYARD_GAP = 3;
/** Distance from a part outline to the board edge. */
export const EDGE_MARGIN = 1.5;
export const HOLE_DIA = 3.2;
/** Mounting hole centre to board edge. */
export const HOLE_INSET = 3.5;
/** Free space from the edge of a mounting hole to any part outline. */
export const HOLE_FREE = 4;
/** Longest the controller's USB end may stick out past the y = 0 edge. */
export const MAX_OVERHANG = 1.5;
/** Pitch of the pads that stand in for a wired part. */
export const WIRE_PAD_PITCH = 2.54;

interface Rect {
  x: number;
  y: number;
  w: number;
  d: number;
}

interface Item {
  use: PlacedPart["use"];
  def: PartDef;
  rot: Rot;
  w: number;
  d: number;
  role: "controller" | "wire" | "normal";
  /** Distance the outline sticks out past the top edge (controller only). */
  overhang: number;
}

const rotated = (def: PartDef, rot: Rot): { w: number; d: number } =>
  rot === 90 || rot === 270 ? { w: def.body.d, d: def.body.w } : { w: def.body.w, d: def.body.d };

/** Rotation that turns a part-local face direction toward -y (the top edge of the board). */
function rotToTop(face: "x-" | "x+" | "y-" | "y+" | "up"): Rot | undefined {
  switch (face) {
    case "y-":
      return 0;
    case "x-":
      return 90;
    case "y+":
      return 180;
    case "x+":
      return 270;
    default:
      return undefined;
  }
}

/** A row of plain pads standing in for a part that is wired to the board, not mounted on it. */
function wirePadDef(def: PartDef, pins: PinDef[]): PartDef {
  const n = pins.length;
  return {
    ...def,
    id: `${def.id}-wirepads`,
    name: `${def.name} (wire pads)`,
    body: { w: n * WIRE_PAD_PITCH, d: 3.4, h: 0.2 },
    maxHeight: 0.2,
    shapes: [],
    decals: [],
    holes: [],
    ports: [],
    pins: pins.map((p, i) => ({ ...p, x: WIRE_PAD_PITCH / 2 + i * WIRE_PAD_PITCH, y: 1.7 })),
    footprint: { mount: "tht", pitch: WIRE_PAD_PITCH },
  };
}

const rectGap = (a: Rect, b: Rect): boolean =>
  a.x + a.w + COURTYARD_GAP <= b.x ||
  b.x + b.w + COURTYARD_GAP <= a.x ||
  a.y + a.d + COURTYARD_GAP <= b.y ||
  b.y + b.d + COURTYARD_GAP <= a.y;

/** Shortest distance from a point to a rectangle (0 when inside). */
export function distToRect(px: number, py: number, r: Rect): number {
  const dx = Math.max(r.x - px, 0, px - (r.x + r.w));
  const dy = Math.max(r.y - py, 0, py - (r.y + r.d));
  return Math.hypot(dx, dy);
}

/** lo, lo + 1, ... up to hi, always ending on hi so a tight fit is still found. */
function steps(lo: number, hi: number): number[] {
  if (hi < lo - 1e-9) return [];
  const out: number[] = [];
  for (let v = lo; v <= hi + 1e-9; v += 1) out.push(v);
  if (hi - out[out.length - 1]! > 1e-9) out.push(hi);
  return out;
}

function holePositions(W: number, D: number): { x: number; y: number; dia: number }[] {
  return [
    { x: HOLE_INSET, y: HOLE_INSET },
    { x: W - HOLE_INSET, y: HOLE_INSET },
    { x: HOLE_INSET, y: D - HOLE_INSET },
    { x: W - HOLE_INSET, y: D - HOLE_INSET },
  ].map((h) => ({ ...h, dia: HOLE_DIA }));
}

function pack(items: Item[], W: number, D: number): Rect[] | null {
  const holes = holePositions(W, D);
  const free = HOLE_DIA / 2 + HOLE_FREE;
  const placed: Rect[] = [];
  for (const it of items) {
    const xs = steps(EDGE_MARGIN, W - EDGE_MARGIN - it.w);
    let ys: number[];
    if (it.role === "controller") ys = [-it.overhang];
    else if (it.role === "wire") ys = steps(EDGE_MARGIN, D - EDGE_MARGIN - it.d).reverse();
    else ys = steps(EDGE_MARGIN, D - EDGE_MARGIN - it.d);
    if (it.role === "controller" && -it.overhang + it.d > D - EDGE_MARGIN) return null;
    let hit: Rect | undefined;
    search: for (const y of ys) {
      for (const x of xs) {
        const r: Rect = { x, y, w: it.w, d: it.d };
        if (holes.some((h) => distToRect(h.x, h.y, r) < free)) continue;
        if (!placed.every((p) => rectGap(p, r))) continue;
        hit = r;
        break search;
      }
    }
    if (!hit) return null;
    placed.push(hit);
  }
  return placed;
}

export function layoutPcb(loaded: Loaded): PcbLayout {
  const warnings: string[] = [];
  const usedPins = new Map<string, Set<string>>();
  for (const net of loaded.nets) {
    for (const np of net.pins) {
      if (!usedPins.has(np.ref)) usedPins.set(np.ref, new Set());
      usedPins.get(np.ref)!.add(np.pin.name);
    }
  }

  const items: Item[] = [];
  let controllerTaken = false;
  for (const p of loaded.placed) {
    const mount = p.def.footprint?.mount;
    if (mount === undefined || mount === "wire" || mount === "none") {
      const names = usedPins.get(p.use.ref);
      const pins = p.def.pins.filter((q) => (names ? names.has(q.name) : false));
      const why = mount === undefined ? "has no footprint" : `is mounted by "${mount}"`;
      if (pins.length === 0) {
        warnings.push(`${p.use.ref} (${p.def.id}) ${why} and has no connections: left off the board.`);
        continue;
      }
      const def = wirePadDef(p.def, pins);
      warnings.push(
        `${p.use.ref} (${p.def.id}) ${why}: left off the board, ${pins.length} wire pads (${pins.map((q) => q.name).join(", ")}) at the bottom edge instead. Solder its leads to them.`,
      );
      items.push({ use: p.use, def, rot: 0, ...rotated(def, 0), role: "wire", overhang: 0 });
      continue;
    }
    if (mount === "smd") {
      warnings.push(
        `${p.use.ref} (${p.def.id}) is surface-mount: drawn with through-hole pads at its pin positions. Check the footprint in board.tsx before ordering.`,
      );
    }
    let rot: Rot = 0;
    let overhang = 0;
    let role: Item["role"] = "normal";
    if (p.def.kind === "board" && !controllerTaken) {
      controllerTaken = true;
      role = "controller";
      const usb = p.def.ports?.find((q) => /usb/i.test(q.name));
      const turn = usb ? rotToTop(usb.faces) : undefined;
      if (usb && turn === undefined) {
        warnings.push(`${p.use.ref}: the USB port faces up, so the board cannot overhang an edge; placed inside the outline.`);
      } else if (usb && turn !== undefined) {
        rot = turn;
        const { w, d } = p.def.body;
        // Keep every pad at least 1.5 mm inside the board edge, whatever the overhang.
        const nearest = Math.min(...p.def.pins.map((q) => rotPoint(q.x, q.y, w, d, rot)[1]));
        overhang = Math.max(0, Math.min(MAX_OVERHANG, nearest - 1.5));
        if (overhang < 0.5) {
          warnings.push(
            `${p.use.ref}: the pads sit too close to the USB end for it to overhang the board edge (${overhang.toFixed(1)} mm). Check the cable still fits.`,
          );
        }
      } else if (!usb) {
        warnings.push(`${p.use.ref}: no USB port in its definition, so no overhang; placed against the top edge.`);
      }
    }
    items.push({ use: p.use, def: p.def, rot, ...rotated(p.def, rot), role, overhang });
  }

  if (items.length === 0) {
    warnings.push("No parts to place: the board is the minimum size.");
  }

  // Order: controller, wire pads, then the rest largest first.
  const rank = (i: Item): number => (i.role === "controller" ? 0 : i.role === "wire" ? 1 : 2);
  items.sort((a, b) => rank(a) - rank(b) || b.w * b.d - a.w * a.d);

  const gapArea = items.reduce((s, i) => s + (i.w + COURTYARD_GAP) * (i.d + COURTYARD_GAP), 0);
  const maxW = items.reduce((m, i) => Math.max(m, i.w), 0);
  const maxD = items.reduce((m, i) => Math.max(m, i.d - i.overhang), 0);
  const sumD = items.reduce((s, i) => s + i.d + COURTYARD_GAP, 0);
  const sumW = items.reduce((s, i) => s + i.w + COURTYARD_GAP, 0);
  const wLo = Math.max(Math.ceil(maxW + 2 * EDGE_MARGIN), 20);
  const dLo = Math.max(Math.ceil(maxD + 2 * EDGE_MARGIN), 20);
  // Upper bounds leave room for a hole keep-out in each corner on top of a single row or column.
  const corner = 2 * (HOLE_INSET + HOLE_DIA / 2 + HOLE_FREE);
  const wHi = Math.max(wLo, Math.min(300, Math.ceil(sumW + 2 * EDGE_MARGIN + corner)));
  const dHi = Math.max(dLo, Math.min(300, Math.ceil(sumD + 2 * EDGE_MARGIN + corner)));
  const wStep = Math.max(1, Math.ceil((wHi - wLo) / 24));

  // Smallest area wins, but a board longer than 1.6:1 is charged for the excess: a long strip
  // is awkward to enclose and to hold while soldering.
  const score = (W: number, D: number): number => W * D * Math.max(1, Math.max(W, D) / Math.min(W, D) / 1.6);
  let best: { W: number; D: number; rects: Rect[]; score: number } | undefined;
  for (let W = wLo; W <= wHi; W += wStep) {
    for (let D = Math.max(dLo, Math.floor((gapArea * 0.6) / W)); D <= dHi; D += 1) {
      if (best && W * D >= best.score) break;
      const rects = pack(items, W, D);
      if (rects) {
        const s = score(W, D);
        if (!best || s < best.score) best = { W, D, rects, score: s };
        break;
      }
    }
  }
  if (!best) {
    throw new Error("pcb layout: could not fit the parts on a board up to 300 mm. Check the part dimensions.");
  }

  const parts: PlacedPart[] = items.map((it, i) => ({
    use: it.use,
    def: it.def,
    at: { x: best!.rects[i]!.x, y: best!.rects[i]!.y, z: BOARD_T, rot: it.rot },
  }));
  return {
    board: { w: best.W, d: best.D, t: BOARD_T },
    parts,
    holes: holePositions(best.W, best.D),
    warnings,
  };
}
