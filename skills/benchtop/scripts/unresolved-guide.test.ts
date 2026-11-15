import { afterAll, describe, expect, test } from "bun:test";
import { mkdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { buildDrawings, buildFitCheck, buildWiring } from "./drawing";
import { buildGuide } from "./guide";
import { BOARD, BUTTON, project } from "./lib/drawing-fixtures";
import { resolveProject } from "./lib/project";
import type { PartDef } from "./lib/types";

const unresolved: PartDef = {
  ...BUTTON,
  id: "unresolved-module",
  name: "Unresolved module",
  geometryEvidence: { status: "unresolved", reason: "The exact board has a different pin arrangement; numeric positions are unknown.", unknown: ["PCB outline", "pad coordinates", "assembled height"] },
};
const definitions = new Map([[BOARD.id, BOARD], [unresolved.id, unresolved]]);
const plan = project([{ ref: "mcu", part: BOARD.id }, { ref: "mic", part: unresolved.id }], [{ from: "mcu.10", to: "mic.1" }]);
const root = join(tmpdir(), `benchtop-unresolved-guide-${process.pid}`);
afterAll(async () => { await rm(root, { recursive: true, force: true }); });

describe("unresolved physical geometry", () => {
  // Changed 2026-11-14: the withholding behaviour is now strict-geometry mode only; the default builds the full guide.
  test("strict geometry: retains useful inventory and logical connections without physical assembly scenes", async () => {
    process.env.BENCHTOP_STRICT_GEOMETRY = "1";
    try {
    const guide = await buildGuide(resolveProject(plan, definitions));
    expect(guide.html).toContain("partial planning guide");
    expect(guide.html).toContain("Pin layout unresolved — use source pinout");
    expect(guide.html).toContain("mcu.10");
    expect(guide.html).toContain("mic.1");
    expect(guide.html).not.toContain('class="step"');
    expect(guide.html).not.toContain("data-detail-callout");
    expect(guide.hero).toContain("Physical layout unresolved");
    expect(guide.findings.map((f) => [f.check, f.part])).toEqual([["geometry-unresolved", "mic"]]);
    expect(guide.drawings).toBe(1); // only the known controller's individual inventory view
    } finally {
      delete process.env.BENCHTOP_STRICT_GEOMETRY;
    }
  });

  test("default: the full guide is built, with the unverified part marked where a builder looks", async () => {
    const guide = await buildGuide(resolveProject(plan, definitions));
    expect(guide.html).not.toContain("partial planning guide");
    expect(guide.html).toContain('class="step"');
    // Cover, inventory and the step that wires to the part each carry a notice.
    expect(guide.html).toContain("Layout not verified for Unresolved module. Measure the real part before printing the case.");
    expect(guide.html).toContain("Layout not verified. Measure yours before printing the case: The exact board has a different pin arrangement; numeric positions are unknown.");
    expect(guide.html).toContain("Layout of the unresolved module not verified. Measure yours before printing the case.");
    // Unverified geometry is something to measure, not a drawing defect: no finding.
    expect(guide.findings.filter((f) => f.check === "geometry-unresolved")).toEqual([]);
  });

  test("strict geometry: returns the partial guide before attempting PCB or enclosure geometry", async () => {
    process.env.BENCHTOP_STRICT_GEOMETRY = "1";
    try {
    const pcb = { ...plan, build: { ...plan.build, path: "pcb-diy" as const } };
    const guide = await buildGuide(resolveProject(pcb, definitions));
    expect(guide.findings[0]!.check).toBe("geometry-unresolved");
    expect(guide.html).not.toContain("into its outline on the board");
    } finally {
      delete process.env.BENCHTOP_STRICT_GEOMETRY;
    }
  });

  // Changed 2026-11-14: the drawing APIs refuse only in strict-geometry mode (the default warns and draws).
  test("strict geometry: physical drawing and fit-check APIs refuse the unresolved layout", () => {
    const loaded = resolveProject(plan, definitions);
    process.env.BENCHTOP_STRICT_GEOMETRY = "1";
    try {
      for (const draw of [buildDrawings, buildWiring, buildFitCheck]) {
        expect(() => draw(loaded)).toThrow("needs resolved physical geometry");
      }
    } finally {
      delete process.env.BENCHTOP_STRICT_GEOMETRY;
    }
  });

  test("default guide exits 0 even with --strict, and says once on a warning line that geometry is unverified", async () => {
    await mkdir(join(root, "parts"), { recursive: true });
    await Bun.write(join(root, "project.json"), JSON.stringify(plan));
    for (const def of definitions.values()) await Bun.write(join(root, "parts", `${def.id}.json`), JSON.stringify(def));
    // --strict is about drawing quality; unverified geometry is something to measure.
    const child = Bun.spawn(["bun", join(import.meta.dir, "guide.ts"), root, "--strict"], { stdout: "pipe", stderr: "pipe" });
    const output = await new Response(child.stdout).text();
    const errors = await new Response(child.stderr).text();
    expect(await child.exited).toBe(0);
    // Without Chrome the guide also warns that the pages were not measured; that is about the
    // machine, not the geometry, so it is left out of the count.
    const warnings = `${output}\n${errors}`.split("\n").filter((l) => l.startsWith("warning:") && !l.includes("pages were not measured"));
    expect(warnings).toHaveLength(1);
    expect(warnings[0]).toContain("UNVERIFIED geometry");
    expect(output).not.toContain("drawing: ");
    expect(await Bun.file(join(root, "out", "guide", "index.html")).text()).not.toContain("partial planning guide");
  });

  test("strict guide (with --strict-geometry) exits nonzero while still writing the explicit partial package", async () => {
    await mkdir(join(root, "parts"), { recursive: true });
    await Bun.write(join(root, "project.json"), JSON.stringify(plan));
    for (const def of definitions.values()) await Bun.write(join(root, "parts", `${def.id}.json`), JSON.stringify(def));
    const child = Bun.spawn(["bun", join(import.meta.dir, "guide.ts"), root, "--strict", "--strict-geometry"], { stdout: "pipe", stderr: "pipe" });
    const output = await new Response(child.stdout).text();
    expect(await child.exited).toBe(1);
    expect(output).toContain("physical layout");
    expect(await Bun.file(join(root, "out", "guide", "index.html")).text()).toContain("partial planning guide");
    expect(await Bun.file(join(root, "out", "guide", "hero.svg")).text()).toContain("Physical layout unresolved");
  });
});
