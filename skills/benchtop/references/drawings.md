# The flat drawings

`drawing.ts` writes the measured, flat counterpart of the assembly booklet. Same data
(`project.json` plus part files), so the drawings cannot disagree with the guide.

```
bun scripts/drawing.ts <projectDir> [--debug]
bun scripts/shoot.ts <projectDir>/out/drawings/index.html <outDir> --pages 1,2,3,4 --width 1300 --height 920
bun scripts/shoot.ts <projectDir>/out/drawings/wiring.svg <outDir> --width 1130 --height 800
```

Output in `<projectDir>/out/drawings/`: `wiring.svg` (`wiring-2.svg`, ... when the plan is split over
sheets, see below), `wiring-legend.svg` (`wiring-legend-2.svg`, ... for a long list; only when the
connections list has a sheet of its own, see below), `enclosure.svg` (only with an
`enclosure`), `pinmap.svg`, `fitcheck.svg` (more pages as `fitcheck-2.svg` if the parts do not
fit one sheet), and `index.html` with all of them as A4 landscape pages in that order
(`?only=N` shows one). Print at 100 %: every title block states the scale.

`--debug` prints, after the checks, the scale and one line per part of the wiring plan: its
`x`, `y`, `rot` and size in plan coordinates, and the `plan` object that would pin it exactly
there. Read it before writing a `plan` override.

## What each is for

| Drawing | Use |
| --- | --- |
| Wiring, top view | Keep on the bench while soldering. Parts from above at one scale, every wired pad named inside the outline like silkscreen, wires in their real colour outside it on one lane per net, a dot at each end. The legend numbers the wires like the booklet steps (connection index plus one) and repeats the `why`; the same number sits on the wire. A crossing is drawn as a gap in the lane. The legend is under the plan, or on `wiring-legend.svg` when it would hold the plan's scale down. |
| Case, three views | Third-angle top, front, right side of the closed case. Overall width, depth, height (body plus lid), openings dimensioned from the nearest two edges (callouts with leaders in the top view), lid screws, dashed part outlines. Numbers come from `layoutEnclosure`. |
| Pin map | Each used controller pin: label, GPIO, net, other end, wire colour. |
| Fit check, 1:1 | Every distinct part at exactly true size with a 100 mm ruler. Lay the real part on its outline: if edges, holes or pin order differ, the part file is wrong and so are the case and guide. Each part carries the first sentence of its `verify` note and `typical` or `datasheet`. One user unit is one millimetre; a test holds that. |

## How the wiring layout is decided

Three bands, top to bottom: a row of parts, a band of lanes, the controller.

1. The controller is the board with most connections. It is turned so its two long pad rows
   are its top and bottom edges (the row with more used pads on top) and centred under the row.
   It slides a little sideways if one of its stubs would run along a stub from above.
2. Every other part stands in the row, bottoms on one line, turned so most of its used pads
   face down. Order, left to right: the one with the shortest total lane length (every order
   up to seven parts, greedy insertion above that; ties go to project order). A part that can
   stand two equally narrow ways (a resistor: which end faces down) takes the way with the
   shorter lanes. Spacing leaves room for pin names that stand out past a part's ends, wrap
   channels and the part's name.
3. One lane per net: a straight horizontal line, 4 mm apart at print scale. Lanes are
   ordered for the fewest stub-over-lane crossings, then the shortest stubs (every order up
   to eight nets, a barycentre order improved by neighbour swaps above that).
4. A connection is a stub from pad A to the lane, a run along the lane, a stub to pad B. The
   lane is drawn only between the pads actually wired together, so a daisy chain reads as a
   chain. Connections that share a pad share its stub. A pad facing the lane band drops
   straight; any other pad leaves perpendicular to its edge, runs round the nearest side of
   its part in a channel of its own (nested so channels never cross), then joins its lane.
   The controller's bottom-row pads wrap round the nearer end of the controller the same way.
5. Pin names. Text size is a property of the sheet, not of the drawing scale: a name of a wired
   pad is 1.7 mm of capital height on paper (never below 1.6) at 1 : 5 as at 5 : 1, so the
   pad pitch cannot shrink it. A wire always leaves its pad outward and stays outside the
   outline, so the name goes on the other side of the pad, into the body, where no stub can
   come: a name cannot be overlapped by a wire of a neighbouring pad, by construction. Names
   of one edge read upward (sideways pads: horizontally), in a row set one gap in from the
   pads. Where neighbouring names would touch (pads closer than a name is tall) the row is
   spread along the edge, keeping the order of the pads (isotonic spread, `spreadOut`), and each
   name that stands off its pad gets a thin leader; leaders of one row cannot cross. If the
   row is wider than the part it may stand out past the part's ends (the plan leaves room
   there), and if that still does not clear, the names go in two alternating rows. Pads
   nothing is soldered to are drawn but named only when every one of them fits beside its pad;
   otherwise they stay unnamed on this sheet (the pin map names the controller's used pins).
6. Other marks: a filled dot at each pad end and where a stub meets its lane; a gap in a lane
   either side of a stub of another net that crosses it; the net name once in capitals on a
   white halo at whichever end of the lane is free (left first), joined to the lane by a thin
   dashed line when stubs of other nets pushed it away; shapes inside a part in grey so the
   pin names printed over them read first; a numbered tag (connection index plus one, as in the
   legend and the booklet) at the middle of each connection's run, slid along it if a stub is
   in the way. Lane names and tags are 1.7 mm of capital height too.
7. The scale is the largest usual one (5, 4, 3, 2.5, 2, 1.5, 1.25, 1, 0.75, 1 : 1.5, 1 : 2 and
   smaller, never above 2 : 1) at which everything fits the sheet and the plan has no check line.
   The title block states it. A plan that would have to go below 1 : 1.5 to fit is not shrunk: it is
   split (see "Parts too many or too dense for one sheet").
8. The legend. It stays under the plan unless that holds the scale down: when the sheet is
   below 1 : 1 with it and the plan would draw at least a third larger (one scale step of 1.3 or
   more) with the sheet to itself, the legend moves to `wiring-legend.svg`, the page after the
   plan in `index.html`, enlarged to fill its sheet, and the plan's title block says "Step
   numbers: see the connections sheet". A list too long for one sheet (past about 40 rows) is
   paginated: `wiring-legend.svg`, `wiring-legend-2.svg`, ..., each titled "(n of N)", every step
   on exactly one page. The step numbers on the plan are the same either way.

### Parts too many or too dense for one sheet

Pin names are fixed at 1.7 mm on paper, so a part has a smallest size at which its wired names
fit, whatever the scale. Five mechanisms keep the plan readable instead of shrinking it:

- **A part drawn larger.** A part whose wired names do not fit inside its body at the sheet's scale,
  or whose wired pads are closer than 1.6 mm on paper, is drawn at the nearest larger scale from
  0.5, 1 : 1.5, 0.75, 1, 1.25, 1.5, 2, 2.5, 3, 4, 5 : 1 where they do (a controller at most 1.5 : 1,
  or the sheet outgrows the paper). Every length of the part grows together, pads included. The
  sheet says so beside its name: `Header h  drawn 3 : 1`. Wires, lanes and text are unaffected.
  `--debug` shows the factor next to the size.
- **Numbers and a pin key.** A part whose names would have to be drawn larger than 2.5 : 1 (a controller:
  1.5 : 1) to fit at their pads is drawn with each wired pad numbered 1, 2, 3 ... in the part file's
  order, and a boxed key beside it, on the side away from the lanes, says which name each number is
  (`1 GND  2 VCC  3 CE`). Numbers are one or two characters, so a modest size holds them where a
  four-letter name would need 4 : 1; the key is text at the sheet's size, in free space, so it costs the
  same at any scale. The part's own scale is stated as for any enlarged part. The names are
  used when they fit in a size no larger than the numbers need; the numbers win otherwise.
- **Pads with a pad in front of them.** The inner row of a 2 x N header, the middle row of a 3 x N
  block, one side of a DIP seen from the other: a straight stub would run through the pad in front.
  A blocked pad first hops sideways along the edge into a corridor between two columns of pads,
  then leaves from there. A stack of n aligned pads gets n corridors, r/n of a column from its column
  for the pad with r pads outside it; a pad half a column off the pads in front of it steps to the
  middle of the gap between the two nearest. The part is drawn larger until the corridors are at
  least 0.9 mm apart on paper. The check treats the hop (first two runs of the wire) as inside the
  part, not as a wire through it.
- **Which edge a pad leaves by.** The nearest edge, except that pads in a straight row of three or
  more leave with their row, even a corner pad nearer its side: but only when the row's edge is within
  2 mm of the pad's own nearest. A block of three columns of pads close to a side (the right side of a
  flight controller) is not a row along the top; it leaves by its side.
- **Lying flat.** When parts standing upright, pads toward the lanes, do not make a readable plan (one
  or several sheets), the same is tried with every part turned to its shortest depth, whichever way its
  pads then face. A 98 mm screen standing in the row sets the height of the whole sheet; lying down,
  its wires wrap round its side. Plans that read upright are never changed by this.
- **Several sheets.** When one sheet would be below 1 : 1.5 or has check lines, the parts are
  split over 2 to 8 sheets, each with the controller. Parts joined by a connection that does not
  go through the controller stay together (a resistor and the strip it feeds); where that is not
  enough, the split cuts the fewest wires. Each sheet is its own plan at its own scale, titled
  "sheet n of N", with a note under the drawing naming its parts and the nets that continue on
  other sheets. A wire cut by the split ends, on each of its two sheets, at a block `to sheet N`
  whose pad is numbered with the wire's step, so wire 24 runs from its part on one sheet to the
  block pad 24 and the same wire from the block pad 24 to its other part on the other. Step
  numbers are always the project's; the legend lists them all. Files: `wiring.svg`, `wiring-2.svg`,
  ... then the legend page(s).

A project whose parts form one group wired to each other so tightly that no split is readable,
or a part that needs more than 5 : 1, gets a check line and a plan at the smallest scale that
fits: read that line as "this drawing is not reliable". When no scale fits at all (enlarged
parts can make the plan grow on paper as the scale shrinks), the plan is shrunk onto the sheet,
the title block reads "Scale none: shrunk to fit", and a second check line says it is not to
scale. Do not hand that sheet to a builder: the booklet's steps are the wiring instructions for
such a project.

Known not to be solved, and what the build prints for it:

- **A 3 x N block of pads** (three rows of servo headers, 3 pads stacked in each column). The row in
  front of a pad blocks both the inward name and the corridor, and three corridors per gap need about
  4.5 : 1 for names or numbers to stand beside them. The plan is not drawn to scale or has check lines
  (`label ... is overlapped by the wire of step N`).
- **A board of 60 pads with 40 wired on all four edges** (a 3D-printer mainboard), alone or after
  splitting: the controller's own pad rows hold more names and wrapped wires than any size up to 3 : 1
  can separate; the sheets that carry it have check lines.
