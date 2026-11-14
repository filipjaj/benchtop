// Loading and resolving a project: part definitions, pin lookups, nets, bench layout.

import { readdir } from "node:fs/promises";
import { join, resolve } from "node:path";
import type { PartDef, PinDef, PlacedPart, Project, Shape } from "./types";

export const SKILL_ROOT = resolve(import.meta.dir, "..", "..");
export const LIBRARY_DIR = join(SKILL_ROOT, "assets", "parts");

export interface NetPin {
  ref: string;
  pin: PinDef;
  part: PlacedPart;
}

export interface Net {
  name: string;
  pins: NetPin[];
}

export interface Loaded {
  dir: string;
  project: Project;
  placed: PlacedPart[];
  byRef: Map<string, PlacedPart>;
  nets: Net[];
}

export class ProjectError extends Error {}

async function readJson<T>(path: string): Promise<T> {
  // JSON.parse returns any; every caller narrows through a typed loader below.
  return (await Bun.file(path).json()) as T;
}

async function loadDir(dir: string, into: Map<string, PartDef>): Promise<void> {
  let names: string[];
  try {
    names = await readdir(dir);
  } catch {
    return;
  }
  for (const name of names.filter((n) => n.endsWith(".json")).sort()) {
    const def = await readJson<PartDef>(join(dir, name));
    if (def.id !== name.replace(/\.json$/, "")) {
      throw new ProjectError(`${join(dir, name)}: id "${def.id}" must match the file name`);
    }
    into.set(def.id, def);
  }
}

/** Library parts, overridden by any part of the same id in <project>/parts/. */
export async function loadPartDefs(projectDir?: string): Promise<Map<string, PartDef>> {
  const defs = new Map<string, PartDef>();
  await loadDir(LIBRARY_DIR, defs);
  if (projectDir) await loadDir(join(projectDir, "parts"), defs);
  return defs;
}

export function parseEnd(end: string): { ref: string; pin: string } {
  const dot = end.indexOf(".");
  if (dot < 1 || dot === end.length - 1) {
    throw new ProjectError(`"${end}" is not a pin reference; expected "<ref>.<pin>", e.g. "mcu.GPIO8"`);
  }
  return { ref: end.slice(0, dot), pin: end.slice(dot + 1) };
}

export function findPin(def: PartDef, name: string): PinDef | undefined {
  return def.pins.find((p) => p.name === name || p.aliases?.includes(name));
}

/**
 * The ordinary part definition for a part that repeats per unit (PartDef.repeat): body
 * grown to `units` units, the per-unit shapes copied once per unit with numbered tags,
 * the spanning port stretched over all of them. Done once, here, so nothing downstream
 * has to know about units. A part without `repeat` is returned as it is, and so is a
 * one-unit part apart from its `repeat` block being dropped. The input is never changed.
 */
export function expandRepeat(def: PartDef, units: number | undefined, ref: string): PartDef {
  const rep = def.repeat;
  if (!rep) return def;
  const n = units ?? 1;
  if (!Number.isInteger(n) || n < 1) {
    throw new ProjectError(`part "${ref}": units must be a whole number of at least 1 for ${def.name}, got ${units}`);
  }
  if (!(rep.pitch > 0)) throw new ProjectError(`${def.id}: repeat.pitch must be above 0`);
  const run = (n - 1) * rep.pitch;
  const copies: Shape[] = [];
  for (let k = 0; k < n; k++) {
    for (const s of rep.shapes) {
      const moved = { ...s, x: s.x + k * rep.pitch };
      copies.push(s.tag ? { ...moved, tag: `${s.tag}-${k + 1}` } : moved);
    }
  }
  if (rep.span && !def.ports?.some((p) => p.name === rep.span)) {
    throw new ProjectError(`${def.id}: repeat.span "${rep.span}" is not the name of a port`);
  }
  const { repeat: _repeat, ...plain } = def;
  return {
    ...plain,
    body: { ...def.body, w: def.body.w + run },
    shapes: [...(def.shapes ?? []), ...copies],
    ports: def.ports?.map((p) => (p.name === rep.span ? { ...p, x: p.x + run / 2, w: p.w + run } : p)),
  };
}

/**
 * Bench layout for the wiring illustrations when the project does not place parts
 * itself: controller boards in the front row, everything else in a row behind, so
 * wires arc away from the viewer and both ends of each one stay visible.
 */
export function benchLayout(project: Project, defs: Map<string, PartDef>): PlacedPart[] {
  const gap = 14;
  const front: PlacedPart[] = [];
  const back: PlacedPart[] = [];
  for (const use of project.parts) {
    const library = defs.get(use.part);
    if (!library) {
      throw new ProjectError(
        `part "${use.part}" (ref ${use.ref}) is not in the library. Add ${use.part}.json to the project's parts/ folder.`,
      );
    }
    const def = expandRepeat(library, use.units, use.ref);
    const placed: PlacedPart = {
      use,
      def,
      at: { x: use.bench?.x ?? 0, y: use.bench?.y ?? 0, z: use.bench?.z ?? 0, rot: use.bench?.rot ?? 0 },
    };
    (def.kind === "board" ? front : back).push(placed);
  }
  // Turn each module so its pads face the controller in the front row: wires then
  // leave from the near edge instead of crossing the part's own components.
  for (const p of back) {
    if (p.use.bench) continue;
    const { w, d } = p.def.body;
    const cx = p.def.pins.reduce((s, q) => s + q.x, 0) / p.def.pins.length;
    const cy = p.def.pins.reduce((s, q) => s + q.y, 0) / p.def.pins.length;
    const toward: [0 | 90 | 180 | 270, number][] = [
      [0, cy / d - 0.5],
      [180, 0.5 - cy / d],
      [90, cx / w - 0.5],
      [270, 0.5 - cx / w],
    ];
    toward.sort((m, n) => n[1] - m[1]);
    if (toward[0]![1] > 0.15) p.at.rot = toward[0]![0];
  }
  const size = (p: PlacedPart) => {
    const swap = p.at.rot === 90 || p.at.rot === 270;
    return swap ? { w: p.def.body.d, d: p.def.body.w } : { w: p.def.body.w, d: p.def.body.d };
  };
  const rowWidth = (row: PlacedPart[]) => row.reduce((sum, p) => sum + size(p).w, 0) + gap * Math.max(0, row.length - 1);
  const freeBack = back.filter((p) => !p.use.bench);
  const freeFront = front.filter((p) => !p.use.bench);
  const backDepth = freeBack.reduce((m, p) => Math.max(m, size(p).d), 0);
  const widest = Math.max(rowWidth(freeFront), rowWidth(freeBack));
  // Parts the project placed itself stay where they are. The rest are laid out in rows
  // as a block that starts to the right of every placed part, so a free part can never
  // land on one the project placed, whatever number of either there are.
  const fixed = [...back, ...front].filter((p) => p.use.bench);
  const originX = fixed.length ? Math.max(...fixed.map((p) => p.at.x + size(p).w)) + gap : 0;
  const originY = fixed.length ? Math.min(...fixed.map((p) => p.at.y)) : 0;
  const layRow = (row: PlacedPart[], y: number, alignFront: boolean, depth: number) => {
    const free = row.filter((p) => !p.use.bench);
    let x = originX + (widest - rowWidth(free)) / 2;
    for (const p of free) {
      p.at.x = x;
      p.at.y = originY + (alignFront ? y + depth - size(p).d : y);
      x += size(p).w + gap;
    }
  };
  layRow(back, 0, true, backDepth);
  layRow(front, freeBack.length ? backDepth + gap * 1.4 : 0, false, 0);
  return [...back, ...front];
}

export function computeNets(project: Project, byRef: Map<string, PlacedPart>): Net[] {
  const parent = new Map<string, string>();
  const find = (k: string): string => {
    let r = k;
    while (parent.get(r) !== r) r = parent.get(r)!;
    parent.set(k, r);
    return r;
  };
  const named = new Map<string, string>();
  const resolveEnd = (end: string): { key: string; np: NetPin } => {
    const { ref, pin } = parseEnd(end);
    const part = byRef.get(ref);
    if (!part) throw new ProjectError(`connection uses "${end}" but no part has ref "${ref}"`);
    const def = findPin(part.def, pin);
    if (!def) {
      const known = part.def.pins.map((p) => p.name).join(", ");
      throw new ProjectError(`${part.def.name} (ref ${ref}) has no pin "${pin}". Its pins are: ${known}`);
    }
    return { key: `${ref}.${def.name}`, np: { ref, pin: def, part } };
  };
  const pins = new Map<string, NetPin>();
  for (const c of project.connections) {
    const a = resolveEnd(c.from);
    const b = resolveEnd(c.to);
    for (const e of [a, b]) {
      pins.set(e.key, e.np);
      if (!parent.has(e.key)) parent.set(e.key, e.key);
    }
    parent.set(find(a.key), find(b.key));
    if (c.net) named.set(a.key, c.net);
  }
  const groups = new Map<string, NetPin[]>();
  const names = new Map<string, string>();
  for (const [key, np] of pins) {
    const root = find(key);
    if (!groups.has(root)) groups.set(root, []);
    groups.get(root)!.push(np);
    const given = named.get(key);
    if (given) names.set(root, given);
  }
  const nets: Net[] = [];
  for (const [root, members] of groups) {
    let name = names.get(root);
    if (!name) {
      const gnd = members.find((m) => m.pin.role === "gnd");
      const rail = members.find((m) => m.pin.role === "power-out");
      const io = members.find((m) => m.part.def.kind === "board" && m.pin.role === "io") ?? members[0]!;
      name = gnd ? "GND" : rail ? rail.pin.name : `${io.ref}_${io.pin.name}`;
    }
    nets.push({ name, pins: members });
  }
  return nets;
}

export async function loadProject(dir: string): Promise<Loaded> {
  const abs = resolve(dir);
  const file = Bun.file(join(abs, "project.json"));
  if (!(await file.exists())) {
    throw new ProjectError(`${join(abs, "project.json")} not found. Pass the folder that holds project.json.`);
  }
  const project = await readJson<Project>(join(abs, "project.json"));
  return resolveProject(project, await loadPartDefs(abs), abs);
}

/** Resolve an in-memory project against a set of part definitions. Tests use this directly. */
export function resolveProject(project: Project, defs: Map<string, PartDef>, dir = "."): Loaded {
  const abs = resolve(dir);
  const refs = new Set<string>();
  for (const use of project.parts) {
    if (refs.has(use.ref)) throw new ProjectError(`ref "${use.ref}" is used by more than one part`);
    refs.add(use.ref);
  }
  const placed = benchLayout(project, defs);
  const byRef = new Map(placed.map((p) => [p.use.ref, p]));
  const nets = computeNets(project, byRef);
  return { dir: abs, project, placed, byRef, nets };
}

/** Run a CLI entry point with one clean error line instead of a stack trace for user mistakes. */
export async function main(run: () => Promise<void>): Promise<void> {
  try {
    await run();
  } catch (err) {
    if (err instanceof ProjectError) {
      console.error(`error: ${err.message}`);
      process.exit(2);
    }
    throw err;
  }
}
