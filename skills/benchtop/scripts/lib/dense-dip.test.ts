// Synthetic rendering stress fixture, not a dimensioned purchasable part. This
// reproduces the narrow lead tabs of the original DIP-14 guide failure without
// relying on mutable library parts or asserting that drawing dimensions are exact.
import { describe, expect, test } from "bun:test";
import { buildGuide } from "../guide";
import { bubbleProblems, checkWiringStep } from "./drawing-check";
import { BOARD, project } from "./drawing-fixtures";
import { proj, solderPoint } from "./iso";
import { resolveProject } from "./project";
import { benchFrame, wiringStepArt } from "./scenes";
import type { PartDef, Placement } from "./types";

const names = ["1OE", "1A", "1Y", "2OE", "2A", "2Y", "GND", "3Y", "3A", "3OE", "4Y", "4A", "4OE", "VCC"];
const DIP: PartDef = {
  id: "synthetic-dip14", name: "Synthetic DIP fixture", kind: "connector", blurb: "Renderer test only",
  body: { w: 7.62, d: 19.3, h: 5.08 }, maxHeight: 5.08,
  pins: names.map((name, i) => ({ name, role: "passive", x: i < 7 ? 0 : 7.62, y: 2.03 + (i < 7 ? i : 13 - i) * 2.54, z: -3, lead: 3.18 })),
  electrical: {}, sourcing: { search: [], priceUsd: 0 }, sources: [], confidence: "typical",
};

const load = (rot: NonNullable<Placement["rot"]>, dip = DIP) => resolveProject(project(
  [{ ref: "mcu", part: BOARD.id, label: "Controller" }, { ref: "chip", part: dip.id, label: "DIP-14", bench: { x: 40, y: 0, rot } }],
  dip.pins.map((p) => ({ from: "mcu.10", to: `chip.${p.name}` })),
), new Map([[BOARD.id, BOARD], [dip.id, dip]]));

describe("dense DIP detail labels", () => {
  for (const rot of [0, 90, 180, 270] as const) {
    test(`every DIP lead is identified without changing geometry at ${rot} degrees`, () => {
      const before = JSON.stringify(DIP);
      const loaded = load(rot);
      const frame = benchFrame(loaded);
      let callouts = 0;
      for (let i = 0; i < DIP.pins.length; i++) {
        const art = wiringStepArt(loaded, i, frame);
        expect(bubbleProblems(art.geom)).toEqual([]);
        // Main-view occlusion remains a real finding; a readable inset must not
        // silently erase it. No missing, crossed or overlapping inset label remains.
        expect(checkWiringStep(art.geom).filter((p) => p.check !== "wire-end-hidden")).toEqual([]);
        const bubble = art.geom.bubbles.find((b) => b.target.ref === "chip")!;
        // Ghosted solids paint last, so drawing order may differ; the complete
        // multiset of part/pin/world-position tuples must still be identical.
        const pads = (items: typeof bubble.geom.pads) => items.map((p) => JSON.stringify([p.part, p.pin, p.at])).sort();
        expect(pads(bubble.geom.pads)).toEqual(pads(art.geom.main.pads));
        const pad = bubble.geom.pads.find((p) => p.part === "chip" && p.pin === DIP.pins[i]!.name)!;
        const actual = solderPoint(loaded.byRef.get("chip")!, DIP.pins[i]!.name);
        expect(pad.at).toEqual(actual);
        expect(bubble.target.at).toEqual(actual);
        const label = bubble.geom.labels.find((l) => l.part === "chip" && l.pin === DIP.pins[i]!.name)!;
        expect(label.text).toBe(DIP.pins[i]!.name);
        expect(label.quad.every((p) => Math.hypot(p[0] - pad.screen[0], p[1] - pad.screen[1]) <= bubble.radius / bubble.zoom)).toBe(true);
        if (bubble.detailCallout) {
          callouts++;
          expect(bubble.detailCallout.anchor).toEqual(proj(...actual));
          expect(art.svg).toContain(`data-detail-callout="chip.${DIP.pins[i]!.name}"`);
          expect(bubble.geom.labels).toHaveLength(1);
        }
      }
      expect(callouts).toBeGreaterThan(0);
      expect(JSON.stringify(DIP)).toBe(before);
    }, 30_000);
  }

  test("the generated guide uses the detail and still reports actual main-view occlusion", async () => {
    const guide = await buildGuide(load(0));
    expect(guide.html).toContain('data-detail-callout="chip.1OE"');
    expect(guide.findings.filter((f) => f.check === "label-missing")).toEqual([]);
    // Changed 2026-11-14: main-view occlusion is still reported, but as a note ("drawn through the
    // part, nothing to fix"), not a strict finding, when no turn shows the pad without hiding another.
    expect(guide.findings.some((f) => f.check === "wire-end-hidden" && f.part === "chip")).toBe(false);
    expect(guide.notes.some((f) => f.check === "wire-end-hidden" && f.part === "chip" && f.level === "note")).toBe(true);
  }, 30_000);

  test("a name too long for the inset fails visibly instead of shrinking text or changing the part", () => {
    const dip = structuredClone(DIP);
    dip.pins = [{ ...dip.pins[0]!, name: "EXCESSIVELY_LONG_PIN_NAME_THAT_CANNOT_FIT_IN_THE_DETAIL" }];
    const loaded = load(0, dip);
    const art = wiringStepArt(loaded, 0, benchFrame(loaded));
    const found = bubbleProblems(art.geom).find((p) => p.check === "label-missing");
    expect(found).toBeDefined();
    expect(found!.fix).toContain("fault in the renderer");
    expect(art.geom.bubbles.find((b) => b.target.ref === "chip")!.detailCallout).toBeUndefined();
  });
});
