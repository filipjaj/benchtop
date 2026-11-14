---
name: benchtop
description: Take a microcontroller or 3D-printing project from a loose idea to a package someone can build - concept, parts and live prices, a checked circuit, a carrier PCB or an illustrated flat-pack-style soldering guide drawn to scale, a 3D-printable enclosure, firmware scaffold, and a designed landing page with every file. Use this whenever the user wants to make a physical electronics thing (ESP32, ESP8266, Arduino, Raspberry Pi Pico, XIAO, sensors, displays, LEDs, buttons, servos, batteries), asks what parts to buy, how to wire or solder something, whether to order a PCB, wants a case or enclosure for electronics, wants a wiring diagram, BOM, assembly instructions or a build guide, or wants to present or share a hardware project - even if they only say "I want to build a thing that..." and never mention a microcontroller.
---

# Benchtop

Turns "I want a thing that..." into a folder a person can build from: a guide, a parts
list, a case to print, a board to order, firmware to flash, and a page that shows it off.

## The one idea

Everything is generated from **one file, `project.json`**, plus the part definitions in
`assets/parts/`. You write and edit that file; scripts derive the drawings, the checks,
the case, the board, the pin numbers and the page from it.

This is what makes the output trustworthy. A wiring diagram you draw by hand and a pin
table you type by hand will disagree with each other sooner or later, and a beginner
cannot tell which one is wrong. So: never hand-draw a wiring illustration, never type a
GPIO number into firmware, never quote a dimension that is not in a part file. Change
`project.json` (or a part file) and regenerate.

`scripts/lib/types.ts` is the schema, with a comment on every field.
`examples/luft/project.json` is a complete project file (parts, connections, enclosure,
firmware and showcase blocks); read it before writing your first one. It ships with its
firmware in `examples/luft/firmware/` (the one piece written by hand, and a model for
what `main.cpp` should look like) but without the other generated output: run the
scripts on a copy to see what each produces.

## Setup

Scripts are TypeScript run with **bun** from this skill's directory. The core (checks,
BOM, sourcing, guide, concept sheet, landing page, firmware scaffold) has no dependencies.

| Step | Needs | If missing |
| --- | --- | --- |
| Enclosure, PCB | `bun install --cwd scripts` once (JSCAD, tscircuit, pinned) | The script prints the command and exits 3. Tell the user what will be installed, then run it. |
| Guide PDF, screenshots | Chrome, Chromium or Edge | HTML still works; the user prints to PDF from a browser. |
| Compiling firmware | PlatformIO (`pio`) | Scaffold is still written; say it is uncompiled. |
| 3D renders | Blender on PATH | `render.ts` exits 3 with one line; the page falls back to the line drawing and the 3D viewer. |

Work in a project folder the user chooses (ask once; default `./<slug>/`). All commands
take that folder: `bun <skill>/scripts/<name>.ts <projectDir>`.

## The flow

Six phases. Each ends with something the user can look at and a decision that is theirs.
Do not run ahead through a decision: a wrong guess at phase 1 wastes everything after it.
If the user arrives mid-way ("I have the parts, I need a case"), start at that phase and
build the minimum `project.json` it needs.

### 1. Imagine

Read `references/imagine.md`. Find out what the thing does for whom, where it lives, how
it is powered and what the user's skill and tools are. Offer two or three genuinely
different directions, not three sizes of the same box. Once a direction is picked, write
a first `project.json` (parts and enclosure block, no connections yet) and run:

```bash
bun scripts/concept.ts <projectDir>      # out/concept.html: closed view, inside view, size, cost
```

Show the user the concept sheet (open it, or screenshot it with `shoot.ts`). **Decision:
is this the thing?** Iterate here; it is the cheapest place to change your mind.

### 2. Parts and circuit

Read `references/circuit.md`. Pick parts from `assets/parts/` (list the folder; each file
has a `blurb`). A part that is not there goes in `<projectDir>/parts/`. Where its pad
positions come from decides whether the guide and the case can be trusted, so before
typing a board or module by hand, ask the parts catalog. A snapshot of it ships with the
skill; there is nothing to set up:

```bash
bun scripts/catalog.ts find "<exact model>"     # is this board or module in the catalog?
bun scripts/catalog.ts pads <part_id>           # does it hold pad positions from the maker's CAD file?
bun scripts/catalog.ts import-part <part_id> --id <id> --out <projectDir>/parts/<id>.json
```

When `pads` lists a dataset, `import-part` writes the draft part file: pads and outline
from the maker's file, ground pins, and where the catalog has them GPIO numbers, logic
level, height and connector openings. It prints what it could not derive (power pins,
price, often the height); fill those in from the datasheet. Import only the exact board
you will buy, same maker and revision: a branded board's pads say nothing about a clone
with the same chip. When the catalog has no pad data for the part, write the file from
the datasheet or the maker's drawing, following `references/circuit.md` ("Adding a
part"). Then write the `connections` and check them:

```bash
bun scripts/validate.ts <projectDir>     # electrical rule check, exit 1 on errors
```

Errors block. Each finding says what is wrong, why it matters and what to change; fix
`project.json` and rerun until it is clean. Warnings are judgement calls: resolve them or
tell the user about them in plain words. Never suppress a finding by editing a part file
to make it pass unless the part file is actually wrong, and say so if you do. When a
part's real draw exceeds the supply and firmware will limit it, declare that with
`peakMa` and `peakMaWhy` on the part's entry (see the reference) rather than hiding it.

### 3. Sourcing and the build path

**Decision, asked explicitly: do you want a finished PCB, or do you want to solder it yourself?**
Explain the three paths in a sentence each and recommend one for this project and this person:

| `build.path` | What the user does | Good when |
| --- | --- | --- |
| `wire` | Solders (or pushes on, `joint: "dupont"`) wires between modules, following the guide | One-off, few connections, wants it this week |
| `pcb-diy` | Orders a bare carrier board, solders the modules onto it | Several units, many connections, wants it tidy and robust |
| `pcb-assembled` | Orders the board with sockets fitted, presses modules in | No soldering iron, or a gift for someone without one |

Then get live prices. Read `references/sourcing-stores.md` first; it covers which stores
have an API, which to search on the web, and VAT and customs for the user's country.

```bash
bun scripts/shopping.ts <projectDir> --region NO   # out/shopping/index.html: the list a person buys from
bun scripts/source.ts <projectDir>       # price and stock candidates per part, from the stores with an API
bun scripts/bom.ts <projectDir>          # out/bom.csv, out/bom.md, estimated total
```

Start with `shopping.ts`. It needs no API: for every part it shows the drawing, what a
listing must match (size, pin order, supply range, height), and buttons that open the
right search at retailers for the user's region (two-letter country code; the store
list is `assets/stores.json`). That page alone is enough for a user to buy from, and
it is the right hand-over when you cannot look prices up yourself. It never orders
anything. Then go further and find real listings and prices where you can:

The bundled parts catalog (`references/catalog.md`) has manufacturer facts, not prices:
`find` and `show` return source-linked dimensions and pins for writing a part file. A
full catalog (located by `--db` or `BENCHTOP_CATALOG`) also has shop listings:
`bun scripts/catalog.ts listings "<part>" --norway`. Its numbers are seller and
manufacturer claims, never measurements.

Expect the API stores to miss generic clone modules (the cheap sensor and display
boards most builds use) and to offer a branded board with a different size or pin order
instead. That is not a match: search the web retailers named in the reference for the
exact variant the part file describes.

`source.ts` gathers candidates; you choose. Prefer one or two shops over five (shipping
dominates small orders), check that each listing is the same variant as the part file
(pin order and size differ between clones), and write your picks into
`project.sourcing`: one line per part with the variant to choose in its `note`, and
one `shipping` entry per shop (leave its `price` out if the shop only shows it at
checkout). When one listing supplies several parts, a resistor assortment for three
resistors, give it one line and name the other refs in `covers`. A part the user says
they already have gets `"owned": true` on its entry in `parts` instead of a line: it
stays in the guide and the checks, costs nothing, and the shopping page tells them
what to verify on the one in their drawer. Rerun `bom.ts`; it then prints the real total including
shipping. Show the user that figure before they order anything. A store reported as
"unavailable" is an outage on its side, not a reason to stop: carry on with the others.

### 4. Build files

Generate what the chosen path needs, then **look at every output before showing it**.
While iterating, run the one script you are working on. Before handing anything over,
run the whole pipeline once so no file is stale or missing:

```bash
bun scripts/build.ts <projectDir> --region NO   # every step in order; stops if the electrical check fails
```

It prints one line per step, repeats everything any generator flagged in one list, and
writes `out/build-report.md`. A step it skips tells you why (Blender missing, no
showcase copy yet). It compiles the firmware: a compile error fails the build, and the
first compile for a chip family downloads its toolchain (about 1 GB, a few minutes),
which is expected. A report that says NOT COMPILED means the firmware is unchecked; say
so in the hand-over. The individual scripts:

```bash
bun scripts/guide.ts <projectDir> --pdf  # out/guide/index.html + guide.pdf
bun scripts/enclosure.ts <projectDir>    # out/enclosure/: body.stl, lid.stl, .3mf, assembly.glb, print.md
bun scripts/pcb.ts <projectDir>          # pcb paths only. pcb/board.tsx + out/pcb/: gerbers.zip, schematic.svg, pcb.png, order.md
bun scripts/firmware.ts <projectDir>     # firmware/: platformio.ini, include/pins.h, bring-up test, main.cpp skeleton
bun scripts/compile.ts <projectDir>      # compiles bring-up and main with PlatformIO; errors as file:line
bun scripts/render.ts <projectDir>       # out/renders/: hero.png, hero-alpha.png, exploded.png, top.png (needs Blender)
bun scripts/drawing.ts <projectDir>      # out/drawings/: wiring plan, dimensioned case drawing, pin map, 1:1 fit-check sheet
bun scripts/shoot.ts <projectDir>/out/guide/index.html <projectDir>/out/shots --pages 1,3,4 --width 900
```

Read the reference for each step you run: `references/guide.md`, `references/enclosure.md`,
`references/pcb.md`, `references/firmware.md`, `references/renders.md`, `references/drawings.md`. Each explains what to check and what to
change in `project.json` when the result is not right. Then write the real firmware
behaviour into `firmware/src/main.cpp`, using only the constants from `pins.h`.

Enclosure and PCB scripts print warnings (a vent covered by another part, a port that
does not reach a wall, a wire-mounted part left off the board). These are design
problems, not noise. Fix the layout or tell the user what the consequence is.

`guide.ts` and `drawing.ts` check their own drawings on every build and print one line
per problem: a wire that ends on a pad hidden behind a taller component, a pin name
with nowhere clear to sit, parts that overlap in an exploded view, a wire through a
part in the wiring plan. Each line names the page, step and part. Layout findings may be fixed with `bench`;
renderer findings belong in the generator, and unresolved geometry needs source data.
Do not change correct part geometry to silence a renderer finding. A part marked
`geometryEvidence.status: "unresolved"` (its file's layout is contradicted by evidence;
today that is the INMP441 microphone) still builds: the case, drawings, guide and
package are made from the file's numbers, a `warning:` says so once per build, and each
affected output carries "LAYOUT NOT VERIFIED". Repeat that warning first in the
hand-over, tell the user to measure the part and correct it in the project's `parts/`
folder before printing, and never present such a case as ready to print. The fit-test
print is the gate. `--strict-geometry` (or `BENCHTOP_STRICT_GEOMETRY=1`) turns the
warning back into a refusal with a partial logical guide; a carrier PCB is refused in
every mode, because a board costs money and has no cheap fit test. `--strict`
exits non-zero while any drawing finding remains. A clean check means the tested drawing
invariants hold, not that the part file is right.

### 5. Showcase

Read `references/showcase.md`. Write the `showcase` block (headline, how it works,
features, stats, FAQ, theme), then:

```bash
bun scripts/package.ts <projectDir>      # dist/<slug>/ (index.html, guide/, files/) + dist/<slug>.zip
bun scripts/shoot.ts <projectDir>/dist/<slug>/index.html <projectDir>/out/shots --width 1320 --height 2400
```

Look at the page, all of it: `--from 2400` captures the window starting 2400 px down.
The copy is yours and it is what separates a product page from a template with nouns
swapped in; the reference says how to write it and how to pick a theme. Prices on the
page come from `project.sourcing` once every part has a line there. A line bought in
another currency than the project's carries its own `currency`; totals are then shown
per currency ("401 NOK + 7.95 USD") and never converted. Without sourcing the page
says the figure is an estimate from typical prices.

`package.ts` rebuilds the guide from `project.json` every time, so never correct a
generated file by hand: the correction is lost on the next run and the files disagree
until then. If a generator is wrong, change its input, and if it cannot be made right
that way, tell the user what is wrong in the output rather than patching it silently.

### 6. Hand over

Tell the user, briefly: where the package is, what it will cost, what to do first, and
**what has not been verified**. Be specific. See "What accuracy means here".

## What accuracy means here

Read `references/geometry-evidence.md` before using a clone part for a case or carrier
PCB. Check `assets/geometry-evidence/library-audit.json` for the limits of the bundled
models and `assets/geometry-evidence/variant-records.json` for source-specific records.
These records preserve unknown values; they are not runnable part definitions.

The guide is drawn to scale and its pin positions come from part files, so it is exactly
as accurate as those files. Each part file states its `confidence`:

- `datasheet`: outline and pads come from a manufacturer drawing.
- `typical`: a common clone size. Hobby modules are copied by many factories; the same
  listing title can arrive with a different pin order or a board two millimetres wider.

So before anything irreversible, have the user check the real part against the drawing:

- **Before soldering**: compare the pin labels printed on each module with the inventory
  page of the guide. If the order differs (some OLEDs swap VCC and GND), fix the part
  file or override it in `<projectDir>/parts/`, and regenerate.
- **Before printing a case or ordering a board**: have the user check their real parts
  against the files, cheapest check first. Print the 1:1 fit sheet from `drawing.ts` on
  paper at 100 % and lay each part on its outline. Then print the fit test from
  `enclosure.ts` (`fit-test.3mf`, about a quarter of an hour) and try the parts in it,
  following the checklist at the top of `print.md`. Calipers settle whatever those two
  leave open, against each part's `verify` note. Correct the part file first and
  regenerate; a case that is 1 mm too small is scrap.

Say which parts are `typical` in your hand-over. Do not present a generated case as
guaranteed to fit, and do not present firmware you could not compile as tested.

## When nobody can answer

If no one is there to answer (a scripted or scheduled run), do not stall and do not guess
silently: each question in phases 1 and 3 gets a recorded default and the run goes on.

- **Default and record**: the five questions in `imagine.md`, the direction (the simplest
  that does the job), the name, `build.path` (`wire`, soldered), the budget ("no ceiling,
  here is the total") and which of two equivalent parts to buy. Write each in
  `DECISIONS.md` in the project folder, numbered: the question, the answer taken, one line
  of reason, what would change it.
- **Never default**: anything that spends money (do not order; stop at `shopping.ts` and
  the total), anything safety-related (mains, lithium cells or charging, anything worn,
  used by a child or left running unattended). Take the safe design instead (USB power, no
  cell). If the idea cannot be built without one, stop at the concept sheet and say what a
  person must decide.
- **Hand-over**: start with every assumed answer, before the cost and the files, worded as
  "assumed", never "agreed". The user sees what was decided for them before what was built.
- **Recording people**: a device that records audio or video needs a consent note, in the
  hand-over and on the showcase page: who is recorded, that they must be told first, and
  that the law on recording differs by country. Ask in phase 1 whenever the idea listens
  or watches. Unattended, build the device and add the note: whether the people in the
  room agree is theirs to give each time it is used, so it is not a decision the run
  takes or blocks on. Record in `DECISIONS.md` that nobody was asked.

## Safety lines

- **Mains voltage is out of scope.** Do not design anything where the user wires 110/230 V.
  A relay switching mains goes in a commercial, certified smart plug or relay box instead; say so.
- **Lithium cells**: only with a protection circuit and a charger part from the library
  (or one you add with its datasheet). Never charge through a bare regulator. Tell the
  user not to leave a first charge unattended.
- **Current**: the validator checks the power budget. If it warns, take it seriously;
  LED strips and servos are what brown out boards and melt thin wire.
- Anything worn on the body, used by a child, or left running unattended gets a sentence
  about that risk in the hand-over.

## Scripts at a glance

| Script | Reads | Writes |
| --- | --- | --- |
| `build.ts [--region CC] [--skip a,b]` | everything | every output below, plus `out/build-report.md` |
| `concept.ts` | parts, enclosure | `out/concept.html` |
| `validate.ts [--json]` | parts, connections, power | findings on stdout |
| `source.ts [--stores] [--query]` | parts | candidates on stdout (cached 24 h) |
| `shopping.ts [--region CC]` | parts, sourcing | `out/shopping/index.html` |
| `catalog.ts find\|show\|listings\|pads\|check-library` | the bundled parts catalog (or `--db`, `BENCHTOP_CATALOG`) | text on stdout (read-only) |
| `catalog.ts import-part <part_id> --id ID --out FILE` | the catalog's pad data for one board or module | a draft part file, normally in `<projectDir>/parts/` |
| `catalog-cards.ts build\|show\|find`, `catalog.ts card\|cards` | the full catalog (build), a card file (`--cards` or `BENCHTOP_CARDS`) | one pre-joined reference card per part, text or `--json` (read-only) |
| `bom.ts` | parts, sourcing | `out/bom.csv`, `out/bom.md` |
| `guide.ts [--pdf]` | everything | `out/guide/` |
| `enclosure.ts` | parts, enclosure | `out/enclosure/` |
| `pcb.ts [--no-export]` | parts, connections | `pcb/board.tsx`, `out/pcb/` |
| `firmware.ts [--force]` | connections, firmware | `firmware/` |
| `compile.ts [--env bringup,main]` | `firmware/` | `firmware/compile-<env>.log`; exit 1 on a compile error |
| `render.ts [--quality draft\|final]` | `out/enclosure/*.glb` | `out/renders/` (run `enclosure.ts` first) |
| `drawing.ts` | parts, connections, enclosure | `out/drawings/` |
| `package.ts [--no-zip]` | everything, showcase | `dist/<slug>/`, `dist/<slug>.zip` |
| `shoot.ts` | an HTML file | PNG screenshots, so you can see what you made |
| `check-parts.ts [dir]` | part files | structural check of part definitions |

All exit 2 with one plain line when `project.json` is wrong (unknown part, unknown pin,
duplicate ref). Read the line; it names the fix.

## When the generators do not cover it

Read `references/scope-and-assessment.md`. State what this package completes, what
remains a design proposal, and what is outside the generators. Deliver the useful
low-voltage controller subsystem when the wider brief includes custom PCBs, mechanics,
mains switching or integration into an existing product. Do not claim the whole
product is build-ready merely because the subsystem generators passed.

They cover module-based builds: a dev board plus breakouts, hand-wired or on a carrier
board, in a rectangular two-piece case. For anything beyond that (a bare-chip PCB, an
organic or multi-part case, a moving mechanism) the generators still give you a correct
starting point and the checks still apply. Edit the generated `pcb/board.tsx` by hand
(`references/pcb.md` has the vocabulary), or write the enclosure in JSCAD starting from
`out/enclosure/layout.json`, and tell the user which parts are hand-made and so not
covered by the automatic agreement between files.
