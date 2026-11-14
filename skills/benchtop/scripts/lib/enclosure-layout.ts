// Enclosure layout: where every part sits inside the case, where the standoffs,
// screw bosses and openings go, which fasteners it takes, and what does not fit.
//
// Pure function, no CAD dependency. scripts/enclosure.ts turns the result into solids
// and the assembly guide reads it to draw the case, so both always agree.
//
// Coordinates: world origin is the outer corner of the body at minimum x and y, z = 0
// on the outside bottom. The inner cavity corner is at (wall, wall, floor). Mount
// positions in project.json are relative to that cavity corner.
//
// Parts keep the orientation they have in iso.ts: component side up. A part mounted
// "on the lid" is therefore not flipped. It hangs just under the lid with its
// components (display glass, button cap) pointing up at the lid, which is also how it
// sits in the finished case.

import { footprint, rotPoint } from "./iso";
import { ProjectError, type Loaded } from "./project";
import type { CapSpec, CustomOpening, EnclosureSpec, PartDef, PlacedMount, PlacedPart, PortDef, Shape } from "./types";

/** A printed cap over a button's stem. Outer (world) coordinates, like the openings. */
export interface Cap {
  ref: string;
  shape: "round" | "rect";
  /** Centre of the cap, which is the centre of the stem. */
  x: number;
  y: number;
  /** Visible size along x and along y. Equal for a round cap. */
  w: number;
  h: number;
  /** Footprint of the flange under the lid, centred on the cap. */
  fw: number;
  fh: number;
  /** Underside of the cap, top of its flange, and top of the cap. */
  z0: number;
  zFlange: number;
  zTop: number;
  /** The blind hole the stem sits in: its diameter, and the height it ends at (the stem's tip). */
  bore: number;
  zBore: number;
  color?: string;
}

/** A post from the floor that a capped part stands on, between its legs, with lips that locate it. */
export interface Seat {
  ref: string;
  /** Footprint of the post, lips included. */
  x0: number;
  x1: number;
  y0: number;
  y1: number;
  /** Top of the post: the top of the lips, or the seat itself when it has none. */
  zTop: number;
  /** Height the part's underside rests at. */
  z: number;
  /** The part's outline plus clearance, cut out of the post above `z`. Absent when the post has no lips. */
  pocket?: { x0: number; x1: number; y0: number; y1: number };
}

export interface Standoff {
  x: number;
  y: number;
  h: number;
  dia: number;
  hole: number;
  from: "floor" | "lid";
}

export interface Opening {
  ref: string;
  port: string;
  face: "x-" | "x+" | "y-" | "y+" | "lid";
  // OUTER coordinates (the wall included), unlike mounts, which count from the inner corner. u, v are the opening's centre.
  // Side faces: u runs along the wall from the outer corner at minimum x or y, v is height above the outer bottom.
  // Lid: u = world x, v = world y.
  u: number;
  v: number;
  w: number;
  h: number;
  shape: "rect" | "round";
}

/** One line of the fastener list. print.md, the guide and the BOM all read this. */
export interface HardwareLine {
  /** Form "M3 x 10 mm countersunk screw". */
  name: string;
  qty: number;
  use: string;
}

export interface EnclosureLayout {
  inner: { w: number; d: number; h: number };
  outer: { w: number; d: number; h: number }; // body including floor, excluding lid
  wall: number;
  floor: number;
  lidThickness: number;
  lipHeight: number;
  fit: number;
  radius: number;
  parts: PlacedPart[]; // every mounted part with `at` in world coordinates, ready for iso.partSolids
  standoffs: Standoff[];
  /** Posts for the parts that carry a printed cap. Empty when no mount has a `cap`. */
  seats: Seat[];
  /** The printed caps, one per capped mount. */
  caps: Cap[];
  openings: Opening[];
  screws: { x: number; y: number; dia: number }[]; // lid screw positions
  /** Every fastener the printed geometry takes, computed from the real hole depths. */
  hardware: HardwareLine[];
  warnings: string[];
}

/** Fixed design values shared with enclosure-solids.ts. */
export const DESIGN = {
  lidThickness: 2.4,
  lipHeight: 2,
  lipThickness: 1.2,
  /** Diameter of the corner screw bosses. */
  bossDia: 6,
  /** Nominal screw size for the lid (M3). */
  screwDia: 3,
  /** Pilot hole in the corner bosses for an M3 self-tapping screw. */
  bossPilot: 2.5,
  /** Deepest pilot hole drilled into a corner boss. */
  bossPilotMax: 12,
  /** Free height between the tallest floor part and a lid part above it, for wires. */
  wiringSpace: 6,
  /** Default height of a standoff under a floor part. */
  standoffHeight: 3,
  /** Pilot hole for an M2 self-tapping screw. */
  pilotHole: 2,
  /** Room above a pin for a push-on jumper lead's plastic housing standing on it. */
  dupontClearance: 14,
  /** Wall left above the top edge of any wall opening. */
  openingHeadroom: 2,
  /** A reach part's stem ends at least this far proud of the lid's outer surface. */
  reachProud: 0.5,
  /** Plate left above the end of a hanging post's pilot hole. */
  lidSkin: 0.8,
  /** Air vents stay at least this far from a controller board, in plan. */
  ventDistance: 5,
  /** Printed caps: clearance to the lid opening on every side. */
  capClear: 0.25,
  /** Plastic over the tip of the stem. With reachProud this is how far a cap stands above the lid. */
  capTop: 1.2,
  /** The flange that keeps a cap in: how far it reaches past the cap, and how thick it is. */
  capFlange: 1.2,
  capFlangeT: 1.2,
  /** A rect cap has its flange on the two ends of its long axis; along the sides it is only this wide. */
  capFlangeSide: 0.3,
  /** Gap between the flange and the lid at rest, so a tall print or a tall switch does not hold the button down. */
  capFlangeGap: 0.8,
  /** Room kept under the flange for the button's travel and the same tolerances. */
  capTravel: 0.7,
  /** The hole for the stem is this much wider than the stem. */
  capBore: 0.4,
  /** Least plastic around that hole. */
  capWall: 1,
  /** Chamfer round the top edge of a cap. */
  capChamfer: 0.5,
  /** Lips that locate a capped part on its post: height, thickness, and clearance to the part. */
  seatLip: 1.2,
  seatLipT: 1.4,
  seatFit: 0.15,
  /** A post stays this far from the part's legs. */
  seatLegClear: 1.1,
} as const;

const SCREW_LENGTHS = [3, 4, 5, 6, 8, 10, 12, 16, 20];

/**
 * Height of the finished case with the lid seated: the body (`outer.h`, floor included)
 * plus the lid plate. This is the one "closed height"; `outer.h` alone is the body, and the
 * lid as printed is taller still because its posts and lip hang below the plate.
 */
export function closedHeight(L: Pick<EnclosureLayout, "outer" | "lidThickness">): number {
  return Math.round((L.outer.h + L.lidThickness) * 100) / 100;
}

/** The hardware list as markdown bullets, exactly as print.md shows it. */
export function hardwareLines(L: Pick<EnclosureLayout, "hardware">): string[] {
  if (!L.hardware.length) return ["- none"];
  return L.hardware.map((h) => `- ${h.qty} x ${h.name}: ${h.use}`);
}

/** Depth of the pilot hole in a standoff, from its free end. Shared with enclosure-solids.ts. */
export function pilotDepth(s: Standoff, floor: number, lidThickness: number): number {
  return s.from === "floor" ? s.h + floor / 2 : s.h + lidThickness - DESIGN.lidSkin;
}

type Rot = 0 | 90 | 180 | 270;
type Dir = "x-" | "x+" | "y-" | "y+";
type Mount = PlacedMount;

interface Rect {
  x: number;
  y: number;
  w: number;
  d: number;
  board?: boolean;
}

interface Reach {
  port: PortDef;
  /** Top of the part under the port, mm above the part's bottom. */
  stemTop: number;
  /** Top of everything else, which cannot pass through the lid. */
  bodyTop: number;
}

interface Item {
  m: Mount;
  placed: PlacedPart;
  on: "floor" | "lid";
  rot: Rot;
  w: number;
  d: number;
  auto: boolean;
  /** Position in cavity coordinates (origin at the inner front-left corner). */
  ix: number;
  iy: number;
  standoffH: number;
  vented: boolean;
  reach?: Reach;
  /** Set on a floor part that carries a printed cap: it stands on a tall post and its stem reaches through the lid. */
  cap?: CapSpec;
}

// Where a part-local direction points after the part is turned by rot (seen from above).
const ROT_DIR: Record<Rot, Record<Dir, Dir>> = {
  0: { "x-": "x-", "x+": "x+", "y-": "y-", "y+": "y+" },
  90: { "x+": "y+", "y+": "x-", "x-": "y-", "y-": "x+" },
  180: { "x+": "x-", "x-": "x+", "y+": "y-", "y-": "y+" },
  270: { "x+": "y-", "y+": "x+", "x-": "y+", "y-": "x-" },
};
// Rotation that makes a part-local direction face world y-.
const ROT_FOR_YMINUS: Record<Dir, Rot> = { "y-": 0, "x-": 90, "y+": 180, "x+": 270 };

const overlaps = (a: Rect, b: Rect, gap = 0): boolean =>
  a.x < b.x + b.w + gap && b.x < a.x + a.w + gap && a.y < b.y + b.d + gap && b.y < a.y + a.d + gap;
/** Distance between two rectangles in plan; 0 when they touch or overlap. */
const planDistance = (a: Rect, b: Rect): number =>
  Math.hypot(Math.max(a.x - b.x - b.w, b.x - a.x - a.w, 0), Math.max(a.y - b.y - b.d, b.y - a.y - a.d, 0));

const ceil10 = (n: number): number => Math.ceil(n * 10 - 1e-9) / 10;
const mm = (n: number): string => `${Math.round(n * 10) / 10} mm`;
const label = (p: PlacedPart): string => `${p.use.ref} (${p.def.name})`;
const rectOf = (it: Item): Rect => ({ x: it.ix, y: it.iy, w: it.w, d: it.d, board: it.placed.def.kind === "board" });

function sidePort(def: PartDef): PortDef | undefined {
  return def.ports?.find((p) => p.faces !== "up");
}

const isVent = (p: PortDef): boolean => /\bvent\b/i.test(p.name);
const isCustom = (o: object): o is CustomOpening => "face" in o;

function shapeTop(def: PartDef, sh: Shape): number {
  return def.body.h + (sh.z ?? 0) + sh.h;
}
function shapeContains(sh: Shape, x: number, y: number): boolean {
  if (sh.kind === "box") return x >= sh.x && x <= sh.x + sh.w && y >= sh.y && y <= sh.y + sh.d;
  return Math.hypot(x - sh.x, y - sh.y) <= sh.r;
}
/** The first up-facing port that something has to reach through, with the heights around it. */
function reachOf(def: PartDef): Reach | undefined {
  const port = def.ports?.find((p) => p.reach && p.faces === "up");
  if (!port) return undefined;
  const under = (def.shapes ?? []).filter((s) => shapeContains(s, port.x, port.y));
  const others = (def.shapes ?? []).filter((s) => !shapeContains(s, port.x, port.y));
  const bodyTop = Math.max(def.body.h, ...others.map((s) => shapeTop(def, s)));
  const stemTop = under.length ? Math.max(...under.map((s) => shapeTop(def, s))) : def.maxHeight;
  return { port, stemTop: Math.max(stemTop, bodyTop), bodyTop };
}

/** Local positions (after rotation) of four posts under a board without mounting holes, kept off the pins. */
function clearPosts(def: PartDef, rot: Rot, w: number, d: number, dia: number): [number, number][] {
  const o = dia / 2;
  const pins = def.pins.map((p) => rotPoint(p.x, p.y, def.body.w, def.body.d, rot));
  const clear = (x: number, y: number): boolean => pins.every(([px, py]) => Math.hypot(px - x, py - y) >= o + 1.4);
  const out: [number, number][] = [];
  for (const [qx, qy] of [
    [0, 0],
    [1, 0],
    [0, 1],
    [1, 1],
  ] as const) {
    const cx = qx ? w - o : o;
    const cy = qy ? d - o : o;
    let best: [number, number] | undefined;
    let bestDist = Infinity;
    // Search the quadrant for the clear spot nearest the corner.
    for (let x = o; x <= w - o + 1e-9; x += 0.5) {
      for (let y = o; y <= d - o + 1e-9; y += 0.5) {
        if ((x > w / 2) !== !!qx || (y > d / 2) !== !!qy) continue;
        if (!clear(x, y)) continue;
        const dist = Math.hypot(x - cx, y - cy);
        if (dist < bestDist) {
          bestDist = dist;
          best = [x, y];
        }
      }
    }
    if (best) out.push(best);
  }
  return out;
}

export function layoutEnclosure(loaded: Loaded): EnclosureLayout {
  const spec = loaded.project.enclosure;
  if (!spec) throw new ProjectError(`${loaded.project.slug}: project.json has no "enclosure" section`);
  const warnings: string[] = [];
  const warn = (msg: string): void => {
    if (!warnings.includes(msg)) warnings.push(msg);
  };

  const { wall, fit, radius } = spec;
  const floor = wall;
  const lidThickness = Math.max(DESIGN.lidThickness, wall);
  const { lipHeight, lipThickness, bossDia, wiringSpace } = DESIGN;
  const gap = fit + 2; // spacing between neighbouring parts
  const screwLid = spec.lid === "screw";
  const dupont = loaded.project.build.joint === "dupont";
  // Parts keep clear of the corner bosses sideways: the screw bosses sit in the four corners.
  const sideMargin = screwLid ? bossDia + fit : fit;
  // Lid parts also clear the locating lip that runs round the inside of the walls.
  const lidMargin = 2 * fit + lipThickness;
  // How near a side wall a lid part may sit: only the bosses at the corners push it further in.
  const lidSide = Math.min(sideMargin, lidMargin);

  // ---- mounts -> items -------------------------------------------------------------
  const items: Item[] = [];
  const mountedRefs = new Set<string>();
  // Parts that hang in the wiring: accounted for, but no position, posts or openings.
  const wireRefs = new Set<string>();
  for (const m of spec.mounts) {
    const placed = loaded.byRef.get(m.ref);
    if (!placed) throw new ProjectError(`enclosure mount refers to "${m.ref}", which is not a part in this project`);
    if (mountedRefs.has(m.ref) || wireRefs.has(m.ref)) {
      warn(`${m.ref} is mounted twice in the enclosure; only the first mount is used.`);
      continue;
    }
    if (m.on === "wire") {
      wireRefs.add(m.ref);
      continue;
    }
    mountedRefs.add(m.ref);
    const auto = (m.x ?? 0) === 0 && (m.y ?? 0) === 0;
    let rot: Rot = m.rot ?? 0;
    if (auto && m.on === "floor" && m.rot === undefined) {
      const sp = sidePort(placed.def);
      if (sp) rot = ROT_FOR_YMINUS[sp.faces as Dir];
    }
    const dims = footprint({ ...placed, at: { ...placed.at, rot } });
    // A cap needs a stem to sit on, and a post from the floor to carry the part.
    let cap = m.cap;
    const capReach = cap ? reachOf(placed.def) : undefined;
    if (cap && m.on !== "floor") {
      warn(`${m.ref} has a cap but is mounted on the lid, where the lid's own posts would be in the way of the cap. Mount it on the floor ("on": "floor"): it then stands on a post and reaches the lid from below. The cap is left out.`);
      cap = undefined;
    } else if (cap && (!capReach || capReach.port.shape !== "round")) {
      warn(`${m.ref} (${placed.def.name}) has a cap but no round stem to carry one (an up-facing round port with "reach": true). The cap is left out.`);
      cap = undefined;
    }
    items.push({
      m,
      placed,
      on: m.on,
      rot,
      w: dims.w,
      d: dims.d,
      auto,
      ix: m.x ?? 0,
      iy: m.y ?? 0,
      standoffH: m.standoff ?? DESIGN.standoffHeight,
      vented: (placed.def.ports ?? []).some(isVent),
      reach: m.on === "lid" ? reachOf(placed.def) : cap ? capReach : undefined,
      cap,
    });
  }
  // Custom openings: the extraOpenings plus any entries in an explicit openings list.
  const extra: CustomOpening[] = [...(spec.extraOpenings ?? [])];
  const wantedList = spec.openings === "auto" ? undefined : spec.openings;
  if (wantedList) for (const o of wantedList) if (isCustom(o)) extra.push(o);
  // Only an opening that names the part answers its "not mounted" warning. An unrelated
  // window or vent says nothing about where this part's lead leaves.
  const hasCableExit = (ref: string): boolean => extra.some((c) => c.cableFor?.includes(ref));
  for (const use of loaded.project.parts) {
    if (!mountedRefs.has(use.ref) && !wireRefs.has(use.ref) && !hasCableExit(use.ref)) {
      warn(
        `${use.ref} (${use.label ?? use.part}) is not mounted in the case; if it sits outside on a lead, add a cable exit with extraOpenings that lists "${use.ref}" in cableFor; if it is soldered into a wire, add { "ref": "${use.ref}", "on": "wire" } to mounts.`,
      );
    }
  }

  const floorItems = items.filter((i) => i.on === "floor");
  const lidItems = items.filter((i) => i.on === "lid");
  const fixedInner = spec.inner;

  // ---- floor parts: pack in a row, side-port parts first and against the y- wall ----
  // Vented parts go last and keep ventDistance from every board, so they do not read its warmth.
  const placedRects: Rect[] = floorItems.filter((i) => !i.auto).map(rectOf);
  const autoFloor = floorItems
    .filter((i) => i.auto)
    .sort(
      (a, b) =>
        Number(a.vented) - Number(b.vented) || Number(!!sidePort(b.placed.def)) - Number(!!sidePort(a.placed.def)),
    );
  {
    let x = sideMargin;
    let y = fit;
    let rowD = 0;
    for (const it of autoFloor) {
      for (let guard = 0; guard < 1000; guard++) {
        if (fixedInner && x > sideMargin && x + it.w > fixedInner.w - sideMargin + 1e-9) {
          x = sideMargin;
          y += rowD + gap;
          rowD = 0;
          continue;
        }
        const cand: Rect = { x, y, w: it.w, d: it.d };
        const hit = placedRects.find((r) => overlaps(cand, r, gap));
        if (hit) {
          x = hit.x + hit.w + gap;
          continue;
        }
        const hot = it.vented ? placedRects.find((r) => r.board && planDistance(cand, r) < DESIGN.ventDistance + 0.05) : undefined;
        if (!hot) break;
        x = hot.x + hot.w + DESIGN.ventDistance + 0.05;
      }
      it.ix = x;
      it.iy = y;
      placedRects.push(rectOf(it));
      rowD = Math.max(rowD, it.d);
      x += it.w + gap;
    }
  }

  // ---- minimum footprint -----------------------------------------------------------
  // Floor parts, parts with a position of their own and the largest lid part set the
  // minimum. Lid parts the layout places are packed over that footprint, and it only grows
  // when they do not fit.
  let needW = sideMargin * 2;
  let needD = 2 * fit;
  for (const it of floorItems) {
    needW = Math.max(needW, it.ix + it.w + (it.auto ? sideMargin : fit));
    needD = Math.max(needD, it.iy + it.d + fit);
  }
  const autoLid = lidItems.filter((i) => i.auto);
  for (const it of lidItems) {
    needD = Math.max(needD, it.d + 2 * lidMargin);
    if (it.auto) {
      needW = Math.max(needW, it.w + 2 * lidSide);
    } else {
      needW = Math.max(needW, it.ix + it.w + lidMargin);
      needD = Math.max(needD, it.iy + it.d + lidMargin);
    }
  }

  // ---- heights ---------------------------------------------------------------------
  const reachNeed = lidThickness + DESIGN.reachProud;
  /** How far below the lid's underside a lid part reaches, including the gap to the lid. */
  const hang = (it: Item): number => {
    const def = it.placed.def;
    if (it.reach) {
      const stemLen = it.reach.stemTop - it.reach.bodyTop;
      // Tall enough: the stem stands 0.5 mm proud. Otherwise the part is pushed up until its body meets the lid.
      return stemLen >= reachNeed - 1e-9 ? it.reach.stemTop - reachNeed : it.reach.bodyTop;
    }
    return def.maxHeight + fit;
  };
  /** Top of a floor part above the cavity floor, with room for jumper leads where it has pins. */
  const floorTop = (it: Item): number =>
    // A capped part is as tall as the cavity by design: its post is cut to whatever height the cavity gets.
    it.cap ? 0 : it.standoffH + it.placed.def.maxHeight + (dupont && it.placed.def.pins.length > 0 ? DESIGN.dupontClearance : 0);
  /** How far below the lid's underside the bottom of a capped part sits: its stem ends reachProud above the lid. */
  const capDrop = (it: Item): number => it.reach!.stemTop - reachNeed;
  // Floor parts are in their final place by now; the lid search asks this many thousand times.
  const floorRects = floorItems.map((f) => ({ r: rectOf(f), top: floorTop(f) }));
  const heightNeededOver = (lid: Item, r: Rect): number => {
    let need = hang(lid) + fit;
    for (const f of floorRects) {
      if (overlaps(r, f.r)) need = Math.max(need, f.top + wiringSpace + hang(lid));
    }
    return need;
  };

  // ---- openings, part 1: which ports and custom entries make openings -------------
  const wanted = (ref: string, port: string): boolean =>
    !wantedList || wantedList.some((o) => !isCustom(o) && o.ref === ref && o.port === port);
  const margin = (port: PortDef): number => (port.margin ?? 0) + fit;
  const gapIn = (it: Item, dir: Dir, w: number, d: number): number =>
    dir === "y-" ? it.iy : dir === "y+" ? d - (it.iy + it.d) : dir === "x-" ? it.ix : w - (it.ix + it.w);
  const REACH_TO_WALL = 1.5 + fit;

  /**
   * Cavity height the parts need in a W x D cavity with the lid parts where they now are:
   * floor parts plus wiring space, lid parts over them, and every wall opening with some
   * wall left above it.
   */
  const heightNeed = (w: number, d: number): number => {
    let need = 2 * fit;
    for (const it of floorItems) need = Math.max(need, it.cap ? capDrop(it) + 1 : floorTop(it) + wiringSpace);
    for (const it of lidItems) need = Math.max(need, heightNeededOver(it, rectOf(it)));
    for (const it of floorItems) {
      for (const port of it.placed.def.ports ?? []) {
        if (port.faces === "up" || !wanted(it.placed.use.ref, port.name)) continue;
        if (gapIn(it, ROT_DIR[it.rot][port.faces], w, d) > REACH_TO_WALL) continue;
        const hh = port.shape === "round" ? Math.max(port.w, port.h) + 2 * margin(port) : port.h + 2 * margin(port);
        const v = floor + it.standoffH + it.placed.def.body.h + (port.z ?? port.h / 2);
        need = Math.max(need, v + hh / 2 + DESIGN.openingHeadroom - floor);
      }
    }
    for (const c of extra) {
      if (c.face !== "lid") need = Math.max(need, c.v + c.h / 2 + DESIGN.openingHeadroom - floor);
    }
    return need;
  };

  // ---- lid parts: pack in two dimensions over the floor footprint ------------------
  const upPortRects = floorItems.flatMap((it) =>
    (it.placed.def.ports ?? [])
      .filter((p) => p.faces === "up")
      .map((p): Rect => {
        const [px, py] = rotPoint(p.x, p.y, it.placed.def.body.w, it.placed.def.body.d, it.rot);
        const swap = it.rot === 90 || it.rot === 270;
        const w = (swap ? p.h : p.w) + 2 * ((p.margin ?? 0) + fit);
        const d = (swap ? p.w : p.h) + 2 * ((p.margin ?? 0) + fit);
        return { x: it.ix + px - w / 2, y: it.iy + py - d / 2, w, d };
      }),
  );
  const floorBoards = floorItems.filter((i) => i.placed.def.kind === "board").map(rectOf);
  // Vented parts first: they have the fewest places they can go.
  const lidOrder = [...autoLid].sort((a, b) => Number(b.vented) - Number(a.vented) || b.w * b.d - a.w * a.d);
  const axis = (lo: number, hi: number, step: number): number[] => {
    const out: number[] = [];
    for (let v = lo; v < hi - 1e-9; v += step) out.push(v);
    out.push(Math.max(lo, hi));
    return out;
  };
  interface PackOpts {
    /** Vents must keep their distance from every board; when false they only score worse. */
    strict: boolean;
    step: number;
    /** "centre" keeps parts near the middle; "corner" packs them toward the front-left, which fits more into a tight cavity. */
    toward: "centre" | "corner";
    budget: number;
  }
  // Every spot for one lid part, best first: no cover over a floor part's up-facing port,
  // a vent away from boards, then the lowest cavity, then the tie-break position.
  const rankSpots = (it: Item, w: number, d: number, o: PackOpts): { x: number; y: number }[] => {
    const xMax = w - lidSide - it.w;
    const yMax = d - lidMargin - it.d;
    if (xMax < lidSide - 1e-9 || yMax < lidMargin - 1e-9) return [];
    // The corner screw bosses are the only reason to stay further from the side walls.
    const bosses: Rect[] = screwLid
      ? [
          { x: 0, y: 0, w: sideMargin, d: sideMargin },
          { x: w - sideMargin, y: 0, w: sideMargin, d: sideMargin },
          { x: 0, y: d - sideMargin, w: sideMargin, d: sideMargin },
          { x: w - sideMargin, y: d - sideMargin, w: sideMargin, d: sideMargin },
        ]
      : [];
    const scored: { x: number; y: number; score: number }[] = [];
    for (const x of axis(lidSide, xMax, o.step)) {
      for (const y of axis(lidMargin, yMax, o.step)) {
        const r: Rect = { x, y, w: it.w, d: it.d };
        if (bosses.some((b) => overlaps(r, b))) continue;
        const blocks = upPortRects.some((p) => overlaps(r, p));
        const tie = o.toward === "centre" ? Math.hypot(x + it.w / 2 - w / 2, y + it.d / 2 - d / 2) : x + y;
        let score = (blocks ? 1000 : 0) + heightNeededOver(it, r) * 4 + tie * 0.01;
        if (it.vented && floorBoards.length) {
          const near = Math.min(...floorBoards.map((b) => planDistance(r, b)));
          if (near < DESIGN.ventDistance) {
            if (o.strict) continue;
            score += 600;
          }
          score -= Math.min(near, 40) * 1.5;
        }
        scored.push({ x, y, score });
      }
    }
    return scored.sort((p, q) => p.score - q.score);
  };
  /** Depth-first so an early choice never leaves a later part without room. Undefined when nothing fits. */
  const packLid = (w: number, d: number, o: PackOpts): { x: number; y: number }[] | undefined => {
    const chosen: { x: number; y: number }[] = [];
    const ranked = lidOrder.map((it) => rankSpots(it, w, d, o));
    let budget = o.budget;
    const solve = (k: number, taken: Rect[]): boolean => {
      if (k === lidOrder.length) return true;
      const it = lidOrder[k]!;
      let tried = 0;
      for (const c of ranked[k]!) {
        if (taken.some((t) => overlaps({ x: c.x, y: c.y, w: it.w, d: it.d }, t, gap))) continue;
        if (tried++ >= 150) break;
        if (budget-- <= 0) return false;
        chosen[k] = c;
        if (solve(k + 1, [...taken, { x: c.x, y: c.y, w: it.w, d: it.d }])) return true;
      }
      return false;
    };
    return solve(0, fixedLid) ? chosen : undefined;
  };
  const fixedLid = lidItems.filter((i) => !i.auto).map(rectOf);
  const applyLid = (c: { x: number; y: number }[] | undefined, w: number, d: number): void => {
    lidOrder.forEach((it, k) => {
      it.ix = c?.[k] ? c[k]!.x : Math.max(0, (w - it.w) / 2);
      it.iy = c?.[k] ? c[k]!.y : Math.max(0, (d - it.d) / 2);
    });
  };
  /** The placement used when the cavity size is given: vents clear of boards if possible, else allowed with a warning later. */
  const packFixed = (w: number, d: number): void => {
    const o: PackOpts = { strict: true, step: 0.5, toward: "centre", budget: 1500 };
    applyLid(packLid(w, d, o) ?? packLid(w, d, { ...o, strict: false, budget: 4000 }), w, d);
  };

  let W: number;
  let D: number;
  if (fixedInner) {
    W = fixedInner.w;
    D = fixedInner.d;
    packFixed(W, D);
  } else if (!autoLid.length) {
    W = ceil10(needW);
    D = ceil10(needD);
  } else {
    // For every width from the minimum up, find the shallowest cavity the lid parts fit
    // in, and keep the combination that gives the smallest case (outer volume). A wider
    // footprint can beat a taller one: a lid part over a floor part raises the whole lid,
    // a part beside it only widens the case.
    const minW = ceil10(needW);
    const minD = ceil10(needD);
    const sum = (f: (i: Item) => number): number => autoLid.reduce((s, i) => s + f(i), 0) + gap * (autoLid.length - 1);
    // One row (or one column) of every lid part is the largest cavity worth trying, and always a way out.
    const maxW = Math.max(minW, ceil10(sum((i) => i.w) + 2 * sideMargin));
    const maxD = Math.max(minD, ceil10(sum((i) => i.d) + 2 * lidMargin));
    const partsArea = autoLid.reduce((s, i) => s + (i.w + gap) * (i.d + gap), 0);
    // No cavity is lower than the tallest part with its gap to the lid, or than a floor part with its wiring space.
    let lowest = 2 * fit;
    for (const it of floorItems) lowest = Math.max(lowest, floorTop(it) + wiringSpace);
    for (const it of autoLid) lowest = Math.max(lowest, hang(it) + fit);
    const outerH = (h: number): number => floor + h + lidThickness;
    const outerArea = (w: number, d: number): number => (w + 2 * wall) * (d + 2 * wall);
    /** The least depth the parts' combined area allows at this width. */
    const areaDepth = (w: number): number => Math.max(minD, Math.ceil(partsArea / (w - 2 * lidSide + gap) + 2 * lidMargin - gap));
    const opts: PackOpts = { strict: true, step: 2, toward: "corner", budget: 150 };
    let best: { w: number; d: number; vol: number; pos: { x: number; y: number }[] } | undefined;
    const tryWidth = (w: number): void => {
      const lo0 = areaDepth(w);
      if (best && outerArea(w, lo0) * outerH(lowest) >= best.vol) return;
      if (lo0 > maxD || !packLid(w, maxD, opts)) return;
      // Shallowest depth that works, assuming a deeper cavity never packs worse.
      let lo = lo0;
      let hi = maxD;
      while (lo < hi) {
        const mid = Math.floor((lo + hi) / 2);
        if (packLid(w, mid, opts)) hi = mid;
        else lo = mid + 1;
      }
      // Deeper cavities can pull parts off the floor parts and lower the case: look at them while that is still possible.
      let lastH = Infinity;
      let stalled = 0;
      for (let d = lo; d <= maxD; d += 1) {
        if (best && outerArea(w, d) * outerH(lowest) >= best.vol) break;
        const pos = packLid(w, d, opts);
        if (!pos) continue;
        applyLid(pos, w, d);
        const h = ceil10(heightNeed(w, d));
        const vol = outerArea(w, d) * outerH(h);
        // Near ties go to the smaller footprint.
        if (!best || vol < best.vol * 0.99) best = { w, d, vol, pos };
        if (h <= ceil10(lowest) + 1e-9) break;
        // Give up on a width once a few more millimetres of depth stop lowering the case.
        stalled = h < lastH - 1e-9 ? 0 : stalled + 1;
        lastH = h;
        if (stalled >= 4) break;
      }
    };
    // Every second width first, smallest footprint first; then the neighbours of the winner.
    const widths: number[] = [];
    for (let w = minW; w < maxW; w += 2) widths.push(w);
    widths.push(maxW);
    widths.sort((a, b) => outerArea(a, areaDepth(a)) - outerArea(b, areaDepth(b)));
    for (const w of widths) tryWidth(w);
    const coarse: { w: number } | undefined = best;
    if (coarse) for (const w of [coarse.w - 1, coarse.w + 1]) if (w >= minW && w <= maxW) tryWidth(w);
    if (best) {
      W = best.w;
      D = best.d;
      applyLid(best.pos, W, D);
    } else {
      // Nothing fitted by the search: one row, which the largest cavity always has room for.
      W = maxW;
      D = minD;
      let x = sideMargin;
      for (const it of lidOrder) {
        it.ix = x;
        it.iy = Math.max(lidMargin, Math.min((D - it.d) / 2, D - lidMargin - it.d));
        x += it.w + gap;
      }
    }
  }

  const gapToWall = (it: Item, dir: Dir): number => gapIn(it, dir, W, D);

  // ---- cavity height ---------------------------------------------------------------
  const needH = heightNeed(W, D);
  const H = fixedInner ? fixedInner.h : ceil10(needH);
  if (fixedInner && H < needH - 1e-9) {
    warn(`The given inner height ${mm(H)} is too low: the parts and openings need about ${mm(needH)}, including ${mm(wiringSpace)} of wiring space${dupont ? " and room for jumper leads on the pins" : ""}.`);
  }


  // ---- capped parts: the post is as tall as it takes for the stem to reach through the lid ----
  const capGapNeed = DESIGN.capFlangeGap + DESIGN.capFlangeT + DESIGN.capTravel;
  for (const it of floorItems) {
    if (!it.cap || !it.reach) continue;
    it.standoffH = H - capDrop(it);
    const gapUnderLid = it.reach.stemTop - it.reach.bodyTop - reachNeed;
    if (gapUnderLid < capGapNeed - 1e-9) {
      warn(
        `The stem of ${it.placed.use.ref} (${it.placed.def.name}) is ${mm(it.reach.stemTop - it.reach.bodyTop)} tall, which leaves ${mm(Math.max(gapUnderLid, 0))} between the part and the lid; a cap's flange needs ${mm(capGapNeed)}. Use a version with a stem at least ${mm(reachNeed + capGapNeed)} tall.`,
      );
    }
  }

  // ---- world placement -------------------------------------------------------------
  const zBottom = (it: Item): number => (it.on === "floor" ? floor + it.standoffH : floor + H - hang(it));
  const parts: PlacedPart[] = items.map((it) => ({
    use: it.placed.use,
    def: it.placed.def,
    at: { x: wall + it.ix, y: wall + it.iy, z: zBottom(it), rot: it.rot },
  }));
  const partOf = new Map(items.map((it, i) => [it, parts[i]!]));
  const outer = { w: W + 2 * wall, d: D + 2 * wall, h: floor + H };

  // ---- standoffs -------------------------------------------------------------------
  const standoffs: Standoff[] = [];
  const screwedBy = new Map<Item, Standoff[]>();
  for (const it of items) {
    // A capped part stands on a seat (below), not on standoffs.
    if (it.cap) continue;
    const p = partOf.get(it)!;
    const { def } = p;
    const holes = def.holes ?? [];
    // Floor standoffs run from the floor up to the underside of the board. Lid standoffs
    // hang from the lid down to the board's top face, where the components face the lid.
    const h = it.on === "floor" ? it.standoffH : hang(it) - def.body.h;
    const from = it.on === "floor" ? "floor" : "lid";
    if (h < 0.4) {
      // A reach part is pressed against the lid by design; anything else is worth a note.
      if (!it.reach) warn(`${label(p)} sits too flat against the lid to get standoffs (${mm(h)} high); it will be held by the lid alone.`);
      continue;
    }
    const mine: Standoff[] = [];
    if (holes.length) {
      for (const hole of holes) {
        const [hx, hy] = rotPoint(hole.x, hole.y, def.body.w, def.body.d, it.rot);
        const pilot = hole.dia > 2.2 ? hole.dia : DESIGN.pilotHole;
        const s: Standoff = { x: p.at.x + hx, y: p.at.y + hy, h, dia: Math.max(5, pilot + 3), hole: pilot, from };
        // A 5 mm screw through the board must find at least (5 - board thickness) of pilot hole.
        if (pilotDepth(s, floor, lidThickness) < 5 - def.body.h - 1e-6) s.hole = 0;
        mine.push(s);
      }
      if (mine.every((s) => s.hole === 0)) {
        warn(
          `${label(p)} is located by its posts and not screwed: they are only ${mm(h)} tall, too short for a 5 mm screw through a ${mm(def.body.h)} board. Raise the standoff or add a hot-glue dab.`,
        );
      }
      screwedBy.set(it, mine.filter((s) => s.hole > 0));
    } else {
      // No mounting holes: four posts that carry the board, kept clear of the pins.
      const dia = Math.min(3, Math.min(it.w, it.d) / 3);
      const spots = clearPosts(def, it.rot, it.w, it.d, dia);
      for (const [cx, cy] of spots) mine.push({ x: p.at.x + cx, y: p.at.y + cy, h, dia, hole: 0, from });
      if (spots.length < 3) warn(`${label(p)} has pins across most of its underside, so only ${spots.length} posts fit clear of them; fix it with hot glue.`);
    }
    standoffs.push(...mine);
  }

  // ---- backing posts for lid parts that are pressed from outside ----------------
  // A button on short lid posts would be pushed into the case, so a post from the floor
  // holds it up from underneath, if no floor part is in the way.
  for (const it of lidItems) {
    if (!it.reach) continue;
    const p = partOf.get(it)!;
    const [px, py] = rotPoint(it.reach.port.x, it.reach.port.y, p.def.body.w, p.def.body.d, it.rot);
    const dia = 3;
    const spot: Rect = { x: it.ix + px - dia / 2, y: it.iy + py - dia / 2, w: dia, d: dia };
    const blocker = floorItems.find((f) => overlaps(spot, rectOf(f)));
    const h = zBottom(it) - 0.2 - floor;
    if (blocker) {
      warn(
        `${label(p)} is pressed from outside but ${label(partOf.get(blocker)!)} sits under it, so there is no room for a backing post: pressing will push the part inward. Move it clear of the floor parts, or glue it.`,
      );
    } else if (h >= 0.4) {
      standoffs.push({ x: wall + it.ix + px, y: wall + it.iy + py, h, dia, hole: 0, from: "floor" });
    }
  }

  // ---- seats for capped parts ----------------------------------------------------------
  // One rectangular post under the body, between the legs, so the legs and their wires hang
  // free beside it. Lips on the two sides without legs keep the part from sliding off. The
  // finger's force goes cap, stem, part, post, floor; the lid carries none of it.
  const seats: Seat[] = [];
  for (const it of floorItems) {
    if (!it.cap) continue;
    const p = partOf.get(it)!;
    const { def } = p;
    const { w: bw, d: bd } = def.body;
    let x0 = 0;
    let x1 = bw;
    let y0 = 0;
    let y1 = bd;
    const EDGE = 1;
    for (const pin of def.pins) {
      if (pin.x <= EDGE) x0 = Math.max(x0, pin.x + DESIGN.seatLegClear);
      else if (pin.x >= bw - EDGE) x1 = Math.min(x1, pin.x - DESIGN.seatLegClear);
      else if (pin.y <= EDGE) y0 = Math.max(y0, pin.y + DESIGN.seatLegClear);
      else if (pin.y >= bd - EDGE) y1 = Math.min(y1, pin.y - DESIGN.seatLegClear);
    }
    const lipsY = y0 === 0 && y1 === bd;
    const lipsX = !lipsY && x0 === 0 && x1 === bw;
    if (x1 - x0 < 2 || y1 - y0 < 2) {
      warn(`${label(p)} has legs so close together that no post fits under it; its cap has nothing to press against. Glue the part to a block, or use a part with legs on two sides only.`);
      continue;
    }
    if (!lipsX && !lipsY) warn(`${label(p)} has legs on every side, so its post has no lips to locate it; fix it to the post with hot glue.`);
    const out = DESIGN.seatFit + DESIGN.seatLipT;
    const OPEN = 2; // the pocket runs out through the sides that have legs
    const toWorld = (ax: number, ay: number, bx: number, by: number) => {
      const a = rotPoint(ax, ay, bw, bd, it.rot);
      const b = rotPoint(bx, by, bw, bd, it.rot);
      return { x0: p.at.x + Math.min(a[0], b[0]), x1: p.at.x + Math.max(a[0], b[0]), y0: p.at.y + Math.min(a[1], b[1]), y1: p.at.y + Math.max(a[1], b[1]) };
    };
    const postRect = toWorld(x0 - (lipsX ? out : 0), y0 - (lipsY ? out : 0), x1 + (lipsX ? out : 0), y1 + (lipsY ? out : 0));
    const pocket =
      lipsX || lipsY
        ? toWorld(
            lipsX ? -DESIGN.seatFit : x0 - OPEN,
            lipsY ? -DESIGN.seatFit : y0 - OPEN,
            lipsX ? bw + DESIGN.seatFit : x1 + OPEN,
            lipsY ? bd + DESIGN.seatFit : y1 + OPEN,
          )
        : undefined;
    const inCavity: Rect = { x: postRect.x0 - wall, y: postRect.y0 - wall, w: postRect.x1 - postRect.x0, d: postRect.y1 - postRect.y0 };
    const blocker = floorItems.find((f) => f !== it && !f.cap && overlaps(inCavity, rectOf(f)));
    if (blocker) {
      warn(`${label(p)} stands on a post from the floor, but ${label(partOf.get(blocker)!)} is where the post goes. Move one of them.`);
      continue;
    }
    if (inCavity.x < 0 || inCavity.y < 0 || inCavity.x + inCavity.w > W || inCavity.y + inCavity.d > D) {
      warn(`The post under ${label(p)} runs into a wall. Move the part at least ${mm(out + fit)} further in.`);
    }
    seats.push({ ref: p.use.ref, ...postRect, z: p.at.z, zTop: p.at.z + (pocket ? DESIGN.seatLip : 0), pocket });
  }

  // ---- lid screws ------------------------------------------------------------------
  const screws: { x: number; y: number; dia: number }[] = [];
  if (screwLid) {
    // Boss centre sits half a millimetre closer to the corner than a tangent circle would, so the
    // boss cylinder cuts through the inner wall faces instead of just touching them.
    const c = bossDia / 2 - 0.5;
    for (const sx of [wall + c, wall + W - c]) {
      for (const sy of [wall + c, wall + D - c]) screws.push({ x: sx, y: sy, dia: DESIGN.screwDia });
    }
  } else {
    warn(`Lid style "${spec.lid}" is not generated in this version; only the screw lid is. The lid is a plain plate with a locating lip and no screw holes, so it is held by friction or glue.`);
  }

  // ---- openings, part 2: build them ------------------------------------------------
  const openings: Opening[] = [];
  const caps: Cap[] = [];
  if (wantedList) {
    for (const o of wantedList) {
      if (isCustom(o)) continue;
      const p = loaded.byRef.get(o.ref);
      if (!p || !mountedRefs.has(o.ref)) warn(`Opening requested for ${o.ref}.${o.port}, but ${o.ref} is not mounted in the enclosure.`);
      else if (!p.def.ports?.some((q) => q.name === o.port)) warn(`Opening requested for ${o.ref}.${o.port}, but ${p.def.name} has no port with that name.`);
    }
  }
  const wallName: Record<Dir, string> = { "x-": "left (x-)", "x+": "right (x+)", "y-": "front (y-)", "y+": "back (y+)" };
  for (const it of items) {
    const p = partOf.get(it)!;
    for (const port of p.def.ports ?? []) {
      const capped = !!it.cap && it.reach?.port === port;
      // A cap always gets its opening: without one it could not be pressed.
      if (!capped && !wanted(p.use.ref, port.name)) continue;
      const m = margin(port);
      const round = port.shape === "round";
      const [px, py] = rotPoint(port.x, port.y, p.def.body.w, p.def.body.d, it.rot);
      const cx = p.at.x + px;
      const cy = p.at.y + py;
      if (capped && it.cap && it.reach) {
        const spec2 = it.cap;
        const isRound = spec2.shape === "round";
        const cw = spec2.w;
        const ch = isRound ? cw : (spec2.h ?? cw);
        const bore = Math.max(port.w, port.h) + DESIGN.capBore;
        if (Math.min(cw, ch) < bore + 2 * DESIGN.capWall - 1e-9) {
          warn(`The cap of ${label(p)} is ${mm(Math.min(cw, ch))} across, too small to hold its ${mm(bore - DESIGN.capBore)} stem; make it at least ${mm(bore + 2 * DESIGN.capWall)}.`);
        }
        const tip = p.at.z + it.reach.stemTop;
        const zFlange = outer.h - DESIGN.capFlangeGap;
        const longY = ch >= cw;
        caps.push({
          ref: p.use.ref,
          shape: spec2.shape,
          x: cx,
          y: cy,
          w: cw,
          h: ch,
          fw: isRound ? cw + 2 * DESIGN.capFlange : cw + 2 * (longY ? DESIGN.capFlangeSide : DESIGN.capFlange),
          fh: isRound ? cw + 2 * DESIGN.capFlange : ch + 2 * (longY ? DESIGN.capFlange : DESIGN.capFlangeSide),
          z0: zFlange - DESIGN.capFlangeT,
          zFlange,
          zTop: tip + DESIGN.capTop,
          bore,
          zBore: tip,
          color: spec2.color,
        });
        openings.push({ ref: p.use.ref, port: port.name, face: "lid", u: cx, v: cy, w: cw + 2 * DESIGN.capClear, h: ch + 2 * DESIGN.capClear, shape: spec2.shape });
        continue;
      }
      if (port.faces === "up") {
        const swap = it.rot === 90 || it.rot === 270;
        let w = (swap ? port.h : port.w) + 2 * m;
        let h = (swap ? port.w : port.h) + 2 * m;
        if (round) w = h = Math.max(w, h);
        if (it.on === "floor") {
          const r: Rect = { x: cx - w / 2, y: cy - h / 2, w, d: h };
          const cover = items.find((o) => o.on === "lid" && overlaps({ x: wall + o.ix, y: wall + o.iy, w: o.w, d: o.d }, r));
          if (cover) {
            warn(`Port ${port.name} of ${label(p)} points up but ${label(partOf.get(cover)!)} sits over it, so no lid opening is made. Move one of them.`);
            continue;
          }
          const lidGap = outer.h - (p.at.z + p.def.maxHeight);
          if (lidGap > 3 && p.def.kind !== "sensor") {
            warn(
              port.reach
                ? `Port ${port.name} of ${label(p)} gets a lid opening but the part sits ${mm(lidGap)} below the lid's inner face, so nothing can touch it through the opening. Mount it on the lid.`
                : `Port ${port.name} of ${label(p)} gets a lid opening as a sight line only: the part sits ${mm(lidGap)} below the lid's inner face, so it is visible only from straight above. Leave the opening out (give an explicit openings list without it) or add a light pipe.`,
            );
          }
        } else if (it.reach && it.reach.port === port) {
          const stemLen = it.reach.stemTop - it.reach.bodyTop;
          if (stemLen < reachNeed - 1e-9) {
            warn(
              `Port ${port.name} of ${label(p)} ends ${mm(reachNeed - stemLen)} short of standing ${mm(DESIGN.reachProud)} proud of the ${mm(lidThickness)} lid: its stem is ${mm(stemLen)} tall. The opening is cut, but nobody can reach it. Use a taller version with a stem at least ${mm(reachNeed)} tall, or print a cap that bridges the gap.`,
            );
          }
        }
        openings.push({ ref: p.use.ref, port: port.name, face: "lid", u: cx, v: cy, w, h, shape: round ? "round" : "rect" });
        continue;
      }
      const dir = ROT_DIR[it.rot][port.faces];
      const gap2 = gapToWall(it, dir);
      if (gap2 > REACH_TO_WALL) {
        warn(
          `Port ${port.name} of ${label(p)} faces the ${wallName[dir]} wall but is ${mm(gap2)} away from it, so no opening is made. Move the part against that wall.`,
        );
        continue;
      }
      let w = port.w + 2 * m;
      let h = port.h + 2 * m;
      if (round) w = h = Math.max(w, h);
      const v = p.at.z + p.def.body.h + (port.z ?? port.h / 2);
      if (v - h / 2 < -1e-9 || v + h / 2 + DESIGN.openingHeadroom > outer.h + 1e-9) {
        warn(`The opening for ${port.name} of ${label(p)} is ${mm(h)} tall at ${mm(v)} above the bottom and leaves less than ${mm(DESIGN.openingHeadroom)} of the ${wallName[dir]} wall above it.`);
      }
      openings.push({
        ref: p.use.ref,
        port: port.name,
        face: dir,
        u: dir === "y-" || dir === "y+" ? cx : cy,
        v,
        w,
        h,
        shape: round ? "round" : "rect",
      });
    }
  }
  for (const c of extra) {
    const alongX = c.face === "y-" || c.face === "y+";
    const uMax = c.face === "lid" ? outer.w : alongX ? outer.w : outer.d;
    const vMax = c.face === "lid" ? outer.d : outer.h;
    if (c.u - c.w / 2 < -1e-9 || c.u + c.w / 2 > uMax + 1e-9 || c.v - c.h / 2 < -1e-9 || c.v + c.h / 2 > vMax + 1e-9) {
      warn(`The custom opening "${c.label}" on the ${c.face} face does not fit inside that face (${mm(uMax)} x ${mm(vMax)}).`);
    }
    openings.push({ ref: "", port: c.label, face: c.face, u: c.u, v: c.v, w: c.w, h: c.shape === "round" ? c.w : c.h, shape: c.shape });
  }

  // ---- collisions and clearances ---------------------------------------------------
  const spanZ = (it: Item): [number, number] => {
    const z = zBottom(it);
    return [z, z + (it.reach ? it.reach.bodyTop : it.placed.def.maxHeight)];
  };
  for (const it of items) {
    const p = partOf.get(it)!;
    const left = it.ix;
    const right = W - (it.ix + it.w);
    const front = it.iy;
    const back = D - (it.iy + it.d);
    if (Math.min(left, right, front, back) < -1e-6) {
      warn(`${label(p)} sticks out of the cavity (${mm(W)} x ${mm(D)}). Make the inner size larger or move the part.`);
    } else if (Math.min(left, right, front, back) < fit - 1e-6) {
      warn(`${label(p)} is closer than ${mm(fit)} to a wall; it may not fit once printed.`);
    }
    if (it.on === "lid" && !it.auto) {
      if (Math.min(left, right, front, back) < lidMargin - 1e-6 && Math.min(left, right, front, back) >= -1e-6) {
        warn(`${label(p)} is on the lid but within ${mm(lidMargin)} of a wall, where the lid's locating lip runs.`);
      }
    }
    const [z0, z1] = spanZ(it);
    if (z0 < floor - 1e-6) warn(`${label(p)} reaches below the floor of the case; the inner height ${mm(H)} is too low.`);
    if (!it.reach && z1 > floor + H - fit + 1e-6) {
      warn(`${label(p)} is ${mm(p.def.maxHeight)} tall and leaves less than ${mm(fit)} to the lid; raise the inner height.`);
    }
  }
  for (let i = 0; i < items.length; i++) {
    for (let j = i + 1; j < items.length; j++) {
      const a = items[i]!;
      const b = items[j]!;
      if (!overlaps(rectOf(a), rectOf(b))) continue;
      const [a0, a1] = spanZ(a);
      const [b0, b1] = spanZ(b);
      const pa = label(partOf.get(a)!);
      const pb = label(partOf.get(b)!);
      if (a0 < b1 && b0 < a1) {
        warn(`${pa} collides with ${pb}.`);
      } else if (a.on !== b.on) {
        const space = Math.max(a0 - b1, b0 - a1);
        if (space < wiringSpace - 1e-6) {
          warn(`Only ${mm(space)} of space between ${pa} and ${pb}, which overlap in plan; ${mm(wiringSpace)} is wanted for wiring.`);
        }
      }
    }
  }
  const corners: Rect[] = screwLid
    ? [
        { x: 0, y: 0, w: bossDia, d: bossDia },
        { x: W - bossDia, y: 0, w: bossDia, d: bossDia },
        { x: 0, y: D - bossDia, w: bossDia, d: bossDia },
        { x: W - bossDia, y: D - bossDia, w: bossDia, d: bossDia },
      ]
    : [];
  for (const it of items) {
    if (corners.some((r) => overlaps(rectOf(it), r))) {
      warn(`${label(partOf.get(it)!)} runs into a corner screw boss (${mm(bossDia)} square in each inner corner).`);
    }
  }
  // A cap's flange lies right under the lid, wider than the cap: it needs that space to itself.
  const flangeRect = (c: Cap): Rect => ({ x: c.x - c.fw / 2 - wall, y: c.y - c.fh / 2 - wall, w: c.fw, d: c.fh });
  caps.forEach((c, i) => {
    const r = flangeRect(c);
    const edge = Math.min(r.x, r.y, W - (r.x + r.w), D - (r.y + r.d));
    if (edge < lidMargin - 1e-6) warn(`The cap of ${c.ref} is within ${mm(lidMargin)} of a wall, where the lid's locating lip runs. Move the part further in or make the cap smaller.`);
    if (corners.some((k) => overlaps(r, k))) warn(`The cap of ${c.ref} runs into a corner screw boss.`);
    const under = lidItems.find((o) => overlaps(r, rectOf(o)));
    if (under) warn(`The cap of ${c.ref} runs into ${label(partOf.get(under)!)}, which hangs under the lid beside it. Move one of them or make the cap smaller.`);
    for (const d of caps.slice(i + 1)) {
      // Two round flanges meet when their centres are closer than the two radii; anything else is tested as rectangles.
      const meet = c.shape === "round" && d.shape === "round" ? Math.hypot(c.x - d.x, c.y - d.y) < (c.fw + d.fw) / 2 : overlaps(r, flangeRect(d));
      if (meet) warn(`The caps of ${c.ref} and ${d.ref} run into each other under the lid. Move the parts apart or make the caps smaller.`);
    }
  });
  // A vent next to a controller reads the controller's warmth, not the room.
  const boards = items.filter((i) => i.placed.def.kind === "board");
  for (const it of items) {
    if (!it.vented) continue;
    for (const b of boards) {
      if (b === it) continue;
      const dist = planDistance(rectOf(it), rectOf(b));
      if (dist < DESIGN.ventDistance) {
        warn(
          `${label(partOf.get(it)!)} has an air vent and ${dist === 0 ? "sits over" : `is only ${mm(dist)} from`} ${label(partOf.get(b)!)}, so it will read the controller's warmth rather than the room. By how much is not known; move it at least ${mm(DESIGN.ventDistance)} away.`,
        );
      }
    }
  }
  const minRadius = Math.min(outer.w, outer.d) / 2;
  if (radius > minRadius) warn(`The corner radius ${mm(radius)} is larger than half the smallest outer side (${mm(minRadius)}); it is reduced to fit.`);

  // ---- hardware --------------------------------------------------------------------
  const hardware: HardwareLine[] = [];
  const addHardware = (name: string, qty: number, use: string): void => {
    const line = hardware.find((l) => l.name === name && l.use === use);
    if (line) line.qty += qty;
    else hardware.push({ name, qty, use });
  };
  const longest = (max: number): number => SCREW_LENGTHS.filter((l) => l <= max + 1e-9).pop() ?? SCREW_LENGTHS[0]!;
  if (screws.length) {
    // The M3 screw goes through the lid and into the boss's pilot hole. Keep 1 mm of hole free
    // at the bottom, and no more than 8 mm of thread in the boss.
    const bossDepth = Math.min(DESIGN.bossPilotMax, outer.h - floor - 1);
    const len = longest(Math.min(lidThickness + bossDepth - 1, lidThickness + 8));
    if (len < lidThickness + 3) warn(`The cavity is only ${mm(H)} tall, so an M3 lid screw gets less than 3 mm of thread in its boss.`);
    addHardware(`M${DESIGN.screwDia} x ${len} mm countersunk screw`, screws.length, "lid to body");
  }
  for (const [it, list] of screwedBy) {
    const p = partOf.get(it)!;
    for (const s of list) {
      const dia = s.hole > 2.2 ? Math.round((s.hole - 0.2) * 2) / 2 : 2;
      const len = longest(pilotDepth(s, floor, lidThickness) + p.def.body.h);
      addHardware(`M${dia} x ${len} mm pan-head screw`, 1, `${p.use.ref} to its ${s.from === "floor" ? "floor" : "lid"} posts`);
    }
  }

  return {
    inner: { w: W, d: D, h: H },
    outer,
    wall,
    floor,
    lidThickness,
    lipHeight,
    fit,
    radius,
    parts,
    standoffs,
    seats,
    caps,
    openings,
    screws,
    hardware,
    warnings,
  };
}

/**
 * The layout in the coordinates the user writes in project.json, as text lines for
 * `enclosure.ts --explain`: where each part ended up (paste-ready mount values), which
 * areas to keep clear, and where the openings are. Pure, so it can be tested.
 */
export function explainLayout(L: EnclosureLayout, loaded: Loaded): string[] {
  const spec = loaded.project.enclosure;
  const n = (v: number): string => String(Math.round(v * 100) / 100);
  const span = (a: number, b: number): string => `${n(a)} to ${n(b)}`;
  const box = (x: number, y: number, w: number, d: number): string => `x ${span(x, x + w)}, y ${span(y, y + d)}`;
  const { wall, fit } = L;
  const { w: IW, d: ID } = L.inner;
  const screwLid = L.screws.length > 0;
  const sideMargin = screwLid ? DESIGN.bossDia + fit : fit;
  const lidMargin = 2 * fit + DESIGN.lipThickness;
  const dirName: Record<Dir, string> = { "x-": "left (x-)", "x+": "right (x+)", "y-": "front (y-)", "y+": "back (y+)" };
  const mountOf = (ref: string): string => spec?.mounts.find((m) => m.ref === ref)?.on ?? "floor";

  const out: string[] = [];
  out.push(
    `Cavity ${n(IW)} x ${n(ID)} x ${n(L.inner.h)} mm. Outer ${n(L.outer.w)} x ${n(L.outer.d)} x ${n(L.outer.h)} mm (body), closed height ${n(closedHeight(L))} mm. Wall ${n(wall)} mm.`,
    ``,
    `Coordinates`,
    `  mounts (x, y): mm from the INNER front-left corner, wall not included. World = mount + ${n(wall)}.`,
    `  x runs left to right, y runs front (y-) to back (y+). A part's x, y is the corner of its footprint after rotation.`,
    `  custom openings (u, v): OUTER coordinates, wall included, and u, v is the opening's centre.`,
    `    side faces: u from the outer corner at minimum x (faces y-, y+) or minimum y (faces x-, x+); v is height above the outer bottom.`,
    `    lid: u = outer x, v = outer y.`,
    ``,
    `Parts (paste into enclosure.mounts to pin one)`,
  );
  for (const p of L.parts) {
    const fp = footprint(p);
    const x = p.at.x - wall;
    const y = p.at.y - wall;
    const on = mountOf(p.use.ref);
    const faces = L.openings
      .filter((o) => o.ref === p.use.ref)
      .map((o) => `${o.port} -> ${o.face === "lid" ? "lid" : `${dirName[o.face]} wall`}`)
      .join("; ");
    // x: 0, y: 0 means "place it for me", so an exact corner position is written as 0.01.
    const wx = x === 0 && y === 0 ? 0.01 : x;
    const rot = p.at.rot ?? 0;
    const cap = L.caps.find((c) => c.ref === p.use.ref);
    const capNote = cap
      ? `, on a ${n(p.at.z - L.floor)} mm post with a ${cap.shape === "round" ? `${n(cap.w)} mm round` : `${n(cap.w)} x ${n(cap.h)} mm`} cap standing ${n(cap.zTop - L.outer.h - L.lidThickness)} mm above the lid`
      : "";
    const capSpec = spec?.mounts.find((m): m is PlacedMount => m.on !== "wire" && m.ref === p.use.ref)?.cap;
    const capJson = cap && capSpec ? `, "cap": ${JSON.stringify(capSpec)}` : "";
    out.push(
      `  ${p.use.ref} (${p.def.name}) on ${on}: x ${n(x)}, y ${n(y)}, ${n(fp.w)} x ${n(fp.d)} mm, rot ${rot}${capNote}${faces ? `, ${faces}` : ""}`,
      `    { "ref": "${p.use.ref}", "on": "${on}", "x": ${n(wx)}, "y": ${n(y)}, "rot": ${rot}${capJson} }`,
    );
  }
  for (const m of spec?.mounts ?? []) if (m.on === "wire") out.push(`  ${m.ref} (${loaded.byRef.get(m.ref)?.def.name ?? m.ref}) hangs in the wiring: no position, no posts`);

  out.push(``, `Keep clear (mount coordinates)`);
  if (screwLid) {
    const c = DESIGN.bossDia;
    out.push(
      `  corner screw bosses, ${n(c)} mm squares (nothing may overlap them):`,
      `    ${box(0, 0, c, c)}`,
      `    ${box(IW - c, 0, c, c)}`,
      `    ${box(0, ID - c, c, c)}`,
      `    ${box(IW - c, ID - c, c, c)}`,
      `  floor parts keep ${n(sideMargin)} mm from the side walls when placed automatically (boss ${n(c)} + fit ${n(fit)}).`,
    );
  } else {
    out.push(`  no corner screw bosses (lid style is not "screw").`);
  }
  out.push(
    `  floor parts: at least ${n(fit)} mm from every wall.`,
    `  lid parts: at least ${n(lidMargin)} mm from every wall (the lid's locating lip), and ${n(fit + 2)} mm from each other.`,
  );
  const covers = L.openings.filter((o) => o.face === "lid" && o.ref !== "" && mountOf(o.ref) === "floor");
  for (const o of covers) {
    out.push(`  over ${o.ref}.${o.port}: no lid part may cover ${box(o.u - wall - o.w / 2, o.v - wall - o.h / 2, o.w, o.h)} (a floor part's up-facing port)`);
  }
  const boards = L.parts.filter((p) => p.def.kind === "board");
  const vented = L.parts.filter((p) => (p.def.ports ?? []).some(isVent));
  for (const v of vented) {
    out.push(`  ${v.use.ref} has an air vent: keep it at least ${n(DESIGN.ventDistance)} mm from ${boards.map((b) => b.use.ref).join(", ") || "any board"}.`);
  }
  out.push(`  a lid part over a floor part needs the cavity ${n(DESIGN.wiringSpace)} mm taller than that floor part.`);

  out.push(``, `Openings (outer coordinates, as written in extraOpenings)`);
  if (!L.openings.length) out.push(`  none`);
  for (const o of L.openings) {
    const what = o.ref ? `${o.ref}.${o.port}` : o.port;
    out.push(`  ${what}: face ${o.face}, u ${n(o.u)}, v ${n(o.v)}, ${n(o.w)} x ${n(o.h)} mm ${o.shape}`);
  }
  if (L.warnings.length) out.push(``, `Warnings`, ...L.warnings.map((w) => `  ${w}`));
  return out;
}
