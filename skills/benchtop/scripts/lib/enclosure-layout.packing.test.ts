// Lid parts packed in two dimensions, the cable-exit exemption, parts that hang in the
// wiring, the one closed height, and the --explain text.

import { describe, expect, test } from "bun:test";
import { closedHeight, explainLayout, layoutEnclosure, type EnclosureLayout } from "./enclosure-layout";
import { resolveProject, type Loaded } from "./project";
import type { CustomOpening, EnclosureSpec, PartDef, Project } from "./types";

const base = {
  blurb: "test part",
  electrical: {},
  sourcing: { search: ["x"], priceUsd: 1 },
  sources: ["test"],
  confidence: "typical" as const,
  pins: [],
};

const board: PartDef = {
  ...base,
  id: "board",
  kind: "board",
  name: "Test board",
  body: { w: 40, d: 20, h: 1.6 },
  maxHeight: 4,
  ports: [{ name: "usb", faces: "y-", x: 20, y: 0, z: 1.6, w: 9, h: 3.2 }],
};
/** A small lid part with a window and no reach, 20 x 15 mm. */
const small = (id: string, w = 20, d = 15): PartDef => ({
  ...base,
  id,
  kind: "display",
  name: id,
  body: { w, d, h: 1.6 },
  maxHeight: 3,
  ports: [{ name: "window", faces: "up", x: w / 2, y: d / 2, w: w / 2, h: d / 2 }],
});
const resistor: PartDef = { ...base, id: "resistor", kind: "passive", name: "Resistor", body: { w: 6, d: 2, h: 2 }, maxHeight: 2 };
const probe: PartDef = { ...base, id: "probe", kind: "sensor", name: "Probe", body: { w: 10, d: 10, h: 1.6 }, maxHeight: 3 };

const deep: PartDef = { ...board, id: "deep", name: "Deep board", body: { w: 30, d: 40, h: 1.6 } };

const defs = new Map([board, deep,small("s1"), small("s2"), small("s3"), small("s4"), small("s5"), small("bar", 50, 10), resistor, probe].map((d) => [d.id, d]));

function loadedOf(parts: [string, string][], spec: Partial<EnclosureSpec> & Pick<EnclosureSpec, "mounts">): Loaded {
  const project: Project = {
    schema: 1,
    slug: "t",
    name: "T",
    tagline: "t",
    summary: "t",
    build: { path: "wire", difficulty: 1, minutes: 1 },
    power: { source: "usb", volts: 5, budgetMa: 500 },
    parts: parts.map(([ref, part]) => ({ ref, part })),
    connections: [],
    enclosure: { wall: 2, fit: 0.3, radius: 3, lid: "screw", openings: "auto", material: "PLA", color: "#fff", ...spec },
  };
  return resolveProject(project, defs);
}
const make = (parts: [string, string][], spec: Partial<EnclosureSpec> & Pick<EnclosureSpec, "mounts">): EnclosureLayout =>
  layoutEnclosure(loadedOf(parts, spec));
const auto = (ref: string, on: "floor" | "lid") => ({ ref, on, x: 0, y: 0 });

describe("lid parts are packed in two dimensions", () => {
  const lidParts: [string, string][] = [
    ["s1", "s1"],
    ["s2", "s2"],
    ["s3", "s3"],
    ["s4", "s4"],
    ["s5", "s5"],
  ];
  const l = make([["b", "board"], ...lidParts], { mounts: [auto("b", "floor"), ...lidParts.map(([r]) => auto(r, "lid"))] });

  test("five lid parts do not make a one-row case", () => {
    // One row of five 20 mm parts would need 100 mm plus margins; packed over a 40 x 20 board plus beside it they need far less.
    expect(l.inner.w).toBeLessThan(75);
    expect(l.inner.d).toBeLessThan(75);
    expect(l.warnings).toEqual([]);
  });

  test("lid parts neither overlap each other nor the corner bosses, and stay inside", () => {
    const lid = l.parts.filter((p) => p.use.ref !== "b");
    const rect = (p: (typeof lid)[number]) => ({ x: p.at.x - l.wall, y: p.at.y - l.wall, w: p.def.body.w, d: p.def.body.d });
    for (const p of lid) {
      const r = rect(p);
      expect(r.x).toBeGreaterThanOrEqual(l.fit - 1e-6);
      expect(r.y).toBeGreaterThanOrEqual(l.fit - 1e-6);
      expect(r.x + r.w).toBeLessThanOrEqual(l.inner.w - l.fit + 1e-6);
      expect(r.y + r.d).toBeLessThanOrEqual(l.inner.d - l.fit + 1e-6);
      for (const q of lid) {
        if (q === p) continue;
        const o = rect(q);
        const apart = r.x >= o.x + o.w || o.x >= r.x + r.w || r.y >= o.y + o.d || o.y >= r.y + r.d;
        expect(apart).toBe(true);
      }
    }
  });

  test("the floor part sets the footprint when the lid parts fit over it", () => {
    const one = make(
      [
        ["b", "board"],
        ["s1", "s1"],
      ],
      { mounts: [auto("b", "floor"), auto("s1", "lid")] },
    );
    const floorOnly = make([["b", "board"]], { mounts: [auto("b", "floor")] });
    expect(one.inner.w).toBeCloseTo(floorOnly.inner.w, 6);
    expect(one.inner.d).toBeCloseTo(floorOnly.inner.d, 6);
  });

  test("a long lid part uses the width between the corner bosses instead of widening the case", () => {
    const withBar = make(
      [
        ["b", "deep"],
        ["bar", "bar"],
      ],
      { mounts: [auto("b", "floor"), auto("bar", "lid")] },
    );
    // 50 mm bar over a 40 mm deep board: the bar sits between the bosses with 1.8 mm margins, so the old 50 + 2 x 6.3 is not needed.
    expect(withBar.inner.w).toBeLessThan(50 + 2 * 6.3);
    expect(withBar.warnings).toEqual([]);
  });

  test("explicit positions are untouched", () => {
    const fixed = make(
      [
        ["b", "board"],
        ["s1", "s1"],
      ],
      { mounts: [{ ref: "b", on: "floor", x: 8, y: 1.5 }, { ref: "s1", on: "lid", x: 30, y: 20 }] },
    );
    expect(fixed.parts[0]!.at.x).toBeCloseTo(2 + 8, 6);
    expect(fixed.parts[1]!.at.x).toBeCloseTo(2 + 30, 6);
    expect(fixed.parts[1]!.at.y).toBeCloseTo(2 + 20, 6);
    expect(fixed.inner.w).toBeCloseTo(Math.ceil((30 + 20 + 1.8) * 10 - 1e-9) / 10, 6);
  });
});

describe("the not-mounted warning and cable exits", () => {
  const parts: [string, string][] = [
    ["b", "board"],
    ["p", "probe"],
  ];
  const window: CustomOpening = { face: "lid", u: 20, v: 15, w: 8, h: 4, shape: "rect", label: "light window" };
  const exit: CustomOpening = { face: "x+", u: 14, v: 9, w: 5, h: 5, shape: "round", label: "probe cable", cableFor: ["p"] };
  const notMounted = (l: EnclosureLayout): boolean => l.warnings.some((w) => w.includes("is not mounted in the case"));

  test("an unrelated window does not answer the warning", () => {
    expect(notMounted(make(parts, { mounts: [auto("b", "floor")], extraOpenings: [window] }))).toBe(true);
    expect(notMounted(make(parts, { mounts: [auto("b", "floor")], openings: [{ ref: "b", port: "usb" }, window] }))).toBe(true);
  });

  test("a cable exit that names the part answers it, in extraOpenings or in the openings list", () => {
    expect(notMounted(make(parts, { mounts: [auto("b", "floor")], extraOpenings: [exit] }))).toBe(false);
    expect(notMounted(make(parts, { mounts: [auto("b", "floor")], openings: [{ ref: "b", port: "usb" }, exit] }))).toBe(false);
  });

  test("a cable exit for another part does not answer it", () => {
    expect(notMounted(make(parts, { mounts: [auto("b", "floor")], extraOpenings: [{ ...exit, cableFor: ["other"] }] }))).toBe(true);
  });

  test("the warning names both fixes", () => {
    const w = make(parts, { mounts: [auto("b", "floor")] }).warnings.find((x) => x.startsWith("p "))!;
    expect(w).toContain("cableFor");
    expect(w).toContain('"on": "wire"');
  });
});

describe('mounts: { ref, on: "wire" }', () => {
  const parts: [string, string][] = [
    ["b", "board"],
    ["r", "resistor"],
  ];
  const l = make(parts, { mounts: [auto("b", "floor"), { ref: "r", on: "wire" }] });

  test("is accepted without a warning", () => {
    expect(l.warnings).toEqual([]);
  });

  test("gets no placement, posts or hardware", () => {
    expect(l.parts.map((p) => p.use.ref)).toEqual(["b"]);
    expect(l.standoffs.every((s) => s.from === "floor")).toBe(true);
    expect(l.hardware.some((h) => h.use.startsWith("r "))).toBe(false);
    const alone = make([["r", "resistor"]], { mounts: [{ ref: "r", on: "wire" }] });
    expect(alone.parts).toEqual([]);
    expect(alone.standoffs).toEqual([]);
  });

  test("does not change the cavity", () => {
    const without = make([["b", "board"]], { mounts: [auto("b", "floor")] });
    expect(l.inner).toEqual(without.inner);
  });

  test("a part mounted and on the wire warns about the second entry", () => {
    const twice = make(parts, { mounts: [auto("b", "floor"), auto("r", "floor"), { ref: "r", on: "wire" }] });
    expect(twice.warnings.some((w) => w.includes("mounted twice"))).toBe(true);
  });
});

describe("closed height", () => {
  test("is the body plus the lid plate, from one function", () => {
    const l = make([["b", "board"]], { mounts: [auto("b", "floor")] });
    expect(closedHeight(l)).toBeCloseTo(l.outer.h + l.lidThickness, 6);
    expect(closedHeight(l)).toBeGreaterThan(l.outer.h);
  });
});

describe("--explain text", () => {
  const loaded = loadedOf(
    [
      ["b", "board"],
      ["s1", "s1"],
      ["r", "resistor"],
    ],
    { mounts: [auto("b", "floor"), auto("s1", "lid"), { ref: "r", on: "wire" }] },
  );
  const l = layoutEnclosure(loaded);
  const text = explainLayout(l, loaded).join("\n");

  test("states the coordinate systems, the keep-outs and the closed height", () => {
    expect(text).toContain("INNER front-left corner");
    expect(text).toContain("OUTER coordinates");
    expect(text).toContain("corner screw bosses");
    expect(text).toContain(`closed height ${closedHeight(l)} mm`);
    expect(text).toContain("r (Resistor) hangs in the wiring");
  });

  test("the printed mount lines pin every part exactly where the layout put it", () => {
    const mounts = [...text.matchAll(/^ {4}(\{ "ref".*\})$/gm)].map((m) => JSON.parse(m[1]!) as EnclosureSpec["mounts"][number]);
    expect(mounts).toHaveLength(2);
    const pinned = layoutEnclosure(
      loadedOf(
        [
          ["b", "board"],
          ["s1", "s1"],
          ["r", "resistor"],
        ],
        { mounts: [...mounts, { ref: "r", on: "wire" }], inner: l.inner },
      ),
    );
    for (const p of l.parts) {
      const q = pinned.parts.find((x) => x.use.ref === p.use.ref)!;
      expect(q.at.x).toBeCloseTo(p.at.x, 1);
      expect(q.at.y).toBeCloseTo(p.at.y, 1);
      expect(q.at.rot).toBe(p.at.rot);
    }
  });
});
