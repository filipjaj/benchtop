import { describe, expect, test } from "bun:test";
import { footprint, rotPoint } from "./iso";
import { BOARD_T, COURTYARD_GAP, HOLE_DIA, HOLE_FREE, distToRect, layoutPcb } from "./pcb-layout";
import { resolveProject } from "./project";
import type { PartDef, PartUse, Project } from "./types";

const base = {
  blurb: "test part",
  maxHeight: 5,
  electrical: {},
  sourcing: { search: ["x"], priceUsd: 1 },
  sources: ["test"],
  confidence: "typical" as const,
};

const mcu: PartDef = {
  ...base,
  id: "t-mcu",
  name: "Test MCU",
  kind: "board",
  body: { w: 18, d: 22, h: 1.6 },
  pins: [
    { name: "3V3", role: "power-out", x: 2, y: 6 },
    { name: "GND", role: "gnd", x: 2, y: 8.54 },
    { name: "G1", role: "io", x: 2, y: 11.08 },
    { name: "G2", role: "io", x: 16, y: 6 },
  ],
  // The USB socket is on the part's y = 0 edge, facing -y.
  ports: [{ name: "usb", faces: "y-", x: 9, y: 0, w: 9, h: 3.2 }],
  footprint: { mount: "header", pitch: 2.54 },
};
const oled: PartDef = {
  ...base,
  id: "t-oled",
  name: "Test OLED",
  kind: "display",
  body: { w: 27, d: 28, h: 1.6 },
  pins: [
    { name: "GND", role: "gnd", x: 9, y: 2.3 },
    { name: "VCC", role: "power-in", x: 11.54, y: 2.3 },
    { name: "SDA", role: "io", x: 14.08, y: 2.3 },
  ],
  footprint: { mount: "header", pitch: 2.54 },
};
const button: PartDef = {
  ...base,
  id: "t-btn",
  name: "Test button",
  kind: "input",
  body: { w: 6.5, d: 6, h: 3.5 },
  pins: [
    { name: "1", role: "passive", x: 0.5, y: 0.75 },
    { name: "2", role: "passive", x: 0.5, y: 5.25 },
  ],
  footprint: { mount: "tht", pitch: 4.5 },
};
const motor: PartDef = {
  ...base,
  id: "t-motor",
  name: "Test motor",
  kind: "actuator",
  body: { w: 24, d: 12, h: 20 },
  pins: [
    { name: "+", role: "power-in", x: 0, y: 3 },
    { name: "-", role: "gnd", x: 0, y: 6 },
    { name: "SENSE", role: "io", x: 0, y: 9 },
  ],
  footprint: { mount: "wire" },
};

const defs = new Map([mcu, oled, button, motor].map((d) => [d.id, d]));

function project(parts: PartUse[], connections: Project["connections"]): Project {
  return {
    schema: 1,
    slug: "t",
    name: "T",
    tagline: "t",
    summary: "t",
    build: { path: "pcb-diy", difficulty: 1, minutes: 1 },
    power: { source: "usb", volts: 5, budgetMa: 500 },
    parts,
    connections,
  };
}

const baseParts: PartUse[] = [
  { ref: "mcu", part: "t-mcu" },
  { ref: "oled", part: "t-oled" },
  { ref: "btn", part: "t-btn" },
];
const baseConns: Project["connections"] = [
  { from: "mcu.3V3", to: "oled.VCC" },
  { from: "mcu.GND", to: "oled.GND" },
  { from: "mcu.G1", to: "oled.SDA" },
  { from: "mcu.G2", to: "btn.1" },
  { from: "btn.2", to: "mcu.GND" },
];

const layout = (parts: PartUse[], conns: Project["connections"]) => layoutPcb(resolveProject(project(parts, conns), defs));

describe("layoutPcb", () => {
  const l = layout(baseParts, baseConns);
  const outlines = l.parts.map((p) => ({ ref: p.use.ref, x: p.at.x, y: p.at.y, ...footprint(p) }));

  test("board is whole millimetres, 1.6 thick, parts sit on top", () => {
    expect(Number.isInteger(l.board.w)).toBe(true);
    expect(Number.isInteger(l.board.d)).toBe(true);
    expect(l.board.t).toBe(BOARD_T);
    for (const p of l.parts) expect(p.at.z).toBe(BOARD_T);
  });

  test("no two part outlines overlap, and the courtyard gap holds", () => {
    for (let i = 0; i < outlines.length; i++) {
      for (let j = i + 1; j < outlines.length; j++) {
        const a = outlines[i]!;
        const b = outlines[j]!;
        const apart =
          a.x + a.w + COURTYARD_GAP <= b.x + 1e-9 ||
          b.x + b.w + COURTYARD_GAP <= a.x + 1e-9 ||
          a.y + a.d + COURTYARD_GAP <= b.y + 1e-9 ||
          b.y + b.d + COURTYARD_GAP <= a.y + 1e-9;
        expect(apart).toBe(true);
      }
    }
  });

  test("every pin of every placed part lies on the board", () => {
    for (const p of l.parts) {
      for (const pin of p.def.pins) {
        const [x, y] = rotPoint(pin.x, pin.y, p.def.body.w, p.def.body.d, p.at.rot);
        const wx = p.at.x + x;
        const wy = p.at.y + y;
        expect(wx).toBeGreaterThan(0.9);
        expect(wx).toBeLessThan(l.board.w - 0.9);
        expect(wy).toBeGreaterThan(0.9);
        expect(wy).toBeLessThan(l.board.d - 0.9);
      }
    }
  });

  test("four mounting holes keep 4 mm clear of every part", () => {
    expect(l.holes).toHaveLength(4);
    for (const h of l.holes) {
      expect(h.dia).toBe(HOLE_DIA);
      expect(h.x).toBeGreaterThan(0);
      expect(h.x).toBeLessThan(l.board.w);
      for (const o of outlines) {
        expect(distToRect(h.x, h.y, o)).toBeGreaterThanOrEqual(HOLE_DIA / 2 + HOLE_FREE - 1e-9);
      }
    }
  });

  test("the controller's USB end overhangs the y = 0 edge", () => {
    const c = l.parts.find((p) => p.use.ref === "mcu")!;
    expect(c.at.rot).toBe(0);
    expect(c.at.y).toBeLessThan(0);
  });

  test("a USB port on another side turns the controller so it faces the top edge", () => {
    const side: PartDef = { ...mcu, id: "t-mcu-side", ports: [{ name: "usb", faces: "x+", x: 18, y: 11, w: 9, h: 3.2 }] };
    const m = new Map(defs).set(side.id, side);
    const p = resolveProject(project([{ ref: "mcu", part: side.id }], []), m);
    const c = layoutPcb(p).parts[0]!;
    expect(c.at.rot).toBe(270);
  });

  test("wired parts become pad rows at the bottom, with a warning", () => {
    const w = layout(
      [...baseParts, { ref: "m", part: "t-motor" }],
      [...baseConns, { from: "m.+", to: "mcu.3V3" }, { from: "m.-", to: "mcu.GND" }],
    );
    const pads = w.parts.find((p) => p.use.ref === "m")!;
    expect(pads.def.pins.map((q) => q.name)).toEqual(["+", "-"]);
    expect(pads.def.body.h).toBeLessThan(1);
    expect(w.warnings.some((s) => s.startsWith("m (t-motor)"))).toBe(true);
    // Bottom edge: the pad row is lower than the other non-controller parts' top edges.
    const lowest = Math.max(...w.parts.filter((p) => p.use.ref !== "m").map((p) => p.at.y));
    expect(pads.at.y).toBeGreaterThanOrEqual(lowest - 1e-9);
  });

  test("the board grows when a part is added", () => {
    const more = layout(
      [...baseParts, { ref: "oled2", part: "t-oled" }, { ref: "oled3", part: "t-oled" }],
      [...baseConns, { from: "oled2.VCC", to: "mcu.3V3" }, { from: "oled3.VCC", to: "mcu.3V3" }],
    );
    expect(more.board.w * more.board.d).toBeGreaterThan(l.board.w * l.board.d);
  });
});
