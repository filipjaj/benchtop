import { describe, expect, test } from "bun:test";
import { layoutEnclosure } from "./enclosure-layout";
import { resolveProject } from "./project";
import type { EnclosureSpec, PartDef, Project } from "./types";

const base = {
  kind: "board" as const,
  blurb: "test part",
  pins: [],
  electrical: {},
  sourcing: { search: ["x"], priceUsd: 1 },
  sources: ["test"],
  confidence: "typical" as const,
};

const mcu: PartDef = {
  ...base,
  id: "mcu",
  name: "Test MCU",
  body: { w: 22, d: 18, h: 1.6 },
  maxHeight: 5,
  ports: [{ name: "usb", faces: "y-", x: 11, y: 0, z: 1.6, w: 9, h: 3.2 }],
};
const sideways: PartDef = {
  ...base,
  id: "sideways",
  name: "Sideways MCU",
  body: { w: 30, d: 12, h: 1.6 },
  maxHeight: 5,
  // Socket on the short x- edge: the part must be turned to bring it to the y- wall.
  ports: [{ name: "usb", faces: "x-", x: 0, y: 6, z: 1.6, w: 9, h: 3.2 }],
};
const display: PartDef = {
  ...base,
  id: "display",
  kind: "display",
  name: "Test display",
  body: { w: 27, d: 27, h: 1.6 },
  maxHeight: 4,
  holes: [
    { x: 2, y: 2, dia: 2.2 },
    { x: 25, y: 2, dia: 2.2 },
    { x: 2, y: 25, dia: 2.2 },
    { x: 25, y: 25, dia: 2.2 },
  ],
  ports: [{ name: "screen", faces: "up", x: 13.5, y: 11, w: 22, h: 12 }],
};
const sensor: PartDef = { ...base, id: "sensor", kind: "sensor", name: "Test sensor", body: { w: 12, d: 10, h: 1.6 }, maxHeight: 3 };

const defs = new Map([mcu, sideways, display, sensor].map((d) => [d.id, d]));

function make(parts: [string, string][], spec: Partial<EnclosureSpec> & Pick<EnclosureSpec, "mounts">) {
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
  return layoutEnclosure(resolveProject(project, defs));
}

describe("layoutEnclosure", () => {
  test("cavity encloses every part with at least fit clearance", () => {
    const l = make(
      [
        ["m", "mcu"],
        ["s", "sensor"],
        ["d", "display"],
      ],
      {
        mounts: [
          { ref: "m", on: "floor", x: 0, y: 0 },
          { ref: "s", on: "floor", x: 0, y: 0 },
          { ref: "d", on: "lid", x: 0, y: 0 },
        ],
      },
    );
    const eps = 1e-6;
    expect(l.parts).toHaveLength(3);
    for (const p of l.parts) {
      const swap = p.at.rot === 90 || p.at.rot === 270;
      const w = swap ? p.def.body.d : p.def.body.w;
      const d = swap ? p.def.body.w : p.def.body.d;
      expect(p.at.x - l.wall).toBeGreaterThanOrEqual(l.fit - eps);
      expect(p.at.y - l.wall).toBeGreaterThanOrEqual(l.fit - eps);
      expect(l.wall + l.inner.w - (p.at.x + w)).toBeGreaterThanOrEqual(l.fit - eps);
      expect(l.wall + l.inner.d - (p.at.y + d)).toBeGreaterThanOrEqual(l.fit - eps);
      expect(p.at.z).toBeGreaterThanOrEqual(l.floor - eps);
      expect(l.floor + l.inner.h - (p.at.z + p.def.maxHeight)).toBeGreaterThanOrEqual(l.fit - eps);
    }
    expect(l.outer).toEqual({ w: l.inner.w + 4, d: l.inner.d + 4, h: l.inner.h + l.floor });
    expect(l.warnings).toEqual([]);
    // Display over the MCU needs the cavity to grow taller: MCU top + 6 mm wiring + display.
    const mcuTop = l.parts[0]!.at.z + 5;
    const dispBottom = l.parts[2]!.at.z;
    expect(dispBottom - mcuTop).toBeGreaterThanOrEqual(6 - 1e-6);
    expect(l.screws).toHaveLength(4);
  });

  test("a y- USB port gives an opening on the y- wall aligned with the port", () => {
    const l = make([["m", "mcu"]], { mounts: [{ ref: "m", on: "floor", x: 0, y: 0 }] });
    const p = l.parts[0]!;
    expect(p.at.rot).toBe(0);
    expect(p.at.y - l.wall).toBeCloseTo(l.fit, 6); // against the front wall
    expect(l.openings).toHaveLength(1);
    const o = l.openings[0]!;
    expect(o.face).toBe("y-");
    expect(o.ref).toBe("m");
    expect(o.port).toBe("usb");
    expect(o.u).toBeCloseTo(p.at.x + 11, 6);
    expect(o.v).toBeCloseTo(p.at.z + 1.6 + 1.6, 6);
    expect(o.w).toBeCloseTo(9 + 2 * 0.3, 6);
    expect(o.h).toBeCloseTo(3.2 + 2 * 0.3, 6);
  });

  test("a part whose socket faces x- is turned so the socket meets the y- wall", () => {
    const l = make([["m", "sideways"]], { mounts: [{ ref: "m", on: "floor", x: 0, y: 0 }] });
    const p = l.parts[0]!;
    expect(p.at.rot).toBe(90);
    expect(l.openings[0]!.face).toBe("y-");
    expect(l.warnings).toEqual([]);
  });

  test("a lid-mounted display gives a lid opening over its active area", () => {
    const l = make([["d", "display"]], { mounts: [{ ref: "d", on: "lid", x: 0, y: 0 }] });
    const p = l.parts[0]!;
    const o = l.openings.find((x) => x.face === "lid")!;
    expect(o).toBeDefined();
    expect(o.u).toBeCloseTo(p.at.x + 13.5, 6);
    expect(o.v).toBeCloseTo(p.at.y + 11, 6);
    expect(o.w).toBeCloseTo(22 + 0.6, 6);
    expect(o.h).toBeCloseTo(12 + 0.6, 6);
    // Four mounting holes give four hanging standoffs with the 2 mm pilot hole.
    const hung = l.standoffs.filter((s) => s.from === "lid");
    expect(hung).toHaveLength(4);
    expect(hung.every((s) => s.hole === 2)).toBe(true);
  });

  test("a side port in the middle of the cavity warns instead of making an opening", () => {
    const l = make([["m", "mcu"]], {
      inner: { w: 80, d: 80, h: 30 },
      mounts: [{ ref: "m", on: "floor", x: 30, y: 30 }],
    });
    expect(l.openings).toHaveLength(0);
    const w = l.warnings.find((x) => x.includes("usb") && x.includes("m (Test MCU)"));
    expect(w).toBeDefined();
  });

  test("explicit mount positions are kept", () => {
    const l = make(
      [
        ["m", "mcu"],
        ["s", "sensor"],
      ],
      {
        inner: { w: 90, d: 60, h: 25 },
        mounts: [
          { ref: "m", on: "floor", x: 40, y: 20, rot: 0 },
          { ref: "s", on: "floor", x: 10, y: 5 },
        ],
      },
    );
    expect(l.inner).toEqual({ w: 90, d: 60, h: 25 });
    expect(l.parts[0]!.at.x).toBeCloseTo(2 + 40, 6);
    expect(l.parts[0]!.at.y).toBeCloseTo(2 + 20, 6);
    expect(l.parts[1]!.at.x).toBeCloseTo(2 + 10, 6);
    expect(l.parts[1]!.at.y).toBeCloseTo(2 + 5, 6);
  });

  test("snap and slide lids warn and leave screws empty", () => {
    const l = make([["m", "mcu"]], { lid: "snap", mounts: [{ ref: "m", on: "floor", x: 0, y: 0 }] });
    expect(l.screws).toEqual([]);
    expect(l.warnings.some((w) => w.includes("snap") && w.includes("screw lid"))).toBe(true);
  });
});
