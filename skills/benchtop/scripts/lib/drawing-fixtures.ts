// Fixtures for the drawing tests: a few small parts that do not depend on the part
// library, and the geometry the renderer produced before the drawing check existed.
//
// `legacyGeom` keeps the old drawing rules on record, formula for formula, so the
// regression tests can show that each check fires on what the booklet used to draw:
//   - a wire was a flat curve leaving both pads straight up the page, painted over
//     every solid, with a solder dot on each end whether or not the pad could be seen;
//   - a guide line was painted whole, over whatever it crossed;
//   - a pin label ran inward from the nearest edge of its part, whatever stood there.

import { type Pt, type V3, bezier, proj } from "./geom";
import { type DrawnLabel, type Scene, type SceneGeom, freeTextQuad, labelCandidates, renderScene } from "./iso";
import { resolveProject } from "./project";
import type { Connection, EnclosureSpec, PartDef, PartUse, PinDef, Project } from "./types";

const pin = (name: string, x: number, y: number, extra: Partial<PinDef> = {}): PinDef => ({ name, role: "passive", x, y, ...extra });

function part(id: string, kind: PartDef["kind"], body: PartDef["body"], pins: PinDef[], shapes: PartDef["shapes"] = []): PartDef {
  const maxHeight = body.h + Math.max(0, ...(shapes ?? []).map((s) => (s.z ?? 0) + s.h));
  return { id, name: id, kind, blurb: "", body, maxHeight, shapes, pins, electrical: {}, sourcing: { search: [], priceUsd: 0 }, sources: [], confidence: "typical" };
}

/** A 6 mm push button: four legs on the corners of the outline and a tall stem in the middle. */
export const BUTTON = part(
  "button",
  "input",
  { w: 6.5, d: 6, h: 3.4 },
  [pin("1", 0, 0.75), pin("2", 0, 5.25), pin("1b", 6.5, 0.75), pin("2b", 6.5, 5.25)],
  [{ kind: "cyl", tag: "stem", x: 3.25, y: 3, z: 0, r: 1.75, h: 6.1 }],
);

/** The same button with its legs where they really are: at the foot of the body. */
export const BUTTON_WITH_LEGS: PartDef = { ...BUTTON, pins: BUTTON.pins.map((p) => ({ ...p, z: -3.4 })) };

/** A small display: a row of four pads along one edge and a glass panel covering most of the board. */
export const DISPLAY = part(
  "display",
  "display",
  { w: 27.3, d: 27.8, h: 1.6 },
  [pin("GND", 9.84, 2.3), pin("VCC", 12.38, 2.3), pin("SCL", 14.92, 2.3), pin("SDA", 17.46, 2.3)],
  [{ kind: "box", tag: "glass", x: 0.3, y: 4.27, z: 0, w: 26.7, d: 19.27, h: 1.5 }],
);

/** A sensor breakout: four pads in a row, one low component. */
export const SENSOR = part(
  "sensor",
  "sensor",
  { w: 15, d: 11.5, h: 1.6 },
  [pin("VCC", 3.69, 1.9), pin("GND", 6.23, 1.9), pin("SCL", 8.77, 1.9), pin("SDA", 11.31, 1.9)],
  [{ kind: "box", tag: "can", x: 6, y: 6, z: 0, w: 2.5, d: 2.5, h: 0.9 }],
);

/** A controller board: a header row down each long side and a USB socket at the back. */
export const BOARD = part(
  "board",
  "board",
  { w: 18, d: 22.5, h: 1 },
  [
    ...["5V", "GND", "3V3", "4", "3", "2"].map((n, i) => pin(n, 16.8, 3.24 + i * 2.54)),
    ...["5", "6", "7", "8", "9", "10"].map((n, i) => pin(n, 1.2, 3.24 + i * 2.54)),
  ],
  [{ kind: "box", tag: "usb", x: 4.5, y: -1, z: 0, w: 9, d: 7.4, h: 3.2 }],
);

export const DEFS = new Map<string, PartDef>([BUTTON, DISPLAY, SENSOR, BOARD].map((d) => [d.id, d]));

export function project(parts: PartUse[], connections: Connection[], enclosure?: EnclosureSpec): Project {
  return {
    schema: 1,
    slug: "test",
    name: "Test",
    tagline: "",
    summary: "",
    build: { path: "wire", joint: "solder", difficulty: 1, minutes: 10 },
    power: { source: "usb", volts: 5, budgetMa: 500 },
    parts,
    connections,
    enclosure,
  };
}

export const load = (parts: PartUse[], connections: Connection[], defs = DEFS, enclosure?: EnclosureSpec) =>
  resolveProject(project(parts, connections, enclosure), defs);

/** The flat curve the old renderer drew for a wire: both ends leave straight up the page. */
export function legacyWirePath(a: V3, b: V3, index = 0): Pt[] {
  const pa = proj(...a);
  const pb = proj(...b);
  const span = Math.hypot(pa[0] - pb[0], pa[1] - pb[1]);
  const lift = 4 + span * 0.1 + (index % 4) * 1.6;
  const ctrl: [Pt, Pt, Pt, Pt] = [pa, [pa[0], pa[1] - lift], [pb[0], pb[1] - lift], pb];
  const out: Pt[] = [];
  for (let i = 0; i <= 96; i++) out[i] = bezier(ctrl, i / 96);
  return out;
}

/** The geometry of a scene as the renderer drew it before the drawing check existed. */
export function legacyGeom(scene: Scene): SceneGeom {
  // Solids and pad rings were drawn the same way then as now.
  const base = renderScene({ solids: scene.solids }).geom;
  const labels: DrawnLabel[] = [];
  for (const s of scene.solids) {
    for (const p of s.pads ?? []) {
      if (!p.label || !p.labelDir) continue;
      // The first candidate is the old rule: on the face, inward from the nearest edge.
      const c = labelCandidates(s, p, p.label)[0]!;
      labels[labels.length] = { text: p.label, quad: c.quad, kind: "face", part: s.part, pin: p.pin, target: p.mark === "target", samples: c.samples };
    }
  }
  for (const t of scene.texts ?? []) labels[labels.length] = { text: t.text, quad: freeTextQuad(t), kind: "free", part: t.part };
  const sorted = [...(scene.wires ?? [])].sort((p, q) => (p.state === q.state ? 0 : p.state === "done" ? -1 : 1));
  const wires = sorted.map((w, i) => {
    const path = legacyWirePath(w.a, w.b, i);
    const dot = (p: V3): Pt | null => (w.state === "now" ? proj(...p) : null);
    // The old wire had no depth. A straight line between its ends is the nearest thing to where it was.
    const path3 = path.map((_, k): V3 => {
      const t = k / (path.length - 1);
      return [w.a[0] + (w.b[0] - w.a[0]) * t, w.a[1] + (w.b[1] - w.a[1]) * t, w.a[2] + (w.b[2] - w.a[2]) * t];
    });
    return {
      color: w.color,
      state: w.state,
      ends: [
        { pad: w.ends?.[0], at: w.a, screen: proj(...w.a), dot: dot(w.a) },
        { pad: w.ends?.[1], at: w.b, screen: proj(...w.b), dot: dot(w.b) },
      ] as SceneGeom["wires"][number]["ends"],
      path,
      path3,
      runs: [path],
    };
  });
  const guides = (scene.guides ?? []).map((g) => ({ a: g.a, b: g.b, runs: [[g.a, g.b]] as [V3, V3][], drawn: [[proj(...g.a), proj(...g.b)]] as [Pt, Pt][] }));
  return { ...base, labels, wires, guides, unplaced: [] };
}
