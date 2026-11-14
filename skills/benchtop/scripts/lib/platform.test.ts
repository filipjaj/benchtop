import { describe, expect, test } from "bun:test";
import { FAMILIES, type Lookup, guessFamily, parseBoards, resolveBoard } from "./platform";

const found = (platform: string, frameworks = ["arduino"]): Lookup => ({ kind: "found", platform, frameworks });
const asks = (l: Lookup) => async (): Promise<Lookup> => l;

describe("the pinned platform table", () => {
  test("every platform is pinned to an exact version, never a range or a bare name", () => {
    for (const f of FAMILIES) {
      expect(f.version).toMatch(/^\d+\.\d+\.\d+$/);
      expect(f.comment.join("\n")).toContain(f.version);
      expect(f.comment.join("\n")).toContain("2026-");
    }
    expect(new Set(FAMILIES.map((f) => f.platform)).size).toBe(FAMILIES.length);
  });
});

describe("parsing what PlatformIO says about a board", () => {
  const list = JSON.stringify([
    { id: "rpipico", platform: "raspberrypi", frameworks: ["arduino", "picosdk", "mbed-ce"] },
    { id: "rpipico", platform: "raspberrypi", frameworks: ["arduino", "picosdk"] },
    { id: "rpipico2", platform: "raspberrypi", frameworks: ["arduino"] },
  ]);

  test("matches the exact id only and merges the frameworks of a board listed twice", () => {
    expect(parseBoards(list, "rpipico")).toEqual({ kind: "found", platform: "raspberrypi", frameworks: ["arduino", "picosdk", "mbed-ce"] });
  });

  test("an id that is only a substring of others is unknown, with those ids as suggestions", () => {
    expect(parseBoards(list, "pico")).toEqual({ kind: "unknown", suggestions: ["rpipico", "rpipico2"] });
  });

  test("output that is not a board list means PlatformIO could not be asked", () => {
    expect(parseBoards("Error: nope", "uno")).toEqual({ kind: "unavailable" });
    expect(parseBoards('{"id":"uno"}', "uno")).toEqual({ kind: "unavailable" });
  });
});

describe("the board decides the platform", () => {
  test("the three families PlatformIO routes to a pinned platform", async () => {
    const pico = await resolveBoard("pico", asks(found("raspberrypi")));
    const uno = await resolveBoard("uno", asks(found("atmelavr")));
    const esp = await resolveBoard("esp32-s3-devkitc-1", asks(found("espressif32")));
    expect(pico.ok && pico.family.id).toBe("rp2040");
    expect(uno.ok && uno.family.id).toBe("avr");
    expect(esp.ok && esp.family.id).toBe("esp32");
  });

  test("a platform the scaffold has no pinned version for is a reason, not a guess", async () => {
    const r = await resolveBoard("nucleo_f401re", asks(found("ststm32")));
    expect(r.ok).toBe(false);
    if (!r.ok) {
      expect(r.reason).toContain("ststm32");
      expect(r.reason).toContain("pins.h");
    }
  });

  test("a board of a known platform that has no Arduino framework is unsupported", async () => {
    const r = await resolveBoard("some_picosdk_only", asks(found("raspberrypi", ["picosdk"])));
    expect(r.ok).toBe(false);
  });

  test("an id PlatformIO does not know is unsupported, and the reason lists the ids that contain it", async () => {
    const r = await resolveBoard("nano", asks({ kind: "unknown", suggestions: ["nanoatmega328", "nanoatmega328new"] }));
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.reason).toContain("nanoatmega328new");
  });

  test("an unknown id that looks like an ESP32 stays on espressif32, so a typo is a real compile error as before", async () => {
    const r = await resolveBoard("esp32-s3-devkit-typo", asks({ kind: "unknown", suggestions: [] }));
    expect(r.ok && r.family.platform).toBe("espressif32");
  });

  test("without PlatformIO the name decides, and an unrecognised name keeps the ESP32 default", async () => {
    const none = asks({ kind: "unavailable" });
    const pico = await resolveBoard("rpipicow", none);
    const nano = await resolveBoard("nanoatmega328new", none);
    const odd = await resolveBoard("mystery_board", none);
    expect(pico.ok && pico.family.id).toBe("rp2040");
    expect(nano.ok && nano.family.id).toBe("avr");
    expect(odd.ok && odd.family.id).toBe("esp32");
  });

  test("name patterns do not mistake other vendors' boards for AVR or ESP32", () => {
    expect(guessFamily("nanorp2040connect")?.id).toBe("rp2040");
    expect(guessFamily("uno_r4_wifi")).toBeUndefined();
    expect(guessFamily("nano_every")).toBeUndefined();
    expect(guessFamily("nucleo_f401re")).toBeUndefined();
    expect(guessFamily("lolin_c3_mini")?.id).toBe("esp32");
  });
});
