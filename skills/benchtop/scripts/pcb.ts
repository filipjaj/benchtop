// Carrier-PCB generator: lays the project's parts out on a 2-layer board, writes a
// tscircuit board file, and exports fabrication files with the pinned tscircuit CLI.
//
//   bun pcb.ts <projectDir> [--no-export]
//
// Writes <projectDir>/pcb/board.tsx (readable, meant to be edited by hand for anything
// the generator does not cover) and, unless --no-export, <projectDir>/out/pcb/*.
// Exit codes: 0 ok, 2 project error, 3 tscircuit not installed, 4 an export failed.

import { assertResolvedGeometry } from "./lib/geometry-evidence";
import { existsSync } from "node:fs";
import { mkdir } from "node:fs/promises";
import { join, resolve } from "node:path";
import { layoutPcb, type PcbLayout } from "./lib/pcb-layout";
import { rotPoint } from "./lib/iso";
import { loadProject, main, type Loaded, type Net } from "./lib/project";
import type { PlacedPart } from "./lib/types";

const SCRIPTS_DIR = import.meta.dir;
const TSCI = join(SCRIPTS_DIR, "node_modules", "tscircuit", "cli.mjs");
export const TSCIRCUIT_VERSION = "0.0.3168";

const POWER_MM = 0.5;
const SIGNAL_MM = 0.25;

// ---------------------------------------------------------------------------
// board.tsx
// ---------------------------------------------------------------------------

/** Number to at most three decimals, no trailing zeros, no "-0". */
const n = (v: number): string => {
  const r = Math.round(v * 1000) / 1000;
  return (Object.is(r, -0) ? 0 : r).toString();
};

/** tscircuit pin labels must be valid identifiers: letters, digits, underscore, not starting with a digit. */
function labelFor(name: string, taken: Set<string>): string {
  let l = name.replace(/\+/g, "plus").replace(/-/g, "minus").replace(/[^A-Za-z0-9_]/g, "_");
  if (/^[0-9]/.test(l)) l = `P${l}`;
  let out = l;
  for (let i = 2; taken.has(out); i++) out = `${l}_${i}`;
  taken.add(out);
  return out;
}

const refName = (ref: string): string => ref.replace(/[^A-Za-z0-9_]/g, "_");

interface Frame {
  /** Board centre, so board coordinates (origin top-left, y down) become tscircuit's (origin centre, y up). */
  cx: number;
  cy: number;
}

const toPcb = (f: Frame, x: number, y: number): [number, number] => [x - f.cx, f.cy - y];

interface PadInfo {
  pinIndex: number;
  name: string;
  /** Text printed next to the pad. */
  shown: string;
  /** Offset from the part centre in tscircuit orientation (y up). */
  dx: number;
  dy: number;
  /** World position in board coordinates (y down), for chaining traces. */
  wx: number;
  wy: number;
  edge: "top" | "bottom" | "left" | "right";
}

function padsOf(p: PlacedPart): { pads: PadInfo[]; w: number; d: number } {
  const swap = p.at.rot === 90 || p.at.rot === 270;
  const w = swap ? p.def.body.d : p.def.body.w;
  const d = swap ? p.def.body.w : p.def.body.d;
  const pads = p.def.pins.map((pin, i): PadInfo => {
    // Boards that print bare GPIO numbers are labelled with their GPIO alias.
    const shown = /^[0-9]+$/.test(pin.name) ? (pin.aliases?.find((a) => /[A-Za-z]/.test(a)) ?? pin.name) : pin.name;
    const [x, y] = rotPoint(pin.x, pin.y, p.def.body.w, p.def.body.d, p.at.rot);
    const edges: [number, PadInfo["edge"]][] = [
      [y, "top"],
      [d - y, "bottom"],
      [x, "left"],
      [w - x, "right"],
    ];
    edges.sort((a, b) => a[0] - b[0]);
    return { pinIndex: i + 1, name: pin.name, shown, dx: x - w / 2, dy: d / 2 - y, wx: p.at.x + x, wy: p.at.y + y, edge: edges[0]![1] };
  });
  return { pads, w, d };
}

function holeSizes(p: PlacedPart): { hole: number; outer: number } {
  if (p.def.id.endsWith("-wirepads")) return { hole: 1.1, outer: 2 };
  const pitch = p.def.footprint?.pitch ?? 2.54;
  return pitch <= 1.5 ? { hole: 0.7, outer: 1.2 } : { hole: 1, outer: 1.7 };
}

function partBlock(p: PlacedPart, f: Frame): string {
  const { pads, w, d } = padsOf(p);
  const [px, py] = toPcb(f, p.at.x + w / 2, p.at.y + d / 2);
  const { hole, outer } = holeSizes(p);
  const taken = new Set<string>();
  const labels = pads.map((pad) => labelFor(pad.shown, taken));
  const wire = p.def.id.endsWith("-wirepads");
  const what = wire ? "wire pads, solder the part's leads here" : `${p.def.footprint?.mount ?? "?"}, ${p.def.pins.length} pins, rotation ${p.at.rot}`;
  const lines: string[] = [];
  lines.push(`    {/* ${refName(p.use.ref)}: ${p.def.name} (${what}) */}`);
  lines.push(`    <chip`);
  lines.push(`      name="${refName(p.use.ref)}"`);
  lines.push(`      pcbX={${n(px)}}`);
  lines.push(`      pcbY={${n(py)}}`);
  lines.push(`      pinLabels={{ ${labels.map((l, i) => `pin${i + 1}: "${l}"`).join(", ")} }}`);
  const lcsc = wire ? undefined : p.def.footprint?.lcsc;
  // Modules and wire pads are not placed by the assembler; a part with an LCSC number is.
  lines.push(lcsc ? `      supplierPartNumbers={{ jlcpcb: ["${lcsc}"] }}` : `      doNotPlace`);
  lines.push(`      footprint={`);
  lines.push(`        <footprint>`);
  for (const pad of pads) {
    lines.push(
      `          <platedhole portHints={["pin${pad.pinIndex}"]} pcbX={${n(pad.dx)}} pcbY={${n(pad.dy)}} shape="circle" holeDiameter="${hole}mm" outerDiameter="${outer}mm" />`,
    );
  }
  lines.push(`          <silkscreenrect pcbX={0} pcbY={0} width="${n(w)}mm" height="${n(d)}mm" strokeWidth="0.15mm" isFilled={false} />`);
  lines.push(`          <silkscreentext text="${refName(p.use.ref)}" pcbX={0} pcbY={${n(-d / 2 - 1)}} fontSize="1mm" />`);
  for (const pad of pads) {
    const chars = pad.shown.length;
    // Label sits inside the outline, away from the nearest edge; text along a pin row is turned 90 degrees.
    const along = Math.min(3.2, 0.9 + chars * 0.28);
    let tx = pad.dx;
    let ty = pad.dy;
    let rot = 0;
    if (pad.edge === "top") ty -= along;
    else if (pad.edge === "bottom") ty += along;
    else if (pad.edge === "left") tx += along;
    else tx -= along;
    if (pad.edge === "top" || pad.edge === "bottom") rot = 90;
    lines.push(
      `          <silkscreentext text="${pad.shown.replace(/"/g, "")}" pcbX={${n(tx)}} pcbY={${n(ty)}} fontSize="0.7mm"${rot ? ` pcbRotation={${rot}}` : ""} />`,
    );
  }
  lines.push(`        </footprint>`);
  lines.push(`      }`);
  lines.push(`    />`);
  return lines.join("\n");
}

const POWER_ROLES = new Set(["gnd", "power-in", "power-out"]);

/** Join a net's pins nearest-first so each trace is short and the net stays one tree. */
function chain(net: Net, pos: Map<string, { x: number; y: number }>): [string, string][] {
  const key = (np: Net["pins"][number]): string => `${np.ref}.${np.pin.name}`;
  const rest = net.pins.map(key);
  const done: string[] = [rest.shift()!];
  const pairs: [string, string][] = [];
  while (rest.length) {
    let bi = 0;
    let bj = 0;
    let bd = Infinity;
    for (let i = 0; i < done.length; i++) {
      for (let j = 0; j < rest.length; j++) {
        const a = pos.get(done[i]!)!;
        const b = pos.get(rest[j]!)!;
        const dist = Math.hypot(a.x - b.x, a.y - b.y);
        if (dist < bd) {
          bd = dist;
          bi = i;
          bj = j;
        }
      }
    }
    pairs.push([done[bi]!, rest[bj]!]);
    done.push(rest.splice(bj, 1)[0]!);
  }
  return pairs;
}

export function renderBoard(loaded: Loaded, layout: PcbLayout): string {
  const { board } = layout;
  const f: Frame = { cx: board.w / 2, cy: board.d / 2 };
  const byRef = new Map(layout.parts.map((p) => [p.use.ref, p]));

  // Selector for a pin: ".<ref> > .pin<N>", N being the pin's index in the (possibly pad-only) part.
  const pos = new Map<string, { x: number; y: number }>();
  const sel = new Map<string, string>();
  for (const p of layout.parts) {
    for (const pad of padsOf(p).pads) {
      pos.set(`${p.use.ref}.${pad.name}`, { x: pad.wx, y: pad.wy });
      sel.set(`${p.use.ref}.${pad.name}`, `.${refName(p.use.ref)} > .pin${pad.pinIndex}`);
    }
  }

  const out: string[] = [];
  out.push(`// Carrier PCB for "${loaded.project.name}", generated by benchtop pcb.ts.`);
  out.push(`// Board ${board.w} x ${board.d} mm, 2 layers, ${board.t} mm. Edit freely; re-running pcb.ts overwrites this file.`);
  out.push(`// Origin is the board centre, x right, y UP. Parts keep their real pin positions, so a module drops straight in.`);
  out.push(`export default () => (`);
  out.push(`  <board`);
  out.push(`    width="${board.w}mm"`);
  out.push(`    height="${board.d}mm"`);
  out.push(`    layers={2}`);
  out.push(`    autorouter="auto_local"`);
  out.push(`    // Vias at JLCPCB's standard tier: 0.3 mm drill, 0.6 mm pad.`);
  out.push(`    minViaHoleDiameter="0.3mm"`);
  out.push(`    minViaPadDiameter="0.6mm"`);
  out.push(`  >`);
  out.push(``);
  out.push(`    {/* Mounting holes (M3 clearance) */}`);
  for (const h of layout.holes) {
    const [x, y] = toPcb(f, h.x, h.y);
    out.push(`    <hole pcbX={${n(x)}} pcbY={${n(y)}} diameter="${h.dia}mm" />`);
  }
  out.push(``);
  for (const p of layout.parts) {
    out.push(partBlock(p, f));
    out.push(``);
  }
  out.push(`    {/* Nets. Power and ground ${POWER_MM} mm, signals ${SIGNAL_MM} mm. */}`);
  const nets = [...loaded.nets].sort((a, b) => a.name.localeCompare(b.name));
  for (const net of nets) {
    const power = net.pins.some((np) => POWER_ROLES.has(np.pin.role));
    const mm = power ? POWER_MM : SIGNAL_MM;
    out.push(`    {/* ${net.name}: ${net.pins.map((np) => `${np.ref}.${np.pin.name}`).join(", ")} */}`);
    const id = net.name.replace(/[^A-Za-z0-9_]/g, "_");
    chain(net, pos).forEach(([a, b], i) => {
      if (!byRef.has(a.split(".")[0]!) || !byRef.has(b.split(".")[0]!)) return;
      out.push(`    <trace name="${id}_${i + 1}" from="${sel.get(a)}" to="${sel.get(b)}" thickness="${mm}mm" />`);
    });
  }
  out.push(`  </board>`);
  out.push(`)`);
  out.push(``);
  return out.join("\n");
}

// ---------------------------------------------------------------------------
// Export
// ---------------------------------------------------------------------------

interface ExportJob {
  format: string;
  file: string;
  required: boolean;
}

const JOBS: ExportJob[] = [
  { format: "schematic-svg", file: "schematic.svg", required: true },
  { format: "pcb-svg", file: "pcb.svg", required: true },
  { format: "pcb-png", file: "pcb.png", required: true },
  { format: "gerbers", file: "gerbers.zip", required: true },
  { format: "glb", file: "board.glb", required: false },
];

async function runTsci(args: string[], cwd: string): Promise<{ ok: boolean; log: string }> {
  const proc = Bun.spawn([process.execPath, TSCI, ...args], { cwd, stdout: "pipe", stderr: "pipe" });
  const [so, se] = await Promise.all([new Response(proc.stdout).text(), new Response(proc.stderr).text()]);
  const code = await proc.exited;
  return { ok: code === 0, log: `${so}${se}`.trim() };
}

// ---------------------------------------------------------------------------
// order.md
// ---------------------------------------------------------------------------

function orderMd(loaded: Loaded, layout: PcbLayout): string {
  const { board } = layout;
  const rows = layout.parts
    .map((p) => {
      const wire = p.def.id.endsWith("-wirepads");
      const mount = wire ? "wire pads" : (p.def.footprint?.mount ?? "?");
      const lcsc = p.def.footprint?.lcsc ?? "";
      return `| ${p.use.ref} | ${p.use.label ?? p.def.name} | ${mount} | ${lcsc || "none"} |`;
    })
    .join("\n");
  const warn = layout.warnings.length ? layout.warnings.map((w) => `- ${w}`).join("\n") : "- none";
  return `# Ordering the ${loaded.project.name} carrier board

Board: **${board.w} x ${board.d} mm**, **2 layers**, ${board.t} mm thick. Four M3 mounting holes (3.2 mm) in the corners.

## Bare board (you solder everything)

1. Open https://jlcpcb.com and choose Order Now, then Add gerber file.
2. Upload \`gerbers.zip\` from this folder. Do not unzip it. It also holds \`bom.csv\` and
   \`pick_and_place.csv\` (empty when no part has an LCSC number); if the uploader rejects the zip, unzip it,
   delete those two files and zip the rest again. (Not tested against the live uploader.)
3. Check the preview: ${board.w} x ${board.d} mm outline, silkscreen on top, a hole at every pin.
4. Options:

| Option | Value |
|---|---|
| Base material | FR-4 |
| Layers | 2 |
| Dimensions | ${board.w} x ${board.d} mm (filled in from the file) |
| PCB thickness | 1.6 mm |
| Surface finish | HASL, lead free |
| Quantity | 5 |
| Everything else | leave at the default |

5. Order. Then buy the modules and parts in \`bom\` of the guide and solder them on: modules go in
   header-side down, pins through the holes, components on top.

## Assembled by JLCPCB (optional)

JLCPCB assembles only parts that have an LCSC number. Pin headers and hobby modules are not assembled:
you solder those by hand, so assembly saves little on a carrier board like this one. If a part below
lists an LCSC number you can have it placed.

| Ref | Part | Mount | LCSC |
|---|---|---|---|
${rows}

To order assembly: upload \`gerbers.zip\` as above, switch on Assembly, choose top side, upload
\`bom.csv\` and \`pick_and_place.csv\`, and fill in the LCSC part number of each part you want placed.
The files tscircuit writes leave the comment, value and footprint columns empty, so complete them from
the table above before uploading. Check each part's rotation in JLCPCB's placement preview.

## Notes from the generator

${warn}
`;
}

// ---------------------------------------------------------------------------
// main
// ---------------------------------------------------------------------------

function installHint(): string {
  return [
    `tscircuit ${TSCIRCUIT_VERSION} is not installed in ${join(SCRIPTS_DIR, "node_modules")}.`,
    `Install it:  bun add --exact tscircuit@${TSCIRCUIT_VERSION} --cwd ${SCRIPTS_DIR}`,
    `or run it once without installing:  bunx tscircuit@${TSCIRCUIT_VERSION} export <board.tsx> -f gerbers`,
  ].join("\n");
}

await main(async () => {
  const args = process.argv.slice(2);
  const noExport = args.includes("--no-export");
  const dir = args.find((a) => !a.startsWith("--"));
  if (!dir) {
    console.error("usage: bun pcb.ts <projectDir> [--no-export]");
    process.exit(2);
  }
  const loaded = await loadProject(resolve(dir));
  assertResolvedGeometry(loaded, "Carrier PCB generation");
  const layout = layoutPcb(loaded);

  const pcbDir = join(loaded.dir, "pcb");
  const outDir = join(loaded.dir, "out", "pcb");
  await mkdir(pcbDir, { recursive: true });
  const boardFile = join(pcbDir, "board.tsx");
  await Bun.write(boardFile, renderBoard(loaded, layout));
  console.log(`wrote ${boardFile}`);
  console.log(`board ${layout.board.w} x ${layout.board.d} mm, ${layout.parts.length} parts, ${loaded.nets.length} nets`);
  for (const w of layout.warnings) console.log(`warning: ${w}`);

  if (noExport) return;

  if (!existsSync(TSCI)) {
    console.error(installHint());
    process.exit(3);
  }
  await mkdir(outDir, { recursive: true });
  await Bun.write(join(outDir, "order.md"), orderMd(loaded, layout));
  console.log(`wrote ${join(outDir, "order.md")}`);

  let failed = false;
  for (const job of JOBS) {
    const target = join(outDir, job.file);
    // The parts engine looks parts up online and can stall for minutes; this board needs no lookups.
    const r = await runTsci(["export", boardFile, "--disable-parts-engine", "-f", job.format, "-o", target], pcbDir);
    if (r.ok && existsSync(target)) {
      console.log(`wrote ${target}`);
    } else if (job.required) {
      failed = true;
      console.error(`error: export ${job.format} failed\n${r.log.split("\n").slice(-12).join("\n")}`);
    } else {
      console.log(`skipped ${job.file}: export ${job.format} failed (optional)\n${r.log.split("\n").slice(-4).join("\n")}`);
    }
  }
  // `tsci export` exits 0 even when routing failed: the failures only exist as *_error
  // records in the circuit JSON. Export that and read them, or an unrouted board ships silently.
  const cjFile = join(outDir, "circuit.json");
  const cj = await runTsci(["export", boardFile, "--disable-parts-engine", "-f", "circuit-json", "-o", cjFile], pcbDir);
  if (cj.ok && existsSync(cjFile)) {
    // JSON.parse yields any; narrowed to the two fields read here.
    const records = (await Bun.file(cjFile).json()) as { type?: string; message?: string }[];
    const errors = records.filter((r) => typeof r.type === "string" && r.type.endsWith("_error"));
    const routed = records.filter((r) => r.type === "pcb_trace").length;
    const wanted = records.filter((r) => r.type === "source_trace").length;
    console.log(`routing: ${routed} of ${wanted} connections routed`);
    if (errors.length > 0 || routed < wanted) {
      failed = true;
      console.error(`error: ${errors.length} design errors in the board (see ${cjFile})`);
      for (const e of errors.slice(0, 15)) console.error(`  ${e.type}: ${e.message ?? ""}`);
    }
  } else {
    failed = true;
    console.error(`error: could not read back the routed board\n${cj.log.split("\n").slice(-6).join("\n")}`);
  }

  // tscircuit's own short-circuit check on the routed copper.
  const shorts = await runTsci(["check", "shorts", boardFile], pcbDir);
  const verdict = shorts.log.split("\n").find((l) => /short/i.test(l)) ?? shorts.log.split("\n")[0] ?? "";
  if (shorts.ok && /no shorts/i.test(verdict)) {
    console.log(`check: ${verdict}`);
  } else {
    failed = true;
    console.error(`error: shorts check failed\n${shorts.log.split("\n").slice(-12).join("\n")}`);
  }
  if (failed) process.exit(4);
});
