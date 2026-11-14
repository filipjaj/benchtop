// What the renderer guarantees by construction, tested over ranges of input rather
// than on the example project: these are the properties the booklet relies on for
// parts and layouts nobody has drawn yet.

import { describe, expect, test } from "bun:test";
import { MAX_TURN, checkScene, checkWiringStep } from "./drawing-check";
import { BUTTON, DEFS, load } from "./drawing-fixtures";
import { type HoverItem, hoverShapes, planHover } from "./explode";
import { type V3, VIEW, backtrack, hiddenDepth, isHidden, overlapDepth, proj, sharpestTurn, textQuad, textWidth } from "./geom";
import { type Solid, WIRE_MIN, freeTextQuad, partSolids, pinWorld, renderScene, solderPoint, visibleSegments, wireCurve } from "./iso";
import { benchFrame, benchView, wiringStepArt } from "./scenes";
import type { PartDef } from "./types";

const box = (x: number, y: number, z: number, w: number, d: number, h: number, extra: Partial<Solid> = {}): Solid => ({ kind: "box", x, y, z, w, d, h, ...extra });

describe("what hides what", () => {
  const block = box(0, 0, 0, 10, 10, 5);

  test("a point keeps its place on the page when moved along the view direction", () => {
    const p: V3 = [3, 7, 2];
    const q: V3 = [p[0] + VIEW[0] * 4, p[1] + VIEW[1] * 4, p[2] + VIEW[2] * 4];
    expect(proj(...q)[0]).toBeCloseTo(proj(...p)[0], 9);
    expect(proj(...q)[1]).toBeCloseTo(proj(...p)[1], 9);
  });

  test("a point on a solid's own surface is not hidden by it; a point behind or inside it is", () => {
    expect(hiddenDepth([5, 5, 5], block)).toBe(0);
    expect(hiddenDepth([10, 5, 2], block)).toBe(0);
    expect(hiddenDepth([5, 10, 2], block)).toBe(0);
    expect(hiddenDepth([-1, -1, 1], block)).toBeGreaterThan(1);
    expect(hiddenDepth([5, 5, 2], block)).toBeGreaterThan(1);
    // Beside, in front of and above the block.
    expect(isHidden([12, 12, 0], [block])).toBe(false);
    expect(isHidden([5, 5, 9], [block])).toBe(false);
    expect(isHidden([-8, 6, 0], [block])).toBe(false);
  });

  test("a cylinder hides what is behind its round outline, not the corners of its box", () => {
    const can: Solid = { kind: "cyl", x: 0, y: 0, z: 0, w: 10, d: 10, h: 12, r: 5 };
    expect(isHidden([-2, -2, 1], [can])).toBe(true);
    // Behind the corner of the bounding box, where there is no cylinder.
    expect(isHidden([-4, 4.5, 1], [can])).toBe(false);
    expect(isHidden([-4, 4.5, 1], [{ ...can, kind: "box" }])).toBe(true);
  });

  test("a line is cut exactly where it goes behind a solid", () => {
    // Straight down from 20 mm above the far corner of the block to the bench behind it.
    const runs = visibleSegments([0, 0, 25], [0, 0, 0], [block]);
    expect(runs).toHaveLength(1);
    expect(runs[0]![0]).toEqual([0, 0, 25]);
    // It disappears where the line of sight first meets the block's top edge.
    expect(runs[0]![1][2]).toBeCloseTo(5, 1);
    expect(visibleSegments([10, 10, 25], [10, 10, 0], [block])).toHaveLength(1);
    expect(visibleSegments([0, 0, 4], [0, 0, 0], [block])).toEqual([]);
  });
});

describe("wires", () => {
  test("no wire doubles back, whatever the positions of its two pads", () => {
    let worst = 0;
    let cases = 0;
    for (const dist of [2.54, 4, 7, 10, 14, 20, 40, 80, 150]) {
      for (let ang = 0; ang < 360; ang += 5) {
        for (const dz of [0, 1.6, -1.6, 8, -8, 25]) {
          for (const lift of [4, 6, 9, 12, 20, 38]) {
            const a: V3 = [0, 0, 2];
            const b: V3 = [Math.cos((ang * Math.PI) / 180) * dist, Math.sin((ang * Math.PI) / 180) * dist, 2 + dz];
            const pa = proj(...a);
            const pb = proj(...b);
            // Ends closer than this on the page are reported by the drawing check instead.
            if (Math.hypot(pb[0] - pa[0], pb[1] - pa[1]) < WIRE_MIN) continue;
            const c = wireCurve(a, b, lift);
            cases++;
            worst = Math.max(worst, sharpestTurn(c.path, 1.5));
            expect(backtrack(c.path)).toBeLessThan(1e-9);
            expect(c.path[0]).toEqual(pa);
            expect(c.path[c.path.length - 1]![0]).toBeCloseTo(pb[0], 9);
          }
        }
      }
    }
    expect(cases).toBeGreaterThan(20000);
    // Well inside the limit the drawing check enforces.
    expect(worst).toBeLessThan(MAX_TURN - 15);
  });

  test("a wire is held above its pads in space, so it passes over low components instead of behind them", () => {
    const c = wireCurve([20, 45, 1], [0, 25, 1.6], 6);
    const top = Math.max(...c.path3.map((p) => p[2]));
    expect(top).toBeGreaterThan(4);
    expect(c.path3[0]).toEqual([20, 45, 1]);
  });

  test("the part of a wire behind a solid is not painted, and its hidden end gets no dot", () => {
    const post = box(-3, -3, 0, 6, 6, 30, { part: "sonar", tag: "can" });
    const behind: V3 = [-6, -6, 0];
    const r = renderScene({ solids: [post], wires: [{ a: [40, -6, 0], b: behind, color: "red", state: "now" }] });
    const w = r.geom.wires[0]!;
    expect(w.ends[0].dot).not.toBeNull();
    expect(w.ends[1].dot).toBeNull();
    // What was painted stops short of the hidden end.
    const last = w.runs[w.runs.length - 1]!;
    const end = last[last.length - 1]!;
    expect(Math.hypot(end[0] - w.ends[1].screen[0], end[1] - w.ends[1].screen[1])).toBeGreaterThan(0.5);
    expect(r.svg.match(/<circle/g)).toHaveLength(1);
  });

  test("a wire that would cut through a tall solid is lifted over it", () => {
    const tower = box(18, -4, 0, 4, 8, 14, { part: "relay", tag: "relay" });
    const r = renderScene({ solids: [tower], wires: [{ a: [0, 0, 0], b: [40, 0, 0], color: "red", state: "now" }] });
    expect(checkScene(r.geom)).toEqual([]);
    expect(Math.max(...r.geom.wires[0]!.path3.map((p) => p[2]))).toBeGreaterThan(14);
  });
});

describe("pin labels", () => {
  test("every label the renderer places is clear of pads, shapes, wires and other labels, at every rotation", () => {
    for (const id of ["button", "display", "sensor", "board"]) {
      for (const rot of [0, 90, 180, 270] as const) {
        const def = DEFS.get(id)!;
        const p = { use: { ref: id, part: id }, def, at: { x: 0, y: 0, z: 0, rot } };
        const target = def.pins[1]!.name;
        const at = solderPoint(p, target);
        const r = renderScene({
          solids: partSolids(p, { targets: [target], leads: true }),
          wires: [{ a: at, b: [at[0] + 30, at[1] + 40, 0], color: "red", state: "now", ends: [{ ref: id, pin: target }, { ref: "x", pin: "y" }] }],
        });
        const found = checkScene(r.geom).filter((f) => f.check.startsWith("label"));
        expect(found).toEqual([]);
      }
    }
  });

  test("text boxes are never narrower than the words they stand for", () => {
    // Advance widths of these words in Helvetica Bold, in ems. The estimate may be wider, never narrower.
    const measured: [string, number][] = [["GND", 2.222], ["3V3", 1.779], ["GPIO10", 3.613], ["Air sensor", 4.96], ["SDA", 2.111], ["VCC", 2.111]];
    for (const [word, em] of measured) expect(textWidth(word, 1)).toBeGreaterThanOrEqual(em);
    const quad = textQuad([10, 10], [1, 0], [0, 1], "GND", 2, "end");
    expect(Math.max(...quad.map((q) => q[0]))).toBe(10);
    expect(freeTextQuad({ text: "GND", at: [10, 10], anchor: "middle", size: 2 })[0]![0]).toBeCloseTo(10 - textWidth("GND", 2) / 2, 9);
  });
});

describe("the bench as the booklet draws it", () => {
  const wires = [{ from: "mcu.10", to: "btn.1" }, { from: "btn.2", to: "mcu.GND" }];

  // Changed 2026-11-14: a part is never turned when its bench gives rot; x and y alone still allow the automatic turn.
  test("a part the project placed itself, with its rot, is never turned", () => {
    const pinned = load([{ ref: "mcu", part: "board" }, { ref: "btn", part: "button", bench: { x: 40, y: 0, rot: 0 } }], wires);
    expect(benchView(pinned).byRef.get("btn")!.at).toEqual(pinned.byRef.get("btn")!.at);
  });

  test("a free part is turned until none of its wired pins is behind its own shapes", () => {
    const free = load([{ ref: "mcu", part: "board" }, { ref: "btn", part: "button" }], wires);
    const view = benchView(free);
    const btn = view.byRef.get("btn")!;
    const solids = view.placed.flatMap((p) => partSolids(p, { labels: false, leads: true }));
    for (const pin of ["1", "2"]) expect(isHidden(solderPoint(btn, pin), solids)).toBe(false);
    // Turned about its own centre: the outline stays where the layout put it.
    const before = free.byRef.get("btn")!;
    expect(btn.at.x + BUTTON.body.d / 2).toBeCloseTo(before.at.x + BUTTON.body.w / 2, 9);
    // The view is computed once and is its own view.
    expect(benchView(free)).toBe(view);
    expect(benchView(view)).toBe(view);
  });

  test("every step of a small build passes the whole drawing check", () => {
    const loaded = load(
      [
        { ref: "mcu", part: "board", label: "Controller" },
        { ref: "oled", part: "display", label: "Display" },
        { ref: "env", part: "sensor", label: "Air sensor" },
        { ref: "btn", part: "button", label: "Button" },
      ],
      [
        { from: "mcu.3V3", to: "oled.VCC" },
        { from: "mcu.GND", to: "oled.GND" },
        { from: "oled.VCC", to: "env.VCC" },
        { from: "oled.SDA", to: "env.SDA" },
        { from: "mcu.10", to: "btn.1" },
        { from: "btn.2", to: "mcu.GND" },
      ],
    );
    const frame = benchFrame(loaded);
    loaded.project.connections.forEach((_, i) => {
      const art = wiringStepArt(loaded, i, frame);
      expect(checkWiringStep(art.geom)).toEqual([]);
      // Bubbles and captions never overlap, whatever the labels.
      expect(Math.abs(art.geom.bubbles[0]!.centre[0] - art.geom.bubbles[1]!.centre[0])).toBeGreaterThanOrEqual(2 * art.geom.bubbles[0]!.radius);
    });
  });

  test("a lead is drawn only as long as it takes to be seen, and never longer than the part file allows", () => {
    // An axial resistor: a lead out of each end, half way up the body.
    const resistor = (lead?: number): PartDef => ({
      ...BUTTON,
      id: "resistor",
      body: { w: 10, d: 2.3, h: 2.3 },
      shapes: [],
      pins: [
        { name: "1", role: "passive", x: 0, y: 1.15, z: -1.15, lead },
        { name: "2", role: "passive", x: 10, y: 1.15, z: -1.15, lead },
      ],
    });
    const place = (def: PartDef) => ({ use: { ref: "r1", part: "resistor" }, def, at: { x: 0, y: 0, z: 0, rot: 0 as const } });
    const seen = (def: PartDef, pin: string): boolean => !isHidden(solderPoint(place(def), pin), partSolids(place(def), { labels: false, leads: true }));
    // With 20 mm of lead, the far end is drawn out past the body's shadow; the near end stays short.
    const long = partSolids(place(resistor(20)), { labels: false, leads: true });
    expect(seen(resistor(20), "1")).toBe(true);
    expect(seen(resistor(20), "2")).toBe(true);
    expect(long.find((s) => s.tag === "lead 1")!.w).toBeGreaterThan(1.4);
    expect(long.find((s) => s.tag === "lead 1")!.w).toBeLessThan(5);
    expect(long.find((s) => s.tag === "lead 2")!.w).toBeCloseTo(1.4, 9);
    // With no length given, a lead is a short leg, and the far one stays behind the body.
    expect(seen(resistor(), "1")).toBe(false);
    expect(seen(resistor(), "2")).toBe(true);
    // The wire ends where the pad is drawn.
    const pad = long.find((s) => s.tag === "lead 1")!;
    expect(solderPoint(place(resistor(20)), "1")).toEqual([pad.x + pad.pads![0]!.x, pad.y + pad.pads![0]!.y, pad.z + pad.h]);
  });

  test("a pin without a z stays a pad on the top face, exactly where pinWorld puts it", () => {
    const p = { use: { ref: "btn", part: "button" }, def: BUTTON, at: { x: 3, y: 4, z: 0, rot: 90 as const } };
    expect(solderPoint(p, "1")).toEqual(pinWorld(p, "1"));
  });
});

describe("exploded steps", () => {
  const item = (id: string, x: number, y: number, w: number, d: number, h = 2): HoverItem => ({ id, label: id, solids: [box(x, y, 2, w, d, h, { part: id })] });

  test("no two hovering parts or names overlap, for parts packed tightly in any arrangement", () => {
    // A deterministic spread of sizes and positions on a 6 mm grid, edge to edge.
    for (let seed = 1; seed <= 40; seed++) {
      const items: HoverItem[] = [];
      for (let i = 0; i < 2 + (seed % 5); i++) {
        const w = 5 + ((seed * 7 + i * 11) % 25);
        const d = 5 + ((seed * 13 + i * 5) % 25);
        items[i] = item(`part-${i}`, i * 6 + ((seed * 3) % 9), ((seed + i * 17) % 4) * 6, w, d, 1 + ((seed + i) % 9));
      }
      const groups = planHover(items, { base: 22, max: 62 });
      expect(groups.flat().map((p) => p.item.id).sort()).toEqual(items.map((it) => it.id).sort());
      for (const group of groups) {
        const shapes = group.map((p) => [...hoverShapes(p.item, p.dz), ...(p.text ? [freeTextQuad(p.text)] : [])]);
        for (let a = 0; a < shapes.length; a++) {
          for (let b = a + 1; b < shapes.length; b++) {
            for (const s of shapes[a]!) for (const t of shapes[b]!) expect(overlapDepth(s, t)).toBeLessThanOrEqual(0);
          }
        }
        for (const p of group) expect(p.dz).toBeLessThanOrEqual(62);
      }
    }
  });

  test("parts that cannot all be kept apart under the height limit are split over more than one step", () => {
    // Five plates stacked one behind the other, each overlapping the next on the page.
    const items = [0, 1, 2, 3, 4].map((i) => item(`plate-${i}`, i * 3, i * 3, 40, 40));
    const groups = planHover(items, { base: 22, max: 30 });
    expect(groups.length).toBeGreaterThan(1);
    expect(groups.flat()).toHaveLength(5);
  });

  test("a name goes on the part when it fits there and beside it when it does not", () => {
    const [group] = planHover([item("Display", 0, 0, 30, 30), item("Button", 60, 0, 6, 6)], { base: 22, max: 62 });
    const byId = new Map(group!.map((p) => [p.item.id, p]));
    expect(byId.get("Display")!.text!.anchor).toBe("middle");
    expect(byId.get("Button")!.text!.anchor).not.toBe("middle");
  });
});
