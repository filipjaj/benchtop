// On a module with a pin header, the header pins ARE the pads. A shape tagged "header"
// must not count as hiding the pads it stands on: with it, every wire to the microphone,
// buzzer, amplifier or relay module used to be reported as "pad is behind <part> header".

import { describe, expect, test } from "bun:test";
import { checkWiringStep } from "./drawing-check";
import { BOARD } from "./drawing-fixtures";
import { load } from "./drawing-fixtures";
import { isHidden } from "./geom";
import { TERMINATION_TAGS, partSolids, pinWorld, renderScene, solderPoint } from "./iso";
import { loadPartDefs } from "./project";
import { benchFrame, wiringStepArt } from "./scenes";
import type { PartDef, PlacedPart } from "./types";

const defs = await loadPartDefs();
const withHeader = [...defs.values()].filter((d) => d.shapes?.some((s) => s.tag === "header"));
const place = (def: PartDef, rot: 0 | 90 | 180 | 270 = 0): PlacedPart => ({ use: { ref: "m", part: def.id }, def, at: { x: 5, y: 5, z: 0, rot } });

describe("a header over its own pads", () => {
  test("the library has modules with a header, so the rule is exercised on real files", () => {
    expect(withHeader.map((d) => d.id)).toEqual(expect.arrayContaining(["inmp441-mic", "active-buzzer-module", "relay-module-1ch", "max98357a-breakout"]));
  });

  test("every header pin is a pad on the header's top face, seen from the front and from every side", () => {
    for (const def of withHeader) {
      for (const rot of [0, 90, 180, 270] as const) {
        const p = place(def, rot);
        const solids = partSolids(p, { labels: false, leads: true });
        const header = solids.filter((s) => s.tag === "header" && s.pads?.length);
        for (const h of header) {
          for (const pad of h.pads!) {
            const at = solderPoint(p, pad.pin!);
            // Exactly where the header's top face carries the pad ring ...
            expect(at[0]).toBeCloseTo(h.x + pad.x, 9);
            expect(at[1]).toBeCloseTo(h.y + pad.y, 9);
            expect(at[2]).toBeCloseTo(h.z + h.h, 9);
            // ... which neither the header's own box nor the board hides. (Another tall shape
            // of the part, such as the relay's screw terminal, is a different matter.)
            expect(isHidden(at, [solids[0]!, h])).toBe(false);
          }
        }
        expect(header.length).toBeGreaterThan(0);
      }
    }
  });

  test("the board under the header keeps the pin names but draws no ring there, and only the header's rings count as pads", () => {
    const mic = defs.get("inmp441-mic")!;
    const solids = partSolids(place(mic), { labels: true });
    const body = solids[0]!;
    expect(body.pads!.every((q) => q.ring === false)).toBe(true);
    expect(body.pads!.map((q) => q.label)).toEqual(mic.pins.map((q) => q.name));
    const rendered = renderScene({ solids });
    expect(rendered.geom.pads.map((q) => q.pin).sort()).toEqual(mic.pins.map((q) => q.name).sort());
    // pinWorld stays the pad position on the board, which the PCB footprints use.
    expect(pinWorld(place(mic), "SCK")[2]).toBe(mic.body.h);
  });

  test("the header keeps its height in the part: the pin tips stand where maxHeight says", () => {
    for (const def of withHeader) {
      const tip = Math.max(...def.shapes!.filter((s) => s.tag === "header").map((s) => def.body.h + (s.z ?? 0) + s.h));
      expect(def.maxHeight).toBeGreaterThanOrEqual(tip - 1e-9);
      for (const pin of def.pins) {
        const header = def.shapes!.find((s) => s.tag === "header" && s.kind === "box" && pin.x >= s.x && pin.x <= s.x + s.w && pin.y >= s.y && pin.y <= s.y + (s as { d: number }).d);
        if (header) expect(solderPoint(place(def), pin.name)[2]).toBeCloseTo(def.body.h + (header.z ?? 0) + header.h, 9);
      }
    }
  });

  test("a header pin is not special on a pin that is not inside the header", () => {
    const board: PartDef = {
      ...BOARD,
      id: "mod",
      body: { w: 20, d: 10, h: 1.6 },
      shapes: [{ kind: "box", x: 0, y: 7, w: 10, d: 2.5, h: 2.5, tag: "header" }],
      pins: [
        { name: "IN", role: "io", x: 2, y: 8 },
        { name: "OUT", role: "io", x: 15, y: 2 },
      ],
    };
    const p = place(board);
    expect(solderPoint(p, "IN")[2]).toBeCloseTo(1.6 + 2.5, 9);
    expect(solderPoint(p, "OUT")[2]).toBeCloseTo(1.6, 9);
  });

  test("wiring steps to every header pin of the library modules pass the whole drawing check", () => {
    // On these two, the name of a pin on a tall plug or a header 2 mm from the board edge sits
    // beyond the magnifier's reach: a label-layout limit, so only hiding and wire problems count.
    const labelLimited = new Set(["max98357a-breakout", "soil-probe-capacitive-v12"]);
    for (const id of ["inmp441-mic", "active-buzzer-module", "relay-module-1ch", "max98357a-breakout", "soil-probe-capacitive-v12"]) {
      const def = defs.get(id)!;
      const headerPins = def.pins.filter((q) =>
        def.shapes!.some((s) => s.tag !== undefined && TERMINATION_TAGS.has(s.tag) && s.kind === "box" && q.x >= s.x && q.x <= s.x + s.w && q.y >= s.y && q.y <= s.y + s.d),
      );
      expect(headerPins.length).toBeGreaterThan(1);
      const loaded = load(
        [
          { ref: "mcu", part: "board" },
          { ref: "mod", part: id },
        ],
        headerPins.map((q) => ({ from: "mcu.10", to: `mod.${q.name}` })),
        new Map([...defs, ["board", BOARD]]),
      );
      const frame = benchFrame(loaded);
      loaded.project.connections.forEach((_, i) => {
        const found = checkWiringStep(wiringStepArt(loaded, i, frame).geom).filter((p) => !(labelLimited.has(id) && p.check === "label-missing"));
        expect(found).toEqual([]);
      });
    }
  });
});
