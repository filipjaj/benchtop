import { afterAll, describe, expect, test } from "bun:test";
import { existsSync } from "node:fs";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { bringupCpp, platformioIni, rp2040I2cBus } from "./firmware";
import { FAMILIES } from "./lib/platform";
import { pinMapDetailed } from "./lib/pinmap";
import { loadProject } from "./lib/project";

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

  test("outputs are still put at idle before anything is switched, on every family", () => {
    for (const f of [ESP32, RP2040, AVR]) {
      const c = bringupCpp(loaded, pins, f);
      const firstWrite = c.indexOf("digitalWrite(");
      const firstOutput = c.indexOf("OUTPUT);");
      if (firstWrite >= 0) expect(firstWrite).toBeLessThan(firstOutput);
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
