#!/usr/bin/env bun
// Runs every generator for a project in the right order and reports what happened.
//
// Usage: bun build.ts <projectDir> [--region NO] [--skip render,pcb] [--quality final]
//
// The individual scripts stay the way to iterate on one thing; this is the way to be
// sure nothing was missed or left stale before handing a project over. It stops at
// the electrical check if that fails, because every later file would describe a
// circuit that should not be built. Everything any step warned about is collected in
// one list at the end and in <projectDir>/out/build-report.md.

import { mkdir } from "node:fs/promises";
import { join } from "node:path";
import { ProjectError, loadProject, main } from "./lib/project";

interface StepResult {
  name: string;
  status: "ok" | "skipped" | "failed";
  seconds: number;
  why?: string;
  /** Warnings and problems: what someone has to act on or accept. */
  notes: string[];
  /** Information-level lines: assumptions a generator wants on record, nothing to fix. */
  info: string[];
  outputs: string[];
}

interface Step {
  name: string;
  script: string;
  args?: string[];
  /** Return a reason to skip, or null to run. */
  skip?: () => string | null;
  /** Exit codes that mean "could not run here" rather than "the project is wrong". */
  soft?: Record<number, string>;
  /** A failure here stops the build. */
  gate?: boolean;
}

const here = import.meta.dir;

// Lines worth repeating in the summary: anything a script flagged about the project.
const NOTE = /^\s*(warning:|check:|drawing:|\[[a-z-]+\]|error:|store unavailable|pdf skipped|zip skipped)/i;
const PATHLIKE = /^(\/|[A-Za-z]:\\).+\.[a-z0-9]+(\s|$)/;

/**
 * Sorts a step's output into what needs attention and what is only on record.
 * validate.ts prints its findings under "ERROR (2)", "WARN (1)", "INFO (1)" headings.
 * What sits under INFO is a declared assumption, not a problem: listing it with the
 * warnings taught readers to skim past the list.
 */
export function classify(lines: string[]): { flagged: string[]; info: string[] } {
  let section = "";
  const flagged: string[] = [];
  const info: string[] = [];
  for (const l of lines) {
    const head = /^(ERROR|WARN|INFO) \(\d+\)$/.exec(l);
    if (head) {
      section = head[1]!;
      continue;
    }
    // A check that reports it found nothing is not something to flag.
    if (!NOTE.test(l) || /no shorts detected|no problems|nothing (was )?found/i.test(l)) continue;
    if (section === "INFO") info.push(l);
    else flagged.push(l);
  }
  return { flagged, info };
}

async function run(step: Step, dir: string): Promise<StepResult> {
  const reason = step.skip?.() ?? null;
  if (reason) return { name: step.name, status: "skipped", seconds: 0, why: reason, notes: [], info: [], outputs: [] };
  const t0 = performance.now();
  const proc = Bun.spawn(["bun", join(here, step.script), dir, ...(step.args ?? [])], { stdout: "pipe", stderr: "pipe" });
  const [out, err, code] = await Promise.all([new Response(proc.stdout).text(), new Response(proc.stderr).text(), proc.exited]);
  const lines = `${out}\n${err}`.split("\n").map((l) => l.trimEnd()).filter(Boolean);
  const { flagged, info } = classify(lines);
  const res: StepResult = {
    name: step.name,
    status: "ok",
    seconds: (performance.now() - t0) / 1000,
    notes: flagged,
    info,
    // Scripts print "<path>" or "<path>  (13 pages)" or "<path> (15.1 s)": keep the path.
    outputs: lines.filter((l) => PATHLIKE.test(l)).map((l) => l.replace(/\s+\([^)]*\)\s*$/, "").split(/\s{2,}/)[0]!),
  };
  if (code !== 0) {
    const soft = step.soft?.[code];
    res.status = soft ? "skipped" : "failed";
    res.why = soft ?? `exit ${code}: ${lines[lines.length - 1] ?? "no output"}`;
    // On a real failure the last lines are the explanation; keep them.
    if (!soft) res.notes = lines.slice(-12);
  }
  return res;
}

// Guarded so the test can import classify() without starting a build.
if (import.meta.main) await main(async () => {
  const args = process.argv.slice(2);
  const valued = new Set(["--region", "--skip", "--quality"]);
  const dir = args.find((a, i) => !a.startsWith("--") && !valued.has(args[i - 1] ?? ""));
  if (!dir) throw new ProjectError("usage: bun build.ts <projectDir> [--region NO] [--skip render,pcb] [--quality final]");
  const opt = (name: string): string | undefined => {
    const i = args.indexOf(name);
    return i >= 0 ? args[i + 1] : undefined;
  };
  const skipped = new Set((opt("--skip") ?? "").split(",").filter(Boolean));
  const loaded = await loadProject(dir);
  const { project } = loaded;
  const region = opt("--region") ?? project.sourcing?.region;
  const cased = !!project.enclosure;
  const onBoard = project.build.path !== "wire";
  const by = (name: string, cond: string | null): (() => string | null) => () => (skipped.has(name) ? "skipped on request" : cond);

  // A build must not quietly replace final-quality renders with draft ones: someone
  // rendered them at final on purpose, and the page would ship the noisy version. So
  // without --quality the build keeps whatever quality the last render used.
  let previousQuality: string | undefined;
  try {
    const meta: unknown = await Bun.file(join(loaded.dir, "out", "renders", "render.json")).json();
    if (meta && typeof meta === "object" && "quality" in meta && (meta.quality === "draft" || meta.quality === "final")) previousQuality = meta.quality;
  } catch {
    // No renders yet, or renders made before render.json existed: draft is the default.
  }
  const quality = opt("--quality") ?? previousQuality ?? "draft";
  // Only "final" is worth explaining as kept: saying a draft was "kept from the previous
  // render" read as if this build had not rendered at all.
  const qualityWhy = opt("--quality")
    ? "asked for on the command line"
    : previousQuality === "final"
      ? "rendered again at final because the previous renders were final; pass --quality draft for speed"
      : "the default; pass --quality final before publishing";

  const steps: Step[] = [
    { name: "validate", script: "validate.ts", gate: true },
    { name: "bom", script: "bom.ts" },
    { name: "shopping", script: "shopping.ts", args: region ? ["--region", region] : [] },
    { name: "concept", script: "concept.ts" },
    {
      name: "enclosure",
      script: "enclosure.ts",
      skip: by("enclosure", cased ? null : "the project has no enclosure block"),
      soft: { 3: "CAD packages not installed: run `bun install --cwd scripts`" },
    },
    {
      name: "render",
      script: "render.ts",
      args: ["--quality", quality],
      skip: by("render", cased ? null : "nothing to render without an enclosure"),
      soft: { 3: "Blender not found: the page uses the line drawing and the 3D viewer instead" },
    },
    { name: "drawing", script: "drawing.ts", skip: by("drawing", null) },
    {
      name: "pcb",
      script: "pcb.ts",
      skip: by("pcb", onBoard ? null : "build path is hand-wired, no board"),
      soft: { 3: "tscircuit not installed: run `bun install --cwd scripts`" },
    },
    { name: "firmware", script: "firmware.ts", skip: by("firmware", project.firmware ? null : "the project has no firmware block") },
    {
      // Not optional: a package whose firmware does not compile is not finished. Only a
      // machine without PlatformIO skips it, and the report then says so in words.
      name: "compile",
      script: "compile.ts",
      skip: by("compile", project.firmware ? null : "the project has no firmware block"),
      soft: { 3: "NOT COMPILED: PlatformIO is missing, the framework is not arduino, or the board is not in a family the scaffold builds. The firmware is unchecked; the reason is under Flagged (see compile.ts)" },
    },
    { name: "guide", script: "guide.ts", args: ["--pdf"] },
    { name: "package", script: "package.ts", skip: by("package", project.showcase ? null : "no showcase copy yet (see references/showcase.md)") },
  ];

  const results: StepResult[] = [];
  let stopped = false;
  for (const step of steps) {
    if (stopped) {
      results.push({ name: step.name, status: "skipped", seconds: 0, why: "not run: the electrical check failed", notes: [], info: [], outputs: [] });
      continue;
    }
    const r = await run(step, loaded.dir);
    results.push(r);
    const mark = r.status === "ok" ? "ok  " : r.status === "skipped" ? "skip" : "FAIL";
    console.log(`${mark} ${r.name.padEnd(10)} ${r.status === "ok" ? `${r.seconds.toFixed(1)} s` : (r.why ?? "")}`);
    if (step.gate && r.status === "failed") stopped = true;
  }

  // package.ts repeats the guide's drawing findings, so the same line used to appear
  // twice. A finding is listed once, under the first step that reported it.
  const seen = new Set<string>();
  for (const r of results) {
    if (r.status === "failed") continue; // a failed step's notes are its error tail: keep all of it
    const fresh = (l: string): boolean => {
      const k = l.trim();
      if (seen.has(k)) return false;
      seen.add(k);
      return true;
    };
    r.notes = r.notes.filter(fresh);
    r.info = r.info.filter(fresh);
  }
  const failed = results.filter((r) => r.status === "failed");
  const flagged = results.filter((r) => r.notes.length > 0);
  const informed = results.filter((r) => r.info.length > 0);
  const rendered = results.find((r) => r.name === "render")?.status === "ok";
  const short = (p: string) => (p.startsWith(loaded.dir) ? p.slice(loaded.dir.length + 1) : p);
  const md = [
    `# Build report: ${project.name}`,
    "",
    `Built ${new Date().toISOString().slice(0, 16).replace("T", " ")} UTC from \`project.json\`.`,
    "",
    "| Step | Result | Detail |",
    "| --- | --- | --- |",
    ...results.map((r) => `| ${r.name} | ${r.status} | ${r.status === "ok" ? `${r.seconds.toFixed(1)} s` : (r.why ?? "").replace(/\|/g, "/")} |`),
    "",
    flagged.length ? "## Flagged by the generators" : "## Nothing was flagged",
    "",
    ...flagged.flatMap((r) => [`**${r.name}**`, "", ...r.notes.map((n) => `- ${n.trim()}`), ""]),
    ...(informed.length
      ? [
          "## On record, nothing to fix",
          "",
          "Assumptions the project declares. They are correct only while what they rest on stays true.",
          "",
          ...informed.flatMap((r) => r.info.map((n) => `- ${n.trim()}`)),
          "",
        ]
      : []),
    ...(rendered ? ["## Renders", "", `Quality: ${quality} (${qualityWhy}).`, ""] : []),
    "## Files",
    "",
    ...results.flatMap((r) => r.outputs.map((o) => `- \`${short(o)}\``)),
    "",
    "A clean report means the generators agree with each other. It does not mean the",
    "parts match their part files: print the fit test and check the 1:1 fit sheet first.",
    "",
  ].join("\n");
  await mkdir(join(loaded.dir, "out"), { recursive: true });
  await Bun.write(join(loaded.dir, "out", "build-report.md"), md);

  console.log("");
  if (flagged.length) {
    console.log("Flagged:");
    for (const r of flagged) for (const n of r.notes) console.log(`  ${r.name}: ${n.trim()}`);
  } else {
    console.log("Nothing was flagged.");
  }
  if (informed.length) {
    console.log("\nOn record, nothing to fix:");
    for (const r of informed) for (const n of r.info) console.log(`  ${r.name}: ${n.trim()}`);
  }
  if (rendered) console.log(`\nRenders: ${quality} quality (${qualityWhy}).`);
  console.log(`\n${join(loaded.dir, "out", "build-report.md")}`);
  if (failed.length) {
    console.log(`${failed.length} step(s) failed: ${failed.map((r) => r.name).join(", ")}`);
    process.exit(1);
  }
});
