import { describe, expect, test } from "bun:test";
import { candidateTransforms, registerModel, toPadFrame, type Box2, type ModelConnector, type PadFeature, type Vec } from "./model-frame";

// A 50 x 20 mm board in the pad frame, origin at its corner. USB on the left short edge,
// a JST near the right end of the top long edge, a terminal block on the right short edge.
const outline: Box2 = { min: [0, 0], max: [50, 20] };
const padGroups: PadFeature[] = [
  { ref: "X6", center: [3, 10] },
  { ref: "CONN1", center: [40, 16] },
  { ref: "J9", center: [47, 6] },
];

/** Put the pad-frame scene into a model frame by an exact inverse of a known transform. */
function modelScene(toModel: (v: Vec) => Vec, toModelDir: (v: Vec) => Vec): { modelPcb: Box2; connectors: ModelConnector[] } {
  const corners = ([[0, 0], [50, 0], [50, 20], [0, 20]] as Vec[]).map(toModel);
  const modelPcb: Box2 = {
    min: [Math.min(...corners.map((c) => c[0])), Math.min(...corners.map((c) => c[1]))],
    max: [Math.max(...corners.map((c) => c[0])), Math.max(...corners.map((c) => c[1]))],
  };
  const connectors: ModelConnector[] = [
    // The housing centre sits a little off the pad centroid, as real connectors do.
    { name: "USB_C", ref: "X6", center: toModel([2, 10]), openings: [{ center: toModel([-0.4, 10]), outward: toModelDir([-1, 0]), width_mm: 9, lower_above_pcb_mm: 0.1, upper_above_pcb_mm: 3.3 }] },
    { name: "JST_SH4", ref: "CONN1", center: toModel([40, 17]), openings: [{ center: toModel([40, 19.2]), outward: toModelDir([0, 1]), width_mm: 4, lower_above_pcb_mm: 0.5, upper_above_pcb_mm: 2.5 }] },
    { name: "TERMBLOCK", ref: "J9", center: toModel([46, 6]), openings: [] },
  ];
  return { modelPcb, connectors };
}

describe("candidateTransforms", () => {
  test("a rectangle keeps the four orientations that preserve its size", () => {
    const c = candidateTransforms({ min: [0, 0], max: [50, 20] }, outline);
    expect(c.map((x) => `${x.transform.rotation_deg}${x.transform.reflected ? "m" : ""}`).sort()).toEqual(["0", "0m", "180", "180m"]);
  });
  test("a model lying the other way keeps the quarter turns", () => {
    const c = candidateTransforms({ min: [0, 0], max: [20, 50] }, outline);
    expect(c.map((x) => `${x.transform.rotation_deg}${x.transform.reflected ? "m" : ""}`).sort()).toEqual(["270", "270m", "90", "90m"]);
  });
  test("a square keeps all eight", () => {
    expect(candidateTransforms({ min: [0, 0], max: [30, 30] }, { min: [0, 0], max: [30, 30] })).toHaveLength(8);
  });
  test("a different size keeps none", () => {
    expect(candidateTransforms({ min: [0, 0], max: [52, 20] }, outline)).toHaveLength(0);
  });
  test("each candidate maps the model's PCB onto the outline", () => {
    for (const { transform } of candidateTransforms({ min: [100, -40], max: [120, 10] }, outline)) {
      const a = toPadFrame(transform, [100, -40]);
      const b = toPadFrame(transform, [120, 10]);
      expect([Math.min(a[0], b[0]), Math.min(a[1], b[1]), Math.max(a[0], b[0]), Math.max(a[1], b[1])].map((n) => Math.round(n))).toEqual([0, 0, 50, 20]);
    }
  });
});

describe("registerModel", () => {
  test("a model in the same orientation with a shifted origin", () => {
    const { modelPcb, connectors } = modelScene((v) => [v[0] + 100, v[1] - 30], (v) => v);
    const r = registerModel({ modelPcb, outline, connectors, padGroups, padFrameY: "up" });
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.registration.transform).toMatchObject({ rotation_deg: 0, reflected: false, seen_from_underside: false, t: [-100, 30] });
    expect(r.registration.features.map((f) => f.ref)).toEqual(["X6", "CONN1", "J9"]);
    expect(r.registration.residual_mm).toBeLessThan(1.5);
    expect(r.registration.runner_up_residual_mm!).toBeGreaterThan(8);
    // The USB opening lands on the left edge, facing out, 0.4 mm proud of the board.
    expect(r.registration.openings[0]).toEqual({ connector: "USB_C", ref: "X6", center: [0, 10], outward: [-1, 0], width_mm: 9, lower_above_pcb_mm: 0.1, upper_above_pcb_mm: 3.3, overhang_mm: 0.4 });
    // The JST opening is set back 0.8 mm inside the top edge.
    expect(r.registration.openings[1]).toMatchObject({ center: [40, 20], outward: [0, 1], overhang_mm: -0.8 });
  });

  test("a model turned a quarter and a model turned upside down give the same openings", () => {
    // Quarter turn: pad (x, y) -> model (-y, x). Half turn: pad (x, y) -> model (-x, -y).
    for (const [name, toModel, toDir] of [
      ["quarter", (v: Vec): Vec => [-v[1] + 7, v[0] + 3], (v: Vec): Vec => [-v[1], v[0]]],
      ["half", (v: Vec): Vec => [-v[0], -v[1]], (v: Vec): Vec => [-v[0], -v[1]]],
    ] as const) {
      const { modelPcb, connectors } = modelScene(toModel, toDir);
      const r = registerModel({ modelPcb, outline, connectors, padGroups, padFrameY: "up" });
      expect(r.ok, name).toBe(true);
      if (!r.ok) continue;
      expect(r.registration.transform.seen_from_underside, name).toBe(false);
      expect(r.registration.openings.map((o) => [o.center, o.outward]), name).toEqual([[[0, 10], [-1, 0]], [[40, 20], [0, 1]]]);
    }
  });

  test("a model seen from the underside is found and marked", () => {
    const { modelPcb, connectors } = modelScene((v) => [50 - v[0], v[1]], (v) => [-v[0], v[1]]);
    const r = registerModel({ modelPcb, outline, connectors, padGroups, padFrameY: "up" });
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.registration.transform).toMatchObject({ reflected: true, seen_from_underside: true });
    expect(r.registration.openings[0]).toMatchObject({ center: [0, 10], outward: [-1, 0] });
  });

  test("the hold-out check measures each connector under a fit made without it", () => {
    const { modelPcb, connectors } = modelScene((v) => v, (v) => v);
    const r = registerModel({ modelPcb, outline, connectors, padGroups, padFrameY: "up" });
    if (!r.ok) throw new Error(r.reason);
    expect(r.registration.holdout.map((h) => h.ref)).toEqual(["X6", "CONN1", "J9"]);
    expect(r.registration.holdout.every((h) => h.distance_mm <= 1.5)).toBe(true);
  });

  test("one connector on the centre line of a board cannot tell left-right mirror images apart", () => {
    const r = registerModel({
      modelPcb: outline, outline, padFrameY: "up",
      connectors: [{ name: "USB_C", ref: "X6", center: [3, 10], openings: [] }],
      padGroups: [{ ref: "X6", center: [3, 10] }],
    });
    expect(r).toEqual({ ok: false, reason: "two orientations fit about equally (0 and 0 mm); the board is symmetric as far as its connectors show" });
  });

  test("the side of the board a connector is on settles a mirror image that positions cannot", () => {
    // Same centre-line connector as above. The CAD file puts it on top, and its housing is on the model's +Z face.
    const input = { modelPcb: outline, outline, padFrameY: "up" as const, connectors: [{ name: "USB_C", ref: "X6", center: [3, 10] as Vec, side: "above" as const, openings: [] }] };
    const top = registerModel({ ...input, padGroups: [{ ref: "X6", center: [3, 10], side: "top" }] });
    expect(top.ok).toBe(true);
    if (top.ok) expect(top.registration).toMatchObject({ side_evidence: 1, transform: { seen_from_underside: false, rotation_deg: 0 } });
    // On the bottom in the CAD file but above in the model: the model is seen from the underside.
    const bottom = registerModel({ ...input, padGroups: [{ ref: "X6", center: [3, 10], side: "bottom" }] });
    expect(bottom.ok).toBe(true);
    if (bottom.ok) expect(bottom.registration.transform.seen_from_underside).toBe(true);
  });

  test("a Y-down pad frame needs a reflection to hold a model seen from the top, and that is not the underside", () => {
    // KiCad: Y points down. The same board, top view, has pad (x, y) = model (x, 20 - y).
    const down: PadFeature[] = padGroups.map((g) => ({ ref: g.ref, center: [g.center[0], 20 - g.center[1]], side: "top" }));
    const { modelPcb, connectors } = modelScene((v) => v, (v) => v);
    const sided = connectors.map((c) => ({ ...c, side: "above" as const }));
    const r = registerModel({ modelPcb, outline, connectors: sided, padGroups: down, padFrameY: "down" });
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.registration).toMatchObject({ side_evidence: 3, feature_count: 3, transform: { reflected: true, seen_from_underside: false } });
    // The USB opening is still on the left edge; the JST's wall, y = 20 in the model, is y = 0 in this frame.
    expect(r.registration.openings.map((o) => [o.center, o.outward])).toEqual([[[0, 10], [-1, 0]], [[40, 0], [0, -1]]]);
    // Read as Y-up, the same data would be a board seen from below, and the side evidence would reject it.
    const wrong = registerModel({ modelPcb, outline, connectors: sided, padGroups: down, padFrameY: "up" });
    expect(wrong.ok).toBe(false);
  });

  test("connectors that disagree about the side leave the question to the positions", () => {
    const { modelPcb, connectors } = modelScene((v) => v, (v) => v);
    const sided = connectors.map((c) => ({ ...c, side: "above" as const }));
    const r = registerModel({ modelPcb, outline, padFrameY: "up", connectors: sided, padGroups: [{ ...padGroups[0]!, side: "top" }, { ...padGroups[1]!, side: "bottom" }, padGroups[2]!] });
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.registration).toMatchObject({ side_evidence: 0, transform: { seen_from_underside: false } });
  });

  test("one connector well off both centre lines is enough", () => {
    const r = registerModel({
      modelPcb: outline, outline, padFrameY: "up",
      connectors: [{ name: "JST", ref: "CONN1", center: [40, 16], openings: [] }],
      padGroups: [{ ref: "CONN1", center: [40, 16] }],
    });
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.registration.holdout).toEqual([]);
  });

  test("no shared connector name, no answer", () => {
    const r = registerModel({ modelPcb: outline, outline, padFrameY: "up", connectors: [{ name: "3X04", ref: null, center: [10, 10], openings: [] }], padGroups });
    expect(r).toEqual({ ok: false, reason: "no connector is named in both the model and the pad data, so nothing fixes the orientation" });
  });

  test("outlines of different sizes are not the same board", () => {
    const r = registerModel({ modelPcb: { min: [0, 0], max: [52.2, 22.8] }, outline, connectors: [], padGroups, padFrameY: "up" });
    expect(r).toEqual({ ok: false, reason: "the model's PCB is 52.2 x 22.8 mm and the outline is 50 x 20 mm; they are not the same board outline" });
  });

  test("connectors that land nowhere near the pad data's are refused", () => {
    const r = registerModel({
      modelPcb: outline, outline, padFrameY: "up",
      connectors: [{ name: "A", ref: "X6", center: [25, 2], openings: [] }, { name: "B", ref: "CONN1", center: [10, 18], openings: [] }],
      padGroups,
    });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.reason).toContain("no orientation puts the model's connectors on the pad data's");
  });

  test("a reference the model uses twice is not used as evidence, either time", () => {
    const r = registerModel({
      modelPcb: outline, outline, padFrameY: "up",
      connectors: [{ name: "A", ref: "CONN1", center: [40, 16], openings: [] }, { name: "B", ref: "CONN1", center: [5, 5], openings: [] }],
      padGroups,
    });
    // Neither CONN1 is evidence, so nothing is left to fix the orientation.
    expect(r).toEqual({ ok: false, reason: "no connector is named in both the model and the pad data, so nothing fixes the orientation" });
  });
});
