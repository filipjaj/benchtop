# Carrier PCB

A 2-layer carrier board replaces loose wires: a footprint for each module's pin header and each
through-hole part, joined by routed traces. For hobby modules and through-hole parts only. It is not a
bare-chip design tool (no SMD layout, no impedance control, no antennas).

## Run it

```
bun scripts/pcb.ts <projectDir>               # board.tsx plus all exports
bun scripts/pcb.ts <projectDir> --no-export   # board.tsx only
```

Exit codes: 0 ok, 2 project error, 3 tscircuit not installed (prints the install command), 4 an export
or the routing check failed.

Writes `<projectDir>/pcb/board.tsx` (edit it by hand, rerunning the script overwrites it) and into
`<projectDir>/out/pcb/`: `schematic.svg`, `pcb.svg`, `pcb.png`, `gerbers.zip`, `board.glb`,
`circuit.json` (routing read-back), `order.md` (JLCPCB steps for this board). A full run on the luft
example takes about 13 s.

Layout rules (`scripts/lib/pcb-layout.ts`): controller first with its USB end 0 to 1.5 mm past the y = 0
edge; other parts packed with 3 mm between outlines and 1.5 mm to the edge; four M3 holes (3.2 mm) in the
corners with 4 mm free around each hole edge; size is whole millimetres. Parts with mount `wire` or `none`
become a row of wire pads at the bottom edge (warning printed). Power and ground nets 0.5 mm, signals 0.25 mm.

## tscircuit

Pinned: `tscircuit@0.0.3168` in `scripts/package.json` (it releases several times a day, do not float).
The CLI runs under bun (`#!/usr/bin/env bun`); it is invoked as
`bun scripts/node_modules/tscircuit/cli.mjs <args>` run with the pcb folder as cwd, because it writes a
`.tscircuit/` cache into the cwd. No imports are needed in `board.tsx`: the CLI supplies the JSX elements.
Coordinates in the file: origin at the board centre, y up, millimetres.

Elements and props used (all ran in this setup):

```tsx
<board width="49mm" height="54mm" layers={2} autorouter="auto_local"
       minViaHoleDiameter="0.3mm" minViaPadDiameter="0.6mm">
<hole pcbX={-21} pcbY={23.5} diameter="3.2mm" />                       {/* mounting hole */}
<chip name="oled" pcbX={0} pcbY={0} doNotPlace
      pinLabels={{ pin1: "GND", pin2: "VCC" }}
      footprint={<footprint>
        <platedhole portHints={["pin1"]} pcbX={-1.27} pcbY={0} shape="circle"
                    holeDiameter="1mm" outerDiameter="1.7mm" />
        <silkscreenrect pcbX={0} pcbY={0} width="27mm" height="28mm" strokeWidth="0.15mm" isFilled={false} />
        <silkscreentext text="GND" pcbX={-1.27} pcbY={-2} fontSize="0.7mm" pcbRotation={90} />
      </footprint>} />
<trace name="GND_1" from=".mcu > .pin10" to=".oled > .pin1" thickness="0.5mm" />
```

- Pad offsets are relative to the chip's `pcbX/pcbY` (the part centre). Select pins as `.ref > .pinN`, N = index
  of the `platedhole` (`portHints`); labels starting with a digit are not valid selectors.
- `doNotPlace` keeps a module out of the assembly files. For an assembled part use
  `supplierPartNumbers={{ jlcpcb: ["C12345"] }}` instead (generated when the part def has `footprint.lcsc`; untested
  against the live assembler).
- Via size must be set as the two board props above. `routingTolerances={{...}}` on the board did not change them.
- `autorouter="auto_local"` and the default both route locally. `auto-cloud` produced no traces here (no error).

## Check the result

1. The run prints `routing: N of N connections routed` and `check: No shorts detected`. `tsci export` itself
   exits 0 even when routing failed, so the script reads `circuit.json` for `*_error` records and fails on any.
2. Open `out/pcb/pcb.png` (or `pcb.svg`): red is top copper, blue bottom. Every pad of every net has a trace,
   thick traces on power/ground, a via appears as a small blue/red dot, all four pads of each header are
   ringed, nothing crosses a mounting hole, the controller's USB end sits at the top edge.
3. Gerber zip should hold `F_Cu B_Cu F_Mask B_Mask F_SilkScreen B_SilkScreen F_Paste B_Paste Edge_Cuts
   drill-L1-L2.drl drill_npth.drl bom.csv pick_and_place.csv`. Count `X..Y..` lines in `drill-L1-L2.drl`
   under the `T10` tool: one per plated pin (the luft board has 28). `T11` lines are vias.
   `drill_npth.drl` holds the 4 mounting holes.
4. Extra checks: `tsci check shorts board.tsx`, `tsci check netlist board.tsx`, `tsci check placement board.tsx`
   (run in the pcb folder; all three ran clean on luft).
5. KiCad DRC: `tsci export board.tsx -f kicad_zip` writes `board.kicad_pcb`, `.kicad_sch`, `.kicad_pro`
   (export verified). Running `kicad-cli pcb drc` on it is untested: KiCad was not installed here.

## When routing fails

Symptoms: the script exits 4 and lists `pcb_trace_missing_error`, `pcb_autorouting_error` or
`pcb_placement_error`. Autorouting is skipped entirely if any placement error exists (copper too close to the
board edge, overlapping pads, a part outside the board). Fixes, in order: remove the placement errors; make the
board larger (edit `width`/`height`, move parts); move the parts that share a net closer; widen gaps around
tight pin rows; give signal traces `thickness="0.2mm"`; as a last resort route the net by hand with a
`<trace>` using `pcbPath`/`<via>` (untested) or put a wire on that net.
Thin traces: the router may narrow a trace below the requested width; it reports `pcb_trace_warning`.

## Limits

- Modules sit on top, header pins through the board. Check a module's pin order against the real part first
  (`verify` field in the part JSON). Pad offsets are only as accurate as the part definition.
- No ground pour, no teardrops, no impedance control. Via 0.3/0.6 mm is JLCPCB's standard tier.
- Traces run under module bodies; no keep-out is modelled for tall parts.

## JLCPCB upload (not tested against the live site)

Bare board: jlcpcb.com, Order Now, Add gerber file, upload `out/pcb/gerbers.zip` (if rejected, remove
`bom.csv` and `pick_and_place.csv` from the zip). Options: FR-4, 2 layers, 1.6 mm, HASL lead free, quantity 5.
Check the viewer shows the outline, silkscreen and every hole.

Assembly: only parts with an LCSC number are placed, and headers and modules never are. Switch on Assembly,
top side, upload `bom.csv` and `pick_and_place.csv`, fill missing LCSC numbers (the tscircuit files leave comment
and footprint columns empty), confirm rotations in the placement preview. `out/pcb/order.md` repeats this with
the project's own board size and part table.
