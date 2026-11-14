# Enclosure

`enclosure.ts` builds a two-piece printable case from the `enclosure` block and the part
files: a body with standoffs and wall openings, and a lid with a locating lip, openings
and screw holes. The same layout drives the guide's enclosure steps and the 3D model on
the landing page, so the drawing, the print and the page agree.

Needs `bun install --cwd scripts` once (JSCAD, pinned in `scripts/package.json`).

## The spec

```json
"enclosure": {
  "wall": 2, "fit": 0.3, "radius": 3, "lid": "screw",
  "mounts": [
    { "ref": "mcu",  "on": "floor", "x": 0, "y": 0 },
    { "ref": "oled", "on": "lid",   "x": 0, "y": 0 }
  ],
  "openings": "auto", "material": "PLA", "color": "#f2efe8"
}
```

- `mounts`: every part that goes inside. `on: "floor"` for boards and anything with a
  side connector; `on: "lid"` for whatever the user sees or presses. `x: 0, y: 0` means
  "place it for me". Non-zero positions are kept, measured from the inner front-left corner
  (see "Coordinates" below). Floor parts are packed first and set the minimum footprint;
  the lid parts you leave on `x: 0, y: 0` are then packed in two dimensions over that
  footprint (they hang from the lid, so they may sit above floor parts when the cavity is
  tall enough), and the cavity grows only if they do not fit. To pin one part exactly at
  the corner use `x: 0.01`, because `0, 0` means "place it for me".
- A part that is soldered into a wire and has no place of its own (a resistor, a diode)
  is `{ "ref": "r1", "on": "wire" }`: no position, no posts, no warning. A part that lives
  outside on a lead is not a mount; give it a cable exit (`cableFor`, below).
- `cap` on a floor mount gives a button a printed cap, so the button is as large as the cap
  and not as small as the switch's stem:
  `{ "ref": "a", "on": "floor", "x": 60.75, "y": 42, "cap": { "shape": "round", "w": 10, "color": "#e23d5b" } }`.
  `shape` is `"round"` (`w` is the diameter) or `"rect"` (`w` along x, `h` along y). The part
  then stands on a post from the floor, cut to the height that puts its stem 0.5 mm through
  the lid; the lid opening is cut to the cap; and a flange under the lid keeps the cap in,
  so it needs no glue and cannot fall out. `x`, `y` are still the corner of the switch body:
  the cap is centred on the stem. Give every capped part a position; do not leave it on
  `0, 0`. Any `standoff` on the mount is ignored. The part needs a round stem at least
  5.6 mm tall (`tactile-button-6mm-tall` has one; the short `tactile-button-6mm` does not),
  and the floor under it must be free for the post. A cap must be at least 5.9 mm across for
  a 3.5 mm stem. A rect cap has its flange on the two ends of its long axis, which lets four
  of them sit close as the arms of a D-pad. The caps come out as `caps.stl` and as extra
  objects in the `.3mf`. A lid-mounted button cannot carry a cap: the lid's own posts would
  be where the cap goes.
- `fit`: clearance around parts and between lid and body. 0.3 suits a well-tuned FDM
  printer; use 0.4 to 0.5 if the user's prints run tight.
- `wall`: 2 mm is sturdy in PLA. `radius`: outside corner radius.
- `inner`: omit it and the cavity is sized from the parts, with 6 mm of wiring space.
  A part sold by length (an LED strip with `units` on its entry in `parts`) is as long as
  its `units` make it, so the cavity grows with it and its lid window covers every LED:
  8 pixels of `ws2812b-strip` need a case at least 135 mm long. Set `units` before you
  place the lid parts.
- `openings: "auto"` cuts one for every `port` of every mounted part that reaches a wall
  or the lid. A list of `{ "ref", "port" }` cuts only those, which is how you leave out
  an opening you do not want (an onboard LED).
- `extraOpenings`: openings no part implies, most often a cable exit for something that
  lives outside the case on a lead (a soil probe, an LED strip):
  `{ "face": "x+", "u": 12, "v": 8, "w": 5, "h": 5, "shape": "round", "label": "probe lead", "cableFor": ["probe"] }`.
  `u`, `v` are the opening's centre in outer coordinates (see "Coordinates"). `cableFor`
  lists the refs of the unmounted parts whose lead leaves through it; only that answers
  their "not mounted" warning. An opening without it (a light window, say) answers nothing.
- `build.joint: "dupont"` makes the case 14 mm taller inside, room for the plastic
  housings of push-on leads standing on the pins.

## Coordinates

Two systems are in use, and they differ by the wall thickness.

| Where | Origin | Meaning |
| --- | --- | --- |
| `mounts` `x`, `y` | inner front-left corner (wall not included) | the corner of the part's footprint after `rot`; x to the right, y toward the back |
| `layout.json` `parts[].at` | outer front-left corner (z = 0 on the outside bottom) | mount + wall |
| `extraOpenings` / custom openings `u`, `v` | outer corner | the opening's centre. Side faces `y-`, `y+`: `u` along x. Faces `x-`, `x+`: `u` along y. `v` is height above the outside bottom. Lid: `u` = outer x, `v` = outer y |
| `layout.json` `openings[]` | outer | same as the custom openings, for every opening |

Keep-out areas, in mount coordinates (`inner` is the cavity, W wide and D deep):

- Four corner screw bosses, 6 mm squares: `x 0..6` or `x W-6..W`, together with `y 0..6` or
  `y D-6..D`. Nothing may overlap them; `enclosure.ts` warns "runs into a corner screw boss".
  Parts the layout places stay 6.3 mm from the side walls (boss plus `fit`) wherever they
  would touch a boss.
- Floor parts: at least `fit` from every wall. Lid parts: at least 1.8 mm from every wall
  (the lid's locating lip), and `fit` + 2 mm from each other.
- Above a floor part's up-facing port (an LED, a sensor vent): no lid part. The area is the
  port plus its margin; `--explain` prints it.
- A vented part keeps 5 mm from every board.

Worked example. Wall 2 mm, a light bar 51.1 x 10.2 mm mounted on the lid at
`"x": 26, "y": 7`, and a 40 x 6 mm window over its middle:

- The bar's footprint runs x 26..77.1, y 7..17.2 (mount coordinates), so its centre is
  (51.55, 12.1). In `layout.json` it reads `at.x` 28, `at.y` 9.
- The window is in outer coordinates: u = 51.55 + 2 = 53.55, v = 12.1 + 2 = 14.1:
  `{ "face": "lid", "u": 53.55, "v": 14.1, "w": 40, "h": 6, "shape": "rect", "label": "light window" }`.
- A cable exit on the right wall, 8 mm above the outside bottom and 20 mm from the front:
  `{ "face": "x+", "u": 20, "v": 8, ... }`. u counts along y here, from the outer front edge.

Do not guess: `bun enclosure.ts <projectDir> --explain` prints, in the same
coordinates you write, each part's position, size, rotation and the wall or lid its ports
face (with a `mounts` line to paste back), the keep-out areas, every opening with its
outer `u`, `v`, and the warnings. It writes nothing and needs no CAD packages, so use it to
pick a value before changing project.json.

## Height

The one number to quote is the **closed height**: the body (`outer.h`, floor included) plus
the lid plate (2.4 mm, or `wall` if thicker). `enclosure.ts`, `concept.ts` and print.md all
report it, from `closedHeight()` in `lib/enclosure-layout.ts`. `outer.h` alone is only the body.
The lid as printed is taller than its plate because its lip and hanging posts point down into
the body; that height is for the slicer, not for the shelf.

## Outputs, in `out/enclosure/`

`body.stl`, `lid.stl` (lid flat, outer face down), `<slug>.3mf` (both on one plate),
`assembly.glb` (for the landing page), `layout.json` (the computed layout) and `print.md`
(material, layer height, orientation, screw list and the warnings).

The screw list is computed from the geometry (thread from the hole, length from the
depth available) and is the same list the guide's inventory and the BOM print. Never
state a screw size from memory; read it from `print.md` or `layout.json`.

The script exits 4 if either mesh is not closed after repair. Do not hand over files
from a run that exited non-zero.

## Read the warnings

The script prints them and writes them to `print.md`. They are design problems:

| Warning | Consequence | Fix |
| --- | --- | --- |
| A port "points up but X sits over it" | A sensor vent is sealed in, or an LED is hidden. A sealed temperature sensor reads the warmth of the electronics, not the room | Give one of the two parts an explicit `x`/`y`, or move one to the other surface |
| A side port "does not reach a wall" | No hole for a connector | Rotate the part (`rot`) or place it against a wall |
| A port "ends N mm short of standing proud of the lid" | A button or switch nobody can press: its stem does not reach through the lid | Use the taller variant the warning asks for (`tactile-button-6mm-tall` for buttons), or print a cap |
| "The caps of A and B run into each other", or a cap "runs into" a lid part | Two flanges, or a flange and a part hanging under the lid, want the same space, so one button will bind | Move the parts apart or make a cap smaller. A flange is 1.2 mm wider than its cap on each side |
| A part "stands on a post from the floor, but X is where the post goes" | No post, so pressing the cap pushes the switch down into the case | Move the floor part named, or the button |
| "The stem of X ... a cap's flange needs 2.7 mm" | The switch is too short for a captive cap | Use `tactile-button-6mm-tall` |
| A part "will read the controller's warmth" | A temperature sensor next to the heat source | Give the sensor an explicit position at the far end, or widen `inner` so there is a far end |
| A part "is not mounted in the case" | It is in `parts` but not in `mounts` | Mount it; if it is soldered into a wire, add `{ "ref", "on": "wire" }` to `mounts`; if it lives outside on a lead, add a cable exit with `extraOpenings` that lists the ref in `cableFor` (an unrelated window or vent does not count) |
| A part "is located by its posts and not screwed" | The post is too short for a screw | Fine for a board held down by the lid; otherwise raise `standoff` |
| Parts collide or do not fit `inner` | The case cannot close | Remove `inner`, or move a part |
| Snap or slide lid requested | Only the screw lid is generated; other values give a plain friction lid | Use `"screw"` |

Rerun `concept.ts` after layout changes; it is the fastest way to see the result.

## Before printing

Most part files hold typical clone dimensions, so the first full print often does not
fit. The fit test finds that out in about fifteen minutes.

1. Print the fit test first: `fit-test.3mf` (or `fit-floor.stl` and `fit-lid.stl`).
   `fit-floor` is the bottom of the body with a 0.8 mm floor, every post at its real
   height and the lower part of the wall openings. `fit-lid` is a 1.2 mm plate with the
   real openings, screw holes and hanging posts. Both come from the same geometry as the
   case, so what fits here fits there. Try the parts on them and go through the
   "Print this first" checklist in `print.md`. If a part does not fit or a port misses
   its opening, measure it against the part file's `verify` note, correct the part file
   (or override it in `<projectDir>/parts/`), regenerate and print the fit test again.
   The case is cut to the part files, nothing else.
2. Use calipers for what the fit test cannot show: the height of tall components
   (headers, capacitors, buttons) against the underside of the lid, and the thickness of
   anything that sits between a board and the lid. The fit-floor wall stops 3 mm above
   the tallest floor board, so it shows nothing above that.
3. Print the case. Settings are in `print.md`. PLA is fine indoors; PETG or ASA for a car, a window sill
   or outdoors. The case is not sealed: outdoor use needs a gasket and cable gland the
   generator does not make.

## Checking a build

The generator repairs its meshes, and for the example both body and lid are closed
(every edge shared by exactly two triangles) with bounding boxes equal to the layout.
A slicer preview is still the real check: open the `.3mf` if a slicer is available, or
ask the user to, and look for thin walls around openings and standoffs that float.

## Limits

- Rectangular body and flat lid only. For other shapes, start from `layout.json`, which
  holds every part position, standoff and opening in world coordinates.
- Boards without mounting holes sit between four corner posts; they are located, not clamped.
- STL and 3MF only, no STEP.
