// Regression tests for problems found by agents using the enclosure step on real projects:
// one fastener list, cavity height, jumper-lead room, cable exits, buttons that cannot be
// pressed, and sensors sitting over the controller.

import { describe, expect, test } from "bun:test";
import { DESIGN, hardwareLines, layoutEnclosure, pilotDepth } from "./enclosure-layout";
import { resolveProject } from "./project";
import type { CustomOpening, EnclosureSpec, PartDef, Project } from "./types";

const base = {
  blurb: "test part",
  electrical: {},
  sourcing: { search: ["x"], priceUsd: 1 },
  sources: ["test"],
  confidence: "typical" as const,
};

const board: PartDef = {
  ...base,
  id: "board",
  kind: "board",
  name: "Test board",
  body: { w: 22, d: 18, h: 1.2 },
  maxHeight: 4.5,
  // Header pins along both long edges.
  pins: [2, 5, 8, 11, 14, 17, 20].flatMap((x) => [
    { name: `A${x}`, role: "io" as const, x, y: 1.2 },
    { name: `B${x}`, role: "io" as const, x, y: 16.8 },
  ]),
  ports: [{ name: "usb", faces: "y-", x: 11, y: 0, z: 1.6, w: 9, h: 3.2, margin: 1.5 }],
};
const screen: PartDef = {
  ...base,
  id: "screen",
  kind: "display",
  name: "Test screen",
  body: { w: 27.3, d: 27.8, h: 1.6 },
  maxHeight: 3.1,
  pins: [],
  holes: [
    { x: 2, y: 2, dia: 2 },
    { x: 25.3, y: 2, dia: 2 },
    { x: 2, y: 25.8, dia: 2 },
    { x: 25.3, y: 25.8, dia: 2 },
  ],
  ports: [{ name: "display", faces: "up", x: 13.65, y: 15.4, w: 21.7, h: 10.9, margin: 0.5 }],
};
const probe: PartDef = { ...base, id: "probe", kind: "sensor", name: "Soil probe", body: { w: 10, d: 10, h: 1.6 }, maxHeight: 3, pins: [] };
const sensor: PartDef = {
  ...base,
  id: "sensor",
  kind: "sensor",
  name: "Test sensor",
  body: { w: 15, d: 11.5, h: 1.6 },
  maxHeight: 2.5,
  pins: [],
  ports: [{ name: "Vent", faces: "up", x: 7.5, y: 7.25, w: 2.5, h: 2.5, shape: "round", margin: 1.5 }],
};
/** Switch whose cap is `stem` mm tall on a 3.5 mm body. */
const switchWith = (id: string, stem: number): PartDef => ({
  ...base,
  id,
  kind: "input",
  name: `Switch ${stem}`,
  body: { w: 6.5, d: 6, h: 3.5 },
  maxHeight: 3.5 + stem,
  pins: [],
  shapes: [{ kind: "cyl", x: 3.25, y: 3, r: 1.75, h: stem, tag: "cap" }],
  ports: [{ name: "cap", faces: "up", x: 3.25, y: 3, w: 3.5, h: 3.5, shape: "round", margin: 0.5, reach: true }],
});
const noHoles: PartDef = {
  ...base,
  id: "noholes",
  kind: "board",
  name: "Holeless board",
  body: { w: 30, d: 20, h: 1.6 },
  maxHeight: 4,
  pins: [4, 8, 12, 16, 20, 24].flatMap((x) => [
    { name: `A${x}`, role: "io" as const, x, y: 1.3 },
    { name: `B${x}`, role: "io" as const, x, y: 18.7 },
  ]),
};
const holed: PartDef = {
  ...base,
  id: "holed",
  kind: "board",
  name: "Holed board",
  body: { w: 30, d: 20, h: 1.6 },
  maxHeight: 4,
  pins: [],
  holes: [
    { x: 2, y: 2, dia: 2.2 },
    { x: 28, y: 18, dia: 2.2 },
  ],
};

const defs = new Map([board, screen, probe, sensor, noHoles, holed, switchWith("sw-short", 1.5), switchWith("sw-long", 4)].map((d) => [d.id, d]));

function make(
  parts: [string, string][],
  spec: Partial<EnclosureSpec> & Pick<EnclosureSpec, "mounts">,
  joint: "solder" | "dupont" = "solder",
) {
  const project: Project = {
    schema: 1,
    slug: "t",
    name: "T",
    tagline: "t",
    summary: "t",
    build: { path: "wire", joint, difficulty: 1, minutes: 1 },
    power: { source: "usb", volts: 5, budgetMa: 500 },
    parts: parts.map(([ref, part]) => ({ ref, part })),
    connections: [],
    enclosure: { wall: 2, fit: 0.3, radius: 3, lid: "screw", openings: "auto", material: "PLA", color: "#fff", ...spec },
  };
  return layoutEnclosure(resolveProject(project, defs));
}

const auto = (ref: string, on: "floor" | "lid") => ({ ref, on, x: 0, y: 0 });

describe("1. one source for fasteners", () => {
  const l = make(
    [
      ["b", "board"],
      ["d", "screen"],
    ],
    { mounts: [auto("b", "floor"), auto("d", "lid")] },
  );

  test("hardware lists the lid screws and the board screws in the standard form", () => {
    for (const h of l.hardware) expect(h.name).toMatch(/^M\d(\.5)? x \d+ mm [a-z-]+ screw$/);
    const lid = l.hardware.find((h) => h.use === "lid to body")!;
    expect(lid.qty).toBe(4);
    expect(lid.name).toStartWith("M3 x ");
    const board = l.hardware.filter((h) => h.name.startsWith("M2 x "));
    expect(board.reduce((n, h) => n + h.qty, 0)).toBe(4);
  });

  test("every screw fits the hole it goes in", () => {
    const length = (name: string): number => Number(/ x (\d+) mm/.exec(name)![1]);
    const bossDepth = Math.min(DESIGN.bossPilotMax, l.outer.h - l.floor - 1);
    expect(length(l.hardware.find((h) => h.use === "lid to body")!.name)).toBeLessThanOrEqual(l.lidThickness + bossDepth - 1 + 1e-9);
    const screen = l.parts.find((p) => p.use.ref === "d")!;
    const post = l.standoffs.find((s) => s.from === "lid" && s.hole > 0)!;
    const len = length(l.hardware.find((h) => h.name.startsWith("M2"))!.name);
    expect(len).toBeLessThanOrEqual(pilotDepth(post, l.floor, l.lidThickness) + screen.def.body.h + 1e-9);
    // A 5 mm screw fits: the pilot hole is deep enough for it.
    expect(pilotDepth(post, l.floor, l.lidThickness) + screen.def.body.h).toBeGreaterThanOrEqual(5 - 1e-6);
  });

  test("print.md's list is exactly layout.hardware", () => {
    const lines = hardwareLines(l);
    expect(lines).toHaveLength(l.hardware.length);
    l.hardware.forEach((h, i) => expect(lines[i]).toBe(`- ${h.qty} x ${h.name}: ${h.use}`));
  });

  test("posts too short for a 5 mm screw are not screwed and say so", () => {
    const short = make([["h", "holed"]], { mounts: [{ ref: "h", on: "floor", x: 0, y: 0, standoff: 1 }] });
    expect(short.standoffs.every((s) => s.hole === 0)).toBe(true);
    expect(short.hardware.find((h) => h.name.includes("pan-head"))).toBeUndefined();
    expect(short.warnings.some((w) => w.includes("located by its posts and not screwed"))).toBe(true);
    const tall = make([["h", "holed"]], { mounts: [{ ref: "h", on: "floor", x: 0, y: 0, standoff: 3 }] });
    expect(tall.hardware.find((h) => h.name.includes("pan-head"))?.qty).toBe(2);
  });
});

describe("2. cavity height", () => {
  test("a lone floor board with a side USB port: room for wiring and the opening has wall above it", () => {
    const l = make([["b", "board"]], { mounts: [auto("b", "floor")] });
    const p = l.parts[0]!;
    // Tallest part on its standoff plus wiring space.
    expect(l.inner.h).toBeGreaterThanOrEqual(DESIGN.standoffHeight + p.def.maxHeight + DESIGN.wiringSpace - 1e-6);
    const o = l.openings.find((x) => x.port === "usb")!;
    expect(o.face).toBe("y-");
    expect(o.v + o.h / 2 + DESIGN.openingHeadroom).toBeLessThanOrEqual(l.outer.h + 1e-6);
    expect(l.warnings).toEqual([]);
  });

  test("a tall opening raises the cavity", () => {
    const l = make([["b", "board"]], {
      mounts: [auto("b", "floor")],
      extraOpenings: [{ face: "x+", u: 10, v: 30, w: 6, h: 6, shape: "rect", label: "high slot" }],
    });
    expect(l.outer.h).toBeGreaterThanOrEqual(30 + 3 + DESIGN.openingHeadroom - 1e-6);
  });
});

describe("3. jumper leads need room", () => {
  const mounts = [auto("b", "floor")];
  test("dupont is at least 14 mm taller inside than solder", () => {
    const solder = make([["b", "board"]], { mounts }, "solder");
    const dupont = make([["b", "board"]], { mounts }, "dupont");
    expect(dupont.inner.h - solder.inner.h).toBeGreaterThanOrEqual(14 - 1e-6);
  });

  test("corner posts keep clear of pin rows", () => {
    const l = make([["n", "noholes"]], { mounts: [auto("n", "floor")] }, "dupont");
    const p = l.parts[0]!;
    expect(l.standoffs.length).toBeGreaterThanOrEqual(3);
    for (const s of l.standoffs) {
      for (const pin of p.def.pins) {
        expect(Math.hypot(s.x - (p.at.x + pin.x), s.y - (p.at.y + pin.y))).toBeGreaterThanOrEqual(s.dia / 2 + 1.4 - 1e-6);
      }
      // Still under the board.
      expect(s.x).toBeGreaterThan(p.at.x);
      expect(s.x).toBeLessThan(p.at.x + p.def.body.w);
    }
  });
});

describe("4. openings the parts do not imply", () => {
  const cable: CustomOpening = { face: "x+", u: 14, v: 9, w: 5, h: 5, shape: "round", label: "probe cable" };

  test("auto plus extraOpenings gives the cable exit with ref empty and the label as port", () => {
    const l = make([["b", "board"]], { mounts: [auto("b", "floor")], extraOpenings: [cable] });
    expect(l.openings.some((o) => o.port === "usb")).toBe(true);
    const c = l.openings.find((o) => o.port === "probe cable")!;
    expect(c).toEqual({ ref: "", port: "probe cable", face: "x+", u: 14, v: 9, w: 5, h: 5, shape: "round" });
  });

  test("a custom entry may also sit in the openings list", () => {
    const l = make([["b", "board"]], { mounts: [auto("b", "floor")], openings: [{ ref: "b", port: "usb" }, cable] });
    expect(l.openings.map((o) => o.port).sort()).toEqual(["probe cable", "usb"]);
  });

  test("a part that is not mounted warns that it may need a cable exit", () => {
    const l = make(
      [
        ["b", "board"],
        ["p", "probe"],
      ],
      { mounts: [auto("b", "floor")] },
    );
    const w = l.warnings.find((x) => x.startsWith("p "))!;
    expect(w).toContain("is not mounted in the case; if it sits outside on a lead, add a cable exit with extraOpenings");
  });
});

describe("5. a button nobody can press", () => {
  const lidSwitch = (part: string) => make([["s", part]], { mounts: [auto("s", "lid")] });

  test("a short stem is flagged with the shortfall and the stem height needed", () => {
    const l = lidSwitch("sw-short");
    const w = l.warnings.find((x) => x.includes("short of standing"))!;
    expect(w).toContain("1.4 mm short"); // lid 2.4 + 0.5 proud - 1.5 stem
    expect(w).toContain("at least 2.9 mm tall");
    expect(w).toContain("print a cap");
    // The opening is still there, and the part sits with its body against the lid.
    expect(l.openings.some((o) => o.face === "lid" && o.port === "cap")).toBe(true);
    expect(l.parts[0]!.at.z + 3.5).toBeCloseTo(l.outer.h, 6);
  });

  test("a tall enough stem ends 0.5 mm proud of the lid's outer surface", () => {
    const l = lidSwitch("sw-long");
    expect(l.warnings.filter((w) => w.includes("short of standing"))).toEqual([]);
    const p = l.parts[0]!;
    expect(p.at.z + 3.5 + 4).toBeCloseTo(l.outer.h + l.lidThickness + 0.5, 6);
    // The body still sits under the lid, not inside it.
    expect(p.at.z + 3.5).toBeLessThanOrEqual(l.outer.h + 1e-9);
  });
});

describe("6. a sensor above the heat", () => {
  test("a vented lid part is placed clear of the controller board", () => {
    const l = make(
      [
        ["b", "board"],
        ["v", "sensor"],
        ["d", "screen"],
      ],
      { mounts: [auto("b", "floor"), auto("v", "lid"), auto("d", "lid")] },
    );
    const b = l.parts.find((p) => p.use.ref === "b")!;
    const v = l.parts.find((p) => p.use.ref === "v")!;
    const dx = Math.max(v.at.x - (b.at.x + 22), b.at.x - (v.at.x + 15), 0);
    const dy = Math.max(v.at.y - (b.at.y + 18), b.at.y - (v.at.y + 11.5), 0);
    expect(Math.hypot(dx, dy)).toBeGreaterThanOrEqual(DESIGN.ventDistance);
    expect(l.warnings.some((w) => w.includes("warmth"))).toBe(false);
  });

  test("a vented floor part is spaced away from the board", () => {
    const l = make(
      [
        ["b", "board"],
        ["v", "sensor"],
      ],
      { mounts: [auto("v", "floor"), auto("b", "floor")] },
    );
    const b = l.parts.find((p) => p.use.ref === "b")!;
    const v = l.parts.find((p) => p.use.ref === "v")!;
    const dx = Math.max(v.at.x - (b.at.x + 22), b.at.x - (v.at.x + 15), 0);
    expect(dx).toBeGreaterThanOrEqual(DESIGN.ventDistance);
  });

  test("when it cannot be placed away, it warns about the controller's warmth", () => {
    const l = make(
      [
        ["b", "board"],
        ["v", "sensor"],
      ],
      { inner: { w: 40, d: 30, h: 30 }, mounts: [auto("b", "floor"), auto("v", "lid")] },
    );
    const w = l.warnings.find((x) => x.includes("warmth"))!;
    expect(w).toContain("v (Test sensor)");
    expect(w).toContain("not known");
  });
});

describe("round 2", () => {
  const cable: CustomOpening = { face: "x+", u: 14, v: 9, w: 5, h: 5, shape: "round", label: "probe cable" };
  const parts: [string, string][] = [
    ["b", "board"],
    ["p", "probe"],
  ];

  test("a cable exit that names the part clears the not-mounted warning, in extraOpenings or in the openings list", () => {
    const named: CustomOpening = { ...cable, cableFor: ["p"] };
    const viaExtra = make(parts, { mounts: [auto("b", "floor")], extraOpenings: [named] });
    expect(viaExtra.warnings.some((w) => w.includes("is not mounted in the case"))).toBe(false);
    const viaList = make(parts, { mounts: [auto("b", "floor")], openings: [{ ref: "b", port: "usb" }, named] });
    expect(viaList.warnings.some((w) => w.includes("is not mounted in the case"))).toBe(false);
    const none = make(parts, { mounts: [auto("b", "floor")] });
    expect(none.warnings.some((w) => w.includes("is not mounted in the case"))).toBe(true);
  });

  test("an up-facing light far below the lid is called a sight line, not a plug", () => {
    const led: PartDef = {
      ...base,
      id: "ledboard",
      kind: "board",
      name: "LED board",
      body: { w: 20, d: 15, h: 1.6 },
      maxHeight: 3,
      pins: [],
      ports: [{ name: "Blue LED", faces: "up", x: 10, y: 7, w: 2.5, h: 2.5, shape: "round" }],
    };
    defs.set(led.id, led);
    const l = make([["m", "ledboard"]], { inner: { w: 40, d: 30, h: 25 }, mounts: [auto("m", "floor")] });
    const w = l.warnings.find((x) => x.includes("Blue LED"))!;
    expect(w).toContain("sight line");
    expect(w).toContain("visible only from straight above");
    expect(w).toContain("explicit openings list");
    expect(w).toContain("light pipe");
    expect(w).not.toContain("plugs in");
    expect(w).not.toContain("will not reach");
    // The opening is still cut.
    expect(l.openings.some((o) => o.face === "lid" && o.port === "Blue LED")).toBe(true);
  });

  test("a lid button gets a backing post from the floor when nothing is under it", () => {
    const l = make(
      [
        ["b", "board"],
        ["s", "sw-short"],
      ],
      { inner: { w: 70, d: 40, h: 30 }, mounts: [auto("b", "floor"), auto("s", "lid")] },
    );
    const sw = l.parts.find((p) => p.use.ref === "s")!;
    const post = l.standoffs.find(
      (s) => s.from === "floor" && s.hole === 0 && Math.abs(s.x - (sw.at.x + 3.25)) < 1e-6 && Math.abs(s.y - (sw.at.y + 3)) < 1e-6,
    )!;
    expect(post).toBeDefined();
    // Rises from the floor to 0.2 mm below the part's underside.
    expect(l.floor + post.h).toBeCloseTo(sw.at.z - 0.2, 6);
    expect(l.warnings.some((w) => w.includes("inward"))).toBe(false);
  });

  test("with a floor part in the way there is no backing post, and a warning with the fix", () => {
    const l = make(
      [
        ["b", "board"],
        ["s", "sw-short"],
      ],
      { inner: { w: 60, d: 50, h: 40 }, mounts: [{ ref: "b", on: "floor", x: 10, y: 10 }, { ref: "s", on: "lid", x: 12, y: 12 }] },
    );
    const sw = l.parts.find((p) => p.use.ref === "s")!;
    expect(l.standoffs.some((s) => s.from === "floor" && Math.abs(s.x - (sw.at.x + 3.25)) < 1e-6 && Math.abs(s.y - (sw.at.y + 3)) < 1e-6)).toBe(false);
    const w = l.warnings.find((x) => x.includes("inward"))!;
    expect(w).toContain("Move it clear of the floor parts, or glue it");
    expect(w).toContain("b (Test board)");
  });
});
