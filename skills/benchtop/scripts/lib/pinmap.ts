// Firmware pin map: one entry per net that touches a controller pin with a gpio number.
// Pure: no file access. firmware.ts renders it into pins.h, bring-up code and ESPHome YAML.

import type { Loaded, Net, NetPin } from "./project";

export interface PinEntry {
  /** C identifier, always starts with PIN_. */
  name: string;
  gpio: number;
  net: string;
  /** What is on the other end, e.g. "oled.SDA, env.SDA". */
  comment: string;
}

export type PinUse = "bus-sda" | "bus-scl" | "bus-other" | "output" | "input" | "analog";

export interface PinEntryDetail extends PinEntry {
  /** The controller pin itself. */
  controller: NetPin;
  /** Everything else on the net. */
  others: NetPin[];
  use: PinUse;
}

function ident(s: string): string {
  return s
    .toUpperCase()
    .replace(/[^A-Z0-9]+/g, "_")
    .replace(/^_+|_+$/g, "");
}

function classify(others: NetPin[]): PinUse {
  const pins = others.map((o) => o.pin);
  if (pins.some((p) => /^SDA$/i.test(p.name) || p.aliases?.some((a) => /^SDA$/i.test(a)))) return "bus-sda";
  if (pins.some((p) => /^SCL$/i.test(p.name) || p.aliases?.some((a) => /^SCL$/i.test(a)))) return "bus-scl";
  if (pins.some((p) => p.needs?.some((n) => n === "i2c" || n === "spi" || n === "uart"))) return "bus-other";
  if (pins.some((p) => p.needs?.includes("adc"))) return "analog";
  // dir is stated from the peripheral's side: "out" means the peripheral drives the pin.
  if (pins.some((p) => p.dir === "out")) return "input";
  if (pins.some((p) => p.dir === "in")) return "output";
  if (others.some((o) => o.part.def.kind === "input" || o.part.def.kind === "sensor")) return "input";
  if (others.some((o) => ["actuator", "light", "audio", "display"].includes(o.part.def.kind))) return "output";
  return "input";
}

/** Same as pinMap, with the pins behind each entry and a guess at which way the signal flows. */
export function pinMapDetailed(loaded: Loaded): PinEntryDetail[] {
  const explicit = new Set(loaded.project.connections.map((c) => c.net).filter((n): n is string => !!n));
  const entries: PinEntryDetail[] = [];
  const used = new Set<string>();

  const claim = (base: string): string => {
    let name = base;
    for (let i = 2; used.has(name); i++) name = `${base}_${i}`;
    used.add(name);
    return name;
  };

  const netOf = new Map<string, Net>();
  const connected = new Map<string, NetPin[]>();
  for (const net of loaded.nets as Net[]) {
    for (const np of net.pins) {
      netOf.set(`${np.ref}.${np.pin.name}`, net);
      const list = connected.get(np.ref) ?? [];
      if (!list.some((q) => q.pin.name === np.pin.name)) list.push(np);
      connected.set(np.ref, list);
    }
  }
  const isRail = (n: Net): boolean =>
    n.pins.some((p) => p.pin.role === "gnd" || p.pin.role === "power-out" || p.pin.role === "power-in");
  /** A part with exactly two connected pins, both passive: a resistor-like series element. */
  const seriesPair = (ref: string): NetPin[] | undefined => {
    const pins = connected.get(ref);
    if (!pins || pins.length !== 2 || !pins.every((p) => p.pin.role === "passive")) return undefined;
    // A button is a peripheral, not a pass-through.
    return pins[0]!.part.def.kind === "input" ? undefined : pins;
  };

  interface Found {
    np: NetPin;
    via: string[];
  }
  /** What the net ends in, following up to three series passives and stopping at rails. */
  const trace = (net: Net, entry: NetPin, via: string[], seen: Set<Net>): Found[] => {
    const found: Found[] = [];
    const handled = new Set<string>();
    for (const np of net.pins) {
      if (np === entry || via.includes(np.ref)) continue;
      const pair = seriesPair(np.ref);
      if (!pair) {
        found.push({ np, via });
        continue;
      }
      if (handled.has(np.ref)) continue;
      handled.add(np.ref);
      const far = pair.find((p) => p.pin.name !== np.pin.name)!;
      const farNet = netOf.get(`${far.ref}.${far.pin.name}`)!;
      if (via.length >= 3 || seen.has(farNet) || farNet === net || isRail(farNet)) continue;
      found.push(...trace(farNet, far, [...via, np.ref], new Set([...seen, net])));
    }
    return found;
  };

  for (const net of loaded.nets as Net[]) {
    const controller = net.pins.find((p) => p.part.def.kind === "board" && p.pin.gpio !== undefined);
    if (!controller) continue;
    let traced = trace(net, controller, [], new Set());
    if (!traced.length) traced = net.pins.filter((p) => p !== controller).map((np) => ({ np, via: [] }));
    const others = traced.map((t) => t.np);
    const commentParts = traced.map((t) => `${t.np.ref}.${t.np.pin.name}${t.via.length ? ` via ${t.via.join(", ")}` : ""}`);
    let stem: string;
    if (explicit.has(net.name)) {
      stem = ident(net.name);
    } else {
      const first = others.find((o) => o.part.def.kind !== "board") ?? others[0] ?? controller;
      stem = ident(`${first.ref}_${first.pin.name}`);
    }
    if (!stem) stem = `GPIO${controller.pin.gpio}`;
    if (!stem.startsWith("PIN_")) stem = `PIN_${stem}`;
    entries.push({
      name: claim(stem),
      gpio: controller.pin.gpio!,
      net: net.name,
      comment: commentParts.join(", "),
      controller,
      others,
      use: classify(others),
    });
  }
  return entries;
}

export function pinMap(loaded: Loaded): PinEntry[] {
  return pinMapDetailed(loaded).map(({ name, gpio, net, comment }) => ({ name, gpio, net, comment }));
}

/**
 * Pin constants a hand-written source file uses that the pin map no longer defines.
 *
 * pins.h names each pin after its net, so renaming a net in project.json renames the
 * constant, and a main.cpp written against the old name stops compiling. The generator
 * keeps main.cpp, so it is the one place that can say so at the moment of the rename
 * instead of leaving it to the compiler a step later. Line comments are ignored: a
 * note about an old name is not a use of it.
 */
export function stalePinNames(source: string, defined: readonly string[]): string[] {
  const known = new Set(defined);
  const code = source
    .split("\n")
    .map((line) => line.replace(/\/\/.*$/, ""))
    .join("\n")
    .replace(/\/\*[\s\S]*?\*\//g, "");
  const used = code.match(/\bPIN_[A-Z0-9_]+\b/g) ?? [];
  return [...new Set(used)].filter((name) => !known.has(name)).sort();
}

/** What the bring-up test does with one output pin. */
export interface BringUpPlan {
  /** Level written before anything else, and returned to after a pulse. */
  idle: "HIGH" | "LOW";
  /** True when the test switches the part on for a moment. */
  pulse: boolean;
  /** Who is on the pin, for the serial message. */
  target: string;
  /** Why the pin is not pulsed; empty when it is. */
  why: string;
}

/**
 * Decides, per output pin, whether the bring-up test may exercise it.
 *
 * The first version drove every output high for 400 ms and told the builder, in a code
 * comment, to disconnect motors and relays. In a 50-project evaluation 25 projects had a
 * servo, relay, motor driver or similar on such a pin: the generated test would have
 * moved or switched it the first time the board was powered. It also wrote LOW first,
 * which is the ON level for a low-triggered relay or buzzer.
 *
 * Now: every output goes to its idle level first (`idle` on the far pin, default low),
 * and only a part whose file says `electrical.bringUp: "pulse"` is switched on. Anything
 * else is held and named, including parts nobody reviewed, so the safe behaviour is the
 * default and exercising a part is a decision someone wrote down.
 */
export function bringUpPlan(p: PinEntryDetail): BringUpPlan {
  const targets = p.others.filter((o) => o.part.def.kind !== "passive");
  const idle = targets.some((o) => o.pin.idle === "high") ? "HIGH" : "LOW";
  const names = [...new Set(targets.map((o) => `${o.part.use.label ?? o.part.def.name} (${o.ref})`))];
  const target = names.join(", ") || "nothing but passive parts";
  if (!targets.length) return { idle, pulse: false, target, why: "only passive parts are on this net" };
  const caps = p.controller.pin.caps ?? [];
  if (caps.includes("flash") || caps.includes("usb")) return { idle, pulse: false, target, why: "it is a flash or USB pin of the controller" };
  const held = targets.filter((o) => o.part.def.electrical.bringUp !== "pulse");
  if (held.length) {
    const kinds = [...new Set(held.map((o) => o.part.def.kind))].join(", ");
    return { idle, pulse: false, target, why: `its part file does not mark it as safe to switch in a test (kind: ${kinds})` };
  }
  return { idle, pulse: true, target, why: "" };
}
