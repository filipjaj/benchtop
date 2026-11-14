// The name of the pad a bubble is about is always written in the bubble, even when the pads
// are so close that the bubble is magnified a lot and the name is long (a Pico's ADC_VREF,
// a servo header's "33+"). Synthetic fixture, not a dimensioned purchasable part.
import { describe, expect, test } from "bun:test";
import { bubbleProblems } from "./drawing-check";
import { BOARD, project } from "./drawing-fixtures";
import { resolveProject } from "./project";
import { benchFrame, wiringStepArt } from "./scenes";
import type { PartDef, Placement } from "./types";

const names = ["ADC_VREF", "AGND", "GP28", "3V3_EN", "SDI(MOSI)", "SD_MISO", "RESET", "GND"];
/** Two rows of 1.27 mm pitch pads, the way a fine-pitch module has them. */
const MODULE: PartDef = {
  id: "synthetic-fine-pitch", name: "Synthetic fine-pitch module", kind: "connector", blurb: "Renderer test only",
  body: { w: 6, d: 12, h: 1.6 }, maxHeight: 1.6,
  pins: names.map((name, i) => ({ name, role: "passive", x: i < 4 ? 0 : 6, y: 1.5 + (i < 4 ? i : 7 - i) * 1.27, z: 0, lead: 0 })),
  electrical: {}, sourcing: { search: [], priceUsd: 0 }, sources: [], confidence: "typical",
};

const load = (rot: NonNullable<Placement["rot"]>) => resolveProject(project(
  [{ ref: "mcu", part: BOARD.id, label: "Controller" }, { ref: "mod", part: MODULE.id, label: "Module", bench: { x: 40, y: 0, rot } }],
  MODULE.pins.map((p) => ({ from: "mcu.10", to: `mod.${p.name}` })),
), new Map([[BOARD.id, BOARD], [MODULE.id, MODULE]]));

describe("the wired pad's name in its bubble", () => {
  for (const rot of [0, 90, 180, 270] as const) {
    test(`is written inside the bubble for every pad at ${rot} degrees`, () => {
      const loaded = load(rot);
      const frame = benchFrame(loaded);
      for (let i = 0; i < MODULE.pins.length; i++) {
        const art = wiringStepArt(loaded, i, frame);
        expect(bubbleProblems(art.geom).filter((p) => p.check === "label-missing")).toEqual([]);
        const bubble = art.geom.bubbles.find((b) => b.target.ref === "mod")!;
        const label = bubble.geom.labels.find((l) => l.part === "mod" && l.pin === MODULE.pins[i]!.name);
        expect(label).toBeDefined();
      }
    }, 30_000);
  }
});
