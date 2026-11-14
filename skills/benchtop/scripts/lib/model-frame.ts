// Registering a board's 3D model to its 2D pad data.
//
// The catalog holds two independent descriptions of a board: pad centres and an outline from the
// CAD file, and heights and connector openings from a STEP model. Each has its own axes and origin,
// and the catalog does not say how they relate. This module works that out, or declines to.
//
// A board lies flat in both, so the relation is one of eight: a quarter-turn rotation, optionally
// reflected, plus a shift. A reflection does not by itself mean the model is seen from the underside:
// a pad frame whose Y axis points down (KiCad) needs one to hold a model seen from the top. The
// physical question is answered by `seen_from_underside`, which accounts for the frame's Y direction. The candidates that make the two PCB
// outlines the same size are kept, and the one that also puts the model's connectors where the pad
// data has them wins, provided it wins clearly. A square or symmetric board with nothing to break
// the tie gets no answer: a cut-out on the wrong wall is worse than none.
//
// Pure functions, no database and no file access, so the importer can call them directly.

export type Vec = [number, number];

export interface Box2 {
  min: Vec;
  max: Vec;
}

/** A connector as the 3D model has it. Coordinates are in the model's own frame, mm. */
export interface ModelConnector {
  /** Package name from the model, e.g. "USB_C_CUSB31-CFM2AX-01-X". */
  name: string;
  /** Reference designator when the model names one ("X6"). Features are matched on it. */
  ref: string | null;
  /** Centre of the connector's housing and pins, looking down on the board. */
  center: Vec;
  /** Which face of the PCB the housing sits on in the model: +Z is "above". Null when it straddles the board or is unknown. */
  side?: "above" | "below" | null;
  openings: ModelOpeningIn[];
}

export interface ModelOpeningIn {
  /** Centre of the opening's face, looking down on the board. */
  center: Vec;
  /** Direction the opening faces, a unit vector along one model axis. */
  outward: Vec;
  width_mm: number;
  lower_above_pcb_mm: number;
  upper_above_pcb_mm: number;
}

/** A pad group from the 2D data, in the pad dataset's own source frame. */
export interface PadFeature {
  ref: string;
  /** Mean position of the group's pads. */
  center: Vec;
  /** The side of the board the CAD file places the part on. */
  side?: "top" | "bottom" | null;
}

/** x' = m[0][0] x + m[0][1] y + t[0], y' = m[1][0] x + m[1][1] y + t[1]: model frame to pad frame. */
export interface Transform {
  m: [Vec, Vec];
  t: Vec;
  /** Counter-clockwise rotation in the pad frame's own axes, before any mirroring is undone. */
  rotation_deg: 0 | 90 | 180 | 270;
  /** The matrix includes a reflection (determinant -1). Arithmetic only; see `seen_from_underside` for what it means. */
  reflected: boolean;
  /**
   * The model looks at the board from the opposite face to the pad data's top view, so "above the
   * PCB" in the model is the underside in the pad data. True when the matrix is reflected in a
   * Y-up pad frame, or not reflected in a Y-down one.
   */
  seen_from_underside: boolean;
}

export interface RegisteredOpening {
  connector: string;
  ref: string | null;
  /** Centre of the opening, moved onto the board outline along its facing direction. Pad-frame mm. */
  center: Vec;
  /** Unit vector pointing out of the board, in pad-frame axes. */
  outward: Vec;
  width_mm: number;
  lower_above_pcb_mm: number;
  upper_above_pcb_mm: number;
  /** How far the opening's face sits beyond the outline. Negative when it is set back inside. */
  overhang_mm: number;
}

export interface Registration {
  transform: Transform;
  /** Largest difference between the two PCB outlines' sizes after the transform. */
  extent_delta_mm: number;
  /** Connectors found in both sources, with the distance between them after the transform. */
  features: { ref: string; distance_mm: number }[];
  /**
   * How many matched connectors settled whether the model is seen from the underside, by comparing the side of the
   * board the CAD file puts each one on with the side its housing is on in the model. 0 means the
   * positions alone had to decide it.
   */
  side_evidence: number;
  /** Root mean square of those distances. Housing centre against pad centroid, so a few mm is normal. */
  residual_mm: number;
  /** The residual of the next best candidate. The gap to it is what makes the answer unique. */
  runner_up_residual_mm: number | null;
  /** How many connectors the fit rests on. With one, only its distance from the board's centre lines separates the candidates. */
  feature_count: number;
  /**
   * Each connector's distance under the transform chosen WITHOUT it. A check that did not take
   * part in the fit. Empty when there are too few connectors to leave one out.
   */
  holdout: { ref: string; distance_mm: number }[];
  /**
   * One entry per opening in the model. A connector can carry several: one per position on a header
   * or terminal block, or nested wires of one socket that overlap. Collapse per connector for a cut-out.
   */
  openings: RegisteredOpening[];
}

export type RegistrationResult = { ok: true; registration: Registration } | { ok: false; reason: string };

export interface RegisterInput {
  /** PCB bounds in the model frame. */
  modelPcb: Box2;
  /** Board outline bounds in the pad frame. Must come from the same CAD file as the pads. */
  outline: Box2;
  connectors: ModelConnector[];
  padGroups: PadFeature[];
  /** Which way the pad frame's Y axis points when the board is seen from the top. EAGLE is "up", KiCad is "down". */
  padFrameY: "up" | "down";
}

/** The two outlines must agree in size this closely to be the same board. */
export const EXTENT_TOLERANCE_MM = 0.5;
/** A fit worse than this is not a fit: housing centres and pad centroids differ, but not by more. */
export const MAX_RESIDUAL_MM = 4;
/** The winner must beat the runner-up by this much, and by half. */
export const MIN_MARGIN_MM = 2;

const round = (n: number, d = 3): number => Number(n.toFixed(d));
const apply = (m: [Vec, Vec], v: Vec): Vec => [m[0][0] * v[0] + m[0][1] * v[1], m[1][0] * v[0] + m[1][1] * v[1]];
const dist = (a: Vec, b: Vec): number => Math.hypot(a[0] - b[0], a[1] - b[1]);
const rms = (ds: number[]): number => Math.sqrt(ds.reduce((s, d) => s + d * d, 0) / ds.length);

const ROTATIONS: { deg: 0 | 90 | 180 | 270; m: [Vec, Vec] }[] = [
  { deg: 0, m: [[1, 0], [0, 1]] },
  { deg: 90, m: [[0, -1], [1, 0]] },
  { deg: 180, m: [[-1, 0], [0, -1]] },
  { deg: 270, m: [[0, 1], [-1, 0]] },
];

/** The candidates that make the model's PCB the same size as the outline, each shifted so the two boxes coincide. */
export function candidateTransforms(modelPcb: Box2, outline: Box2, padFrameY: "up" | "down" = "up"): { transform: Transform; extent_delta_mm: number }[] {
  const out: { transform: Transform; extent_delta_mm: number }[] = [];
  const corners: Vec[] = [modelPcb.min, [modelPcb.max[0], modelPcb.min[1]], modelPcb.max, [modelPcb.min[0], modelPcb.max[1]]];
  const target: Vec = [outline.max[0] - outline.min[0], outline.max[1] - outline.min[1]];
  for (const reflected of [false, true]) {
    for (const r of ROTATIONS) {
      // A reflection flips the model's x before the rotation.
      const m: [Vec, Vec] = reflected ? [[-r.m[0][0], r.m[0][1]], [-r.m[1][0], r.m[1][1]]] : r.m;
      const pts = corners.map((c) => apply(m, c));
      const min: Vec = [Math.min(...pts.map((p) => p[0])), Math.min(...pts.map((p) => p[1]))];
      const max: Vec = [Math.max(...pts.map((p) => p[0])), Math.max(...pts.map((p) => p[1]))];
      const delta = Math.max(Math.abs(max[0] - min[0] - target[0]), Math.abs(max[1] - min[1] - target[1]));
      if (delta > EXTENT_TOLERANCE_MM) continue;
      // Centre on centre, so a small size difference is split between the two edges.
      const t: Vec = [(outline.min[0] + outline.max[0]) / 2 - (min[0] + max[0]) / 2, (outline.min[1] + outline.max[1]) / 2 - (min[1] + max[1]) / 2];
      out.push({ transform: { m, t, rotation_deg: r.deg, reflected, seen_from_underside: reflected !== (padFrameY === "down") }, extent_delta_mm: delta });
    }
  }
  return out;
}

export const toPadFrame = (tr: Transform, v: Vec): Vec => {
  const p = apply(tr.m, v);
  return [p[0] + tr.t[0], p[1] + tr.t[1]];
};

interface Pair {
  ref: string;
  model: Vec;
  pad: Vec;
  /** True when this connector says the model is seen from the underside, false when it says it is not, null when it cannot say. */
  underside: boolean | null;
}

/** Best candidate for a set of matched connectors, or why there is none. */
function choose(cands: { transform: Transform; extent_delta_mm: number }[], pairs: Pair[]):
  | { ok: true; best: (typeof cands)[number]; residual: number; runnerUp: number | null }
  | { ok: false; reason: string } {
  if (!pairs.length) return { ok: false, reason: "no connector is named in both the model and the pad data, so nothing fixes the orientation" };
  const scored = cands
    .map((c) => ({ c, r: rms(pairs.map((p) => dist(toPadFrame(c.transform, p.model), p.pad))) }))
    .sort((a, b) => a.r - b.r);
  const best = scored[0]!;
  const next = scored[1];
  if (best.r > MAX_RESIDUAL_MM) return { ok: false, reason: `no orientation puts the model's connectors on the pad data's (best residual ${round(best.r, 2)} mm)` };
  if (next && (next.r - best.r < MIN_MARGIN_MM || next.r < best.r * 2)) {
    return { ok: false, reason: `two orientations fit about equally (${round(best.r, 2)} and ${round(next.r, 2)} mm); the board is symmetric as far as its connectors show` };
  }
  return { ok: true, best: best.c, residual: best.r, runnerUp: next ? next.r : null };
}

export function registerModel(input: RegisterInput): RegistrationResult {
  let cands = candidateTransforms(input.modelPcb, input.outline, input.padFrameY);
  if (!cands.length) {
    const me = [input.modelPcb.max[0] - input.modelPcb.min[0], input.modelPcb.max[1] - input.modelPcb.min[1]].map((n) => round(n, 2));
    const oe = [input.outline.max[0] - input.outline.min[0], input.outline.max[1] - input.outline.min[1]].map((n) => round(n, 2));
    return { ok: false, reason: `the model's PCB is ${me.join(" x ")} mm and the outline is ${oe.join(" x ")} mm; they are not the same board outline` };
  }
  const byRef = new Map(input.padGroups.map((g) => [g.ref.toUpperCase(), g]));
  // A reference used twice in the model cannot say which one the pad group is, so neither is used.
  const uses = new Map<string, number>();
  for (const c of input.connectors) if (c.ref) uses.set(c.ref.toUpperCase(), (uses.get(c.ref.toUpperCase()) ?? 0) + 1);
  const pairs: Pair[] = [];
  for (const c of input.connectors) {
    const key = c.ref?.toUpperCase();
    const g = key ? byRef.get(key) : undefined;
    if (!key || !g || uses.get(key) !== 1) continue;
    // A part on the top of the board whose housing is on the model's +Z face: the model is seen from the top.
    const underside = c.side && g.side ? (c.side === "above") !== (g.side === "top") : null;
    pairs.push({ ref: c.ref!, model: c.center, pad: g.center, underside });
  }

  // When every connector that can tell agrees, only that half of the candidates is considered.
  const votes = pairs.map((p) => p.underside).filter((v): v is boolean => v !== null);
  const agreed = votes.length > 0 && votes.every((v) => v === votes[0]);
  const sideEvidence = agreed ? votes.length : 0;
  if (agreed) cands = cands.filter((c) => c.transform.seen_from_underside === votes[0]);

  const picked = choose(cands, pairs);
  if (!picked.ok) return picked;
  const tr = picked.best.transform;

  const holdout: Registration["holdout"] = [];
  if (pairs.length >= 2) {
    for (const left of pairs) {
      const without = choose(cands, pairs.filter((p) => p !== left));
      if (without.ok) holdout.push({ ref: left.ref, distance_mm: round(dist(toPadFrame(without.best.transform, left.model), left.pad), 2) });
    }
  }

  const openings: RegisteredOpening[] = [];
  for (const c of input.connectors) {
    for (const o of c.openings) {
      const at = toPadFrame(tr, o.center);
      const raw = apply(tr.m, o.outward);
      const outward: Vec = [Math.round(raw[0]), Math.round(raw[1])];
      // Signed distance from the outline edge the opening faces, positive outside the board.
      const axis = outward[0] !== 0 ? 0 : 1;
      const edge = outward[axis]! > 0 ? input.outline.max[axis]! : input.outline.min[axis]!;
      const overhang = (at[axis]! - edge) * outward[axis]!;
      const center: Vec = axis === 0 ? [edge, at[1]] : [at[0], edge];
      openings.push({
        connector: c.name, ref: c.ref, center: [round(center[0]), round(center[1])], outward,
        width_mm: round(o.width_mm, 2), lower_above_pcb_mm: round(o.lower_above_pcb_mm, 2), upper_above_pcb_mm: round(o.upper_above_pcb_mm, 2),
        overhang_mm: round(overhang, 2),
      });
    }
  }

  return {
    ok: true,
    registration: {
      transform: { ...tr, t: [round(tr.t[0]), round(tr.t[1])] },
      extent_delta_mm: round(picked.best.extent_delta_mm, 2),
      features: pairs.map((p) => ({ ref: p.ref, distance_mm: round(dist(toPadFrame(tr, p.model), p.pad), 2) })),
      side_evidence: sideEvidence,
      feature_count: pairs.length,
      residual_mm: round(picked.residual, 2),
      runner_up_residual_mm: picked.runnerUp == null ? null : round(picked.runnerUp, 2),
      holdout,
      openings,
    },
  };
}
