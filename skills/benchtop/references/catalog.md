# Parts catalog (optional)

A local SQLite catalog of maker parts: source-linked dimensions, pin definitions,
specifications and pad geometry. The full catalog (about 4,000 parts, with cached drawings
and shop listings) is built by another tool and is not distributed; the skill ships a public
subset (below), and everything works without either. Use it to write part files from evidence and find the modules people buy.

## Pointing the skill at it

`scripts/catalog.ts` is read-only. Database lookup order: `--db <path>`, the environment
variable `BENCHTOP_CATALOG`, then the bundled public catalog `assets/catalog/maker_catalog.sqlite`.
Do not copy the full database or its `references/` folder into the skill; set
`BENCHTOP_CATALOG` to the catalog's own file (cached drawings are found next to it). With no
database a command prints one line saying so and exits 3, as it does for a locked or
half-written database (retried once) or a changed schema (the line names what is missing).
`--json` on any command.

### The bundled public catalog

The skill ships a public subset of the catalog (636 of 4,238 parts): parts identified by
their maker, with the facts that maker published about them (dimensions, pin definitions,
pad geometry, voltages, document links), each with its source URL. It is built so it can be
redistributed (`scripts/catalog-public.ts` lists the rules):

- No retailer data: no parts keyed by a shop's listing, no facts sourced from a shop, no
  listings, variants, prices or stock. `listings` returns nothing; use the shopping page's
  shop searches instead.
- No copied text: part descriptions, evidence quotes, source text and sentence-like
  specification values are removed. Each value keeps its `[S<id>]` source URL: open it to
  read the claim in context.
- Ranked by name, not popularity (the curation ranking was built from shop data).
- Licence: facts compiled under CC BY 4.0 (`metadata.license`). Brand and product names
  only identify parts.

Same schema and `user_version`, so every command works on it. Every command's text output
starts with a `catalog:` line naming the file and saying it is the public catalog;
`--json` carries the same in a `catalog` field (`bundled_snapshot: true`). Reading the
full catalog prints no such line.

- Not found in the public catalog is not "does not exist". `find`, `show` and `pads` say
  so and name `--db <path>` and `BENCHTOP_CATALOG`; `--json` gets a `hint` field. Clone
  modules (HC-SR04, INMP441 and similar) are mostly absent: they have no maker of record.
- Pad coordinates (reference, number, net, side, type, drill) are kept; per-pad parser
  evidence is not.
- Regenerate it from the full catalog, after the library changes:

```
bun scripts/catalog.ts check-library --json --db <full.sqlite>   # collect parts[].matches[].part_id
#   (unique, sorted) into assets/catalog/library-ids.json, a JSON array of ids, then:
bun scripts/catalog-snapshot.ts --src <full.sqlite> --out /tmp/snapshot.sqlite \
  --include assets/catalog/library-ids.json
bun scripts/catalog-public.ts --src /tmp/snapshot.sqlite --out assets/catalog/maker_catalog.sqlite
```

```
bun scripts/catalog.ts find "BME280" --norway
bun scripts/catalog.ts find "sensor" --fits 30 20 12     # box in mm, rotation allowed
bun scripts/catalog.ts show pimoroni:3930990346323
bun scripts/catalog.ts listings "ESP32-C3 SuperMini" --norway
bun scripts/catalog.ts check-library                     # part files vs catalog, report only
bun scripts/catalog.ts pads arduino:A000066              # what numeric pad data exists
bun scripts/catalog.ts import-part arduino:A000066 --rot 90 \
  --id uno-r3 --out <projectDir>/parts/uno-r3.json       # draft part file from the CAD pads (headers by default)
```

## Reading the data (source claims, never measurements)

Nothing was measured or fit-tested. A value from a manufacturer table is still a claim.

- `scope pcb` is the bare board: it maps to `PartDef.body` (`h` = PCB thickness) and gives
  no component height. Take `maxHeight` from a drawing or a 3-value assembly outline.
- `assembly` and `product_unspecified` map to `body.w`, `body.d` and `maxHeight`. The
  second means the publisher did not say if headers are included; check before trusting it.
- Other scopes (`component`, `partial_body_only`, `cad_model`, antenna or shaft excluded)
  are not whole-part outlines. Do not put them in `body`.
- Axis order is the source's, not length/width/height. Use the labels when given,
  otherwise place the values from the drawing.
- A two-value outline has an unknown third dimension: not zero, never "fits".
- A data issue on a dimension (`cross_source_dimension_difference`,
  `no_unambiguous_envelope`) means no outline was selected. Do not pick a number silently:
  use the cached drawing or ask the user to measure.
- A branded board's data is never evidence for a clone: a shared chip is not the same board.
- A listing marked `NOT SOLD LOOSE` (`sold_loose: false` in `--json`) is an assembly service's
  stock, such as JLCPCB's parts library: the part is fitted to a board that supplier builds and
  cannot be ordered on its own. Its price belongs to a PCB assembly order. Never put it on a
  shopping list. Its C-number is still the right value for a part's `footprint.lcsc`.

## confidence, verify and sources

`confidence: "datasheet"` only when outline and pads came from a manufacturer drawing or
CAD you opened (a cached `mechanical_drawing`, `cad_or_mechanical` or `pinout`, or a KiCad
or Eagle file from a `source_repository` link). A seller's text claim ("25x18 mm" on a
shop page) stays `typical`, even from a big shop: it describes that listing, and many
factories make the same module.

Put in `sources` the catalog's source URL for each value (`[S<id>]` in `show`, URLs under
Sources) plus the drawing's origin URL. Put in `verify` what to measure and carry any data
issue into it, e.g. "catalog has conflicting sizes (25 x 18 vs 22.5 x 17.8): measure board
and header height before printing".

## Adding a part with the catalog

1. `find` by model name, prefer the exact model, then `show <part_id>`.
2. Read the labelled sections. Open the pinout and mechanical drawing marked LOCAL with
   the image or PDF reader. NOT CACHED assets are links only; fetch them if needed.
3. Write `<projectDir>/parts/<id>.json` as in `references/circuit.md` ("Adding a part"):
   outline by scope, pins from the pin definitions or drawing, supply range, current,
   logic level and I2C address from the specifications.
4. Pad coordinates come from the drawing or CAD, never from memory. When `pads <id>` lists
   a dataset, use `import-part` (next section) instead of typing them.
5. Run `bun scripts/check-parts.ts <projectDir>/parts`, then `bun scripts/catalog.ts
   check-library` to see where your numbers differ.

## Pad positions from CAD: `pads` and `import-part`

For about 40 boards the catalog holds numeric pad centres parsed from the maker's CAD file
(`geometry_objects`, kind `pcb_pad_centers`), in millimetres. Source positions, not
measurements of a bought board.

`pads <part_id> [--geometry ID]` lists each dataset (geometry id, revision, frame, source URL,
validation status, pad count), whether a board outline dataset (`pcb_outline_and_drills`)
from the same CAD file exists, and for the one dataset in play every reference designator
with its pad count, bounding box, pad types and a few net names. Headers are the
through-hole references (listed first) with a regular pitch. A part with no numeric pads
gets the cached pinout, drawing and CAD files instead, paths resolved against the database
folder. Nothing is estimated from images.

`import-part <part_id> --id NEW_ID --out FILE.json [--header REF[,REF...]] [--geometry ID]
[--rot 0|90|180|270] [--mirror] [--outline x0,y0,x1,y1] [--overwrite]` writes a draft part file.

- Without `--header`, the headers are the pad groups the card generator classes as headers
  (`classifyGroup` in `catalog-cards.ts`, the rule behind `board.headers` in `card --json`; there
  is one rule, not two). The command and `pads` print each group taken and the basis ("package
  1X08", "reference J1, 2.54 mm pitch"). Check the list: on an Uno it also takes the ICSP and
  JP2 groups, so `--header IOH,IOL,POWER,AD` is still the way to get the four main headers.
  When no group qualifies the command stops and says to run `pads <part_id>` and pass `--header`.
- `--header J1,J2` overrides the default: it takes every pad of those references; `J1:1-7` or
  `J1:1;3;5` takes only those pad numbers. Only the selected pads are imported, never the whole
  board.
- `--rot` turns the part clockwise as seen from above, exactly as `rotPoint` in `lib/iso.ts`
  does for `bench.rot`, `plan.rot` and enclosure mounts (a unit test pins this); `--mirror`
  flips it left-right first, both about the outline. Use them so the USB connector ends at
  y = 0.
- `--outline x0,y0,x1,y1` gives the board edge in the CAD file's OWN frame (EAGLE: Y up),
  in mm, when the dataset has no outline of its own. It replaces the pad bounding box (and
  any outline dataset, with a warning). The draft's `verify` and the output say the outline
  was supplied on the command line, not read from the CAD file. A wrong outline shifts every
  pad, so take the numbers from a drawing or a measurement, and check that the pads you
  expect at a board edge sit where they should. Example: an Uno's EAGLE origin is the board's
  lower-left corner, so `--outline 0,0,68.58,53.34` puts the digital header 2.54 mm from one
  long edge and the power and analog headers 2.54 mm from the other.
- Name `--out` `<id>.json`: check-parts requires the id to equal the file name.

Traps the command handles, and what you still do:

- A dataset holds every pad on the board (an Uno has 306). Pick the headers from `pads`.
- Several datasets are different CAD files or revisions. Without `--geometry` the command
  stops and lists them; datasets are never merged, and the draft names the one used.
- Frames differ: EAGLE is X right, Y up; KiCad is X right, Y down; the origin can lie far
  outside the board (the XIAO ESP32-S3 sits near x = 140, y = 95). The frame is read per
  dataset and refused when unclear. The draft's origin is the top-left corner of the outline
  seen from above, x right, y down.
- Board size: the outline dataset from the same CAD file (same hash or URL; an outline of
  another file is not used). Two payload shapes are read: parsed CAD edge geometry (bounds
  are centre lines of the edge or dimension layer; the catalog does not guarantee they are
  the outer edge) and PCB extents from the dimension callouts of a drawing
  (`dimensioned_pdf_header_centers` datasets, e.g. the ESP32-S3-DevKitC-1: 25.4 x 62.74 mm,
  no corner radii, antenna and connector projections excluded). Without an outline the box
  is the bounding box of ALL pads, which is smaller than the board and puts the origin at
  the outermost pad, not the corner. The command and the part's `verify` say so; measure the
  board and move the pads before a case depends on it. The Uno now has an outline dataset
  (68.58 x 53.34 mm), so it needs no `--outline`; the flag stays for boards without one.
- Twin pads: a castellated module such as the XIAO has an edge pad and an inner pad per pin,
  1.27 mm apart, on the same net. The command warns; take one set with `J1:1-7`.
- Pin names: `pin_definitions` when connector (= reference) and number match one row exactly,
  else the net name, else `<reference>.<pad>`. A row whose `notes` JSON binds it to datasets
  (`supported_geometry_ids`, `geometry_bindings`) counts only for the chosen dataset; a row
  bound elsewhere is ignored. Repeats get `.2`, `.3`; the CAD id stays as an alias.
- A pad number is not a GPIO number. Roles and `gpio` are taken from the published pin row
  (`pin_definitions`), and only where it is unambiguous. A net label sets one thing, ground,
  and never a GPIO number:
  - `role: "gnd"` when the published name is a ground (`GND`, `AGND`, `DGND`, `GND.n`, `GND2`,
    `G`, ...) or the source's pin type for the pin is `G`/`GND`. A bare `G` counts only when
    the row's function text is empty or says ground (a MOSFET gate is also `G`). A pad with no
    published row whose CAD net is named `GND` (or `AGND`, `GND1`, ...) is ground too; where a
    published row exists it wins over the net.
  - `gpio: n` when the published name and function text together name exactly one number, in
    one of three forms: `GPIOn` (Espressif, Arduino, Adafruit tables), `GPn` (the Pico tables)
    or `IOn` (Espressif's short form: `IO12; MISO`, `GPIO label IO9`). Upper case, not part of
    a longer token: `RTC_GPIO3` and `LP_GPIO7` are other numbering spaces and `DIO2` or
    `GP2Y1010` are not GPIO numbers. A schematic net label (`native net: IO8` on the Arduino
    tables) is not a function and is ignored. Two or more distinct numbers means no `gpio`; the
    command warns. Against the library's hand-written ESP32-S3-DevKitC-1 all 36 imported numbers
    and 4 grounds agree.
  - Supply pins keep role `io`. The catalog cannot tell an output from an input (`3V3` is an
    output on a dev board and an input on a breakout) and states no volts, so the report lists
    them under "power pins that need role, volts and direction".
  - Each value set this way is recorded on the pin as `importedFrom` (`{ role?, gpio? }`: the
    pin row id, connector, pin number and the text read), so a reader can tell an imported
    value from a hand-set one. Nothing in a build reads it. A pin without a pin-table row gets
    one thing at most: ground, when its CAD net is named `GND`.
  - `electrical.logicVolts` is set when the catalog states one logic level for the part and every
    non-disputed claim agrees (not a range, not a conflict, not a chip-only claim); the claim
    and its source are in `imported.fields`.
  - `maxHeight` is set when the catalog has a 3D model of the board (`pcb_model_clearances`,
    about a third of the parts with header pads): PCB thickness plus the tallest modelled point
    above the PCB, measured from the PCB's underside as the case layout expects. `body.h` takes
    the model's PCB thickness when the outline states none. Both are in `imported.fields`. It
    is a nominal model figure, not a measurement, and counts only what is modelled: a breakout
    that ships with loose headers is drawn without them, so add them yourself. Parts reaching
    below the PCB are reported as a warning (the part file has no field for them); give the
    board posts that tall. A part with several models that disagree gets no height.
  - `ports` are set from the same model's connector openings when the model can be matched to
    the pad dataset being imported (`lib/model-frame.ts`: same outline size, connectors named
    alike in the same places, the side of the board they sit on). About a fifth of the parts
    with header pads get them. Each connector becomes one side port on the wall it faces, at
    its place along that wall, with `z` the centre of the opening above the PCB's top face and
    a 2 mm `margin` that is a default, not a catalog figure: the model gives the hole in the
    connector, not the plug that has to pass the case wall. `--rot` and `--mirror` move the
    ports with the pads. `imported.ports` records the model and how well it matched. No ports
    when the outline is not from the same CAD file as the pads, for a module footprint, for a
    board the model shows from the other side, or when no unique match exists (a symmetric
    board, or no connector named in both); the report says which. Nothing that faces up is
    imported: buttons, LEDs and displays are still yours to add.
    With `"openings": "auto"` a case opens for every port that ends up at a wall, a breakout's
    two STEMMA QT or Qwiic sockets included. List `openings` in the project to keep only the
    ones the build uses.
- Everything else is a placeholder or empty: `caps`, voltages, `sourcing.priceUsd`, and
  `body.h` and `maxHeight` where the catalog has neither a stated thickness nor a model. Prices
  are in shop currencies where the part file wants USD, so check-parts fails on purpose until
  they are filled in; the command prints what is missing, minus what is now set.
- `confidence` stays `typical`; `sources` holds the CAD URL and its `source_sha256`.
- Provenance: the draft carries `imported` (the catalog part id, the geometry ids, the source
  files' sha256 where the catalog has one, how the outline was found, and `geometrySha256`, a
  hash of the pad positions and `body.w`/`body.d` as written). `check-parts.ts` recomputes it
  and prints `INFO <id>: pads or outline were changed after import ...` when it no longer
  matches. It is information, not an error: filling in names, roles, gpio, heights and
  electrical values does not change the hash, moving a pad or resizing the body does.

### Module footprints (Pico, XIAO)

A part that is itself a module (`pads` says "Module footprint datasets") has no placed-board
pads, only `module_land_pattern`: the footprint that mounts the module on a carrier, in
footprint-local coordinates with no outline. `import-part` reads its contact rows (four or
more pads in a line on one pitch; the same reading the card uses for `module_contact_row`, a
surface pad and a through hole on the same spot counting once) and ignores mounting holes and
debug pads. Without `--header` it takes every contact row; `--header U2:1-20` selects pads
within them. A module usually has one footprint per way of mounting (DIP and SMD for a XIAO),
so with more than one the command stops and lists them: pass `--geometry`. A part that also
has a placed board imports the board unless `--geometry` names the footprint.

- Outline: the catalog's selected envelope (`envelopes`) when its scope is a whole-part outline
  (`pcb`, `assembly`, `product_unspecified`, `board_without_headers`, ...) and it is not
  smaller than the footprint's pad bounding box; its third value is used only as `body.h` when
  its axis label says PCB thickness. Otherwise the bounding box of all footprint pads, with a
  warning. The long envelope side is put along the longer pad extent and the pads are centred
  in the outline. Both are assumptions the catalog does not state.
- The draft is never resolved. It carries `geometryEvidence.status: "unresolved"` naming what
  is not known (where the pads sit in the outline, which way round it lies, the height), so a
  build prints "LAYOUT NOT VERIFIED" for it and a carrier PCB refuses it. Measure the module,
  write the corrected geometry, and only then replace the evidence.

Worked example (Seeed XIAO ESP32-S3, KiCad, Y down, origin at x 139.6, y 94.4):

```
bun scripts/catalog.ts pads seeed:doc:xiao_esp32s3_getting_started
  ... J1 | 14 pads | 1.27 x 15.24 mm   (two pads per pin: take 1-7)
bun scripts/catalog.ts import-part seeed:doc:xiao_esp32s3_getting_started \
  --header "J1:1-7,J2:1-7" --id xiao-esp32-s3 --out <projectDir>/parts/xiao-esp32-s3.json
  board 17.78 x 21.135 mm from outline geometry 34
```

Result: two columns of 7 pads, 2.54 mm pitch, 15.24 mm apart (x = 1.27 and 16.51), first
pad at y = 2.921, D0 on the left with the USB end at y = 0. Then check the `gnd` and `gpio`
the import set (`importedFrom`), add the other roles, voltages, gpio and caps by hand, run
`check-parts.ts`, and draw `fitcheck.svg` to compare with the board.

## Cards: one read with everything joined

A card is one part's catalog facts pre-joined into a single record: outline and its scope,
header and connector pads with coordinates, pin table, electrical claims, cached references,
where to buy, and an explicit "not in the catalog" list. `scripts/catalog-cards.ts` generates
them from the full catalog into a separate SQLite file. No card file is bundled; build one:

```
bun scripts/catalog-cards.ts build --src <full catalog> --out <cards.sqlite>
export BENCHTOP_CARDS=<cards.sqlite>             # or pass --cards <file> to each command
bun scripts/catalog.ts card arduino:A000066      # the rendered card (--json: the card JSON)
bun scripts/catalog.ts cards "esp32" --norway    # search; also --fits W D H, --include-pcb, --pads, --limit N
```

Use `card` instead of `show` when you want one read with everything joined; it covers all
4,237 parts but needs a card file built from the full catalog. `show`, `pads` and
`import-part` read the relational tables (or the snapshot) and are the way to write a part
file. With no card file the commands say so in one line and exit 3. A missing card is not
proof the part does not exist: the file only covers the catalog it was built from.

Cached paths in a card are relative to the full catalog's folder. With `--db` or
`BENCHTOP_CATALOG` pointing at the full catalog they print as absolute paths; otherwise they
stay relative and the output says they need the full catalog. `--json` is never rewritten.

A card labels three kinds of interpretation. Read them as the generator's reading, not as
source statements:

- Header and connector grouping of pads comes from CAD package names (`1X08`, `PN61729`) and
  the row geometry; pads on components and test points are left out and counted.
- A pad is joined to a pin function only by exact identifiers (connector and pin number);
  otherwise the pad carries its CAD net name, which is a label, not a verified function.
- Voltages are parsed from claim text ("3,3 til 5,5 V") and shown with the claim they came
  from; conflicting claims are flagged.

When a card's `outline` is null, read `outline_observations` (`--json`). A single
`pcb`-scope observation with status `manual_source_transcription` and no
`differs_from_selected` sibling is usable as the PCB size. Caveat: that record covers
several order options, so confirm the size on the variant you buy.

Coverage in the current build (4,237 cards): outline on 1,502; CAD pads on 55 parts, of
which 41 have board headers or connectors (2,743 header and connector pads); pads joined to
pin functions on only 2; a pin table on 25; supply voltage on 1,066; a Norwegian listing on
1,157. Most cards say pad coordinates are missing (4,183). For pad positions use `pads` and
`import-part`.

## Sourcing

Needs the full catalog; the bundled public catalog has no listings.
`listings` gives shop, title, price with currency, URL and observation time. These are
candidates to check, not a recommendation: VAT, shipping, pack size (read the title:
"5-pakning" is a price for five) and variant are not normalised, and stock and shipping to
Norway are not verified. Open the page, then put the price you saw in `project.sourcing`.

## What it cannot give

- Pad or pin centre coordinates for most parts (only the boards `pads` lists have them;
  pin definitions are names and functions).
- Verified clone sizes (nothing was measured), live stock or prices (snapshots).
- Mounting-hole positions, tolerances, enclosure opening positions.
