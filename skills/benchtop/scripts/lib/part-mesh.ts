// Detailed triangle meshes for placed parts, used by the GLB writer.
//
// The geometry comes from iso.partSolids, so a part lands at exactly the position and
// rotation the guide drawings give it: body first, then every shape in definition order,
// then a thin gold pad ring at each pin. Each piece is a closed mesh (every edge is shared
// by two triangles) and pieces that share a material are merged into one group, so the
// GLB gets one mesh per part and material.
//
// Units: millimetres, Z up, world coordinates.

import { TERMINATION_TAGS, partSolids, type Solid } from "./iso";
import type { PlacedPart } from "./types";

export type Rgb = [number, number, number];

export interface PartMaterial {
  /** Short name used in mesh names: "part:<ref>:<name>". */
  name: string;
  /** Linear RGB, as glTF wants it. */
  color: Rgb;
  metallic: number;
  roughness: number;
}

const lin = (c: number): number => (c <= 0.04045 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4);

/** sRGB hex ("#0b4a2a") to linear RGB. */
export function hexToLinear(hex: string): Rgb {
  const m = /^#?([0-9a-f]{6})$/i.exec(hex.trim());
  const n = m ? parseInt(m[1]!, 16) : 0xdddddd;
  return [lin(((n >> 16) & 255) / 255), lin(((n >> 8) & 255) / 255), lin((n & 255) / 255)];
}

const mat = (name: string, hex: string, metallic: number, roughness: number): PartMaterial => ({
  name,
  color: hexToLinear(hex),
  metallic,
  roughness,
});

export const PCB_GREEN = mat("pcb-green", "#0c5a31", 0, 0.42);
export const PCB_PURPLE = mat("pcb-purple", "#4b2377", 0, 0.42);
export const PCB_BLUE = mat("pcb-blue", "#143f86", 0, 0.42);
export const CONNECTOR_STEEL = mat("connector-steel", "#b9bdc2", 1, 0.34);
export const SHIELD_CAN = mat("shield-can", "#d3d6d9", 1, 0.28);
export const CHIP_BLACK = mat("chip", "#141414", 0, 0.5);
export const ANTENNA_CERAMIC = mat("antenna", "#7b3a2b", 0, 0.5);
export const BUTTON_BODY = mat("button-body", "#111111", 0, 0.5);
export const BUTTON_CAP = mat("button-cap", "#3b3b3e", 0, 0.42);
export const DISPLAY_GLASS = mat("display-glass", "#04060c", 0, 0.06);
export const LED_WARM_WHITE = mat("led", "#fff0c4", 0, 0.3);
export const SENSOR_CAN = mat("sensor-can", "#c8cbcf", 1, 0.24);
export const TERMINAL_BLUE = mat("terminal", "#2459a8", 0, 0.45);
export const DEFAULT_GREY = mat("default", "#7e7e82", 0, 0.6);
export const GOLD_PAD = mat("gold-pad", "#d9a63a", 1, 0.26);

const SHAPE_MATERIAL: Record<string, PartMaterial> = {
  usb: CONNECTOR_STEEL,
  "usb-c-socket": CONNECTOR_STEEL,
  connector: CONNECTOR_STEEL,
  "screw-terminal": TERMINAL_BLUE,
  header: CHIP_BLACK,
  module: SHIELD_CAN,
  chip: CHIP_BLACK,
  "mpu6050-chip": CHIP_BLACK,
  "tp4056-chip": CHIP_BLACK,
  antenna: ANTENNA_CERAMIC,
  button: BUTTON_BODY,
  "button-cap": BUTTON_CAP,
  glass: DISPLAY_GLASS,
  led: LED_WARM_WHITE,
  "led-lens": LED_WARM_WHITE,
  "sensor-can": SENSOR_CAN,
  "buzzer-can": SENSOR_CAN,
};

/** led-1, led-2 ... led-60: one tag per pixel of a light bar, all lit the same way. */
const NUMBERED_LED = /^led-\d+$/;

/** Material of a shape from its tag; untagged or unknown tags are mid grey. */
export function shapeMaterial(tag: string | undefined): PartMaterial {
  if (tag && NUMBERED_LED.test(tag)) return LED_WARM_WHITE;
  return (tag && SHAPE_MATERIAL[tag]) || DEFAULT_GREY;
}

const PCB_KINDS = new Set(["board", "sensor", "display", "power"]);

/** Material of the part body (the board or housing the shapes stand on). */
export function bodyMaterial(p: PlacedPart): PartMaterial {
  const id = p.def.id.toLowerCase();
  if (id.includes("bme280")) return PCB_PURPLE;
  if (id.includes("oled") || id.includes("ssd1306")) return PCB_BLUE;
  if (id.includes("button")) return BUTTON_BODY;
  if (PCB_KINDS.has(p.def.kind)) return PCB_GREEN;
  if ((p.def.kind === "actuator" || p.def.kind === "audio") && /module|breakout|mic/.test(id)) return PCB_GREEN;
  return DEFAULT_GREY;
}

// ---------------------------------------------------------------------------
// Primitives. Every one is closed and indexed, so shared edges are shared indices.
// ---------------------------------------------------------------------------

export const CYL_SEGMENTS = 24;
const PAD_OUTER = 0.85;
const PAD_INNER = 0.45;
/** Pad rings are sunk into the body this far and stand this far proud of it, in mm. */
const PAD_SINK = 0.02;
const PAD_RISE = 0.05;

export interface RawMesh {
  /** xyz triples, mm. */
  positions: number[];
  /** Triangle indices, counter-clockwise seen from outside. */
  indices: number[];
}

export function boxMesh(x: number, y: number, z: number, w: number, d: number, h: number): RawMesh {
  const x1 = x + w;
  const y1 = y + d;
  const z1 = z + h;
  // 0..3 bottom (counter-clockwise from above), 4..7 top.
  const positions = [x, y, z, x1, y, z, x1, y1, z, x, y1, z, x, y, z1, x1, y, z1, x1, y1, z1, x, y1, z1];
  const indices = [
    0, 2, 1, 0, 3, 2, // bottom
    4, 5, 6, 4, 6, 7, // top
    0, 1, 5, 0, 5, 4, // -y
    1, 2, 6, 1, 6, 5, // +x
    2, 3, 7, 2, 7, 6, // +y
    3, 0, 4, 3, 4, 7, // -x
  ];
  return { positions, indices };
}

export function cylinderMesh(cx: number, cy: number, z: number, r: number, h: number, segments = CYL_SEGMENTS): RawMesh {
  const positions: number[] = [];
  for (const zz of [z, z + h]) {
    for (let i = 0; i < segments; i++) {
      const a = (i / segments) * Math.PI * 2;
      positions.push(cx + Math.cos(a) * r, cy + Math.sin(a) * r, zz);
    }
  }
  const bc = segments * 2;
  positions.push(cx, cy, z, cx, cy, z + h);
  const indices: number[] = [];
  for (let i = 0; i < segments; i++) {
    const j = (i + 1) % segments;
    indices.push(i, j, segments + j, i, segments + j, segments + i); // side
    indices.push(bc, j, i); // bottom cap, facing down
    indices.push(bc + 1, segments + i, segments + j); // top cap
  }
  return { positions, indices };
}

/** A flat ring (annulus extruded by h) with a hole through it. */
export function ringMesh(cx: number, cy: number, z: number, rOuter: number, rInner: number, h: number, segments = CYL_SEGMENTS): RawMesh {
  const positions: number[] = [];
  // Layers of `segments` vertices: outer bottom, outer top, inner bottom, inner top.
  for (const [r, zz] of [[rOuter, z], [rOuter, z + h], [rInner, z], [rInner, z + h]] as const) {
    for (let i = 0; i < segments; i++) {
      const a = (i / segments) * Math.PI * 2;
      positions.push(cx + Math.cos(a) * r, cy + Math.sin(a) * r, zz);
    }
  }
  const ob = 0;
  const ot = segments;
  const ib = segments * 2;
  const it = segments * 3;
  const indices: number[] = [];
  for (let i = 0; i < segments; i++) {
    const j = (i + 1) % segments;
    indices.push(ob + i, ob + j, ot + j, ob + i, ot + j, ot + i); // outer wall
    indices.push(ib + j, ib + i, it + i, ib + j, it + i, it + j); // inner wall, facing the hole
    indices.push(ot + i, ot + j, it + j, ot + i, it + j, it + i); // top annulus
    indices.push(ob + j, ob + i, ib + i, ob + j, ib + i, ib + j); // bottom annulus
  }
  return { positions, indices };
}

// ---------------------------------------------------------------------------
// Parts
// ---------------------------------------------------------------------------

export interface PartComponent {
  /** "body", "shape:<index into def.shapes>" or "pad:<index into def.pins>". */
  source: string;
  material: PartMaterial;
  mesh: RawMesh;
}

function solidMesh(s: Solid): RawMesh {
  if (s.kind === "cyl") return cylinderMesh(s.x + s.w / 2, s.y + s.d / 2, s.z, s.r ?? s.w / 2, s.h);
  return boxMesh(s.x, s.y, s.z, s.w, s.d, s.h);
}

/** Every piece of a placed part, unmerged, in world millimetres. */
export function partComponents(p: PlacedPart): PartComponent[] {
  // leads: true draws through-hole legs where they are (at the foot of a switch, the
  // ends of a resistor), the same way the booklet does, instead of pads on top of the body.
  const solids = partSolids(p, { labels: false, leads: true });
  const body = solids[0]!;
  const out: PartComponent[] = [{ source: "body", material: bodyMaterial(p), mesh: solidMesh(body) }];
  solids.slice(1).forEach((s, i) => {
    if (s.h <= 0 || s.w <= 0 || s.d <= 0) return;
    out.push({ source: `shape:${i}`, material: shapeMaterial(s.tag), mesh: solidMesh(s) });
  });
  // Pads of header pins are carried by the header shape (partSolids), so ring them on
  // its top face, where the pins end, as well as the pads on the body.
  let n = 0;
  for (const host of solids.filter((s, i) => i === 0 || (s.tag !== undefined && TERMINATION_TAGS.has(s.tag) && s.pads))) {
    const top = host.z + host.h;
    for (const pad of (host.pads ?? []).filter((q) => q.ring !== false)) {
      out.push({
        source: `pad:${n++}`,
        material: GOLD_PAD,
        mesh: ringMesh(host.x + pad.x, host.y + pad.y, top - PAD_SINK, PAD_OUTER, PAD_INNER, PAD_SINK + PAD_RISE),
      });
    }
  }
  return out;
}

export interface PartMeshGroup {
  material: PartMaterial;
  positions: Float32Array;
  indices: Uint32Array;
}

/** The part's pieces merged per material, in a stable order. */
export function partMeshes(p: PlacedPart): PartMeshGroup[] {
  const groups = new Map<string, { material: PartMaterial; positions: number[]; indices: number[] }>();
  for (const c of partComponents(p)) {
    let g = groups.get(c.material.name);
    if (!g) {
      g = { material: c.material, positions: [], indices: [] };
      groups.set(c.material.name, g);
    }
    const base = g.positions.length / 3;
    for (const v of c.mesh.positions) g.positions.push(v);
    for (const i of c.mesh.indices) g.indices.push(base + i);
  }
  return [...groups.values()].map((g) => ({
    material: g.material,
    positions: new Float32Array(g.positions),
    indices: new Uint32Array(g.indices),
  }));
}
