# Imagine

The user has an idea, often one sentence. Your job in this phase is to turn it into a
thing they can picture and say yes or no to, before any wiring exists.

## Find out five things

Ask only what you cannot infer, in one short batch, and offer a default for each so the
user can answer "yes to all".

1. **What it does, for whom.** The moment of use: who looks at it or touches it, how
   often, what they want to know or make happen.
2. **Where it lives.** Desk, wall, outdoors, pocket, inside something else. This decides
   size, power and whether it needs to survive weather.
3. **Power.** A USB cable is simplest and is the right default. Battery only if the place
   it lives demands it; battery roughly doubles the difficulty.
4. **Who builds it and with what.** Soldered before? Owns an iron, a multimeter, a 3D
   printer (which bed size, which material)? This sets the build path and difficulty.
5. **Budget and patience.** A rough ceiling, and "this weekend" versus "whenever".

Do not ask about parts. Choosing parts is your job, in the next phase.

If the idea listens or watches (a microphone, a camera), also ask who will be recorded and
whether they will know; the hand-over and the page carry a consent note (see "When nobody
can answer" in `SKILL.md`). If no one can answer any of this, that section says which
defaults to take and record in `DECISIONS.md`, and which to leave undecided.

## Offer directions that differ

Give two or three, each a short paragraph and a one-line trade-off. They should differ in
kind: what the user interacts with, how big it is, what it costs to build. For a plant
watering reminder:

- **The glance**: a single LED in a small puck that goes red when the soil is dry. Three
  parts, one hour, runs for months on USB.
- **The dial**: a small display showing moisture and days since watering, with a button.
  Five parts, an evening.
- **The quiet one**: no display at all; it sends a phone notification. Fewest parts on
  show, but needs Wi-Fi setup and an account somewhere.

Recommend one and say why for this person. A beginner's first build should be the
simplest direction that still does the job.

## Make it visible

Once a direction is picked, write `project.json` with `parts`, `power`, a draft `build`
block and, for a cased build, an `enclosure` block with every part mounted (`on: "floor"`
for boards and sensors, `on: "lid"` for anything the user looks at or presses; `x: 0, y: 0`
means "place it for me"). Leave `connections` empty. Then run `concept.ts` and show it.

The concept sheet gives the closed view, the inside view, the outer size with an
everyday comparison ("about the size of a deck of cards"), each part with a plain-language
blurb, and a rough parts cost. Read its warnings: a vent under a display or a port that
cannot reach a wall is easier to fix now than after the wiring is drawn.

If the environment can show images or pages, show the sheet rather than describing it.
If you can only send text, give the size comparison, the part list and the cost.

## Naming

Give the project a short name the user would put on the case: one or two syllables, a
real word in any language, not an acronym. It appears at 78 pt on the guide cover and
letter-spaced behind the product on the landing page, so four to six letters works best.
Offer two and let the user pick or supply their own.

## Leave this phase with

- `name`, `slug`, `tagline` (under ten words, what it is) and `summary` (two or three
  sentences: who, what, why).
- A parts list the user has seen drawn.
- A size they have agreed to.
- A build path you expect to recommend, even though the question is asked in phase 3.
