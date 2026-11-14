import { afterAll, describe, expect, test } from "bun:test";
import { cp, mkdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

// Two faults from a 50-project evaluation, both about a package that says more than it holds:
// the zip left out the project's own part files, so nobody else could rebuild it, and the
// landing page said "Rendered and drawn" when the build had skipped the renders.

const root = join(tmpdir(), `benchtop-package-contents-${process.pid}`);
afterAll(async () => {
  await rm(root, { recursive: true, force: true });
});

async function packaged(name: string, prepare: (dir: string) => Promise<void>): Promise<{ dist: string; page: string; readme: string }> {
  const dir = join(root, name);
  await mkdir(dir, { recursive: true });
  await cp(join(import.meta.dir, "..", "examples", "luft", "project.json"), join(dir, "project.json"));
  await prepare(dir);
  const child = Bun.spawn(["bun", join(import.meta.dir, "package.ts"), dir, "--no-zip"], { stdout: "pipe", stderr: "pipe" });
  const err = await new Response(child.stderr).text();
  expect({ code: await child.exited, err }).toEqual({ code: 0, err: "" });
  const dist = join(dir, "dist", "luft");
  return { dist, page: await Bun.file(join(dist, "index.html")).text(), readme: await Bun.file(join(dist, "README.md")).text() };
}

describe("what a package holds and what its page says", () => {
  test("a part file that lives in the project travels with the package and is listed", async () => {
    const r = await packaged("parts", async (dir) => {
      await mkdir(join(dir, "parts"), { recursive: true });
      await cp(join(import.meta.dir, "..", "assets", "parts", "tactile-button-6mm-tall.json"), join(dir, "parts", "tactile-button-6mm-tall.json"));
    });
    expect(await Bun.file(join(r.dist, "files", "parts", "tactile-button-6mm-tall.json")).exists()).toBe(true);
    expect(r.readme).toContain("`files/parts/`");
  }, 120_000);

  test("without project parts nothing is listed for them", async () => {
    const r = await packaged("no-parts", async () => {});
    expect(r.readme).not.toContain("files/parts/");
  }, 120_000);

  test("a build with drawings and no renders says drawn, not rendered", async () => {
    const r = await packaged("drawn", async (dir) => {
      await mkdir(join(dir, "out", "drawings"), { recursive: true });
      await Bun.write(join(dir, "out", "drawings", "enclosure.svg"), `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 10 10"/>`);
    });
    expect(r.page).toContain("Drawn from the same files the case is printed from.");
    expect(r.page).not.toContain("Rendered");
  }, 120_000);
});
