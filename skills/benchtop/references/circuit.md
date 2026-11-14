# Parts and circuit

## Choosing parts

List `assets/parts/` and read the `blurb`, `electrical` and `verify` fields of candidates.
Prefer a part whose exact model and revision have source-backed geometry for the
intended use, then the simplest part that does the job and is available from suitable
shops. A bundled typical clone model is a starting point for selection, not evidence
that a seller's module fits it. See `geometry-evidence.md`.

Defaults that are right most of the time:

- **Controller**: `esp32-c3-supermini` for anything small with Wi-Fi or Bluetooth;
  `pi-pico-w` when the user wants MicroPython; `esp32-s3-devkitc-1` for audio, cameras or
  many pins; `esp32-devkit-v1` only when the user already owns one.
- **Logic level**: all library controllers are 3.3 V. Choose 3.3 V peripherals where a
  choice exists. A 5 V output into a 3.3 V pin is the most common way beginners kill a
  board; the validator catches it.
- **Bus**: I2C peripherals share two wires and are the easiest thing to add.
- **Someone who has never soldered**: the gentlest build uses boards that come with pin
  headers already fitted and push-on jumper leads (`joint: "dupont"`), or a keyed
  plug-together family (STEMMA QT, Qwiic, Grove), where the cable only fits one way.
  The library's boards and breakouts are the same parts whether or not headers are
  fitted, so use them as they are for a jumper-lead build and, when sourcing, filter for
  "headers soldered", because the same module is sold both ways. Keyed plug-together
  boards are different products with different outlines: add those as project parts.
  One thing is not modelled: which way the pins point. A board sold with headers usually
  has them pointing down, away from the components, so leads push on from underneath.
  The case leaves 14 mm above a part for the lead housings and does not know which side
  the pins are on. Follow "Headers pointing down" below; do not improvise a mount.
- **Parts sold by count or length**: an LED strip's part file gives current per pixel.
  Say how many the build has with `units` on the part's entry in `parts`
  (`{ "ref": "strip", "part": "ws2812b-strip", "units": 8 }`); the power checks multiply
  by it and warn `units-missing` if you forget. The geometry follows `units` too: the
  library strip is one 16.67 mm pixel (60 LEDs/m) that repeats, so 8 pixels are a 133 mm
  body with eight LEDs, the pads at the input end, and a lid window over all of them, in
  the guide, the drawings, the case and the renders. A strip with another pitch is a
  project copy of the file with its own `repeat.pitch` (see "Adding a part"). For a rigid
  bar use `ws2812b-stick-8` (8 pixels, 51 x 10 mm, pads on the back at both ends); its
  currents are for all eight, so it takes no `units`.

### Headers pointing down

A board sold with headers fitted has the long pins under the PCB, plastic housing against
the underside. The part files do not model this: they place pads and body as seen from
above and know nothing under the board. The case only sees the floor `standoff` under it
(3 mm unless `mounts` says otherwise), so a board left at the default stands on its pins
or sits tilted. Allow for it in the project:

1. Measure, on the real board, from the underside of the PCB to the tips of the pins
   (calipers). A common 2.54 mm header is about 8 to 9 mm; that figure is typical, not
   from a source, so measure. Add 0.5 to 1 mm.
2. Put the result as `standoff` on the board's entry in `enclosure.mounts`, for example
   `{ "ref": "mcu", "on": "floor", "standoff": 9 }`. Each millimetre adds a millimetre to
   the case height (checked with `concept.ts`: 3 mm gave 22 mm tall, 9 mm gave 28 mm,
   same project). Side ports follow the board up, so a USB opening moves with the standoff.
3. Leave `inner` out so the cavity grows. An `inner.h` copied from an earlier run keeps
   the old height and the layout warns that it is too low.
4. Say in the hand-over that the board stands on 9 mm posts, pins down, and that the posts
   locate it but do not clamp it (a board without mounting holes sits between four
   corner posts): a dab of hot glue on a post stops it rattling.
5. Wiring: the pads on the top face still carry the solder joints of the header, so
   soldered wires (`joint: "solder"`) go on top as drawn and need nothing more. Push-on
   leads (`joint: "dupont"`) fit the pins from underneath, and the lead housings hang
   below the board. The case adds its 14 mm for housings above the board whatever the
   joint (a dupont build measured 50 mm tall with a 17 mm standoff), so for a compact
   case prefer soldered wires, or accept the height and say why.
6. If the pins are the problem, not the board, cut or file them flush, or fit a female
   header or socket and plug the board into it: then the standoff is that part's height.

Do not edit the part file to pretend the board is thicker or add a downward shape: the
guide draws pads on the top face and a shape under the board would hide them.

## Writing connections

Each connection is one physical wire or trace between two pads:

```json
{ "from": "mcu.GPIO6", "to": "oled.SDA", "net": "I2C_SDA", "color": "blue", "why": "Data line" }
```

- Pin names are the silkscreen labels in the part file, or an alias (`GPIO6` works where
  the board prints `6`).
- `net` names the signal for the firmware pin map (`PIN_I2C_SDA`). Name every signal the
  firmware will use; power and ground are named automatically.
- `why` is the caption under that step of the guide. Write it for the builder: four to
  eight words on what the wire is for.
- `color`: red for power, black for ground, and one colour per signal kept consistent
  across the build. Defaults follow that rule if you leave it out.
- **Order matters**: connections become guide steps in the order written. Put power and
  ground first, then signals, grouped by part, so the builder finishes one module before
  starting the next.
- **Daisy-chain instead of crowding**: three wires on one pad is hard to solder. Run
  power from the controller to the first module and from that module's pad on to the
  next, as the example does. The validator warns on crowded pads.
- Passives are parts. An LED needs `mcu.GPIO2 -> r1.1`, `r1.2 -> led.A`, `led.K -> mcu.GND`.

## The validator

`validate.ts` exits 1 on any error. What it checks, by code:

| Code | Meaning |
| --- | --- |
| `rail-short` | Two different supply rails, or a rail and ground, on one net |
| `overvoltage` | A pin sees more than it survives (a 5 V echo pin into a 3.3 V GPIO) |
| `no-divider` | A higher-voltage signal reaches a pin through a single series resistor. One resistor limits current, it does not lower the voltage; a divider needs a second resistor from the pin to ground |
| `logic-level-low` (warn) | An input needs more volts to read "high" than its driver gives (3.3 V data into a 5 V LED strip). Often works on a short wire; say so and offer a level shifter. The library has one: `74ahct125-dip14`, powered from the 5 V rail, controller pin to `1A`, `1Y` through 330 ohm to the strip's DIN, the other pins tied to GND (its pin notes say which) |
| `high-below-supply` | An input that switches a transistor tied to its own supply (a low-triggered buzzer or relay module) is fed from a higher rail than the pin driving it, so the controller can turn it on but never off. Feed the module from the controller's rail |
| `undervoltage`, `unpowered`, `no-ground` | A part cannot run as wired |
| `missing-capability` | A pin needs ADC, PWM and so on, and the controller pin lacks it |
| `input-only-driven` | An input-only controller pin wired to something it must drive |
| `flash-pin` (error), `strapping-pin`, `usb-pin` (warn) | Controller pins with a catch; the message quotes the pin's note |
| `multiple-drivers` | Two outputs fighting on one net |
| `i2c-address-clash`, `i2c-no-pullups` | Bus problems |
| `led-no-resistor` | A bare LED with nothing limiting its current |
| `power-budget`, `rail-budget` | The supply or a regulator is asked for more than it has |
| `declared-limit` (info), `limit-without-reason` | A part's draw is capped by `peakMa` on its entry in `parts`; see below |
| `crowded-pad`, `unused-signal` | Buildability and loose ends |
| `power-entry` | `project.power` does not describe a real way in |

**The 500 mA default is a computer's USB port.** An ESP32 with Wi-Fi on peaks near
400 mA by itself, so a Wi-Fi build with LEDs or a buzzer does not fit 500 mA and is not
meant to. If the device will run from a USB charger, set `power.budgetMa` to the
charger's rating (1000 for a 1 A charger) and tell the user a computer port will not do.

**When the honest numbers do not fit the supply.** Eight addressable LEDs at full white
draw more than a USB port gives. Do not edit the part file to make the check pass: the
part really can draw that. Either power the hungry part from its own supply, or cap it in
firmware and declare the cap on the part's entry in `parts`:

```json
{ "ref": "strip", "part": "ws2812b-strip", "units": 8, "peakMa": 120, "peakMaWhy": "Firmware caps brightness at 63 of 255 (LED_BRIGHTNESS_CAP = 63), 480 mA x 63/255 = 119 mA" }
```

The check then uses 120 mA for the whole strip instead of 8 x 60 = 480 mA, and reports
`declared-limit` quoting both figures, so the dependency stays visible. Enforce the cap in `main.cpp` in a way that cannot be removed by accident (a
constant with a `static_assert`), and tell the user that the limit lives in firmware.

The validator does not check resistor values. When you design a divider or an LED
resistor, state the values in the part's `value` and `label`, and give the user one
multimeter check that proves the resistors are the right way round.

The fix text is written to be acted on. If you disagree with a finding, the usual cause
is a part file that is wrong or incomplete; fix the part file and note it.

The validator does not know what the firmware does. It cannot tell that you put a
button on a pin you also use for the display. `net` names and the generated `pins.h`
help you see that; read the pin map after `firmware.ts`.

## Adding a part

When the library lacks a part, write `<projectDir>/parts/<id>.json`. Project parts
override library parts of the same id, which is also how you correct a library part for
one build.

1. For a board or module, ask the parts catalog before anything else. A snapshot ships
   with the skill, so this needs no setup: `bun scripts/catalog.ts find "<exact model>"`,
   then `bun scripts/catalog.ts pads <part_id>`. If `pads` lists a dataset, the maker's
   CAD file has been parsed and you do not type pad positions:
   `bun scripts/catalog.ts import-part <part_id> --id <id> --out <projectDir>/parts/<id>.json`
   writes the draft and prints what it left for you; steps 5 to 9 below still apply to
   those fields. `references/catalog.md` ("Pad positions from CAD") has the flags and the
   traps. Import only the exact board or module you will buy, same maker and revision: a
   branded board's pads and size say nothing about a clone's.
2. No pad data in the catalog, or a plain component the catalog does not hold: find the
   datasheet or the manufacturer's mechanical drawing. A retailer listing is a last
   resort. `bun scripts/catalog.ts show <part_id>` lists source-linked dimensions and the
   drawings to open, when the part is in the catalog at all. `references/catalog.md` has
   the reading rules, which matter: a PCB outline is not the assembled height.
3. Use an existing file only as a structural template. Do not carry over its pad
   positions, connector locations, hole positions or heights to another clone. Fields
   are documented in `scripts/lib/types.ts`. Keep incomplete research records in
   `assets/geometry-evidence/` or the project's research folder until the required
   fields can be filled from evidence.
4. Origin is the top-left corner seen from above, component side up, in the orientation
   the silkscreen reads; x right, y down, millimetres. Controller boards have USB at y = 0.
5. `pins`: one per pad, named as printed, at real pad centres. Set `role`; `volts`,
   `minVolts`, `maxVolts` on supply pins; `dir` and `needs` on signals with a fixed
   direction or a required capability; `gpio` and `caps` on controller pins.
6. `shapes`: the three to eight things that make the part recognisable, with real
   heights. `ports`: every opening a case would need. A module whose header pins are its
   pads (microphone, buzzer, amplifier, relay) tags the header box `"header"` and puts
   the pins at their real places under it: the drawings then put each pad, and the end of
   every wire, on the top of the header. Name every LED `led-1`, `led-2` ... so the
   renders light them. For something sold by length or count (a strip), give the file ONE
   unit and a `repeat` block: `{ "pitch": 16.67, "shapes": [ { "kind": "box", "tag": "led", ... } ], "span": "<name of the port that must cover all units>" }`.
   `body.w` is then one unit long; the pins stay at the input end; the project's `units`
   makes the body, the LED shapes (`led-1` ... `led-N`) and the spanning port as long as
   the build needs, once, when the project is loaded.
7. `electrical`: supply current typical and peak, logic level, I2C addresses and whether
   pull-ups are fitted. Add `"bringUp": "pulse"` only if switching the part on for 400 ms
   in a test can do no harm (an LED, a buzzer); leave it out for anything that moves,
   heats or switches a load, and the bring-up test will hold that pin still. On an input
   that is active when low, set `"idle": "high"` on the pin so the test never rests it at
   the level that switches it on.
8. `sources`: the URLs you actually read. `confidence: "datasheet"` only when outline and
   pads came from a manufacturer drawing; otherwise `"typical"` with a `verify` note
   saying what to measure.
9. Run `bun scripts/check-parts.ts <projectDir>/parts`.

Do not guess a dimension to make a part file pass. If it is unpublished, retain it as
unknown in a research record and list the measurements needed. A typical model can
illustrate a concept if identified as such; it cannot establish connector cutouts,
carrier-board pad positions or a case fit. A draft from `import-part` is the maker's
file, not a measurement of the board you bought, and the values the command lists as
not derived are placeholders, not evidence: replace each from a source before a case
or a board depends on it. Deliver the supported subsystem while waiting for the
missing geometry; see `scope-and-assessment.md`.
