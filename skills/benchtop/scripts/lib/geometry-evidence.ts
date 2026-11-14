import { ProjectError, type Loaded } from "./project";

// What the skill does with a part whose part file says its own geometry is unresolved
// (`geometryEvidence.status: "unresolved"`): the numbers in the file are a legacy guess
// that evidence contradicts, such as the microphone drawn with one row of six pads when
// the boards on sale have two rows of three.
//
// Policy, decided by the user on 2026-11-14: warn, still build. Every output is made
// from the file's numbers and says prominently that this part is not verified and must
// be measured before anything is printed. That is how the skill treats its other
// "typical" parts; the cheap fit-test print is the gate. Refusing instead left the skill
// unable to produce a case for any project with that part until someone measured one,
// which an unattended run never can.
//
// The refusal is kept for two cases. Strict mode, for someone who wants a build to stop
// (`--strict-geometry` or BENCHTOP_STRICT_GEOMETRY=1). And outputs that cost money to
// make and have no cheap test, such as a carrier PCB: those call assertResolvedGeometry.

type Placed = Pick<Loaded, "placed">;

/** Explicitly unresolved part records remain usable for logical wiring/BOM planning. */
export function unresolvedGeometry(loaded: Placed): Loaded["placed"] {
  return loaded.placed.filter((p) => p.def.geometryEvidence?.status === "unresolved");
}

/** True when the caller asked for unresolved geometry to stop the build. */
export function strictGeometry(): boolean {
  return process.argv.includes("--strict-geometry") || process.env.BENCHTOP_STRICT_GEOMETRY === "1";
}

/** The refusal. Always throws when a part is unresolved, whatever the mode. */
export function assertResolvedGeometry(loaded: Placed, purpose: string): void {
  const unresolved = unresolvedGeometry(loaded);
  if (!unresolved.length) return;
  throw new ProjectError(`${purpose} needs resolved physical geometry: ${unresolved.map((p) =>
    `${p.use.ref} (${p.def.id}): ${p.def.geometryEvidence!.reason}; missing: ${p.def.geometryEvidence!.unknown.join(", ")}`
  ).join(" | ")}. Use the logical connections/BOM as a partial package; replace the part with a source-backed exact variant before fabrication.`);
}

const label = (p: Loaded["placed"][number]): string => `${p.use.label ?? p.def.name} (${p.use.ref})`;

/**
 * One line for a drawing, a print note or a page: which parts are drawn from unverified
 * numbers. Empty when every part is resolved, so callers can spread it into a list.
 */
export function unverifiedNotes(loaded: Placed): string[] {
  const unresolved = unresolvedGeometry(loaded);
  if (!unresolved.length) return [];
  return [`LAYOUT NOT VERIFIED: ${unresolved.map(label).join(", ")}. Measure before printing.`];
}

let warned = false;

/**
 * The default gate for physical outputs. In strict mode it refuses, naming `purpose`.
 * Otherwise it prints one warning for the whole process, however many outputs ask, and
 * returns the parts so the caller can mark its output. The warning text does not name
 * the purpose, so build.ts, which lists a repeated line once, shows it once per build.
 */
export function warnUnresolvedGeometry(loaded: Placed, purpose: string): Loaded["placed"] {
  const unresolved = unresolvedGeometry(loaded);
  if (!unresolved.length) return unresolved;
  if (strictGeometry()) assertResolvedGeometry(loaded, purpose);
  if (!warned) {
    warned = true;
    for (const p of unresolved) {
      const e = p.def.geometryEvidence!;
      console.error(
        `warning: ${label(p)} is drawn from UNVERIFIED geometry. ${e.reason} Not known: ${e.unknown.join("; ")}. Measure the part you have, write the corrected file to <projectDir>/parts/${p.def.id}.json, and rebuild before printing the case. Print the fit test first. (--strict-geometry makes this an error.)`,
      );
    }
  }
  return unresolved;
}

/** For tests: the warning is printed once per process, so a test must be able to reset that. */
export function resetGeometryWarning(): void {
  warned = false;
}
