import { describe, expect, test } from "bun:test";
import { bringUpPlan, pinMap, pinMapDetailed, stalePinNames } from "./pinmap";
import { resolveProject } from "./project";
import type { PartDef, PinDef, Project } from "./types";

function part(id: string, kind: PartDef["kind"], pins: PinDef[]): PartDef {
  return {
    id,
    name: id,
    kind,
    blurb: "",
    body: { w: 10, d: 10, h: 1 },
    maxHeight: 2,
    pins,
    electrical: {},
    sourcing: { search: [], priceUsd: 1 },
    sources: [],
    confidence: "typical",
  };
}

const io = (name: string, gpio?: number, extra: Partial<PinDef> = {}): PinDef => ({
  name,
  role: "io",
  x: 0,
  y: 0,
  ...(gpio === undefined ? {} : { gpio }),
  ...extra,
});

const defs = new Map<string, PartDef>(
  [
    part("board", "board", [
      io("GPIO6", 6),
      io("GPIO7", 7),
      io("GPIO10", 10),
      io("GPIO3", 3),
      { name: "GND", role: "gnd", x: 0, y: 0 },
      { name: "3V3", role: "power-out", x: 0, y: 0, volts: 3.3 },
    ]),
    part("oled", "display", [io("SDA"), io("SCL"), { name: "GND", role: "gnd", x: 0, y: 0 }]),
    part("sensor", "sensor", [io("SDA"), io("SCL")]),
    part("button", "input", [io("1"), io("2")]),
    part("resistor", "passive", [
      { name: "1", role: "passive", x: 0, y: 0 },
      { name: "2", role: "passive", x: 0, y: 0 },
    ]),
    part("strip", "light", [io("DIN", undefined, { dir: "in" })]),
    part("sonar", "sensor", [io("ECHO", undefined, { dir: "out" })]),
  ].map((d) => [d.id, d]),
);

function project(connections: Project["connections"]): Project {
  return {
    schema: 1,
    slug: "t",
    name: "T",
    tagline: "",
    summary: "",
    build: { path: "wire", difficulty: 1, minutes: 1 },
    power: { source: "usb", volts: 5, budgetMa: 500 },
    parts: [
      { ref: "mcu", part: "board" },
      { ref: "oled", part: "oled" },
      { ref: "env", part: "sensor" },
      { ref: "btn", part: "button" },
      { ref: "r1", part: "resistor" },
      { ref: "r2", part: "resistor" },
      { ref: "strip", part: "strip" },
      { ref: "sonar", part: "sonar" },
    ],
    connections,
  };
}

const map = (connections: Project["connections"]) => pinMap(resolveProject(project(connections), defs));

describe("pinMap", () => {
  test("named nets become PIN_<NET> and list every part on the bus", () => {
    const m = map([
      { from: "mcu.GPIO6", to: "oled.SDA", net: "I2C_SDA" },
      { from: "oled.SDA", to: "env.SDA" },
      { from: "mcu.GPIO7", to: "oled.SCL", net: "I2C_SCL" },
    ]);
    expect(m).toEqual([
      { name: "PIN_I2C_SDA", gpio: 6, net: "I2C_SDA", comment: "oled.SDA, env.SDA" },
      { name: "PIN_I2C_SCL", gpio: 7, net: "I2C_SCL", comment: "oled.SCL" },
    ]);
  });

  test("unnamed nets are named from the peripheral ref and pin", () => {
    const m = map([{ from: "mcu.GPIO10", to: "btn.1" }]);
    expect(m).toHaveLength(1);
    expect(m[0]!.name).toBe("PIN_BTN_1");
    expect(m[0]!.gpio).toBe(10);
    expect(m[0]!.comment).toBe("btn.1");
  });

  test("nets without a controller gpio pin are skipped", () => {
    const m = map([
      { from: "mcu.GND", to: "oled.GND" },
      { from: "mcu.3V3", to: "env.SDA" },
      { from: "btn.2", to: "oled.SCL" },
      { from: "mcu.GPIO10", to: "btn.1", net: "BUTTON" },
    ]);
    expect(m.map((e) => e.name)).toEqual(["PIN_BUTTON"]);
  });

  test("names are valid C identifiers and unique", () => {
    const m = map([
      { from: "mcu.GPIO6", to: "oled.SDA", net: "i2c sda!" },
      { from: "mcu.GPIO7", to: "oled.SCL", net: "I2C-SDA" },
      { from: "mcu.GPIO10", to: "btn.1", net: "9lives" },
      { from: "mcu.GPIO3", to: "btn.2", net: "PIN_I2C_SDA" },
    ]);
    const names = m.map((e) => e.name);
    for (const n of names) expect(n).toMatch(/^[A-Za-z_][A-Za-z0-9_]*$/);
    expect(new Set(names).size).toBe(names.length);
    expect(names).toEqual(["PIN_I2C_SDA", "PIN_I2C_SDA_2", "PIN_9LIVES", "PIN_I2C_SDA_3"]);
  });
});

describe("series passives", () => {
  const detail = (c: Project["connections"]) => pinMapDetailed(resolveProject(project(c), defs));

  test("output through a series resistor is an output and names the strip", () => {
    const [e] = detail([
      { from: "mcu.GPIO3", to: "r1.1" },
      { from: "r1.2", to: "strip.DIN" },
    ]);
    expect(e!.use).toBe("output");
    expect(e!.comment).toBe("strip.DIN via r1");
    expect(e!.name).toBe("PIN_STRIP_DIN");
  });

  test("input through a divider is an input; the pull-down leg is ignored", () => {
    const m = detail([
      { from: "sonar.ECHO", to: "r1.1" },
      { from: "r1.2", to: "mcu.GPIO3" },
      { from: "r2.1", to: "mcu.GPIO3" },
      { from: "r2.2", to: "mcu.GND" },
    ]);
    expect(m).toHaveLength(1);
    expect(m[0]!.use).toBe("input");
    expect(m[0]!.comment).toBe("sonar.ECHO via r1");
  });

  test("a pull-up to a rail is not the peripheral", () => {
    const [e] = detail([
      { from: "mcu.GPIO10", to: "btn.1" },
      { from: "r1.1", to: "mcu.GPIO10" },
      { from: "r1.2", to: "mcu.3V3" },
    ]);
    expect(e!.use).toBe("input");
    expect(e!.comment).toBe("btn.1");
  });

  test("follows at most three passives", () => {
    const e = detail([
      { from: "mcu.GPIO3", to: "r1.1" },
      { from: "r1.2", to: "r2.1" },
      { from: "r2.2", to: "strip.DIN" },
    ]);
    expect(e[0]!.comment).toBe("strip.DIN via r1, r2");
  });
});

describe("pin names a hand-written file uses that no longer exist", () => {
  const defined = ["PIN_LED_DATA", "PIN_BUTTON"];

  test("a name left over from a renamed net is reported once", () => {
    const src = "pinMode(PIN_LED_DATA_3V3, OUTPUT);\nrmtWrite(PIN_LED_DATA_3V3, f, n);\ndigitalRead(PIN_BUTTON);";
    expect(stalePinNames(src, defined)).toEqual(["PIN_LED_DATA_3V3"]);
  });

  test("names only mentioned in comments are not uses", () => {
    const src = "// was PIN_OLD_NAME\n/* PIN_ALSO_OLD */\ndigitalRead(PIN_BUTTON); // not PIN_GONE";
    expect(stalePinNames(src, defined)).toEqual([]);
  });

  test("a file that uses only current names is clean", () => {
    expect(stalePinNames("digitalWrite(PIN_LED_DATA, HIGH);", defined)).toEqual([]);
  });
});

describe("bring-up plan: what the generated test may do with an output", () => {
  const safeLed: PartDef = { ...part("led", "light", [io("A", undefined, { dir: "in" }), { name: "K", role: "passive", x: 0, y: 0 }]), electrical: { bringUp: "pulse" } };
  const buzzer: PartDef = { ...part("buzzer", "audio", [io("IO", undefined, { dir: "in", idle: "high" })]), electrical: { bringUp: "pulse" } };
  const relay = part("relay", "actuator", [io("IN", undefined, { dir: "in", idle: "high" })]);
  const servo = part("servo", "actuator", [io("SIG", undefined, { dir: "in" })]);
  const unreviewed = part("mystery", "light", [io("DIN", undefined, { dir: "in" })]);
  const own = new Map<string, PartDef>([...defs, ...[safeLed, buzzer, relay, servo, unreviewed].map((d): [string, PartDef] => [d.id, d])]);
  const plan = (target: string, partId: string, via?: boolean) => {
    const p = project(via ? [{ from: "mcu.GPIO3", to: "r1.1" }, { from: "r1.2", to: `x.${target}` }] : [{ from: "mcu.GPIO3", to: `x.${target}` }]);
    p.parts = [{ ref: "mcu", part: "board" }, { ref: "r1", part: "resistor" }, { ref: "x", part: partId }];
    return bringUpPlan(pinMapDetailed(resolveProject(p, own))[0]!);
  };

  test("a relay is never switched, and is held at its idle level, which is HIGH for a low-triggered one", () => {
    const r = plan("IN", "relay");
    expect(r.pulse).toBe(false);
    expect(r.idle).toBe("HIGH");
    expect(r.why).toContain("actuator");
  });

  test("a servo is never switched", () => {
    const r = plan("SIG", "servo");
    expect(r.pulse).toBe(false);
    expect(r.idle).toBe("LOW");
  });

  test("a part file that says nothing is held: safe is the default, also for parts nobody reviewed", () => {
    expect(plan("DIN", "mystery").pulse).toBe(false);
  });

  test("an LED marked safe is pulsed, also through its series resistor", () => {
    expect(plan("A", "led").pulse).toBe(true);
    const viaResistor = plan("A", "led", true);
    expect(viaResistor.pulse).toBe(true);
    expect(viaResistor.target).toContain("(x)");
  });

  test("a low-triggered buzzer marked safe is pulsed from an idle of HIGH", () => {
    const r = plan("IO", "buzzer");
    expect(r.pulse).toBe(true);
    expect(r.idle).toBe("HIGH");
  });

  test("the library's own relay, servo, buzzer and LED carry the fields this relies on", async () => {
    const lib = async (id: string) => (await Bun.file(new URL(`../../assets/parts/${id}.json`, import.meta.url)).json()) as PartDef;
    expect((await lib("relay-module-1ch")).electrical.bringUp).toBeUndefined();
    expect((await lib("relay-module-1ch")).pins.find((p) => p.name === "IN")?.idle).toBe("high");
    expect((await lib("sg90-servo")).electrical.bringUp).toBeUndefined();
    expect((await lib("active-buzzer-module")).electrical.bringUp).toBe("pulse");
    expect((await lib("active-buzzer-module")).pins.find((p) => p.name === "I/O")?.idle).toBe("high");
    expect((await lib("led-5mm")).electrical.bringUp).toBe("pulse");
  });
});
