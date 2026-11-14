import { afterAll, describe, expect, test } from "bun:test";
import { mkdir, readdir, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { BUTTON, project } from "./lib/drawing-fixtures";
import type { PartDef } from "./lib/types";

const root = join(tmpdir(), `benchtop-package-geometry-${process.pid}`);
afterAll(async () => { await rm(root, { recursive: true, force: true }); });
const unresolved: PartDef = { ...BUTTON, id: "unknown-module", geometryEvidence: { status: "unresolved", reason: "Exact variant has no verified pad layout.", unknown: ["pad coordinates"] } };

// Strict mode: the default since 2026-11-14 is to warn and package (see the last test).
describe("packaging unresolved physical geometry, strict mode", () => {
  for (const existingDist of [false, true]) {
    test(`refuses before copying old physical artifacts or ${existingDist ? "touching an existing" : "creating a"} dist`, async () => {
      const dir = join(root, existingDist ? "existing" : "fresh");
      await mkdir(join(dir, "parts"), { recursive: true });
      await Bun.write(join(dir, "parts", `${unresolved.id}.json`), JSON.stringify(unresolved));
      // Deliberately no showcase copy: unresolved geometry must be diagnosed first.
      await Bun.write(join(dir, "project.json"), JSON.stringify(project([{ ref: "mic", part: unresolved.id }], [])));
      const artifacts = ["out/enclosure/body.stl", "out/guide/guide.pdf", "out/drawings/wiring.svg", "out/renders/hero.png"];
      for (const path of artifacts) {
        await mkdir(dirname(join(dir, path)), { recursive: true });
        await Bun.write(join(dir, path), `OLD PHYSICAL ARTIFACT: ${path}`);
      }
      const dist = join(dir, "dist", "test");
      if (existingDist) {
        await mkdir(dist, { recursive: true });
        await Bun.write(join(dist, "sentinel.txt"), "PRIOR PACKAGE UNCHANGED");
      }
      const child = Bun.spawn(["bun", join(import.meta.dir, "package.ts"), dir, "--no-zip", "--strict-geometry"], { stdout: "pipe", stderr: "pipe" });
      const [stdout, stderr] = await Promise.all([new Response(child.stdout).text(), new Response(child.stderr).text()]);
      expect(await child.exited).toBe(2);
      expect(stderr).toContain("needs resolved physical geometry");
      expect(stderr).toContain("partial package");
      expect(stderr).not.toContain("project.json is missing");
      expect(stdout).toBe("");
      if (existingDist) {
        expect(await readdir(dist)).toEqual(["sentinel.txt"]);
        expect(await Bun.file(join(dist, "sentinel.txt")).text()).toBe("PRIOR PACKAGE UNCHANGED");
      } else {
        expect(await stat(join(dir, "dist")).catch(() => null)).toBeNull();
      }
      for (const path of artifacts) expect(await Bun.file(join(dir, path)).text()).toBe(`OLD PHYSICAL ARTIFACT: ${path}`);
    });
  }
});

describe("packaging unresolved physical geometry, default mode", () => {
  test("warns about the unverified part and goes on to the next requirement instead of refusing", async () => {
    const dir = join(root, "default");
    await mkdir(join(dir, "parts"), { recursive: true });
    await Bun.write(join(dir, "parts", `${unresolved.id}.json`), JSON.stringify(unresolved));
    // No showcase copy, so packaging still stops, but for that reason and after the warning.
    await Bun.write(join(dir, "project.json"), JSON.stringify(project([{ ref: "mic", part: unresolved.id }], [])));
    const child = Bun.spawn(["bun", join(import.meta.dir, "package.ts"), dir, "--no-zip"], { stdout: "pipe", stderr: "pipe" });
    const stderr = await new Response(child.stderr).text();
    await child.exited;
    expect(stderr).toMatch(/warning: .*\(mic\) is drawn from UNVERIFIED geometry/);
    expect(stderr).toContain("Exact variant has no verified pad layout.");
    expect(stderr).not.toContain("needs resolved physical geometry");
    expect(stderr).toMatch(/showcase/);
  });
});
