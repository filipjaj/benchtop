// The part meshes in the GLB must be closed solids and must sit exactly where the guide
// drawings (iso.partSolids) put each part, at every rotation.

import { describe, expect, test } from "bun:test";
import { partSolids } from "./iso";
import {
  CONNECTOR_STEEL,
  DISPLAY_GLASS,
  GOLD_PAD,
  PCB_BLUE,
  PCB_GREEN,
  PCB_PURPLE,
  bodyMaterial,
  partComponents,
  partMeshes,
  shapeMaterial,
  type RawMesh,
} from "./part-mesh";
import type { PartDef, PlacedPart } from "./types";

const def = (id: string, kind: PartDef["kind"]): PartDef => ({
  id,
  name: id,
  kind,
  blurb: "test part",
  body: { w: 18, d: 22.5, h: 1.2 },
  maxHeight: 5,
  shapes: [
    { kind: "box", x: 4.5, y: -0.3, w: 9, h: 3.2, d: 6.8, tag: "usb" },
    { kind: "box", x: 6, y: 9, z: 0.2, w: 5, d: 4, h: 0.85, tag: "chip" },
    { kind: "cyl", x: 13, y: 15, r: 1.75, h: 2.5, tag: "button-cap" },
    { kind: "box", x: 2, y: 18, w: 3, d: 2, h: 1 },
  ],
  pins: [
    { name: "VCC", role: "power-in", x: 1.27, y: 1.27 },
    { name: "SDA", role: "io", x: 3.81, y: 1.27 },
    { name: "GND", role: "gnd", x: 16, y: 20 },
  ],
  electrical: {},
  sourcing: { search: ["x"], priceUsd: 1 },
  sources: [],
  confidence: "typical",
});

const placed = (d: PartDef, rot: 0 | 90 | 180 | 270): PlacedPart => ({
  use: { ref: "u1", part: d.id },
  def: d,
  at: { x: 10.5, y: 4.25, z: 3, rot },
});

/** Every edge shared by exactly two triangles, and each directed edge used once (consistent winding). */
function closed(m: RawMesh): boolean {
  const directed = new Set<string>();
  const undirected = new Map<string, number>();
  for (let t = 0; t < m.indices.length; t += 3) {
    for (let e = 0; e < 3; e++) {
      const a = m.indices[t + e]!;
      const b = m.indices[t + ((e + 1) % 3)]!;
      const d = `${a}>${b}`;
      if (directed.has(d)) return false;
      directed.add(d);
      const k = a < b ? `${a}|${b}` : `${b}|${a}`;
      undirected.set(k, (undirected.get(k) ?? 0) + 1);
    }
  }
  return [...undirected.values()].every((c) => c === 2);
}

function bbox(m: RawMesh): { min: number[]; max: number[] } {
  const min = [Infinity, Infinity, Infinity];
  const max = [-Infinity, -Infinity, -Infinity];
  for (let i = 0; i < m.positions.length; i += 3) {
    for (let a = 0; a < 3; a++) {
      min[a] = Math.min(min[a]!, m.positions[i + a]!);
      max[a] = Math.max(max[a]!, m.positions[i + a]!);
    }
  }
  return { min, max };
}

/** Signed volume by the divergence theorem; positive when normals point outward. */
function volume(m: RawMesh): number {
  let v = 0;
  for (let t = 0; t < m.indices.length; t += 3) {
    const p = [0, 1, 2].map((k) => m.positions.slice(m.indices[t + k]! * 3, m.indices[t + k]! * 3 + 3));
    const [a, b, c] = p as [number[], number[], number[]];
    v += (a[0]! * (b[1]! * c[2]! - b[2]! * c[1]!) - a[1]! * (b[0]! * c[2]! - b[2]! * c[0]!) + a[2]! * (b[0]! * c[1]! - b[1]! * c[0]!)) / 6;
  }
  return v;
}

describe("part meshes", () => {
  for (const rot of [0, 90, 180, 270] as const) {
    test(`every piece is a closed, outward-facing solid at rot ${rot}`, () => {
      for (const c of partComponents(placed(def("test-board", "board"), rot))) {
        expect(closed(c.mesh)).toBe(true);
        expect(volume(c.mesh)).toBeGreaterThan(0);
      }
    });

    test(`body and shapes sit where partSolids puts them at rot ${rot}`, () => {
      const p = placed(def("test-board", "board"), rot);
      const solids = partSolids(p, { labels: false });
      const parts = partComponents(p);
      const near = (a: number[], b: number[]): void => a.forEach((v, i) => expect(v).toBeCloseTo(b[i]!, 5));
      const body = parts.find((c) => c.source === "body")!;
      const s0 = solids[0]!;
      near(bbox(body.mesh).min, [s0.x, s0.y, s0.z]);
      near(bbox(body.mesh).max, [s0.x + s0.w, s0.y + s0.d, s0.z + s0.h]);
      solids.slice(1).forEach((s, i) => {
        const piece = parts.find((c) => c.source === `shape:${i}`)!;
        near(bbox(piece.mesh).min, [s.x, s.y, s.z]);
        near(bbox(piece.mesh).max, [s.x + s.w, s.y + s.d, s.z + s.h]);
      });
      // Pad rings are centred on the rotated pin position, on the body's top face.
      for (const [i, pad] of (s0.pads ?? []).entries()) {
        const ring = bbox(parts.find((c) => c.source === `pad:${i}`)!.mesh);
        expect((ring.min[0]! + ring.max[0]!) / 2).toBeCloseTo(s0.x + pad.x, 5);
        expect((ring.min[1]! + ring.max[1]!) / 2).toBeCloseTo(s0.y + pad.y, 5);
        expect(ring.max[2]!).toBeGreaterThan(s0.z + s0.h);
        expect(ring.min[2]!).toBeLessThan(s0.z + s0.h);
      }
    });
  }

  test("merged groups keep one mesh per material and all the triangles", () => {
    const p = placed(def("test-board", "board"), 0);
    const groups = partMeshes(p);
    expect(new Set(groups.map((g) => g.material.name)).size).toBe(groups.length);
    const merged = groups.reduce((n, g) => n + g.indices.length, 0);
    const single = partComponents(p).reduce((n, c) => n + c.mesh.indices.length, 0);
    expect(merged).toBe(single);
    for (const g of groups) expect(closed({ positions: [...g.positions], indices: [...g.indices] })).toBe(true);
  });

  test("materials follow the tag and the part", () => {
    expect(shapeMaterial("usb")).toBe(CONNECTOR_STEEL);
    expect(shapeMaterial("glass")).toBe(DISPLAY_GLASS);
    expect(shapeMaterial(undefined).name).toBe("default");
    expect(bodyMaterial(placed(def("esp32-c3-supermini", "board"), 0))).toBe(PCB_GREEN);
    expect(bodyMaterial(placed(def("bme280-breakout", "sensor"), 0))).toBe(PCB_PURPLE);
    expect(bodyMaterial(placed(def("ssd1306-oled-096-i2c", "display"), 0))).toBe(PCB_BLUE);
    expect(partComponents(placed(def("x", "board"), 0)).filter((c) => c.material === GOLD_PAD)).toHaveLength(3);
  });

  test("every numbered LED shape lights, not only led-1 and led-2, and a pixel-like name that is not one does not", () => {
    for (const tag of ["led-1", "led-2", "led-3", "led-8", "led-60"]) expect(shapeMaterial(tag).name).toBe("led");
    expect(shapeMaterial("led-lens").name).toBe("led");
    for (const tag of ["led-", "led-x", "ledge", "led-1a", "xled-1"]) expect(shapeMaterial(tag).name).toBe("default");
  });

  test("the pads of a header's pins are ringed once, on top of the header, and the board under it gets none", () => {
    const mod: PartDef = {
      ...def("mod", "audio"),
      shapes: [{ kind: "box", x: 1, y: 8, z: 0, w: 8, d: 2.54, h: 2.5, tag: "header" }],
      pins: [
        { name: "A", role: "io", x: 2, y: 9 },
        { name: "B", role: "io", x: 4.54, y: 9 },
        { name: "C", role: "io", x: 15, y: 3 },
      ],
    };
    const p = placed(mod, 0);
    const rings = partComponents(p).filter((c) => c.material === GOLD_PAD);
    expect(rings).toHaveLength(3);
    const tops = rings.map((c) => Math.max(...c.mesh.positions.filter((_, i) => i % 3 === 2))).sort((a, b) => a - b);
    // C on the board, A and B at the header's top (z of the part + body + header height).
    expect(tops[0]).toBeCloseTo(p.at.z + mod.body.h + 0.05, 6);
    expect(tops[1]).toBeCloseTo(p.at.z + mod.body.h + 2.5 + 0.05, 6);
    expect(tops[2]).toBeCloseTo(tops[1]!, 9);
  });
});
