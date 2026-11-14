# Geometry evidence and exact variants

A part number printed on a chip does not identify its carrier board. Keep the maker,
board revision, seller SKU and fitted connector/header options with each observation.
The catalog uses source claims; no parts have been physically measured by this work.

Treat evidence separately for PCB outline, assembled envelope, pad positions, connector
openings, mounting holes, acoustic port and clearance. A manufacturer outline does not
validate a guessed Z height or a USB opening copied from a different board. A nominal
pitch alone does not locate the first pad or establish pin order. Never infer numeric
pad positions from a photograph's scale.

`assets/geometry-evidence/variant-records.json` retains incomplete, source-specific
records, including unknowns. It is deliberately outside `assets/parts/`: a record with
unknown required geometry must not silently become a runnable PartDef. Published numeric
coordinates can support a documented draft; all remaining model assumptions must stay
visible. The full SQLite catalog and its `references/` hold retained sources.

`assets/geometry-evidence/library-audit.json` inventories the bundled files as they were
reviewed. It reports their own declarations, not an independent verification. A change
to any part invalidates its recorded hash and requires re-review. `datasheet` is not a
blanket fit certification: read each file's `verify` note for assumed heights and shapes.

## Before a mechanical deliverable

- Match the exact board and connector variant to the source. Treat the official
  micro-USB ESP32-S3-DevKitC-1 and dual USB-C clones as different boards.
- Preserve PCB size separately from module/antenna overhang, USB protrusion and fitted
  headers, including geometry below the PCB. A fit margin does not repair missing data.
- State view, origin, X/Y directions, units and source revision for pad coordinates.
  Footprint-local coordinates are not placed board coordinates.
- For INMP441, distinguish the microphone IC's bottom acoustic port from the carrier
  PCB's opening, side and position. A nominal 10 mm listing does not establish a
  second module's pad arrangement. Six pads at 2.54 mm span 12.7 mm before edge margins.
- If a required value is unknown, keep the case/PCB at concept or draft status and list
  that value. Deliver verified wiring and the controller subsystem where possible.

## What the build does with an unresolved part

A part file may declare `geometryEvidence.status: "unresolved"` when evidence
contradicts its own layout. The build then follows one policy, set on 2026-11-14:
**warn, still build.**

- The case, drawings, concept, renders, guide and package are generated from the file's
  numbers. One `warning:` line per build names the part, the reason and what is unknown.
  Every drawing sheet's title strip, the case's `print.md` and the concept sheet carry
  "LAYOUT NOT VERIFIED: <part>. Measure before printing."
- This is a draft status, not a release. Say so in the hand-over, before anything else.
  The user measures the part they hold, writes a corrected file to
  `<projectDir>/parts/<id>.json` (project parts override the library), and rebuilds.
  The fit-test print comes before the case.
- The shopping page never states an unresolved size or pin order as something to match.
- A carrier PCB (`pcb.ts`) is refused in every mode: a board costs money to make and
  there is no ten-minute test for it.
- `--strict-geometry`, or `BENCHTOP_STRICT_GEOMETRY=1`, restores refusal everywhere:
  physical outputs stop with the reason, the guide falls back to a partial logical
  guide, and the case's screws are left out of the BOM.

Why not refuse by default: every other library part is `typical` and treated the same
way (drawn, warned about, gated by the fit test), and a refusal leaves the skill unable
to produce any case for a project with that part until someone measures one.

A fit-check sheet helps compare a real board with a model. It does not validate guessed
geometry on its own, and a successful software render is not a physical fit test.
