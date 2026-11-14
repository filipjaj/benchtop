#!/usr/bin/env bun
// Generate the 3D-printable enclosure for a project.
//
//   bun enclosure.ts <projectDir>
//   bun enclosure.ts <projectDir> --explain
//                        prints where every part sits, in the coordinates `mounts` uses, plus
//                        the keep-out areas and the openings. Writes nothing.
//
// Writes into <projectDir>/out/enclosure/:
//   body.stl, lid.stl    printable solids (lid flat, outer face down)
//   <slug>.3mf           both on one plate, with the caps beside them when there are any
//   caps.stl             the printed button caps, flange down (only when a mount has a "cap")
//   fit-floor.stl, fit-lid.stl, fit-test.3mf
//                        the ten-minute fit test: lower body with thin floor, and a thin lid plate
//   assembly.glb         body, lid and its mounted parts lifted 12 mm, detailed meshes per part
//   closed.glb           the same with the lid seated (used by render.ts)
//   layout.json          the EnclosureLayout (also consumed by the assembly guide)
//   print.md             slicer settings, screws, warnings
//
// Exit codes: 0 ok, 2 project error, 3 JSCAD packages not installed, 4 files written
// but a mesh is not watertight.

import { unverifiedNotes, warnUnresolvedGeometry } from "./lib/geometry-evidence";
import { mkdir } from "node:fs/promises";
import { join, resolve } from "node:path";
import { closedHeight, explainLayout, hardwareLines, layoutEnclosure, type EnclosureLayout } from "./lib/enclosure-layout";
import {
  buildCaps,
  buildFitSolids,
  buildSolids,
  fitChecklist,
  meshToGeom3,
  meshVolume,
  triMesh,
  type FitSolids,
  type Geom3,
  type Jscad,
  type Solids,
  type TriMesh,
} from "./lib/enclosure-solids";
import { writeGlb, type GlbMesh } from "./lib/glb";
import { partMeshes } from "./lib/part-mesh";
import { loadProject, main } from "./lib/project";


interface Serializers {
  stl: { serialize(options: { binary: boolean }, ...objects: Geom3[]): ArrayBuffer[] };
  mf: { serialize(options: { unit: string }, ...objects: Geom3[]): (ArrayBuffer | string)[] };
}

/** Sizes are sums of design values and fit clearances; without rounding they print as 61.900000000000006. */
const mm2 = (n: number): number => Math.round(n * 100) / 100;

const LID_LIFT = 12; // mm the lid floats above the body in assembly.glb

async function loadJscad(): Promise<{ J: Jscad; ser: Serializers }> {
  const scriptsDir = import.meta.dir;
  try {
    // Dynamic imports so a missing install gives the install command, not a stack trace.
    const modeling = await import("@jscad/modeling");
    const stl = await import("@jscad/stl-serializer");
    const mf = await import("@jscad/3mf-serializer");
    // CommonJS packages: the namespace carries either named exports or a default.
    const pick = <T>(ns: unknown): T => ((ns as { default?: T }).default ?? ns) as T;
    return { J: pick<Jscad>(modeling), ser: { stl: pick(stl), mf: pick(mf) } };
  } catch (err) {
    console.error(`The JSCAD packages are not installed (${err instanceof Error ? err.message : String(err)}). Run:`);
    console.error(`  bun install --cwd "${scriptsDir}"`);
    process.exit(3);
  }
}

const hexToLinear = (hex: string): [number, number, number] => {
  const m = /^#?([0-9a-f]{6})$/i.exec(hex.trim());
  const n = m ? parseInt(m[1]!, 16) : 0xdddddd;
  const lin = (c: number): number => (c <= 0.04045 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4);
  return [lin(((n >> 16) & 255) / 255), lin(((n >> 8) & 255) / 255), lin((n & 255) / 255)];
};

function toMesh(name: string, m: TriMesh, color: [number, number, number]): GlbMesh {
  return { name, positions: new Float32Array(m.v), indices: new Uint32Array(m.t), color, roughness: 0.7, smoothAngle: 40 };
}

function concat(parts: ArrayBuffer[]): Uint8Array {
  const total = parts.reduce((s, p) => s + p.byteLength, 0);
  const out = new Uint8Array(total);
  let at = 0;
  for (const p of parts) {
    out.set(new Uint8Array(p), at);
    at += p.byteLength;
  }
  return out;
}

/** Assumed average extrusion rate for the print-time estimate: a 0.4 mm nozzle at 0.2 mm layers on a printer that does about 100 mm/s, travel and layer changes included. */
const FLOW_MM3_PER_S = 8;

interface FitStats {
  floorVolume: number;
  lidVolume: number;
  floorSize: FitSolids["floorSize"];
  lidSize: FitSolids["lidSize"];
  wallHeight: number;
}

function fitSection(L: EnclosureLayout, lidRefs: ReadonlySet<string>, s: FitStats): string[] {
  const total = s.floorVolume + s.lidVolume;
  const minutes = Math.max(5, Math.round(total / FLOW_MM3_PER_S / 60 / 5) * 5);
  const cm3 = (v: number): string => (Math.round(v / 100) / 10).toFixed(1);
  const size = (z: { w: number; d: number; h: number }): string => `${z.w} x ${z.d} x ${Math.round(z.h * 10) / 10} mm`;
  return [
    `## Print this first`,
    ``,
    // Above everything else in the file: this is the one note that can waste a whole print.
    ...L.warnings.filter((w) => w.startsWith("LAYOUT NOT VERIFIED")).flatMap((w) => [`**${w}**`, ``]),
    `Two small pieces cut to the same part files as the full case. Print them before the case: if a part does not fit, you find out in about ${minutes} minutes instead of after the full print.`,
    ``,
    `- fit-floor.stl: the bottom of the body, ${size(s.floorSize)}. Floor thinned to 0.8 mm, every post at its real height, wall ${Math.round(s.wallHeight * 10) / 10} mm above the floor, wall openings cut as far up as the wall goes. Try the floor-mounted parts on it.`,
    `- fit-lid.stl: a 1.2 mm plate, ${size(s.lidSize)}, with the real lid openings, the screw holes and the hanging posts, without the lip. Hold the lid-mounted parts against it.`,
    `- fit-test.3mf has both on one plate, flat side down. No supports.`,
    ``,
    `Time: roughly ${minutes} minutes. This is an estimate: ${cm3(total)} cm3 of plastic at an assumed ${FLOW_MM3_PER_S} mm3/s average flow, rounded to 5 minutes. Your slicer and printer decide the real figure.`,
    ``,
    `Check:`,
    ``,
    ...fitChecklist(L, lidRefs),
    ``,
    `If a check fails: measure the part with calipers, correct its part file (or override it with a copy in the project's parts/ folder), and regenerate with \`bun enclosure.ts <projectDir>\`. Then print the fit test again before the full case.`,
    ``,
  ];
}

function printNotes(L: EnclosureLayout, material: string, lidSize: Solids["lidSize"], fit: string[]): string {
  const bridged = L.openings.filter((o) => o.face !== "lid" && o.shape === "rect" && o.w > 12);
  const supports = bridged.length
    ? `No supports expected. The wide wall openings (${bridged.map((o) => `${o.ref}.${o.port} ${Math.round(o.w * 10) / 10} mm`).join(", ")}) bridge across the top edge; check the preview and enable bridge settings or add a support there if the slicer sags it.`
    : "No supports expected. Every opening is small enough to bridge, and nothing overhangs more than 45 degrees.";
  return [
    `# Print notes`,
    ``,
    ...fit,
    `## Full print`,
    ``,
    `- Material: ${material}`,
    `- Layer height: 0.2 mm`,
    `- Supports: ${supports}`,
    `- Body orientation: floor on the bed, open side up, exactly as in body.stl.`,
    `- Lid orientation: outer face on the bed (lid.stl is already flat that way), so the locating lip and hanging standoffs point up and need no supports. The countersinks sit on the bed side.`,
    ...(L.caps.length
      ? [
          `- Caps: caps.stl holds the ${L.caps.length} button caps, flange on the bed, hole opening downward. No supports. They stand ${Math.round((L.caps[0]!.zTop - L.outer.h - L.lidThickness) * 10) / 10} mm above the lid when fitted. Print them in another colour if you like; a 0.2 mm layer and 3 walls make them solid.`,
          `- Each capped button stands on a post from the floor, ${L.seats.length ? `${Math.round((L.seats[0]!.z - L.floor) * 10) / 10} mm tall` : "cut to the cavity height"}. The posts print with the body and need no supports.`,
        ]
      : []),
    `- Closed size: ${mm2(L.outer.w)} x ${mm2(L.outer.d)} x ${mm2(closedHeight(L))} mm (closed height: body ${mm2(L.outer.h)} mm plus lid plate ${mm2(L.lidThickness)} mm).`,
    `- Printed pieces: body ${mm2(L.outer.w)} x ${mm2(L.outer.d)} x ${mm2(L.outer.h)} mm; lid ${mm2(lidSize.w)} x ${mm2(lidSize.d)} x ${mm2(lidSize.h)} mm including its lip and hanging posts, which sit inside the body when closed.`,
    `- Cavity: ${mm2(L.inner.w)} x ${mm2(L.inner.d)} x ${mm2(L.inner.h)} mm, wall ${mm2(L.wall)} mm, fit clearance ${mm2(L.fit)} mm.`,
    ``,
    `## Hardware`,
    ``,
    ...hardwareLines(L),
    ``,
    `## Warnings`,
    ``,
    ...(L.warnings.length ? L.warnings.map((w) => `- ${w}`) : ["- none"]),
    ``,
  ].join("\n");
}

main(async () => {
  const args = process.argv.slice(2);
  const explain = args.includes("--explain");
  const dirArg = args.find((a) => !a.startsWith("--"));
  if (!dirArg) {
    console.error("usage: bun enclosure.ts <projectDir> [--explain]");
    process.exit(2);
  }
  if (explain) {
    // No CAD needed and nothing written: the layout in the coordinates mounts are written in.
    const loadedForExplain = await loadProject(dirArg);
    warnUnresolvedGeometry(loadedForExplain, "Enclosure layout");
    for (const line of explainLayout(layoutEnclosure(loadedForExplain), loadedForExplain)) console.log(line);
    return;
  }
  const loaded = await loadProject(dirArg);
  warnUnresolvedGeometry(loaded, "Enclosure generation");
  const { J, ser } = await loadJscad();
  const layout = layoutEnclosure(loaded);
  // First in the list, so print.md opens its warnings with the one that can waste a print.
  layout.warnings.unshift(...unverifiedNotes(loaded).map((n) => `${n} The case is cut to that part's file, not to a measured part: print the fit test and hold the real part against it before printing the case.`));
  const spec = loaded.project.enclosure!;
  const solids = buildSolids(J, layout);
  const lidRefs = new Set(spec.mounts.filter((m) => m.on === "lid").map((m) => m.ref));
  const fitSolids = buildFitSolids(J, layout, lidRefs);

  const outDir = join(resolve(loaded.dir), "out", "enclosure");
  await mkdir(outDir, { recursive: true });
  const written: string[] = [];
  const write = async (name: string, data: string | Uint8Array): Promise<void> => {
    const path = join(outDir, name);
    await Bun.write(path, data);
    written.push(path);
  };

  const bodyMesh = triMesh(J, solids.body);
  const lidMesh = triMesh(J, solids.lidPrint);
  for (const [name, m] of [["body", bodyMesh], ["lid", lidMesh]] as const) {
    if (m.rawOpenEdges > 0) console.log(`note: ${name} mesh had ${m.rawOpenEdges} open edges before repair, ${m.openEdges} after.`);
    if (m.openEdges > 0) console.error(`error: ${name} mesh still has ${m.openEdges} open edges after repair; it is not watertight and must not be printed.`);
  }
  const bodyGeom = meshToGeom3(J, bodyMesh);
  const lidGeom = meshToGeom3(J, lidMesh);
  await write("body.stl", concat(ser.stl.serialize({ binary: true }, bodyGeom)));
  await write("lid.stl", concat(ser.stl.serialize({ binary: true }, lidGeom)));

  const bodyColor = hexToLinear(spec.color);
  const named = (g: Geom3, name: string): Geom3 => ({ ...g, name });
  const plateLid = J.transforms.translate([layout.outer.w + 10, 0, 0], lidGeom);

  // Printed caps: one mesh each, checked like the body and the lid.
  const CAP_COLOR = "#2b2d33";
  const caps = buildCaps(J, layout).map((c) => ({
    ref: c.ref,
    color: hexToLinear(c.color ?? CAP_COLOR),
    assembled: triMesh(J, c.assembled),
    print: triMesh(J, c.print),
  }));
  const capOpenEdges = caps.reduce((n, c) => n + c.print.openEdges + c.assembled.openEdges, 0);
  if (capOpenEdges > 0) console.error(`error: the cap meshes have ${capOpenEdges} open edges after repair; they are not watertight and must not be printed.`);
  const capPrintGeoms = caps.map((c) => meshToGeom3(J, c.print));
  if (caps.length) await write("caps.stl", concat(ser.stl.serialize({ binary: true }, ...capPrintGeoms)));

  const mf = ser.mf.serialize(
    { unit: "millimeter" },
    named(J.colors.colorize([...bodyColor, 1], bodyGeom), "body"),
    named(J.colors.colorize([...bodyColor, 1], plateLid), "lid"),
    // The caps go in a row in front of the body, clear of both pieces.
    ...caps.map((c, i) => named(J.colors.colorize([...c.color, 1], J.transforms.translate([0, -20, 0], capPrintGeoms[i]!)), `cap-${c.ref}`)),
  );
  await write(
    `${loaded.project.slug}.3mf`,
    concat(mf.map((p) => (typeof p === "string" ? new TextEncoder().encode(p).buffer : p))),
  );

  const fitFloorMesh = triMesh(J, fitSolids.floor);
  const fitLidMesh = triMesh(J, fitSolids.lid);
  for (const [name, m] of [["fit-floor", fitFloorMesh], ["fit-lid", fitLidMesh]] as const) {
    if (m.rawOpenEdges > 0) console.log(`note: ${name} mesh had ${m.rawOpenEdges} open edges before repair, ${m.openEdges} after.`);
    if (m.openEdges > 0) console.error(`error: ${name} mesh still has ${m.openEdges} open edges after repair; it is not watertight and must not be printed.`);
  }
  const fitFloorGeom = meshToGeom3(J, fitFloorMesh);
  const fitLidGeom = meshToGeom3(J, fitLidMesh);
  await write("fit-floor.stl", concat(ser.stl.serialize({ binary: true }, fitFloorGeom)));
  await write("fit-lid.stl", concat(ser.stl.serialize({ binary: true }, fitLidGeom)));
  const fitMf = ser.mf.serialize(
    { unit: "millimeter" },
    named(J.colors.colorize([...bodyColor, 1], fitFloorGeom), "fit-floor"),
    named(J.colors.colorize([...bodyColor, 1], J.transforms.translate([layout.outer.w + 10, 0, 0], fitLidGeom)), "fit-lid"),
  );
  await write("fit-test.3mf", concat(fitMf.map((p) => (typeof p === "string" ? new TextEncoder().encode(p).buffer : p))));

  const lift = J.transforms.translate([0, 0, LID_LIFT], solids.lidAssembled);
  const lidColor = bodyColor.map((c) => Math.min(1, c * 0.92 + 0.04)) as [number, number, number];
  const partGlb: GlbMesh[] = layout.parts.flatMap((p) => {
    const mount = spec.mounts.find((m) => m.ref === p.use.ref)?.on ?? "floor";
    return partMeshes(p).map(
      (g): GlbMesh => ({
        name: `part:${p.use.ref}:${g.material.name}`,
        positions: g.positions,
        indices: g.indices,
        color: g.material.color,
        metallic: g.material.metallic,
        roughness: g.material.roughness,
        smoothAngle: 40,
        extras: { ref: p.use.ref, part: p.def.id, mount },
      }),
    );
  });
  // In the exploded assembly the lid-mounted parts travel with the lid.
  const liftedParts: GlbMesh[] = partGlb.map((m) => {
    if (m.extras?.mount !== "lid") return m;
    const positions = new Float32Array(m.positions);
    for (let i = 2; i < positions.length; i += 3) positions[i] = positions[i]! + LID_LIFT;
    return { ...m, positions };
  });
  const lidSeatedMesh = triMesh(J, solids.lidAssembled);
  // Caps are named and tagged like lid parts: in the exploded view they rise with the lid,
  // which is where they sit once the case is closed.
  const capGlb = (dz: number): GlbMesh[] =>
    caps.map((c) => {
      const positions = new Float32Array(c.assembled.v);
      for (let i = 2; i < positions.length; i += 3) positions[i] = positions[i]! + dz;
      return {
        name: `part:${c.ref}:cap`,
        positions,
        indices: new Uint32Array(c.assembled.t),
        color: c.color,
        roughness: 0.55,
        smoothAngle: 40,
        extras: { ref: c.ref, part: "printed-cap", mount: "lid" },
      };
    });
  await write(
    "assembly.glb",
    writeGlb([toMesh("body", bodyMesh, bodyColor), toMesh("lid", triMesh(J, lift), lidColor), ...liftedParts, ...capGlb(LID_LIFT)]),
  );
  await write(
    "closed.glb",
    writeGlb([toMesh("body", bodyMesh, bodyColor), toMesh("lid", lidSeatedMesh, lidColor), ...partGlb, ...capGlb(0)]),
  );

  await write("layout.json", JSON.stringify(layout, null, 2) + "\n");
  const fit = fitSection(layout, lidRefs, {
    floorVolume: meshVolume(fitFloorMesh),
    lidVolume: meshVolume(fitLidMesh),
    floorSize: fitSolids.floorSize,
    lidSize: fitSolids.lidSize,
    wallHeight: fitSolids.wallHeight,
  });
  await write("print.md", printNotes(layout, spec.material, solids.lidSize, fit));

  for (const p of written) console.log(p);
  const o = layout.outer;
  console.log(`closed size: ${mm2(o.w)} x ${mm2(o.d)} x ${mm2(closedHeight(layout))} mm (closed height ${mm2(closedHeight(layout))} = body ${mm2(o.h)} + lid plate ${mm2(layout.lidThickness)}; printed lid piece ${mm2(solids.lidSize.h)} tall including its posts)`);
  for (const w of layout.warnings) console.log(`warning: ${w}`);
  if (bodyMesh.openEdges > 0 || lidMesh.openEdges > 0 || fitFloorMesh.openEdges > 0 || fitLidMesh.openEdges > 0 || capOpenEdges > 0) {
    console.error(
      `error: files were written, but body has ${bodyMesh.openEdges}, lid ${lidMesh.openEdges}, fit-floor ${fitFloorMesh.openEdges}, fit-lid ${fitLidMesh.openEdges} and the caps ${capOpenEdges} open edges. Exiting with status 4.`,
    );
    process.exit(4);
  }
});
