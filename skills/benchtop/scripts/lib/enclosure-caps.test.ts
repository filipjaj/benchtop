// Printed caps: a floor-mounted button on a tall post, with a captive cap over its stem.
// Found on a handheld console build, where nine bare 3.5 mm stems made a face nobody
// wanted to press.

import { describe, expect, test } from "bun:test";
import { DESIGN, explainLayout, layoutEnclosure } from "./enclosure-layout";
import { buildCaps, buildSolids, meshVolume, triMesh, type Jscad } from "./enclosure-solids";
import { resolveProject } from "./project";
import type { EnclosureSpec, PartDef, Project } from "./types";

const base = {
  blurb: "test part",
  electrical: {},
  sourcing: { search: ["x"], priceUsd: 1 },
  sources: ["test"],
  confidence: "typical" as const,
};
/** A 6 x 6 tactile switch: legs on the two x sides, a round stem `stem` mm tall. */
const tact = (id: string, stem: number): PartDef => ({
  ...base,
  id,
  kind: "input",
  name: `Switch ${stem}`,
  body: { w: 6.5, d: 6, h: 3.4 },
  maxHeight: 3.4 + stem,
  pins: [
    { name: "1", role: "passive", x: 0, y: 0.75 },
    { name: "2", role: "passive", x: 0, y: 5.25 },
    { name: "1b", role: "passive", x: 6.5, y: 0.75 },
    { name: "2b", role: "passive", x: 6.5, y: 5.25 },
  ],
  shapes: [{ kind: "cyl", x: 3.25, y: 3, r: 1.75, h: stem, tag: "button-cap" }],
  ports: [{ name: "button-cap", faces: "up", x: 3.25, y: 3, w: 3.5, h: 3.5, shape: "round", margin: 0.5, reach: true }],
});
const slab: PartDef = { ...base, id: "slab", kind: "board", name: "Slab", body: { w: 20, d: 20, h: 1.6 }, maxHeight: 4, pins: [] };
const defs = new Map([tact("tall", 6.1), tact("short", 4), slab].map((d) => [d.id, d]));

function make(parts: [string, string][], spec: Partial<EnclosureSpec> & Pick<EnclosureSpec, "mounts">) {
  const project: Project = {
    schema: 1,
    slug: "t",
    name: "T",
    tagline: "t",
    summary: "t",
    build: { path: "wire", joint: "solder", difficulty: 1, minutes: 1 },
    power: { source: "usb", volts: 5, budgetMa: 500 },
    parts: parts.map(([ref, part]) => ({ ref, part })),
    connections: [],
    enclosure: { wall: 2, fit: 0.3, radius: 3, lid: "screw", openings: "auto", material: "PLA", color: "#fff", inner: { w: 50, d: 40, h: 24 }, ...spec },
  };
  const loaded = resolveProject(project, defs);
  return { loaded, L: layoutEnclosure(loaded) };
}

describe("a capped button", () => {
  const { loaded, L } = make([["a", "tall"]], {
    mounts: [{ ref: "a", on: "floor", x: 20, y: 15, cap: { shape: "round", w: 10 } }],
  });
  const cap = L.caps[0]!;
  const seat = L.seats[0]!;
  const part = L.parts[0]!;
  const lidIn = L.outer.h;
  const lidOut = lidIn + L.lidThickness;

  test("no warnings", () => expect(L.warnings).toEqual([]));

  test("stands on one post from the floor and gets no standoffs", () => {
    expect(L.standoffs).toEqual([]);
    expect(L.seats).toHaveLength(1);
    expect(seat.z).toBeCloseTo(part.at.z, 6);
    // Stem tip ends reachProud above the lid, exactly as for a lid-mounted button.
    expect(part.at.z + 3.4 + 6.1).toBeCloseTo(lidOut + DESIGN.reachProud, 6);
  });

  test("the post stays between the legs and its lips are outside the body", () => {
    // Legs at x = 0 and 6.5 of the part, so the post is narrower than the body in x.
    expect(seat.x0).toBeCloseTo(part.at.x + DESIGN.seatLegClear, 6);
    expect(seat.x1).toBeCloseTo(part.at.x + 6.5 - DESIGN.seatLegClear, 6);
    expect(seat.y0).toBeLessThan(part.at.y);
    expect(seat.y1).toBeGreaterThan(part.at.y + 6);
    expect(seat.pocket!.y0).toBeCloseTo(part.at.y - DESIGN.seatFit, 6);
    expect(seat.zTop - seat.z).toBeCloseTo(DESIGN.seatLip, 6);
  });

  test("the cap is captive and free to move", () => {
    // The opening is the cap plus clearance, and the flange is wider than the opening.
    const o = L.openings.find((q) => q.ref === "a")!;
    expect(o.shape).toBe("round");
    expect(o.w).toBeCloseTo(10 + 2 * DESIGN.capClear, 6);
    expect(cap.fw).toBeGreaterThan(o.w + 1);
    // At rest the flange is below the lid and above the body of the switch, with travel to spare.
    expect(cap.zFlange).toBeLessThan(lidIn - 0.5);
    expect(cap.z0 - (part.at.z + 3.4)).toBeGreaterThanOrEqual(DESIGN.capTravel - 1e-9);
    // It rests on the tip of the stem and stands above the lid.
    expect(cap.zBore).toBeCloseTo(part.at.z + 9.5, 6);
    expect(cap.zTop - lidOut).toBeCloseTo(DESIGN.reachProud + DESIGN.capTop, 6);
  });

  test("--explain gives a mount line that carries the cap", () => {
    const text = explainLayout(L, loaded).join("\n");
    expect(text).toContain(`"cap": {"shape":"round","w":10}`);
    expect(text).toContain("10 mm round cap");
  });
});

describe("cap problems are reported", () => {
  test("a cap on a lid mount is left out, with the reason", () => {
    const { L } = make([["a", "tall"]], { mounts: [{ ref: "a", on: "lid", x: 20, y: 15, cap: { shape: "round", w: 10 } }] });
    expect(L.caps).toEqual([]);
    expect(L.warnings.join("\n")).toContain("has a cap but is mounted on the lid");
  });

  test("a stem too short to leave room for the flange", () => {
    const { L } = make([["a", "short"]], { mounts: [{ ref: "a", on: "floor", x: 20, y: 15, cap: { shape: "round", w: 10 } }] });
    expect(L.warnings.join("\n")).toContain("a cap's flange needs");
  });

  test("a cap too small for the stem", () => {
    const { L } = make([["a", "tall"]], { mounts: [{ ref: "a", on: "floor", x: 20, y: 15, cap: { shape: "round", w: 5 } }] });
    expect(L.warnings.join("\n")).toContain("too small to hold");
  });

  test("a floor part where the post goes", () => {
    const { L } = make(
      [
        ["a", "tall"],
        ["s", "slab"],
      ],
      { mounts: [{ ref: "a", on: "floor", x: 20, y: 15, cap: { shape: "round", w: 10 } }, { ref: "s", on: "floor", x: 12, y: 8 }] },
    );
    expect(L.warnings.join("\n")).toContain("is where the post goes");
    expect(L.seats).toEqual([]);
  });

  test("two caps whose flanges meet; a diagonal pair of round ones that do not", () => {
    const pair = (dx: number, dy: number) =>
      make(
        [
          ["a", "tall"],
          ["b", "tall"],
        ],
        {
          mounts: [
            { ref: "a", on: "floor", x: 10, y: 10, cap: { shape: "round", w: 10 } },
            { ref: "b", on: "floor", x: 10 + dx, y: 10 + dy, cap: { shape: "round", w: 10 } },
          ],
        },
      ).L.warnings.join("\n");
    expect(pair(11, 0)).toContain("run into each other");
    // 11.5 across and 8 up is 14 mm between centres: clear, though the bounding squares overlap.
    expect(pair(11.5, 8)).not.toContain("run into each other");
  });

  test("a rect cap keeps its flange to the ends of its long axis", () => {
    const { L } = make([["a", "tall"]], { mounts: [{ ref: "a", on: "floor", x: 20, y: 15, cap: { shape: "rect", w: 6.5, h: 7.5 } }] });
    const c = L.caps[0]!;
    expect(c.fh - c.h).toBeCloseTo(2 * DESIGN.capFlange, 6);
    expect(c.fw - c.w).toBeCloseTo(2 * DESIGN.capFlangeSide, 6);
  });
});

let J: Jscad | undefined;
try {
  const ns = await import("@jscad/modeling");
  J = ((ns as { default?: Jscad }).default ?? ns) as Jscad;
} catch {
  console.warn(`enclosure-caps.test.ts: solids skipped, JSCAD is not installed. Run: bun install --cwd "${import.meta.dir}/.."`);
}

describe.skipIf(!J)("cap and seat solids", () => {
  const { L } = make(
    [
      ["a", "tall"],
      ["u", "tall"],
    ],
    {
      mounts: [
        { ref: "a", on: "floor", x: 30, y: 20, cap: { shape: "round", w: 10 } },
        { ref: "u", on: "floor", x: 10, y: 10, cap: { shape: "rect", w: 6.5, h: 7.5 } },
      ],
    },
  );

  test("body, lid and every cap are watertight", () => {
    const s = buildSolids(J!, L);
    const open: Record<string, number> = { body: triMesh(J!, s.body).openEdges, lid: triMesh(J!, s.lidPrint).openEdges };
    for (const c of buildCaps(J!, L)) {
      open[`cap ${c.ref} print`] = triMesh(J!, c.print).openEdges;
      open[`cap ${c.ref} assembled`] = triMesh(J!, c.assembled).openEdges;
    }
    expect(Object.entries(open).filter(([, n]) => n > 0)).toEqual([]);
  });

  test("a cap prints flange down, as tall as it stands, and is mostly plastic", () => {
    const caps = buildCaps(J!, L);
    const round = triMesh(J!, caps[0]!.print);
    const zs = round.v.filter((_, i) => i % 3 === 2);
    const c = L.caps[0]!;
    // To a hundredth of a millimetre: triMesh snaps vertices to a grid.
    expect(Math.min(...zs)).toBeCloseTo(0, 2);
    expect(Math.max(...zs)).toBeCloseTo(c.zTop - c.z0, 2);
    // More than half of the cap's cylinder is left after the hole for the stem.
    const full = Math.PI * 5 * 5 * (c.zTop - c.z0);
    expect(meshVolume(round)).toBeGreaterThan(0.5 * full);
    expect(meshVolume(round)).toBeLessThan(1.2 * full);
  });

  test("the seat adds plastic to the body", () => {
    const withSeat = meshVolume(triMesh(J!, buildSolids(J!, L).body));
    const without = meshVolume(triMesh(J!, buildSolids(J!, { ...L, seats: [] }).body));
    expect(withSeat - without).toBeGreaterThan(500);
  });
});
