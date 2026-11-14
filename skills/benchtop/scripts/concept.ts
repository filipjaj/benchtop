#!/usr/bin/env bun
// Concept sheet: one page that lets the user see the thing before any wiring is
// decided. Needs only the parts list (and, for a cased build, the enclosure block);
// connections can still be empty.
//
// Usage: bun concept.ts <projectDir>
// Writes <projectDir>/out/concept.html

import { mkdir } from "node:fs/promises";
import { join } from "node:path";
import { esc } from "./lib/iso";
import { unverifiedNotes, warnUnresolvedGeometry } from "./lib/geometry-evidence";
import { pricing } from "./lib/pricing";
import { loadProject, main } from "./lib/project";
import * as scenes from "./lib/scenes";

// A comparison people can picture. Footprint and height are given separately because
// one volume figure describes a flat tile and a cube equally badly.
function likeness(w: number, d: number, h: number): string {
  const long = Math.max(w, d);
  const short = Math.min(w, d);
  const foot =
    long <= 45
      ? "sits in the palm of a hand"
      : long <= 90 && short <= 58
        ? "smaller than a bank card in footprint"
        : long <= 165 && short <= 80
          ? "about the footprint of a phone"
          : long <= 220 && short <= 150
            ? "about the footprint of a paperback"
            : "larger than a paperback";
  return `${foot}, closed height ${h.toFixed(0)} mm`;
}

await main(async () => {
  const dir = process.argv[2];
  if (!dir) {
    console.error("usage: bun concept.ts <projectDir>");
    process.exit(2);
  }
  const loaded = await loadProject(dir);
  warnUnresolvedGeometry(loaded, "the physical concept illustration");
  const { project } = loaded;
  let closed = "";
  let open = "";
  let back = "";
  let dims = "";
  let warnings: string[] = [];
  if (project.enclosure) {
    const { closedHeight, layoutEnclosure } = await import("./lib/enclosure-layout");
    const L = layoutEnclosure(loaded);
    closed = scenes.closedSvg(L);
    open = scenes.enclosureCloseStep(loaded, L);
    const o = L.outer;
    // The closed height: body plus lid plate, the same number enclosure.ts prints.
    const h = closedHeight(L);
    dims = `${o.w.toFixed(0)} x ${o.d.toFixed(0)} x ${h.toFixed(0)} mm: ${likeness(o.w, o.d, h)}`;
    back = scenes.closedSvg(scenes.turnedLayout(L));
    warnings = [...unverifiedNotes(loaded), ...L.warnings];
  } else {
    closed = scenes.benchSvg(loaded);
  }
  const cost = pricing(loaded);
  // Every part laid out flat, including any that live outside the case on a lead and
  // so appear in neither enclosure view.
  const bench = project.enclosure ? scenes.benchSvg(loaded) : "";
  const rows = loaded.placed
    .map(
      (p) =>
        `<tr><td>${esc(p.use.label ?? p.use.ref)}</td><td>${esc(p.def.name)}</td><td>${esc(p.def.blurb)}</td><td>${esc(cost.priceOf(p.use.ref))}</td></tr>`,
    )
    .join("");
  const html = `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>${esc(project.name)} concept</title><style>
body{margin:0;font:16px/1.5 ui-sans-serif,system-ui,-apple-system,"Helvetica Neue",Arial,sans-serif;background:#f6f6f3;color:#111}
main{max-width:1040px;margin:0 auto;padding:48px 24px 72px}
h1{font-size:clamp(40px,7vw,76px);line-height:.95;letter-spacing:-.035em;margin:0 0 12px;font-weight:800}
.lede{font-size:20px;color:#666;max-width:36em;margin:0 0 36px}
.views{display:grid;grid-template-columns:repeat(auto-fit,minmax(280px,1fr));gap:16px}
figure{margin:0;background:#fff;border:1px solid #e3e2dc;border-radius:22px;padding:24px;aspect-ratio:1/1;display:flex;flex-direction:column}
figure svg{flex:1;min-height:0;width:100%}
figcaption{font-size:13px;color:#777;letter-spacing:.06em;text-transform:uppercase}
.facts{display:flex;gap:10px;flex-wrap:wrap;margin:20px 0 36px}
.facts span{border:1px solid #dddcd5;border-radius:999px;padding:7px 13px;font-size:14px;background:#fff}
table{width:100%;border-collapse:collapse;font-size:15px}td{padding:11px 12px 11px 0;border-top:1px solid #e3e2dc;vertical-align:top}
td:first-child{font-weight:600;white-space:nowrap}td:last-child{text-align:right;white-space:nowrap}td:nth-child(3){color:#666}
.warn{margin:24px 0 0;padding:14px 18px;border:1px solid #111;border-radius:14px;font-size:15px}
@media(max-width:720px){.views{grid-template-columns:1fr}td:nth-child(3){display:none}}
</style></head><body><main>
<h1>${esc(project.name)}</h1><p class="lede">${esc(project.summary || project.tagline)}</p>
<div class="views"><figure><figcaption>${project.enclosure ? "Closed" : "On the bench"}</figcaption>${closed}</figure>${back ? `<figure><figcaption>From behind</figcaption>${back}</figure>` : ""}${open ? `<figure><figcaption>Inside</figcaption>${open}</figure>` : ""}${bench ? `<figure><figcaption>The parts</figcaption>${bench}</figure>` : ""}</div>
<div class="facts">${dims ? `<span>${esc(dims)}</span>` : ""}<span>${loaded.placed.length} parts</span><span>Parts: ${esc(cost.total)}</span><span>${esc(project.power.source.toUpperCase())} power</span></div>
<table>${rows}</table>
${warnings.map((w) => `<p class="warn">${esc(w)}</p>`).join("")}
</main></body></html>`;
  const out = join(loaded.dir, "out");
  await mkdir(out, { recursive: true });
  await Bun.write(join(out, "concept.html"), html);
  console.log(join(out, "concept.html"));
  if (dims) console.log(dims);
  for (const w of warnings) console.log(`warning: ${w}`);
});
