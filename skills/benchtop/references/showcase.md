# Showcase: the landing page and the package

`package.ts` assembles `dist/<slug>/`: a landing page, the guide and every file, plus a
zip. The page layout is fixed and tested; what you bring is the copy and the theme.

## Where the design comes from

The section order and patterns were taken from current hardware product sites collected
on Mobbin (the Sites section, filtered to Technology and Shopping) and from flat-pack
assembly booklets:

| Section | Pattern |
| --- | --- |
| Navigation | A floating pill of section links, the wordmark left, the primary action right |
| Hero | Small fact chips, a two-tone headline (a quiet first sentence, then the claim), one primary and one secondary action |
| Stage | The object alone on a wide rounded stage, the name letter-spaced behind it, spec pills floating at the corners. The 3D model fades in over the line drawing when it loads |
| How it works | Three numbered cards about using the thing |
| Stats | A hairline grid of four numbers |
| Features | A dark band, a two-tone heading, six short claims under thin rules |
| What's inside | Each part as a line drawing with a plain blurb and price |
| Build | The first three guide steps as paper cards |
| Files | A list of downloads, one row each |
| FAQ | An accordion |

If a browser with Mobbin access is available and the user wants a look of their own,
browse Sites there for two or three references in the product's category before choosing
the theme, and say which ones you drew on. Take structure and restraint from them, never
copy text, imagery or a brand's identity.

## Writing the copy

Write for someone who has never heard of the project and will give the page ten seconds.

- **`headline`**: five to nine words. The promise, not the parts. Two short sentences
  work best because the page sets the first one in grey and the second in full ink:
  "Know your air. At a glance."
- **`subhead`**: one or two sentences. What it is, in concrete nouns, and the one thing
  that makes it easy to say yes to.
- **`howItWorks`**: exactly three steps about *using* the finished thing, not building it.
  Title of two or three words, one sentence each.
- **`features`**: three or six. Each a claim a sceptic could check, with the reason in
  the body. "Stays on your desk: readings live on the device, nothing is sent anywhere."
- **`featuresHeading`**: the heading over the features. Two short sentences again
  ("Four parts. One evening."). Left out, the tagline is used.
- **`stats`**: up to four numbers that are true and that someone would repeat. Parts
  count, build time, cost, battery life. A zero can be the strongest one.
- **`faq`**: the real objections. Can I build it without soldering experience, without a
  printer, what cable, can I change it, what does it cost to run.

Use the user's language for the page if they write to you in one. Keep claims to what
the project does; do not invent accuracy figures, battery life or certifications. If a
number is an estimate, the FAQ is the place to say so. A project nobody has built yet
should say so on its page: add an FAQ entry, and remove it once the first one works.

The template writes a few sentences of its own, and each follows from project data or
from how the files are made: "Build it in N minutes" is `build.minutes`, the parts
count and total are computed, and "drawn to scale from the real parts" describes the
guide generator. Everything else that makes a claim is your copy. If `build.minutes` is
a guess, the page states your guess as fact: make it an honest one.

Prices and the parts total come from `project.sourcing` when every part has a line
there (in that currency), else from the part files' USD estimates. A sourcing line's
price is what the buyer pays for that listing, so a five-pack shows the pack price
against one part: say "pack of 5" in the line's `note`, which the shopping page and
BOM print. Leave a shop's shipping `price` out when it is only shown at checkout; the
totals then say so instead of assuming zero. The size on the stage is the closed case,
lid included.

## Choosing the theme

```json
"theme": { "mood": "minimal-light", "accent": "#ff5a1f", "display": "Inter Tight", "text": "Inter" }
```

| `mood` | Feels like | Use for |
| --- | --- | --- |
| `minimal-light` | Off-white, black type, one accent | The default. Desk objects, tools, anything calm |
| `warm-paper` | Cream paper, warm ink | Home, kitchen, garden, gifts |
| `stage-dark` | Near-black with a lit stage, drawings as white lines | Audio, lighting, anything that glows |
| `blueprint` | Deep blue with a drafting grid | Instruments, robots, technical showpieces |

- `accent`: one colour, used only for the small dots on spec pills and focus rings.
  Take it from the object (the case colour, an LED colour), not from a palette.
- `display` and `text`: Google Fonts family names. One grotesque for both is always safe
  (Inter Tight with Inter). A characterful display face (Space Grotesk, Bricolage
  Grotesque, Fraunces, Instrument Serif) changes the page's personality more than
  anything else; pair it with a plain text face.
- `enclosure.color` tints the 3D model. Match it to the filament the user will print in.

## Look at it

```bash
bun scripts/shoot.ts <projectDir>/dist/<slug>/index.html <projectDir>/out/shots --width 1320 --height 2400
bun scripts/shoot.ts <projectDir>/dist/<slug>/index.html <projectDir>/out/shots --width 520 --height 2400   # narrow layout
```

Headless Chrome will not lay out narrower than about 500 px, so 520 is the narrowest
honest check; ask the user to open it on a phone for the real one.

Check that the headline breaks well, no card has an orphaned last word, the stats read as
a set, and the object is centred on the stage. Rewrite copy that wraps badly rather than
accepting it.

The 3D model needs the folder to be served (`bunx serve dist/<slug>` or any static host);
opened straight from disk the page shows the line drawing instead, by design.

## What is in the package

```
dist/<slug>/
  index.html          landing page
  README.md           what each file is
  <slug>.zip          the whole folder, linked from the page
  guide/              index.html, guide.pdf
  files/              bom.csv, project.json, enclosure/, pcb/, firmware/
```

The page links only to files that exist, so run the build steps you want included
before packaging. The folder is a static site: it can be dropped on any host as it is.
Publishing it anywhere is the user's decision; ask before uploading.
