// What a wiring step shows of the bench. The viewpoint is the same on every page, but a step
// need not show the whole bench: on a wide bench it is framed on the two parts it joins, with a
// small drawing of the whole bench saying where that is; and every step prints large enough.

import { describe, expect, test } from "bun:test";
import { DEFS, SENSOR, load } from "./drawing-fixtures";
import { HALF_PAGE, FULL_STEP, benchArt, benchFrame, trimSlivers, wiringStepArt } from "./scenes";
import type { PartDef } from "./types";

/** A long off-board part (a 300 mm LED panel): it makes the bench wide, and is not joined to anything near it. */
const PANEL: PartDef = {
  ...SENSOR,
  id: "panel",
  name: "Panel",
  body: { w: 300, d: 20, h: 2 },
  maxHeight: 4,
  shapes: [],
  pins: [{ name: "IN", role: "io", x: 2, y: 10 }],
};
const defs = new Map([...DEFS, [PANEL.id, PANEL]]);

const wide = () =>
  load(
    [
      { ref: "mcu", part: "board", label: "Controller" },
      { ref: "oled", part: "display", label: "Display", bench: { x: 40, y: 0, rot: 0 } },
      { ref: "env", part: "sensor", label: "Air sensor", bench: { x: 40, y: 40, rot: 0 } },
      { ref: "panel", part: "panel", label: "Panel", bench: { x: 100, y: 0, rot: 0 } },
    ],
    [
      { from: "mcu.3V3", to: "oled.VCC" },
      { from: "oled.VCC", to: "env.VCC" },
      { from: "mcu.10", to: "panel.IN" },
    ],
    defs,
  );

describe("a step on a wide bench", () => {
  test("is framed on the two parts it joins, with a locator showing where, clipped to that frame", () => {
    const loaded = wide();
    const frame = benchFrame(loaded);
    const art = wiringStepArt(loaded, 1, frame);
    expect(art.svg).toContain('<g class="bt-loc"');
    expect(art.svg).toContain("<clipPath");
    expect(art.area.maxX - art.area.minX).toBeLessThan(0.7 * (frame.maxX - frame.minX));
  });

  test("keeps the same viewpoint as the cover: every pad is at the same place in space and on the page", () => {
    const loaded = wide();
    const cover = benchArt(loaded).geom.pads;
    const frame = benchFrame(loaded);
    loaded.project.connections.forEach((_, i) => {
      for (const p of wiringStepArt(loaded, i, frame).geom.main.pads) {
        const same = cover.find((q) => q.part === p.part && q.pin === p.pin)!;
        expect(p.at).toEqual(same.at);
        expect(p.screen).toEqual(same.screen);
      }
    });
  });

  test("every step prints at least 70 % of the page wide and 80 mm tall, on half a page or on a whole one", () => {
    const loaded = wide();
    const frame = benchFrame(loaded);
    loaded.project.connections.forEach((_, i) => {
      const art = wiringStepArt(loaded, i, frame);
      const slot = art.full ? FULL_STEP : HALF_PAGE;
      const s = Math.min(slot.w / art.size.w, slot.h / art.size.h);
      expect(art.size.w * s).toBeGreaterThanOrEqual(0.7 * HALF_PAGE.w - 1);
      expect(art.size.h * s).toBeGreaterThanOrEqual(80 - 1);
    });
  });
});

describe("a step on a compact bench", () => {
  test("shows the whole bench, with no locator", () => {
    const loaded = load(
      [
        { ref: "mcu", part: "board" },
        { ref: "oled", part: "display" },
        { ref: "env", part: "sensor" },
      ],
      [{ from: "mcu.3V3", to: "oled.VCC" }, { from: "oled.VCC", to: "env.VCC" }],
    );
    const frame = benchFrame(loaded);
    for (let i = 0; i < 2; i++) {
      const art = wiringStepArt(loaded, i, frame);
      expect(art.svg).not.toContain('<g class="bt-loc"');
      expect(art.area).toEqual(frame);
    }
  });

  test("a step that must be on a page alone is drawn for a whole page", () => {
    const loaded = load([{ ref: "mcu", part: "board" }, { ref: "oled", part: "display" }], [{ from: "mcu.3V3", to: "oled.VCC" }]);
    const art = wiringStepArt(loaded, 0, benchFrame(loaded), true);
    expect(art.full).toBe(true);
    const s = Math.min(FULL_STEP.w / art.size.w, FULL_STEP.h / art.size.h);
    expect(art.size.w * s).toBeGreaterThan(wiringStepArt(loaded, 0, benchFrame(loaded)).size.w * Math.min(HALF_PAGE.w / art.size.w, HALF_PAGE.h / art.size.h));
  });
});

describe("a frame does not show a corner of a neighbour", () => {
  const region = { minX: 0, minY: 0, maxX: 100, maxY: 60 };
  const core = { minX: 30, minY: 20, maxX: 70, maxY: 40 };

  test("a neighbour that only pokes in is put outside by the nearest edge", () => {
    // 3 mm of a 40 mm part shows at the left edge: seen on a handheld's charger step as a stray mark.
    expect(trimSlivers(region, core, [{ minX: -37, minY: 10, maxX: 3, maxY: 30 }])).toEqual({ ...region, minX: 3 });
  });

  test("a neighbour that is mostly in view stays", () => {
    expect(trimSlivers(region, core, [{ minX: -5, minY: 10, maxX: 20, maxY: 30 }])).toEqual(region);
  });

  test("the frame never closes in on the two parts the step is about", () => {
    // Its near edge is 2 mm from the joined parts: trimming would crowd them, so the corner stays.
    expect(trimSlivers(region, core, [{ minX: -200, minY: 22, maxX: 28, maxY: 24 }])).toEqual(region);
  });
});
