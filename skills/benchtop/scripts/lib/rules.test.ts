import { describe, expect, test } from "bun:test";
import { resolveProject } from "./project";
import { checkProject } from "./rules";
import type { Finding } from "./rules";
import type { Connection, PartDef, PartUse, PinDef, Project } from "./types";

// ---- fixtures: small hand-written parts, independent of assets/parts/ ----

const base = {
  body: { w: 10, d: 10, h: 2 },
  maxHeight: 5,
  blurb: "test part",
  sourcing: { search: ["test"], priceUsd: 1 },
  sources: ["test"],
  confidence: "typical" as const,
};

const pin = (name: string, role: PinDef["role"], extra: Partial<PinDef> = {}): PinDef => ({ name, role, x: 0, y: 0, ...extra });

const mcu: PartDef = {
  ...base,
  id: "mcu",
  name: "Test MCU",
  kind: "board",
  pins: [
    pin("5V", "power-out", { volts: 5, supplyMa: 500, backfeed: { minVolts: 4.5, maxVolts: 5.5 } }),
    pin("3V3", "power-out", { volts: 3.3, supplyMa: 300 }),
    pin("GND", "gnd"),
    pin("GPIO3", "io", { caps: ["pwm"] }),
    pin("GPIO4", "io", { caps: ["adc", "pwm"] }),
    pin("GPIO5", "io", { caps: ["pwm"] }),
    pin("GPIO7", "io", { caps: ["i2c"] }),
    pin("GPIO8", "io", { caps: ["i2c"] }),
    pin("GPIO34", "io", { caps: ["input-only", "adc"] }),
    pin("GPIO6", "io", { caps: ["flash"], note: "Wired to the SPI flash." }),
    pin("GPIO0", "io", { caps: ["strapping"], note: "Must be high at boot." }),
    pin("GPIO18", "io", { caps: ["usb"], note: "USB D-." }),
  ],
  electrical: { logicVolts: 3.3, currentMa: { typical: 80, peak: 240 } },
};

const hcsr04: PartDef = {
  ...base,
  id: "hcsr04",
  name: "HC-SR04",
  kind: "sensor",
  pins: [
    pin("VCC", "power-in", { minVolts: 4.5, maxVolts: 5.5 }),
    pin("TRIG", "io", { dir: "in" }),
    pin("ECHO", "io", { dir: "out", volts: 5 }),
    pin("GND", "gnd"),
  ],
  electrical: { logicVolts: 5, currentMa: { typical: 15, peak: 15 } },
};

const resistor: PartDef = {
  ...base,
  id: "resistor",
  name: "Resistor",
  kind: "passive",
  pins: [pin("A", "passive"), pin("B", "passive")],
  electrical: {},
};

const led: PartDef = {
  ...base,
  id: "led",
  name: "LED",
  kind: "light",
  pins: [pin("A", "passive"), pin("K", "passive")],
  electrical: { needsSeriesResistor: true, currentMa: { typical: 10, peak: 20 } },
};

const i2cPart = (id: string, addrs: number[], pullups: boolean): PartDef => ({
  ...base,
  id,
  name: id,
  kind: "sensor",
  pins: [pin("VCC", "power-in", { minVolts: 3, maxVolts: 5.5 }), pin("GND", "gnd"), pin("SDA", "io", { caps: ["i2c"] }), pin("SCL", "io", { caps: ["i2c"] })],
  electrical: { logicVolts: 3.3, i2cAddresses: addrs, i2cPullups: pullups, currentMa: { typical: 5, peak: 10 } },
});

const oled = i2cPart("oled", [0x3c, 0x3d], true);
const bme = i2cPart("bme", [0x76], true);
const bare = i2cPart("bare", [0x40], false);

const analog: PartDef = {
  ...base,
  id: "analog",
  name: "Analog sensor",
  kind: "sensor",
  pins: [pin("VCC", "power-in", { minVolts: 3, maxVolts: 5.5 }), pin("GND", "gnd"), pin("OUT", "io", { dir: "out", needs: ["adc"], volts: 3.3 })],
  electrical: { logicVolts: 3.3 },
};

const hog: PartDef = {
  ...base,
  id: "hog",
  name: "Hungry module",
  kind: "actuator",
  pins: [pin("VCC", "power-in"), pin("GND", "gnd")],
  electrical: { currentMa: { typical: 300, peak: 400 } },
};

const boost: PartDef = {
  ...base,
  id: "boost",
  name: "Boost converter",
  kind: "power",
  pins: [pin("VIN", "power-in", { minVolts: 2, maxVolts: 5 }), pin("OUT", "power-out", { volts: 5, supplyMa: 1000 }), pin("GND", "gnd")],
  electrical: {},
};

const DEFS = new Map<string, PartDef>([mcu, hcsr04, resistor, led, oled, bme, bare, analog, hog, boost].map((d) => [d.id, d]));

const use = (ref: string, part: string, value?: string): PartUse => ({ ref, part, value });
const c = (from: string, to: string): Connection => ({ from, to });

function project(parts: PartUse[], connections: Connection[], over: Partial<Project> = {}): Project {
  return {
    schema: 1,
    slug: "t",
    name: "Test",
    tagline: "t",
    summary: "t",
    build: { path: "pcb-diy", difficulty: 1, minutes: 10 },
    power: { source: "usb", volts: 5, budgetMa: 500 },
    parts,
    connections,
    ...over,
  };
}

function check(p: Project): Finding[] {
  return checkProject(resolveProject(p, DEFS));
}

const codes = (fs: Finding[], level?: Finding["level"]): string[] => fs.filter((f) => !level || f.level === level).map((f) => f.code);

const MCU = use("mcu", "mcu");
const HC = use("hc", "hcsr04");

/** Sensor powered and grounded, so a test only has to add the connection under test. */
const hcPower = [c("mcu.5V", "hc.VCC"), c("mcu.GND", "hc.GND")];

describe("passing project", () => {
  test("distance sensor with divider, LED with resistor and I2C OLED has no errors or warnings", () => {
    const fs = check(
      project(
        [MCU, HC, use("r1", "resistor", "1 kohm"), use("r2", "resistor", "2 kohm"), use("r3", "resistor", "220 ohm"), use("led", "led"), use("oled", "oled")],
        [
          ...hcPower,
          c("mcu.GPIO5", "hc.TRIG"),
          c("hc.ECHO", "r1.A"),
          c("r1.B", "mcu.GPIO4"),
          c("r1.B", "r2.A"),
          c("r2.B", "mcu.GND"),
          c("mcu.3V3", "oled.VCC"),
          c("mcu.GND", "oled.GND"),
          c("mcu.GPIO7", "oled.SDA"),
          c("mcu.GPIO8", "oled.SCL"),
          c("mcu.GPIO3", "r3.A"),
          c("r3.B", "led.A"),
          c("led.K", "mcu.GND"),
        ],
      ),
    );
    expect(codes(fs, "error")).toEqual([]);
    expect(codes(fs, "warn")).toEqual([]);
  });
});

describe("error rules", () => {
  test("overvoltage: 5 V HC-SR04 echo straight into a 3.3 V GPIO", () => {
    const fs = check(project([MCU, HC], [...hcPower, c("hc.ECHO", "mcu.GPIO4")]));
    const f = fs.find((x) => x.code === "overvoltage");
    expect(f).toBeDefined();
    expect(f!.level).toBe("error");
    expect(f!.refs).toEqual(["hc.ECHO", "mcu.GPIO4"]);
    expect(f!.message).toContain("5 V");
    expect(f!.message).toContain("3.3 V");
    expect(f!.fix).toContain("voltage divider");
    expect(f!.fix).toContain("level shifter");
  });

  test("overvoltage: a 5 V rail on a 3.3 V-only power pin", () => {
    const fs = check(project([MCU, use("o", "oled")], [c("mcu.5V", "o.VCC"), c("mcu.GND", "o.GND")]));
    expect(codes(fs, "error")).not.toContain("overvoltage"); // oled tolerates 5.5 V
    const strict: PartDef = { ...oled, id: "strict", pins: oled.pins.map((p) => (p.name === "VCC" ? { ...p, maxVolts: 3.6 } : p)) };
    DEFS.set("strict", strict);
    const bad = check(project([MCU, use("s", "strict")], [c("mcu.5V", "s.VCC"), c("mcu.GND", "s.GND")]));
    DEFS.delete("strict");
    expect(codes(bad, "error")).toContain("overvoltage");
  });

  test("rail-short: 5V tied to 3V3, and a rail tied to GND", () => {
    expect(codes(check(project([MCU], [c("mcu.5V", "mcu.3V3")])), "error")).toContain("rail-short");
    expect(codes(check(project([MCU], [c("mcu.3V3", "mcu.GND")])), "error")).toContain("rail-short");
  });

  test("undervoltage: 4.5 V part on the 3.3 V rail", () => {
    const fs = check(project([MCU, HC], [c("mcu.3V3", "hc.VCC"), c("mcu.GND", "hc.GND")]));
    expect(codes(fs, "error")).toContain("undervoltage");
  });

  test("unpowered: power input left unconnected", () => {
    const fs = check(project([MCU, HC], [c("mcu.GND", "hc.GND"), c("mcu.GPIO5", "hc.TRIG")]));
    expect(codes(fs, "error")).toContain("unpowered");
  });

  test("no-ground: module not tied to the board ground", () => {
    const fs = check(project([MCU, use("o", "oled")], [c("mcu.3V3", "o.VCC")]));
    expect(codes(fs, "error")).toContain("no-ground");
  });

  test("missing-capability: analogue output on a pin without ADC", () => {
    const fs = check(project([MCU, use("a", "analog")], [c("mcu.3V3", "a.VCC"), c("mcu.GND", "a.GND"), c("a.OUT", "mcu.GPIO5")]));
    const f = fs.find((x) => x.code === "missing-capability");
    expect(f?.level).toBe("error");
    expect(f?.fix).toContain("GPIO4");
  });

  test("input-only-driven: GPIO34 wired to a peripheral input", () => {
    const fs = check(project([MCU, HC], [...hcPower, c("mcu.GPIO34", "hc.TRIG")]));
    expect(codes(fs, "error")).toContain("input-only-driven");
  });

  test("flash-pin is an error and includes the pin note", () => {
    const fs = check(project([MCU, HC], [...hcPower, c("mcu.GPIO6", "hc.TRIG")]));
    const f = fs.find((x) => x.code === "flash-pin");
    expect(f?.level).toBe("error");
    expect(f?.message).toContain("Wired to the SPI flash.");
  });

  test("multiple-drivers: two outputs on one net", () => {
    const fs = check(project([MCU, HC, use("hc2", "hcsr04")], [...hcPower, c("mcu.5V", "hc2.VCC"), c("mcu.GND", "hc2.GND"), c("hc.ECHO", "hc2.ECHO")]));
    expect(codes(fs, "error")).toContain("multiple-drivers");
  });

  test("i2c-address-clash: two parts with one fixed address is an error", () => {
    const fs = check(i2cBus([use("b1", "bme"), use("b2", "bme")]));
    const f = fs.find((x) => x.code === "i2c-address-clash");
    expect(f?.level).toBe("error");
  });

  test("i2c-no-pullups: bus with no pull-ups anywhere", () => {
    const fs = check(i2cBus([use("b1", "bare")]));
    expect(codes(fs, "error")).toContain("i2c-no-pullups");
  });

  test("led-no-resistor: LED wired straight to a GPIO", () => {
    const fs = check(project([MCU, use("led", "led")], [c("mcu.GPIO3", "led.A"), c("led.K", "mcu.GND")]));
    expect(codes(fs, "error")).toContain("led-no-resistor");
  });

  test("power-budget: peak current above the source budget", () => {
    const fs = check(project([MCU, HC], hcPower, { power: { source: "usb", volts: 5, budgetMa: 200 } }));
    const f = fs.find((x) => x.code === "power-budget");
    expect(f?.level).toBe("error");
  });

  test("rail-budget: module draws more than the 3V3 pin supplies", () => {
    const fs = check(project([MCU, use("h", "hog")], [c("mcu.3V3", "h.VCC"), c("mcu.GND", "h.GND")], { power: { source: "usb", volts: 5, budgetMa: 2000 } }));
    expect(codes(fs, "error")).toContain("rail-budget");
  });

  test("power-entry: USB needs no entry; other sources need a valid in-range entry", () => {
    expect(codes(check(project([MCU], [])), "error")).toEqual([]);
    expect(codes(check(project([MCU], [], { power: { source: "usb", volts: 5, budgetMa: 500, entry: "mcu.3V3" } })), "error")).toEqual([]);
    const lipo = (entry?: string, volts = 5): Finding[] => check(project([MCU], [], { power: { source: "lipo", volts, budgetMa: 500, entry } }));
    expect(codes(lipo(), "error")).toContain("power-entry");
    expect(codes(lipo("mcu.3V3"), "error")).toContain("power-entry"); // power-out without backfeed
    expect(codes(lipo("mcu.5V", 12), "error")).toContain("power-entry"); // outside backfeed range
    expect(codes(lipo("mcu.5V", 5), "error")).toEqual([]);
  });

  test("unpowered: non-USB source with nothing feeding the board", () => {
    const fs = check(project([MCU], [], { power: { source: "aa", volts: 5, budgetMa: 500 } }));
    expect(codes(fs, "error")).toContain("unpowered");
  });

  test("rail-short: boost converter into a backfeed pin is a legitimate feed, 3.3 V into it is a short", () => {
    const fed = check(project([MCU, use("b", "boost")], [c("b.OUT", "mcu.5V"), c("b.GND", "mcu.GND")], { power: { source: "aa", volts: 3, budgetMa: 1000, entry: "b.VIN" } }));
    expect(codes(fed, "error")).not.toContain("rail-short");
    expect(codes(fed, "error")).not.toContain("unpowered");
    const bad = check(project([MCU, use("b", "boost")], [c("mcu.3V3", "mcu.5V")]));
    expect(codes(bad, "error")).toContain("rail-short");
  });
});

describe("warn and info rules", () => {
  test("strapping-pin and usb-pin warn", () => {
    const fs = check(project([MCU, HC], [...hcPower, c("mcu.GPIO0", "hc.TRIG")]));
    expect(codes(fs, "warn")).toContain("strapping-pin");
    expect(fs.find((x) => x.code === "strapping-pin")?.message).toContain("Must be high at boot.");
    const usb = check(project([MCU, HC], [...hcPower, c("mcu.GPIO18", "hc.TRIG")]));
    expect(usb.find((x) => x.code === "usb-pin")?.level).toBe("warn");
  });

  test("i2c-address-clash warns and names the alternative when one exists", () => {
    const fs = check(i2cBus([use("o1", "oled"), use("o2", "oled")]));
    const f = fs.find((x) => x.code === "i2c-address-clash");
    expect(f?.level).toBe("warn");
    expect(f?.message).toContain("0x3D");
  });

  test("crowded-pad: three wires on one pad on the wire build path", () => {
    const parts = [MCU, HC, use("o", "oled"), use("o2", "oled")];
    const conns = [...hcPower, c("mcu.3V3", "o.VCC"), c("mcu.GND", "o.GND"), c("mcu.3V3", "o2.VCC"), c("mcu.GND", "o2.GND")];
    const wire = check(project(parts, conns, { build: { path: "wire", joint: "solder", difficulty: 1, minutes: 5 } }));
    expect(codes(wire, "warn")).toContain("crowded-pad");
    expect(codes(check(project(parts, conns)), "warn")).not.toContain("crowded-pad");
  });

  test("unused-signal: info for an unconnected signal pin", () => {
    const fs = check(project([MCU, HC], hcPower));
    expect(fs.find((x) => x.code === "unused-signal")?.level).toBe("info");
  });

  test("findings are sorted errors first", () => {
    const fs = check(project([MCU, HC], [c("mcu.5V", "mcu.3V3")]));
    const levels = fs.map((f) => f.level);
    expect(levels).toEqual([...levels].sort((a, b) => ["error", "warn", "info"].indexOf(a) - ["error", "warn", "info"].indexOf(b)));
  });
});

/** MCU with the given I2C parts all on GPIO7 (SDA) and GPIO8 (SCL), powered from 3V3. */
function i2cBus(parts: PartUse[]): Project {
  const conns: Connection[] = [c("mcu.GPIO7", `${parts[0]!.ref}.SDA`), c("mcu.GPIO8", `${parts[0]!.ref}.SCL`)];
  for (const p of parts) {
    conns.push(c("mcu.3V3", `${p.ref}.VCC`), c("mcu.GND", `${p.ref}.GND`));
    if (p !== parts[0]) conns.push(c("mcu.GPIO7", `${p.ref}.SDA`), c("mcu.GPIO8", `${p.ref}.SCL`));
  }
  return project([MCU, ...parts], conns);
}

// ---- current limits, series resistors and logic thresholds ----

const strip: PartDef = {
  ...base,
  id: "strip",
  name: "LED strip",
  kind: "light",
  pins: [
    pin("VCC", "power-in", { minVolts: 3, maxVolts: 5.5 }),
    pin("GND", "gnd"),
    pin("DIN", "io", { dir: "in", minHighVolts: 3.5 }),
  ],
  electrical: { logicVolts: 5, currentMa: { typical: 200, peak: 480 } },
};
DEFS.set("strip", strip);

const stripOn3v3 = (extra: Partial<PartUse> = {}, power: Partial<Project["power"]> = {}): Finding[] =>
  check(
    project([MCU, { ...use("s", "strip"), ...extra }], [c("mcu.3V3", "s.VCC"), c("mcu.GND", "s.GND"), c("mcu.GPIO5", "s.DIN")], {
      power: { source: "usb", volts: 5, budgetMa: 2000, ...power },
    }),
  );

describe("declared limits", () => {
  test("480 mA strip on a 300 mA rail fails rail-budget", () => {
    expect(codes(stripOn3v3(), "error")).toContain("rail-budget");
  });

  test("peakMa 120 with a reason passes and reports declared-limit quoting the reason", () => {
    const fs = stripOn3v3({ peakMa: 120, peakMaWhy: "firmware caps brightness at 25 percent" });
    expect(codes(fs, "error")).not.toContain("rail-budget");
    const f = fs.find((x) => x.code === "declared-limit");
    expect(f?.level).toBe("info");
    expect(f?.message).toContain("firmware caps brightness at 25 percent");
    expect(f?.message).toContain("480");
  });

  test("limit-without-reason: peakMa with empty peakMaWhy is an error", () => {
    expect(codes(stripOn3v3({ peakMa: 120 }), "error")).toContain("limit-without-reason");
    expect(codes(stripOn3v3({ peakMa: 120, peakMaWhy: "  " }), "error")).toContain("limit-without-reason");
  });

  test("power-budget uses the declared peak", () => {
    const over = stripOn3v3({}, { budgetMa: 600 });
    expect(codes(over, "error")).toContain("power-budget");
    const ok = stripOn3v3({ peakMa: 100, peakMaWhy: "capped in firmware" }, { budgetMa: 600 });
    expect(codes(ok, "error")).not.toContain("power-budget");
  });
});

describe("no-divider", () => {
  const r1 = use("r1", "resistor", "1 kohm");
  const r2 = use("r2", "resistor", "2 kohm");

  test("5 V echo through one series resistor only is an error", () => {
    const fs = check(project([MCU, HC, r1], [...hcPower, c("hc.ECHO", "r1.A"), c("r1.B", "mcu.GPIO4")]));
    const f = fs.find((x) => x.code === "no-divider");
    expect(f?.level).toBe("error");
    expect(f?.fix).toContain("2 kohm");
    expect(f?.fix).toContain("level shifter");
  });

  test("the same with a second resistor to ground passes", () => {
    const fs = check(
      project([MCU, HC, r1, r2], [...hcPower, c("hc.ECHO", "r1.A"), c("r1.B", "mcu.GPIO4"), c("r1.B", "r2.A"), c("r2.B", "mcu.GND")]),
    );
    expect(codes(fs)).not.toContain("no-divider");
    expect(codes(fs, "error")).toEqual([]);
  });

  test("a series resistor to a pin that survives the voltage is fine", () => {
    const fs = check(project([MCU, use("r3", "resistor"), use("o", "oled")], [c("mcu.GPIO3", "r3.A"), c("r3.B", "o.SDA")]));
    expect(codes(fs)).not.toContain("no-divider");
  });
});

describe("logic-level-low", () => {
  test("3.3 V GPIO into a part that needs 3.5 V high warns and names the options", () => {
    const f = stripOn3v3().find((x) => x.code === "logic-level-low");
    expect(f?.level).toBe("warn");
    expect(f?.fix).toContain("74AHCT125");
    expect(f?.message).toContain("datasheet");
  });

  test("no warning when the driver is high enough", () => {
    const fs = check(project([MCU, HC, use("s", "strip")], [...hcPower, c("mcu.5V", "s.VCC"), c("mcu.GND", "s.GND"), c("hc.ECHO", "s.DIN")]));
    expect(codes(fs)).not.toContain("logic-level-low");
  });
});

describe("logic-level-low through a series resistor", () => {
  test("GPIO -> resistor -> strip DIN still warns and names the resistor", () => {
    const fs = check(
      project(
        [MCU, use("s", "strip"), use("r3", "resistor", "330 ohm")],
        [c("mcu.3V3", "s.VCC"), c("mcu.GND", "s.GND"), c("mcu.GPIO7", "r3.A"), c("r3.B", "s.DIN")],
        { power: { source: "usb", volts: 5, budgetMa: 2000 } },
      ),
    );
    const f = fs.find((x) => x.code === "logic-level-low");
    expect(f?.level).toBe("warn");
    expect(f?.message).toContain("r3");
    expect(f?.refs).toContain("r3");
  });
});

describe("per-unit current", () => {
  const pixels: PartDef = {
    ...base,
    id: "pixels",
    name: "Pixel strip",
    kind: "light",
    pins: [pin("VCC", "power-in", { minVolts: 3, maxVolts: 5.5 }), pin("GND", "gnd")],
    electrical: { currentMa: { typical: 20, peak: 60 }, perUnit: { name: "pixel" } },
  };
  const psu: PartDef = {
    ...base,
    id: "psu",
    name: "5 V supply",
    kind: "power",
    pins: [pin("OUT", "power-out", { volts: 5, supplyMa: 400 }), pin("GND", "gnd")],
    electrical: {},
  };
  DEFS.set("pixels", pixels);
  DEFS.set("psu", psu);

  const strip5v = (extra: Partial<PartUse> = {}): Finding[] =>
    check(
      project(
        [MCU, use("psu", "psu"), { ...use("px", "pixels"), ...extra }],
        [c("psu.OUT", "px.VCC"), c("psu.GND", "px.GND"), c("mcu.GND", "psu.GND")],
        { power: { source: "usb", volts: 5, budgetMa: 5000 } },
      ),
    );

  test("8 pixels at 60 mA on a 400 mA pin fails rail-budget at 480 mA", () => {
    const f = strip5v({ units: 8 }).find((x) => x.code === "rail-budget");
    expect(f?.level).toBe("error");
    expect(f?.message).toContain("480");
  });

  test("peakMa 120 with a reason passes and declared-limit quotes 480", () => {
    const fs = strip5v({ units: 8, peakMa: 120, peakMaWhy: "firmware caps brightness" });
    expect(codes(fs, "error")).toEqual([]);
    expect(fs.find((x) => x.code === "declared-limit")?.message).toContain("480");
  });

  test("a per-unit part without units reports units-missing", () => {
    const f = strip5v().find((x) => x.code === "units-missing");
    expect(f?.level).toBe("warn");
    expect(f?.message).toContain("single pixel");
    expect(strip5v({ units: 0 }).some((x) => x.code === "units-missing")).toBe(true);
    expect(strip5v({ units: 8 }).some((x) => x.code === "units-missing")).toBe(false);
  });
});

// ---- an input whose high level is measured from its own supply ----

const buzzer: PartDef = {
  ...base,
  id: "buzzer",
  name: "Buzzer module",
  kind: "audio",
  pins: [pin("VCC", "power-in", { minVolts: 3.3, maxVolts: 5 }), pin("IO", "io", { dir: "in", maxVolts: 5, highWithinOfSupply: 0.6 }), pin("GND", "gnd")],
  electrical: { logicVolts: 3.3, fiveVoltTolerant: true, currentMa: { typical: 30, peak: 40 } },
};
const fiveVoltOnly: PartDef = {
  ...buzzer,
  id: "relay5",
  name: "5 V relay board",
  pins: [pin("VCC", "power-in", { minVolts: 4.5, maxVolts: 5.5 }), pin("IO", "io", { dir: "in", maxVolts: 5, highWithinOfSupply: 0.6 }), pin("GND", "gnd")],
};
DEFS.set("buzzer", buzzer);
DEFS.set("relay5", fiveVoltOnly);

describe("high-below-supply", () => {
  const wired = (part: string, rail: "5V" | "3V3"): Finding[] =>
    check(project([MCU, use("b", part)], [c(`mcu.${rail}`, "b.VCC"), c("mcu.GND", "b.GND"), c("mcu.GPIO3", "b.IO")]));

  test("a 3.3 V pin switching a supply-referenced input on 5 V is an error that says to use the 3.3 V rail", () => {
    const f = wired("buzzer", "5V").find((x) => x.code === "high-below-supply");
    expect(f?.level).toBe("error");
    expect(f?.message).toContain("4.4 V");
    expect(f?.fix).toContain("3.3 V rail");
    expect(f?.refs).toEqual(["mcu.GPIO3", "b.IO", "b.VCC"]);
  });

  test("the same part fed from 3.3 V passes", () => {
    expect(codes(wired("buzzer", "3V3"))).not.toContain("high-below-supply");
  });

  test("a part that cannot run from the lower rail gets the transistor advice instead", () => {
    const f = wired("relay5", "5V").find((x) => x.code === "high-below-supply");
    expect(f?.fix).toContain("transistor");
    expect(f?.fix).not.toContain("3.3 V rail instead");
  });

  test("the library buzzer carries the field, so real projects get the check", async () => {
    const lib = (await Bun.file(new URL("../../assets/parts/active-buzzer-module.json", import.meta.url)).json()) as PartDef;
    expect(lib.pins.find((p) => p.name === "I/O")?.highWithinOfSupply).toBe(0.6);
  });
});

describe("an I2C bus is found from its devices, not from controller pin names", () => {
  const mcuWithAliases: PartDef = {
    ...mcu,
    id: "mcu-alias",
    pins: [...mcu.pins, pin("8", "io", { aliases: ["GPIO8b", "SDA"], caps: ["i2c"] }), pin("9", "io", { aliases: ["GPIO9b", "SCL"], caps: ["i2c"] })],
  };
  DEFS.set("mcu-alias", mcuWithAliases);
  const M = use("mcu", "mcu-alias");

  test("two default-I2C pins used for a buzzer and another input raise no bus error", () => {
    const fs = check(
      project(
        [M, use("b", "buzzer"), use("b2", "buzzer")],
        [c("mcu.3V3", "b.VCC"), c("mcu.GND", "b.GND"), c("mcu.8", "b.IO"), c("mcu.3V3", "b2.VCC"), c("mcu.GND", "b2.GND"), c("mcu.9", "b2.IO")],
      ),
    );
    expect(codes(fs)).not.toContain("i2c-no-pullups");
    expect(codes(fs, "error")).toEqual([]);
  });

  test("a real I2C device on those pins is still checked, and the fix names a part that exists", () => {
    const fs = check(project([M, use("s", "bare")], [c("mcu.3V3", "s.VCC"), c("mcu.GND", "s.GND"), c("mcu.8", "s.SDA"), c("mcu.9", "s.SCL")]));
    const f = fs.find((x) => x.code === "i2c-no-pullups");
    expect(f?.level).toBe("error");
    expect(f?.fix).toContain("resistor-axial");
  });
});
