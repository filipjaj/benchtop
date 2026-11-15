#!/usr/bin/env bun
// Builds the illustrated assembly guide: an A4 booklet in the visual language of
// flat-pack furniture instructions, drawn to scale from the project's real parts.
//
// Usage: bun guide.ts <projectDir> [--pdf] [--strict]
// Writes <projectDir>/out/guide/index.html (+ guide.pdf with --pdf, + hero.svg).
//
// Every build runs the drawing check (lib/drawing-check.ts) over the geometry of each
// drawing in the booklet and prints one line per problem: which page and step, which
// part, what cannot be read and what to change. The exit code stays 0 unless --strict
// is given, in which case any problem makes it 1.

import { existsSync } from "node:fs";
import { mkdir, readdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { type Finding, type Names, type Problem, benchOverlapProblems, checkScene, checkWiringStep, dedupe, formatFinding, stepNotes } from "./lib/drawing-check";
import type { EnclosureLayout } from "./lib/enclosure-layout";
import { WIRE_HEX, esc } from "./lib/iso";
import { type Block, type Item, PAGE, PAGE_GAP, flowBlocks, lineMm, linesOf, textMm } from "./lib/page-flow";
import { measurePages, overflowText } from "./lib/page-fit";
import type { PcbLayout } from "./lib/pcb-layout";
import { strictGeometry, warnUnresolvedGeometry } from "./lib/geometry-evidence";
import { JOINTS, JOINT_SEQUENCE, TOOLS, WARNING, WIRE_PREP } from "./lib/pictograms";
import { guessFamily } from "./lib/platform";
import { type Loaded, loadProject, main } from "./lib/project";
import { fileUrl, findChrome } from "./lib/tools";
import * as scenes from "./lib/scenes";
import type { PlacedPart } from "./lib/types";

interface Step {
  art: string;
  caption: string;
  /** Tall drawings get a page to themselves. */
  full?: boolean;
  /** What the drawing shows, for the drawing check's messages. */
  drawing: string;
  /** What the drawing check found in this step's art. */
  problems: Problem[];
  /** What it noted and left as it is: drawings that are right, not defects. */
  notes?: Problem[];
}

export interface Guide {
  html: string;
  hero: string;
  pages: number;
  /** What the builder can act on; --strict fails on any. */
  findings: Finding[];
  /** Information about drawings that are right as they are; never counted. */
  notes: Finding[];
  drawings: number;
}

/** First sentence of a part's geometryEvidence.reason, for the "not verified" notices. */
function unverifiedReason(p: PlacedPart): string {
  const reason = p.def.geometryEvidence?.reason ?? "";
  return reason.split(/(?<=[.!?])\s/)[0] ?? reason;
}

const isUnverified = (p: PlacedPart): boolean => p.def.geometryEvidence?.status === "unresolved";

/** A step's check results split into what fails --strict and what is information. */
function splitProblems(all: Problem[]): { problems: Problem[]; notes: Problem[] } {
  return { problems: all.filter((p) => p.level !== "note"), notes: all.filter((p) => p.level === "note") };
}

const partLabel = (p: PlacedPart): string => p.use.label ?? p.def.name;
const cap = (s: string): string => s.charAt(0).toUpperCase() + s.slice(1);
/**
 * A part label as it reads in the middle of a sentence: "Display" becomes "display",
 * while "LED strip" and "1 kΩ resistor" are left alone. Lower-casing the whole label
 * would turn an ohm sign into a small omega and an abbreviation into a word.
 */
const inSentence = (s: string): string => (/^[A-Z][a-z]/.test(s) ? s.charAt(0).toLowerCase() + s.slice(1) : s);

// ---------------------------------------------------------------------------
// Pages
// ---------------------------------------------------------------------------

function page(body: string, n: number, code: string, cls = ""): string {
  return `<section class="page ${cls}">${body}<footer><span>${n}</span><span>${esc(code)}</span></footer></section>`;
}

/**
 * The cover's second number. It counts what the builder does, once: a soldered wire has two
 * joints, one at each end; a push-on lead is one connection however many ends it has; a
 * carrier board has one joint per pin; a factory-assembled board has parts to press in.
 */
export function coverCount(loaded: Loaded, P: PcbLayout | null): { n: number; label: string } {
  const { build } = loaded.project;
  if (P) {
    return build.path === "pcb-assembled"
      ? { n: P.parts.length, label: "parts to press in" }
      : { n: P.parts.reduce((n, p) => n + p.def.pins.length, 0), label: "solder joints" };
  }
  const wires = loaded.project.connections.length;
  return build.joint === "dupont" ? { n: wires, label: "connections" } : { n: wires * 2, label: "solder joints" };
}

function coverPage(loaded: Loaded, hero: string, count: { n: number; label: string }): string {
  const { project } = loaded;
  const dots = [1, 2, 3].map((i) => `<i class="${i <= project.build.difficulty ? "on" : ""}"></i>`).join("");
  return (
    `<section class="page cover"><h1>${esc(project.name.toUpperCase())}</h1>` +
    `<div class="hero">${hero}</div>` +
    `<div class="facts"><div><b>${project.build.minutes}</b><span>minutes</span></div>` +
    `<div><b>${count.n}</b><span>${count.label}</span></div>` +
    `<div><b class="dots">${dots}</b><span>difficulty</span></div></div>` +
    `<p class="tag">${esc(project.tagline)}</p>` +
    unverifiedCover(loaded) +
    `</section>`
  );
}

/** One line on the cover naming the parts whose layout nobody has verified. */
function unverifiedCover(loaded: Loaded): string {
  const parts = loaded.placed.filter(isUnverified);
  if (!parts.length) return "";
  return `<p class="tag">Layout not verified for ${parts.map((p) => esc(partLabel(p))).join(", ")}. Measure the real part before printing the case.</p>`;
}

function toolsFor(loaded: Loaded): string[] {
  const { build, enclosure, power, firmware } = loaded.project;
  let tools: string[];
  if (build.path === "pcb-assembled") tools = [];
  else if (build.path === "wire" && build.joint === "dupont") tools = ["multimeter"];
  else if (build.path === "wire") tools = ["iron", "solder", "stripper", "cutters", "multimeter"];
  else tools = ["iron", "solder", "cutters", "multimeter"];
  // A USB cable is a tool when the build is powered over USB or the firmware is loaded over it.
  if (power.source === "usb" || firmware) tools.push("usb");
  if (enclosure) tools.push("screwdriver", "printer");
  return tools;
}

function prepPage(loaded: Loaded): string {
  const tools = toolsFor(loaded)
    .map((t) => `<figure>${TOOLS[t]!.svg}<figcaption>${TOOLS[t]!.label}</figcaption></figure>`)
    .join("");
  const soldering = soldersJoints(loaded);
  let html = tools ? `<div class="panel tools">${tools}</div>` : "";
  if (soldering) {
    html +=
      `<div class="panel seq">` +
      JOINT_SEQUENCE.map((s, i) => `<figure><b>${i + 1}</b>${s}</figure>`).join("") +
      `<p>Heat the pad and the pin together for two seconds. Feed solder into the joint, not onto the iron. Take the solder away first, then the iron.</p></div>` +
      `<div class="panel pair"><figure class="ok">${JOINTS.good}<figcaption>A shiny cone that wets both pad and pin</figcaption></figure>` +
      `<figure>${JOINTS.cold}<figcaption>A ball sitting on the pin</figcaption></figure>` +
      `<figure>${JOINTS.starved}<figcaption>Too little solder</figcaption></figure>` +
      `<figure>${JOINTS.bridge}<figcaption>Solder joining two pins</figcaption></figure></div>`;
    if (loaded.project.build.path === "wire") {
      html += `<div class="panel prep">${WIRE_PREP}<p>Strip 3 mm, twist the strands, and tin the end before you solder it to a pad.</p></div>`;
    }
  }
  const work = soldering ? "solder or change a wire" : "change a wire";
  const care = soldering ? " Work on a surface that does not burn, and wash your hands after handling solder." : "";
  html += `<div class="panel warn">${WARNING}<p>${powerOff(loaded)} before you ${work}.${care}</p></div>`;
  return html;
}

/**
 * The inventory: every part drawn 1:1 (so one can be laid on the page to identify it), then
 * the wires, then the printed parts and fasteners. The lists have no fixed length, so they
 * are cut into pages by the size each item will print (lib/page-flow.ts).
 */
function inventoryPages(loaded: Loaded, L: EnclosureLayout | null, names: Names): { pages: string[]; problems: Problem[]; count: number } {
  const problems: Problem[] = [];
  const groups = new Map<string, { part: PlacedPart; refs: string[] }>();
  for (const p of loaded.placed) {
    const key = `${p.def.id}|${p.use.value ?? ""}`;
    if (!groups.has(key)) groups.set(key, { part: p, refs: [] });
    groups.get(key)!.refs.push(p.use.ref);
  }
  const figures: Item[] = [];
  for (const g of groups.values()) {
    const art = scenes.partSvg(g.part);
    for (const found of checkScene(art.geom, names)) problems.push(found);
    const notice = isUnverified(g.part) ? `Layout not verified. Measure yours before printing the case: ${unverifiedReason(g.part)}` : "";
    const name = `${g.refs.length}x ${g.part.def.name}${g.part.use.value ? ` ${g.part.use.value}` : ""}`;
    // The caption can make the figure wider than its drawing; its small lines wrap inside that width.
    const w = Math.min(PAGE.w, Math.max(art.width, textMm(name.length, 9) + 4));
    const smalls = linesOf(g.refs.join(", ").length, 7.5, w) + (notice ? linesOf(notice.length, 7.5, w) : 0);
    const h = art.height + 2 + lineMm(15) + (linesOf(name.length, 9, w) - 1) * lineMm(9) + smalls * lineMm(7.5);
    figures.push({
      w: w + 1.5,
      h,
      html:
        `<figure><div class="art" style="width:${art.width.toFixed(1)}mm">${art.svg}</div>` +
        `<figcaption><b>${g.refs.length}x</b> ${esc(g.part.def.name)}${g.part.use.value ? ` <em>${esc(g.part.use.value)}</em>` : ""}` +
        `<small>${esc(g.refs.join(", "))}</small>${notice ? `<small>${esc(notice)}</small>` : ""}</figcaption></figure>`,
    });
  }
  const blocks: Block[] = [{ open: `<div class="inventory">`, close: `</div>`, items: figures, gapX: 10, gapY: 9, lead: 0 }];
  const supply = (items: Item[]): Block => ({ open: `<div class="wires">`, close: `</div>`, items, gapX: 12, gapY: 6, lead: 6.3 });
  if (loaded.project.build.path === "wire") {
    const counts = new Map<string, number>();
    loaded.project.connections.forEach((c, i) => {
      const col = scenes.wireColor(loaded, c, i);
      counts.set(col, (counts.get(col) ?? 0) + 1);
    });
    blocks.push(
      supply(
        [...counts].map(([col, n]) => {
          const text = `${n}x ${col} wire, 120 mm`;
          return {
            w: Math.max(30, textMm(text.length, 9) + 4) + 1.5,
            h: 1.5 + 2 + lineMm(15),
            html: `<figure><span class="wire" style="--c:${WIRE_HEX[col] ?? col}"></span><figcaption><b>${n}x</b> ${esc(col)} wire, 120 mm</figcaption></figure>`,
          };
        }),
      ),
    );
  }
  if (L) {
    const fig = (qty: number, name: string, use?: string): Item => ({
      w: Math.max(textMm(name.length + 4, 9) + 6, use ? textMm(use.length, 7.5) : 0) + 1.5,
      h: lineMm(15) + (use ? lineMm(7.5) : 0),
      html: `<figure><figcaption><b>${qty}x</b> ${esc(name)}${use ? `<small>${esc(use)}</small>` : ""}</figcaption></figure>`,
    });
    // Fastener names come from the enclosure layout, the same list print.md and the
    // BOM use, so the guide can never ask for a screw the case was not cut for.
    blocks.push(
      supply([
        fig(1, "printed body"),
        fig(1, "printed lid"),
        ...(L.caps?.length ? [fig(L.caps.length, "printed button cap", "caps.stl, one per button")] : []),
        ...L.hardware.map((h) => fig(h.qty, h.name, h.use)),
      ]),
    );
  }
  return { pages: flowBlocks(blocks), problems: dedupe(problems), count: groups.size };
}

/** Captions above the bubbles must print at least this high (about 7.5 pt). */
const MIN_CAPTION_MM = 2.6;

function wiringSteps(loaded: Loaded, names: Names): Step[] {
  const frame = scenes.benchFrame(loaded);
  const used = new Map<string, number>();
  const joint = loaded.project.build.joint === "dupont" ? "Push on" : "Solder";
  // Two steps share a page only while the drawing still prints large enough to read in half of
  // one. A step that ends up alone on its page (its neighbour needs a page of its own, or it is
  // the last) is drawn for a whole page, not left small in the middle of an empty one.
  const arts = loaded.project.connections.map((_, i) => scenes.wiringStepArt(loaded, i, frame));
  const needsPage = (art: ReturnType<typeof scenes.wiringStepArt>): boolean =>
    art.full || scenes.STEP_CAPTION_SIZE * Math.min(scenes.HALF_PAGE.w / art.size.w, scenes.HALF_PAGE.h / art.size.h) < MIN_CAPTION_MM;
  const full = arts.map(needsPage);
  // A step that gets a page of its own is drawn for a whole page, whatever made it need one.
  full.forEach((f, i) => {
    if (f && !arts[i]!.full) arts[i] = scenes.wiringStepArt(loaded, i, frame, true);
  });
  for (let i = 0; i < arts.length; ) {
    if (!full[i] && i + 1 < arts.length && !full[i + 1]) {
      i += 2;
      continue;
    }
    if (!full[i]) {
      arts[i] = scenes.wiringStepArt(loaded, i, frame, true);
      full[i] = true;
    }
    i++;
  }
  return loaded.project.connections.map((c, i) => {
    const art = arts[i]!;
    const [a, b] = art.ends;
    let note = "";
    // A lead that ends on a connector contact is plugged in, whatever the build's joint.
    const plugged = art.ends.some((e) => e.part.def.pins.some((p) => p.plug === true && (p.name === e.pin || (p.aliases ?? []).includes(e.pin))));
    for (const e of plugged ? [] : art.ends) {
      const key = `${e.ref}.${e.pin}`;
      if (used.has(key)) note = `The ${esc(e.pin)} pad on the ${esc(inSentence(partLabel(e.part)))} already holds a wire. Add this one beside it.`;
      used.set(key, i);
    }
    const hex = WIRE_HEX[art.color] ?? art.color;
    const caption =
      `<div class="recipe"><span class="wire" style="--c:${hex}"></span>` +
      `<span class="verb">${plugged ? `Plug in the <b>${esc(art.color)}</b> lead` : `${joint} a <b>${esc(art.color)}</b> wire`}</span>` +
      `<span class="end">${esc(partLabel(a.part))} <b>${esc(a.pin)}</b></span><span class="to"></span>` +
      `<span class="end">${esc(partLabel(b.part))} <b>${esc(b.pin)}</b></span></div>` +
      (c.why ? `<p class="why">${esc(c.why)}</p>` : "") +
      (note ? `<p class="note">${note}</p>` : "") +
      [...new Set(art.ends.filter((e) => isUnverified(e.part)).map((e) => e.ref))]
        .map((ref) => `<p class="note">Layout of the ${esc(inSentence(partLabel(loaded.byRef.get(ref)!)))} not verified. Measure yours before printing the case.</p>`)
        .join("");
    return {
      art: art.svg,
      caption,
      full: full[i]!,
      drawing: `${partLabel(a.part)} ${a.pin} to ${partLabel(b.part)} ${b.pin}`,
      ...splitProblems([...checkWiringStep(art.geom, names), ...stepNotes(art.geom, names)]),
    };
  });
}

function pcbSteps(loaded: Loaded, P: PcbLayout, names: Names): Step[] {
  const verb = loaded.project.build.path === "pcb-assembled" ? "Press" : "Solder";
  return scenes.pcbOrder(P).map((p, i) => {
    const art = scenes.pcbStepArt(P, i);
    return {
      art: art.svg,
      drawing: `${partLabel(p)} onto the board`,
      problems: checkScene(art.geom, names),
      caption:
        `<div class="recipe"><span class="verb">${verb} the <b>${esc(inSentence(partLabel(p)))}</b> into its outline on the board</span></div>` +
        `<p class="why">${p.def.pins.length} pins. ${verb === "Solder" ? "Tack one corner pin, check the part sits flat, then solder the rest." : "Line up every pin before you push."}</p>`,
    };
  });
}

function enclosureSteps(loaded: Loaded, L: EnclosureLayout, names: Names): Step[] {
  // A drawing names the parts it shows hovering, in the order the project lists them.
  const labels = (refs: string[]) => L.parts.filter((p) => refs.includes(p.use.ref)).map((p) => inSentence(partLabel(p)));
  const list = (xs: string[]) => (xs.length > 1 ? `${xs.slice(0, -1).join(", ")} and ${xs[xs.length - 1]}` : (xs[0] ?? ""));
  const lidScrew = L.hardware.find((h) => h.use.startsWith("lid"));
  const steps: Step[] = [];
  // Parts that would overlap on the page are spread over more than one drawing.
  for (const art of scenes.enclosureFloorArts(loaded, L)) {
    steps.push({
      art: art.svg,
      caption: `<div class="recipe"><span class="verb">Lower the <b>${esc(list(labels(art.refs)))}</b> onto the posts in the body</span></div><p class="why">Connectors go toward their openings in the wall.</p>`,
      full: true,
      drawing: `${list(labels(art.refs))} into the body`,
      problems: checkScene(art.geom, names),
    });
  }
  scenes.enclosureLidArts(loaded, L).forEach((art, i) => {
    steps.push({
      art: art.svg,
      caption: `<div class="recipe"><span class="verb">${i === 0 ? "Turn the lid over and seat" : "Seat"} the <b>${esc(list(labels(art.refs)))}</b> face down in it</span></div><p class="why">Each part looks out through its own opening.</p>`,
      full: true,
      drawing: `${list(labels(art.refs))} into the lid`,
      problems: checkScene(art.geom, names),
    });
  });
  const close = scenes.enclosureCloseArt(loaded, L);
  steps.push({
    art: close.svg,
    drawing: "closing the lid",
    problems: checkScene(close.geom, names),
    caption: L.caps?.length
      ? `<div class="recipe"><span class="verb">Set a <b>cap</b> over each button's stem, fold the wires in, lower the lid over the caps${lidScrew ? ` and fit the <b>${lidScrew.qty} ${esc(lidScrew.name)}s</b>` : ""}</span></div><p class="why">Each cap has a hole for its stem and a flange that the lid holds down, so it cannot fall out. Press every button before the last screw: each one must click and spring back. Stop turning as soon as a screw is snug. Printed plastic strips easily.</p>`
      : `<div class="recipe"><span class="verb">Fold the wires in, close the lid${lidScrew ? ` and fit the <b>${lidScrew.qty} ${esc(lidScrew.name)}s</b>` : ""}</span></div><p class="why">Stop turning as soon as a screw is snug. Printed plastic strips easily.</p>`,
    full: true,
  });
  return steps;
}

// ---------------------------------------------------------------------------
// Texts that follow the project: how the joints are made, how it is powered, what is flashed
// ---------------------------------------------------------------------------

/** True when the builder solders: hand-wired with soldered joints, or a carrier board they populate. */
const soldersJoints = (loaded: Loaded): boolean => {
  const { build } = loaded.project;
  if (build.path === "pcb-assembled") return false;
  if (build.path === "wire") return build.joint !== "dupont";
  return true;
};

/** What the builder does to cut power, by what powers the build. */
function powerOff(loaded: Loaded): string {
  switch (loaded.project.power.source) {
    case "usb":
      return "Unplug USB";
    case "lipo":
    case "aa":
      return "Disconnect the battery";
    case "dc-jack":
      return "Unplug the power supply";
  }
}

/** What the builder does to switch it on, by what powers the build. */
function powerOn(loaded: Loaded): string {
  switch (loaded.project.power.source) {
    case "usb":
      return "Plug in the USB cable";
    case "lipo":
    case "aa":
      return "Connect the battery";
    case "dc-jack":
      return "Plug in the power supply";
  }
}

/** The line that loads the firmware, only for a framework this skill generates a flash command for. */
function flashLine(loaded: Loaded): string {
  const fw = loaded.project.firmware;
  if (!fw) return "";
  if (fw.framework === "arduino") {
    // The firmware step writes platformio.ini only for a board family it has a pinned
    // platform for. Where it has run, what it wrote decides; before it has, the board's name does.
    const scaffold = existsSync(join(loaded.dir, "firmware")) ? existsSync(join(loaded.dir, "firmware", "platformio.ini")) : guessFamily(fw.board) !== undefined;
    if (!scaffold) return "";
    // A Pico shows up as a serial port only after its first Arduino upload; before that it needs the boot button.
    const first = guessFamily(fw.board)?.id === "rp2040" ? " The first time, hold BOOTSEL while you plug in the USB cable." : "";
    return `<li><b>Flash the bring-up test.</b> It reports every part it can find before you load the real firmware.${first}<code>pio run -e bringup -t upload &amp;&amp; pio device monitor</code></li>`;
  }
  if (fw.framework === "esphome") {
    return `<li><b>Flash the ESPHome configuration.</b> The log shows which parts it found.<code>esphome run firmware/${esc(loaded.project.slug)}.yaml</code></li>`;
  }
  return "";
}

/**
 * The "Before you switch it on" pages. The table of nets has a row for every net, so it
 * runs over as many pages as it needs: a row is never cut, a table that continues says so
 * and the numbering of the checks carries on.
 */
export function checksPages(loaded: Loaded): string[] {
  const rails = loaded.nets.filter((n) => n.pins.some((p) => p.pin.role === "power-out"));
  const gnd = loaded.nets.find((n) => n.pins.some((p) => p.pin.role === "gnd"));
  const textW = PAGE.w - 6;
  const li = (html: string, chars: number, extra = 0): { html: string; h: number } => ({ html, h: linesOf(chars, 10, textW) * lineMm(10) + extra });
  const gap = 6;
  const cap = PAGE.h - lineMm(15) - PAGE_GAP;

  const first: { html: string; h: number }[] = [];
  const look = soldersJoints(loaded)
    ? "Look. Every joint is a shiny cone. No solder touches a neighbouring pad. No stray strands of wire."
    : loaded.project.build.path === "pcb-assembled"
      ? "Look. Every part sits flat and every pin is in its hole. Nothing touches a neighbouring pin."
      : "Look. Every lead is pushed fully onto its pin. No bare metal touches a neighbouring pin.";
  first.push(li(`<li><b>Look.</b> ${esc(look.replace(/^Look\. /, ""))}</li>`, look.length));
  if (rails.length && gnd) {
    const perRow = Math.max(1, Math.floor((textW + 6) / (36 + 6)));
    const rows = Math.ceil(rails.length / perRow);
    first.push({
      html:
        `<li><b>These must not beep.</b> Set the multimeter to continuity and probe each pair. A beep means a short: find it before you plug in.` +
        `<div class="pairs">${rails.map((r) => `<span><i>${esc(r.name)}</i><i class="x"></i><i>GND</i></span>`).join("")}</div></li>`,
      h: 2 * lineMm(10) + 2 + rows * 11,
    });
  }
  const thW = textMm(Math.max(3, ...loaded.nets.map((n) => n.name.length)), 9) + 5;
  const rowOf = (n: (typeof loaded.nets)[number]): { html: string; h: number } => {
    const cells = n.pins.map((p) => `${partLabel(p.part)} ${p.pin.name}`);
    const chars = cells.reduce((s, c) => s + c.length + 3, 0);
    return {
      html: `<tr><th>${esc(n.name)}</th><td>${n.pins.map((p) => `${esc(partLabel(p.part))} <b>${esc(p.pin.name)}</b>`).join(" &middot; ")}</td></tr>`,
      h: linesOf(chars, 9, textW - thW - 2) * lineMm(9) + 2.6,
    };
  };
  const tail: { html: string; h: number }[] = [];
  tail.push(li(`<li><b>${esc(powerOn(loaded))}.</b> Nothing gets warm, nothing smells. If something does, ${esc(powerOff(loaded).replace(/^./, (c) => c.toLowerCase()))} at once and check the wires against the table above.</li>`, 110));
  const flash = flashLine(loaded);
  // Two lines of text above the command; the boot-button sentence makes it three.
  if (flash) tail.push({ html: flash, h: (flash.includes("BOOTSEL") ? 3 : 2) * lineMm(10) + 2 + lineMm(9) + 4.6 });

  // Lay the checks out page after page.
  const pages: string[] = [];
  let lis: string[] = [];
  let used = 0;
  let numbered = 0;
  let start = 1;
  let rowsOpen: string[] = [];
  const introH = lineMm(10) + 2;
  const closeTable = (): void => {
    if (rowsOpen.length) lis.push(`${lis.pop() ?? ""}<table>${rowsOpen.join("")}</table></li>`);
    rowsOpen = [];
  };
  const newPage = (): void => {
    closeTable();
    pages.push(`<h2>Before you switch it on${pages.length ? " (continued)" : ""}</h2><ol class="checks" start="${start}">${lis.join("")}</ol>`);
    start = numbered + 1;
    lis = [];
    used = 0;
  };
  const addLi = (item: { html: string; h: number }): void => {
    if (lis.length && used + item.h > cap) newPage();
    lis.push(item.html);
    numbered++;
    used += item.h + gap;
  };
  for (const item of first) addLi(item);
  if (loaded.nets.length) {
    const intro = `<li><b>These must beep.</b> Probe the two ends of every connection.`;
    const cont = `<li style="list-style:none"><b>These must beep</b>, continued.`;
    const rows = loaded.nets.map(rowOf);
    if (lis.length && used + introH + rows[0]!.h > cap) newPage();
    lis.push(intro);
    numbered++;
    used += introH;
    for (const r of rows) {
      if (used + r.h > cap && rowsOpen.length) {
        closeTable();
        newPage();
        lis.push(cont);
        // The continued item is not numbered but the browser still counts it, so the list starts at the table's own number.
        start = numbered;
        used = introH;
      }
      rowsOpen.push(r.html);
      used += r.h;
    }
    closeTable();
    used += gap;
  }
  for (const item of tail) addLi(item);
  newPage();
  return pages;
}

// ---------------------------------------------------------------------------
// Document
// ---------------------------------------------------------------------------

const CSS = `
@import url("https://fonts.googleapis.com/css2?family=Noto+Sans:wght@400;600;800&display=swap");
*{box-sizing:border-box}html{background:#e9e9e6}
body{margin:0;font-family:"Noto Sans","Helvetica Neue",Arial,sans-serif;color:#111;font-size:10pt;line-height:1.4}
.page{width:210mm;height:297mm;margin:8mm auto;padding:16mm 18mm 20mm;background:#fff;position:relative;overflow:hidden;box-shadow:0 1mm 6mm rgba(0,0,0,.12);display:flex;flex-direction:column;gap:7mm}
.page footer{position:absolute;left:18mm;right:18mm;bottom:10mm;display:flex;justify-content:space-between;font-size:8pt}
.page footer span:first-child{font-weight:800;font-size:10pt}
svg{display:block;width:100%;height:100%}
h1{font-size:78pt;line-height:.9;font-weight:800;margin:4mm 0 0;letter-spacing:-.02em}
h2{font-size:15pt;font-weight:800;margin:0}
.cover .hero{flex:1;min-height:0;padding:6mm 0}
.cover .facts{display:flex;gap:14mm;border-top:.6mm solid #111;padding-top:5mm}
.cover .facts div{display:flex;flex-direction:column}
.cover .facts b{font-size:26pt;font-weight:800;line-height:1}
.cover .facts span{font-size:8.5pt}
.cover .dots{display:flex;gap:1.6mm;height:26pt;align-items:center}
.cover .dots i{width:5mm;height:5mm;border-radius:50%;border:.5mm solid #111}
.cover .dots i.on{background:#111}
.cover .tag{font-size:12pt;margin:0;max-width:120mm}
.panel{border:.5mm solid #111;border-radius:4mm;padding:6mm 7mm;display:flex;gap:6mm;align-items:center}
.panel p{margin:0;font-size:9.5pt;max-width:95mm}
.panel figure{margin:0;display:flex;flex-direction:column;align-items:center;gap:1.5mm;position:relative}
.panel figcaption{font-size:7.5pt;text-align:center;max-width:26mm;line-height:1.25}
.tools{flex-wrap:wrap;justify-content:flex-start;gap:5mm 8mm}
.tools svg{width:22mm;height:18mm}
.seq svg,.pair svg{width:30mm;height:22mm}
.seq figure b{position:absolute;left:0;top:-1mm;font-size:13pt;font-weight:800}
.pair{justify-content:space-between}
.prep svg{width:74mm;height:19mm;flex:none}
.warn svg{width:13mm;height:12mm;flex:none}
.inventory{display:flex;flex-wrap:wrap;gap:9mm 10mm;align-items:flex-end}
.inventory figure,.wires figure{margin:0;display:flex;flex-direction:column;gap:2mm}
.inventory figcaption,.wires figcaption{font-size:9pt}
.inventory figcaption b,.wires figcaption b{font-size:15pt;font-weight:400;margin-right:1mm}
.inventory small,.wires small{display:block;color:#666;font-size:7.5pt}
.inventory em{font-style:normal;font-weight:600}
.wires{display:flex;flex-wrap:wrap;gap:6mm 12mm;border-top:.3mm solid #111;padding-top:6mm}
.wire{display:block;width:30mm;height:1.5mm;border-radius:1mm;background:var(--c);box-shadow:0 0 0 .3mm #111}
.step{flex:1;min-height:0;display:flex;flex-direction:column;gap:3mm}
.step .num{font-size:40pt;font-weight:800;line-height:.8}
.step .art{flex:1;min-height:0}
.recipe{display:flex;align-items:center;gap:3mm;flex-wrap:wrap;font-size:10.5pt}
.recipe .wire{width:14mm}
.recipe .end{border:.4mm solid #111;border-radius:2mm;padding:.6mm 2.4mm}
.recipe .to{width:7mm;height:.5mm;background:#111;position:relative}
.recipe .to::after{content:"";position:absolute;right:-.2mm;top:-1.1mm;border-left:2.2mm solid #111;border-top:1.35mm solid transparent;border-bottom:1.35mm solid transparent}
.why,.note{margin:0;font-size:9pt;color:#444}
.note{color:#111;font-weight:600}
.checks{margin:0;padding-left:6mm;display:flex;flex-direction:column;gap:6mm;font-size:10pt}
.checks li::marker{font-weight:800;font-size:15pt}
.checks table{border-collapse:collapse;margin-top:2mm;width:100%;font-size:9pt}
.checks th{text-align:left;font-weight:800;padding:1.2mm 4mm 1.2mm 0;white-space:nowrap;vertical-align:top}
.checks td{padding:1.2mm 0;border-bottom:.2mm solid #bbb}
.checks code{display:block;margin-top:2mm;font:9pt ui-monospace,Menlo,monospace;border:.3mm solid #111;border-radius:2mm;padding:2mm 3mm}
.pairs{display:flex;gap:6mm;margin-top:2mm;flex-wrap:wrap}
.pairs span{display:flex;align-items:center;gap:2mm}
.pairs i{font-style:normal;font-weight:800;border:.4mm solid #111;border-radius:2mm;padding:.4mm 2.2mm}
.pairs i.x{border:0;padding:0;width:5mm;height:5mm;background:linear-gradient(45deg,transparent 44%,#111 44%,#111 56%,transparent 56%),linear-gradient(-45deg,transparent 44%,#111 44%,#111 56%,transparent 56%)}
.done .hero{flex:1;min-height:0}
@page{size:A4;margin:0}
@media print{html{background:#fff}.page{margin:0;box-shadow:none;break-after:page}}
@media screen and (max-width:230mm){.page{width:100%;height:auto;min-height:0;margin:0 0 4mm;padding:8mm 5mm 16mm}.step .art{aspect-ratio:4/3}.cover .hero{aspect-ratio:1}h1{font-size:44pt}}
`;

async function tryLayouts(loaded: Loaded): Promise<{ L: EnclosureLayout | null; P: PcbLayout | null }> {
  let L: EnclosureLayout | null = null;
  let P: PcbLayout | null = null;
  if (loaded.project.enclosure) L = (await import("./lib/enclosure-layout")).layoutEnclosure(loaded);
  if (loaded.project.build.path !== "wire") P = (await import("./lib/pcb-layout")).layoutPcb(loaded);
  return { L, P };
}

/** How the drawing check names parts and part files for this project. */
async function namesFor(loaded: Loaded): Promise<Names> {
  let local: string[] = [];
  try {
    local = await readdir(join(loaded.dir, "parts"));
  } catch {
    // No project-local parts folder: every part comes from the library.
  }
  return {
    label: (ref) => {
      const p = loaded.byRef.get(ref);
      return p ? partLabel(p) : ref;
    },
    file: (ref) => {
      const id = loaded.byRef.get(ref)?.def.id;
      if (!id) return `the part file of "${ref}"`;
      return local.includes(`${id}.json`) ? `parts/${id}.json` : `a copy of assets/parts/${id}.json in the project's parts/ folder`;
    },
  };
}

/**
 * Preserve useful planning output when an exact physical layout is unresolved.
 * None of the legacy XY values of those parts may reach a cover, wiring inset,
 * fitted enclosure or scale drawing. This is a logical plan, not assembly guidance.
 */
async function partialGuide(loaded: Loaded): Promise<Guide> {
  const names = await namesFor(loaded);
  const code = `${loaded.project.slug.toUpperCase()}-PARTIAL`;
  const hero = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 160 35" role="img" aria-label="Physical layout unresolved">` +
    `<rect x="1" y="1" width="158" height="33" fill="#fff" stroke="#777" stroke-dasharray="2 2"/>` +
    `<text x="80" y="15" text-anchor="middle" font-family="Arial,sans-serif" font-size="5">Physical layout unresolved</text>` +
    `<text x="80" y="25" text-anchor="middle" font-family="Arial,sans-serif" font-size="3.5">No physical pin positions or fit are asserted</text></svg>`;
  const pages = [page(`<h2>${esc(loaded.project.name)} — partial planning guide</h2><div>${hero}</div>` +
    `<p>The exact physical layout of one or more parts is unresolved. This package retains the inventory and logical connection names. Physical wiring pictures, solder locations, fitted enclosure views and assembly steps are withheld.</p>` +
    `<p>Use the exact module's source pinout and confirm its dimensions and pad positions before assembly or fabrication. The connection list below is a plan; it does not establish electrical correctness.</p>`, 1, code)];
  const findings: Finding[] = [];
  let drawings = 0;
  for (const p of loaded.placed) {
    const evidence = p.def.geometryEvidence;
    const unresolved = evidence?.status === "unresolved";
    const number = pages.length + 1;
    let body = `<h2>Inventory — ${esc(partLabel(p))}</h2><p>${esc(p.use.ref)} · ${esc(p.def.name)}</p>`;
    if (unresolved) {
      body += `<div class="unresolved-part">${hero}<p><b>Pin layout unresolved — use source pinout</b></p></div>` +
        `<p>${esc(evidence.reason)}</p>` +
        (evidence.unknown.length ? `<p>Still unknown: ${evidence.unknown.map(esc).join(", ")}.</p>` : "");
      findings.push({ check: "geometry-unresolved", part: p.use.ref, page: number, drawing: "inventory and physical guidance",
        what: `the exact physical layout of ${partLabel(p)} is unresolved; its physical drawing and the project's assembly guidance are withheld.`,
        fix: `Establish the exact module's source pinout and measured or documented geometry in ${names.file(p.use.ref)} before generating physical assembly instructions.` });
    } else {
      const art = scenes.partSvg(p);
      body += `<div style="width:${art.width.toFixed(1)}mm;max-width:100%">${art.svg}</div><p>This individual part illustration does not establish the unresolved project's fit.</p>`;
      drawings++;
      for (const problem of checkScene(art.geom, names)) findings.push({ ...problem, page: number, drawing: "inventory" });
    }
    pages.push(page(body, number, code));
  }
  for (let start = 0; start < loaded.project.connections.length; start += 12) {
    const rows = loaded.project.connections.slice(start, start + 12).map((c, i) =>
      `<tr><td>${start + i + 1}</td><td>${esc(c.from)}</td><td>${esc(c.to)}</td></tr>`).join("");
    pages.push(page(`<h2>Logical connection plan</h2><p>Names only. No physical pad coordinates or solder locations are asserted.</p>` +
      `<table class="logical-connections"><thead><tr><th>Step</th><th>From</th><th>To</th></tr></thead><tbody>${rows}</tbody></table>`, pages.length + 1, code));
  }
  const html = `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">` +
    `<title>${esc(loaded.project.name)} partial planning guide</title><style>${CSS}.page svg{height:auto}.logical-connections{border-collapse:collapse;width:100%;table-layout:fixed}.logical-connections th,.logical-connections td{padding:3mm;border-bottom:.2mm solid #bbb;text-align:left;overflow-wrap:anywhere}.logical-connections th:first-child{width:14mm}.unresolved-part{border:.4mm dashed #777;padding:5mm}</style></head><body>` +
    pages.join("") + `<script>{const o=new URLSearchParams(location.search).get("only");if(o)document.querySelectorAll(".page").forEach((p,i)=>{if(String(i+1)!==o)p.remove()})}</script></body></html>`;
  return { html, hero, pages: pages.length, findings, notes: [], drawings };
}

export async function buildGuide(loaded: Loaded): Promise<Guide> {
  // Default: build the whole guide and mark the unverified parts. Strict geometry keeps the
  // old behaviour of withholding the physical drawings.
  if (strictGeometry() && loaded.placed.some(isUnverified)) return partialGuide(loaded);
  const { project } = loaded;
  const { L, P } = await tryLayouts(loaded);
  const names = await namesFor(loaded);
  const code = `${project.slug.toUpperCase()}-${project.build.path.toUpperCase()}-1`;
  const heroArt = L ? scenes.closedArt(L) : P ? scenes.pcbDoneArt(P) : scenes.benchArt(loaded);
  const hero = heroArt.svg;
  const count = coverCount(loaded, P);

  const steps: Step[] = [...(P ? pcbSteps(loaded, P, names) : wiringSteps(loaded, names)), ...(L ? enclosureSteps(loaded, L, names) : [])];
  const inventory = inventoryPages(loaded, L, names);
  // Every problem the drawing check finds, tagged with the page it is printed on.
  const findings: Finding[] = [];
  const notes: Finding[] = [];
  const report = (pageNo: number, drawing: string, problems: Problem[], step?: number, extra: Problem[] = []): void => {
    for (const found of [...problems, ...extra]) (found.level === "note" ? notes : findings).push({ ...found, page: pageNo, step, drawing });
  };
  report(1, "the finished object on the cover", withTurns(checkScene(heroArt.geom, names), loaded, names));
  report(1, "the bench layout", benchOverlapProblems(loaded.placed, names));

  const pages: string[] = [coverPage(loaded, hero, count)];
  let n = 2;
  pages.push(page(prepPage(loaded), n++, code));
  report(n, "inventory", inventory.problems);
  for (const html of inventory.pages) pages.push(page(html, n++, code));
  // Two steps to a page; a step flagged `full` takes a page alone.
  let i = 0;
  while (i < steps.length) {
    const first = steps[i]!;
    const pair = !first.full && steps[i + 1] && !steps[i + 1]!.full ? [first, steps[i + 1]!] : [first];
    const body = pair
      .map((s, k) => `<div class="step"><div class="num">${i + k + 1}</div><div class="art">${s.art}</div>${s.caption}</div>`)
      .join("");
    pair.forEach((s, k) => report(n, s.drawing, s.problems, i + k + 1, s.notes));
    pages.push(page(body, n++, code));
    i += pair.length;
  }
  for (const body of checksPages(loaded)) pages.push(page(body, n++, code));
  pages.push(
    page(
      `<h2>${esc(cap(project.name))} is built</h2><div class="hero">${hero}</div><p class="tag">${esc(project.summary)}</p>`,
      n++,
      code,
      "done",
    ),
  );
  const html =
    `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">` +
    `<title>${esc(project.name)} assembly guide</title><style>${CSS}</style></head><body>` +
    pages.join("") +
    // index.html?only=3 shows page 3 alone, which is how shoot.ts captures one page per image.
    `<script>{const o=new URLSearchParams(location.search).get("only");if(o)document.querySelectorAll(".page").forEach((p,i)=>{if(String(i+1)!==o)p.remove()})}</script>` +
    `</body></html>`;
  return { html, hero, pages: pages.length, findings, notes, drawings: steps.length + 1 + inventory.count };
}

/**
 * A pad hidden in the cover's view of the bench gets a message that names the turn that
 * shows it (as the `bench` value to write), or says that no turn does and the steps draw
 * it through the part, which is a note.
 */
function withTurns(problems: Problem[], loaded: Loaded, names: Names): Problem[] {
  if (!problems.some((p) => p.check === "wire-end-hidden")) return problems;
  const explained = scenes.explainBench(loaded);
  return problems.map((p) => {
    if (p.check !== "wire-end-hidden" || !p.part || !p.pin) return p;
    const part = explained.find((e) => e.ref === p.part);
    // A turn counts only if it hides fewer of the part's wired pads than now and shows this one.
    const turn = part?.turns.find((t) => t.degrees !== 0 && !t.overlaps && !t.hidden.includes(p.pin!) && t.hidden.length < part.hides.length);
    if (turn) {
      return { ...p, fix: `Turn the part ${turn.degrees} degrees: set "bench": { "x": ${turn.bench.x}, "y": ${turn.bench.y}, "rot": ${turn.bench.rot} } on part "${p.part}" in project.json; that shows the pad. If the real lead leaves the body lower down than its top face, give pin "${p.pin}" a "z" in ${names.file(p.part)}.` };
    }
    return { ...p, level: "note", fix: `Nothing to fix: no turn of part "${p.part}" shows this pad, and each step draws it through the part.` };
  });
}

/**
 * `--explain`: the bench as the booklet draws it, in the numbers a project writes. Each
 * part gets a paste-ready `bench` value that reproduces the drawing exactly, the wired
 * pads it hides and behind what, and what each turn about its own centre would do.
 */
export function explainLines(loaded: Loaded): string[] {
  const out = [
    "bench: x and y are millimetres from the bench origin (0, 0) to the top-left corner of the part's outline AFTER the turn, seen from above (x to the right, y away from you).",
    "rot is the part's turn, clockwise seen from above: 0, 90, 180 or 270 degrees. Paste a line into the part's entry in project.json to pin the drawing exactly as shown.",
    "",
  ];
  const b = (v: { x: number; y: number; rot: number }): string => `"bench": { "x": ${v.x}, "y": ${v.y}, "rot": ${v.rot} }`;
  for (const e of scenes.explainBench(loaded)) {
    out.push(`${e.ref} (${e.part})  ${b(e.bench)}`);
    if (!e.hides.length) out.push("  hides no wired pad");
    for (const h of e.hides) out.push(`  pad ${h.pin} is behind ${h.by.join(", ")}`);
    if (e.hides.length) {
      for (const t of e.turns.filter((x) => x.degrees !== 0)) {
        out.push(`  turn ${t.degrees}: ${b(t.bench)}  hides ${t.hides}${t.overlaps ? " (overlaps another part: move it too)" : ""}`);
      }
    }
  }
  return out;
}

async function printPdf(htmlPath: string, pdfPath: string): Promise<boolean> {
  await rm(pdfPath, { force: true });
  const chrome = await findChrome();
  if (!chrome) return false;
  const proc = Bun.spawn(
    [chrome, "--headless=new", "--disable-gpu", `--user-data-dir=${join(tmpdir(), `benchtop-chrome-${process.pid}`)}`, "--no-pdf-header-footer", "--virtual-time-budget=4000", `--print-to-pdf=${pdfPath}`, fileUrl(htmlPath)],
    { stdout: "ignore", stderr: "ignore" },
  );
  // Chrome sometimes exits non-zero after writing a good file, or lingers after it;
  // the file is the evidence, not the exit code.
  const timer = setTimeout(() => proc.kill(), 60_000);
  await proc.exited;
  clearTimeout(timer);
  const made = Bun.file(pdfPath);
  return (await made.exists()) && made.size > 1000;
}

if (import.meta.main) {
  await main(async () => {
    const dir = process.argv[2];
    if (!dir) {
      console.error("usage: bun guide.ts <projectDir> [--pdf] [--strict]");
      process.exit(2);
    }
    const loaded = await loadProject(dir);
    if (process.argv.includes("--explain")) {
      // Writes nothing: what each part's bench value is now, what it hides, and what a turn would do.
      for (const line of explainLines(loaded)) console.log(line);
      return;
    }
    // One warning for unverified geometry (not a drawing finding); the notices in the guide say the rest.
    if (!strictGeometry()) warnUnresolvedGeometry(loaded, "the guide");
    const out = join(loaded.dir, "out", "guide");
    await mkdir(out, { recursive: true });
    const { html, hero, pages, findings, notes, drawings } = await buildGuide(loaded);
    await Bun.write(join(out, "index.html"), html);
    await Bun.write(join(out, "hero.svg"), hero);
    console.log(`${join(out, "index.html")}  (${pages} pages)`);
    console.log(join(out, "hero.svg"));
    if (process.argv.includes("--pdf")) {
      const pdf = join(out, "guide.pdf");
      if (await printPdf(join(out, "index.html"), pdf)) console.log(pdf);
      else console.log("pdf skipped: no Chrome, Chromium or Edge found. Open index.html and print to PDF instead.");
    }
    // Measure every page in a real browser: a page taller than its box cuts content off with no
    // other trace. Without a browser there is nothing to measure with, and that is said, not hidden.
    const fit = await measurePages(html);
    if (fit === null) {
      console.log("warning: the pages were not measured for overflow (no Chrome, Chromium or Edge found); lists are paginated by estimated sizes. Open the pages to check them.");
    } else {
      for (const o of fit) {
        findings.push({
          check: "page-overflow",
          page: o.page,
          drawing: "page layout",
          what: overflowText(o),
          fix: "This is a fault in the guide's page layout, not in the project: report it with the project folder. Until it is fixed, split the list by hand or print the page and check what is missing.",
        });
      }
    }
    // One line per problem, then one line of summary, so a log reads the same as a terminal.
    for (const found of findings) console.log(formatFinding(found));
    console.log(
      findings.length
        ? `drawing check: ${findings.length} problem${findings.length > 1 ? "s" : ""} in ${drawings} drawings. Each line above names the page, the part and the change that fixes it.`
        : `drawing check: ${drawings} drawings, no problems.`,
    );
    // Notes are drawings that are right as they stand. They are never counted and never fail --strict.
    if (notes.length) {
      // Neighbour names left out of a bubble are common; they are counted, and listed with --notes.
      const names = notes.filter((n) => n.check === "label-missing");
      for (const n of notes.filter((x) => x.check !== "label-missing" || process.argv.includes("--notes"))) console.log(`note: ${formatFinding(n).replace(/^drawing: /, "")}`);
      console.log(
        `notes: ${notes.length - names.length} drawn through a part or between neighbouring pads, ${names.length} bubbles that do not name every neighbouring pad (--notes lists them). Nothing to fix.`,
      );
    }
    if (findings.length && process.argv.includes("--strict")) process.exit(1);
  });
}
