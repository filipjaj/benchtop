import { describe, expect, test } from "bun:test";
import {
  MAX_TURN,
  bubbleProblems,
  checkScene,
  checkWiringStep,
  formatFinding,
  guideProblems,
  hoverProblems,
  intersectProblems,
  labelProblems,
  wireEndProblems,
  wirePathProblems,
} from "./drawing-check";
import { BOARD, BUTTON, BUTTON_WITH_LEGS, DEFS, DISPLAY, SENSOR, legacyGeom, legacyWirePath, load } from "./drawing-fixtures";
import type { EnclosureLayout } from "./enclosure-layout";
import { type Pt, type V3, backtrack, circlePoly, proj, sharpestTurn, silhouette, textQuad } from "./geom";
import { type DrawnLabel, type DrawnSolid, type DrawnWire, type FreeText, type Scene, type SceneGeom, type Solid, footprint, partSolids, renderScene, wireCurve } from "./iso";
import { type WiringStepGeom, benchFrame, benchScene, benchView, enclosureLidArts, lidSolids, wiringStepArt } from "./scenes";
import type { PartDef } from "./types";

// ---------------------------------------------------------------------------
// Hand-built geometry
// ---------------------------------------------------------------------------

const box = (x: number, y: number, z: number, w: number, d: number, h: number, extra: Partial<Solid> = {}): Solid => ({ kind: "box", x, y, z, w, d, h, ...extra });
const drawn = (s: Solid, ghost = false): DrawnSolid => ({ solid: s, ghost, outline: silhouette(s) });
const geom = (g: Partial<SceneGeom>): SceneGeom => ({ solids: [], pads: [], wires: [], labels: [], guides: [], arrows: [], unplaced: [], ...g });
const checks = (ps: { check: string }[]): string[] => ps.map((p) => p.check);

/** A wire being added between two points, drawn as the renderer would draw it, dots included. */
function wire(a: V3, b: V3, over: Partial<DrawnWire> = {}): DrawnWire {
  const c = wireCurve(a, b, 6);
  return {
    color: "red",
    state: "now",
    ends: [
      { pad: { ref: "mcu", pin: "A" }, at: a, screen: proj(...a), dot: proj(...a) },
      { pad: { ref: "btn", pin: "1" }, at: b, screen: proj(...b), dot: proj(...b) },
    ],
    path: c.path,
    path3: c.path3,
    runs: [c.path],
    ...over,
  };
}

const pad = (part: string, pin: string, at: V3, target = true) => ({ part, pin, at, screen: proj(...at), target });
const upright = (text: string, at: Pt, over: Partial<DrawnLabel> = {}): DrawnLabel => ({ text, kind: "free", quad: textQuad(at, [1, 0], [0, 1], text, 2, "start"), ...over });

// A pad at the back of a block with a tall post standing between it and the viewer.
const A: V3 = [-30, 20, 1];
const B: V3 = [0, 0.75, 3.4];
const BODY = box(0, 0, 0, 6.5, 6, 3.4, { part: "btn", tag: "btn" });
const POST = box(1.5, 1.5, 3.4, 3.5, 3, 6, { part: "btn", tag: "stem" });

describe("wire ends", () => {
  test("a dot painted over the solid that hides its pad is reported, naming the solid", () => {
    const g = geom({ solids: [drawn(BODY), drawn(POST)], pads: [pad("mcu", "A", A), pad("btn", "1", B)], wires: [wire(A, B)] });
    const found = wireEndProblems(g);
    expect(checks(found)).toEqual(["wire-end-hidden"]);
    expect(found[0]!.part).toBe("btn");
    expect(found[0]!.what).toContain("behind btn stem");
    expect(found[0]!.what).toContain("painted on top of");
    expect(found[0]!.fix).toContain(`"bench"`);
    expect(found[0]!.fix).toContain(`"z"`);
  });

  test("a hidden pad with no dot is still reported, as a wire passing behind", () => {
    const w = wire(A, B);
    w.ends[1].dot = null;
    const found = wireEndProblems(geom({ solids: [drawn(BODY), drawn(POST)], pads: [pad("mcu", "A", A), pad("btn", "1", B)], wires: [w] }));
    expect(checks(found)).toEqual(["wire-end-hidden"]);
    expect(found[0]!.what).toContain("passing behind");
  });

  test("a see-through solid hides nothing, and a pad in the open passes", () => {
    const pads = [pad("mcu", "A", A), pad("btn", "1", B)];
    expect(wireEndProblems(geom({ solids: [drawn(BODY), drawn(POST, true)], pads, wires: [wire(A, B)] }))).toEqual([]);
    expect(wireEndProblems(geom({ solids: [drawn(BODY)], pads, wires: [wire(A, B)] }))).toEqual([]);
  });

  test("a dot that is not on the pad it names is reported", () => {
    const elsewhere = pad("btn", "1", [6.5, 5.25, 3.4]);
    const found = wireEndProblems(geom({ solids: [drawn(BODY)], pads: [pad("mcu", "A", A), elsewhere], wires: [wire(A, B)] }));
    expect(checks(found)).toEqual(["wire-end-off-pad"]);
    expect(found[0]!.what).toContain("mm from");
    const none = wireEndProblems(geom({ solids: [drawn(BODY)], pads: [pad("mcu", "A", A)], wires: [wire(A, B)] }));
    expect(none[0]!.what).toContain("no pad of that name");
  });

  test("finished wires are not checked: only the wire being added has to be followed", () => {
    const g = geom({ solids: [drawn(BODY), drawn(POST)], pads: [pad("btn", "1", B)], wires: [wire(A, B, { state: "done" })] });
    expect(wireEndProblems(g)).toEqual([]);
  });
});

describe("wire paths", () => {
  test("a wire that folds back on itself is reported with the angle", () => {
    // Up 8 mm and straight back down 0.3 mm to the side: a spike.
    const path: Pt[] = [];
    for (let i = 0; i <= 20; i++) path[i] = [0, -i * 0.4];
    for (let i = 1; i <= 15; i++) path[20 + i] = [0.3, -8 + i * 0.4];
    const found = wirePathProblems(geom({ wires: [wire(A, B, { path, runs: [path] })] }));
    expect(checks(found)).toEqual(["wire-reversal"]);
    expect(found[0]!.what).toMatch(/turns 1\d\d degrees/);
  });

  test("a gentle arc is not a reversal", () => {
    expect(wirePathProblems(geom({ wires: [wire(A, B)] }))).toEqual([]);
  });

  test("two ends on one spot of the page are reported with what to move", () => {
    // b is straight toward the camera from a: both land on the same point of the page.
    const a: V3 = [10, 10, 1];
    const b: V3 = [12, 12, 1 + 2 * Math.SQRT2 * Math.tan(Math.PI / 6)];
    const found = wirePathProblems(geom({ wires: [wire(a, b)] }));
    expect(checks(found)).toEqual(["wire-reversal"]);
    expect(found[0]!.what).toContain("one in front of the other");
    expect(found[0]!.fix).toContain(`"bench"`);
  });

  test("a wire through a solid is reported, naming the solid and its part", () => {
    const wall = box(-20, 5, 0, 10, 10, 30, { part: "sonar", tag: "can" });
    const w = wire(A, B);
    // Straight through the middle of the wall, low down.
    w.path3 = w.path3.map((_, i): V3 => [A[0] + ((B[0] - A[0]) * i) / (w.path3.length - 1), A[1] + ((B[1] - A[1]) * i) / (w.path3.length - 1), 2]);
    const found = wirePathProblems(geom({ solids: [drawn(wall)], wires: [w] }));
    expect(checks(found)).toEqual(["wire-through-part"]);
    expect(found[0]!.what).toContain("sonar can");
    expect(found[0]!.part).toBe("sonar");
  });
});

describe("labels", () => {
  test("two overlapping labels are reported once, by name", () => {
    const found = labelProblems(geom({ labels: [upright("Button", [0, 0], { part: "btn" }), upright("Air sensor", [4, 0.5], { part: "env" })] }));
    expect(checks(found)).toEqual(["label-overlap"]);
    expect(found[0]!.what).toContain(`"Button"`);
    expect(found[0]!.what).toContain(`"Air sensor"`);
    expect(found[0]!.fix).toContain(`"label"`);
  });

  test("labels side by side do not overlap", () => {
    expect(labelProblems(geom({ labels: [upright("Button", [0, 0]), upright("Air sensor", [12, 0])] }))).toEqual([]);
  });

  test("a label lying on a face under a component is reported as covered", () => {
    const board = box(0, 0, 0, 20, 20, 1.6, { part: "oled", tag: "oled" });
    const glass = box(0, 4, 1.6, 20, 12, 1.5, { part: "oled", tag: "glass" });
    const under: DrawnLabel = { text: "VCC", kind: "face", part: "oled", pin: "VCC", quad: [proj(5, 5, 1.6), proj(8, 5, 1.6), proj(8, 6, 1.6), proj(5, 6, 1.6)], samples: [[5, 5, 1.6], [8, 6, 1.6]] };
    const found = labelProblems(geom({ solids: [drawn(board), drawn(glass)], labels: [under] }));
    expect(checks(found)).toEqual(["label-hidden"]);
    expect(found[0]!.what).toContain("oled glass");
    const clear: DrawnLabel = { ...under, quad: [proj(5, 1, 1.6), proj(8, 1, 1.6), proj(8, 2, 1.6), proj(5, 2, 1.6)], samples: [[5, 1, 1.6], [8, 2, 1.6]] };
    expect(labelProblems(geom({ solids: [drawn(board), drawn(glass)], labels: [clear] }))).toEqual([]);
  });

  test("an upright label across the edge of a hovering part is reported; wholly on its own part it is not", () => {
    const plate = box(0, 0, 20, 30, 30, 1.6, { part: "oled", hover: { group: "lid parts", item: "oled" } });
    const centre = proj(15, 15, 21.6);
    const edge = proj(30, 15, 21.6);
    const on = upright("Display", [centre[0] - 4, centre[1]], { part: "oled" });
    const across = upright("Display", [edge[0] - 2, edge[1]], { part: "oled" });
    expect(labelProblems(geom({ solids: [drawn(plate)], labels: [on] }))).toEqual([]);
    expect(checks(labelProblems(geom({ solids: [drawn(plate)], labels: [across] })))).toEqual(["label-hidden"]);
    // Another part's name on this part is never right, even wholly inside it.
    expect(checks(labelProblems(geom({ solids: [drawn(plate)], labels: [{ ...on, part: "btn" }] })))).toEqual(["label-hidden"]);
  });

  test("a label crossed by the wire being added, or by a guide line, is reported", () => {
    const w = wire([-10, 0, 0], [10, 0, 0]);
    const mid = w.path[Math.floor(w.path.length / 2)]!;
    const label = upright("GND", [mid[0] - 2, mid[1] + 0.8]);
    const byWire = labelProblems(geom({ wires: [w], labels: [label] }));
    expect(checks(byWire)).toEqual(["label-under-line"]);
    expect(byWire[0]!.what).toContain("the wire being added");
    const byGuide = labelProblems(geom({ labels: [label], guides: [{ a: [0, 0, 0], b: [0, 0, 1], runs: [], drawn: [[[mid[0], mid[1] - 5], [mid[0], mid[1] + 5]]] }] }));
    expect(byGuide[0]!.what).toContain("a guide line");
    // A finished wire under a label is allowed: labels are painted over finished wires.
    expect(labelProblems(geom({ wires: [{ ...w, state: "done" }], labels: [label] }))).toEqual([]);
  });
});

describe("guides", () => {
  const plate = box(0, 0, 20, 30, 30, 2, { part: "oled", tag: "oled" });

  test("a guide painted across the solid in front of it is reported", () => {
    // Straight down from the back corner: behind the plate all the way.
    const a: V3 = [0, 0, 20];
    const b: V3 = [0, 0, 0];
    const found = guideProblems(geom({ solids: [drawn(plate)], guides: [{ a, b, runs: [[a, b]], drawn: [[proj(...a), proj(...b)]] }] }));
    expect(checks(found)).toEqual(["guide-over-solid"]);
    expect(found[0]!.what).toContain("oled");
  });

  test("the renderer's own guides stop at the solid", () => {
    const scene: Scene = { solids: [plate], guides: [{ a: [0, 0, 20], b: [0, 0, 0] }, { a: [30, 30, 20], b: [30, 30, 0] }] };
    const r = renderScene(scene);
    expect(guideProblems(r.geom)).toEqual([]);
    // The back corner's guide is wholly behind the plate; the front corner's is wholly in view.
    expect(r.geom.guides[0]!.runs).toEqual([]);
    expect(r.geom.guides[1]!.runs).toHaveLength(1);
  });
});

describe("hovering parts", () => {
  const hov = (item: string, x: number, group = "lid parts"): Solid => box(x, 0, 20, 10, 10, 2, { part: item, hover: { group, item } });

  test("two hovering parts whose outlines overlap on the page are reported", () => {
    // Side by side with a 1 mm gap at one height: the nearer one's thickness covers the other's edge.
    const found = hoverProblems(geom({ solids: [drawn(hov("oled", 0)), drawn(hov("btn", 11))] }));
    expect(checks(found)).toEqual(["hover-overlap"]);
    expect(found[0]!.fix).toContain("enclosure.mounts");
  });

  test("parts apart on the page, and parts that land on different things, are not", () => {
    expect(hoverProblems(geom({ solids: [drawn(hov("oled", 0)), drawn(hov("btn", 40))] }))).toEqual([]);
    expect(hoverProblems(geom({ solids: [drawn(hov("lid", 0, "lid")), drawn(hov("screw 1", 11, "screws"))] }))).toEqual([]);
  });
});

describe("solids", () => {
  test("two parts placed in the same space are reported once", () => {
    const a = box(0, 0, 0, 10, 10, 2, { part: "oled" });
    const b = box(5, 5, 0, 10, 10, 2, { part: "env" });
    const found = intersectProblems(geom({ solids: [drawn(a), drawn(b)] }));
    expect(checks(found)).toEqual(["parts-intersect"]);
    expect(intersectProblems(geom({ solids: [drawn(a), drawn(box(10, 0, 0, 5, 5, 2, { part: "env" }))] }))).toEqual([]);
    // Solids of one part stand on each other by design.
    expect(intersectProblems(geom({ solids: [drawn(a), drawn(box(2, 2, 1, 3, 3, 4, { part: "oled" }))] }))).toEqual([]);
  });
});

describe("bubbles", () => {
  const target = { ref: "btn", pin: "1", at: B, label: "Button" };
  const labelBy = (dx: number): DrawnLabel => {
    const t = proj(...B);
    return { text: "1", kind: "face", part: "btn", pin: "1", quad: [[t[0] + dx, t[1] - 0.5], [t[0] + dx + 1, t[1] - 0.5], [t[0] + dx + 1, t[1] + 0.5], [t[0] + dx, t[1] + 0.5]] };
  };
  const step = (inside: Partial<SceneGeom>, over: Partial<WiringStepGeom["bubbles"][number]> = {}): WiringStepGeom => ({
    main: geom({}),
    bubbles: [{ centre: [0, 0], radius: 17, zoom: 2.6, target, geom: geom({ pads: [pad("btn", "1", B)], labels: [labelBy(1.5)], ...inside }), seeThrough: false, ...over }],
    captions: [],
  });

  test("a bubble whose pad is behind a solid is reported", () => {
    const found = bubbleProblems(step({ solids: [drawn(BODY), drawn(POST)] }));
    expect(checks(found)).toEqual(["bubble-target-hidden"]);
    expect(found[0]!.what).toContain("behind btn stem");
  });

  test("a bubble that shows the pad, filled, with its name beside it passes", () => {
    expect(bubbleProblems(step({ solids: [drawn(BODY), drawn(POST, true)] }))).toEqual([]);
  });

  test("a bubble not centred on a drawn pad is reported", () => {
    expect(checks(bubbleProblems(step({ pads: [] })))).toEqual(["bubble-target-hidden"]);
  });

  test("a pad whose name has no place, or falls outside the circle, is reported", () => {
    const missing = bubbleProblems(step({ labels: [] }));
    expect(checks(missing)).toEqual(["label-missing"]);
    expect(missing[0]!.fix).toContain("fault in the renderer");
    const cut = bubbleProblems(step({ labels: [labelBy(6.2)] }));
    expect(checks(cut)).toEqual(["label-missing"]);
    expect(cut[0]!.what).toContain("cut off");
    expect(cut[0]!.fix).toContain("fault in the renderer");
  });

  test("two bubbles that overlap, and a caption that runs into a bubble, are reported", () => {
    const s = step({});
    s.bubbles[1] = { ...s.bubbles[0]!, centre: [20, 0] };
    expect(checks(bubbleProblems(s))).toContain("bubble-overlap");
    const t = step({});
    t.captions = [upright("Distance sensor VCC", [-10, 0], { part: "sonar" })];
    expect(checks(bubbleProblems(t))).toEqual(["label-overlap"]);
    expect(circlePoly([0, 0], 17)).toHaveLength(16);
  });
});

test("a finding prints as one line with the page, step, part, problem and fix", () => {
  const line = formatFinding({ check: "wire-end-hidden", page: 8, step: 9, drawing: "Controller 10 to Button 1", part: "btn", what: "the Button pad 1 is behind btn stem.", fix: `Set "bench" on part "btn".` });
  expect(line).toBe(`drawing: page 8, step 9 (Controller 10 to Button 1), part "btn": The Button pad 1 is behind btn stem. Set "bench" on part "btn".`);
  expect(line).not.toContain("\n");
});

// ---------------------------------------------------------------------------
// Regressions: the three drawings a reader marked as wrong
// ---------------------------------------------------------------------------

describe("regression: a wire end painted on the stem of a push button", () => {
  const parts = (bench?: { x: number; y: number; rot: 0 }) => [
    { ref: "mcu", part: "board", label: "Controller" },
    { ref: "btn", part: "button", label: "Button", bench },
  ];
  const wires = [{ from: "mcu.10", to: "btn.1" }];
  // rot 0 is what the bench layout chose: leg 1 sits at the back, behind the stem.
  const pinned = load(parts({ x: 40, y: 0, rot: 0 }), wires);

  test("as it was drawn: the dot sits on the stem, and the leg's name runs under it", () => {
    const old = legacyGeom(benchScene(pinned, 0, 0));
    const ends = wireEndProblems(old);
    expect(checks(ends)).toEqual(["wire-end-hidden"]);
    expect(ends[0]!.what).toContain("painted on top of btn stem");
    expect(checks(labelProblems(old))).toContain("label-hidden");
  });

  test("with the part pinned that way, the wire now passes behind the stem and the bubble shows the leg through it", () => {
    const art = wiringStepArt(pinned, 0, benchFrame(pinned));
    const end = art.geom.main.wires.find((w) => w.state === "now")!.ends.find((e) => e.pad?.ref === "btn")!;
    expect(end.dot).toBeNull();
    const bubble = art.geom.bubbles.find((b) => b.target.ref === "btn")!;
    expect(bubble.seeThrough).toBe(true);
    expect(bubble.geom.solids.find((s) => s.solid.tag === "stem")!.ghost).toBe(true);
    const found = checkWiringStep(art.geom);
    // The one thing left to say is that the project should turn the part, and by how much.
    expect(checks(found)).toEqual(["wire-end-hidden"]);
    expect(found[0]!.what).toContain("passing behind");
    expect(found[0]!.fix).toMatch(/Turn the part \d+ degrees: set "bench": \{ "x": [-\d.]+, "y": [-\d.]+, "rot": \d+ \}/);
    expect(art.svg).toContain(`<defs><g id="s0d`);
  });

  test("left to itself, the booklet turns the button so the wired leg faces the viewer, and nothing is reported", () => {
    const free = load(parts(), wires);
    expect(free.byRef.get("btn")!.at.rot).toBe(0);
    expect(benchView(free).byRef.get("btn")!.at.rot).not.toBe(0);
    const art = wiringStepArt(free, 0, benchFrame(free));
    expect(checkWiringStep(art.geom)).toEqual([]);
    const end = art.geom.main.wires.find((w) => w.state === "now")!.ends.find((e) => e.pad?.ref === "btn")!;
    const on = art.geom.main.pads.find((p) => p.part === "btn" && p.pin === "1")!;
    expect(end.dot).toEqual(on.screen);
    expect(art.geom.bubbles.every((b) => !b.seeThrough)).toBe(true);
  });

  test("a part file that says where the legs are gets its wire on a leg, not on the top face", () => {
    const defs = new Map<string, PartDef>([...DEFS, ["button", { ...BUTTON_WITH_LEGS, id: "button" }]]);
    const legs = load(parts(), wires, defs);
    const art = wiringStepArt(legs, 0, benchFrame(legs));
    expect(checkWiringStep(art.geom)).toEqual([]);
    const end = art.geom.main.wires.find((w) => w.state === "now")!.ends.find((e) => e.pad?.ref === "btn")!;
    // At the foot of the 3.4 mm body, outside its outline.
    expect(end.at[2]).toBeLessThan(0.5);
    expect(art.geom.main.solids.filter((s) => s.solid.tag?.startsWith("lead"))).toHaveLength(4);
  });
});

describe("regression: lid parts, names and guide lines piled on each other", () => {
  // The layout of the example project: three parts close together under the lid.
  const at = (x: number, y: number, z: number) => ({ x, y, z, rot: 0 as const });
  const loaded = load(
    [
      { ref: "env", part: "sensor", label: "Air sensor" },
      { ref: "oled", part: "display", label: "Display" },
      { ref: "btn", part: "button", label: "Button" },
    ],
    [],
    DEFS,
    { wall: 2, fit: 0.3, radius: 3, lid: "screw", mounts: ["env", "oled", "btn"].map((ref) => ({ ref, on: "lid" as const, x: 0, y: 0 })), openings: "auto", material: "PLA", color: "white" },
  );
  const place = (ref: string, def: PartDef, x: number, y: number, z: number) => ({ use: loaded.byRef.get(ref)!.use, def, at: at(x, y, z) });
  const L: EnclosureLayout = {
    inner: { w: 66, d: 31.4, h: 16.7 },
    outer: { w: 70, d: 35.4, h: 18.7 },
    wall: 2,
    floor: 2,
    lidThickness: 2.4,
    lipHeight: 2,
    fit: 0.3,
    radius: 3,
    parts: [place("env", SENSOR, 46.7, 12.3, 15.87), place("oled", DISPLAY, 16.8, 3.8, 15.3), place("btn", BUTTON, 46.8, 3.8, 12.1)],
    standoffs: [],
    openings: [],
    screws: [],
    hardware: [],
    warnings: [],
  };

  test("as it was drawn: every part at one height, names on top, guides painted whole", () => {
    const D = L.outer.d;
    const z = L.lidThickness + 22;
    const solids: Solid[] = lidSolids(L, 0);
    const guides: NonNullable<Scene["guides"]> = [];
    const texts: FreeText[] = [];
    for (const p of L.parts) {
      const fp = footprint(p);
      const y = D - p.at.y - fp.d;
      solids[solids.length] = box(p.at.x, y, z, fp.w, fp.d, p.def.body.h, { part: p.use.ref, hover: { group: "lid parts", item: p.use.ref } });
      const c = proj(p.at.x + fp.w / 2, y + fp.d / 2, z + p.def.body.h);
      texts[texts.length] = { text: p.use.label!, at: [c[0], c[1] + 0.9], anchor: "middle", size: 2.1, part: p.use.ref };
      for (const [gx, gy] of [[p.at.x, y], [p.at.x + fp.w, y], [p.at.x, y + fp.d], [p.at.x + fp.w, y + fp.d]] as [number, number][]) {
        guides[guides.length] = { a: [gx, gy, z], b: [gx, gy, L.lidThickness] };
      }
    }
    const old = legacyGeom({ solids, guides, texts });
    expect(checks(hoverProblems(old)).length).toBeGreaterThanOrEqual(2);
    // A name lying across the edges of the parts around it, and guide lines struck through names.
    expect(checks(labelProblems(old))).toContain("label-hidden");
    expect(checks(labelProblems(old))).toContain("label-under-line");
    expect(checks(guideProblems(old))).toEqual(["guide-over-solid"]);
  });

  test("as it is drawn now: nothing overlaps and nothing is reported", () => {
    const arts = enclosureLidArts(loaded, L);
    expect(arts.flatMap((a) => a.refs).sort()).toEqual(["btn", "env", "oled"]);
    for (const art of arts) {
      expect(checkScene(art.geom)).toEqual([]);
      // Each part hovers at its own height, and has a dashed outline where it lands.
      const heights = art.geom.solids.filter((s) => s.solid.hover).map((s) => s.solid.z);
      expect(new Set(heights).size).toBe(heights.length);
      expect(art.svg).toContain("stroke-dasharray");
    }
  });
});

describe("regression: a spike where a wire meets a pad straight behind its other end", () => {
  // The controller's pad and the display's pad in line with the viewer: straight up and down on the page.
  const near: V3 = [20, 45, 1];
  const far: V3 = [0, 25, 1.6];

  test("as it was drawn: the curve rises past the far pad and folds back onto it", () => {
    const path = legacyWirePath(near, far);
    expect(sharpestTurn(path, 1.5)).toBeGreaterThan(150);
    const found = wirePathProblems(geom({ wires: [wire(near, far, { path, runs: [path] })] }));
    expect(checks(found)).toEqual(["wire-reversal"]);
  });

  test("as it is drawn now: the same wire runs from pad to pad without turning back", () => {
    const c = wireCurve(near, far, 6.2);
    expect(sharpestTurn(c.path, 1.5)).toBeLessThan(MAX_TURN / 2);
    expect(backtrack(c.path)).toBeLessThan(1e-9);
    expect(wirePathProblems(renderScene({ solids: [], wires: [{ a: near, b: far, color: "red", state: "now" }] }).geom)).toEqual([]);
  });

  test("the old pin labels ran under the display glass; the new ones are all readable", () => {
    const loaded = load(
      [
        { ref: "mcu", part: "board", label: "Controller" },
        { ref: "oled", part: "display", label: "Display" },
      ],
      [{ from: "mcu.3V3", to: "oled.VCC" }],
    );
    const old = legacyGeom(benchScene(loaded, 0, 0));
    expect(checks(labelProblems(old))).toContain("label-hidden");
    const art = wiringStepArt(loaded, 0, benchFrame(loaded));
    expect(checkWiringStep(art.geom)).toEqual([]);
    // The pad the caption names carries its name inside its bubble.
    for (const b of art.geom.bubbles) expect(b.geom.labels.some((l) => l.part === b.target.ref && l.pin === b.target.pin)).toBe(true);
  });
});

test("default part solids are unchanged by lead support: body, then shapes, pads on the body", () => {
  const placed = { use: { ref: "btn", part: "button" }, def: BUTTON_WITH_LEGS, at: { x: 0, y: 0, z: 0, rot: 0 as const } };
  const plain = partSolids(placed, { labels: false });
  expect(plain).toHaveLength(2);
  expect(plain[0]!.pads).toHaveLength(4);
  const withLeads = partSolids(placed, { labels: false, leads: true });
  expect(withLeads).toHaveLength(6);
  expect(withLeads[0]!.pads).toHaveLength(0);
  expect(BOARD.pins.length).toBe(12);
});
