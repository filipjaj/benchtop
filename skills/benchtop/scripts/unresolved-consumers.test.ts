import { afterAll, afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdir, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { buildShopping, mustMatch } from "./shopping";
import { consumables } from "./lib/consumables";
import { BUTTON, project } from "./lib/drawing-fixtures";
import { resolveProject } from "./lib/project";
import type { PartDef } from "./lib/types";

const root = join(tmpdir(), `benchtop-unresolved-consumers-${process.pid}`);
afterAll(async () => { await rm(root, { recursive: true, force: true }); });
// Sentinel geometry must never appear as purchasing or physical-render guidance.
const unknown: PartDef = {
  ...BUTTON, id: "unresolved-module", name: "Exact module pending", kind: "sensor",
  body: { w: 9876.543, d: 8765.432, h: 1 }, maxHeight: 7654.321,
  pins: BUTTON.pins.map((p, i) => i === 0 ? { ...p, role: "power-in", minVolts: 1.8, maxVolts: 3.6 } : p),
  footprint: { mount: "header", pitch: 123.456 }, holes: [{ x: 2, y: 2, dia: 2 }],
  ports: [{ name: "cap", faces: "up", x: 2, y: 2, w: 2, h: 2, reach: true }],
  sourcing: { search: ["EXACT_MODULE_SEARCH"], priceUsd: 3 },
  verify: "Legacy size 9876.543 x 8765.432 mm and old row order must not be shown.",
  geometryEvidence: { status: "unresolved", reason: "The exact board has another pin arrangement; numeric coordinates are unknown.", unknown: ["pad coordinates", "PCB outline", "height"] },
};
const plan = (owned = false, enclosure = false) => {
  const p = project([{ ref: "mic", part: unknown.id, owned }], [{ from: "mic.1", to: "mic.2" }]);
  // Deliberately incomplete enclosure: no geometry code should inspect it when
  // the part is unresolved; useful general consumables must still be available.
  if (enclosure) p.enclosure = {} as NonNullable<typeof p.enclosure>;
  return p;
};
const load = (owned = false, enclosure = false) => resolveProject(plan(owned, enclosure), new Map([[unknown.id, unknown]]));

// Since 2026-11-14 the default is "warn, still build". What follows is strict mode
// (BENCHTOP_STRICT_GEOMETRY=1), where the case is refused and so its hardware is withheld.
describe("unresolved geometry in downstream consumers, strict mode", () => {
  beforeEach(() => { process.env.BENCHTOP_STRICT_GEOMETRY = "1"; });
  afterEach(() => { delete process.env.BENCHTOP_STRICT_GEOMETRY; });

  test("shopping criteria keep supply information without legacy size, order, pitch, holes or height", () => {
    for (const kind of ["sensor", "board"] as const) {
      const criteria = mustMatch({ ...unknown, kind });
      expect(criteria).toContain("Runs from 1.8 to 3.6 V");
      expect(criteria.join(" ")).toContain("unresolved");
      expect(criteria.join(" ")).not.toMatch(/9876|8765|7654|123\.456|Pins in this order|mounting holes|mm apart/);
    }
  });

  for (const owned of [false, true]) test(`shopping stays usable for ${owned ? "owned" : "to-buy"} unresolved parts without physical artwork`, async () => {
    const html = await buildShopping(load(owned, true), "NO");
    expect(html).toContain("Pin layout unresolved");
    expect(html).toContain("Enclosure hardware withheld");
    expect(html).not.toContain("<svg");
    expect(html).not.toMatch(/9876\.543|8765\.432|7654\.321|Pins in this order/);
    if (owned) expect(html).toContain("You have this");
    else expect(html).toContain("EXACT_MODULE_SEARCH");
  });

  test("shared consumables retain wire, solder and heat-shrink but never derive enclosure screws", async () => {
    const items = await consumables(load(false, true));
    expect(items.some((x) => /wire/i.test(x.name))).toBe(true);
    expect(items.some((x) => x.name === "Solder")).toBe(true);
    expect(items.some((x) => /Heat-shrink/.test(x.name))).toBe(true);
    expect(items.some((x) => /screw|enclosure/i.test(`${x.name} ${x.blurb}`))).toBe(false);
  });

  async function prepared(name: string) {
    const dir = join(root, name);
    await mkdir(join(dir, "parts"), { recursive: true });
    await Bun.write(join(dir, "parts", `${unknown.id}.json`), JSON.stringify(unknown));
    await Bun.write(join(dir, "project.json"), JSON.stringify(plan(false, true)));
    return dir;
  }
  async function run(script: string, dir: string) {
    const child = Bun.spawn([process.execPath, join(import.meta.dir, script), dir], { env: { ...process.env, PATH: "" }, stdout: "pipe", stderr: "pipe" });
    const [stdout, stderr] = await Promise.all([new Response(child.stdout).text(), new Response(child.stderr).text()]);
    return { code: await child.exited, stdout, stderr };
  }

  test("BOM keeps electronic parts and valid consumables while disclosing missing mechanical hardware in CSV and Markdown", async () => {
    const dir = await prepared("bom");
    expect((await run("bom.ts", dir)).code).toBe(0);
    for (const name of ["bom.csv", "bom.md"]) {
      const text = await Bun.file(join(dir, "out", name)).text();
      expect(text).toContain("Exact module pending");
      expect(text).toContain("Solder");
      expect(text).toContain("Enclosure hardware withheld");
      expect(text).not.toMatch(/M2.*screw|M3.*screw/);
    }
  });

  for (const script of ["concept.ts", "render.ts"]) test(`${script} refuses before physical output or stale model reuse, even without Blender`, async () => {
    const dir = await prepared(script);
    const stale = join(dir, "out", "enclosure", "closed.glb");
    await mkdir(dirname(stale), { recursive: true });
    await Bun.write(stale, "STALE MODEL MUST NOT BE USED");
    const result = await run(script, dir);
    expect(result.code).toBe(2);
    expect(result.stderr).toContain("needs resolved physical geometry");
    expect(result.stdout).not.toContain("Blender");
    expect(await Bun.file(stale).text()).toBe("STALE MODEL MUST NOT BE USED");
    expect(await stat(join(dir, "out", "renders")).catch(() => null)).toBeNull();
    expect(await Bun.file(join(dir, "out", "concept.html")).exists()).toBe(false);
  });
});

describe("unresolved geometry in downstream consumers, default mode", () => {
  test("shopping still refuses to state an unverified size or pin order as something to match in a shop", () => {
    const criteria = mustMatch({ ...unknown, kind: "sensor" });
    expect(criteria.join(" ")).toContain("unresolved");
    expect(criteria.join(" ")).not.toMatch(/9876|8765|7654|Pins in this order/);
  });

  test("the BOM no longer withholds the case hardware note by default", async () => {
    // Without an enclosure block there is no hardware either way; the point is the wording.
    const dir = join(root, "bom-default");
    await mkdir(join(dir, "parts"), { recursive: true });
    await Bun.write(join(dir, "parts", `${unknown.id}.json`), JSON.stringify(unknown));
    await Bun.write(join(dir, "project.json"), JSON.stringify(plan(false, false)));
    const child = Bun.spawn([process.execPath, join(import.meta.dir, "bom.ts"), dir], { stdout: "pipe", stderr: "pipe" });
    expect(await child.exited).toBe(0);
    const text = await Bun.file(join(dir, "out", "bom.md")).text();
    expect(text).toContain("Exact module pending");
    expect(text).not.toContain("Enclosure hardware withheld");
  });
});
