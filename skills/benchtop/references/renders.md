# Renders

Product images of the finished object, rendered from the same geometry as the printed
case and the guide drawings. Needs Blender 5: `BLENDER_EXE`, then `blender` on PATH, then
`Program Files\Blender Foundation\Blender *` (newest) or `/Applications/Blender.app`. Everything else in
the skill works without it.

## Run

```
bun scripts/enclosure.ts <projectDir>                 # writes out/enclosure/closed.glb
bun scripts/render.ts <projectDir>                    # all four images, draft quality
bun scripts/render.ts <projectDir> --quality final    # slower, cleaner; for anything published
bun scripts/render.ts <projectDir> --only hero,top
```

render.ts runs enclosure.ts itself when closed.glb is missing. Images land in
`<projectDir>/out/renders/`. Times on an Apple-silicon Mac at 1600 x 1200: draft about 15 s
per image, final about 60 s. The hero and hero-alpha images share one render.

## Images

| File | Use |
|---|---|
| hero.png | Landing-page hero and README. Closed object, three-quarter view from the front right. |
| hero-alpha.png | Same view, transparent background, soft contact shadow only. Composite onto any page colour. |
| exploded.png | "What is inside": the lid lifted clear, with every lid-mounted part (the ones marked `mount: "lid"` in the GLB) rising with it and hanging under it exactly as when closed; floor parts stay in the body. Higher camera than hero so the floor is visible. |
| top.png | Orthographic, straight down, lid on. Shows where the openings sit. |

## Colour and backdrop

- Case colour: `enclosure.color` in project.json, or `--color "#rrggbb"` for one run.
- Backdrop: chosen from the case colour when not given: same hue, about 14 points of
  lightness darker for a light case, lighter for a dark one, so the edges read. Override
  with `--backdrop "#rrggbb"` (`--bg` also works). It is composited after rendering, so
  the exact hex lands in the PNG.
- Part colours come from tags and part kinds in `scripts/lib/part-mesh.ts` (named
  constants). Change them there; the GLB and the renders pick them up.

## Lit LEDs

A product whose point is a light should show it lit. Say what the LEDs show in
`showcase.lit` in project.json:

```json
"showcase": { "lit": "#ff2a1a" }                  // every LED of every part
"showcase": { "lit": { "bar": "#ff2a1a" } }       // only the part with ref "bar"
```

Every shape tagged `led`, `led-1`, `led-2` ... `led-N` or `led-lens` is an LED. With `lit`
set, those of the named parts become emissive in that colour, and each throws a soft glow
on the plastic around it (a lid window, the inside of the case in exploded.png). Prefer the
map form: the string form also lights a controller's onboard LED. Without `lit`, LEDs
render as before. A strip with `units: N` has N lit LEDs: the glow is per LED. Look at
hero.png and top.png: every LED red, none grey, no white blow-out.

## What was rendered: render.json

render.ts writes `out/renders/render.json` after every successful run:

```json
{ "quality": "draft", "images": ["hero.png", "top.png"], "lit": { "*": "#ff2a1a" }, "device": "gpu" }
```

`quality` is `draft` or `final`; `images` are the files this run wrote; `lit` is what was
passed to Blender (`{ "*": colour }` for the string form, the map otherwise, or `null`);
`device` is `gpu` or `cpu` (the CPU after a GPU crash). A later step can read it to avoid
replacing final images with draft ones, or an image that shows lit LEDs with an unlit one.

## Alpha image check

hero-alpha.png must hold only the object and a soft contact shadow that reaches zero alpha
well inside the frame. `bun scripts/render.ts <projectDir> --only hero --check-alpha` prints
`ALPHA-CHECK border_max=... band3pct_max=...` (both must be about 0) and writes
`alpha-check-grey.png` and `alpha-check-colour.png`, the image over mid-grey and over saturated
blue. Look at both: no rectangle, no vertical edges, no haze. Delete them afterwards.

## When Blender is missing

render.ts prints one line (`renders skipped: Blender was not found ...`) and exits 3.
Nothing else fails. Tell the user the renders were skipped and how to install it
(`brew install --cask blender`), or to set `BLENDER_EXE` to an existing blender. Do not substitute the isometric guide drawings for the
renders on the landing page without saying so. assembly.glb and closed.glb still exist for
a web 3D viewer.

## Check before showing a render to a user (open every PNG)


1. Parts inside the case outline: nothing pokes through a wall except what is meant to
   (a button cap through the lid, a USB plug through a wall opening).
2. Openings aligned: in top.png each lid opening sits over its part (display window over the
   glass, button hole over the cap, vent over the sensor); in hero.png the USB opening
   shows the connector.
3. No z-fighting: no flickering stripes or speckle where two surfaces meet.
4. Nothing floating: in hero.png and top.png every part is seated; in exploded.png lid parts
   hang under the lid at one height and move with it (a long strip does not poke out past
   the lid's outline), floor parts sit on their standoffs.
5. Framing: everything in frame with margin; colours right, glass dark, boards recognisable.

A failure in 1 or 2 is a layout bug, not a render bug. Fix the enclosure layout and
re-run both scripts. Part meshes use `partSolids` placement, so if a part looks wrong
here it is wrong in the guide too.
