import { afterAll, describe, expect, test } from "bun:test";
import { existsSync } from "node:fs";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { bringupCpp, mainCpp, platformioIni, rp2040I2cBus } from "./firmware";
import { FAMILIES, type Lookup, platformSpec, resolveBoard } from "./lib/platform";
import { pinMapDetailed } from "./lib/pinmap";
import { loadPartDefs, loadProject, resolveProject } from "./lib/project";
import type { PartDef, PinDef, Project } from "./lib/types";

const [ESP32, RP2040, AVR] = FAMILIES as [(typeof FAMILIES)[number], (typeof FAMILIES)[number], (typeof FAMILIES)[number]];
const LUFT = join(import.meta.dir, "..", "examples", "luft");
const hasPio = Bun.which("pio") !== null;

const loaded = await loadProject(LUFT);
const fw = loaded.project.firmware!;
const pins = pinMapDetailed(loaded);

describe("platformio.ini follows the family", () => {
  test("ESP32 keeps the pinned espressif32 platform and the native USB flags on a C3", () => {
    const ini = platformioIni(fw, ESP32);
    expect(ini).toContain("platform = espressif32@8.0.0\n");
    expect(ini).toContain("-DARDUINO_USB_CDC_ON_BOOT=1");
    expect(ini).not.toContain("board_build.core");
  });

  test("RP2040 pins the official platform with the earlephilhower core and no ESP32 flags", () => {
    const ini = platformioIni({ ...fw, board: "rpipicow" }, RP2040);
    expect(ini).toContain(`platform = raspberrypi@${RP2040.version}\n`);
    expect(ini).toContain("board = rpipicow\n");
    expect(ini).toContain("board_build.core = earlephilhower\n");
    expect(ini).not.toContain("ARDUINO_USB");
  });

  test("a board id that looks like an S3 gets no USB CDC flags outside the ESP32 family", () => {
    expect(platformioIni({ ...fw, board: "some_s3_thing" }, RP2040)).not.toContain("build_flags");
    expect(platformioIni({ ...fw, board: "uno" }, AVR)).toContain(`platform = atmelavr@${AVR.version}\n`);
  });

  test("user build flags still land in the ini on every family", () => {
    expect(platformioIni({ ...fw, board: "uno", buildFlags: ["-DFOO"] }, AVR)).toContain("  -DFOO");
  });
});

describe("the bring-up sketch compiles on the family's own API", () => {
  test("ESP32: Wire.begin(sda, scl) and Serial.printf", () => {
    const c = bringupCpp(loaded, pins, ESP32);
    expect(c).toMatch(/Wire\.begin\(PIN_\w+, PIN_\w+\);/);
    expect(c).toContain("Serial.printf(");
  });

  test("RP2040: Wire.setSDA/setSCL then Wire.begin(), never the two-argument form", () => {
    const c = bringupCpp(loaded, pins, RP2040);
    expect(c).toMatch(/\.setSDA\(PIN_\w+\);/);
    expect(c).toMatch(/\.setSCL\(PIN_\w+\);/);
    expect(c).not.toMatch(/\.begin\(PIN_/);
  });

  test("AVR: no printf, text kept in flash, fixed-pin Wire.begin()", () => {
    const c = bringupCpp(loaded, pins, AVR);
    expect(c).not.toContain("Serial.printf(");
    expect(c).toContain('Serial.println(F("');
    expect(c).toContain("Wire.begin();");
    expect(c).not.toMatch(/Serial\.println\("/);
  });

  test("outputs get their idle level before their output driver is switched on, on every family", () => {
    for (const f of [ESP32, RP2040, AVR]) {
      const c = bringupCpp(loaded, pins, f);
      const firstLevel = c.search(/digitalWrite\(|gpio_set_level\(/);
      const firstOutput = c.indexOf("OUTPUT);");
      if (firstLevel >= 0) expect(firstLevel).toBeLessThan(firstOutput);
    }
  });

  test("RP2040 I2C pins are mapped to the controller they belong to", () => {
    expect(rp2040I2cBus(16, 17)).toBe("Wire");
    expect(rp2040I2cBus(4, 5)).toBe("Wire");
    expect(rp2040I2cBus(2, 3)).toBe("Wire1");
    expect(rp2040I2cBus(6, 7)).toBe("Wire1");
    expect(rp2040I2cBus(4, 7)).toBeNull();
    expect(rp2040I2cBus(5, 4)).toBeNull();
  });
});

// A stepper-driver build like a TIG rotator: an opto-isolated driver whose ENA idles high, an
// open-collector alarm, a panel pot, a toggle, terminal and connector contacts, a push-pull sensor.
describe("a stepper-driver build", () => {
  const at = (name: string, role: PinDef["role"], extra: Partial<PinDef> = {}): PinDef => ({ name, role, x: 0, y: 0, ...extra });
  const gpio = (n: number, caps: PinDef["caps"] = []): PinDef => at(`GPIO${n}`, "io", { gpio: n, caps });
  const def = (id: string, kind: PartDef["kind"], pins: PinDef[]): PartDef => ({
    id, name: id, kind, blurb: "", body: { w: 10, d: 10, h: 1 }, maxHeight: 2, pins,
    electrical: {}, sourcing: { search: [], priceUsd: 1 }, sources: [], confidence: "typical",
  });
  const passive3 = ["1", "2", "3"].map((n) => at(n, "passive"));
  const defs = new Map<string, PartDef>(
    [
      def("board", "board", [
        ...[50, 52, 32, 29, 33, 34].map((n) => gpio(n)),
        gpio(49, ["adc"]),
        gpio(10),
        gpio(11),
        gpio(35, ["input-only", "adc"]),
        gpio(36, ["input-only", "adc"]),
        gpio(25),
        gpio(37, ["adc"]),
        at("GND", "gnd"), at("GND_2", "gnd"),
        at("3V3", "power-out", { volts: 3.3 }), at("3V3_2", "power-out", { volts: 3.3 }),
      ]),
      def("driver", "actuator", [
        at("PUL+", "io", { dir: "in" }),
        at("ENA+", "io", { dir: "in", idle: "high" }),
        at("ALM+", "io", { dir: "out", note: "Alarm opto transistor collector (open collector)." }),
        at("PUL-", "gnd"),
      ]),
      def("pot", "input", [at("1", "passive"), at("2", "passive", { aliases: ["W"] }), at("3", "passive")]),
      // KY-040 style: SW is stated as an output, but it is a contact that only closes to GND.
      def("encoder", "input", [at("SW", "io", { dir: "out", note: "Push button, closes to GND when pressed." }), at("GND", "gnd")]),
      def("toggle", "input", [at("1", "passive"), at("COM", "passive"), at("3", "passive")]),
      def("terminal", "connector", passive3),
      def("socket", "connector", ["1", "2", "3", "4"].map((n) => at(n, "passive"))),
      def("pir", "sensor", [at("OUT", "io", { dir: "out" })]),
      def("resistor", "passive", [at("1", "passive"), at("2", "passive")]),
      def("led", "light", [at("A", "io", { dir: "in" })]),
    ].map((d) => [d.id, d]),
  );
  const project: Project = {
    schema: 1, slug: "rotator", name: "Rotator", tagline: "", summary: "",
    build: { path: "wire", difficulty: 1, minutes: 1 },
    power: { source: "usb", volts: 5, budgetMa: 500 },
    parts: [
      { ref: "mcu", part: "board" }, { ref: "drv", part: "driver" }, { ref: "pot", part: "pot" },
      { ref: "pot2", part: "pot" }, { ref: "dirsw", part: "toggle" }, { ref: "key", part: "toggle" },
      { ref: "estop", part: "terminal" }, { ref: "pedal", part: "socket" }, { ref: "pir", part: "pir" },
      { ref: "r1", part: "resistor" }, { ref: "led", part: "led" }, { ref: "pot3", part: "pot" },
      { ref: "enc", part: "encoder" }, { ref: "sel", part: "toggle" },
    ],
    connections: [
      { from: "mcu.GPIO50", to: "drv.PUL+", net: "STEP" },
      { from: "mcu.GPIO52", to: "drv.ENA+", net: "ENA" },
      { from: "mcu.GPIO32", to: "drv.ALM+", net: "ALM" },
      { from: "drv.PUL-", to: "mcu.GND" },
      { from: "mcu.3V3", to: "pot.3" },
      { from: "pot.1", to: "mcu.GND_2" },
      { from: "mcu.GPIO49", to: "pot.2", net: "POT" },
      { from: "mcu.3V3", to: "pot2.3" },
      { from: "pot2.1", to: "mcu.GND" },
      { from: "mcu.GPIO10", to: "pot2.2", net: "POT_NO_ADC" },
      { from: "mcu.GPIO29", to: "dirsw.COM", net: "DIR_SW" },
      { from: "dirsw.1", to: "pot.1" },
      { from: "mcu.3V3_2", to: "estop.1" },
      { from: "estop.2", to: "mcu.GPIO34", net: "ESTOP" },
      { from: "estop.3", to: "mcu.GND" },
      { from: "mcu.GPIO33", to: "pedal.4", net: "PEDAL_SW" },
      { from: "pedal.3", to: "mcu.GND" },
      { from: "mcu.GPIO11", to: "key.COM", net: "KEY" },
      { from: "key.1", to: "mcu.GND" },
      { from: "r1.1", to: "mcu.GPIO11" },
      { from: "r1.2", to: "mcu.3V3_2" },
      { from: "mcu.GPIO35", to: "led.A", net: "ONLY_IN" },
      { from: "mcu.3V3_2", to: "pot3.3" },
      { from: "pot3.1", to: "mcu.GND_2" },
      { from: "mcu.GPIO36", to: "pot3.2", net: "POT_ONLY_IN" },
      { from: "mcu.GPIO25", to: "enc.SW", net: "ENC_SW" },
      { from: "enc.GND", to: "mcu.GND" },
      { from: "mcu.GPIO37", to: "sel.COM", net: "SEL" },
      { from: "sel.1", to: "mcu.3V3" },
      { from: "sel.3", to: "mcu.GND_2" },
      { from: "pir.OUT", to: "mcu.GPIO33" },
    ],
    firmware: { framework: "arduino", board: "esp32-p4", behaviour: "Hold ENA high." },
  };
  // pir.OUT shares PEDAL_SW only in the test below that needs a push-pull driver; elsewhere it is off the net.
  const withoutPir = { ...project, connections: project.connections.filter((c) => c.from !== "pir.OUT") };
  const rot = resolveProject(withoutPir, defs);
  const rotPins = pinMapDetailed(rot);
  const use = (name: string) => rotPins.find((p) => p.name === name)!;
  const setupOf = (c: string) => c.slice(c.indexOf("void setup() {"), c.indexOf("\n}\n", c.indexOf("void setup() {")));

  test("1: an output with an idle level is driven to it before anything else in setup(), in bring-up and main", () => {
    for (const f of [ESP32, RP2040, AVR]) {
      for (const c of [bringupCpp(rot, rotPins, f), mainCpp(rot, rot.project.firmware!, rotPins, f)]) {
        const s = setupOf(c);
        const ena = s.indexOf("pinMode(PIN_ENA, OUTPUT);");
        expect(ena).toBeGreaterThan(0);
        // Nothing that waits (Serial) comes before ENA is an output at HIGH.
        expect(s.indexOf("Serial.begin")).toBeGreaterThan(ena);
        expect(s.slice(0, ena)).toMatch(f.id === "esp32" ? /gpio_set_level\(\(gpio_num_t\)PIN_ENA, 1\);/ : /digitalWrite\(PIN_ENA, HIGH\);/);
        // ENA is never driven to its active level, and STEP is never pulsed.
        expect(c).not.toContain("digitalWrite(PIN_ENA, LOW)");
        expect(c).not.toContain("digitalWrite(PIN_STEP, HIGH)");
      }
    }
  });

  test("1: on ESP32 the level is also written after pinMode, since Arduino core 3 ignores digitalWrite before it", () => {
    const s = setupOf(bringupCpp(rot, rotPins, ESP32));
    expect(s.indexOf("digitalWrite(PIN_ENA, HIGH);")).toBeGreaterThan(s.indexOf("pinMode(PIN_ENA, OUTPUT);"));
  });

  test("2: contacts and open-collector outputs get INPUT_PULLUP, push-pull outputs and fitted pull resistors get INPUT", () => {
    const c = bringupCpp(rot, rotPins, ESP32);
    expect(c).toContain("pinMode(PIN_ALM, INPUT_PULLUP);");
    expect(c).toContain("pinMode(PIN_PEDAL_SW, INPUT_PULLUP);");
    expect(c).toContain("pinMode(PIN_ESTOP, INPUT_PULLUP);");
    expect(c).toContain("pinMode(PIN_DIR_SW, INPUT_PULLUP);");
    expect(c).toContain("pinMode(PIN_KEY, INPUT);");
    // dir "out" on an input part is a contact, not a push-pull output.
    expect(c).toContain("pinMode(PIN_ENC_SW, INPUT_PULLUP);");
    const pir = resolveProject(project, defs);
    expect(bringupCpp(pir, pinMapDetailed(pir), ESP32)).toContain("pinMode(PIN_PEDAL_SW, INPUT);");
  });

  test("3: a pot wiper on an ADC pin is read with analogRead and no pull-up; off an ADC pin it is a plain INPUT", () => {
    expect(use("PIN_POT").use).toBe("analog");
    const c = bringupCpp(rot, rotPins, ESP32);
    expect(c).toContain("analogRead(PIN_POT)");
    expect(c).not.toMatch(/pinMode\(PIN_POT, /);
    expect(use("PIN_POT_NO_ADC").use).toBe("input");
    expect(c).toContain("pinMode(PIN_POT_NO_ADC, INPUT);");
    // An input-only ADC pin (classic ESP32 GPIO34-39) is the usual pot pin: still analog.
    expect(use("PIN_POT_ONLY_IN").use).toBe("analog");
    expect(c).toContain("analogRead(PIN_POT_ONLY_IN)");
    expect(c).not.toMatch(/pinMode\(PIN_POT_ONLY_IN, /);
    // The common of an SPDT toggle is not a wiper, whatever its throws are wired to.
    expect(use("PIN_SEL").use).toBe("input");
    expect(c).toContain("digitalRead(PIN_SEL)");
  });

  test("4: explicit dir decides before the part's kind, and an input-only pin is never an output", () => {
    expect(use("PIN_ALM").use).toBe("input"); // an actuator, but ALM+ says it drives
    expect(use("PIN_ENA").use).toBe("output");
    expect(use("PIN_ONLY_IN").use).toBe("input"); // led.A wants driving, but GPIO35 cannot
    const c = bringupCpp(rot, rotPins, ESP32);
    expect(c).not.toContain("pinMode(PIN_ONLY_IN, OUTPUT)");
    // GPIO34-39 on a classic ESP32 have no internal pull-up: say so rather than pretend.
    expect(c).toContain("pinMode(PIN_ONLY_IN, INPUT);");
    expect(c).toContain("no internal pull-up");
  });

  test("5: ESP32-P4, C5 and C61 boards get the pinned pioarduino platform; the rest stays on espressif32", async () => {
    const pio = "https://github.com/pioarduino/platform-espressif32.git#55.03.312-1";
    const none = async (): Promise<Lookup> => ({ kind: "unavailable" });
    const known = async (): Promise<Lookup> => ({ kind: "found", platform: "espressif32", frameworks: ["arduino"] });
    for (const board of ["esp32-p4", "esp32-p4_r3-evboard", "m5stack-tab5-p4", "esp32-c5-devkitc-1", "seeed_xiao_esp32c5", "esp32-c61-devkitc1"]) {
      for (const lookup of [none, known]) {
        const r = await resolveBoard(board, lookup);
        expect(r.ok && platformSpec(r.family)).toBe(pio);
        if (r.ok) expect(platformioIni({ ...fw, board }, r.family)).toContain(`platform = ${pio}\n`);
      }
    }
    const s3 = await resolveBoard("esp32-s3-devkitc-1", known);
    expect(s3.ok && platformSpec(s3.family)).toBe(`espressif32@${ESP32.version}`);
    const p4 = await resolveBoard("esp32-p4", none);
    expect(p4.ok && p4.family.comment.join("\n")).toContain("55.03.312-1");
  });
});

// The same rules on bundled catalog parts, wired the way a builder would.
describe("bundled parts on a classic ESP32", async () => {
  const defs = await loadPartDefs();
  const project: Project = {
    schema: 1, slug: "probe", name: "Probe", tagline: "", summary: "",
    build: { path: "wire", difficulty: 1, minutes: 1 },
    power: { source: "usb", volts: 5, budgetMa: 500 },
    parts: [
      { ref: "mcu", part: "esp32-devkit-v1" }, { ref: "pot", part: "potentiometer-9mm-vertical" },
      { ref: "enc", part: "rotary-encoder-ky040" }, { ref: "sw", part: "slide-switch-ss12d00" },
    ],
    connections: [
      { from: "mcu.D34", to: "pot.2", net: "POT" },
      { from: "pot.1", to: "mcu.GND" },
      { from: "pot.3", to: "mcu.3V3" },
      { from: "mcu.D25", to: "enc.SW", net: "ENC_SW" },
      { from: "mcu.D26", to: "enc.CLK", net: "ENC_CLK" },
      { from: "enc.GND", to: "mcu.GND.2" },
      { from: "enc.+", to: "mcu.3V3" },
      { from: "mcu.D32", to: "sw.COM", net: "SEL" },
      { from: "sw.A", to: "mcu.3V3" },
      { from: "sw.B", to: "mcu.GND.2" },
    ],
    firmware: { framework: "arduino", board: "esp32dev", behaviour: "Read inputs." },
  };
  const loaded = resolveProject(project, defs);
  const c = bringupCpp(loaded, pinMapDetailed(loaded), ESP32);

  test("a pot on input-only D34 is read with analogRead and no pinMode", () => {
    expect(c).toContain("analogRead(PIN_POT)");
    expect(c).not.toMatch(/pinMode\(PIN_POT, /);
  });

  test("KY-040 SW, a contact to GND stated as dir out, keeps the internal pull-up", () => {
    expect(c).toContain("pinMode(PIN_ENC_SW, INPUT_PULLUP);");
  });

  test("an SS12D00 common between 3V3 and GND on an ADC pin is a digital level, not a wiper", () => {
    expect(c).toContain("digitalRead(PIN_SEL)");
    expect(c).not.toContain("analogRead(PIN_SEL)");
  });
});

// The path that matters for a build: a board with no platform must not stop it. Needs PlatformIO
// to name the platform of the board; without it the answer is the old ESP32 default.
describe.skipIf(!hasPio)("an unsupported board does not stop the build", () => {
  const dirs: string[] = [];
  afterAll(async () => {
    for (const d of dirs) await rm(d, { recursive: true, force: true });
  });

  async function projectWithBoard(board: string): Promise<string> {
    const dir = await mkdtemp(join(tmpdir(), "benchtop-fw-"));
    dirs.push(dir);
    const p = await Bun.file(join(LUFT, "project.json")).json();
    p.firmware.board = board;
    await Bun.write(join(dir, "project.json"), JSON.stringify(p));
    return dir;
  }
  const script = (name: string, dir: string) => Bun.spawn(["bun", join(import.meta.dir, name), dir], { stdout: "pipe", stderr: "pipe" });

  test("firmware.ts says so, writes pins.h and no platformio.ini, and exits 0", async () => {
    const dir = await projectWithBoard("nucleo_f401re");
    const proc = script("firmware.ts", dir);
    const [out, code] = await Promise.all([new Response(proc.stdout).text(), proc.exited]);
    expect(code).toBe(0);
    expect(out).toContain("warning: firmware scaffold limited to include/pins.h");
    expect(out).toContain("ststm32");
    expect(existsSync(join(dir, "firmware", "include", "pins.h"))).toBe(true);
    expect(existsSync(join(dir, "firmware", "platformio.ini"))).toBe(false);
  });

  test("compile.ts reports NOT COMPILED with the reason and exits with the soft code 3", async () => {
    const dir = await projectWithBoard("nucleo_f401re");
    const proc = script("compile.ts", dir);
    const [out, code] = await Promise.all([new Response(proc.stdout).text(), proc.exited]);
    expect(code).toBe(3);
    expect(out).toContain("warning: NOT COMPILED:");
    expect(out).toContain("ststm32");
  });
});
