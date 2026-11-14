#!/usr/bin/env bun
// Structural check of part definitions. Catches the mistakes that silently wreck a
// drawing or an enclosure: a pin outside the board outline, a shape taller than the
// stated height, two pins sharing a name.
//
// Usage: bun check-parts.ts [dir ...]     (defaults to the bundled library)

import { readdir } from "node:fs/promises";
import { join } from "node:path";
import { editedAfterImport } from "./lib/import-provenance";
import { LIBRARY_DIR, expandRepeat } from "./lib/project";
import type { PartDef } from "./lib/types";

const KINDS = ["board", "sensor", "display", "actuator", "power", "passive", "input", "audio", "connector", "light"];
const ROLES = ["power-in", "power-out", "gnd", "io", "passive", "nc"];
// Connectors and antennas legitimately hang over the board edge by a few millimetres.
const OVERHANG = 4;
/**
 * A leg can sit just outside the moulded body: the switch lug of a PCB barrel jack is 0.2 mm
 * past the housing on the maker's own drawing. Further out than this, the pin is far more
 * likely in the wrong frame or the wrong unit, which is what the rule is there to catch.
 */
export const PIN_OVERHANG = 1;

export function check(def: PartDef, file: string): string[] {
  const e: string[] = [];
  const need = (ok: boolean, msg: string) => {
    if (!ok) e.push(msg);
  };
  need(def.id === file.replace(/\.json$/, ""), `id "${def.id}" does not match file name`);
  need(KINDS.includes(def.kind), `kind "${def.kind}" is not one of ${KINDS.join("|")}`);
  need(typeof def.blurb === "string" && def.blurb.length > 10, "blurb missing");
  need(def.body?.w > 0 && def.body?.d > 0 && def.body?.h > 0, "body needs positive w, d, h");
  need(typeof def.maxHeight === "number" && Number.isFinite(def.maxHeight) && def.maxHeight > 0, "maxHeight needs a positive finite number");
  need(Array.isArray(def.pins) && def.pins.length > 0, "pins missing");
  need(Array.isArray(def.sources) && def.sources.length > 0, "sources missing: cite where the dimensions came from");
  need(def.confidence === "datasheet" || def.confidence === "typical", "confidence must be datasheet|typical");
  need(def.sourcing?.priceUsd > 0, "sourcing.priceUsd missing");
  need((def.sourcing?.search?.length ?? 0) > 0, "sourcing.search missing");
  if (def.confidence === "typical") need(!!def.verify, "typical-confidence parts need a verify note");
  if (def.geometryEvidence) {
    need(["unresolved", "source-supported"].includes(def.geometryEvidence.status), "geometryEvidence.status must be unresolved|source-supported");
    need(typeof def.geometryEvidence.reason === "string" && def.geometryEvidence.reason.length > 0, "geometryEvidence.reason missing");
    need(Array.isArray(def.geometryEvidence.unknown), "geometryEvidence.unknown must be an array");
  }

  if (!def.body || !def.pins || ![def.body.w, def.body.d, def.body.h, def.maxHeight].every((v) => typeof v === "number" && Number.isFinite(v) && v > 0)) return e;

  if (def.repeat) {
    const rep = def.repeat;
    need(typeof rep.pitch === "number" && rep.pitch > 0, "repeat.pitch must be a number above 0 (mm between units)");
    need(Array.isArray(rep.shapes) && rep.shapes.length > 0, "repeat.shapes must list what is drawn per unit");
    need(!rep.span || !!def.ports?.some((p) => p.name === rep.span), `repeat.span "${rep.span}" is not the name of a port`);
    if (rep.pitch > 0) need(Math.abs(def.body.w - rep.pitch) < 0.5, `body.w (${def.body.w}) is one unit long, so it should equal repeat.pitch (${rep.pitch})`);
    for (const s of rep.shapes ?? []) {
      need(s.kind === "box" || s.kind === "cyl", "repeat.shapes entries must be box or cyl");
      need(!!s.tag, "repeat.shapes entries need a tag, which becomes <tag>-1, <tag>-2 ... (use \"led\" for pixels)");
    }
    // Everything below is checked on a run of three units, which is what a drawing will see.
    if (e.length) return e;
    def = expandRepeat(def, 3, file);
  }

  const seen = new Set<string>();
  for (const p of def.pins) {
    for (const n of [p.name, ...(p.aliases ?? [])]) {
      need(!seen.has(n), `pin name "${n}" appears twice`);
      seen.add(n);
    }
    need(ROLES.includes(p.role), `pin ${p.name}: role "${p.role}" invalid`);
    need(
      p.x >= -PIN_OVERHANG && p.x <= def.body.w + PIN_OVERHANG && p.y >= -PIN_OVERHANG && p.y <= def.body.d + PIN_OVERHANG,
      `pin ${p.name} at (${p.x}, ${p.y}) is more than ${PIN_OVERHANG} mm outside the ${def.body.w} x ${def.body.d} body`,
    );
    if (p.role === "power-out") need(typeof p.volts === "number", `power-out pin ${p.name} needs volts`);
  }
  let top = def.body.h;
  for (const s of def.shapes ?? []) {
    const z = def.body.h + (s.z ?? 0);
    top = Math.max(top, z + s.h);
    const x0 = s.kind === "box" ? s.x : s.x - s.r;
    const y0 = s.kind === "box" ? s.y : s.y - s.r;
    const x1 = s.kind === "box" ? s.x + s.w : s.x + s.r;
    const y1 = s.kind === "box" ? s.y + s.d : s.y + s.r;
    need(
      x0 >= -OVERHANG && y0 >= -OVERHANG && x1 <= def.body.w + OVERHANG && y1 <= def.body.d + OVERHANG,
      `shape ${s.tag ?? s.kind} extends more than ${OVERHANG} mm beyond the body`,
    );
  }
  need(def.maxHeight + 0.01 >= top, `maxHeight ${def.maxHeight} is lower than the tallest shape (${top.toFixed(2)})`);
  for (const h of def.holes ?? []) {
    need(h.x > 0 && h.x < def.body.w && h.y > 0 && h.y < def.body.d, `mounting hole at (${h.x}, ${h.y}) is outside the body`);
  }
  if (def.kind === "board") {
    need(def.pins.some((p) => p.role === "gnd"), "a board needs at least one gnd pin");
    need(def.pins.some((p) => typeof p.gpio === "number"), "a board needs gpio numbers on its io pins");
    need(typeof def.electrical?.logicVolts === "number", "a board needs electrical.logicVolts");
  }
  return e;
}

if (import.meta.main) {
  const dirs = process.argv.slice(2).length ? process.argv.slice(2) : [LIBRARY_DIR];
  let failed = 0;
  let count = 0;
  for (const dir of dirs) {
    for (const file of (await readdir(dir)).filter((n) => n.endsWith(".json")).sort()) {
      count++;
      let errors: string[];
      let parsed: PartDef | null = null;
      try {
        // Parsed JSON is untyped; check() validates the fields it reads.
        parsed = (await Bun.file(join(dir, file)).json()) as PartDef;
        errors = check(parsed, file);
      } catch (err) {
        errors = [`not valid JSON: ${(err as Error).message}`];
      }
      if (errors.length) {
        failed++;
        console.log(`FAIL ${file}`);
        for (const m of errors) console.log(`     ${m}`);
      } else {
        console.log(`ok   ${file}`);
        if (parsed?.geometryEvidence?.status === "unresolved") console.log(`     PHYSICAL GEOMETRY UNRESOLVED: logical planning only; ${parsed.geometryEvidence.reason}`);
      }
      // Information, not an error: a draft from `import-part` records a hash of the geometry it wrote.
      const edited = parsed ? editedAfterImport(parsed) : null;
      if (edited) console.log(`     INFO ${edited}`);
    }
  }
  console.log(`\n${count - failed}/${count} parts pass structural checks (not source or fit verification)`);
  process.exit(failed ? 1 : 0);
}
