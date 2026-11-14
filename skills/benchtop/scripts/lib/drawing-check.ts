// The drawing check: reads the geometry of a drawing and reports what a builder would
// not be able to read in it.
//
// Every check is a pure function of the geometry renderScene returns (solids, pads,
// wire paths, text boxes, guide lines), never of pixels, so each one can be tested
// with a handful of numbers. The checks measure with the same functions the renderer
// draws with (geom.ts) but recompute everything from positions: a wire end is tested
// against the solids again here, whatever the renderer believed when it drew the dot.
// That is what lets a check catch a fault in the renderer itself.
//
// guide.ts runs these on every drawing of every build and prints one line per problem.

import {
  type Pt,
  type V3,
  backtrack,
  circlePoly,
  clipToConvex,
  inflate,
  isHiddenBy,
  isInside,
  overlapDepth,
  pointInConvex,
  polylineHitsConvex,
  proj,
  sharpestTurn,
} from "./geom";
import { type DrawnLabel, type DrawnSolid, type SceneGeom, type Solid, WIRE_HALF, WIRE_MIN, footprint, solidName } from "./iso";
import type { WiringStepGeom } from "./scenes";
import type { PlacedPart } from "./types";

export type CheckId =
  | "geometry-unresolved"
  | "wire-end-hidden"
  | "wire-end-off-pad"
  | "wire-reversal"
  | "wire-through-part"
  | "label-overlap"
  | "label-hidden"
  | "label-under-line"
  | "label-missing"
  | "bubble-target-hidden"
  | "bubble-overlap"
  | "hover-overlap"
  | "guide-over-solid"
  | "parts-intersect"
  | "bench-overlap"
  | "page-overflow";

export interface Problem {
  /**
   * "finding" (the default) is something the builder can act on and fails --strict.
   * "note" is information about a drawing that is right as it stands, such as a pad
   * that is drawn through the part in front of it because no side shows it.
   */
  level?: "finding" | "note";
  /** Pin the problem is about, when it is about one. */
  pin?: string;
  check: CheckId;
  /** Ref of the part to change, when there is one. */
  part?: string;
  /** What is wrong, as a sentence. */
  what: string;
  /** What to change in project.json or the part file. */
  fix: string;
}

/** How the check names things in its messages. guide.ts fills these in from the project. */
export interface Names {
  /** "Button" for ref "btn". */
  label: (ref: string) => string;
  /** "assets/parts/tactile-button-6mm-tall.json" for ref "btn". */
  file: (ref: string) => string;
}

const PLAIN: Names = { label: (ref) => ref, file: (ref) => `the part file of "${ref}"` };

/**
 * A wire may turn this many degrees inside TURN_WINDOW millimetres of travel before it
 * reads as folded back. The renderer's own wires stay under 50 for every position of
 * two pads; the hooks and spikes this check exists for start at about 85.
 */
export const MAX_TURN = 70;
export const TURN_WINDOW = 1.5;
/** Overlaps smaller than this are line-weight noise, not collisions. */
const TOUCH = 0.05;
const RENDERER_FAULT = "This is a fault in the renderer, not in the project: report it with the project folder.";

const blocksOf = (g: SceneGeom): DrawnSolid[] => g.solids.filter((s) => !s.ghost);

function hiders(p: V3, solids: readonly DrawnSolid[]): Solid[] {
  return solids.filter((s) => isHiddenBy(p, s.solid)).map((s) => s.solid);
}

const list = (xs: string[]): string => (xs.length > 1 ? `${xs.slice(0, -1).join(", ")} and ${xs[xs.length - 1]}` : (xs[0] ?? ""));

/** What to change when a pad cannot be seen. A pin already drawn as a lead needs a longer lead, not a `z`. */
function turnAdvice(g: SceneGeom, ref: string, pin: string, names: Names): string {
  const turn = `Run "bun guide.ts <projectDir> --explain": it lists, for part "${ref}", the "bench" value (x, y, rot) that shows this pad, or says that no turn does; paste that value into project.json. `;
  const isLead = g.solids.some((s) => s.solid.part === ref && s.solid.tag === `lead ${pin}`);
  return (
    turn +
    (isLead
      ? `If the real lead is long enough to reach past the part, say so with "lead" (its length in mm) on pin "${pin}" in ${names.file(ref)}.`
      : `If the lead really leaves the body lower down than its top face, give pin "${pin}" a "z" in ${names.file(ref)}.`)
  );
}

// ---------------------------------------------------------------------------
// Wires
// ---------------------------------------------------------------------------

/**
 * A wire being added must end on a pad the builder can see, and its solder dot must be
 * on that pad. Fires when the pad is behind a solid (and says so if a dot was painted
 * over the solid anyway), and when the dot and the drawn pad are in different places.
 */
export function wireEndProblems(g: SceneGeom, names: Names = PLAIN): Problem[] {
  const out: Problem[] = [];
  const solids = blocksOf(g);
  for (const w of g.wires.filter((x) => x.state === "now")) {
    for (const e of w.ends) {
      const ref = e.pad?.ref;
      const pin = e.pad?.pin ?? "?";
      const who = ref ? `the ${names.label(ref)} pad ${pin}` : "a wire end";
      const behind = hiders(e.at, solids);
      if (behind.length) {
        const by = list(behind.map(solidName));
        out.push({
          check: "wire-end-hidden",
          pin,
          part: ref,
          what: e.dot
            ? `${who} is behind ${by}, and the wire's solder dot is painted on top of ${by} instead of on a pad.`
            : `${who} is behind ${by} in the step's main view, so the wire is drawn passing behind it.`,
          fix: ref ? turnAdvice(g, ref, pin, names) : RENDERER_FAULT,
        });
        continue;
      }
      if (!e.pad) continue;
      const pad = g.pads.find((p) => p.part === e.pad!.ref && p.pin === e.pad!.pin);
      if (!pad) {
        out.push({ check: "wire-end-off-pad", part: ref, what: `the wire ends at ${who}, but no pad of that name is drawn on the part.`, fix: RENDERER_FAULT });
      } else if (!e.dot || Math.hypot(e.dot[0] - pad.screen[0], e.dot[1] - pad.screen[1]) > 0.3) {
        const off = e.dot ? `${Math.hypot(e.dot[0] - pad.screen[0], e.dot[1] - pad.screen[1]).toFixed(1)} mm from` : "missing from";
        out.push({ check: "wire-end-off-pad", part: ref, what: `the wire's solder dot is ${off} ${who}.`, fix: RENDERER_FAULT });
      }
    }
  }
  return out;
}

/**
 * A wire must run from one pad to the other without folding back on itself or passing
 * through a part. Fires on a turn sharper than MAX_TURN inside TURN_WINDOW mm, on any
 * travel back past its own start or finish, and on a path that enters a solid.
 */
export function wirePathProblems(g: SceneGeom, names: Names = PLAIN): Problem[] {
  const out: Problem[] = [];
  const solids = blocksOf(g);
  for (const w of g.wires.filter((x) => x.state === "now")) {
    const [a, b] = w.ends;
    const who = a.pad && b.pad ? `the wire from ${names.label(a.pad.ref)} ${a.pad.pin} to ${names.label(b.pad.ref)} ${b.pad.pin}` : "a wire";
    const turn = sharpestTurn(w.path, TURN_WINDOW);
    const back = backtrack(w.path);
    const apart = Math.hypot(a.screen[0] - b.screen[0], a.screen[1] - b.screen[1]);
    if (apart < WIRE_MIN) {
      // One pad is in front of the other as seen from the viewer: no wire can be drawn between them.
      // Two pads of one part keep their distance whatever the bench says, so there is nothing to move.
      const samePart = !!a.pad && !!b.pad && a.pad.ref === b.pad.ref;
      out.push({
        level: samePart ? "note" : "finding",
        check: "wire-reversal",
        part: a.pad?.ref,
        what: `${who} has its two ends only ${apart.toFixed(1)} mm apart on the page, one in front of the other, so the wire cannot be shown running between them.`,
        fix: samePart
          ? `Both pads are on part "${a.pad!.ref}", so no bench change moves them apart: the two bubbles each show one end, and the wire is a short hop between neighbouring pads.`
          : a.pad && b.pad
            ? `Move one of the two parts sideways: change "bench": { "x": .., "y": .. } on part "${a.pad.ref}" or "${b.pad.ref}" in project.json.`
            : RENDERER_FAULT,
      });
    } else if (turn > MAX_TURN || back > 0.5) {
      out.push({
        check: "wire-reversal",
        part: a.pad?.ref,
        what:
          turn > MAX_TURN
            ? `${who} folds back on itself: it turns ${turn.toFixed(0)} degrees within ${TURN_WINDOW} mm.`
            : `${who} overshoots its end by ${back.toFixed(1)} mm and comes back.`,
        fix: RENDERER_FAULT,
      });
    }
    const n = w.path3.length;
    const through = new Set<Solid>();
    for (let i = Math.ceil(n * 0.1); i < Math.floor(n * 0.9); i++) {
      for (const s of solids) if (isInside(w.path3[i]!, s.solid, 0.25)) through.add(s.solid);
    }
    // A leg on the underside of its own part (a through-hole key switch, a barrel jack) can
    // only be reached through that part: no place on the bench clears it. That is how the
    // part is built, not something to move, so it is a note. Any other solid is a finding.
    // "Under" is judged against every solid of the part, not only the one the wire crosses: a key
    // switch's leg comes out beside the housing but beneath its flange, and the wire then clips both.
    const covers = (s: Solid, at: V3): boolean => at[2] <= s.z + s.h * 0.25 && at[0] >= s.x - 0.5 && at[0] <= s.x + s.w + 0.5 && at[1] >= s.y - 0.5 && at[1] <= s.y + s.d + 0.5;
    const legUnder = new Set<string>();
    for (const [end, at] of [[a, w.path3[0]!] as const, [b, w.path3[n - 1]!] as const]) {
      const ref = end.pad?.ref;
      if (ref && solids.some((s) => s.solid.part === ref && covers(s.solid, at))) legUnder.add(ref);
    }
    const avoidable = [...through].filter((s) => !(s.part && legUnder.has(s.part)));
    if (avoidable.length) {
      const parts = [...new Set(avoidable.map((s) => s.part).filter((p): p is string => !!p))];
      out.push({
        check: "wire-through-part",
        part: parts[0],
        what: `${who} passes through ${list(avoidable.map(solidName))}.`,
        fix: parts.length
          ? `Move ${list(parts.map((p) => `"${p}"`))} out of the wire's way with "bench": { "x": .., "y": .. } in project.json, or turn the part the wire starts from so its pad faces the other end.`
          : RENDERER_FAULT,
      });
    } else if (through.size) {
      const own = [...new Set([...through].map((s) => s.part).filter((p): p is string => !!p))];
      out.push({
        level: "note",
        check: "wire-through-part",
        part: own[0],
        what: `${who} ends at a leg on the underside of ${list(own.map((p) => names.label(p)))}, so its last stretch is drawn through the part.`,
        fix: "Nothing to move: this part's legs are under its body. Turn the part over to solder the wire on, then set it back.",
      });
    }
  }
  return out;
}

// ---------------------------------------------------------------------------
// Labels
// ---------------------------------------------------------------------------

const labelName = (l: DrawnLabel, names: Names): string => (l.pin && l.part ? `the pin label "${l.text}" on ${names.label(l.part)}` : `the label "${l.text}"`);

/**
 * Every piece of text must be readable: no two text boxes may overlap, a label lying
 * on a part or on the bench must not be behind a solid, an upright label must not sit
 * across the outline of a hovering part, and no wire being added or guide line may run
 * through a label.
 */
export function labelProblems(g: SceneGeom, names: Names = PLAIN, extra: readonly DrawnLabel[] = []): Problem[] {
  const out: Problem[] = [];
  const solids = blocksOf(g);
  const labels = [...g.labels, ...extra];
  for (let i = 0; i < labels.length; i++) {
    for (let j = i + 1; j < labels.length; j++) {
      if (overlapDepth(labels[i]!.quad, labels[j]!.quad) > TOUCH) {
        const pinLabels = !!labels[i]!.pin && !!labels[j]!.pin;
        out.push({
          check: "label-overlap",
          part: labels[i]!.part,
          what: `${labelName(labels[i]!, names)} and ${labelName(labels[j]!, names)} overlap.`,
          fix: pinLabels
            ? RENDERER_FAULT
            : `Shorten the "label" of ${list([...new Set([labels[i]!.part, labels[j]!.part].filter((p): p is string => !!p))].map((p) => `"${p}"`)) || "the part"} in project.json.`,
        });
      }
    }
  }
  for (const l of labels) {
    const behind = new Set<Solid>();
    for (const p of l.samples ?? []) for (const s of hiders(p, solids)) behind.add(s);
    if (l.kind === "ground") {
      for (const s of g.solids) if (overlapDepth(l.quad, s.outline) > TOUCH) behind.add(s.solid);
    }
    if (l.kind === "free") {
      for (const s of g.solids) {
        if (!s.solid.hover || overlapDepth(l.quad, s.outline) <= TOUCH) continue;
        // Its own part may carry the name, but only wholly on it, never across its edge.
        const own = s.solid.hover.item === l.part && l.quad.every((p) => pointInConvex(p, s.outline));
        if (!own) behind.add(s.solid);
      }
    }
    if (behind.size) {
      out.push({
        check: "label-hidden",
        part: l.part,
        what: `${labelName(l, names)} is covered by ${list([...behind].map(solidName))}.`,
        fix: l.pin && l.part
          ? `Turn the part so that pad has clear board or bench beside it: set "bench": { "rot": .. } on part "${l.part}" in project.json.`
          : RENDERER_FAULT,
      });
    }
    const struck: string[] = [];
    for (const w of g.wires.filter((x) => x.state === "now")) {
      if (w.runs.some((run) => polylineHitsConvex(run, l.quad, WIRE_HALF))) struck.push("the wire being added");
      else if (w.ends.some((e) => e.dot && pointInConvex(e.dot, inflate(l.quad, 0.8)))) struck.push("the wire's solder dot");
    }
    if (g.guides.some((gd) => gd.drawn.some(([a, b]) => clipToConvex(a, b, l.quad)))) struck.push("a guide line");
    if (struck.length) {
      out.push({
        check: "label-under-line",
        part: l.part,
        what: `${labelName(l, names)} is crossed by ${list([...new Set(struck)])}.`,
        fix: l.pin && l.part ? `Turn the part so the wire leaves away from the label: set "bench": { "rot": .. } on part "${l.part}" in project.json.` : RENDERER_FAULT,
      });
    }
  }
  return out;
}

// ---------------------------------------------------------------------------
// Guides, hovering parts, solids
// ---------------------------------------------------------------------------

/** A guide line must stop where a solid is in front of it. Fires when a painted stretch is behind one. */
export function guideProblems(g: SceneGeom): Problem[] {
  const solids = blocksOf(g);
  const over = new Set<Solid>();
  let count = 0;
  for (const gd of g.guides) {
    let bad = false;
    for (const [p, q] of gd.runs) {
      for (const t of [0.1, 0.2, 0.3, 0.4, 0.5, 0.6, 0.7, 0.8, 0.9]) {
        const m: V3 = [p[0] + (q[0] - p[0]) * t, p[1] + (q[1] - p[1]) * t, p[2] + (q[2] - p[2]) * t];
        for (const s of hiders(m, solids)) {
          over.add(s);
          bad = true;
        }
      }
    }
    if (bad) count++;
  }
  if (!count) return [];
  return [
    {
      check: "guide-over-solid",
      part: [...over][0]?.part,
      what: `${count} guide line${count > 1 ? "s are" : " is"} drawn across ${list([...over].map(solidName))}, which ${over.size > 1 ? "are" : "is"} in front of ${count > 1 ? "them" : "it"}.`,
      fix: RENDERER_FAULT,
    },
  ];
}

/** Parts hovering in one step must not overlap each other on the page. */
export function hoverProblems(g: SceneGeom, names: Names = PLAIN): Problem[] {
  const out: Problem[] = [];
  const items = new Map<string, { group: string; item: string; outlines: Pt[][] }>();
  for (const s of g.solids) {
    const h = s.solid.hover;
    if (!h) continue;
    const key = `${h.group}\u0000${h.item}`;
    if (!items.has(key)) items.set(key, { group: h.group, item: h.item, outlines: [] });
    items.get(key)!.outlines.push(s.outline);
  }
  const all = [...items.values()];
  for (let i = 0; i < all.length; i++) {
    for (let j = i + 1; j < all.length; j++) {
      const a = all[i]!;
      const b = all[j]!;
      if (a.group !== b.group) continue;
      const deep = Math.max(...a.outlines.flatMap((p) => b.outlines.map((q) => overlapDepth(p, q))));
      if (deep > 0.1) {
        out.push({
          check: "hover-overlap",
          part: a.item,
          what: `${names.label(a.item)} and ${names.label(b.item)} overlap by ${deep.toFixed(1)} mm where they hover before being fitted, so their outlines run into each other.`,
          fix: `Move the two apart in the enclosure: change x and y of "${a.item}" or "${b.item}" under enclosure.mounts in project.json.`,
        });
      }
    }
  }
  return out;
}

/** Two different parts must not occupy the same space; where they do, what hides what is undefined. */
export function intersectProblems(g: SceneGeom, names: Names = PLAIN): Problem[] {
  const out: Problem[] = [];
  const seen = new Set<string>();
  const solids = blocksOf(g).map((s) => s.solid);
  const lap = (a0: number, a1: number, b0: number, b1: number): number => Math.min(a1, b1) - Math.max(a0, b0);
  for (let i = 0; i < solids.length; i++) {
    for (let j = i + 1; j < solids.length; j++) {
      const a = solids[i]!;
      const b = solids[j]!;
      if (!a.part || !b.part || a.part === b.part) continue;
      if (lap(a.x, a.x + a.w, b.x, b.x + b.w) < 0.3 || lap(a.y, a.y + a.d, b.y, b.y + b.d) < 0.3 || lap(a.z, a.z + a.h, b.z, b.z + b.h) < 0.3) continue;
      const key = [a.part, b.part].sort().join("\u0000");
      if (seen.has(key)) continue;
      seen.add(key);
      out.push({
        check: "parts-intersect",
        part: a.part,
        what: `${names.label(a.part)} and ${names.label(b.part)} occupy the same space, so neither can be drawn in front of the other.`,
        fix: `Move one of them: change "bench": { "x": .., "y": .. } on part "${a.part}" or "${b.part}" in project.json.`,
      });
    }
  }
  return out;
}

/** Every check that applies to a single scene. */
export function checkScene(g: SceneGeom, names: Names = PLAIN): Problem[] {
  return [
    ...wireEndProblems(g, names),
    ...wirePathProblems(g, names),
    ...labelProblems(g, names),
    ...guideProblems(g),
    ...hoverProblems(g, names),
    ...intersectProblems(g, names),
  ];
}

// ---------------------------------------------------------------------------
// Wiring steps
// ---------------------------------------------------------------------------

/**
 * A bubble exists to show one pad. Fires when that pad is behind a solid inside the
 * bubble, when the pad is not drawn there at all, when its name has no place beside it
 * or falls outside the circle, and when the two bubbles of a step overlap.
 */
export function bubbleProblems(step: WiringStepGeom, names: Names = PLAIN): Problem[] {
  const out: Problem[] = [];
  for (const b of step.bubbles) {
    const { ref, pin, at } = b.target;
    const who = `the ${names.label(ref)} pad ${pin}`;
    const behind = hiders(at, blocksOf(b.geom));
    const t = proj(...at);
    const pad = b.geom.pads.find((p) => p.part === ref && p.pin === pin);
    if (behind.length) {
      out.push({ check: "bubble-target-hidden", part: ref, what: `in its bubble, ${who} is behind ${list(behind.map(solidName))}.`, fix: turnAdvice(b.geom, ref, pin, names) });
    } else if (!pad || !pad.target || Math.hypot(pad.screen[0] - t[0], pad.screen[1] - t[1]) > 0.3) {
      out.push({ check: "bubble-target-hidden", part: ref, what: `the bubble for ${who} is not centred on a drawn pad of that name.`, fix: RENDERER_FAULT });
    }
    const label = b.geom.labels.find((l) => l.part === ref && l.pin === pin);
    const reach = b.radius / b.zoom;
    if (!label) {
      out.push({
        check: "label-missing",
        part: ref,
        what: `the name of ${who} cannot be shown beside the pad: there is no free place for it next to the pad.`,
        fix: RENDERER_FAULT,
      });
    } else if (label.quad.some((p) => Math.hypot(p[0] - t[0], p[1] - t[1]) > reach)) {
      out.push({
        check: "label-missing",
        part: ref,
        what: `the name of ${who} is cut off by the edge of its bubble.`,
        fix: RENDERER_FAULT,
      });
    }
  }
  for (let i = 0; i < step.bubbles.length; i++) {
    for (let j = i + 1; j < step.bubbles.length; j++) {
      const a = step.bubbles[i]!;
      const b = step.bubbles[j]!;
      if (Math.hypot(a.centre[0] - b.centre[0], a.centre[1] - b.centre[1]) < a.radius + b.radius) {
        out.push({ check: "bubble-overlap", part: a.target.ref, what: `the two bubbles of the step overlap.`, fix: RENDERER_FAULT });
      }
    }
  }
  for (const c of step.captions) {
    for (const b of step.bubbles) {
      if (overlapDepth(c.quad, circlePoly(b.centre, b.radius, 24)) > TOUCH) {
        out.push({ check: "label-overlap", part: c.part, what: `the caption "${c.text}" runs into a bubble.`, fix: `Shorten the "label" of part "${c.part}" in project.json.` });
      }
    }
  }
  return out;
}

/**
 * A wired pad that is behind something in the step's main view. If turning its part
 * would show it, that is a finding that names the turn; if no turn of the bench or the
 * part does, the step draws it through the part in its bubble, which is a note.
 */
function hiddenPadProblems(step: WiringStepGeom, names: Names): Problem[] {
  const out: Problem[] = [];
  for (const h of step.hidden ?? []) {
    const who = `the ${names.label(h.ref)} pad ${h.pin}`;
    const by = list(h.by);
    const shown = step.bubbles.some((b) => b.target.ref === h.ref && b.target.pin === h.pin && b.seeThrough);
    if (h.turn) {
      out.push({
        level: "finding",
        check: "wire-end-hidden",
        part: h.ref,
        what: `${who} is behind ${by} in the step's main view, so the wire is drawn passing behind it.`,
        fix: `Turn the part ${h.turn.degrees} degrees: set "bench": { "x": ${h.turn.x}, "y": ${h.turn.y}, "rot": ${h.turn.rot} } on part "${h.ref}" in project.json; that shows the pad. If the real lead leaves the body lower down than its top face, give pin "${h.pin}" a "z" in ${names.file(h.ref)}.`,
      });
    } else if (shown) {
      out.push({
        level: "note",
        check: "wire-end-hidden",
        part: h.ref,
        what: `${who} is behind ${by} in the step's main view, and no turn of its part shows it without hiding another wired pad, so the step draws it through ${by} in its bubble.`,
        fix: "Nothing to fix: the bubble shows the pad and the end of the wire through the dashed outline.",
      });
    } else {
      out.push({
        level: "finding",
        check: "wire-end-hidden",
        part: h.ref,
        what: `${who} is behind ${by} from every side and its bubble cannot show it either.`,
        fix: `No turn of the bench or of part "${h.ref}" shows it. Give the pin a "z" in ${names.file(h.ref)} if its lead really leaves lower down, or move the part so nothing stands in front of it.`,
      });
    }
  }
  return out;
}

/**
 * Footprints the project's own `bench` values put on top of each other. Free parts are
 * laid out around placed ones, so this only fires when two `bench` values collide (or a
 * `bench` lands on a free part's row, which is also named).
 */
export function benchOverlapProblems(parts: readonly PlacedPart[], names: Names = PLAIN): Problem[] {
  const out: Problem[] = [];
  const lap = (a0: number, a1: number, b0: number, b1: number): number => Math.min(a1, b1) - Math.max(a0, b0);
  for (let i = 0; i < parts.length; i++) {
    for (let j = i + 1; j < parts.length; j++) {
      const a = parts[i]!;
      const b = parts[j]!;
      const fa = footprint(a);
      const fb = footprint(b);
      const dx = lap(a.at.x, a.at.x + fa.w, b.at.x, b.at.x + fb.w);
      const dy = lap(a.at.y, a.at.y + fa.d, b.at.y, b.at.y + fb.d);
      if (dx < 0.3 || dy < 0.3) continue;
      const free = b.at.x + fb.w + 5;
      out.push({
        check: "bench-overlap",
        part: a.use.ref,
        what: `${names.label(a.use.ref)} and ${names.label(b.use.ref)} are placed on top of each other on the bench: their outlines overlap by ${dx.toFixed(1)} x ${dy.toFixed(1)} mm.`,
        fix: `Move one of them: for example set "bench": { "x": ${Math.round(free * 10) / 10}, "y": ${Math.round(b.at.y * 10) / 10} } on part "${a.use.ref}" (to the right of "${b.use.ref}"), or drop "bench" from one so the layout places it. "bench" is millimetres from the part's top-left corner as seen from above; see guide.md.`,
      });
    }
  }
  return out;
}

/**
 * Names that a step's bubble leaves out: the pads next to the target that are in the
 * bubble but have no name written beside them (no room, or the bubble is a detail that
 * names only its own pad). They are listed so a missing neighbour name is never a surprise.
 */
export function stepNotes(step: WiringStepGeom, names: Names = PLAIN): Problem[] {
  const out: Problem[] = [];
  for (const b of step.bubbles) {
    const t = proj(...b.target.at);
    const reach = b.radius / b.zoom;
    const unnamed = b.geom.pads
      .filter((p) => !(p.part === b.target.ref && p.pin === b.target.pin) && p.pin && Math.hypot(p.screen[0] - t[0], p.screen[1] - t[1]) <= reach)
      .filter((p) => !b.geom.labels.some((l) => l.part === p.part && l.pin === p.pin))
      .map((p) => `${p.part ? names.label(p.part) : ""} ${p.pin}`.trim());
    if (unnamed.length) {
      out.push({
        level: "note",
        check: "label-missing",
        part: b.target.ref,
        what: `in the ${names.label(b.target.ref)} ${b.target.pin} bubble, the names of the neighbouring pads ${list([...new Set(unnamed)])} are not written beside them.`,
        fix: "Nothing to fix: the bubble names the pad being wired; the neighbours are named in their own steps.",
      });
    }
  }
  return out;
}

/** The main view of a step with the labels the drawing's frame cuts off left out: nobody can read them, so they cannot overlap anything. */
function visibleLabels(step: WiringStepGeom): SceneGeom {
  const v = step.view;
  if (!v) return step.main;
  const inside = (q: readonly Pt[]): boolean => q.some((p) => p[0] >= v.minX && p[0] <= v.maxX && p[1] >= v.minY && p[1] <= v.maxY);
  return { ...step.main, labels: step.main.labels.filter((l) => inside(l.quad)) };
}

/** Every check for one wiring step: its main view, both bubbles and the captions. */
export function checkWiringStep(step: WiringStepGeom, names: Names = PLAIN): Problem[] {
  // A pad the step already knows is hidden in its main view is judged below, with what
  // would clear it; the plain "behind" finding only stays for an end the step did not account for.
  const known = new Set((step.hidden ?? []).map((h) => `${h.ref}.${h.pin}`));
  const ends = wireEndProblems(step.main, names).filter((p) => !(p.check === "wire-end-hidden" && p.part && known.has(`${p.part}.${/ pad (\S+) is behind/.exec(p.what)?.[1] ?? ""}`)));
  const out = [...ends, ...hiddenPadProblems(step, names), ...wirePathProblems(step.main, names), ...labelProblems(visibleLabels(step), names, step.captions), ...intersectProblems(step.main, names)];
  for (const b of step.bubbles) {
    // A bubble that was drawn again with a see-through solid has labels of its own to check.
    if (b.seeThrough || b.detailCallout) out.push(...labelProblems(b.geom, names).map((p) => ({ ...p, what: `in the ${names.label(b.target.ref)} ${b.target.pin} bubble, ${p.what}` })));
  }
  out.push(...bubbleProblems(step, names));
  return dedupe(out);
}

export function dedupe(problems: readonly Problem[]): Problem[] {
  const seen = new Set<string>();
  return problems.filter((p) => {
    const key = `${p.check}|${p.what}`;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

// ---------------------------------------------------------------------------
// Reporting
// ---------------------------------------------------------------------------

export interface Finding extends Problem {
  page: number;
  /** Step number as printed in the booklet, when the drawing is a step. */
  step?: number;
  /** What the drawing is, e.g. "Controller 3V3 to Display VCC" or "inventory". */
  drawing: string;
}

const cap = (s: string): string => s.charAt(0).toUpperCase() + s.slice(1);

/** One plain line: where, what, and what to change. */
export function formatFinding(f: Finding): string {
  const where = `page ${f.page}${f.step !== undefined ? `, step ${f.step}` : ""} (${f.drawing})`;
  return `drawing: ${where}${f.part ? `, part "${f.part}"` : ""}: ${cap(f.what)} ${f.fix}`;
}
