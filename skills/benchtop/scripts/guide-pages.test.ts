// What the guide's pages say and whether they hold it: the cover's numbers, the texts that
// follow the project (joint, power, firmware), and the lists that run over several pages.

import { describe, expect, test } from "bun:test";
import { buildGuide, checksPages, coverCount } from "./guide";
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

function many(n: number, tweak: (p: Project) => void = () => {}) {
  const a = rowPart("rowa", n);
  const b = rowPart("rowb", n);
  const parts: PartUse[] = [{ ref: "a", part: a.id, label: "Left bar" }, { ref: "b", part: b.id, label: "Right bar" }];
  const connections: Connection[] = Array.from({ length: n }, (_, i) => ({ from: `a.p${i}`, to: `b.p${i}`, net: `NET_NUMBER_${i}` }));
  const p = project(parts, connections);
  tweak(p);
  return resolveProject(p, new Map([[a.id, a], [b.id, b]]));
}

describe("the cover", () => {
  test("counts what the builder does once: a push-on connection is one, a soldered wire has two joints", () => {
    const solder = many(8);
    expect(coverCount(solder, null)).toEqual({ n: 16, label: "solder joints" });
    const dupont = many(8, (p) => (p.build.joint = "dupont"));
    // The doubled number was wire ends labelled as connections.
    expect(coverCount(dupont, null)).toEqual({ n: 8, label: "connections" });
  });

  test("a project with no wires says zero, not a made-up number", () => {
    expect(coverCount(many(0), null).n).toBe(0);
  });

  test("the cover of a built guide shows that number and the minutes", async () => {
    const guide = await buildGuide(many(5, (p) => ((p.build.joint = "dupont"), (p.build.minutes = 45))));
    expect(guide.html).toContain("<b>5</b><span>connections</span>");
    expect(guide.html).toContain("<b>45</b><span>minutes</span>");
  });
});

describe("texts that follow the project", () => {
  const build = (tweak: (p: Project) => void) => buildGuide(many(3, tweak));

  test("a push-on build says nothing about solder, and a soldered one does", async () => {
    const dupont = (await build((p) => (p.build.joint = "dupont"))).html;
    expect(dupont).not.toContain("shiny cone");
    expect(dupont).not.toContain("tin the end");
    expect(dupont).toContain("pushed fully onto its pin");
    const solder = (await build(() => {})).html;
    expect(solder).toContain("shiny cone");
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
