// Electrical rule check. Every rule is a small function Ctx -> Finding[]; add a rule by
// writing one and appending it to RULES at the bottom.
//
// Messages are read by an LLM agent and relayed to a hobbyist, so each one says what is
// wrong and why it matters (message) and what to change (fix).

import { findPin, parseEnd, ProjectError } from "./project";
import type { Loaded, Net, NetPin } from "./project";
import type { PartDef, PinCap, PinDef, PlacedPart } from "./types";

export interface Finding {
  level: "error" | "warn" | "info";
  code: string;
  message: string;
  refs: string[];
  fix: string;
}

interface Ctx {
  loaded: Loaded;
  nets: Net[];
  /** "<ref>.<pin name>" -> the net the pin is on. Pins with no connection are absent. */
  netOf: Map<string, Net>;
}

type Rule = (c: Ctx) => Finding[];

const EPS = 1e-6;
const V_TOL = 0.05;

const key = (ref: string, pin: PinDef): string => `${ref}.${pin.name}`;
const pinRef = (np: NetPin): string => key(np.ref, np.pin);
const describe = (np: NetPin): string => `${np.part.def.name} (${np.ref}) pin ${np.pin.name}`;
const isBoard = (np: NetPin): boolean => np.part.def.kind === "board";
const hasCap = (pin: PinDef, cap: PinCap): boolean => pin.caps?.includes(cap) ?? false;
const fmtV = (v: number): string => `${Math.round(v * 100) / 100} V`;
const fmtAddr = (a: number): string => `0x${a.toString(16).toUpperCase().padStart(2, "0")}`;
const uniq = <T>(xs: T[]): T[] => [...new Set(xs)];

function makeCtx(loaded: Loaded): Ctx {
  const netOf = new Map<string, Net>();
  for (const net of loaded.nets) for (const np of net.pins) netOf.set(pinRef(np), net);
  return { loaded, nets: loaded.nets, netOf };
}

/** Voltage a pin forces onto its net, or undefined when it does not drive. */
function drivenVolts(np: NetPin): number | undefined {
  const p = np.pin;
  if (p.role === "power-out") return p.volts;
  if (p.role === "io" && (p.dir === "out" || isBoard(np))) return p.volts ?? np.part.def.electrical.logicVolts;
  return undefined;
}

/** Highest voltage a pin survives, or undefined when it is exempt or unknown. */
function survivesVolts(np: NetPin): number | undefined {
  const p = np.pin;
  if (p.role === "passive" || p.role === "gnd" || p.role === "nc" || p.role === "power-out") return undefined;
  if (p.maxVolts !== undefined) return p.maxVolts;
  if (p.role === "power-in") return undefined;
  const e = np.part.def.electrical;
  if (e.fiveVoltTolerant) return 5.5;
  return e.logicVolts;
}

function railVolts(net: Net): number[] {
  return net.pins
    .filter((p) => p.pin.role === "power-out" && p.pin.volts !== undefined)
    .map((p) => p.pin.volts as number); // filtered on the line above
}

function powerEntry(loaded: Loaded): { part: PlacedPart; pin: PinDef } | { problem: string } {
  const entry = loaded.project.power.entry;
  if (!entry) return { problem: "project.power.entry is not set." };
  let ref: string;
  let pinName: string;
  try {
    ({ ref, pin: pinName } = parseEnd(entry));
  } catch (err) {
    if (err instanceof ProjectError) return { problem: `project.power.entry "${entry}" is malformed. ${err.message}` };
    throw err;
  }
  const part = loaded.byRef.get(ref);
  if (!part) return { problem: `project.power.entry "${entry}" names ref "${ref}", which is not in project.parts.` };
  const pin = findPin(part.def, pinName);
  if (!pin) {
    return {
      problem: `project.power.entry "${entry}": ${part.def.name} has no pin "${pinName}". Its pins are: ${part.def.pins.map((p) => p.name).join(", ")}.`,
    };
  }
  return { part, pin };
}

// ---------------------------------------------------------------- power rails

const railShort: Rule = (c) => {
  const out: Finding[] = [];
  for (const net of c.nets) {
    const rails = net.pins.filter((p) => p.pin.role === "power-out");
    const grounds = net.pins.filter((p) => p.pin.role === "gnd");
    if (rails.length > 0 && grounds.length > 0) {
      const r = rails[0]!;
      const g = grounds[0]!;
      out.push({
        level: "error",
        code: "rail-short",
        message: `${describe(r)} (a power output${r.pin.volts !== undefined ? ` at ${fmtV(r.pin.volts)}` : ""}) is wired to ground pin ${describe(g)} on net "${net.name}". That is a dead short: the supply is pulled to 0 V, so the USB port or regulator will overheat or shut down and parts can be damaged.`,
        refs: [...rails, ...grounds].map(pinRef),
        fix: `Find the connection that joins a power pin to GND and remove it. Check that the wire meant for ${r.pin.name} is not landing on a GND pad next to it.`,
      });
    }
    const levels = rails.filter((p) => p.pin.volts !== undefined);
    const first = levels[0];
    // A backfeed pin (a dev board's 5V pin) accepts an external supply inside its range: a legitimate feed.
    const feeds = (a: NetPin, b: NetPin): boolean =>
      a.pin.backfeed !== undefined &&
      (b.pin.volts as number) >= a.pin.backfeed.minVolts - EPS &&
      (b.pin.volts as number) <= a.pin.backfeed.maxVolts + EPS;
    const other = first
      ? levels.find(
          (p) => Math.abs((p.pin.volts as number) - (first.pin.volts as number)) > V_TOL && !feeds(first, p) && !feeds(p, first),
        )
      : undefined;
    if (first && other) {
      out.push({
        level: "error",
        code: "rail-short",
        message: `${describe(first)} (${fmtV(first.pin.volts as number)}) and ${describe(other)} (${fmtV(other.pin.volts as number)}) are on the same net "${net.name}". Two supplies at different voltages fight each other; the stronger one pushes current into the weaker and one of them can burn out.`,
        refs: levels.map(pinRef),
        fix: `Separate the two rails. Pick one voltage for everything on this net (usually the one the receiving parts are rated for) and connect only that power pin.`,
      });
    }
  }
  return out;
};

const overvoltage: Rule = (c) => {
  const out: Finding[] = [];
  for (const net of c.nets) {
    const drivers: { np: NetPin; v: number }[] = [];
    for (const np of net.pins) {
      const v = drivenVolts(np);
      if (v !== undefined) drivers.push({ np, v });
    }
    if (drivers.length === 0) continue;
    for (const victim of net.pins) {
      const max = survivesVolts(victim);
      if (max === undefined) continue;
      const worst = drivers
        .filter((d) => d.np !== victim && d.v > max + EPS)
        .sort((a, b) => b.v - a.v)[0];
      if (!worst) continue;
      const fromRail = worst.np.pin.role === "power-out";
      const fix = fromRail
        ? `Power ${victim.part.def.name} (${victim.ref}) from a rail at or below ${fmtV(max)} (for example the board's 3V3 pin), or add a regulator between ${worst.np.ref}.${worst.np.pin.name} and ${victim.ref}.${victim.pin.name}.`
        : Math.abs(worst.v - 5) < 0.3 && Math.abs(max - 3.3) < 0.3
          ? `Add a two-resistor voltage divider in the signal line: ${worst.np.ref}.${worst.np.pin.name} to a 1 kohm resistor to ${victim.ref}.${victim.pin.name}, and a 2 kohm resistor from ${victim.ref}.${victim.pin.name} to GND. That turns 5 V into 3.3 V. Or use a bidirectional level shifter module between the two (needed if the line carries data in both directions, such as I2C).`
          : `Bring the signal from ${fmtV(worst.v)} down to at most ${fmtV(max)} with a two-resistor divider (R2 / (R1 + R2) = ${(max / worst.v).toFixed(2)} or less, R1 in series, R2 to GND, 1 kohm to 10 kohm), or use a level shifter module.`;
      out.push({
        level: "error",
        code: "overvoltage",
        message: `${describe(worst.np)} drives ${fmtV(worst.v)} onto net "${net.name}", but ${describe(victim)} only survives ${fmtV(max)}. Over-voltage can permanently damage the input, or the whole chip, sometimes only after it has run for a while.`,
        refs: [pinRef(worst.np), pinRef(victim)],
        fix,
      });
    }
  }
  return out;
};

const noDivider: Rule = (c) => {
  const out: Finding[] = [];
  const isGroundNet = (net: Net | undefined): boolean => net?.pins.some((q) => q.pin.role === "gnd") ?? false;
  for (const r of c.loaded.placed) {
    if (!r.def.id.startsWith("resistor")) continue;
    const sides = r.def.pins.map((pin) => c.netOf.get(key(r.use.ref, pin))).filter((n): n is Net => n !== undefined);
    if (sides.length !== 2 || sides[0] === sides[1]) continue;
    for (const [high, low] of [[sides[0]!, sides[1]!], [sides[1]!, sides[0]!]] as [Net, Net][]) {
      const drivers = high.pins.flatMap((np) => {
        const v = drivenVolts(np);
        return v === undefined ? [] : [{ np, v }];
      });
      let hit: { driver: { np: NetPin; v: number }; victim: NetPin; max: number } | undefined;
      for (const victim of low.pins) {
        if (victim.pin.role !== "io") continue;
        const max = survivesVolts(victim);
        if (max === undefined) continue;
        const driver = drivers.filter((d) => d.v > max + EPS).sort((a, b) => b.v - a.v)[0];
        if (driver && (!hit || driver.v > hit.driver.v)) hit = { driver, victim, max };
      }
      if (!hit) continue;
      const hasLeg = low.pins.some(
        (q) =>
          q.part !== r &&
          q.part.def.id.startsWith("resistor") &&
          q.part.def.pins.some((o) => o !== q.pin && isGroundNet(c.netOf.get(key(q.ref, o)))),
      );
      if (hasLeg) continue;
      const { driver, victim, max } = hit;
      out.push({
        level: "error",
        code: "no-divider",
        message: `${describe(driver.np)} drives ${fmtV(driver.v)}, and the only thing between it and ${describe(victim)} (which survives ${fmtV(max)}) is the single resistor ${r.use.ref}. A series resistor does not lower a voltage: once the input's protection diode conducts, the pin still sits well above its limit and can be damaged.`,
        refs: [pinRef(driver.np), pinRef(victim), r.use.ref],
        fix: `Make it a divider by adding a second resistor from ${victim.ref}.${victim.pin.name} to GND. For 5 V into 3.3 V use 1 kohm from the signal to the pin and 2 kohm from the pin to GND. Or use a level shifter module instead.`,
      });
    }
  }
  return out;
};

const logicLevelLow: Rule = (c) => {
  const out: Finding[] = [];
  for (const net of c.nets) {
    for (const np of net.pins) {
      const need = np.pin.minHighVolts;
      if (need === undefined) continue;
      const isDriver = (d: NetPin): boolean => d.pin.role === "io" && (isBoard(d) || d.pin.dir === "out");
      // Drivers on the same net, plus drivers one two-pin series resistor away (not through ground or supply nets).
      const candidates: { d: NetPin; via?: string }[] = net.pins.filter((d) => d !== np && isDriver(d)).map((d) => ({ d }));
      for (const q of net.pins) {
        if (q.part === np.part || !q.part.def.id.startsWith("resistor") || q.part.def.pins.length !== 2) continue;
        const other = q.part.def.pins.find((pin) => pin !== q.pin);
        const far = other ? c.netOf.get(key(q.ref, other)) : undefined;
        if (!far || far === net || far.pins.some((f) => f.pin.role === "gnd" || f.pin.role === "power-out")) continue;
        for (const d of far.pins) if (isDriver(d)) candidates.push({ d, via: q.ref });
      }
      const weak = candidates
        .flatMap(({ d, via }) => {
          const v = drivenVolts(d);
          return v !== undefined && v < need - EPS ? [{ d, v, via }] : [];
        })
        .sort((a, b) => a.v - b.v)[0];
      if (!weak) continue;
      out.push({
        level: "warn",
        code: "logic-level-low",
        message: `${describe(weak.d)} drives ${fmtV(weak.v)}${weak.via ? ` (through series resistor ${weak.via})` : ""} but ${describe(np)} needs at least ${fmtV(need)} to read a high. That often works with short wires, but it is outside the datasheet, so it can fail with longer wires, a different batch or a warm room.`,
        refs: [pinRef(weak.d), pinRef(np), ...(weak.via ? [weak.via] : [])],
        fix: `Put a level shifter in the signal line (a 74AHCT125 or similar, powered from the higher rail), or power ${np.part.def.name} from a lower rail if it allows, so its threshold drops under ${fmtV(weak.v)}.`,
      });
    }
  }
  return out;
};

/**
 * An input whose "high" is measured from the part's own supply, not from ground: it
 * drives a transistor tied to the supply rail. A lower-voltage controller can pull such
 * a pin low but cannot bring it close enough to the rail to release it, so the part is
 * stuck in its low state. Unlike `logic-level-low` this does not "often work": the gap
 * is volts, not tenths. Found when one of three independent builds wired a low-triggered
 * buzzer to 5 V and switched it from a 3.3 V pin, and every other check passed.
 */
const highBelowSupply: Rule = (c) => {
  const out: Finding[] = [];
  for (const net of c.nets) {
    for (const np of net.pins) {
      const within = np.pin.highWithinOfSupply;
      if (within === undefined) continue;
      const supplyPins = np.part.def.pins.filter((p) => p.role === "power-in");
      const rails = supplyPins.flatMap((p) => {
        const n = c.netOf.get(key(np.ref, p));
        return n ? railVolts(n) : [];
      });
      if (rails.length === 0) continue; // not powered: `unpowered` reports that
      const supply = Math.max(...rails);
      const need = supply - within;
      const weak = net.pins
        .filter((d) => d !== np && d.pin.role === "io" && (isBoard(d) || d.pin.dir === "out"))
        .flatMap((d) => {
          const v = drivenVolts(d);
          return v !== undefined && v < need - EPS ? [{ d, v }] : [];
        })
        .sort((a, b) => a.v - b.v)[0];
      if (!weak) continue;
      const supplyPin = supplyPins[0]!; // rails is non-empty, so there is at least one
      const canRunLower = supplyPin.minVolts !== undefined && supplyPin.minVolts <= weak.v + EPS;
      out.push({
        level: "error",
        code: "high-below-supply",
        message: `${describe(np)} only reads as high within ${fmtV(within)} of its own supply, which is ${fmtV(supply)} here, so it needs ${fmtV(need)}. ${describe(weak.d)} reaches ${fmtV(weak.v)}. The controller can pull the pin low but can never release it: ${np.part.def.name} stays in its low state (a low-triggered buzzer or relay stays on).`,
        refs: [pinRef(weak.d), pinRef(np), key(np.ref, supplyPin)],
        fix: canRunLower
          ? `Power ${np.ref}.${supplyPin.name} from the ${fmtV(weak.v)} rail instead of ${fmtV(supply)}: the part runs from ${fmtV(supplyPin.minVolts!)} upward, and its high level then matches the controller's.`
          : `Switch ${np.ref}.${np.pin.name} through a transistor or a level shifter powered from ${fmtV(supply)}, or choose a version of the part with a ${fmtV(weak.v)} trigger. This part cannot run from ${fmtV(weak.v)}.`,
      });
    }
  }
  return out;
};

const undervoltage: Rule = (c) => {
  const out: Finding[] = [];
  for (const net of c.nets) {
    const levels = railVolts(net);
    if (levels.length === 0) continue;
    const v = Math.min(...levels);
    for (const np of net.pins) {
      if (np.pin.role !== "power-in" || np.pin.minVolts === undefined) continue;
      if (v >= np.pin.minVolts - EPS) continue;
      out.push({
        level: "error",
        code: "undervoltage",
        message: `${describe(np)} needs at least ${fmtV(np.pin.minVolts)} but the rail on net "${net.name}" only provides ${fmtV(v)}. The part will not start, or will misbehave in confusing ways (garbled display, wrong readings, resets).`,
        refs: [pinRef(np)],
        fix: `Connect ${np.ref}.${np.pin.name} to a rail of ${fmtV(np.pin.minVolts)} or more (for example the board's 5V pin), or choose a part that runs at ${fmtV(v)}.`,
      });
    }
  }
  return out;
};

const unpowered: Rule = (c) => {
  const out: Finding[] = [];
  const entry = powerEntry(c.loaded);
  const usb = c.loaded.project.power.source === "usb";
  for (const p of c.loaded.placed) {
    if (p.def.kind === "board") {
      const feedPins = p.def.pins.filter((pin) => pin.backfeed !== undefined);
      const hasIn = p.def.pins.some((pin) => pin.role === "power-in");
      if (usb || (!hasIn && feedPins.length === 0)) continue; // fed through its USB socket
      if ("pin" in entry && entry.part === p) continue; // the project's source is declared to enter here
      const fed = (pin: PinDef): boolean =>
        c.netOf.get(key(p.use.ref, pin))?.pins.some((q) => q.part !== p && q.pin.role === "power-out") ?? false;
      const feedOk = feedPins.some(fed) || p.def.pins.filter((pin) => pin.role === "power-in").some(fed);
      if (feedOk) continue;
      const target = feedPins[0] ?? p.def.pins.find((pin) => pin.role === "power-in")!;
      out.push({
        level: "error",
        code: "unpowered",
        message: `${p.def.name} (${p.use.ref}) has no power: the source is "${c.loaded.project.power.source}", not USB, and nothing feeds ${target.name}. The board will not run.`,
        refs: [key(p.use.ref, target)],
        fix: `Connect the battery or converter output (a power-out pin in the right voltage range) to ${p.use.ref}.${target.name}, and set project.power.entry to "${p.use.ref}.${target.name}".`,
      });
      continue;
    }
    for (const pin of p.def.pins) {
      if (pin.role !== "power-in") continue;
      if ("pin" in entry && entry.part === p && entry.pin === pin) continue; // fed by the project's power source
      const net = c.netOf.get(key(p.use.ref, pin));
      const fed = net?.pins.some((q) => q.pin.role === "power-out") ?? false;
      if (fed) continue;
      out.push({
        level: "error",
        code: "unpowered",
        message: net
          ? `${p.def.name} (${p.use.ref}) pin ${pin.name} is a power input, but net "${net.name}" has no power output on it. The part gets no supply and will do nothing.`
          : `${p.def.name} (${p.use.ref}) pin ${pin.name} is a power input and is not connected to anything. The part gets no supply and will do nothing.`,
        refs: [key(p.use.ref, pin)],
        fix: `Add a connection from a power pin of the controller board (for example 3V3 or 5V, whichever ${p.def.name} is rated for) to ${p.use.ref}.${pin.name}.`,
      });
    }
  }
  return out;
};

const noGround: Rule = (c) => {
  const out: Finding[] = [];
  const boards = c.loaded.placed.filter((p) => p.def.kind === "board");
  if (boards.length === 0) return out;
  const boardGnd = new Set<Net>();
  for (const b of boards) {
    for (const pin of b.def.pins) {
      if (pin.role !== "gnd") continue;
      const net = c.netOf.get(key(b.use.ref, pin));
      if (net) boardGnd.add(net);
    }
  }
  // Every ground pad of one part is the same copper. A part that reaches board ground on
  // one pad (a charger board on its header GND) therefore carries board ground to whatever
  // hangs on its other ground pads (a cell on its battery socket). Spread until stable.
  for (let grew = true; grew; ) {
    grew = false;
    for (const p of c.loaded.placed) {
      const nets = p.def.pins
        .filter((pin) => pin.role === "gnd")
        .map((pin) => c.netOf.get(key(p.use.ref, pin)))
        .filter((net): net is Net => net !== undefined);
      if (!nets.some((net) => boardGnd.has(net))) continue;
      for (const net of nets) {
        if (boardGnd.has(net)) continue;
        boardGnd.add(net);
        grew = true;
      }
    }
  }
  for (const p of c.loaded.placed) {
    if (p.def.kind === "board") continue;
    const grounds = p.def.pins.filter((pin) => pin.role === "gnd");
    if (grounds.length === 0) continue;
    const ok = grounds.some((pin) => {
      const net = c.netOf.get(key(p.use.ref, pin));
      return net !== undefined && boardGnd.has(net);
    });
    if (ok) continue;
    out.push({
      level: "error",
      code: "no-ground",
      message: `${p.def.name} (${p.use.ref}) has no ground connection to the controller board. Signals are measured against ground, so without a shared ground the part sees random voltages and nothing works reliably.`,
      refs: grounds.map((pin) => key(p.use.ref, pin)),
      fix: `Connect ${p.use.ref}.${grounds[0]!.name} to a GND pin of the controller board.`,
    });
  }
  return out;
};

// ---------------------------------------------------------------- pins and signals

function boardPinsWith(def: PartDef, caps: PinCap[]): string[] {
  return def.pins.filter((p) => p.role === "io" && caps.every((cap) => hasCap(p, cap))).map((p) => p.name);
}

const missingCapability: Rule = (c) => {
  const out: Finding[] = [];
  for (const net of c.nets) {
    for (const np of net.pins) {
      const needs = np.pin.needs;
      if (!needs || needs.length === 0 || isBoard(np)) continue;
      const ok = net.pins.some((q) => isBoard(q) && q.pin.role === "io" && needs.every((cap) => hasCap(q.pin, cap)));
      if (ok) continue;
      const boardPins = net.pins.filter((q) => isBoard(q));
      const board = c.loaded.placed.find((p) => p.def.kind === "board");
      const choices = board ? boardPinsWith(board.def, needs) : [];
      out.push({
        level: "error",
        code: "missing-capability",
        message: `${describe(np)} needs a controller pin with ${needs.join(" + ")}, but ${boardPins.length > 0 ? `the board pin it is wired to (${boardPins.map((q) => q.pin.name).join(", ")}) does not have it` : `it is not wired to a controller pin at all`}. The wiring would look right but the signal could not be read or generated.`,
        refs: [pinRef(np), ...boardPins.map(pinRef)],
        fix: choices.length > 0
          ? `Move the wire to a ${board!.def.name} pin that supports ${needs.join(" + ")}: ${choices.slice(0, 8).join(", ")}.`
          : `Use a controller board with a pin that supports ${needs.join(" + ")}.`,
      });
    }
  }
  return out;
};

const inputOnlyDriven: Rule = (c) => {
  const out: Finding[] = [];
  for (const net of c.nets) {
    const inputOnly = net.pins.filter((p) => isBoard(p) && hasCap(p.pin, "input-only"));
    const sinks = net.pins.filter((p) => !isBoard(p) && p.pin.dir === "in");
    for (const a of inputOnly) {
      for (const b of sinks) {
        out.push({
          level: "error",
          code: "input-only-driven",
          message: `${describe(a)} is input-only (it cannot output a signal), but ${describe(b)} is an input that must be driven. The peripheral would never receive anything.`,
          refs: [pinRef(a), pinRef(b)],
          fix: `Move the wire from ${a.pin.name} to an output-capable pin of ${a.part.def.name}. Input-only pins are only suitable for reading sensors and buttons.`,
        });
      }
    }
  }
  return out;
};

function capRule(cap: PinCap, level: Finding["level"], code: string, why: string, fixText: (np: NetPin) => string): Rule {
  return (c) => {
    const out: Finding[] = [];
    for (const net of c.nets) {
      for (const np of net.pins) {
        if (!isBoard(np) || !hasCap(np.pin, cap)) continue;
        out.push({
          level,
          code,
          message: `${describe(np)} is used on net "${net.name}". ${why}${np.pin.note ? ` Pin note: ${np.pin.note}` : ""}`,
          refs: [pinRef(np)],
          fix: fixText(np),
        });
      }
    }
    return out;
  };
}

const flashPin = capRule(
  "flash",
  "error",
  "flash-pin",
  "This pin is wired to the board's built-in flash memory. Connecting anything to it can crash the chip or stop it booting.",
  (np) => `Leave ${np.pin.name} unconnected and move the wire to a free GPIO pin of ${np.part.def.name}.`,
);

const strappingPin = capRule(
  "strapping",
  "warn",
  "strapping-pin",
  "The chip reads this pin at reset to decide how to boot, so an external part pulling it high or low can stop the board starting or uploading.",
  (np) => `Prefer a different GPIO on ${np.part.def.name}. If you must keep ${np.pin.name}, make sure the connected part leaves it at the level the note above requires during reset.`,
);

const usbPin = capRule(
  "usb",
  "warn",
  "usb-pin",
  "This pin is the native USB data line. Using it as a GPIO usually breaks USB serial and uploading.",
  (np) => `Use a different GPIO on ${np.part.def.name} unless this build deliberately gives up USB serial.`,
);

const multipleDrivers: Rule = (c) => {
  const out: Finding[] = [];
  for (const net of c.nets) {
    const outs = net.pins.filter((p) => p.pin.dir === "out");
    if (outs.length < 2) continue;
    out.push({
      level: "error",
      code: "multiple-drivers",
      message: `${outs.map(describe).join(" and ")} all drive net "${net.name}". Two outputs tied together fight when they disagree (one pushes high, the other pulls low), which can overheat or damage both.`,
      refs: outs.map(pinRef),
      fix: `Connect only one of these outputs to the net. If the parts are meant to share a line (a bus), use pins that are bidirectional or open-drain and give them different addresses.`,
    });
  }
  return out;
};

// ---------------------------------------------------------------- I2C

interface Bus {
  sda: Net;
  scl: Net;
  members: PlacedPart[];
}

function lineOf(pin: PinDef): "sda" | "scl" | undefined {
  const names = [pin.name, ...(pin.aliases ?? [])].map((n) => n.toUpperCase());
  if (names.includes("SDA")) return "sda";
  if (names.includes("SCL")) return "scl";
  return undefined;
}

function findBuses(c: Ctx): Bus[] {
  const index = new Map<Net, number>(c.nets.map((n, i) => [n, i]));
  const buses = new Map<string, { sda: Net; scl: Net }>();
  for (const p of c.loaded.placed) {
    // A bus is found from its devices, never from the controller. A controller pin that
    // can be SDA is only SDA when an I2C device is on it; two such pins wired to a
    // buzzer and a button once produced "the I2C bus has no pull-ups" on a project with
    // no I2C in it.
    if (p.def.kind === "board") continue;
    const netFor = (line: "sda" | "scl"): Net | undefined =>
      p.def.pins
        .filter((pin) => lineOf(pin) === line)
        .map((pin) => c.netOf.get(key(p.use.ref, pin)))
        .find((n): n is Net => n !== undefined);
    const sda = netFor("sda");
    const scl = netFor("scl");
    if (!sda || !scl || sda === scl) continue;
    buses.set(`${index.get(sda)}:${index.get(scl)}`, { sda, scl });
  }
  return [...buses.values()].map(({ sda, scl }) => {
    const members = uniq([...sda.pins, ...scl.pins].map((np) => np.part));
    return { sda, scl, members };
  });
}

const i2cAddressClash: Rule = (c) => {
  const out: Finding[] = [];
  for (const bus of findBuses(c)) {
    const withAddr = bus.members.filter((p) => (p.def.electrical.i2cAddresses?.length ?? 0) > 0);
    const defaults = withAddr.map((p) => p.def.electrical.i2cAddresses![0]!);
    for (let i = 0; i < withAddr.length; i++) {
      for (let j = i + 1; j < withAddr.length; j++) {
        const a = withAddr[i]!;
        const b = withAddr[j]!;
        const addrA = a.def.electrical.i2cAddresses!;
        const addrB = b.def.electrical.i2cAddresses!;
        if (addrA[0] !== addrB[0]) continue;
        const free = (addrs: number[]): number[] => addrs.slice(1).filter((x) => !defaults.includes(x));
        const altA = free(addrA);
        const altB = free(addrB);
        const hasAlt = addrA.length > 1 || addrB.length > 1;
        const alt = altB.length > 0 ? { p: b, addr: altB[0]! } : altA.length > 0 ? { p: a, addr: altA[0]! } : undefined;
        const refs = [a.use.ref, b.use.ref];
        const level: Finding["level"] = alt ? "warn" : "error";
        out.push({
          level,
          code: "i2c-address-clash",
          message: `${a.def.name} (${a.use.ref}) and ${b.def.name} (${b.use.ref}) are on the same I2C bus and both answer at ${fmtAddr(addrA[0]!)} by default. The controller cannot tell them apart, so reads and writes hit both or neither.${
            alt ? ` ${alt.p.def.name} can also use ${fmtAddr(alt.addr)}.` : hasAlt ? " Every alternative address is already taken on this bus." : " Neither part offers another address."
          }`,
          refs,
          fix: alt
            ? `Change ${alt.p.use.ref} to address ${fmtAddr(alt.addr)} (usually a solder jumper or address pin on the module; check its silkscreen) and tell the firmware which address each one uses.`
            : `Put one of the two on a separate I2C bus (another pair of SDA/SCL pins, or a TCA9548A multiplexer), or replace one of them with a part that has a different address.`,
        });
      }
    }
  }
  return out;
};

const i2cNoPullups: Rule = (c) => {
  const out: Finding[] = [];
  const pulled = (net: Net): boolean =>
    net.pins.some(
      (np) =>
        np.part.def.id.startsWith("resistor") &&
        np.part.def.pins.some(
          (other) =>
            other !== np.pin && (c.netOf.get(key(np.ref, other))?.pins.some((q) => q.pin.role === "power-out") ?? false),
        ),
    );
  for (const bus of findBuses(c)) {
    if (bus.members.some((p) => p.def.electrical.i2cPullups)) continue;
    if (pulled(bus.sda) && pulled(bus.scl)) continue;
    out.push({
      level: "error",
      code: "i2c-no-pullups",
      message: `The I2C bus on ${bus.sda.name} / ${bus.scl.name} has no pull-up resistors: none of ${bus.members.map((p) => p.use.ref).join(", ")} has them built in. I2C lines can only be pulled low by the devices, so without pull-ups they never return to high and the bus does not work.`,
      refs: [...bus.sda.pins, ...bus.scl.pins].map(pinRef),
      fix: `Add two resistors of 4.7 kohm (library part "resistor-axial", with "value": "4.7 kohm"): one from the SDA net to the 3V3 rail and one from the SCL net to the 3V3 rail. Or add an I2C module that has pull-ups on board.`,
    });
  }
  return out;
};

// ---------------------------------------------------------------- LEDs, current

const ledNoResistor: Rule = (c) => {
  const out: Finding[] = [];
  for (const p of c.loaded.placed) {
    if (!p.def.electrical.needsSeriesResistor) continue;
    const bad: { np: NetPin; to: NetPin }[] = [];
    for (const pin of p.def.pins) {
      if (pin.role === "gnd" || pin.role === "nc") continue;
      const net = c.netOf.get(key(p.use.ref, pin));
      if (!net) continue;
      const np = net.pins.find((q) => q.part === p && q.pin === pin);
      const to = net.pins.find((q) => q.part !== p && ((isBoard(q) && q.pin.role === "io") || q.pin.role === "power-out"));
      if (np && to) bad.push({ np, to });
    }
    if (bad.length === 0) continue;
    const first = bad[0]!;
    out.push({
      level: "error",
      code: "led-no-resistor",
      message: `${p.def.name} (${p.use.ref}) pin ${first.np.pin.name} is wired straight to ${describe(first.to)} with no resistor in between. Nothing limits the current, so the LED (or the pin) burns out within seconds.`,
      refs: [key(p.use.ref, first.np.pin), pinRef(first.to)],
      fix: `Add a resistor of 220 ohm to 330 ohm in series: ${first.to.ref}.${first.to.pin.name} to the resistor, the resistor to ${p.use.ref}.${first.np.pin.name} (use a part with id "resistor" and a value of "220 ohm"). Use 1 kohm for a dimmer, longer-lived LED.`,
    });
  }
  return out;
};

/** Units counted in the power maths: the declared count for per-unit parts (at least 1), else 1. */
const unitCount = (p: PlacedPart): number =>
  p.def.electrical.perUnit && p.use.units !== undefined && p.use.units >= 1 ? p.use.units : 1;
const partPeak = (p: PlacedPart): number => (p.def.electrical.currentMa?.peak ?? 0) * unitCount(p);
/** This build's peak draw: the project's declared limit when set, else the part file's. */
const peak = (p: PlacedPart): number => p.use.peakMa ?? partPeak(p);
const typical = (p: PlacedPart): number => {
  const t = (p.def.electrical.currentMa?.typical ?? 0) * unitCount(p);
  return p.use.peakMa !== undefined ? Math.min(t, p.use.peakMa) : t;
};

const unitsMissing: Rule = (c) => {
  const out: Finding[] = [];
  for (const p of c.loaded.placed) {
    const unit = p.def.electrical.perUnit;
    if (!unit || (p.use.units !== undefined && p.use.units >= 1)) continue;
    out.push({
      level: "warn",
      code: "units-missing",
      message: `${p.def.name} (${p.use.ref}) is specified per ${unit.name}, but the project does not say how many it has, so the power budget counted a single ${unit.name} (${partPeak(p)} mA peak). The real draw is that times the number of ${unit.name}s, which can overload the supply.`,
      refs: [p.use.ref],
      fix: `Set "units" on part ${p.use.ref} to the real number of ${unit.name}s.`,
    });
  }
  return out;
};

const declaredLimit: Rule = (c) => {
  const out: Finding[] = [];
  for (const p of c.loaded.placed) {
    if (p.use.peakMa === undefined) continue;
    const why = p.use.peakMaWhy?.trim() ?? "";
    out.push({
      level: "info",
      code: "declared-limit",
      message: `The power budget assumes ${p.def.name} (${p.use.ref}) never draws more than ${p.use.peakMa} mA, against ${partPeak(p)} mA in the part file. ${why ? `Reason given: "${why}".` : "No reason was given."} The budget is only as good as that limit: if the firmware does not enforce it, the supply can be overloaded.`,
      refs: [p.use.ref],
      fix: `Make sure the firmware enforces the ${p.use.peakMa} mA limit (and say so in the guide), or remove peakMa to budget for the full ${partPeak(p)} mA.`,
    });
    if (!why) {
      out.push({
        level: "error",
        code: "limit-without-reason",
        message: `${p.def.name} (${p.use.ref}) sets peakMa to ${p.use.peakMa} mA without peakMaWhy. A lowered current figure that nobody can check hides the real risk of overloading the supply.`,
        refs: [p.use.ref],
        fix: `Set peakMaWhy on part ${p.use.ref} to what enforces the limit, for example "firmware caps LED brightness at 25 percent", or remove peakMa.`,
      });
    }
  }
  return out;
};

const powerBudget: Rule = (c) => {
  const { budgetMa, source } = c.loaded.project.power;
  const parts = c.loaded.placed;
  const sumPeak = parts.reduce((s, p) => s + peak(p), 0);
  const sumTyp = parts.reduce((s, p) => s + typical(p), 0);
  const top = [...parts].sort((a, b) => peak(b) - peak(a)).slice(0, 3).filter((p) => peak(p) > 0);
  const detail = top.map((p) => `${p.use.ref} ${peak(p)} mA`).join(", ");
  const refs = top.map((p) => p.use.ref);
  if (sumPeak > budgetMa) {
    return [
      {
        level: "error",
        code: "power-budget",
        message: `All parts together can draw ${sumPeak} mA at peak, but the ${source} source supplies only ${budgetMa} mA. Under load the voltage sags, causing resets, flaky radio and a dim or flickering display. Biggest consumers: ${detail}.`,
        refs,
        fix:
          source === "usb" && budgetMa <= 500
            ? `${budgetMa} mA is what a computer's USB port gives. If this device will run from a USB charger, say so: set project.power.budgetMa to the charger's rating (1000 for a 1 A charger, which covers ${sumPeak <= 1000 ? "this build" : "less than this build needs"}) and tell the user a computer port is not enough. Otherwise remove or cap the biggest consumers (peakMa with a firmware limit).`
            : `Use a source with at least ${sumPeak} mA (a 2 A USB adapter or a larger battery), or remove or duty-cycle the biggest consumers. If project.power.budgetMa is wrong, correct it.`,
      },
    ];
  }
  if (sumTyp > budgetMa * 0.8) {
    return [
      {
        level: "warn",
        code: "power-budget",
        message: `Typical consumption is ${sumTyp} mA, over 80% of the ${budgetMa} mA the ${source} source supplies (peak ${sumPeak} mA). There is little headroom, so brown-outs show up when several parts are active at once.`,
        refs,
        fix: `Move to a source with more current, or lower consumption (dim LEDs, sleep between readings).`,
      },
    ];
  }
  return [];
};

const railBudget: Rule = (c) => {
  const out: Finding[] = [];
  for (const net of c.nets) {
    const suppliers = net.pins.filter((p) => p.pin.role === "power-out" && p.pin.supplyMa !== undefined);
    if (suppliers.length === 0) continue;
    const supply = uniq(suppliers.map((s) => s.part)).reduce(
      (sum, part) => sum + Math.max(...suppliers.filter((s) => s.part === part).map((s) => s.pin.supplyMa as number)),
      0,
    );
    const consumers = uniq(
      net.pins.filter((p) => p.pin.role === "power-in" && !suppliers.some((s) => s.part === p.part)).map((p) => p.part),
    );
    const load = consumers.reduce((s, p) => s + peak(p), 0);
    if (load <= supply) continue;
    const s0 = suppliers[0]!;
    out.push({
      level: "error",
      code: "rail-budget",
      message: `${describe(s0)} can supply ${supply} mA, but the parts fed from net "${net.name}" (${consumers.map((p) => p.use.ref).join(", ")}) can draw ${load} mA at peak. An overloaded onboard regulator gets hot, drops its voltage and resets the board.`,
      refs: [pinRef(s0), ...consumers.map((p) => p.use.ref)],
      fix: `Power the heaviest consumer from a separate supply (sharing GND with the board), or use a regulator or source that can deliver at least ${load} mA.`,
    });
  }
  return out;
};

// ---------------------------------------------------------------- wiring hygiene

const crowdedPad: Rule = (c) => {
  if (c.loaded.project.build.path !== "wire") return [];
  const counts = new Map<string, { np: PinDef; ref: string; n: number }>();
  for (const conn of c.loaded.project.connections) {
    for (const end of [conn.from, conn.to]) {
      const { ref, pin } = parseEnd(end);
      const part = c.loaded.byRef.get(ref);
      const def = part ? findPin(part.def, pin) : undefined;
      if (!def) continue;
      const k = key(ref, def);
      const cur = counts.get(k) ?? { np: def, ref, n: 0 };
      cur.n += 1;
      counts.set(k, cur);
    }
  }
  const out: Finding[] = [];
  for (const [k, v] of counts) {
    if (v.n <= 2) continue;
    out.push({
      level: "warn",
      code: "crowded-pad",
      message: `${v.n} wires land on ${k}. A pad or header pin holds one or two wires comfortably; more than that is hard to solder, and a loose wire here can take down the whole circuit.`,
      refs: [k],
      fix: `Join the wires first: twist and solder them into a splice with one wire going to ${k}, or run them to a small power strip on a piece of perfboard (one row for GND, one for the supply) and connect that to the pad with a single wire.`,
    });
  }
  return out;
};

const unusedSignal: Rule = (c) => {
  const out: Finding[] = [];
  for (const p of c.loaded.placed) {
    if (p.def.kind === "board") continue;
    const loose = p.def.pins.filter((pin) => pin.role === "io" && !c.netOf.has(key(p.use.ref, pin)));
    if (loose.length === 0) continue;
    out.push({
      level: "info",
      code: "unused-signal",
      message: `${p.def.name} (${p.use.ref}) has signal pins that are not connected: ${loose.map((l) => l.name).join(", ")}. That is fine if the build does not use those functions.`,
      refs: loose.map((l) => key(p.use.ref, l)),
      fix: `Nothing to do if intentional. Otherwise add a connection for each pin you need to the controller board.`,
    });
  }
  return out;
};

const powerEntryRule: Rule = (c) => {
  const e = powerEntry(c.loaded);
  const board = c.loaded.placed.find((p) => p.def.kind === "board");
  const options = (board?.def.pins ?? [])
    .filter((p) => p.role === "power-in" || (p.role === "power-out" && p.backfeed !== undefined))
    .map((p) => `${board!.use.ref}.${p.name}`);
  const hint = options.length > 0 ? ` Candidate power inputs: ${options.join(", ")}.` : "";
  const usb = c.loaded.project.power.source === "usb";
  // USB: the board is fed through its socket; entry may be omitted or name any board pin.
  if (usb && !c.loaded.project.power.entry) return [];
  if (usb && !("problem" in e) && e.part.def.kind === "board") return [];
  if ("problem" in e) {
    return [
      {
        level: "error",
        code: "power-entry",
        message: `${e.problem} The guide cannot say where the power source plugs in, and the checker cannot tell which part is fed from outside.`,
        refs: [],
        fix: `Set project.power.entry to "<ref>.<pin>" of the pin that receives power from the ${c.loaded.project.power.source} source.${hint}`,
      },
    ];
  }
  const { part, pin } = e;
  const here = `${part.use.ref}.${pin.name}`;
  if (pin.role !== "power-in" && !(pin.role === "power-out" && pin.backfeed)) {
    return [
      {
        level: "error",
        code: "power-entry",
        message: `project.power.entry is ${here}, but that pin's role is "${pin.role}"${pin.role === "power-out" ? " and it has no backfeed range" : ""}, so it is not a power input. Power cannot enter the circuit through it.`,
        refs: [here],
        fix: `Point project.power.entry at a power-in pin or a power-out pin that accepts an external supply.${hint}`,
      },
    ];
  }
  const v = c.loaded.project.power.volts;
  const lo = pin.role === "power-in" ? pin.minVolts : pin.backfeed?.minVolts;
  const hi = pin.role === "power-in" ? pin.maxVolts : pin.backfeed?.maxVolts;
  if ((lo !== undefined && v < lo - EPS) || (hi !== undefined && v > hi + EPS)) {
    return [
      {
        level: "error",
        code: "power-entry",
        message: `The ${c.loaded.project.power.source} source supplies ${fmtV(v)}, but ${here} accepts ${lo !== undefined ? fmtV(lo) : "any"} to ${hi !== undefined ? fmtV(hi) : "any"}. Too low and the board will not run; too high and it can be destroyed.`,
        refs: [here],
        fix: `Use a source inside that range (or a regulator between them), or feed a different power input of ${part.def.name}.`,
      },
    ];
  }
  return [];
};

const RULES: Rule[] = [
  powerEntryRule,
  railShort,
  overvoltage,
  noDivider,
  logicLevelLow,
  highBelowSupply,
  undervoltage,
  unpowered,
  noGround,
  missingCapability,
  inputOnlyDriven,
  flashPin,
  strappingPin,
  usbPin,
  multipleDrivers,
  i2cAddressClash,
  i2cNoPullups,
  ledNoResistor,
  unitsMissing,
  declaredLimit,
  powerBudget,
  railBudget,
  crowdedPad,
  unusedSignal,
];

const ORDER: Record<Finding["level"], number> = { error: 0, warn: 1, info: 2 };

export function checkProject(loaded: Loaded): Finding[] {
  const ctx = makeCtx(loaded);
  const all = RULES.flatMap((rule) => rule(ctx));
  return all
    .map((f, i) => ({ f, i }))
    .sort((a, b) => ORDER[a.f.level] - ORDER[b.f.level] || a.i - b.i)
    .map((x) => x.f);
}
