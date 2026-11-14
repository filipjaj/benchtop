import { describe, expect, test } from "bun:test";
import { join } from "node:path";
import { type Row, type WiringModel, buildDrawings, buildEnclosure, buildFitCheck, buildFitCheckSheets, buildWiring, debugLines, firstSentence, legendPages, legendRows, orderLanes, pinRows, scaleText } from "./drawing";
import { layoutEnclosure } from "./lib/enclosure-layout";
import { type Pt, clipLength, flatPart, fmt, hopOf, overlap, rectBox } from "./lib/flat";
import { type Loaded, loadProject, resolveProject } from "./lib/project";
import type { PartDef, PinDef, Project } from "./lib/types";

function part(id: string, kind: PartDef["kind"], w: number, d: number, pins: PinDef[], extra: Partial<PartDef> = {}): PartDef {
  return {
    id,
    name: id,
    kind,
    blurb: "",
    body: { w, d, h: 1.6 },
    maxHeight: 4,
    pins,
    electrical: {},
    sourcing: { search: [], priceUsd: 1 },
    sources: [],
    confidence: "typical",
    ...extra,
  };
}
const io = (name: string, x: number, y: number, gpio?: number): PinDef => ({ name, role: "io", x, y, ...(gpio === undefined ? {} : { gpio }) });
const gnd = (x: number, y: number): PinDef => ({ name: "GND", role: "gnd", x, y });
const rail = (name: string, x: number, y: number): PinDef => ({ name, role: "power-out", x, y, volts: 3.3 });
const pwr = (name: string, x: number, y: number): PinDef => ({ name, role: "power-in", x, y });

const defs = new Map<string, PartDef>(
  [
    part(
      "board",
      "board",
      20,
      26,
      [io("A", 1.4, 3, 1), io("B", 1.4, 5.54, 2), io("C", 1.4, 8.08, 3), rail("3V3", 18.6, 3), gnd(18.6, 5.54), io("D", 18.6, 8.08, 4)],
      { ports: [{ name: "USB", faces: "y-", x: 10, y: 0, w: 9, h: 3.2 }] },
    ),
    part("disp", "display", 26, 18, [gnd(9, 2), pwr("VCC", 11.5, 2), io("SCL", 14, 2), io("SDA", 16.5, 2)]),
    part("sens", "sensor", 16, 12, [pwr("VCC", 1.5, 3), gnd(1.5, 5.5), io("OUT", 1.5, 8)]),
    part("res", "passive", 10.16, 2.3, [
      { name: "1", role: "passive", x: 0, y: 1.15 },
      { name: "2", role: "passive", x: 10.16, y: 1.15 },
    ]),
    part("strip", "light", 30, 10, [pwr("5V", 2.5, 2.46), io("DIN", 2.5, 5), gnd(2.5, 7.54)]),
  ].map((d) => [d.id, d]),
);

const project: Project = {
  schema: 1,
  slug: "fx",
  name: "Fixture",
  tagline: "",
  summary: "",
  build: { path: "wire", joint: "solder", difficulty: 1, minutes: 1 },
  power: { source: "usb", volts: 5, budgetMa: 500 },
  parts: [
    { ref: "mcu", part: "board", label: "Controller" },
    { ref: "oled", part: "disp", label: "Display" },
    { ref: "env", part: "sens", label: "Sensor" },
    { ref: "r1", part: "res", value: "330 ohm" },
    { ref: "strip", part: "strip", label: "Strip" },
  ],
  connections: [
    { from: "mcu.3V3", to: "oled.VCC", why: "Power for the display" },
    { from: "mcu.GND", to: "oled.GND", why: "Ground for the display" },
    { from: "mcu.A", to: "oled.SDA", why: "Data" },
    { from: "mcu.B", to: "oled.SCL", why: "Clock" },
    { from: "oled.VCC", to: "env.VCC", why: "Power carries on" },
    { from: "oled.GND", to: "env.GND", why: "Ground carries on" },
    { from: "mcu.C", to: "r1.1", why: "Data out to its resistor" },
    { from: "r1.2", to: "strip.DIN", why: "Resistor to the strip" },
    { from: "mcu.GND", to: "strip.GND", why: "Ground for the strip" },
    { from: "mcu.D", to: "env.OUT", why: "Sensor reading" },
  ],
  enclosure: {
    wall: 2,
    fit: 0.3,
    radius: 3,
    lid: "screw",
    mounts: [
      { ref: "mcu", on: "floor", x: 0, y: 0 },
      { ref: "oled", on: "lid", x: 0, y: 0 },
      { ref: "env", on: "floor", x: 0, y: 0 },
      { ref: "strip", on: "floor", x: 0, y: 0 },
      { ref: "r1", on: "floor", x: 0, y: 0 },
    ],
    openings: "auto",
    material: "PLA",
    color: "#fff",
  },
};

const loaded = resolveProject(project, defs);
const wiring = buildWiring(loaded);

// Shaped like the stopp project: a display-like part with all pads on one edge, three inline
// resistors, a strip with pads on one edge, a controller with pads on both edges.
const chained: Project = {
  ...project,
  slug: "fx2",
  parts: [
    { ref: "mcu", part: "board", label: "Controller" },
    { ref: "sonar", part: "disp", label: "Sensor" },
    { ref: "r1", part: "res", value: "1 kohm" },
    { ref: "r2", part: "res", value: "2 kohm" },
    { ref: "r3", part: "res", value: "330 ohm" },
    { ref: "strip", part: "strip", label: "Strip" },
  ],
  connections: [
    { from: "mcu.3V3", to: "sonar.VCC", why: "Power", color: "red" },
    { from: "mcu.GND", to: "sonar.GND", why: "Ground" },
    { from: "mcu.A", to: "sonar.SDA", why: "Trigger", net: "TRIG" },
    { from: "sonar.SCL", to: "r1.1", why: "Echo out", net: "ECHO_5V" },
    { from: "r1.2", to: "r2.1", why: "Divider", net: "ECHO" },
    { from: "r2.2", to: "sonar.GND", why: "Divider leg to ground" },
    { from: "r1.2", to: "mcu.B", why: "Echo to the controller" },
    { from: "mcu.3V3", to: "strip.5V", why: "Power for the strip" },
    { from: "mcu.GND", to: "strip.GND", why: "Ground for the strip" },
    { from: "mcu.C", to: "r3.1", why: "Data out", net: "DATA" },
    { from: "r3.2", to: "strip.DIN", why: "Resistor to the strip", net: "DIN" },
  ],
  enclosure: undefined,
};
const loaded2 = resolveProject(chained, defs);
const wiring2 = buildWiring(loaded2);
const luft = buildWiring(await loadProject(join(import.meta.dir, "../examples/luft")));

describe("wiring diagram", () => {
  const cases: [string, Loaded, WiringModel][] = [
    ["fixture with a chain off a module", loaded, wiring],
    ["fixture with inline resistors", loaded2, wiring2],
  ];

  test("every connection is exactly one wire, one step tag and one legend row", () => {
    for (const [, l, w] of cases) {
      const n = l.project.connections.length;
      expect(w.wires).toHaveLength(n);
      expect(legendRows(l)).toHaveLength(n);
      for (let step = 1; step <= n; step++) {
        expect(w.svg.split(`class="wire" data-step="${step}"`)).toHaveLength(2);
        expect(w.svg.split(`class="tag" data-step="${step}"`)).toHaveLength(2);
        expect(w.svg.split(`class="row" data-step="${step}"`)).toHaveLength(2);
      }
    }
  });

  test("the check prints nothing for the fixtures and for luft", () => {
    expect(wiring.checks).toEqual([]);
    expect(wiring2.checks).toEqual([]);
    expect(luft.checks).toEqual([]);
  });

  test("three bands: the row of parts, one lane per net, the controller", () => {
    for (const [, l, w] of cases) {
      const ctrl = w.parts.find((p) => p.ref === "mcu")!;
      const row = w.parts.filter((p) => p !== ctrl);
      expect(w.lanes).toHaveLength(l.nets.length);
      const ys = w.lanes.map((x) => x.y).sort((a, b) => a - b);
      for (const p of row) expect(p.rect.y + p.rect.d).toBeLessThan(ys[0]!);
      expect(ctrl.rect.y).toBeGreaterThan(ys[ys.length - 1]!);
      // A fixed pitch between lanes.
      for (let i = 1; i < ys.length; i++) expect(ys[i]! - ys[i - 1]!).toBeCloseTo(ys[1]! - ys[0]!, 6);
      // The row sits on one baseline.
      for (const p of row) expect(p.rect.y + p.rect.d).toBeCloseTo(row[0]!.rect.y + row[0]!.rect.d, 6);
    }
  });

  test("the controller is turned so its pad rows are its top and bottom edges, and centred under the row", () => {
    for (const [, , w] of cases) {
      const ctrl = w.parts.find((p) => p.ref === "mcu")!;
      expect(ctrl.pads.every((q) => q.dir === "N" || q.dir === "S")).toBe(true);
      const row = w.parts.filter((p) => p !== ctrl);
      const lo = Math.min(...row.map((p) => p.rect.x));
      const hi = Math.max(...row.map((p) => p.rect.x + p.rect.w));
      // Centred, give or take the nudge that keeps its stubs off the stubs above.
      expect(Math.abs(ctrl.rect.x + ctrl.rect.w / 2 - (lo + hi) / 2)).toBeLessThan(8);
    }
  });

  test("parts turn their used pads toward the lanes", () => {
    const oled = wiring.parts.find((p) => p.ref === "oled")!;
    expect(oled.pads.filter((q) => q.dir === "S")).toHaveLength(4);
    const strip = wiring2.parts.find((p) => p.ref === "strip")!;
    for (const name of ["5V", "DIN", "GND"]) expect(strip.pads.find((q) => q.name === name)!.dir).toBe("S");
  });

  test("lanes are straight and horizontal, and a wire is stub, lane run, stub", () => {
    for (const [, , w] of cases) {
      for (const wire of w.wires) {
        const lane = w.lanes.find((x) => x.net === wire.net)!;
        expect(wire.path.some((p, i) => i > 0 && p[1] === lane.y && wire.path[i - 1]![1] === lane.y)).toBe(true);
        expect(wire.laneY).toBe(lane.y);
      }
    }
  });

  test("two connections that share a pad share its stub", () => {
    const [w2, w9] = [wiring.wires[1]!, wiring.wires[8]!];
    expect(w2.from).toEqual(w9.from);
    expect(w2.path[0]).toEqual(w9.path[0]);
    expect(w2.path[1]).toEqual(w9.path[1]);
  });

  test("each lane carries its net name once", () => {
    for (const [, l, w] of cases) {
      expect(w.laneLabels.map((x) => x.text).sort()).toEqual(l.nets.map((n) => n.name.toUpperCase()).sort());
    }
  });

  test("every wired pad is named, at 1.6 mm cap height or more on the sheet, and most names sit inside their part", () => {
    for (const [, l, w] of cases) {
      for (const pl of w.pinLabels) expect(pl.fontSize * 0.714 * w.scale).toBeGreaterThanOrEqual(1.6);
      expect(w.pinLabels.filter((x) => x.inside).length).toBeGreaterThan(w.pinLabels.length / 2);
      for (const c of l.project.connections) {
        for (const end of [c.from, c.to]) {
          const [ref, pin] = end.split(".");
          const pad = w.parts.find((p) => p.ref === ref)!.pads.find((q) => q.name === pin)!;
          expect(w.pinLabels.some((x) => x.ref === ref && x.pad === pad.name && x.wired)).toBe(true);
        }
      }
    }
  });

  test("parts do not overlap each other", () => {
    for (const [, , w] of cases) {
      for (let i = 0; i < w.parts.length; i++) {
        for (let j = i + 1; j < w.parts.length; j++) expect(overlap(rectBox(w.parts[i]!.rect), rectBox(w.parts[j]!.rect))).toBe(false);
      }
    }
  });

  test("the diagram states a scale and where it came from", () => {
    expect(wiring.svg).toContain("Wiring, top view");
    expect(wiring.svg).toContain("Generated from project.json");
    expect(wiring.svg).toMatch(/Scale \d/);
  });

  test("plan pins a part's turn and its place in the row", () => {
    const pinned = resolveProject({ ...project, parts: project.parts.map((p) => (p.ref === "env" ? { ...p, plan: { x: 200, y: 0, rot: 90 as const } } : p)) }, defs);
    const w = buildWiring(pinned);
    const env = w.parts.find((p) => p.ref === "env")!;
    expect(env.rect.x).toBe(200);
    expect(env.placed.at.rot).toBe(90);
    expect(w.checks).toEqual([]);
  });

  test("a long row of parts is drawn at a smaller scale than a short one, with a clean check", () => {
    const extra = [1, 2, 3, 4, 5, 6];
    const wide = resolveProject(
      {
        ...project,
        parts: [...project.parts, ...extra.map((n) => ({ ref: `x${n}`, part: "disp", label: `Display ${n}` }))],
        connections: [...project.connections, ...extra.map((n) => ({ from: "mcu.GND", to: `x${n}.GND`, why: "Ground" }))],
      },
      defs,
    );
    const w = buildWiring(wide);
    expect(w.scale).toBeLessThanOrEqual(1);
    expect(w.scale).toBeLessThan(wiring.scale);
    expect(w.checks).toEqual([]);
  });

  test("text size belongs to the sheet: pin names, lane names and tags stay at 1.6 mm of capital at any scale", () => {
    const small = resolveProject(
      {
        ...project,
        slug: "fx4",
        parts: [...project.parts, ...[1, 2, 3, 4, 5, 6, 7, 8].map((n) => ({ ref: `x${n}`, part: "disp", label: `Display ${n}` }))],
        connections: [...project.connections, ...[1, 2, 3, 4, 5, 6, 7, 8].map((n) => ({ from: "mcu.GND", to: `x${n}.GND`, why: "Ground" }))],
      },
      defs,
    );
    for (const w of [wiring, wiring2, luft, buildWiring(small)]) {
      for (const l of w.pinLabels) expect(l.fontSize * 0.714 * w.scale).toBeGreaterThanOrEqual(1.6);
      for (const l of w.laneLabels) expect(l.fontSize * 0.714 * w.scale).toBeGreaterThanOrEqual(1.6);
      for (const t of w.tags) expect(t.fontSize * 0.714 * w.scale).toBeGreaterThanOrEqual(1.6);
    }
  });
});

// Two pin headers with every pad wired: 2.54 mm and 0.8 mm pitch. At any sheet scale the pads are
// closer together than a name is tall, which is what used to leave a name under its neighbour's wire.
const header = (id: string, n: number, pitch: number): PartDef => part(id, "sensor", 5 + (n - 1) * pitch, 10, Array.from({ length: n }, (_, i) => io(`P${i}`, 2.5 + i * pitch, 1.5)));
const denseDefs = new Map(defs);
for (const d of [header("hdr", 10, 2.54), header("hdr2", 10, 0.8)]) denseDefs.set(d.id, d);
const denseProject: Project = {
  ...project,
  slug: "fx5",
  parts: [
    { ref: "mcu", part: "board", label: "Controller" },
    { ref: "h1", part: "hdr", label: "Header" },
    { ref: "h2", part: "hdr2", label: "Fine header" },
  ],
  connections: Array.from({ length: 10 }, (_, i) => ({ from: `h1.P${i}`, to: `h2.P${i}`, why: `Line ${i}`, net: `N${i}` })).concat([{ from: "mcu.A", to: "h1.P0", why: "Data", net: "N0" }]),
  enclosure: undefined,
};
const denseLoaded = resolveProject(denseProject, denseDefs);
const dense = buildWiring(denseLoaded);

describe("pin names on a dense header", () => {
  test("the check is clean and every wired pad has a name", () => {
    expect(dense.checks).toEqual([]);
    for (const c of denseLoaded.project.connections) {
      for (const end of [c.from, c.to]) {
        const [ref, pin] = end.split(".");
        expect(dense.pinLabels.filter((l) => l.ref === ref && l.pad === pin && l.wired)).toHaveLength(1);
      }
    }
  });

  test("no name touches another name or any wire, whatever the scale", () => {
    const segs = dense.wires.flatMap((w) => w.path.slice(0, -1).map((p, i): [Pt, Pt] => [p, w.path[i + 1]!]));
    dense.pinLabels.forEach((l, i) => {
      for (const o of dense.pinLabels.slice(i + 1)) expect(overlap(l.box, o.box)).toBe(false);
      for (const [a, b] of segs) expect(clipLength(a, b, l.box)).toBeLessThan(1e-6);
    });
  });

  test("a name stands on the inward side of its pad, opposite the way its wire leaves", () => {
    for (const w of [dense, wiring, wiring2, luft]) {
      for (const l of w.pinLabels.filter((x) => x.wired)) {
        const pad = w.parts.find((p) => p.ref === l.ref)!.pads.find((q) => q.name === l.pad)!;
        if (pad.dir === "N") expect(l.box.y0).toBeGreaterThan(pad.y);
        if (pad.dir === "S") expect(l.box.y1).toBeLessThan(pad.y);
        if (pad.dir === "W") expect(l.box.x0).toBeGreaterThan(pad.x);
        if (pad.dir === "E") expect(l.box.x1).toBeLessThan(pad.x);
      }
    }
  });

  test("names spread out of the pitch keep the order of their pads and are joined to them by leaders", () => {
    const h2 = dense.parts.find((p) => p.ref === "h2")!;
    // The header may stand turned: the pads then run down the page, and so do their names.
    const along = (p: { x: number; y: number }, vertical: boolean): number => (vertical ? p.y : p.x);
    const vertical = h2.pads[0]!.dir === "E" || h2.pads[0]!.dir === "W";
    const fine = dense.pinLabels
      .filter((l) => l.ref === "h2")
      .map((l) => ({ l, at: along(h2.pads.find((q) => q.name === l.pad)!, vertical) }))
      .sort((a, b) => a.at - b.at);
    const centres = fine.map(({ l }) => (vertical ? (l.box.y0 + l.box.y1) / 2 : (l.box.x0 + l.box.x1) / 2));
    for (let i = 1; i < centres.length; i++) expect(centres[i]!).toBeGreaterThan(centres[i - 1]!);
    expect(fine.some(({ l }) => l.leader)).toBe(true);
  });
});

describe("connections sheet", () => {
  // A tall part and many nets make a tall plan: the legend under it would force a small scale.
  const pairs = Array.from({ length: 13 }, (_, i) => i);
  const tallDefs = new Map(defs);
  tallDefs.set("bus", part("bus", "sensor", 76, 60, Array.from({ length: 28 }, (_, i) => io(`P${i}`, 2.5 + i * 2.54, 57))));
  const tall = resolveProject(
    {
      ...project,
      slug: "fx6",
      parts: [
        { ref: "mcu", part: "board", label: "Controller" },
        { ref: "bus", part: "bus", label: "Bus" },
      ],
      connections: [
        ...pairs.map((i) => ({ from: `bus.P${2 * i}`, to: `bus.P${2 * i + 1}`, why: `Line ${i + 1}`, net: `NET${i}` })),
        { from: "mcu.A", to: "bus.P26", why: "Data A", net: "DA" },
        { from: "mcu.B", to: "bus.P27", why: "Data B", net: "DB" },
      ],
      enclosure: undefined,
    },
    tallDefs,
  );

  test("the list stays under the plan when it does not hold the scale down", () => {
    expect(wiring.legendSheet).toBeNull();
    expect(luft.legendSheet).toBeNull();
    expect(wiring.svg).toContain('class="row" data-step="1"');
  });

  test("a plan that the legend would shrink gets the whole sheet, and the list gets its own", () => {
    const withIt = buildWiring(tall);
    expect(withIt.legendSheet).not.toBeNull();
    if (!withIt.legendSheet) return;
    expect(withIt.svg).not.toContain('class="row"');
    for (let step = 1; step <= tall.project.connections.length; step++) {
      expect(withIt.legendSheet.split(`class="row" data-step="${step}"`)).toHaveLength(2);
    }
    expect(withIt.svg).toContain("connections sheet");
    expect(withIt.checks).toEqual([]);
  });

  test("buildDrawings puts the list right after the plan when it has a sheet", () => {
    const set = buildDrawings(tall);
    const pages = set.html.split('<section class="page">').length - 1;
    expect(pages).toBe(2 + (set.wiring.legendSheet ? 1 : 0) + set.fitcheck.length);
    if (set.wiring.legendSheet) expect(set.html.indexOf("Wiring, connections")).toBeGreaterThan(set.html.indexOf("Wiring, top view"));
  });
});

describe("debug listing", () => {
  test("names every part with the x and rot a plan override takes", () => {
    const lines = debugLines(loaded, wiring);
    expect(lines[0]).toContain("1 sheet");
    expect(lines.some((l) => l.startsWith("sheet 1: scale ") && l.includes(scaleText(wiring.scale)))).toBe(true);
    for (const p of wiring.parts) {
      const line = lines.find((l) => l.trim().startsWith(p.ref + " "))!;
      expect(line).toContain(`x=${fmt(p.rect.x)}`);
      expect(line).toContain(`rot=${p.placed.at.rot}`);
      expect(line).toContain(`"plan": { "x": ${fmt(p.rect.x)}, "y": 0, "rot": ${p.placed.at.rot} }`);
    }
  });

  test("pinning a part at the printed x and rot puts it there again", () => {
    const spot = wiring.parts.find((p) => p.ref === "env")!;
    const again = buildWiring(resolveProject({ ...project, parts: project.parts.map((p) => (p.ref === "env" ? { ...p, plan: { x: Number(fmt(spot.rect.x)), y: 0, rot: spot.placed.at.rot } } : p)) }, defs));
    expect(again.parts.find((p) => p.ref === "env")!.rect.x).toBeCloseTo(spot.rect.x, 1);
    expect(again.parts.find((p) => p.ref === "env")!.placed.at.rot).toBe(spot.placed.at.rot);
  });
});

describe("lane order", () => {
  test("picks the order with the fewest crossings, then the shortest stubs", () => {
    // Lane 0 above lane 1 costs two crossings; lane 1 above lane 0 costs none.
    expect(orderLanes(2, [[0, 2], [0, 0]], [1, 1], [1, 1])).toEqual([1, 0]);
    // No crossings either way: the net with the pads below goes lower.
    expect(orderLanes(2, [[0, 0], [0, 0]], [3, 0], [0, 3])).toEqual([0, 1]);
    expect(orderLanes(2, [[0, 0], [0, 0]], [0, 3], [3, 0])).toEqual([1, 0]);
  });

  test("ties keep the order of the project; above eight nets a heuristic still returns every net once", () => {
    expect(orderLanes(3, Array.from({ length: 3 }, () => [0, 0, 0]), [1, 1, 1], [1, 1, 1])).toEqual([0, 1, 2]);
    const n = 10;
    const order = orderLanes(n, Array.from({ length: n }, () => Array.from({ length: n }, () => 0)), Array.from({ length: n }, (_, i) => i), Array.from({ length: n }, (_, i) => n - i));
    expect([...order].sort((a, b) => a - b)).toEqual(Array.from({ length: n }, (_, i) => i));
  });
});

describe("enclosure drawing", () => {
  const L = layoutEnclosure(loaded);
  const drawing = buildEnclosure(loaded, L);
  const printed = (kind: string): string => {
    const m = drawing.svg.match(new RegExp(`data-dim="${kind}" data-value="([^"]+)"`));
    expect(m).not.toBeNull();
    return m![1]!;
  };

  test("prints the overall dimensions the layout computed", () => {
    expect(printed("width")).toBe(fmt(L.outer.w));
    expect(printed("depth")).toBe(fmt(L.outer.d));
    expect(printed("height")).toBe(fmt(L.outer.h + L.lidThickness));
  });

  test("draws every opening in the view it belongs to", () => {
    for (const o of L.openings) expect(drawing.svg).toContain(`data-opening="${o.port}"`);
  });

  test("draws the lid screws and notes the wall once", () => {
    expect(L.screws.length).toBeGreaterThan(0);
    expect(drawing.svg.match(/Wall /g)).toHaveLength(1);
  });
});

describe("pin map", () => {
  test("lists each used controller pin once, with its colour", () => {
    const rows = pinRows(loaded);
    expect(rows.map((r) => r.pin).sort()).toEqual(["3V3", "A", "B", "C", "D", "GND"]);
    expect(rows.find((r) => r.pin === "GND")!.colors).toHaveLength(2);
  });

  test("number format keeps one decimal and drops a trailing zero", () => {
    expect(fmt(70)).toBe("70");
    expect(fmt(70.04)).toBe("70");
    expect(fmt(70.46)).toBe("70.5");
  });
});

describe("fit check", () => {
  const pages = buildFitCheck(loaded);

  test("is one millimetre per user unit: physical size and viewBox agree, and nothing is scaled", () => {
    for (const svg of pages) {
      expect(svg).toContain('viewBox="0 0 297 210"');
      expect(svg).toContain('width="297mm"');
      expect(svg).toContain('height="210mm"');
      expect(svg).not.toContain("scale(");
    }
  });

  test("carries a 100 mm ruler", () => {
    const m = pages[0]!.match(/class="ruler" data-length="100"><line x1="([\d.]+)" y1="[\d.]+" x2="([\d.]+)"/);
    expect(m).not.toBeNull();
    expect(Number(m![2]) - Number(m![1])).toBe(100);
    expect(pages[0]).toContain("fit to page");
  });

  test("draws each distinct part once at its true size", () => {
    for (const id of new Set(project.parts.map((p) => p.part))) expect(pages.join("")).toContain(`data-part="${id}"`);
    const d = defs.get("board")!;
    expect(pages.join("")).toContain(`width="${d.body.w}" height="${d.body.d}"`);
  });

  test("keeps the first sentence of the verify note", () => {
    expect(firstSentence("Measure the width. Then the height.")).toBe("Measure the width.");
    expect(firstSentence(undefined)).toContain("measure");
  });
});

// Two sockets side by side on one edge, and an antenna that stands out past the board: the layouts
// that used to print text over text with a clean check.
const twin = part("twin", "board", 20, 26, [io("A", 1.4, 3, 1), gnd(18.6, 5.54)], {
  ports: [
    { name: "USB native", faces: "y-", x: 5, y: 0, w: 8, h: 3, shape: "rect", margin: 2 },
    { name: "UART serial bridge", faces: "y-", x: 14.5, y: 0, w: 8, h: 3, shape: "rect", margin: 2 },
  ],
  shapes: [{ kind: "box", x: 4, y: 26, w: 12, d: 6, h: 1 }],
});
const twinDefs = new Map(defs);
twinDefs.set("twin", twin);
const twinProject: Project = {
  ...project,
  slug: "fx7",
  parts: [{ ref: "mcu", part: "twin", label: "Controller" }],
  connections: [{ from: "mcu.A", to: "mcu.GND", why: "Loop", net: "L" }],
  enclosure: { ...project.enclosure!, mounts: [{ ref: "mcu", on: "floor", x: 0, y: 0 }], openings: [{ ref: "mcu", port: "USB native" }, { ref: "mcu", port: "UART serial bridge" }] },
};

describe("case drawing places every text against what is already on the sheet", () => {
  const withInner = (inner: { w: number; d: number; h: number }) =>
    resolveProject({ ...project, enclosure: { ...project.enclosure!, inner } }, defs);

  test("a long, flat case and a small, tall one both come out clean, with the notes block clear of every view", () => {
    for (const inner of [{ w: 138, d: 44, h: 21 }, { w: 72, d: 50, h: 24 }]) {
      const d = buildEnclosure(withInner(inner));
      expect(d.checks).toEqual([]);
      expect(d.svg.match(/Wall /g)).toHaveLength(1);
    }
  });

  test("two sockets side by side keep their own labels", () => {
    const l = resolveProject(twinProject, twinDefs);
    const d = buildEnclosure(l);
    expect(d.checks).toEqual([]);
    expect(d.svg).toContain('data-opening="USB native"');
    expect(d.svg).toContain('data-opening="UART serial bridge"');
  });

  test("the fit check keeps its captions off a part's connectors and antennas", () => {
    const l = resolveProject(twinProject, twinDefs);
    const sheets = buildFitCheckSheets(l);
    expect(sheets.checks).toEqual([]);
  });

  test("every sheet's check lines reach buildDrawings", () => {
    const set = buildDrawings(resolveProject(twinProject, twinDefs));
    expect(set.checks).toEqual([...set.wiring.checks, ...(set.enclosure?.checks ?? [])]);
  });
});

// ---------------------------------------------------------------------------
// Dense, many-part and long projects (the classes a 100-project evaluation found unreadable)
// ---------------------------------------------------------------------------

const grid = (id: string, cols: number, pitch: number, names: string[]): PartDef =>
  part(id, "sensor", 4 + (cols - 1) * pitch, 4 + pitch, [
    ...Array.from({ length: cols }, (_, i) => io(names[i]!, 2 + i * pitch, 2)),
    ...Array.from({ length: cols }, (_, i) => io(names[cols + i]!, 2 + i * pitch, 2 + pitch)),
  ]);

describe("two-row headers", () => {
  const names = ["A0", "A1", "A2", "A3", "B0", "B1", "B2", "B3"];
  const defs2 = new Map(defs);
  defs2.set("g2x4", grid("g2x4", 4, 2.54, names));
  defs2.set("bar", part("bar", "sensor", 28, 6, names.map((n, i) => io(n, 2 + i * 3, 3))));
  const l2 = resolveProject(
    {
      ...project,
      slug: "fx8",
      parts: [
        { ref: "mcu", part: "board", label: "Controller" },
        { ref: "g", part: "g2x4", label: "Header" },
        { ref: "b", part: "bar", label: "Bar" },
      ],
      connections: [
        ...names.map((n) => ({ from: `g.${n}`, to: `b.${n}`, why: `Line ${n}`, net: `N_${n}` })),
        { from: "mcu.A", to: "g.A0", why: "Data", net: "N_A0" },
      ],
      enclosure: undefined,
    },
    defs2,
  );
  const w2 = buildWiring(l2);

  test("the inner row hops sideways between two outer pads instead of running through them", () => {
    expect(w2.checks.filter((c) => /touches|overlap along|runs through/.test(c))).toEqual([]);
    const g = w2.parts.find((p) => p.ref === "g")!;
    const hopped = w2.wires.filter((wire) => {
      const pad = g.pads.find((q) => wire.from.ref === "g" && q.name === wire.from.pin);
      return pad && wire.path[1] && Math.abs(wire.path[1]![0] - pad.x) + Math.abs(wire.path[1]![1] - pad.y) > 0.5 && (wire.path[1]![0] === pad.x) !== (wire.path[1]![1] === pad.y);
    });
    expect(hopped.length).toBeGreaterThan(0);
  });

  test("a part whose names need room is drawn larger, says so beside its name, and every name stays at 1.6 mm", () => {
    expect(w2.svg).toMatch(/drawn \d/);
    for (const l of w2.pinLabels) expect(l.fontSize * 0.714 * w2.scale).toBeGreaterThanOrEqual(1.6);
  });
});

describe("a plan too big for one sheet is split, wires that cross sheets end at 'to sheet N' blocks", () => {
  const many = Array.from({ length: 16 }, (_, i) => i);
  const bigDefs = new Map(defs);
  const l3 = resolveProject(
    {
      ...project,
      slug: "fx9",
      parts: [{ ref: "mcu", part: "board", label: "Controller" }, ...many.map((i) => ({ ref: `d${i}`, part: "disp", label: `Display number ${i + 1}` }))],
      connections: [
        { from: "mcu.GND", to: "d0.GND", why: "Ground" },
        ...many.slice(1).map((i) => ({ from: `d${i - 1}.SDA`, to: `d${i}.SCL`, why: `Chain ${i}`, net: `LINK_${i}` })),
      ],
      enclosure: undefined,
    },
    bigDefs,
  );
  const w3 = buildWiring(l3);

  test("more than one sheet, each readable, none with a check line", () => {
    expect(w3.sheets.length).toBeGreaterThan(1);
    for (const s of w3.sheets) expect(s.scale).toBeGreaterThanOrEqual(2 / 3 - 1e-9);
    expect(w3.checks).toEqual([]);
  });

  test("every connection is drawn, a cut one on both of its sheets, and the step numbers stay the project's", () => {
    const n = l3.project.connections.length;
    const seen = new Map<number, number>();
    for (const s of w3.sheets) for (const wire of s.wires) seen.set(wire.step, (seen.get(wire.step) ?? 0) + 1);
    for (let step = 1; step <= n; step++) expect(seen.get(step)).toBeGreaterThanOrEqual(1);
    expect([...seen.keys()].every((s) => s >= 1 && s <= n)).toBe(true);
    const cut = [...seen.values()].filter((c) => c === 2).length;
    expect(cut).toBeGreaterThan(0);
    expect(w3.sheets.some((s) => s.parts.some((p) => p.placed.def.id.startsWith("sheet-edge-")))).toBe(true);
  });

  test("the pages list the plan sheets first, then the connections", () => {
    const set = buildDrawings(l3);
    const first = set.html.indexOf("sheet 1 of");
    expect(first).toBeGreaterThan(-1);
    expect(set.html.indexOf("Wiring, connections")).toBeGreaterThan(set.html.lastIndexOf(`sheet ${w3.sheets.length} of`));
  });
});

describe("a plan that cannot be drawn says so", () => {
  test("a part bigger than any sheet gives a check line, not a silent tangle", () => {
    const hugeDefs = new Map(defs);
    hugeDefs.set("huge", part("huge", "sensor", 900, 900, [io("A", 10, 10), io("B", 20, 10)]));
    const l = resolveProject(
      { ...project, slug: "fx10", parts: [{ ref: "mcu", part: "board", label: "Controller" }, { ref: "h", part: "huge", label: "Huge" }], connections: [{ from: "mcu.A", to: "h.A", why: "x" }, { from: "mcu.B", to: "h.B", why: "y" }], enclosure: undefined },
      hugeDefs,
    );
    const w = buildWiring(l);
    expect(w.checks.length).toBeGreaterThan(0);
  });

  test("a plan no scale holds is shrunk onto the sheet and says it is not to scale", () => {
    // Seen on a radio with a 2 x 4 header: the plan was drawn past the title and over the connections list.
    const hugeDefs = new Map(defs);
    hugeDefs.set("huge", part("huge", "sensor", 2000, 2000, [io("A", 10, 10), io("B", 20, 10)]));
    const l = resolveProject(
      { ...project, slug: "fx11", parts: [{ ref: "mcu", part: "board", label: "Controller" }, { ref: "h", part: "huge", label: "Huge" }], connections: [{ from: "mcu.A", to: "h.A", why: "x" }, { from: "mcu.B", to: "h.B", why: "y" }], enclosure: undefined },
      hugeDefs,
    );
    const w = buildWiring(l);
    const sheet = (w.sheets ?? [w])[0]!;
    // 2000 mm at the smallest scale on offer (1 : 5) is 400 mm: taller than A4 landscape.
    expect(2000 * sheet.scale).toBeLessThan(210);
    expect(sheet.svg).toContain("Scale none: shrunk to fit");
    expect(w.checks.some((c) => c.includes("not to scale"))).toBe(true);
  });
});

describe("connections legend", () => {
  const rows = (n: number): Row[] => Array.from({ length: n }, (_, i) => ({ step: i + 1, hex: "#c22", from: `mcu.P${i}`, to: `x.P${i}`, why: `A reason for wire number ${i + 1} that is long enough to take a second line on the sheet` }));
  test("a long list is paginated: every row once, no page past its sheet", () => {
    const pages = legendPages(loaded, rows(130));
    expect(pages.length).toBeGreaterThan(1);
    expect(pages.some((p) => p.over)).toBe(false);
    const all = pages.map((p) => p.svg).join("");
    for (let step = 1; step <= 130; step++) expect(all.split(`class="row" data-step="${step}"`)).toHaveLength(2);
  });
  test("a short list stays on one page", () => {
    expect(legendPages(loaded, rows(14))).toHaveLength(1);
  });
});

describe("debug listing of a split plan", () => {
  test("lists every sheet, including the 'to sheet N' blocks, without failing", () => {
    const many = Array.from({ length: 16 }, (_, i) => i);
    const l = resolveProject(
      {
        ...project,
        slug: "fx11",
        parts: [{ ref: "mcu", part: "board", label: "Controller" }, ...many.map((i) => ({ ref: `d${i}`, part: "disp", label: `Display number ${i + 1}` }))],
        connections: [{ from: "mcu.GND", to: "d0.GND", why: "Ground" }, ...many.slice(1).map((i) => ({ from: `d${i - 1}.SDA`, to: `d${i}.SCL`, why: `Chain ${i}`, net: `LINK_${i}` }))],
        enclosure: undefined,
      },
      defs,
    );
    const w = buildWiring(l);
    const lines = debugLines(l, w);
    expect(w.sheets.length).toBeGreaterThan(1);
    expect(lines.filter((x) => x.startsWith("sheet "))).toHaveLength(w.sheets.length);
    expect(lines.some((x) => x.trim().startsWith("to2 "))).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// Names that cannot stand at their pads: numbers, a pin key, parts lying flat, pads of a short block
// ---------------------------------------------------------------------------

describe("a 2 x 4 header with four-letter names needs a pin key, not a part four times its size", () => {
  const radioNames = ["GND", "VCC", "CE", "CSN", "SCK", "MOSI", "MISO", "IRQ"];
  const radioDefs = new Map(defs);
  radioDefs.set(
    "radio",
    part("radio", "sensor", 15, 41, [
      ...radioNames.slice(0, 4).map((n, i) => io(n, 3.8 + i * 2.54, 39.5)),
      ...radioNames.slice(4).map((n, i) => io(n, 3.8 + i * 2.54, 37)),
    ]),
  );
  const lr = resolveProject(
    {
      ...project,
      slug: "fx12",
      parts: [{ ref: "mcu", part: "board", label: "Controller" }, { ref: "rf", part: "radio", label: "Radio" }],
      connections: radioNames.slice(0, 6).map((n, i) => ({ from: `mcu.${["A", "B", "C", "D", "3V3", "GND"][i]}`, to: `rf.${n}`, why: n, net: `RF_${n}` })),
      enclosure: undefined,
    },
    radioDefs,
  );
  const wr = buildWiring(lr);

  test("one readable sheet with no check line, the radio carrying numbers and a key", () => {
    expect(wr.checks).toEqual([]);
    expect(wr.sheets).toHaveLength(1);
    expect(wr.scale).toBeGreaterThanOrEqual(2 / 3 - 1e-9);
    const key = wr.keys.find((k) => k.ref === "rf");
    expect(key).toBeDefined();
    expect(key!.key.entries.map((e) => e.name).sort()).toEqual(radioNames.slice(0, 6).sort());
    expect(wr.svg).toContain('class="pin-key"');
  });

  test("the numbers at the pads and the key text are at 1.6 mm cap height or more, and the radio is not drawn at 4 : 1", () => {
    for (const l of wr.pinLabels) expect(l.fontSize * 0.714 * wr.scale).toBeGreaterThanOrEqual(1.6);
    for (const k of wr.keys) expect(k.key.font * 0.714 * wr.scale).toBeGreaterThanOrEqual(1.6);
    const rf = wr.parts.find((p) => p.ref === "rf")!;
    expect(rf.rect.d / 41).toBeLessThan(3);
    const numbers = wr.pinLabels.filter((l) => l.ref === "rf" && l.wired).map((l) => l.text);
    expect(numbers.every((t) => /^\d+$/.test(t))).toBe(true);
  });
});

describe("a part too long to stand in the row lies down instead", () => {
  const longDefs = new Map(defs);
  longDefs.set("strip", part("strip", "light", 24, 210, ["A", "B", "C", "D", "E", "F"].map((n, i) => io(n, 3 + i * 3.4, 207))));
  const ll = resolveProject(
    {
      ...project,
      slug: "fx13",
      parts: [{ ref: "mcu", part: "board", label: "Controller" }, { ref: "s", part: "strip", label: "Long strip" }],
      connections: ["A", "B", "C", "D", "3V3", "GND"].map((p, i) => ({ from: `mcu.${p}`, to: `s.${["A", "B", "C", "D", "E", "F"][i]}`, why: `Line ${i}`, net: `L${i}` })),
      enclosure: undefined,
    },
    longDefs,
  );
  const wl = buildWiring(ll);
  test("no check line, the strip lying with its long side across the sheet", () => {
    expect(wl.checks).toEqual([]);
    const s = wl.parts.find((p) => p.ref === "s")!;
    expect(s.rect.w).toBeGreaterThan(s.rect.d);
    expect(wl.scale).toBeGreaterThanOrEqual(2 / 3 - 1e-9);
  });
});

describe("which edge a pad leaves by", () => {
  const block = part("blk", "board", 40, 36, [
    // A short block of three columns close to the right side, rows 2.54 apart: three pads share each y, but the side is the way out.
    ...[12, 14.5, 17, 19.5, 22, 24.5].flatMap((y, i) => [io(`a${i}`, 36.8, y), io(`b${i}`, 33.6, y), io(`c${i}`, 31, y)]),
    // A strip of pads along the bottom, the corner one nearer the side than the bottom.
    ...[1.5, 4, 6.5, 9, 11.5].map((x, i) => io(`s${i}`, x, 34)),
  ]);
  const placed = { use: { ref: "p", part: "blk" }, def: block, at: { x: 0, y: 0, z: 0, rot: 0 as const } };
  const fp = flatPart(placed);
  test("a short block of pads near a side leaves by the side, not by the top", () => {
    for (const q of fp.pads.filter((x) => /^[abc]\d$/.test(x.name))) expect(q.dir).toBe("E");
  });
  test("a corner pad of a strip still leaves with its row", () => {
    for (const q of fp.pads.filter((x) => /^s\d$/.test(x.name))) expect(q.dir).toBe("S");
  });
  test("pads in line with others, or close enough to touch their rings, hop between the outer pads", () => {
    const aligned = part("al", "sensor", 40, 12, [io("o0", 18, 10), io("o1", 20.54, 10), io("i0", 18, 7.46), io("i1", 20.54, 7.46)]);
    const fa = flatPart({ use: { ref: "q", part: "al" }, def: aligned, at: { x: 0, y: 0, z: 0, rot: 0 as const } });
    const inner = fa.pads.find((x) => x.name === "i0")!;
    expect(hopOf(fa, inner).hop[0]).toBeCloseTo(1.27, 2);
    expect(hopOf(fa, fa.pads.find((x) => x.name === "o0")!).hop).toEqual([0, 0]);
    const offset = part("of", "sensor", 40, 12, [io("o0", 18, 10), io("o1", 20.54, 10), io("i0", 19.27, 7.46)]);
    const fo = flatPart({ use: { ref: "r", part: "of" }, def: offset, at: { x: 0, y: 0, z: 0, rot: 0 as const } });
    // Half a column off already: the middle of the gap is where it is.
    expect(Math.abs(hopOf(fo, fo.pads.find((x) => x.name === "i0")!).hop[0])).toBeLessThan(0.05);
  });
});
