// Regression: the printable meshes must be watertight (every edge shared by exactly two
// triangles). Slicers refuse or silently mangle meshes with open edges. Needs the JSCAD
// packages; skipped with a message when they are not installed.

import { describe, expect, test } from "bun:test";
import { layoutEnclosure, type EnclosureLayout } from "./enclosure-layout";
import {
  buildFitSolids,
  buildSolids,
  fitChecklist,
  meshToGeom3,
  meshVolume,
  triMesh,
  type Jscad,
  type TriMesh,
} from "./enclosure-solids";
import { loadProject, resolveProject } from "./project";
import type { PartDef, Project } from "./types";

let J: Jscad | undefined;
try {
  const ns = await import("@jscad/modeling");
  J = ((ns as { default?: Jscad }).default ?? ns) as Jscad;
} catch {
  console.warn(`enclosure-solids.test.ts skipped: JSCAD is not installed. Run: bun install --cwd "${import.meta.dir}/.."`);
}

const base = {
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
  kind: "board",
  name: "Test MCU",
  body: { w: 18, d: 22.5, h: 1.2 },
  maxHeight: 4.3,
  ports: [{ name: "usb", faces: "y-", x: 9, y: 0, z: 1.6, w: 9, h: 3.2, margin: 1.5 }],
};
const display: PartDef = {
  ...base,
  id: "display",
  kind: "display",
  name: "Test display",
  body: { w: 27.3, d: 27.8, h: 1.6 },
  maxHeight: 3.1,
  holes: [
    { x: 2, y: 2, dia: 2 },
    { x: 25.3, y: 2, dia: 2 },
    { x: 2, y: 25.8, dia: 2 },
    { x: 25.3, y: 25.8, dia: 2 },
  ],
  ports: [{ name: "screen", faces: "up", x: 13.65, y: 15.4, w: 21.7, h: 10.9, margin: 0.5 }],
};
// No mounting holes: gets four corner posts, some of which land beside the round opening.
const button: PartDef = {
  ...base,
  id: "button",
  kind: "input",
  name: "Test button",
  body: { w: 6.5, d: 6, h: 3.5 },
  maxHeight: 5,
  ports: [{ name: "cap", faces: "up", x: 3.25, y: 3, w: 3.5, h: 3.5, shape: "round", margin: 0.5 }],
};
const sensor: PartDef = {
  ...base,
  id: "sensor",
  kind: "sensor",
  name: "Test sensor",
  body: { w: 15, d: 11.5, h: 1.6 },
  maxHeight: 2.5,
  ports: [{ name: "vent", faces: "up", x: 7.5, y: 7.25, w: 2.5, h: 2.5, shape: "round", margin: 1.5 }],
};

function layoutFor(lid: "screw" | "snap") {
  const defs = new Map([mcu, display, button, sensor].map((d) => [d.id, d]));
  const project: Project = {
    schema: 1,
    slug: "t",
    name: "T",
    tagline: "t",
    summary: "t",
    build: { path: "wire", difficulty: 1, minutes: 1 },
    power: { source: "usb", volts: 5, budgetMa: 500 },
    parts: [
      { ref: "m", part: "mcu" },
      { ref: "d", part: "display" },
      { ref: "b", part: "button" },
      { ref: "s", part: "sensor" },
    ],
    connections: [],
    enclosure: {
      wall: 2,
      fit: 0.3,
      radius: 3,
      lid,
      mounts: [
        { ref: "m", on: "floor", x: 0, y: 0 },
        { ref: "d", on: "lid", x: 0, y: 0 },
        { ref: "b", on: "lid", x: 0, y: 0 },
        { ref: "s", on: "lid", x: 0, y: 0 },
      ],
      openings: "auto",
      material: "PLA",
      color: "#f2efe8",
    },
  };
  return layoutEnclosure(resolveProject(project, defs));
}

/** Edge count computed here from the triangle list, independent of TriMesh.openEdges. */
function openEdgeCount(m: TriMesh): number {
  const count = new Map<string, number>();
  for (let i = 0; i < m.t.length; i += 3) {
    for (let e = 0; e < 3; e++) {
      const a = m.t[i + e]!;
      const b = m.t[i + ((e + 1) % 3)]!;
      const k = a < b ? `${a}|${b}` : `${b}|${a}`;
      count.set(k, (count.get(k) ?? 0) + 1);
    }
  }
  return [...count.values()].filter((c) => c !== 2).length;
}

describe("enclosure solids", () => {
  test.skipIf(!J)("body and lid are watertight with two lid parts and round openings", () => {
    const layout = layoutFor("screw");
    expect(layout.openings.filter((o) => o.face === "lid" && o.shape === "round").length).toBeGreaterThanOrEqual(2);
    expect(layout.standoffs.filter((s) => s.from === "lid" && s.hole === 0).length).toBeGreaterThan(0);
    const solids = buildSolids(J!, layout);
    for (const [name, g] of [
      ["body", solids.body],
      ["lid", solids.lidPrint],
    ] as const) {
      const m = triMesh(J!, g);
      expect(m.t.length / 3, `${name} triangles`).toBeGreaterThan(100);
      expect(openEdgeCount(m), `${name} open edges`).toBe(0);
      expect(m.openEdges).toBe(0);
      // The mesh the serializers receive is the repaired one.
      expect(J!.geometries.geom3.toPolygons(meshToGeom3(J!, m))).toHaveLength(m.t.length / 3);
    }
  });

  test.skipIf(!J)("the plain lid used for snap and slide is watertight too", () => {
    const solids = buildSolids(J!, layoutFor("snap"));
    expect(openEdgeCount(triMesh(J!, solids.body))).toBe(0);
    expect(openEdgeCount(triMesh(J!, solids.lidPrint))).toBe(0);
  });
});

const LID_REFS: ReadonlySet<string> = new Set(["d", "b", "s"]);

/** Vertices of a mesh as [x, y, z] triples. */
function vertices(m: TriMesh): [number, number, number][] {
  const out: [number, number, number][] = [];
  for (let i = 0; i < m.v.length; i += 3) out.push([m.v[i]!, m.v[i + 1]!, m.v[i + 2]!]);
  return out;
}

/** Is there a vertex at (x, y), at any height? Used to find opening corners. */
function hasVertexAt(vs: [number, number, number][], x: number, y: number): boolean {
  return vs.some((v) => Math.hypot(v[0] - x, v[1] - y) < 0.02);
}

/** Is there a vertex at height z on the rim of a post of the given diameter? */
function hasTopAt(vs: [number, number, number][], x: number, y: number, dia: number, z: number): boolean {
  return vs.some((v) => Math.abs(v[2] - z) < 0.02 && Math.abs(Math.hypot(v[0] - x, v[1] - y) - dia / 2) < 0.05);
}

function checkOpenings(L: EnclosureLayout, full: TriMesh, fit: TriMesh): void {
  const lidOpenings = L.openings.filter((o) => o.face === "lid");
  expect(lidOpenings.length).toBeGreaterThan(0);
  // lid.stl is the lid turned about the x axis: y' = outer depth - y.
  const fv = vertices(full);
  const tv = vertices(fit);
  for (const o of lidOpenings) {
    const y = L.outer.d - o.v;
    if (o.shape === "round") {
      // A polygon vertex of the circle is at radius w/2 from the centre.
      for (const vs of [fv, tv]) {
        expect(vs.some((p) => Math.abs(Math.hypot(p[0] - o.u, p[1] - y) - o.w / 2) < 0.02), `${o.ref}.${o.port}`).toBe(true);
      }
    } else {
      for (const sx of [-1, 1]) {
        for (const sy of [-1, 1]) {
          const cx = o.u + (sx * o.w) / 2;
          const cy = y + (sy * o.h) / 2;
          expect(hasVertexAt(fv, cx, cy), `full ${o.ref}.${o.port}`).toBe(true);
          expect(hasVertexAt(tv, cx, cy), `fit ${o.ref}.${o.port}`).toBe(true);
        }
      }
    }
  }
}

describe("fit test pieces", () => {
  for (const lid of ["screw", "snap"] as const) {
    test.skipIf(!J)(`both pieces are watertight (${lid} lid fixture)`, () => {
      const fit = buildFitSolids(J!, layoutFor(lid), LID_REFS);
      for (const [name, g] of [
        ["fit-floor", fit.floor],
        ["fit-lid", fit.lid],
      ] as const) {
        const m = triMesh(J!, g);
        expect(m.t.length / 3, `${name} triangles`).toBeGreaterThan(50);
        expect(openEdgeCount(m), `${name} open edges`).toBe(0);
        expect(m.openEdges).toBe(0);
      }
    });
  }

  test.skipIf(!J)("floor posts keep their height above the floor top, and lid openings keep position and size", () => {
    const layout = layoutFor("screw");
    const solids = buildSolids(J!, layout);
    const fit = buildFitSolids(J!, layout, LID_REFS);
    const body = vertices(triMesh(J!, solids.body));
    const fitFloor = vertices(triMesh(J!, fit.floor));
    const posts = layout.standoffs.filter((s) => s.from === "floor" && s.h < fit.wallHeight);
    expect(posts.length).toBeGreaterThan(0);
    for (const s of posts) {
      expect(hasTopAt(body, s.x, s.y, s.dia, layout.floor + s.h), "body post top").toBe(true);
      expect(hasTopAt(fitFloor, s.x, s.y, s.dia, fit.floorTop + s.h), "fit post top").toBe(true);
    }
    checkOpenings(layout, triMesh(J!, solids.lidPrint), triMesh(J!, fit.lid));
    // Flat side down, floor thinned, wall at least 6 mm above the floor.
    const zs = fitFloor.map((v) => v[2]);
    expect(Math.min(...zs)).toBeCloseTo(0, 3);
    expect(fit.floorTop).toBeCloseTo(0.8, 6);
    expect(fit.wallHeight).toBeGreaterThanOrEqual(6);
    expect(Math.max(...zs)).toBeCloseTo(fit.floorTop + fit.wallHeight, 3);
  });

  test.skipIf(!J)("the example's fit-floor is under 40 percent of the full body", async () => {
    const loaded = await loadProject(`${import.meta.dir}/../../examples/luft`);
    const layout = layoutEnclosure(loaded);
    const lidRefs = new Set(loaded.project.enclosure!.mounts.filter((m) => m.on === "lid").map((m) => m.ref));
    const full = meshVolume(triMesh(J!, buildSolids(J!, layout).body));
    const fit = meshVolume(triMesh(J!, buildFitSolids(J!, layout, lidRefs).floor));
    expect(fit / full).toBeLessThan(0.4);
    expect(fit / full).toBeGreaterThan(0.1);
  });

  test("the checklist names floor ports with wall notches and lid ports with their openings", () => {
    const layout = layoutFor("screw");
    const lines = fitChecklist(layout, LID_REFS);
    expect(lines.some((l) => l.includes("Test MCU drops onto its posts without force and its usb lines up with the notch in the wall"))).toBe(true);
    expect(lines.some((l) => l.includes("Test display's screen sits centred in its opening"))).toBe(true);
    expect(lines).toHaveLength(layout.parts.length);
  });
});
