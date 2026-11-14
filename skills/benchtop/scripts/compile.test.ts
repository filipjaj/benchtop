import { describe, expect, test } from "bun:test";
import { summarise } from "./compile";

// Real output, trimmed: the failure is the one a trial build shipped.
const FAILED = `Processing main (platform: espressif32@8.0.0; board: esp32-s3-devkitc-1; framework: arduino)
Compiling .pio/build/main/src/main.cpp.o
src/main.cpp: In function 'void initMic()':
src/main.cpp:70:53: error: 'I2S_DATA_BIT_WIDTH_32_BIT' was not declared in this scope; did you mean 'I2S_DATA_BIT_WIDTH_32BIT'?
   70 |     .slot_cfg = I2S_STD_PHILIPS_SLOT_DEFAULT_CONFIG(I2S_DATA_BIT_WIDTH_32_BIT, I2S_SLOT_MODE_MONO),
*** [.pio/build/main/src/main.cpp.o] Error 1
==================== 1 failed, 0 succeeded in 00:00:08.414 ====================`;

const OK = `Linking .pio/build/main/firmware.elf
RAM:   [==        ]  15.6% (used 51176 bytes from 327680 bytes)
Flash: [===       ]  34.5% (used 1153973 bytes from 3342336 bytes)
========================= 1 succeeded in 00:00:27.550 =========================`;

describe("compile output", () => {
  test("a failed compile yields the compiler's own line with file, line and column", () => {
    const r = summarise("main", FAILED, 1, 8.4);
    expect(r.ok).toBe(false);
    expect(r.errors[0]).toStartWith("src/main.cpp:70:53: error: 'I2S_DATA_BIT_WIDTH_32_BIT'");
    expect(r.errors.length).toBe(2); // the diagnostic and the make-style summary, not the source echo
  });

  test("a compile that succeeds reports sizes without the progress bar", () => {
    const r = summarise("main", OK, 0, 27.5);
    expect(r.ok).toBe(true);
    expect(r.errors).toEqual([]);
    expect(r.size).toEqual(["RAM: 15.6% (used 51176 bytes from 327680 bytes)", "Flash: 34.5% (used 1153973 bytes from 3342336 bytes)"]);
  });

  test("the same error printed for several files is listed once", () => {
    const twice = `a.h:3:1: error: unknown type name 'foo'\na.h:3:1: error: unknown type name 'foo'`;
    expect(summarise("main", twice, 1, 1).errors.length).toBe(1);
  });

  test("a linker failure is an error too", () => {
    const r = summarise("main", "main.cpp:(.text+0x10): undefined reference to `missing()'\ncollect2: error: ld returned 1 exit status", 1, 1);
    expect(r.errors.length).toBe(2);
  });
});
