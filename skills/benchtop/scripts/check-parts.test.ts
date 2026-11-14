// The structural check of part files. One rule is tested here because it rejected a correct
// part: a pin had to lie inside the body outline exactly, and the switch lug of a PCB barrel
// jack sits 0.2 mm outside its housing on the maker's own drawing.

import { describe, expect, test } from "bun:test";
import { readdir } from "node:fs/promises";
import { join } from "node:path";
import { PIN_OVERHANG, check } from "./check-parts";
import { LIBRARY_DIR } from "./lib/project";
import type { PartDef } from "./lib/types";

function part(pins: { name: string; x: number; y: number }[]): PartDef {
  return {
    id: "t",
    name: "Test jack",
    kind: "connector",
    blurb: "A part that exists only to place its pins.",
    body: { w: 9, d: 14.4, h: 11 },
    maxHeight: 11,
    pins: pins.map((p) => ({ ...p, role: "passive" })),
    electrical: {},
    sourcing: { search: ["test jack"], priceUsd: 1 },
    sources: ["a drawing"],
    confidence: "datasheet",
  };
}

describe("a pin outside the body", () => {
  test("a leg just past the housing is a real part, not a mistake", () => {
    expect(check(part([{ name: "CENTER", x: 4.5, y: 13.7 }, { name: "SWITCH", x: -0.2, y: 10.7 }]), "t.json")).toEqual([]);
    expect(check(part([{ name: "A", x: 9 + PIN_OVERHANG, y: 14.4 + PIN_OVERHANG }]), "t.json")).toEqual([]);
  });

  test("a pin well outside is still caught: the wrong frame or the wrong unit", () => {
    // Inches typed as millimetres would put this pin at 0.1 instead of 2.54; the opposite mistake puts it far out.
    const errors = check(part([{ name: "A", x: 4.5, y: 13.7 }, { name: "B", x: 25.4, y: 10.7 }, { name: "C", x: 4.5, y: -1.5 }]), "t.json");
    expect(errors).toEqual([
      "pin B at (25.4, 10.7) is more than 1 mm outside the 9 x 14.4 body",
      "pin C at (4.5, -1.5) is more than 1 mm outside the 9 x 14.4 body",
    ]);
  });
});

describe("the bundled library", () => {
  test("every part file passes the check", async () => {
    const failing: string[] = [];
    for (const file of (await readdir(LIBRARY_DIR)).filter((n) => n.endsWith(".json")).sort()) {
      // Parsed JSON is untyped; check() validates the fields it reads.
      const errors = check((await Bun.file(join(LIBRARY_DIR, file)).json()) as PartDef, file);
      if (errors.length) failing.push(`${file}: ${errors.join("; ")}`);
    }
    expect(failing).toEqual([]);
  });
});
