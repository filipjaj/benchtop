import { test, expect } from "bun:test";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { assertResolvedGeometry, resetGeometryWarning, strictGeometry, unresolvedGeometry, unverifiedNotes, warnUnresolvedGeometry } from "./geometry-evidence";
import type { Loaded } from "./project";
import type { PartDef } from "./types";

const def = JSON.parse(readFileSync(new URL("../../assets/parts/inmp441-mic.json", import.meta.url), "utf8")) as PartDef;
const loaded = (d: PartDef) => ({ placed: [{ use: { ref: "mic", part: d.id }, def: d, at: { x: 0, y: 0, rot: 0 } }] }) as Pick<Loaded, "placed">;

/** Runs `fn` and returns what it printed to stderr. */
function stderrOf(fn: () => void): string[] {
  const lines: string[] = [];
  const original = console.error;
  console.error = (...args: unknown[]) => void lines.push(args.map(String).join(" "));
  try {
    fn();
  } finally {
    console.error = original;
  }
  return lines;
}

// Policy changed on 2026-11-14 from "refuse" to "warn, still build" (see geometry-evidence.ts).
test("known contradictory module geometry warns once, with a concrete reason, and lets the build go on", () => {
  resetGeometryWarning();
  expect(unresolvedGeometry(loaded(def))).toHaveLength(1);
  const first = stderrOf(() => expect(warnUnresolvedGeometry(loaded(def), "Enclosure")).toHaveLength(1));
  expect(first).toHaveLength(1);
  expect(first[0]).toMatch(/^warning: .*UNVERIFIED geometry/);
  expect(first[0]).toMatch(/six pad coordinates/);
  expect(first[0]).toMatch(/parts\/inmp441-mic\.json/);
  // Five outputs ask in one build step; the reader gets the warning once.
  expect(stderrOf(() => warnUnresolvedGeometry(loaded(def), "Drawings"))).toEqual([]);
  expect(unverifiedNotes(loaded(def))[0]).toMatch(/^LAYOUT NOT VERIFIED: .*\(mic\)/);
});

test("strict mode keeps the refusal, and a carrier PCB is refused in every mode", () => {
  resetGeometryWarning();
  process.env.BENCHTOP_STRICT_GEOMETRY = "1";
  try {
    expect(strictGeometry()).toBe(true);
    expect(() => warnUnresolvedGeometry(loaded(def), "Enclosure")).toThrow(/logical connections\/BOM/);
  } finally {
    delete process.env.BENCHTOP_STRICT_GEOMETRY;
  }
  expect(strictGeometry()).toBe(false);
  // A board costs money to make and has no cheap fit test, so pcb.ts always asserts.
  expect(() => assertResolvedGeometry(loaded(def), "Carrier PCB")).toThrow(/six pad coordinates/);
});

test("legacy typical models are not silently reclassified as verified or blocked", () => {
  const typical = structuredClone(def);
  delete typical.geometryEvidence;
  expect(() => assertResolvedGeometry(loaded(typical), "Enclosure")).not.toThrow();
  expect(stderrOf(() => warnUnresolvedGeometry(loaded(typical), "Enclosure"))).toEqual([]);
  expect(unverifiedNotes(loaded(typical))).toEqual([]);
  expect(typical.confidence).toBe("typical");
});

test("incomplete native-geometry draft reports missing dimensions, not malformed JSON", () => {
  const script = fileURLToPath(new URL("../check-parts.ts", import.meta.url));
  const drafts = fileURLToPath(new URL("../../assets/geometry-evidence/drafts", import.meta.url));
  const result = Bun.spawnSync([process.execPath, script, drafts]);
  const output = result.stdout.toString();
  expect(result.exitCode).toBe(1);
  expect(output).toContain("body needs positive w, d, h");
  expect(output).toContain("maxHeight needs a positive finite number");
  expect(output).not.toContain("not valid JSON");
});
