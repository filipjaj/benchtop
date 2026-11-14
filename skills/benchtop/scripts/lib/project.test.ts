// A part that repeats per unit (an LED strip cut to N pixels) must reach every consumer
// as an ordinary part of the right length. The library strip is used as it ships, so a
// change to its file that breaks the expansion shows up here.

import { describe, expect, test } from "bun:test";
import { BUTTON, load } from "./drawing-fixtures";
import { ProjectError, expandRepeat, loadPartDefs, resolveProject } from "./project";
import type { PartDef, Project } from "./types";

const defs = await loadPartDefs();
const strip = defs.get("ws2812b-strip")!;
const PITCH = strip.repeat!.pitch;

const leds = (d: PartDef) => (d.shapes ?? []).filter((s) => s.tag?.startsWith("led-"));
const windowOf = (d: PartDef) => d.ports!.find((p) => p.name === "light window")!;

describe("expanding a part that repeats per unit", () => {
  test("8 pixels at 60 LEDs/m make a body of about 133 mm with 8 LEDs and a window over all of them", () => {
    const d = expandRepeat(strip, 8, "bar");
    expect(d.body.w).toBeCloseTo(8 * PITCH, 6);
    expect(d.body.w).toBeGreaterThan(133);
    expect(d.body.w).toBeLessThan(134);
    expect(d.body.d).toBe(strip.body.d);
    expect(leds(d)).toHaveLength(8);
    expect(leds(d).map((s) => s.tag)).toEqual(["led-1", "led-2", "led-3", "led-4", "led-5", "led-6", "led-7", "led-8"]);
    // One pitch between neighbours, and the last LED still on the body.
    const xs = leds(d).map((s) => (s as { x: number }).x);
    xs.slice(1).forEach((x, i) => expect(x - xs[i]!).toBeCloseTo(PITCH, 9));
    expect(xs[7]! + 5).toBeLessThanOrEqual(d.body.w);
    // The window grows by 7 pitches and stays centred on the run of LEDs.
    const win = windowOf(d);
    const base = windowOf(strip);
    expect(win.w).toBeCloseTo(base.w + 7 * PITCH, 9);
    expect(win.x - win.w / 2).toBeCloseTo(base.x - base.w / 2, 9);
    expect(win.y).toBe(base.y);
    expect(win.h).toBe(base.h);
    const first = leds(d)[0] as { x: number };
    const last = leds(d)[7] as { x: number };
    expect(win.x - win.w / 2).toBeLessThan(first.x);
    expect(win.x + win.w / 2).toBeGreaterThan(last.x + 5);
  });

  test("pins, electrical data and everything else stay as the file says, and the result is an ordinary part", () => {
    const d = expandRepeat(strip, 8, "bar");
    expect(d.pins).toEqual(strip.pins);
    expect(d.electrical).toEqual(strip.electrical);
    expect(d.maxHeight).toBe(strip.maxHeight);
    expect(d.repeat).toBeUndefined();
    // Expanding what was already expanded changes nothing.
    expect(expandRepeat(d, 3, "bar")).toBe(d);
  });

  test("units missing and units 1 both give one pixel, and the library file is not changed by expanding", () => {
    const before = JSON.stringify(strip);
    const none = expandRepeat(strip, undefined, "bar");
    const one = expandRepeat(strip, 1, "bar");
    expect(one).toEqual(none);
    expect(none.body.w).toBeCloseTo(PITCH, 9);
    expect(leds(none)).toHaveLength(1);
    expect(windowOf(none)).toEqual(windowOf(strip));
    expect(JSON.stringify(strip)).toBe(before);
  });

  test("units must be a whole number of at least 1", () => {
    for (const bad of [0, -2, 2.5, Number.NaN]) expect(() => expandRepeat(strip, bad, "bar")).toThrow(ProjectError);
  });

  test("a span naming no port is an error, not a silently missing window", () => {
    const broken: PartDef = { ...strip, repeat: { ...strip.repeat!, span: "no such port" } };
    expect(() => expandRepeat(broken, 2, "bar")).toThrow(/not the name of a port/);
  });

  test("a part without repeat is returned as it is, whatever units says", () => {
    expect(expandRepeat(BUTTON, 5, "btn")).toBe(BUTTON);
  });
});

describe("what the rest of the skill receives", () => {
  const project = (parts: Project["parts"]): Project => ({
    schema: 1,
    slug: "t",
    name: "T",
    tagline: "t",
    summary: "t",
    build: { path: "wire", joint: "solder", difficulty: 1, minutes: 10 },
    power: { source: "usb", volts: 5, budgetMa: 1000 },
    parts,
    connections: [],
  });

  test("each use gets its own length, from the units on its own entry", () => {
    const loaded = resolveProject(
      project([
        { ref: "a", part: "ws2812b-strip", units: 8 },
        { ref: "b", part: "ws2812b-strip", units: 3 },
        { ref: "c", part: "ws2812b-strip" },
      ]),
      defs,
    );
    const len = (ref: string) => loaded.byRef.get(ref)!.def.body.w;
    expect(len("a")).toBeCloseTo(8 * PITCH, 6);
    expect(len("b")).toBeCloseTo(3 * PITCH, 6);
    expect(len("c")).toBeCloseTo(PITCH, 6);
    // The entry still says what the project said; the BOM and the power checks read `units` from it.
    expect(loaded.byRef.get("a")!.use.units).toBe(8);
  });

  test("the solder pads stay at the input end whatever the length", () => {
    const loaded = load([{ ref: "bar", part: "ws2812b-strip", units: 8 }], [], defs);
    const pins = loaded.byRef.get("bar")!.def.pins;
    expect(pins.map((p) => [p.name, p.x, p.y])).toEqual(strip.pins.map((p) => [p.name, p.x, p.y]));
    expect(Math.max(...pins.map((p) => p.x))).toBeLessThan(PITCH);
  });
});
