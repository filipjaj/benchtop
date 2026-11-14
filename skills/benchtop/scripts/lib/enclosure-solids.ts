// Solids for the enclosure: JSCAD geometry built from an EnclosureLayout, plus the
// triangle-mesh step that makes the output watertight.
//
// Booleans are built so that no two operand faces are ever coplanar or coincident:
// unions overlap by at least 0.5 mm, cuts overshoot every face they pass through, and
// the body is built 1 mm too tall and sliced flat at the end so the top face comes from
// one cut instead of several solids that happen to share a plane. That keeps JSCAD
// from leaving T-junctions at the source. triMesh() still repairs any that remain.
//
// The fit-test pieces (buildFitSolids) run the very same body and lid builders with a
// lower cut, a thinner floor and a thinner plate, so they cannot drift from the real case.
//
// The JSCAD packages are passed in (not imported here) so callers can report a missing
// install instead of crashing at import time.

import { DESIGN, pilotDepth, type EnclosureLayout, type Opening } from "./enclosure-layout";

export type Jscad = typeof import("@jscad/modeling");
export type Geom3 = ReturnType<Jscad["primitives"]["cuboid"]>;
type Geom2 = ReturnType<Jscad["primitives"]["rectangle"]>;
export type Vec3 = [number, number, number];

const SEGMENTS = 48;
/** The body is built this much too tall and cut back flat at the end. */
const OVER = 1;
/** Floor thickness of the fit-floor piece. */
export const FIT_FLOOR = 0.8;
/** Plate thickness of the fit-lid piece. */
export const FIT_LID = 1.2;
/** Height of the fit-floor's wall above the tallest seated floor board. */
const FIT_ABOVE_BOARD = 3;
/** The fit-floor's wall is never lower than this above the floor. */
const FIT_MIN_WALL = 6;

export interface Solids {
  body: Geom3;
  /** Lid in its assembled position, on top of the body. */
  lidAssembled: Geom3;
  /** Lid flat for printing: outer face on the bed, at the origin. */
  lidPrint: Geom3;
  /** Expected size of lidPrint. */
  lidSize: { w: number; d: number; h: number };
}

export interface FitSolids {
  /** Fit-floor for printing: flat underside on the bed, at the origin. */
  floor: Geom3;
  /** Fit-lid for printing: outer face on the bed, at the origin. */
  lid: Geom3;
  /** Height of the top face of the fit-floor's floor above the bed. */
  floorTop: number;
  /** Height of the fit-floor's cut above the top face of its floor. */
  wallHeight: number;
  /** Expected sizes of the printed pieces. */
  floorSize: { w: number; d: number; h: number };
  lidSize: { w: number; d: number; h: number };
}

/** Shared primitives. */
function kit(J: Jscad) {
  const { cuboid, cylinder, rectangle, roundedRectangle } = J.primitives;
  const { translate } = J.transforms;
  const { extrudeLinear } = J.extrusions;
  const outline = (w: number, d: number, r: number): Geom2 => {
    const rr = Math.min(r, Math.min(w, d) / 2 - 0.01);
    return rr < 0.05
      ? rectangle({ size: [w, d], center: [w / 2, d / 2] })
      : roundedRectangle({ size: [w, d], center: [w / 2, d / 2], roundRadius: rr, segments: SEGMENTS });
  };
  /** Rounded-rectangle prism from z0 to z1 with its minimum corner at (x, y). */
  const prism = (x: number, y: number, w: number, d: number, r: number, z0: number, z1: number): Geom3 =>
    translate([x, y, z0], extrudeLinear({ height: z1 - z0 }, outline(w, d, r)));
  const post = (x: number, y: number, z0: number, z1: number, dia: number): Geom3 =>
    cylinder({ radius: dia / 2, height: z1 - z0, center: [x, y, (z0 + z1) / 2], segments: SEGMENTS });
  const box = (x0: number, x1: number, y0: number, y1: number, z0: number, z1: number): Geom3 =>
    cuboid({ size: [x1 - x0, y1 - y0, z1 - z0], center: [(x0 + x1) / 2, (y0 + y1) / 2, (z0 + z1) / 2] });
  const openingCutter = (o: Opening, grow: number, z0: number, z1: number): Geom3 =>
    o.shape === "round"
      ? post(o.u, o.v, z0, z1, o.w + 2 * grow)
      : box(o.u - o.w / 2 - grow, o.u + o.w / 2 + grow, o.v - o.h / 2 - grow, o.v + o.h / 2 + grow, z0, z1);
  return { prism, post, box, openingCutter };
}

interface BodyOpts {
  /** Height of the flat cut that makes the top of the walls, posts and bosses. */
  cutZ: number;
  /** Underside of the floor plate. The top face of the floor stays where the layout puts it. */
  plateBottom: number;
  /** Corner screw bosses. The fit-floor leaves them out: they do not decide whether a part fits and cost print time. */
  bosses: boolean;
}

/** The body in world coordinates. Both the real body and the fit-floor come from here. */
function makeBody(J: Jscad, L: EnclosureLayout, o: BodyOpts): Geom3 {
  const { cuboid, cylinder } = J.primitives;
  const { union, subtract, intersect } = J.booleans;
  const { translate, rotateX, rotateY } = J.transforms;
  const { prism, post, box } = kit(J);

  const { wall, floor, lidThickness: lt } = L;
  const { w: IW, d: ID } = L.inner;
  const { w: OW, d: OD, h: OH } = L.outer;

  const tall = OH + OVER;
  const outerSolid = prism(0, 0, OW, OD, L.radius, o.plateBottom, tall);
  const cavity = prism(wall, wall, IW, ID, Math.max(L.radius - wall, 0), floor, tall + 1);
  const wallCutters: Geom3[] = L.openings
    .filter((p): p is Opening & { face: "x-" | "x+" | "y-" | "y+" } => p.face !== "lid")
    .map((p) => {
      const alongX = p.face === "y-" || p.face === "y+";
      const centre = p.face === "y-" || p.face === "x-" ? wall / 2 : (alongX ? OD : OW) - wall / 2;
      const at: Vec3 = alongX ? [p.u, centre, p.v] : [centre, p.u, p.v];
      if (p.shape === "round") {
        const c = cylinder({ radius: p.w / 2, height: wall + 2, segments: SEGMENTS });
        return translate(at, alongX ? rotateX(Math.PI / 2, c) : rotateY(Math.PI / 2, c));
      }
      return cuboid({ size: alongX ? [p.w, wall + 2, p.h] : [wall + 2, p.w, p.h], center: at });
    });
  const shell = subtract(outerSolid, cavity, ...wallCutters);

  const floorStands = L.standoffs.filter((s) => s.from === "floor");
  const standGeoms = floorStands.map((s) => post(s.x, s.y, floor - 0.5, floor + s.h, s.dia));
  // Seats for capped parts: a column the part rests on and, on the two sides without legs, a
  // lip that stands a little higher. Three boxes that overlap by 0.7 mm and share no plane:
  // the lips are 0.2 mm narrower than the column and start 0.2 mm higher inside the floor.
  const seatGeoms = L.seats.flatMap((s) => {
    const p = s.pocket;
    if (!p) return [box(s.x0, s.x1, s.y0, s.y1, floor - 0.5, s.zTop)];
    const lipsAlongY = p.y0 > s.y0;
    const LAP = 0.7;
    const IN = 0.2;
    const zl = floor - 0.3;
    return lipsAlongY
      ? [
          box(s.x0, s.x1, p.y0 - LAP, p.y1 + LAP, floor - 0.5, s.z),
          box(s.x0 + IN, s.x1 - IN, s.y0, p.y0, zl, s.zTop),
          box(s.x0 + IN, s.x1 - IN, p.y1, s.y1, zl, s.zTop),
        ]
      : [
          box(p.x0 - LAP, p.x1 + LAP, s.y0, s.y1, floor - 0.5, s.z),
          box(s.x0, p.x0, s.y0 + IN, s.y1 - IN, zl, s.zTop),
          box(p.x1, s.x1, s.y0 + IN, s.y1 - IN, zl, s.zTop),
        ];
  });

  // Corner screw bosses: a cylinder plus a square reaching into the wall, clipped to a
  // shape half a wall inside the outer outline so nothing lies on the outer surface.
  const clip = prism(wall / 2, wall / 2, OW - wall, OD - wall, Math.max(L.radius - wall / 2, 0), -1, tall + 1);
  const screws = o.bosses ? L.screws : [];
  const bossGeoms = screws.map((s) => {
    const [xa, xb] = s.x < OW / 2 ? [wall * 0.75, s.x] : [s.x, OW - wall * 0.75];
    const [ya, yb] = s.y < OD / 2 ? [wall * 0.75, s.y] : [s.y, OD - wall * 0.75];
    return intersect(clip, union(post(s.x, s.y, floor - 0.5, tall, DESIGN.bossDia), box(xa, xb, ya, yb, floor - 0.5, tall)));
  });

  // In a thinned floor the pilot holes must not break through the underside.
  const holeFloor = (z: number): number => (o.plateBottom > 0 ? Math.max(z, o.plateBottom + 0.4) : z);
  const pilotCuts: Geom3[] = floorStands
    .filter((s) => s.hole > 0)
    .map((s) => post(s.x, s.y, holeFloor(floor + s.h - pilotDepth(s, floor, lt)), floor + s.h + 0.5, s.hole));
  const bossCuts: Geom3[] = screws.map((s) =>
    post(s.x, s.y, OH - Math.min(DESIGN.bossPilotMax, OH - floor - 1), tall + 1, DESIGN.bossPilot),
  );

  let body = union(shell, ...standGeoms, ...seatGeoms, ...bossGeoms);
  const bodyCuts = [...pilotCuts, ...bossCuts];
  if (bodyCuts.length) body = subtract(body, ...bodyCuts);
  // One flat cut makes the top of the walls and of the bosses.
  return subtract(body, box(-5, OW + 5, -5, OD + 5, o.cutZ, tall + 5));
}

interface LidOpts {
  thickness: number;
  /** The locating lip and the corner clearances cut into it. */
  lip: boolean;
  /** 45 degree countersinks on the screw holes. */
  countersink: boolean;
}

/** The lid in its assembled position (underside at z = OH). Real lid and fit-lid come from here. */
function makeLid(J: Jscad, L: EnclosureLayout, o: LidOpts): Geom3 {
  const { cylinderElliptic } = J.primitives;
  const { union, subtract } = J.booleans;
  const { prism, post, box, openingCutter } = kit(J);

  const { wall, floor, fit, lidThickness: lt, lipHeight } = L;
  const { w: IW, d: ID } = L.inner;
  const { w: OW, d: OD, h: OH } = L.outer;
  const lipT = DESIGN.lipThickness;
  const top = OH + o.thickness;
  const plate = prism(0, 0, OW, OD, L.radius, OH, top);
  const lipR = Math.max(L.radius - wall - fit, 0);
  let lip = subtract(
    prism(wall + fit, wall + fit, IW - 2 * fit, ID - 2 * fit, lipR, OH - lipHeight, OH + 0.5),
    prism(wall + fit + lipT, wall + fit + lipT, IW - 2 * fit - 2 * lipT, ID - 2 * fit - 2 * lipT, Math.max(lipR - lipT, 0), OH - lipHeight - 1, OH + 1),
  );
  if (L.screws.length) {
    // Leave room for the corner bosses where the lip would run into them.
    const c = DESIGN.bossDia + fit;
    const z0 = OH - lipHeight - 1;
    lip = subtract(
      lip,
      box(wall - 1, wall + c, wall - 1, wall + c, z0, OH + 1),
      box(wall + IW - c, wall + IW + 1, wall - 1, wall + c, z0, OH + 1),
      box(wall - 1, wall + c, wall + ID - c, wall + ID + 1, z0, OH + 1),
      box(wall + IW - c, wall + IW + 1, wall + ID - c, wall + ID + 1, z0, OH + 1),
    );
  }
  const lidStands = L.standoffs.filter((s) => s.from === "lid");
  const lidOpenings = L.openings.filter((p) => p.face === "lid");
  // Hanging posts end inside the plate (their pilot holes stop 0.8 mm short of the outer face), so they overlap it instead of touching it. Where a
  // post would reach into an opening it is trimmed 0.3 mm back from the opening wall, so the
  // two never share a wall and no sliver forms between them.
  const hangGeoms = lidStands.map((s) => {
    const p = post(s.x, s.y, OH - s.h, OH + 0.5, s.dia);
    const trims = lidOpenings.map((p2) => openingCutter(p2, 0.3, OH - s.h - 1, top + 1));
    return trims.length ? subtract(p, ...trims) : p;
  });
  // A thinner plate shortens the pilot holes so they keep their 0.8 mm skin.
  const holeEnd = (z: number): number => (o.thickness < lt ? Math.min(z, top - DESIGN.lidSkin) : z);
  const hangCuts = lidStands
    .filter((s) => s.hole > 0)
    .map((s) => post(s.x, s.y, OH - s.h - 0.5, holeEnd(OH - s.h + pilotDepth(s, floor, lt)), s.hole));

  // Openings and screw holes go through the plate and the lip together.
  const cutFrom = OH - (o.lip ? lipHeight : 0) - 1;
  const lidCuts: Geom3[] = lidOpenings.map((p) => openingCutter(p, 0, cutFrom, top + 0.5));
  for (const s of L.screws) {
    const rh = (s.dia + 0.4) / 2;
    lidCuts.push(post(s.x, s.y, cutFrom, top + 0.5, 2 * rh));
    if (!o.countersink) continue;
    // Countersink at 45 degrees, flush with the outer face. It starts narrower than the
    // hole and below the point where it meets the hole wall, so the two cross cleanly.
    const zb = top - 1.8;
    const h = 1.9;
    lidCuts.push(
      cylinderElliptic({
        height: h,
        center: [s.x, s.y, zb + h / 2],
        startRadius: [rh - 0.3, rh - 0.3],
        endRadius: [rh - 0.3 + h, rh - 0.3 + h],
        segments: SEGMENTS,
      }),
    );
  }
  const base = o.lip ? union(plate, lip) : plate;
  const plateAndLip = lidCuts.length ? subtract(base, ...lidCuts) : base;
  const lidJoined = union(plateAndLip, ...hangGeoms);
  return hangCuts.length ? subtract(lidJoined, ...hangCuts) : lidJoined;
}

/** Rotate 180 degrees about the x axis (two mirrors, so every coordinate stays exact), then drop to the bed. */
function lidForPrint(J: Jscad, L: EnclosureLayout, assembled: Geom3, thickness: number): Geom3 {
  const { translate, mirrorY, mirrorZ } = J.transforms;
  return translate([0, L.outer.d, L.outer.h + thickness], mirrorZ(mirrorY(assembled)));
}

export function buildSolids(J: Jscad, L: EnclosureLayout): Solids {
  const { w: OW, d: OD, h: OH } = L.outer;
  const { lidThickness: lt, lipHeight } = L;
  const body = makeBody(J, L, { cutZ: OH, plateBottom: 0, bosses: true });
  const lidAssembled = makeLid(J, L, { thickness: lt, lip: true, countersink: true });
  const lidPrint = lidForPrint(J, L, lidAssembled, lt);
  const hang = L.standoffs.filter((s) => s.from === "lid").reduce((m, s) => Math.max(m, s.h), 0);
  return { body, lidAssembled, lidPrint, lidSize: { w: OW, d: OD, h: lt + Math.max(lipHeight, hang) } };
}

export interface CapSolid {
  ref: string;
  /** Where it sits in the closed case, resting on the stem. */
  assembled: Geom3;
  /** For printing: flange on the bed, at the place it has on the plate of caps. */
  print: Geom3;
  color?: string;
}

/**
 * The printed caps. A cap is a block with the stem's hole in it and a flange round its
 * foot. It prints flange down: the flange is the widest part, so nothing overhangs, and
 * the hole is a plain vertical bore closed by a short bridge.
 *
 * The flange slab is wider than the block on every side and the block starts inside it,
 * so the union has no coplanar faces (see the note at the top of this file).
 */
export function buildCaps(J: Jscad, L: EnclosureLayout): CapSolid[] {
  const { cuboid, cylinder, polygon } = J.primitives;
  const { union, subtract } = J.booleans;
  const { translate } = J.transforms;
  const { extrudeRotate } = J.extrusions;
  // The typings export `hull` as a module namespace; at run time it is the function.
  const hull = J.hulls.hull as unknown as (...g: Geom3[]) => Geom3;
  const GAP = 4; // between caps on the plate
  let at = 0;
  return L.caps.map((c) => {
    const hF = c.zFlange - c.z0;
    const hTop = c.zTop - c.z0;
    const hBore = c.zBore - c.z0;
    const ch = Math.min(DESIGN.capChamfer, Math.min(c.w, c.h) / 4);
    let local: Geom3;
    if (c.shape === "round") {
      // A round cap is one solid of revolution: flange, wall, chamfer, top and the stem's hole
      // come from a single profile, so there is no boolean to leave open edges.
      const R = c.w / 2;
      const profile = polygon({
        points: [
          [c.bore / 2, 0],
          [c.fw / 2, 0],
          [c.fw / 2, hF],
          [R, hF],
          [R, hTop - ch],
          [R - ch, hTop],
          [0, hTop],
          [0, hBore],
          [c.bore / 2, hBore],
        ],
      });
      local = extrudeRotate({ segments: SEGMENTS }, profile);
    } else {
      const slab = (w: number, h: number, za: number, zb: number): Geom3 => cuboid({ size: [w, h, zb - za], center: [0, 0, (za + zb) / 2] });
      // The block, with a chamfer round its top edge: the hull of the full outline and a smaller one on top.
      const block = hull(slab(c.w, c.h, hF - 0.5, hTop - ch), slab(c.w - 2 * ch, c.h - 2 * ch, hTop - 0.1, hTop));
      const flange = slab(c.fw, c.fh, 0, hF);
      const stemHole = cylinder({ radius: c.bore / 2, height: hBore + 1, center: [0, 0, (hBore - 1) / 2], segments: SEGMENTS });
      local = subtract(union(flange, block), stemHole);
    }
    const print = translate([at + c.fw / 2, c.fh / 2, 0], local);
    at += c.fw + GAP;
    return { ref: c.ref, assembled: translate([c.x, c.y, c.z0], local), print, color: c.color };
  });
}

/**
 * Two small pieces for a ten-minute test print: the lower part of the body (floor
 * thinned, posts and wall openings as in the real case) and a thin lid plate with the
 * real openings, screw holes and hanging posts. Post heights above the top of the floor
 * and all opening positions equal those of the full case.
 *
 * @param lidRefs refs of the parts mounted on the lid; every other mounted part is on the floor.
 */
export function buildFitSolids(J: Jscad, L: EnclosureLayout, lidRefs: ReadonlySet<string>): FitSolids {
  const { translate } = J.transforms;
  const { w: OW, d: OD, h: OH } = L.outer;
  const floorBoardTop = L.parts
    .filter((p) => !lidRefs.has(p.use.ref))
    .reduce((m, p) => Math.max(m, p.at.z + p.def.body.h), 0);
  const cutZ = Math.min(OH, Math.max(floorBoardTop + FIT_ABOVE_BOARD, L.floor + FIT_MIN_WALL));
  const plateBottom = Math.max(0, L.floor - FIT_FLOOR);
  const floorSolid = makeBody(J, L, { cutZ, plateBottom, bosses: false });
  const lidAssembled = makeLid(J, L, { thickness: FIT_LID, lip: false, countersink: false });
  const hang = L.standoffs.filter((s) => s.from === "lid").reduce((m, s) => Math.max(m, s.h), 0);
  return {
    floor: plateBottom > 0 ? translate([0, 0, -plateBottom], floorSolid) : floorSolid,
    lid: lidForPrint(J, L, lidAssembled, FIT_LID),
    floorTop: L.floor - plateBottom,
    wallHeight: cutZ - L.floor,
    floorSize: { w: OW, d: OD, h: cutZ - plateBottom },
    lidSize: { w: OW, d: OD, h: FIT_LID + hang },
  };
}


// ---------------------------------------------------------------------------
// Triangle mesh
// ---------------------------------------------------------------------------

export interface TriMesh {
  /** xyz triples. */
  v: number[];
  /** Triangle vertex indices. */
  t: number[];
  /** Edges not shared by exactly two triangles after repair. */
  openEdges: number;
  /** The same count before repair: how clean the boolean output was. */
  rawOpenEdges: number;
}

/**
 * Triangulate a solid and close the T-junctions that JSCAD's boolean output leaves
 * where a split edge meets an unsplit one. Without this a slicer sees open edges.
 */
export function triMesh(J: Jscad, g: Geom3): TriMesh {
  const gen = J.modifiers.generalize({ snap: true, triangulate: true }, g);

  // Vertices closer than this (2 micrometres) are the same vertex; JSCAD's snapping can leave
  // two copies of one point up to a few thousandths of a millimetre apart.
  const TOL = 2e-3;
  const v: number[] = [];
  const ids = new Map<string, number>();
  const idOf = (p: ArrayLike<number>): number => {
    const key = `${Math.round(p[0]! / TOL)},${Math.round(p[1]! / TOL)},${Math.round(p[2]! / TOL)}`;
    let id = ids.get(key);
    if (id === undefined) {
      id = v.length / 3;
      ids.set(key, id);
      v.push(p[0]!, p[1]!, p[2]!);
    }
    return id;
  };
  let tris: number[][] = [];
  for (const poly of J.geometries.geom3.toPolygons(gen)) {
    const f = poly.vertices.map(idOf);
    for (let k = 1; k < f.length - 1; k++) {
      if (f[0] !== f[k] && f[k] !== f[k + 1] && f[0] !== f[k + 1]) tris.push([f[0]!, f[k]!, f[k + 1]!]);
    }
  }

  const edgeKey = (a: number, b: number): string => (a < b ? `${a}|${b}` : `${b}|${a}`);
  const boundary = (): Set<string> => {
    const count = new Map<string, number>();
    for (const t of tris) {
      for (let e = 0; e < 3; e++) {
        const k = edgeKey(t[e]!, t[(e + 1) % 3]!);
        count.set(k, (count.get(k) ?? 0) + 1);
      }
    }
    return new Set([...count].filter(([, c]) => c !== 2).map(([k]) => k));
  };

  const CELL = 1;
  const grid = new Map<string, number[]>();
  const cellOf = (x: number): number => Math.floor(x / CELL);
  for (let i = 0; i < v.length / 3; i++) {
    const k = `${cellOf(v[i * 3]!)},${cellOf(v[i * 3 + 1]!)},${cellOf(v[i * 3 + 2]!)}`;
    const cell = grid.get(k);
    if (cell) cell.push(i);
    else grid.set(k, [i]);
  }
  const onSegment = (a: number, b: number): number[] => {
    const A = [v[a * 3]!, v[a * 3 + 1]!, v[a * 3 + 2]!];
    const B = [v[b * 3]!, v[b * 3 + 1]!, v[b * 3 + 2]!];
    const d = [B[0]! - A[0]!, B[1]! - A[1]!, B[2]! - A[2]!];
    const len2 = d[0]! * d[0]! + d[1]! * d[1]! + d[2]! * d[2]!;
    const found: { id: number; t: number }[] = [];
    const lo = [0, 1, 2].map((i) => cellOf(Math.min(A[i]!, B[i]!) - TOL));
    const hi = [0, 1, 2].map((i) => cellOf(Math.max(A[i]!, B[i]!) + TOL));
    for (let x = lo[0]!; x <= hi[0]!; x++) {
      for (let y = lo[1]!; y <= hi[1]!; y++) {
        for (let z = lo[2]!; z <= hi[2]!; z++) {
          for (const id of grid.get(`${x},${y},${z}`) ?? []) {
            if (id === a || id === b) continue;
            const p = [v[id * 3]! - A[0]!, v[id * 3 + 1]! - A[1]!, v[id * 3 + 2]! - A[2]!];
            const t = (p[0]! * d[0]! + p[1]! * d[1]! + p[2]! * d[2]!) / len2;
            if (t <= 0 || t >= 1) continue;
            const q = [p[0]! - d[0]! * t, p[1]! - d[1]! * t, p[2]! - d[2]! * t];
            if (Math.hypot(q[0]!, q[1]!, q[2]!) < TOL) found.push({ id, t });
          }
        }
      }
    }
    return found.sort((m, n) => m.t - n.t).map((f) => f.id);
  };

  let open = boundary();
  const rawOpenEdges = open.size;
  for (let pass = 0; pass < 6 && open.size > 0; pass++) {
    const next: number[][] = [];
    let changed = false;
    for (const t of tris) {
      const ring: number[] = [];
      let split = false;
      for (let e = 0; e < 3; e++) {
        const a = t[e]!;
        const b = t[(e + 1) % 3]!;
        ring.push(a);
        if (open.has(edgeKey(a, b))) {
          const extra = onSegment(a, b);
          if (extra.length) {
            ring.push(...extra);
            split = true;
          }
        }
      }
      if (!split) {
        next.push(t);
        continue;
      }
      // Fan from the centroid: every piece has area, unlike a fan from a corner.
      const c = v.length / 3;
      const cx = (v[t[0]! * 3]! + v[t[1]! * 3]! + v[t[2]! * 3]!) / 3;
      const cy = (v[t[0]! * 3 + 1]! + v[t[1]! * 3 + 1]! + v[t[2]! * 3 + 1]!) / 3;
      const cz = (v[t[0]! * 3 + 2]! + v[t[1]! * 3 + 2]! + v[t[2]! * 3 + 2]!) / 3;
      v.push(cx, cy, cz);
      for (let i = 0; i < ring.length; i++) next.push([c, ring[i]!, ring[(i + 1) % ring.length]!]);
      changed = true;
    }
    tris = next;
    open = boundary();
    if (!changed) break;
  }
  return { v, t: tris.flat(), openEdges: open.size, rawOpenEdges };
}

export function meshToGeom3(J: Jscad, m: TriMesh): Geom3 {
  const polys = [];
  for (let i = 0; i < m.t.length; i += 3) {
    polys.push(
      J.geometries.poly3.create([0, 1, 2].map((k) => [m.v[m.t[i + k]! * 3]!, m.v[m.t[i + k]! * 3 + 1]!, m.v[m.t[i + k]! * 3 + 2]!] as Vec3)),
    );
  }
  return J.geometries.geom3.create(polys);
}

/** Enclosed volume of a closed mesh, in mm^3. */
export function meshVolume(m: TriMesh): number {
  let sum = 0;
  for (let i = 0; i < m.t.length; i += 3) {
    const a = m.t[i]! * 3;
    const b = m.t[i + 1]! * 3;
    const c = m.t[i + 2]! * 3;
    const [ax, ay, az] = [m.v[a]!, m.v[a + 1]!, m.v[a + 2]!];
    const [bx, by, bz] = [m.v[b]!, m.v[b + 1]!, m.v[b + 2]!];
    const [cx, cy, cz] = [m.v[c]!, m.v[c + 1]!, m.v[c + 2]!];
    sum += ax * (by * cz - bz * cy) - ay * (bx * cz - bz * cx) + az * (bx * cy - by * cx);
  }
  return Math.abs(sum) / 6;
}

/**
 * Checklist for the fit test, one line per mounted part, generated from the layout.
 * Floor parts: seating plus the wall notches of their ports. Lid parts: their lid openings.
 */
export function fitChecklist(L: EnclosureLayout, lidRefs: ReadonlySet<string>): string[] {
  const lines: string[] = [];
  const mounted = new Set(L.parts.map((p) => p.use.ref));
  for (const p of L.parts) {
    const ref = p.use.ref;
    const label = p.use.label ?? p.def.name;
    const mine = L.openings.filter((o) => o.ref === ref && mounted.has(o.ref));
    if (lidRefs.has(ref)) {
      if (!mine.length) lines.push(`- [ ] The ${label} sits on its hanging posts without force.`);
      for (const o of mine) lines.push(`- [ ] The ${label}'s ${o.port} sits centred in its opening.`);
    } else if (L.caps.some((c) => c.ref === ref)) {
      lines.push(`- [ ] The ${label}'s cap drops into its lid opening from the inside, stops on its flange and slides freely.`);
    } else {
      const ports = [...new Set(mine.filter((o) => o.face !== "lid").map((o) => o.port))];
      const notch = ports.length ? ` and its ${ports.join(" and its ")} lines up with the notch in the wall` : "";
      lines.push(`- [ ] The ${label} drops onto its posts without force${notch}.`);
    }
  }
  return lines;
}

