// The drawing check as a builder of a project meets it: run on every guide build,
// one line per problem, exit code 0 unless --strict.

import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { mkdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { buildGuide } from "./guide";
import { formatFinding } from "./lib/drawing-check";
import { BOARD, BUTTON, project } from "./lib/drawing-fixtures";
import { loadProject } from "./lib/project";
import type { PartUse } from "./lib/types";

const root = join(tmpdir(), `benchtop-guide-test-${process.pid}`);
const wires = [
  { from: "mcu.10", to: "btn.1", color: "green" as const },
  { from: "btn.2", to: "mcu.GND", color: "black" as const },
];
const parts = (bench?: PartUse["bench"]): PartUse[] => [
  { ref: "mcu", part: "board", label: "Controller" },
  { ref: "btn", part: "button", label: "Button", bench },
];

async function write(name: string, bench?: PartUse["bench"]): Promise<string> {
  const dir = join(root, name);
  await mkdir(join(dir, "parts"), { recursive: true });
  await Bun.write(join(dir, "project.json"), JSON.stringify(project(parts(bench), wires)));
  // Project-local parts, so the test does not depend on the state of the library.
  for (const def of [BOARD, BUTTON]) await Bun.write(join(dir, "parts", `${def.id}.json`), JSON.stringify(def));
  return dir;
}

async function run(dir: string, ...flags: string[]): Promise<{ code: number; out: string }> {
  const proc = Bun.spawn(["bun", join(import.meta.dir, "guide.ts"), dir, ...flags], { stdout: "pipe", stderr: "pipe" });
  const out = await new Response(proc.stdout).text();
  return { code: await proc.exited, out };
}

let clean = "";
let pinned = "";

beforeAll(async () => {
  clean = await write("clean");
  // The button fixed with leg 1 at the back, behind its own stem.
  pinned = await write("pinned", { x: 40, y: 0, rot: 0 });
});

afterAll(async () => {
  await rm(root, { recursive: true, force: true });
});

describe("drawing check in the guide build", () => {
  test("a project the renderer can draw cleanly reports nothing", async () => {
    const guide = await buildGuide(await loadProject(clean));
    expect(guide.findings).toEqual([]);
    expect(guide.drawings).toBeGreaterThanOrEqual(4);
  });

  test("a problem is reported with its page, step, part, and the file and field to change", async () => {
    const guide = await buildGuide(await loadProject(pinned));
    const hidden = guide.findings.filter((f) => f.check === "wire-end-hidden");
    // Once on the cover, which shows the wired bench, and once on the step that adds the wire.
    expect(hidden.map((f) => [f.page, f.step])).toEqual([[1, undefined], [4, 1]]);
    expect(formatFinding(hidden[0]!)).toStartWith(`drawing: page 1 (the finished object on the cover), part "btn": `);
    const line = formatFinding(hidden[1]!);
    expect(line).toStartWith(`drawing: page 4, step 1 (Controller 10 to Button 1), part "btn": The Button pad 1 is behind btn stem`);
    expect(line).toContain(`"bench"`);
    expect(line).toContain("project.json");
    // The part file named is the one this project would actually load.
    expect(line).toContain(`"z" in parts/button.json`);
    // Added 2026-11-14: the fix is a paste-ready bench value naming the turn, on the cover and the step.
    for (const f of hidden) expect(f.fix).toMatch(/Turn the part \d+ degrees: set "bench": \{ "x": [-\d.]+, "y": [-\d.]+, "rot": \d+ \}/);
  });

  test("the build prints one line per problem and still exits 0", async () => {
    const { code, out } = await run(pinned);
    expect(code).toBe(0);
    const lines = out.split("\n").filter((l) => l.startsWith("drawing: "));
    expect(lines).toHaveLength(2);
    expect(out).toContain("drawing check: 2 problems in");
    expect(await Bun.file(join(pinned, "out", "guide", "index.html")).exists()).toBe(true);
  });

  test("--strict turns any problem into a failing exit code, and leaves a clean build at 0", async () => {
    const bad = await run(pinned, "--strict");
    expect(bad.code).toBe(1);
    expect(bad.out).toContain(`drawing: page 4, step 1`);
    const good = await run(clean, "--strict");
    expect(good.code).toBe(0);
    expect(good.out).toContain("no problems");
  });
});
