# Print notes

## Print this first

Two small pieces cut to the same part files as the full case. Print them before the case: if a part does not fit, you find out in about 15 minutes instead of after the full print.

- fit-floor.stl: the bottom of the body, 58.9 x 36 x 7.8 mm. Floor thinned to 0.8 mm, every post at its real height, wall 7 mm above the floor, wall openings cut as far up as the wall goes. Try the floor-mounted parts on it.
- fit-lid.stl: a 1.2 mm plate, 58.9 x 36 x 4.4 mm, with the real lid openings, the screw holes and the hanging posts, without the lip. Hold the lid-mounted parts against it.
- fit-test.3mf has both on one plate, flat side down. No supports.

Time: roughly 15 minutes. This is an estimate: 6.4 cm3 of plastic at an assumed 8 mm3/s average flow, rounded to 5 minutes. Your slicer and printer decide the real figure.

Check:

- [ ] The Controller drops onto its posts without force and its USB-C lines up with the notch in the wall.
- [ ] The Air sensor's vent sits centred in its opening.
- [ ] The Display's display sits centred in its opening.
- [ ] The Button's button-cap sits centred in its opening.

If a check fails: measure the part with calipers, correct its part file (or override it with a copy in the project's parts/ folder), and regenerate with `bun enclosure.ts <projectDir>`. Then print the fit test again before the full case.

## Full print

- Material: PLA
- Layer height: 0.2 mm
- Supports: No supports expected. The wide wall openings (mcu.USB-C 12.5 mm) bridge across the top edge; check the preview and enable bridge settings or add a support there if the slicer sags it.
- Body orientation: floor on the bed, open side up, exactly as in body.stl.
- Lid orientation: outer face on the bed (lid.stl is already flat that way), so the locating lip and hanging standoffs point up and need no supports. The countersinks sit on the bed side.
- Closed size: 58.9 x 36 x 21.1 mm (closed height: body 18.7 mm plus lid plate 2.4 mm).
- Printed pieces: body 58.9 x 36 x 18.7 mm; lid 58.9 x 36 x 5.6 mm including its lip and hanging posts, which sit inside the body when closed.
- Cavity: 54.9 x 32 x 16.7 mm, wall 2 mm, fit clearance 0.3 mm.

## Hardware

- 4 x M3 x 10 mm countersunk screw: lid to body
- 4 x M2 x 5 mm pan-head screw: oled to its lid posts

## Warnings

- none
