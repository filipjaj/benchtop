# The assembly guide

`guide.ts` writes an A4 booklet as one HTML file (and a PDF with `--pdf`). Its visual
language is that of flat-pack furniture instructions: black line art in two weights,
white fills, big step numerals, exploded views with guide lines, magnified bubbles,
crossed-out wrong examples, almost no text.

Every build also runs the **drawing check** and prints what it finds. Read that output
before you look at a single page: see "The drawing check" below.

## What it contains

| Page | Content |
| --- | --- |
| Cover | Name, the finished object, build time, the number of joints or connections, difficulty |
| Before you start | Tools for this build (a soldering kit only when the joints are soldered; a USB cable only when it is powered or flashed over USB), how to make a joint in three frames, good joint versus three bad ones and wire preparation (soldered builds only), one warning worded for how the build is powered |
| Inventory | Every part drawn at 1:1 with its count, wires by colour, printed parts and screws. As many pages as the list needs |
| Steps | `wire`: one connection per step, the new wire in colour, earlier wires greyed, a bubble over each end showing the exact pad. `pcb-*`: one part per step, hovering over its footprint, lowest part first |
| Enclosure steps | Parts lowered onto their posts, lid parts seated, lid closed with screws |
| Before you switch it on | Look, "must not beep" pairs, a continuity table for every net, first power, the command that loads the firmware (only for a framework the skill has one for). As many pages as the nets need; a table that continues says so |
| Done | The finished object and the summary |

Every page is a fixed A4 box, so nothing is allowed to be taller than it: the inventory and
the continuity table are cut into pages by what they contain (each item says how big it
will print; `lib/page-flow.ts`), and `guide.ts` then measures every page in headless Chrome.
A page that is still taller than its box is a `drawing:` finding that names the page and
what is cut off, and `--strict` fails on it. With no Chrome, Chromium or Edge it cannot
measure, and prints a `warning:` line saying so instead of saying nothing.

**The cover's numbers.** Minutes come from `build.minutes`. The next number is what the
builder does, counted once: each soldered wire end is a joint, a push-on connection is one,
a carrier board has one joint per pin, a factory-assembled board has parts to press in. A
wire end on a pin marked `"screw": true` (a terminal block, a relay's load contacts) is a
screw clamp, not a joint: the cover shows the clamps as a number of their own, and the
ends of a lead that plugs in (`"plug": true`) are neither. The BOM's "Build path" line says
the same.

**Wire ends under a screw.** In a soldered build a step whose wire ends on a `"screw": true`
pin says "Solder and clamp" (or "Clamp" when both ends are), and tells the builder to strip
5 mm, twist the strands or crimp a ferrule, tighten the screw, tug the wire and not tin
that end; a second wire in the same clamp goes in with the first. The preparation page adds
"do not tin a wire that goes under a screw", the screwdriver joins the tools, and the
checks ask for a tug on every clamped wire. A build with nothing left to solder gets no
soldering lesson and no iron. A push-on build says "Push on and clamp" and gives the same
clamp steps without the solder and tinning warning, so it still never mentions solder. The drawings are unchanged: the dot still marks where the
wire ends.

**Step numbers.** Steps are numbered 1 to N in build order with no gap. Two short steps can
share a page, so a page can carry two numbers (for example 5 and 6) and the next page starts
at 7; reading only the first number of each page makes it look as if one were missing. The
drawing check's `page P, step S` lines use the same numbers.

**Texts that follow the project.** The joint wording follows `build.joint` (a push-on build
never mentions solder or a "shiny cone"), the power wording follows `power.source`
("Unplug USB", "Disconnect the battery", "Unplug the power supply"), and the firmware line
follows `firmware.framework`: `pio run -e bringup` for arduino, `esphome run` for esphome, and
no line at all for a framework the skill generates no command for. The arduino line also needs
a board the firmware step wrote a `platformio.ini` for (ESP32, RP2040 and AVR; see
`references/firmware.md`); a Pico's line adds the boot button for the first upload. Where the skill has nothing
true to say, it says less.

## Why it is drawn the way it is

- **To scale, from part files.** Board outlines, pad positions and component heights are
  real millimetres through a fixed projection. The inventory is printed at 1:1 so a
  builder can lay a part on the page to identify it.
- **One action per step.** A step that asks for two wires gets one of them wrong.
- **Both ends magnified.** The mistake that ruins hobby builds is the wire one pad over.
  Each bubble shows the target pad filled black among its labelled neighbours.
- **Real wire colours.** The only colour on the page is the wire being added, in the
  colour the builder should pick up.
- **Text only where a drawing cannot carry it**: pin names, and one line of why.
- **Nothing is painted over what hides it.** Solids are the only things that cover
  anything. Wires, guide lines and pin labels are tested against the solids before they
  are drawn, so a wire that runs behind a part disappears behind it.

## The drawing check

`guide.ts` checks the geometry of every drawing it makes (cover, inventory, each step)
and prints one line per problem, then one summary line:

```text
drawing: page 8, step 9 (Controller 10 to Button 1), part "btn": The Button pad 1 is behind btn and btn button-cap in the step's main view, so the wire is drawn passing behind it. Turn or move the part so the pin faces the viewer: set "bench": { "x": .., "y": .., "rot": 90, 180 or 270 } on part "btn" in project.json. If the real lead is long enough to reach past the part, say so with "lead" (its length in mm) on pin "1" in a copy of assets/parts/tactile-button-6mm-tall.json in the project's parts/ folder.
drawing check: 1 problem in 18 drawings. Each line above names the page, the part and the change that fixes it.
```

A clean build ends with `drawing check: 18 drawings, no problems.` The exit code is 0
either way. `bun scripts/guide.ts <projectDir> --strict` exits 1 when any line is
printed; use it when a build must not go out with a known fault.

**Resolve or explicitly disclose every finding.** Fix project layout problems in
`project.json`. Renderer faults require a generator fix; do not distort accurate part
data to suppress them. An unresolved-geometry guide is intentionally partial and may
be handed over as logical wiring help, with its limits stated. Rebuild after changes
and read the output again. The check works on positions, not on pixels, so it is exact about
what is behind what and conservative about text (it assumes words are slightly wider
than they print).

| The line says | What it means for the builder | What to change |
| --- | --- | --- |
| `... pad N is behind X in the step's main view, so the wire is drawn passing behind it` | The pad is on the far side of one of the part's own tall shapes, or behind another part. The bubble still shows it, with X drawn as a dashed outline, but the main view does not. A header never causes this for its own pins: see "Headers" below | Write the `bench` value the line gives (it names the turn). A step already looks at the bench from the side that shows its pads, so this appears only where a turn of the part itself is needed. When no turn helps without hiding another pad, there is no finding: the step draws the pad through the part and prints a `note:`. See "Placing parts: `bench`". If the part's leads really leave the body lower than its top face (push button, axial resistor, LED), add `z` and `lead` to those pins in the part file: see "Leads" below |
| `... passes through X` | The wire's path between its two pads goes through a tall part and could not be lifted over it | Move X, or the part at either end, with `bench` |
| `... has its two ends only N mm apart on the page, one in front of the other` | One pad is exactly behind the other as seen by the viewer; no wire can be drawn between them | Move one of the two parts sideways with `bench` |
| `the name of ... pad N cannot be shown beside the pad` or `is cut off by the edge of its bubble` | There is no clear board or bench next to that pad for its name, so the bubble shows the pad but not what it is called | Rare: a name is placed away from its pad with a leader first, so this only appears when the whole bubble has no clear spot. Turn the part with `bench.rot` or move the neighbouring part away |
| `... and ... overlap by N mm where they hover` | Two parts in one exploded step run into each other. The layout raises parts to prevent this, so this only appears when two mounts occupy the same place | Fix `enclosure.mounts` x and y |
| `... and ... occupy the same space` | Two parts are placed inside each other on the bench; neither can be drawn in front | Change `bench.x`, `bench.y` on one of them |
| `the label "A" and the label "B" overlap`, or `the caption "A" runs into a bubble` | Two part names collide | Shorten the `label` of the part named |
| Any line ending `This is a fault in the renderer, not in the project` | The renderer broke one of its own guarantees (below) | Do not work around it in the project. Report it with the project folder; the tests in `scripts/lib/iso.test.ts` and `drawing-check.test.ts` are where it gets a regression test |

### What the renderer guarantees

These hold for any project, and are tested over ranges of positions and sizes rather
than on one example:

- **A wire never folds back on itself.** Each wire moves steadily from one pad to the
  other on the page, whatever the two pads' positions. Where its far end is higher up
  the page it leans toward it instead of rising straight up and hooking back.
- **A wire is never painted over a solid that is in front of it,** and a solder dot is
  only painted on a pad that can be seen. Wires are held a few millimetres above their
  pads in space, so they pass over low components, and are lifted further to clear a
  tall one when that is possible.
- **The pad a bubble is for is always visible in the bubble.** If something hides it,
  that something is drawn as a dashed outline in the bubble.
- **A free part is turned so its wired pins face the viewer.** A part without `bench`
  is turned about its own centre to the quarter turn that hides the fewest wired pins.
- **Guide lines stop where a solid is in front of them** and leave a gap under text.
- **Hovering parts never overlap, nor do their names.** In an exploded step each part
  is raised until its outline, name and arrow are clear of the others. If that would
  take more than 40 mm of extra height the step is split into two drawings.
- **A pin label is only placed where it is readable:** clear of pads, components, the
  wire being added and other labels. It lies on the board where there is room, and on
  the bench beside the board where there is not.
- **Bubbles and their captions never overlap each other,** and two steps share a page
  only when the drawing still prints with captions of 2.6 mm or more in half a page.

### What it cannot guarantee

Said plainly, so nobody assumes more than is checked:

- **It cannot make a hidden pad visible in the main view if the project fixes the part
  that way**, or if a part's wired leads leave on opposite sides. It reports it and
  relies on the bubble.
- **A pin label that has no free place is left out.** For the pad a wire goes to this
  is reported; for the neighbouring pads it is silent, so a crowded board shows fewer
  neighbour names.
- **Text sizes are estimates.** The check does not measure the font; it uses a width
  table that errs wide. If the page falls back to an unusually wide font, two labels it
  believed apart could touch.
- **It does not judge wire crossings or clutter.** Finished wires are drawn grey over
  everything they pass in front of, including pads inside a bubble. Many wires on
  neighbouring pads still make a crowded bubble.
- **It does not check the bubble's tail,** which is drawn across whatever lies between
  the bubble and its pad.
- **It does not check the part file against the real part.** A pad drawn exactly where
  a wrong part file puts it passes every check.
- **Booklet text is not checked,** only drawings: captions under the steps, the checks
  page and the inventory names are plain HTML.

## Placing parts: `bench`

`bench` on a part's entry in `parts` puts it on the drawing bench:

```json
{ "ref": "oled", "part": "ssd1306-oled-096-i2c", "bench": { "x": 60, "y": 0, "rot": 90 } }
```

- **Units and origin.** `x` and `y` are millimetres on the bench plane, seen from above
  with the component side up: `x` runs to the right, `y` runs away from you (down the
  page in the top view). The bench origin is `0, 0`; nothing limits the numbers.
- **Which corner.** `x, y` is where the part's top-left corner goes, that is its
  outline's smallest `x` and `y` after `rot` is applied. The part's own origin (see the
  part file) is its top-left corner in the orientation its silkscreen reads.
- **`rot`** is the part's turn, clockwise seen from above: 0, 90, 180 or 270 degrees.
  `x, y` is the corner of the outline after the turn, so a 90 degree turn swaps the
  part's width and depth on the bench. Give `rot` to pin the turn; leave it out to let the
  booklet pick the turn that shows the part's wired pads. `z` lifts the part (rarely needed).
- **Free parts.** A part with no `bench` is placed for you: controller boards in a front
  row, modules in a row behind, each turned so its pads face the controller. Free parts
  are laid out beside the parts you placed, never on them. Placing only some parts is
  fine: put the ones you care about, leave the rest free.
- **Colliding values.** If two parts' `bench` values put their outlines on top of each
  other, the drawing check says so, names both parts and suggests a free spot.

**One viewpoint for the whole booklet.** Every bench drawing, the cover and each wiring
step, shows the bench from the same side. A builder lines the first page up with what is
on the desk once, and every later page must show the same arrangement; turning the camera
from step to step would make each page need re-reading. So a pad that is behind its own
part from that side is handled by turning that part, which is your lever:

- A part with no `bench`, or a `bench` with only `x` and `y`, is turned automatically to
  the quarter turn that hides the fewest of its wired pads.
- A part whose `bench` gives `rot` is left as you set it. If a turn would show a hidden
  wired pad without hiding another, the drawing check says so and gives the `bench` value
  to paste. Pasting it fixes that pad on every page.
- If no turn does (a chip with both rows wired: whichever row faces away is behind the
  body), the step draws the pad through the part in its bubble, dashed, and prints a note.

**What a step shows.** The viewpoint is the same on every page, but a step does not have to
show the whole bench at full extent. When the bench is wide, or one part is large, the
whole bench would shrink every step to a strip; the step is then framed on the two parts it
joins with room around them for their neighbours, and a small drawing of the whole bench
sits under it with the frame drawn on it and the two parts shaded, so the builder can tell
where on the desk the step is. The booklet picks, for each step, the framing and the
position of the two bubbles that print the drawing largest. A step whose drawing would
still print under 70 % of the page width, or under 80 mm tall, in half a page
takes a page to itself, and a step that would be alone on a page anyway is drawn for the whole page.

**Choosing values.** Run

```bash
bun scripts/guide.ts <projectDir> --explain
```

It writes nothing. For each part it prints the `bench` value that reproduces the drawing
exactly (paste it into project.json to pin the layout and then edit one number), the
wired pads the part hides in the overview and behind what, and what each turn of the part
would do:

```text
mcu (esp32-c3-supermini)  "bench": { "x": 0, "y": 60, "rot": 0 }
  pad 5 is behind mcu usb
  turn 90: "bench": { "x": 4.2, "y": 56.8, "rot": 90 }  hides 0
```

**What a pad that is behind something means.** If a turn of its part would show it (and
not hide another wired pad), the finding names that turn as a `bench` value. If nothing
does (a chip whose two rows of pins are both wired: the row on the far side is behind the
body from one side or the other), the step draws the pad through the part in its bubble,
dashed, and `guide.ts` prints a `note:` line, "drawn through the part, nothing to fix".
Notes are not counted by `--strict`. A pad that not even the bubble can show is a finding.

**Names in a bubble.** Each bubble writes the name of the pad being wired next to it, or
away from it with a thin leader line when there is no room beside it. Names of the pads
next to it are written only where there is room; the number of bubbles that leave some
out is printed as a note (`--notes` lists them). Pads about 2 mm apart on the page get a
bubble magnified up to 1.9 times more. Two pads of one chip that are next to each other
(a tie wire between pins 2.54 mm apart) cannot be shown as a wire in the main view at all:
the note says so, and each bubble shows one end.

## Leads

A pin is drawn as a pad on the top face of its part (on the top of its header, for a pin
inside a `header` shape: see "Headers"), which is right for every header and castellated
pad. A through-hole part's legs are not there. Two optional fields on a
pin in the part file say where they are:

```json
{ "name": "1", "role": "passive", "x": 0, "y": 0.75, "z": -3.4, "lead": 3.5 }
```

- `z`: height of the solder point relative to the top face of the body; negative for a
  leg that leaves lower down. `-3.4` on a 3.4 mm body is a leg at its foot.
- `lead`: how many millimetres of bare lead there are to solder to (20 for an axial
  resistor, 17 for an LED, 3.5 for a tactile switch). Defaults to 1.5.

With `z`, the booklet draws the lead as a small tab on the body edge nearest the pin and
ends the wire on it. A lead on the far side of the part is drawn just long enough to be
seen past the body, up to `lead`. Without `z` nothing changes. To try it on one project
without touching the library, copy the part file into `<projectDir>/parts/` and edit
the copy.

In the library, both tactile buttons, the axial resistor, the 5 mm LED and the SS12D00
slide switch have these fields. Their `lead` lengths are typical values, not datasheet
ones (each file's `verify` note says so). When you add a through-hole part of your own,
give its pins `z`; a wire drawn onto the top of a part that has no pads there is the
sign that it is missing.

## Headers

On a module whose header pins are its pads (microphone, buzzer, amplifier and relay
modules), the part file tags the header box `"header"` and the pins sit under it. The
drawings treat that as what it is: the pads are drawn on the top face of the header and
every wire to one of those pins ends there, where a push-on lead lands, and where a
soldered lead meets the pin. A `header` shape therefore never hides the pins inside its
footprint, so you never turn a part with `bench.rot` for its own header, and you do not
delete the header from a project copy of the part: it stays in the inventory picture,
the 3D model and the height the case allows. A pin outside the header's footprint is a
pad on the board as before, and the pin names are still written on the board beside the
header.

The same holds for the other shapes where a wire ends: a shape tagged `screw-terminal` or
`connector` is a termination too, and the pins inside its footprint are drawn on its top
face (a screw terminal's names are written there as well, since the board is too far
below to read as their names). A wire into a screw terminal really enters from the side;
the drawing ends it on top, where the builder can see which terminal it belongs to. Any
other tall shape (a can, a button cap, a chip) is not a termination and can still hide
the pads behind it. A long pin name next to a plug or header may still fail to fit its detail bubble.
That is a renderer limitation, not evidence that a valid physical placement is wrong.
The target-label callout preserves the pad coordinates; unresolved label failures must
be reported without changing valid geometry.

## Look before you show

The drawing check does not replace looking. After it is clean:

```bash
bun scripts/shoot.ts <projectDir>/out/guide/index.html <projectDir>/out/shots --pages 1,3,4 --width 900
```

Use `--width 900` or wider; narrower triggers the phone layout. Check what the check
cannot:

- **Inventory**: does every part look like the thing it is? A blank slab means the part
  file has no `shapes`.
- **A wiring step**: can you tell which pad each end lands on from the bubble alone? Is
  the pad's name next to it? A dashed outline in a bubble means the pad is behind
  something in the main view: turn the part.
- **Crossings**: do wires cross each other or pass over a part more than necessary?
- **Enclosure steps**: do parts land inside the walls, with connectors at their
  openings? Does each dashed landing outline sit over the right opening?

## Changing the result

Layout and connection changes belong in `project.json`. Correct source geometry in a
part file only with evidence; fix renderer defects in the scripts. Then regenerate.

| Problem | Change |
| --- | --- |
| Wires cross, or a module's pads face away from the controller | Set `bench: { "x", "y", "rot" }` on the part. Without it, controllers sit in the front row, modules behind, each turned so its pads face forward and its wired pins are not behind its own shapes |
| Steps in an awkward order | Reorder `connections` |
| A caption is unclear | Edit that connection's `why` |
| Parts are labelled by reference | Add `label` to the part ("Display", "Air sensor"). Captions and bubbles use it |
| A pad carries three wires | Daisy-chain through another module's pad |
| A tall component hides the pads behind it | The drawing check names it. Turn the part with `bench.rot` so its pads are on the edge nearest the viewer (the larger y side), or move it to the front row |
| One long part (an LED strip) makes everything else small | Place it along the back with `bench`, and give it only the length that matters for wiring. When a step would print too small in half a page it takes a whole page, so the booklet gets longer rather than unreadable |
| A wire lands on the top of a through-hole part | Add `z` and `lead` to the pins in its part file: see "Leads" |
| A part is unrecognisable | Add `shapes` to its part file |
| A pin label is wrong | Fix the part file; never caption around it |

For `joint: "dupont"` the verb becomes "push on" and the soldering pages are dropped.

## Printing

`--pdf` uses headless Chrome. Without Chrome, open `index.html` and print: A4, margins
none, background graphics on. The page links `?only=N` to show a single page.

## Limits

- Drawings are boxes and cylinders. A part with an unusual shape is approximated; the
  pads are still exact.
- A wire has no real route: it is drawn as one arc held above its two pads. It is hidden
  where a solid is in front of that arc, but the arc is not how the builder will dress
  the wire.
- A lead is drawn as a flat tab on the body edge, not as a bent leg.
- The enclosure is drawn with square corners even when `radius` rounds the print.
- Lid parts are shown from behind, as plain labelled boards, because the lid lies face down.

## Parts with unresolved geometry

`geometryEvidence.status: "unresolved"` means nobody has checked the part file's outline
and pad positions against the real part. The guide is still built, from the file's
numbers, and says so where a builder looks:

- one line on the cover naming the parts, ("Layout not verified for ...");
- beside the part on the inventory page: "Layout not verified. Measure yours before
  printing the case:" and the first sentence of the part file's reason;
- under every step that solders to the part: "Layout of the ... not verified. Measure
  yours before printing the case."

What to do: measure the part you have with calipers (outline, pad centres, pad order),
write a corrected part file as `<projectDir>/parts/<id>.json` (a copy of the library
file with `geometryEvidence` removed or `source-supported`), and rebuild. `guide.ts`
prints one `warning:` line about it; that is not a drawing finding and does not affect
`--strict`. With `--strict-geometry` (or `BENCHTOP_STRICT_GEOMETRY=1`) the old behaviour
returns: the guide is the partial planning guide (an unresolved-part placeholder and a
logical connection table, no wiring, fit or enclosure scenes), and `--strict` exits 1.
