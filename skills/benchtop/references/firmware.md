# Firmware step

Goal: a PlatformIO project whose pin numbers come from the wiring, a bring-up sketch that proves
each part is connected, then the real firmware in `src/main.cpp`.

What has been run: `bun scripts/firmware.ts`, and `pio run` for both environments. On
PlatformIO 6.2.0 with the pinned platforms, the generated bring-up test and main skeleton
compile (sizes are flash used, bring-up / main skeleton):

| Family | Board | Platform | Flash, bring-up / main |
| --- | --- | --- | --- |
| ESP32 | `esp32-c3-devkitm-1` | `espressif32@8.0.0` | 338 KB / 300 KB |
| ESP32 | `esp32-s3-devkitc-1` | `espressif32@8.0.0` | 323 KB / 319 KB |
| RP2040 | `pico`, `rpipico`, `rpipicow` | `raspberrypi@1.20.0`, arduino-pico core | 43 KB / 33 KB (`pico`) |
| AVR | `uno` | `atmelavr@5.3.0` | 6.6 KB / 1.4 KB (of 32 KB) |

Two complete ESP32-C3 `main.cpp` programs written by agents following this reference also
compiled (a display and sensor build with the Adafruit libraries, and an ultrasonic sensor
with an LED strip), and a Pico W sketch using `WiFi.h` compiled. Not compiled: other AVR
boards (`nanoatmega328new`, `megaatmega2560`), RP2350 (`rpipico2`), the classic `esp32dev`
board; they share the family's platform and code but have not been built. Nothing has been
uploaded to a board: `-t upload`, `pio device monitor` and wokwi-cli are untested.

## Which boards are supported

`firmware.board` decides the PlatformIO platform for `"framework": "arduino"`. `firmware.ts`
asks PlatformIO (`pio boards --json-output <board>`) which platform the board belongs to, and
falls back to the board name when PlatformIO is not installed or does not know the id. Three
platforms are supported, each pinned to an exact version in `scripts/lib/platform.ts`:

- `espressif32` (ESP32, C3, S3 and the rest): Arduino core 3.x. The registry's 8.0.0 has no
  ESP32-P4, C5 or C61 board ("Unknown board ID"), so a board id naming one of those chips
  (`esp32-p4`, `esp32-c5-devkitc-1`, `esp32-c61-devkitc1`, ...) gets pioarduino's fork instead,
  pinned to a git tag: `https://github.com/pioarduino/platform-espressif32.git#55.03.312-1`
  (Arduino core 3.3.12), the tag a working ESP32-P4 Arduino project builds with. The generated
  scaffold has not been compiled on it; C5 and C61 have not been built at all.
- `raspberrypi` (RP2040: `pico`, `rpipico`, `rpipicow`; RP2350 untested) with the arduino-pico
  (earlephilhower) core, selected by `board_build.core = earlephilhower`. The platform's default
  core is Arduino-Mbed, which has no Wi-Fi on the Pico W, no `Serial.printf` and no `Wire.setSDA`.
  The ini pins the platform; the platform pins the core to a fixed commit.
- `atmelavr` (Uno, Nano, Mega): classic AVR, 2 KB of RAM on an Uno.

The generated code differs per family. ESP32 uses `Wire.begin(sda, scl)` and, on C3 and S3,
native USB flags. RP2040 uses `Wire.setSDA/setSCL/begin()` on `Wire` or `Wire1`, whichever
controller the SDA/SCL pair belongs to (GPIO 0/1, 4/5, ... are i2c0; 2/3, 6/7, ... are i2c1);
a pair that is neither is reported on the serial port and the build still compiles. AVR has no
`Serial.printf` and fixed I2C pins: the bring-up prints with `Serial.print`, keeps its text in
flash with `F()`, and says on the serial port when `pins.h` names SDA/SCL pins other than the
board's fixed ones. On an Uno the main skeleton and bring-up fit with room to spare, but a
real program with a display library will not: watch the RAM figure the compile prints.

A board outside these three platforms (STM32, nRF52, ESP8266, Teensy, ...), a board id PlatformIO
does not know, or a board without an Arduino framework, gets `include/pins.h` only. `firmware.ts`
prints `warning: firmware scaffold limited to include/pins.h: <reason>`, `compile.ts` prints
`warning: NOT COMPILED: <reason>` and exits 3, `build.ts` marks the compile step skipped, lists the
reason under Flagged, and carries on to the guide and package. Say in the hand-over that the
firmware is unchecked. Do not move a design to an ESP32 to get a build. `esp-idf` and `esphome`
are ESP32-only: on another family's board `firmware.ts` warns and says to use `arduino`.

In a three-model trial on an ESP32-S3, two models' programs compiled first time and one
shipped with a misspelled identifier because it chose not to compile. So compiling is
no longer a choice: `bun scripts/compile.ts <projectDir>` builds both environments and
prints compiler errors as `file:line: message`, and `build.ts` runs it and fails when it
fails. Write `main.cpp`, then compile, then fix what it reports, before anything else.

The first compile for a chip family (C3, S3, classic ESP32 each have their own) downloads
the platform and toolchain (about 1 GB) and takes a few minutes; later builds take 15 to
30 seconds. That download is PlatformIO fetching what `platformio.ini` pins. It is part of
building, not an installation to ask permission for. If PlatformIO itself is missing the
build report says NOT COMPILED: repeat that in the hand-over.

The pinned platform ships Arduino core 3.x on ESP-IDF 5. Code and examples written for
core 2.x need care: the legacy I2S driver still builds but warns as deprecated (the new
one is `driver/i2s_std.h`, where the 32-bit width is `I2S_DATA_BIT_WIDTH_32BIT`), DMA
field names changed (`dma_buf_count` became `dma_desc_num`), and the RMT helpers are
`rmtInit` / `rmtWrite`. Trust the compiler over memory.

## 1. Generate

```
bun scripts/firmware.ts <projectDir>           # arduino: writes <projectDir>/firmware/
bun scripts/firmware.ts <projectDir> --force   # also overwrite src/main.cpp (or the ESPHome yaml)
```

Needs `firmware` in project.json: `framework`, `board` (PlatformIO board id), `libs`, `behaviour`.
Rerun it after any wiring change in project.json.

`platformio.ini` is rewritten on every run, so settings for the module actually fitted go
in project.json: `buildFlags` (compiler flags, one per entry) and `boardOptions`
(PlatformIO `board_*` settings). The case that matters: an ESP32-S3 module with extra RAM
(N8R8, N16R8) keeps that RAM switched off under the generic `esp32-s3-devkitc-1` board,
and an audio or camera buffer then gets seconds instead of minutes. Turn it on with

```json
"firmware": {
  "framework": "arduino", "board": "esp32-s3-devkitc-1", "libs": [], "behaviour": "...",
  "buildFlags": ["-DBOARD_HAS_PSRAM"],
  "boardOptions": { "board_build.arduino.memory_type": "qio_opi" }
}
```

Only for a module that has it: `qio_opi` on a module without the extra RAM does not boot.
Keep a `psramFound()` fallback in the code and say in the hand-over which module the
build assumes.

| File | On rerun |
| --- | --- |
| `platformio.ini` | overwritten; change board and libs in project.json |
| `include/pins.h` | overwritten, never edit |
| `src/bringup.cpp` | overwritten, built only in `[env:bringup]` |
| `src/main.cpp` | kept unless `--force`; this is where you write the behaviour |

A pin constant is named after its net (`net: "LED_DATA"` gives `PIN_LED_DATA`). Rename or
remove a net in project.json and the constant changes with it, while `main.cpp` is kept:
`firmware.ts` then warns which names `main.cpp` uses that `pins.h` no longer defines.
Fix them before compiling.

Other frameworks: `esphome` writes `<slug>.yaml` (pins as substitutions, I2C bus declared, kept on
rerun unless `--force`). `esp-idf` writes `include/pins.h` only. `micropython` writes `pins.py`
only. For those two, CMake, sdkconfig, boot.py and flashing are yours.

## 2. pins.h is the only source of pin numbers

Use `PIN_I2C_SDA`, `PIN_BUTTON` and so on. Never type a GPIO number in `main.cpp`. If a pin is
wrong, fix the connection in project.json and regenerate, so the wiring guide, the PCB and the
firmware stay in agreement. Named nets (`"net": "I2C_SDA"`) give `PIN_I2C_SDA`; unnamed ones are
named from the peripheral, for example `PIN_BTN_1`. The comment on each line says what is on the
other end.

## 3. Bring-up first

Write behaviour only after bring-up passes.

```
cd <projectDir>/firmware
pio run -e bringup -t upload
pio device monitor
```

Read the serial output top to bottom:

- `[pins]` the pin map as compiled in. Compare it with the wiring.
- `[i2c]` every address that answered, then one line per part:
  `[ OK ] <part> found at 0xNN` or `[MISS] <part> missing, expected at 0x.. 0x..`.
  Nothing answering at all means power, ground, or SDA and SCL swapped. One part missing means
  its own wiring, or its address jumper is set to an address not in the part definition.
- `[out]` every output is first put at its idle level (the level at which the part on it does
  nothing: HIGH for a low-triggered relay or buzzer, or for a stepper driver's ENA). This is
  the first thing `setup()` does, in `bringup.cpp` and in the generated `main.cpp`, before
  `Serial` waits up to 3 s for the host; keep it first when you write `main.cpp`. The level is
  set before the pin becomes an output (on ESP32 with `gpio_set_level`, because Arduino core 3
  ignores a `digitalWrite` before `pinMode`). From reset until `setup()` runs the pin still
  floats for a few hundred ms: where that matters (ENA, a relay), fit a pull resistor to the
  idle level. Then only parts whose part file says
  `electrical.bringUp: "pulse"` are switched on for 400 ms: an LED, a buzzer. Everything else
  is held at idle and named on the serial port with the reason: relays, servos, motor drivers,
  LED-strip data lines, and any part file that says nothing. The bring-up test never moves or
  switches a load. Test those parts from `main.cpp`, with the load disconnected the first time.
- `[in]` once a second: `PIN_BUTTON=1`. Press the button: the value must flip. The wiring
  decides the pin mode. A switch or button contact, a screw-terminal or connector contact, and
  an open-collector output (a pin with `"dir": "out"` whose note says "open collector" or
  "open drain", such as a stepper driver's alarm opto) get `INPUT_PULLUP`, so released reads 1
  and pressed reads 0. A push-pull output (`"dir": "out"`, no such note) or a net with a pull
  resistor already fitted gets `INPUT`. A pot wiper (the middle pin of an input or sensor part
  whose other pins go to a supply and ground) on a pin with the `adc` cap, or a pin whose part
  says `"needs": ["adc"]`, is read with `analogRead` and no pull-up. A stated `dir` on the other
  end beats the guess from the part's kind; an `input-only` controller pin is never an output,
  and has no internal pull-up, so the test says when it needs an external one. A pull-up makes
  a broken wire read 1: for a signal where 1 means healthy (an E-STOP), decide the fail-safe
  level in `main.cpp` and fit the resistor that gives it.

A `[MISS]` is a wiring fault until proven otherwise. Do not write driver code around it.

Then flash the real thing: `pio run -e main -t upload`. The ini defaults to `main`, so a bare
`pio run` builds main.

Monitor opens at 115200. Exit with Ctrl+C. Close the monitor before uploading; it holds the port.

## 4. Platform pin

`platformio.ini` pins the platform (`espressif32`, `raspberrypi` or `atmelavr`) to an exact
version, with the reason in a comment. Do not change it to a bare name. To bump one, edit its
entry in `FAMILIES` in `scripts/lib/platform.ts` (the pioarduino tag is `ESP32_PIOARDUINO`
there), rebuild both environments on a board of that family, and check bring-up still passes.

Pico upload: `pio run -e bringup -t upload` needs the board in BOOTSEL mode (hold BOOTSEL while
plugging in USB) the first time; it then re-enumerates as a serial port. Uno and Nano upload over
their own USB serial chip with no button. Neither has been tried on a board.

## 5. First-flash problems on ESP32-C3 and S3

- **No serial port appears.** Hold BOOT, plug in USB, release BOOT. The chip is now in download
  mode and the port appears. After upload, press RESET or replug.
- **Port is there but the monitor is silent.** These chips use native USB, so `Serial` must go to
  USB CDC. The generated ini sets `-DARDUINO_USB_MODE=1 -DARDUINO_USB_CDC_ON_BOOT=1`. On an S3
  devkit with two USB ports, the flags route Serial to the port labelled USB, not UART. Use that
  port, or delete the two flags to use the UART port.
- **Port disappears after upload or reset.** Normal for native USB: the device re-enumerates. Rerun
  `pio device monitor`. Early output can be lost; bring-up waits up to 3 seconds for the host.
- **Port never shows up on any attempt.** Charge-only cable. Try a cable known to carry data.
- **Upload fails with "Wrong boot mode" or timeouts.** Enter download mode as above, and check
  that no part is pulling a strapping pin (C3: GPIO2, 8, 9; S3: GPIO0, 3, 45, 46) at reset.
- **GPIO behaves oddly.** GPIO18 and 19 on C3, GPIO19 and 20 on S3, are the USB pins. Using them
  as GPIO kills USB serial.

## 6. Optional: simulate with wokwi-cli (untested)

Only useful for logic that does not depend on real sensors. Needs a free account and an API
token from wokwi.com, exported as `WOKWI_CLI_TOKEN`. The free plan gives 50 simulation minutes a
month, so cap each run at 10 to 30 seconds and run it only when a change is worth checking.

1. Install the CLI per wokwi.com docs (untested).
2. Build first: `pio run -e main`.
3. Add `wokwi.toml` in `firmware/` pointing at the built `firmware.bin` and `firmware.elf` under
   `.pio/build/main/`, and a `diagram.json` with the board and parts (untested).
4. Run with a timeout and an expected string:
   `wokwi-cli --timeout 15000 --expect-text "ready" .` (untested)

Treat a pass as a smoke test. Bring-up on real hardware is still the check that counts.
