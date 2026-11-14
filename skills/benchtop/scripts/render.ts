#!/usr/bin/env bun
// Render product images of the enclosure with Blender.
//
//   bun render.ts <projectDir> [--quality draft|final] [--only hero,exploded,top]
//                 [--color #rrggbb] [--backdrop #rrggbb] [--check-alpha]
//
// Reads <projectDir>/out/enclosure/closed.glb (written by enclosure.ts; generated here
// when missing) and writes into <projectDir>/out/renders/:
//   hero.png        closed object, three-quarter view, 1600 x 1200
//   hero-alpha.png  the same view on a transparent background with a soft contact shadow
//   exploded.png    lid lifted, lid-mounted parts hanging below it, floor parts in the body
//   top.png         straight down, orthographic, lid on
// --only takes hero, hero-alpha, exploded, top. --color overrides enclosure.color and
// --backdrop (or --bg) the backdrop; by default a same-hue shade 14 points of lightness darker
// than a light case, lighter than a dark one. --check-alpha writes alpha-check-*.png.
//
// Exit codes: 0 ok, 2 project or usage error, 3 Blender not installed (nothing rendered,
// nothing else fails), 4 Blender ran but did not write every image.

import { existsSync } from "node:fs";
import { join, resolve } from "node:path";
import { loadProject, main } from "./lib/project";
import { warnUnresolvedGeometry } from "./lib/geometry-evidence";

const IMAGES = ["hero", "hero-alpha", "exploded", "top"] as const;
type Image = (typeof IMAGES)[number];
const HEX = /^#?[0-9a-f]{6}$/i;

function flag(args: string[], name: string): string | undefined {
  const i = args.indexOf(`--${name}`);
  return i >= 0 ? args[i + 1] : undefined;
}

/** Backdrop of the same hue as the case: about 14 points of lightness darker for a light case, lighter for a dark one. */
export function autoBackdrop(caseHex: string): string {
  const n = parseInt(caseHex.replace("#", ""), 16);
  const [r, g, b] = [(n >> 16) & 255, (n >> 8) & 255, n & 255].map((v) => v / 255) as [number, number, number];
  const max = Math.max(r, g, b);
  const min = Math.min(r, g, b);
  let l = (max + min) / 2;
  const d = max - min;
  let h = 0;
  if (d !== 0) {
    if (max === r) h = ((g - b) / d + 6) % 6;
    else if (max === g) h = (b - r) / d + 2;
    else h = (r - g) / d + 4;
  }
  l = l > 0.5 ? Math.max(0.12, l - 0.14) : Math.min(0.9, l + 0.25);
  const c = Math.min(d, 1 - Math.abs(2 * l - 1)); // keep the case's chroma, so a pale case gets a neutral-ish backdrop
  const x = c * (1 - Math.abs((h % 2) - 1));
  const m = l - c / 2;
  const [r1, g1, b1] = h < 1 ? [c, x, 0] : h < 2 ? [x, c, 0] : h < 3 ? [0, c, x] : h < 4 ? [0, x, c] : h < 5 ? [x, 0, c] : [c, 0, x];
  const hex = (v: number): string => Math.round((v + m) * 255).toString(16).padStart(2, "0");
  return `#${hex(r1)}${hex(g1)}${hex(b1)}`;
}

function fail(message: string): never {
  console.error(`error: ${message}`);
  process.exit(2);
}

main(async () => {
  const args = process.argv.slice(2);
  const dirArg = args[0];
  if (!dirArg || dirArg.startsWith("--")) {
    fail("usage: bun render.ts <projectDir> [--quality draft|final] [--only hero,exploded,top] [--color #rrggbb] [--backdrop #rrggbb] [--device cpu] [--check-alpha]");
  }
  const quality = flag(args, "quality") ?? "draft";
  if (quality !== "draft" && quality !== "final") fail(`--quality must be draft or final, got "${quality}"`);
  const only = (flag(args, "only") ?? IMAGES.join(",")).split(",").map((s) => s.trim()).filter(Boolean);
  const unknown = only.filter((s) => !(IMAGES as readonly string[]).includes(s));
  if (unknown.length) fail(`unknown image ${unknown.join(", ")}; choose from ${IMAGES.join(", ")}`);
  const bgFlag = flag(args, "backdrop") ?? flag(args, "bg");
  if (bgFlag !== undefined && !HEX.test(bgFlag)) fail(`--backdrop must be a hex colour like #e6e4dd, got "${bgFlag}"`);

  const loaded = await loadProject(dirArg);
  warnUnresolvedGeometry(loaded, "physical renders, including cached enclosure models");
  const blender = Bun.which("blender");
  if (!blender) {
    console.log("renders skipped: Blender is not on PATH. Install it (brew install --cask blender, or blender.org/download) and run this again.");
    process.exit(3);
  }

  const spec = loaded.project.enclosure;
  if (!spec) fail("project.json has no enclosure, so there is nothing to render.");
  const color = flag(args, "color") ?? spec.color;
  if (!HEX.test(color)) fail(`enclosure colour must be a hex colour like #c9c5bb, got "${color}"`);

  const bg = bgFlag ?? autoBackdrop(color);
  // showcase.lit: one colour for every LED, or a colour per part ref. Passed on as JSON.
  const rawLit = loaded.project.showcase?.lit;
  const lit: Record<string, string> | null =
    rawLit === undefined ? null : typeof rawLit === "string" ? { "*": rawLit } : Object.keys(rawLit).length ? rawLit : null;
  for (const [ref, c] of Object.entries(lit ?? {})) {
    if (!HEX.test(c)) fail(`showcase.lit ${ref === "*" ? "" : `for "${ref}" `}must be a hex colour like #ff2a1a, got "${c}"`);
    if (ref !== "*" && !loaded.byRef.has(ref)) fail(`showcase.lit names part "${ref}", which is not in project.json`);
  }
  const litArg = lit ? JSON.stringify(Object.fromEntries(Object.entries(lit).map(([k, v]) => [k, v.startsWith("#") ? v : `#${v}`]))) : null;
  const dir = resolve(loaded.dir);
  const glb = join(dir, "out", "enclosure", "closed.glb");
  if (!existsSync(glb)) {
    console.log("closed.glb is missing; running enclosure.ts first.");
    const gen = Bun.spawnSync([process.execPath, join(import.meta.dir, "enclosure.ts"), dir], { stdout: "inherit", stderr: "inherit" });
    if (gen.exitCode !== 0 || !existsSync(glb)) fail("enclosure.ts did not produce closed.glb.");
  }

  const outDir = join(dir, "out", "renders");
  const views = [...new Set(only.map((s): string => (s === "hero-alpha" ? "hero" : s)))];
  const blend = async (device: "auto" | "cpu"): Promise<{ stdout: string; stderr: string; code: number }> => {
    const proc = Bun.spawn(
      [
        blender, "-b", "--factory-startup", "-noaudio", "--python", join(import.meta.dir, "lib", "render_scene.py"), "--",
        "--closed", glb, "--out", outDir, "--only", views.join(","), "--quality", quality,
        "--color", color.startsWith("#") ? color : `#${color}`, "--bg", bg.startsWith("#") ? bg : `#${bg}`,
        "--device", device,
        ...(litArg ? ["--lit", litArg] : []),
        ...(args.includes("--check-alpha") ? ["--check-alpha", "1"] : []),
      ],
      { stdout: "pipe", stderr: "pipe" },
    );
    const [stdout, stderr] = await Promise.all([new Response(proc.stdout).text(), new Response(proc.stderr).text()]);
    return { stdout, stderr, code: await proc.exited };
  };
  const wantCpu = flag(args, "device") === "cpu";
  let run = await blend(wantCpu ? "cpu" : "auto");
  if (run.code !== 0 && !wantCpu) {
    // The GPU backend can crash while compiling its kernels (seen once on Metal, with
    // the same scene rendering fine before and after). One retry on the CPU is slower
    // but removes that failure from a build nobody is watching.
    console.log(`note: Blender exited with status ${run.code} on the GPU; rendering again on the CPU.`);
    run = await blend("cpu");
  }
  const { stdout, stderr, code } = run;
  const times = new Map<string, string>();
  for (const line of stdout.split("\n")) {
    const m = /^RENDER (\S+) (\S+)$/.exec(line.trim());
    if (m) times.set(m[1]!, m[2]!);
    else if (line.startsWith("engine:") || line.startsWith("ALPHA-CHECK")) console.log(line.trim());
  }
  if (code !== 0) {
    console.error(stdout.split("\n").slice(-25).join("\n"));
    console.error(stderr.split("\n").slice(-15).join("\n"));
    console.error(`error: Blender exited with status ${code}.`);
    process.exit(4);
  }
  let missing = 0;
  const written: string[] = [];
  for (const image of only as Image[]) {
    const path = join(outDir, `${image}.png`);
    if (!existsSync(path)) {
      console.error(`error: ${path} was not written.`);
      missing++;
      continue;
    }
    written.push(`${image}.png`);
    const s = times.get(image === "hero-alpha" ? "hero" : image);
    console.log(`${path}${s ? ` (${s} s)` : ""}`);
  }
  if (missing) process.exit(4);
  // What these images are, so a later build does not replace final renders with draft ones
  // or show a lit render as unlit. Lists only the images this run wrote.
  const device: "gpu" | "cpu" = /engine: CYCLES \(GPU\)/.test(stdout) ? "gpu" : "cpu";
  await Bun.write(join(outDir, "render.json"), `${JSON.stringify({ quality, images: written, lit, device }, null, 2)}\n`);
});
