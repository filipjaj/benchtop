// How the booklet places and looks at the bench: free parts never land on each other or on
// parts the project placed, colliding `bench` values are reported by name, each wiring step looks
// from the side that shows its pads, a pad no side shows is drawn through (a note, not a
// finding), and `--explain` prints values that can be pasted back unchanged.

import { describe, expect, test } from "bun:test";
import { buildGuide, explainLines } from "../guide";
import { benchOverlapProblems, checkWiringStep } from "./drawing-check";
import { BOARD, BUTTON, DISPLAY, SENSOR, load } from "./drawing-fixtures";
import { footprint } from "./iso";
import { benchArt, benchFrame, benchView, explainBench, wiringStepArt } from "./scenes";
import type { PartDef, PartUse } from "./types";

const kinds = [BOARD, DISPLAY, SENSOR, BUTTON];
const defs = new Map<string, PartDef>(kinds.map((d) => [d.id, d]));
const eight = (bench: (i: number) => PartUse["bench"]): PartUse[] =>
  Array.from({ length: 8 }, (_, i) => ({ ref: `p${i}`, part: kinds[i % 4]!.id, bench: bench(i) }));

function overlapping(parts: ReturnType<typeof load>["placed"]): string[] {
  const out: string[] = [];
  for (let i = 0; i < parts.length; i++) {
    for (let j = i + 1; j < parts.length; j++) {
      const a = parts[i]!;
      const b = parts[j]!;
      const fa = footprint(a);
      const fb = footprint(b);
      if (a.at.x < b.at.x + fb.w && b.at.x < a.at.x + fa.w && a.at.y < b.at.y + fb.d && b.at.y < a.at.y + fa.d) out.push(`${a.use.ref}/${b.use.ref}`);
    }
  }
  return out;
}

describe("automatic bench layout", () => {
  test("eight parts, boards and modules mixed, never overlap", () => {
    expect(overlapping(load(eight(() => undefined), [], defs).placed)).toEqual([]);
  });

  test("free parts keep clear of parts the project placed, whatever the placed ones are", () => {
    const placed = (i: number): PartUse["bench"] => (i === 0 ? { x: 0, y: 0 } : i === 3 ? { x: 30, y: 10, rot: 90 } : undefined);
    expect(overlapping(load(eight(placed), [], defs).placed)).toEqual([]);
    // Even when the placed part is where the free parts used to go.
    const middle = (i: number): PartUse["bench"] => (i === 5 ? { x: 40, y: 20 } : undefined);
    expect(overlapping(load(eight(middle), [], defs).placed)).toEqual([]);
  });
});

describe("bench values that collide", () => {
  test("the drawing check names both parts and says what to write", () => {
    const loaded = load(eight((i) => (i < 2 ? { x: 0, y: 0 } : undefined)), [], defs);
    const found = benchOverlapProblems(loaded.placed);
    expect(found).toHaveLength(1);
    expect(found[0]!.check).toBe("bench-overlap");
    expect(found[0]!.what).toContain("p0");
    expect(found[0]!.what).toContain("p1");
    expect(found[0]!.fix).toMatch(/"bench": \{ "x": [-\d.]+, "y": [-\d.]+ \}/);
  });

  test("parts that only sit side by side are not reported", () => {
    expect(benchOverlapProblems(load(eight(() => undefined), [], defs).placed)).toEqual([]);
  });
});

describe("one viewpoint for the whole booklet", () => {
  const parts: PartUse[] = [
    { ref: "mcu", part: "board" },
    { ref: "oled", part: "display" },
    { ref: "env", part: "sensor" },
    { ref: "btn", part: "button", bench: { x: 90, y: 0, rot: 0 } },
  ];
  const wires = [{ from: "mcu.10", to: "btn.1" }, { from: "btn.2", to: "oled.GND" }, { from: "env.VCC", to: "mcu.3V3" }, { from: "oled.SDA", to: "env.SDA" }];

  test("every step scene is drawn from the same side as the cover: each pad is at the same place in space", () => {
    const loaded = load(parts, wires);
    const cover = benchArt(loaded).geom.pads;
    const frame = benchFrame(loaded);
    loaded.project.connections.forEach((_, i) => {
      for (const p of wiringStepArt(loaded, i, frame).geom.main.pads) {
        const same = cover.find((q) => q.part === p.part && q.pin === p.pin)!;
        expect(p.at).toEqual(same.at);
        expect(p.screen).toEqual(same.screen);
      }
    });
  });

  test("a bench without rot is turned automatically like a free part; a bench with rot is respected", () => {
    const withRot = load([{ ref: "mcu", part: "board" }, { ref: "btn", part: "button", bench: { x: 40, y: 0, rot: 0 } }], [{ from: "mcu.10", to: "btn.1" }]);
    expect(benchView(withRot).byRef.get("btn")!.at.rot).toBe(0);
    const noRot = load([{ ref: "mcu", part: "board" }, { ref: "btn", part: "button", bench: { x: 40, y: 0 } }], [{ from: "mcu.10", to: "btn.1" }]);
    expect(benchView(noRot).byRef.get("btn")!.at.rot).not.toBe(0);
    // The project's own values are never changed by the view.
    expect(withRot.byRef.get("btn")!.at).toEqual({ x: 40, y: 0, z: 0, rot: 0 });
  });
});

describe("a pad that no side of the bench shows", () => {
  // A pad under a can that stands over it: hidden from every side, and no turn of the part helps.
  const COVERED: PartDef = {
    ...BUTTON,
    id: "covered",
    name: "Covered pad",
    body: { w: 10, d: 10, h: 1.6 },
    maxHeight: 8,
    shapes: [{ kind: "box", tag: "can", x: 1, y: 1, w: 8, d: 8, h: 6 }],
    pins: [{ name: "A", role: "passive", x: 5, y: 5 }, { name: "B", role: "passive", x: 9.5, y: 9.5 }],
  };
  const loaded = load(
    [{ ref: "mcu", part: "board", label: "Controller" }, { ref: "cv", part: "covered", label: "Covered" }],
    [{ from: "mcu.10", to: "cv.A" }],
    new Map([...defs, ["covered", COVERED]]),
  );

  test("is drawn through its dashed outline and reported as a note, not a finding", () => {
    const art = wiringStepArt(loaded, 0, benchFrame(loaded));
    const hidden = art.geom.hidden!.find((h) => h.ref === "cv" && h.pin === "A")!;
    expect(hidden).toBeDefined();
    expect(hidden.turn).toBeNull();
    const bubble = art.geom.bubbles.find((b) => b.target.ref === "cv")!;
    expect(bubble.seeThrough).toBe(true);
    expect(bubble.geom.solids.find((s) => s.solid.tag === "can")!.ghost).toBe(true);
    const found = checkWiringStep(art.geom);
    expect(found.filter((p) => p.level !== "note")).toEqual([]);
    const note = found.find((p) => p.check === "wire-end-hidden")!;
    expect(note.level).toBe("note");
    expect(note.fix).toContain("Nothing to fix");
  });
});

describe("--explain", () => {
  const parts: PartUse[] = [
    { ref: "mcu", part: "board" },
    { ref: "oled", part: "display" },
    { ref: "env", part: "sensor" },
    { ref: "btn", part: "button" },
  ];
  const wires = [{ from: "mcu.10", to: "btn.1" }, { from: "btn.2", to: "oled.GND" }, { from: "env.VCC", to: "mcu.3V3" }];

  test("prints a bench value for every part that gives the same drawing when pasted back", () => {
    const loaded = load(parts, wires);
    const printed = explainBench(loaded);
    const pasted = load(parts.map((p) => ({ ...p, bench: printed.find((e) => e.ref === p.ref)!.bench })), wires);
    const before = benchView(loaded);
    const after = benchView(pasted);
    for (const p of before.placed) {
      const q = after.byRef.get(p.use.ref)!;
      expect(q.at.x).toBeCloseTo(p.at.x, 1);
      expect(q.at.y).toBeCloseTo(p.at.y, 1);
      expect(q.at.rot).toBe(p.at.rot);
    }
    // And explaining the pasted project says the same again.
    expect(explainBench(pasted).map((e) => [e.ref, e.bench])).toEqual(printed.map((e) => [e.ref, e.bench]));
  });

  test("lists the lines a person reads: the bench value, and which pads a part hides and behind what", () => {
    const loaded = load(parts, wires);
    const lines = explainLines(loaded).join("\n");
    expect(lines).toContain("millimetres");
    for (const p of parts) expect(lines).toContain(`${p.ref} (${loaded.byRef.get(p.ref)!.def.id})  "bench": {`);
  });
});

describe("the inventory page", () => {
  test("a project with many parts spreads them over pages instead of running past the footer", async () => {
    // Forty different parts (the inventory groups equal ones): the list is cut by what it holds, not by a count.
    const many = new Map(Array.from({ length: 40 }, (_, i) => [`d${i}`, { ...kinds[i % 4]!, id: `d${i}` }] as const));
    const guide = await buildGuide(load(Array.from({ length: 40 }, (_, i) => ({ ref: `p${i}`, part: `d${i}` })), [], many));
    expect((guide.html.match(/class="inventory"/g) ?? []).length).toBeGreaterThan(1);
  });
});
