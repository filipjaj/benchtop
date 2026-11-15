// What the guide's pages say and whether they hold it: the cover's numbers, the texts that
// follow the project (joint, power, firmware), and the lists that run over several pages.

import { describe, expect, test } from "bun:test";
import { buildGuide, checksPages, coverCount } from "./guide";
import { wireEnds } from "./lib/consumables";
import { DISPLAY, project } from "./lib/drawing-fixtures";
import { findChrome, measurePages, overflowText } from "./lib/page-fit";
import { resolveProject } from "./lib/project";
import type { Connection, PartDef, PartUse, Project } from "./lib/types";

/** A part with n pads in a row, named p0..p<n-1>, for projects with many nets. */
function rowPart(id: string, n: number): PartDef {
  return {
    ...DISPLAY,
    id,
    name: id,
    body: { w: 2.54 * n + 4, d: 8, h: 1.6 },
    maxHeight: 3,
    shapes: [],
    pins: Array.from({ length: n }, (_, i) => ({ name: `p${i}`, role: "io" as const, x: 2 + i * 2.54, y: 2 })),
  };
}

/** The same row of pads, every one a screw clamp (PinDef.screw), like a terminal block. */
function clampPart(id: string, n: number): PartDef {
  const p = rowPart(id, n);
  return { ...p, pins: p.pins.map((pin) => ({ ...pin, screw: true })) };
}

function many(n: number, tweak: (p: Project) => void = () => {}, b = rowPart("rowb", n), a = rowPart("rowa", n)) {
  const parts: PartUse[] = [{ ref: "a", part: a.id, label: "Left bar" }, { ref: "b", part: b.id, label: "Right bar" }];
  const connections: Connection[] = Array.from({ length: n }, (_, i) => ({ from: `a.p${i}`, to: `b.p${i}`, net: `NET_NUMBER_${i}` }));
  const p = project(parts, connections);
  tweak(p);
  return resolveProject(p, new Map([[a.id, a], [b.id, b]]));
}

describe("the cover", () => {
  test("counts what the builder does once: a push-on connection is one, a soldered wire has two joints", () => {
    const solder = many(8);
    expect(coverCount(solder, null)).toEqual([{ n: 16, label: "solder joints" }]);
    const dupont = many(8, (p) => (p.build.joint = "dupont"));
    // The doubled number was wire ends labelled as connections.
    expect(coverCount(dupont, null)).toEqual([{ n: 8, label: "connections" }]);
  });

  test("a wire end under a screw is a screw clamp, not a solder joint", () => {
    // Added 2026-11-15: every wire end was counted as a solder joint, terminal blocks included.
    expect(coverCount(many(4, () => {}, clampPart("rowb", 4)), null)).toEqual([
      { n: 4, label: "solder joints" },
      { n: 4, label: "screw clamps" },
    ]);
    // The BOM's line says the same count; a lead that plugs in has neither joints nor clamps.
    const plugA = { ...rowPart("rowa", 2), pins: rowPart("rowa", 2).pins.map((p) => ({ ...p, plug: true })) };
    expect(wireEnds(many(2, () => {}, clampPart("rowb", 2), plugA))).toEqual({ solder: 0, screw: 0, plug: 4 });
    expect(wireEnds(many(2, () => {}, clampPart("rowb", 2)))).toEqual({ solder: 2, screw: 2, plug: 0 });
    // Nothing soldered at all: no "0 solder joints".
    expect(coverCount(many(3, () => {}, clampPart("rowb", 3), clampPart("rowa", 3)), null)).toEqual([{ n: 6, label: "screw clamps" }]);
  });

  test("a project with no wires says zero, not a made-up number", () => {
    expect(coverCount(many(0), null)[0]!.n).toBe(0);
  });

  test("the cover of a built guide shows that number and the minutes", async () => {
    const guide = await buildGuide(many(5, (p) => ((p.build.joint = "dupont"), (p.build.minutes = 45))));
    expect(guide.html).toContain("<b>5</b><span>connections</span>");
    expect(guide.html).toContain("<b>45</b><span>minutes</span>");
  });
});

describe("texts that follow the project", () => {
  const build = (tweak: (p: Project) => void, b?: PartDef, a?: PartDef) => buildGuide(many(3, tweak, b, a));

  test("a push-on build says nothing about solder, and a soldered one does", async () => {
    const dupont = (await build((p) => (p.build.joint = "dupont"))).html;
    expect(dupont).not.toContain("shiny cone");
    expect(dupont).not.toContain("tin the end");
    expect(dupont).toContain("pushed fully onto its pin");
    const solder = (await build(() => {})).html;
    expect(solder).toContain("shiny cone");
    // Added 2026-11-15: the clamp text said "not into solder ... Do not tin it." on push-on builds too.
    // The style sheet names solder classes; only the words the builder reads count.
    const clamped = (await build((p) => (p.build.joint = "dupont"), clampPart("rowb", 3))).html.replace(/<style>[\s\S]*?<\/style>/, "");
    expect(clamped).toContain("tighten the screw");
    expect(clamped).not.toMatch(/solder/i);
    expect(clamped).not.toMatch(/\btin\b/i);
  });

  test("a wire end under a screw is clamped, not soldered or tinned", async () => {
    // Added 2026-11-15: every end of a soldered build was worded as soldered, terminal blocks included.
    const html = (await build((p) => (p.connections[2]!.to = "b.p0"), clampPart("rowb", 3))).html;
    const steps = html.split('<div class="step">').slice(1);
    expect(steps).toHaveLength(3);
    for (const s of steps) {
      expect(s).toContain("Solder and clamp a");
      expect(s).toContain(`The end at the right bar <b>p`);
      for (const how of ["strip 5 mm", "ferrule", "tighten the screw", "tug the wire", "Do not tin it."]) expect(s).toContain(how);
    }
    // A second wire into the same clamp goes in with the first, not "beside" it as on a pad.
    expect(steps[2]).toContain("The p0 clamp on the right bar already holds a wire. Put this one in the same clamp");
    expect(steps[2]).not.toContain("Add this one beside it");
    // The soldered ends still get their tinning advice, and the screw ends are excepted from it.
    expect(html).toContain("tin the end before you solder it to a pad. Do not tin a wire that goes under a screw");
    expect(html).toContain("Tug every wire under a screw: none moves.");
    expect(html).toContain("Small screwdriver");

    // Nothing soldered: no soldering lesson, no iron, no shiny cone.
    const both = (await build(() => {}, clampPart("rowb", 3), clampPart("rowa", 3))).html;
    expect(both).toContain("Clamp a <b>");
    expect(both).toContain("Both ends go under a screw");
    for (const solder of ["shiny cone", "tin the end", "Soldering iron", "Solder a <b>"]) expect(both).not.toContain(solder);

    // A build without screw terminals reads as before.
    const plain = (await build(() => {})).html;
    expect(plain).not.toContain("under a screw");
    expect(plain).toContain("Solder a <b>");
  });

  test("power words follow the power source", async () => {
    const usb = (await build(() => {})).html;
    expect(usb).toContain("Unplug USB before you");
    expect(usb).toContain("Plug in the USB cable.");
    const battery = (await build((p) => (p.power.source = "lipo"))).html;
    expect(battery).toContain("Disconnect the battery before you");
    expect(battery).toContain("Connect the battery.");
    expect(battery).not.toContain("Unplug USB");
    const jack = (await build((p) => (p.power.source = "dc-jack"))).html;
    expect(jack).toContain("Unplug the power supply before you");
  });

  test("the flash line only exists for a framework the skill generates a command for", async () => {
    const fw = (framework: "arduino" | "esphome" | "esp-idf" | "micropython", board = "esp32dev") => (p: Project): void => {
      p.firmware = { framework, board, behaviour: "x" };
    };
    const esp = (await build(fw("arduino"))).html;
    expect(esp).toContain("pio run -e bringup");
    expect(esp).not.toContain("BOOTSEL");
    // A Pico needs its boot button for the first upload.
    expect((await build(fw("arduino", "pico"))).html).toContain("hold BOOTSEL while you plug in the USB cable");
    // A board the firmware step writes no platformio.ini for gets no command that cannot work.
    expect((await build(fw("arduino", "nucleo_f401re"))).html).not.toContain("pio run");
    expect((await build(fw("esphome"))).html).toContain("esphome run firmware/test.yaml");
    for (const other of ["esp-idf", "micropython"] as const) {
      const html = (await build(fw(other))).html;
      expect(html).not.toContain("bringup");
      expect(html).not.toContain("pio run");
    }
    expect((await build(() => {})).html).not.toContain("Flash");
  });
});

describe("step numbers", () => {
  test("run 1 to N with no gap, and every step a message names is printed on the page it names", async () => {
    const guide = await buildGuide(many(9));
    const pages = guide.html.split('<section class="page').slice(1);
    const onPage = pages.map((p) => [...p.matchAll(/class="num">(\d+)</g)].map((m) => Number(m[1])));
    expect(onPage.flat()).toEqual(Array.from({ length: 9 }, (_, i) => i + 1));
    const named = [...guide.findings, ...guide.notes].filter((f) => f.step !== undefined);
    expect(named.length).toBeGreaterThan(0);
    for (const f of named) expect(onPage[f.page - 1]).toContain(f.step!);
  });
});

describe("the continuity page", () => {
  const rowsIn = (pages: string[]): string[] => pages.flatMap((p) => [...p.matchAll(/<tr><th>([^<]*)<\/th>/g)].map((m) => m[1]!));

  test("runs over as many pages as the nets need, losing and repeating none", () => {
    for (const n of [1, 12, 40, 150]) {
      const pages = checksPages(many(n));
      expect(rowsIn(pages)).toEqual(Array.from({ length: n }, (_, i) => `NET_NUMBER_${i}`));
      if (n >= 40) expect(pages.length).toBeGreaterThan(1);
    }
  });

  test("a table that continues says so, the numbering carries on, and the last check closes the last page", () => {
    const pages = checksPages(many(150));
    expect(pages[0]).toContain("<h2>Before you switch it on</h2>");
    for (const p of pages.slice(1)) expect(p).toContain("(continued)");
    expect(pages[1]).toContain("continued.");
    // Look is 1 and the table is 2 (no supply rails here, so no "must not beep" check); the checks after it follow on the last page, numbered from the table's own number.
    expect(pages[0]).toContain('start="1"');
    expect(pages.at(-1)).toContain("Plug in the USB cable.");
    expect(pages.at(-1)).toContain('start="2"');
    expect(pages.at(-1)).toContain("unplug USB at once");
  });

  test("a project with no connections has no empty table", () => {
    expect(checksPages(many(0)).join("")).not.toContain("These must beep");
  });
});

describe("a page that does not fit is never silent", async () => {
  const chrome = await findChrome();
  const run = chrome ? test : test.skip;

  run("a guide with a long net list fits every page when measured in a browser", async () => {
    const guide = await buildGuide(many(48));
    const over = await measurePages(guide.html);
    expect(over?.map(overflowText) ?? []).toEqual([]);
  }, 120_000);

  run("a page that really is too tall is found, with what is cut", async () => {
    const guide = await buildGuide(many(2));
    const tall = guide.html.replace("</body>", `<section class="page"><h2>Too much</h2>${"<p>A line that will not fit.</p>".repeat(90)}<footer><span>99</span><span>X</span></footer></section></body>`);
    const over = await measurePages(tall);
    expect(over).not.toBeNull();
    const last = over!.at(-1)!;
    expect(last.page).toBeGreaterThan(1);
    expect(last.cut.join(" ")).toContain("A line that will not fit.");
    expect(overflowText(last)).toContain("cut off");
  }, 120_000);
});
