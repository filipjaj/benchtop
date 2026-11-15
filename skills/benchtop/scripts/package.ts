#!/usr/bin/env bun
// Assembles the finished package: a folder (and a zip of it) holding the landing
// page, the guide, and every file needed to build the project.
//
// Usage: bun package.ts <projectDir> [--no-zip]
// Reads whatever the earlier steps left in <projectDir>/out and <projectDir>/firmware,
// and writes <projectDir>/dist/<slug>/ plus <projectDir>/dist/<slug>.zip.
// The landing page only links to files that actually exist.

import { cp, mkdir, readdir, rm, stat } from "node:fs/promises";
import { join } from "node:path";
import { buildGuide } from "./guide";
import { type EnclosureLayout, closedHeight } from "./lib/enclosure-layout";
import { warnUnresolvedGeometry } from "./lib/geometry-evidence";
import { type Loaded, ProjectError, loadProject, main } from "./lib/project";
import * as scenes from "./lib/scenes";
import { formatFinding } from "./lib/drawing-check";
import { pricing } from "./lib/pricing";
import { buildShopping } from "./shopping";
import { type Download, type SiteContext, renderSite } from "./lib/site";
import { zipCommand } from "./lib/tools";
import type { PlacedPart } from "./lib/types";

const exists = async (p: string): Promise<boolean> => !!(await stat(p).catch(() => null));

function requireShowcase(loaded: Loaded): void {
  const s = loaded.project.showcase;
  const missing: string[] = [];
  if (!s) missing.push("showcase");
  else {
    if (!s.headline) missing.push("showcase.headline");
    if (!s.subhead) missing.push("showcase.subhead");
    if ((s.howItWorks?.length ?? 0) < 3) missing.push("showcase.howItWorks (3 steps)");
    if ((s.features?.length ?? 0) < 3) missing.push("showcase.features (3 or 6)");
    if (!s.theme?.mood || !s.theme.accent || !s.theme.display || !s.theme.text) missing.push("showcase.theme");
  }
  if (missing.length) {
    throw new ProjectError(
      `project.json is missing ${missing.join(", ")}. Write the showcase copy first: see references/showcase.md.`,
    );
  }
}

function partCards(loaded: Loaded, priceOf: (ref: string) => string): SiteContext["parts"] {
  const groups = new Map<string, { part: PlacedPart; qty: number }>();
  for (const p of loaded.placed) {
    const g = groups.get(p.def.id);
    if (g) g.qty++;
    else groups.set(p.def.id, { part: p, qty: 1 });
  }
  return [...groups.values()].map((g) => ({
    svg: scenes.partSvg(g.part).svg,
    name: g.part.use.label ?? g.part.def.name,
    qty: g.qty,
    blurb: g.part.def.blurb,
    price: priceOf(g.part.use.ref),
  }));
}

await main(async () => {
  const dir = process.argv[2];
  if (!dir) {
    console.error("usage: bun package.ts <projectDir> [--no-zip]");
    process.exit(2);
  }
  const loaded = await loadProject(dir);
  // A previous run may have left physical drawings, PDFs, meshes or renders in
  // out/. Never repackage those as current evidence for an unresolved variant.
  // Refuse before deleting or writing dist; guide.ts and bom.ts remain available
  // for an explicitly partial planning handoff.
  warnUnresolvedGeometry(loaded, "the complete physical showcase package");
  requireShowcase(loaded);
  const { project } = loaded;
  const out = join(loaded.dir, "out");
  const dist = join(loaded.dir, "dist", project.slug);
  await rm(dist, { recursive: true, force: true });
  await mkdir(join(dist, "files"), { recursive: true });

  const downloads: Download[] = [];
  const add = (label: string, detail: string, href: string, kind: string) => downloads.push({ label, detail, href, kind });

  // Guide: always rebuilt, so the package can never ship a guide older than project.json.
  const guide = await buildGuide(loaded);
  // The package ships this guide, so its drawing problems are reported here too.
  for (const found of guide.findings) console.log(formatFinding(found));
  await mkdir(join(dist, "guide"), { recursive: true });
  await Bun.write(join(dist, "guide", "index.html"), guide.html);
  add("Assembly guide", `${guide.pages} illustrated pages, drawn to scale`, "guide/index.html", "html");
  if (await exists(join(out, "guide", "guide.pdf"))) {
    await cp(join(out, "guide", "guide.pdf"), join(dist, "guide", "guide.pdf"));
    add("Assembly guide, printable", "A4 PDF", "guide/guide.pdf", "pdf");
  }

  if (await exists(join(out, "bom.csv"))) {
    await cp(join(out, "bom.csv"), join(dist, "files", "bom.csv"));
    if (await exists(join(out, "bom.md"))) await cp(join(out, "bom.md"), join(dist, "files", "bom.md"));
    add("Parts list", "Every part with a search term and a price", "files/bom.csv", "csv");
  }

  // Shopping page: always rebuilt, like the guide, so it matches project.json.
  await mkdir(join(dist, "shopping"), { recursive: true });
  await Bun.write(join(dist, "shopping", "index.html"), await buildShopping(loaded, project.sourcing?.region ?? "ALL"));
  add("Shopping list", "Every part with what to check and shop searches", "shopping/index.html", "html");

  let layout: EnclosureLayout | null = null;
  let model: string | undefined;
  const enc = join(out, "enclosure");
  if (await exists(enc)) {
    await cp(enc, join(dist, "files", "enclosure"), { recursive: true });
    if (await exists(join(enc, `${project.slug}.3mf`))) {
      const hasCaps = await exists(join(enc, "caps.stl"));
      add("Enclosure, ready to slice", hasCaps ? "3MF with body, lid and button caps on one plate" : "3MF with body and lid on one plate", `files/enclosure/${project.slug}.3mf`, "3mf");
    }
    if (await exists(join(enc, "fit-test.3mf"))) {
      add("Fit test, print this first", "Two thin pieces that show in minutes whether your parts fit", "files/enclosure/fit-test.3mf", "3mf");
    }
    if (await exists(join(enc, "body.stl"))) add("Enclosure body", "STL", "files/enclosure/body.stl", "stl");
    if (await exists(join(enc, "lid.stl"))) add("Enclosure lid", "STL", "files/enclosure/lid.stl", "stl");
    if (await exists(join(enc, "caps.stl"))) add("Button caps", "STL, all caps on one plate", "files/enclosure/caps.stl", "stl");
    if (await exists(join(enc, "assembly.glb"))) model = "files/enclosure/assembly.glb";
  }

  // Rendered images and drawing sheets, when those steps have been run.
  const renders: NonNullable<SiteContext["renders"]> = {};
  const rdir = join(out, "renders");
  if (await exists(rdir)) {
    await cp(rdir, join(dist, "files", "renders"), { recursive: true });
    if (await exists(join(rdir, "hero-alpha.png"))) renders.hero = "files/renders/hero-alpha.png";
    else if (await exists(join(rdir, "hero.png"))) renders.hero = "files/renders/hero.png";
    if (await exists(join(rdir, "exploded.png"))) renders.exploded = "files/renders/exploded.png";
    if (await exists(join(rdir, "top.png"))) renders.top = "files/renders/top.png";
    if (await exists(join(rdir, "hero.png"))) add("Renders", "Closed, opened up and from above, PNG", "files/renders/hero.png", "png");
  }
  const drawings: NonNullable<SiteContext["drawings"]> = {};
  const ddir = join(out, "drawings");
  if (await exists(ddir)) {
    await cp(ddir, join(dist, "files", "drawings"), { recursive: true });
    if (await exists(join(ddir, "wiring.svg"))) drawings.wiring = "files/drawings/wiring.svg";
    if (await exists(join(ddir, "wiring-legend.svg"))) drawings.wiringLegend = "files/drawings/wiring-legend.svg";
    const drawingFiles = await readdir(ddir);
    const sheetsOf = (re: RegExp): string[] => drawingFiles.filter((n) => re.test(n)).sort((a, b) => a.localeCompare(b, undefined, { numeric: true })).map((n) => `files/drawings/${n}`);
    drawings.wiringMore = sheetsOf(/^wiring-\d+\.svg$/);
    drawings.wiringLegendMore = sheetsOf(/^wiring-legend-\d+\.svg$/);
    if (await exists(join(ddir, "enclosure.svg"))) drawings.enclosure = "files/drawings/enclosure.svg";
    if (await exists(join(ddir, "index.html"))) add("Drawings", "Wiring plan, dimensioned case drawing and pin map", "files/drawings/index.html", "svg");
  }
  if (project.enclosure) layout = (await import("./lib/enclosure-layout")).layoutEnclosure(loaded);

  const pcb = join(out, "pcb");
  if (await exists(pcb)) {
    await cp(pcb, join(dist, "files", "pcb"), { recursive: true });
    if (await exists(join(pcb, "gerbers.zip"))) add("PCB fabrication files", "Gerbers, drill, BOM and placement for JLCPCB", "files/pcb/gerbers.zip", "zip");
    if (await exists(join(pcb, "schematic.svg"))) add("Schematic", "SVG", "files/pcb/schematic.svg", "svg");
  }

  const fw = join(loaded.dir, "firmware");
  if (await exists(fw)) {
    await cp(fw, join(dist, "files", "firmware"), {
      recursive: true,
      // Build output and downloaded libraries are large and machine-specific.
      // Build products and compile logs (which hold this machine's paths) stay out of the package.
      filter: (src) => !src.includes("/.pio") && !/\/compile-[^/]+\.log$/.test(src),
    });
    add("Firmware", "PlatformIO project with a bring-up test", "files/firmware/platformio.ini", "pio");
  }
  await cp(join(loaded.dir, "project.json"), join(dist, "files", "project.json"));
  // project.json names parts by id. A part that lives in the project, not in the skill's
  // library, has to travel with it, or the packaged project cannot be rebuilt by anyone else.
  const projectParts = join(loaded.dir, "parts");
  // A folder, so it is listed in the README, not as a download button on the page.
  let hasProjectParts = false;
  if (await exists(projectParts)) {
    await cp(projectParts, join(dist, "files", "parts"), { recursive: true });
    hasProjectParts = true;
  }

  const steps = project.build.path === "wire"
    ? (() => {
        const frame = scenes.benchFrame(loaded);
        return project.connections.slice(0, 3).map((_, i) => scenes.wiringStepArt(loaded, i, frame).svg);
      })()
    : await (async () => {
        const P = (await import("./lib/pcb-layout")).layoutPcb(loaded);
        return scenes
          .pcbOrder(P)
          .slice(0, 3)
          .map((_, i) => scenes.pcbStepSvg(P, i));
      })();

  const cost = pricing(loaded);
  const zipName = `${project.slug}.zip`;
  const zipPath = join(loaded.dir, "dist", zipName);
  const zipCmd = process.argv.includes("--no-zip") ? null : zipCommand(zipPath, project.slug);
  const wantZip = !!zipCmd;
  const ctx: SiteContext = {
    hero: guide.hero,
    model,
    renders,
    drawings,
    steps,
    parts: partCards(loaded, cost.priceOf),
    downloads,
    guideHref: "guide/index.html",
    shoppingHref: "shopping/index.html",
    zipHref: wantZip ? zipName : undefined,
    // Closed size, lid included: the figure someone holding the object would measure.
    dims: layout ? { w: layout.outer.w, d: layout.outer.d, h: closedHeight(layout) } : undefined,
    total: cost.total,
  };
  await Bun.write(join(dist, "index.html"), renderSite(loaded, ctx));

  const lines = [
    `# ${project.name}`,
    "",
    project.summary,
    "",
    "Open `index.html` for the overview, or go straight to `guide/index.html` to build it.",
    "",
    "| File | What it is |",
    "| --- | --- |",
    ...downloads.map((d) => `| \`${d.href}\` | ${d.label}: ${d.detail} |`),
    "| `files/project.json` | The source of truth every other file was generated from |",
    ...(hasProjectParts ? ["| `files/parts/` | Definitions of the parts this project adds or corrects; keep this folder next to `project.json` when rebuilding |"] : []),
    "",
  ];
  await Bun.write(join(dist, "README.md"), lines.join("\n"));

  if (zipCmd) {
    await rm(zipPath, { force: true });
    const proc = Bun.spawn(zipCmd, { cwd: join(loaded.dir, "dist"), stdout: "ignore", stderr: "inherit" });
    if ((await proc.exited) === 0) {
      // The page links to the zip as a sibling so the folder works when served as a site root.
      await cp(zipPath, join(dist, zipName));
      console.log(zipPath);
    }
  } else if (!process.argv.includes("--no-zip")) {
    console.log("zip skipped: no `zip` command (or Windows tar) found. The folder is complete without it.");
  }
  console.log(join(dist, "index.html"));
  console.log(`${downloads.length} downloads linked: ${downloads.map((d) => d.kind).join(", ")}`);
});
