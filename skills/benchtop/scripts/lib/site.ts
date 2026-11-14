// Landing page for a finished project: one self-contained HTML file.
//
// The section order and the patterns in each section come from studying current
// hardware product sites (see references/showcase.md): a pill navigation with the
// primary action in it, a two-tone headline over a product stage, numbered "how it
// works" cards, the object surrounded by floating spec pills, a hairline stats grid,
// a parts inventory, a build teaser, a downloads list, and an FAQ.

import { esc } from "./iso";
import type { Loaded } from "./project";
import type { Showcase } from "./types";

export interface Download {
  label: string;
  detail: string;
  href: string;
  kind: string;
}

export interface SiteContext {
  hero: string;
  /** Path to a GLB of the assembly, relative to the page. Enables the 3D viewer. */
  model?: string;
  /** Rendered images, paths relative to the page. `hero` should have a transparent background. */
  renders?: { hero?: string; exploded?: string; top?: string };
  /** Drawing sheets, paths relative to the page. */
  drawings?: { wiring?: string; wiringLegend?: string; enclosure?: string; /** Later sheets of a plan split over several (wiring-2.svg, ...). */ wiringMore?: string[]; /** Later pages of a long connections list. */ wiringLegendMore?: string[] };
  steps: string[];
  /** `price` is already formatted with its currency, e.g. "$3" or "59 NOK". */
  parts: { svg: string; name: string; qty: number; blurb: string; price: string }[];
  downloads: Download[];
  guideHref?: string;
  shoppingHref?: string;
  zipHref?: string;
  dims?: { w: number; d: number; h: number };
  /** Parts total, formatted with its currency. Real prices once the project is sourced, else an estimate. */
  total: string;
}

interface Mood {
  bg: string;
  surface: string;
  ink: string;
  muted: string;
  line: string;
  stage: string;
  invert: string;
  inkOn: string;
  dark: boolean;
}

const MOODS: Record<Showcase["theme"]["mood"], Mood> = {
  "minimal-light": {
    bg: "#f7f7f4",
    surface: "#ffffff",
    ink: "#0e0e0d",
    muted: "#74736d",
    line: "#e4e3dd",
    stage: "linear-gradient(180deg,#eceae4,#d6d4cc)",
    invert: "#0e0e0d",
    inkOn: "#f7f7f4",
    dark: false,
  },
  "warm-paper": {
    bg: "#f3eee4",
    surface: "#fbf8f1",
    ink: "#1d1a15",
    muted: "#7c7467",
    line: "#e0d7c6",
    stage: "linear-gradient(180deg,#e8e0d0,#d6cab4)",
    invert: "#1d1a15",
    inkOn: "#f3eee4",
    dark: false,
  },
  "stage-dark": {
    bg: "#0b0c0e",
    surface: "#141619",
    ink: "#f3f3f0",
    muted: "#8c9098",
    line: "#24272c",
    stage: "radial-gradient(120% 90% at 50% 100%,#2a2e35 0%,#121417 55%,#0b0c0e 100%)",
    invert: "#f3f3f0",
    inkOn: "#0b0c0e",
    dark: true,
  },
  blueprint: {
    bg: "#0d2a66",
    surface: "#12357d",
    ink: "#eef3ff",
    muted: "#a7bbe8",
    line: "rgba(255,255,255,.2)",
    stage:
      "linear-gradient(rgba(255,255,255,.07) 1px,transparent 1px) 0 0/28px 28px,linear-gradient(90deg,rgba(255,255,255,.07) 1px,transparent 1px) 0 0/28px 28px,#0f3074",
    invert: "#eef3ff",
    inkOn: "#0d2a66",
    dark: true,
  },
};

const font = (name: string) => name.trim().replace(/\s+/g, "+");

function headline(h: string): string {
  // "Know your air. At a glance." reads as a quiet line followed by the claim.
  const cut = h.indexOf(". ");
  if (cut < 0) return esc(h);
  return `<span>${esc(h.slice(0, cut + 1))}</span> ${esc(h.slice(cut + 2))}`;
}


export function renderSite(loaded: Loaded, ctx: SiteContext): string {
  const { project } = loaded;
  const s = project.showcase!;
  const m = MOODS[s.theme.mood] ?? MOODS["minimal-light"];
  const pathName = { wire: "Hand-wired", "pcb-diy": "Solder-it-yourself PCB", "pcb-assembled": "Assembled PCB" }[project.build.path];

  const pills = [
    `${project.build.minutes} min build`,
    `Difficulty ${project.build.difficulty}/3`,
    `Parts: ${ctx.total}`,
  ];
  const specs = [
    ctx.dims ? `${ctx.dims.w.toFixed(0)} x ${ctx.dims.d.toFixed(0)} x ${ctx.dims.h.toFixed(0)} mm` : null,
    project.power.source === "usb" ? "USB powered" : project.power.source === "lipo" ? "Rechargeable" : cap(project.power.source),
    project.enclosure ? `Printed in ${project.enclosure.material}` : pathName,
    `${project.parts.length} parts`,
  ].filter((x): x is string => !!x);

  // The line drawing is always there; the 3D model fades in over it once it has
  // loaded. A file:// page cannot fetch the model, so the drawing is also the
  // fallback when the folder is opened straight from disk.
  // A rendered image of the object takes the stage when one exists; the line drawing
  // is the fallback and still appears in the build section.
  const visual =
    (ctx.renders?.hero
      ? `<img class="shot" src="${esc(ctx.renders.hero)}" alt="${esc(project.name)}, rendered" width="1600" height="1200">`
      : `<div class="art">${ctx.hero}</div>`) +
    (ctx.model
      ? `<model-viewer src="${esc(ctx.model)}" alt="${esc(project.name)} 3D model" camera-controls auto-rotate rotation-per-second="14deg" interaction-prompt="none" shadow-intensity="1.1" shadow-softness="0.9" exposure="0.92" camera-orbit="-35deg 60deg auto" touch-action="pan-y"></model-viewer>`
      : "");

  const views: string[] = [];
  // Say only what the page shows. A build without Blender has drawings and no renders, and
  // the page used to call them "rendered" all the same.
  const hasRender = !!(ctx.renders?.exploded || ctx.renders?.top);
  const hasDrawing = !!(ctx.drawings?.enclosure || ctx.drawings?.wiring || ctx.drawings?.wiringLegend);
  const viewsLede = hasRender && hasDrawing ? "Rendered and drawn" : hasRender ? "Rendered" : "Drawn";
  if (ctx.renders?.exploded) {
    views.push(`<figure><img src="${esc(ctx.renders.exploded)}" alt="Exploded view" loading="lazy" width="1600" height="1200"><figcaption>Opened up: what sits where</figcaption></figure>`);
  }
  if (ctx.renders?.top) {
    views.push(`<figure><img src="${esc(ctx.renders.top)}" alt="Top view" loading="lazy" width="1600" height="1200"><figcaption>From above</figcaption></figure>`);
  }
  if (ctx.drawings?.enclosure) {
    views.push(`<figure><img class="sheet" src="${esc(ctx.drawings.enclosure)}" alt="Dimensioned drawing of the case" loading="lazy"><figcaption>Dimensions, in millimetres</figcaption></figure>`);
  }
  if (ctx.drawings?.wiring) {
    views.push(`<figure><img class="sheet" src="${esc(ctx.drawings.wiring)}" alt="Wiring diagram, top view" loading="lazy"><figcaption>Wiring, top view</figcaption></figure>`);
  }
  (ctx.drawings?.wiringMore ?? []).forEach((src, i) => {
    views.push(`<figure><img class="sheet" src="${esc(src)}" alt="Wiring diagram, sheet ${i + 2}" loading="lazy"><figcaption>Wiring, sheet ${i + 2}</figcaption></figure>`);
  });
  // The step numbers on the plan mean nothing without the list, so it follows the plan when it has a sheet of its own.
  if (ctx.drawings?.wiringLegend) {
    views.push(`<figure><img class="sheet" src="${esc(ctx.drawings.wiringLegend)}" alt="Wiring connections, step by step" loading="lazy"><figcaption>Wiring, connections</figcaption></figure>`);
  }
  (ctx.drawings?.wiringLegendMore ?? []).forEach((src, i) => {
    views.push(`<figure><img class="sheet" src="${esc(src)}" alt="Wiring connections, page ${i + 2}" loading="lazy"><figcaption>Wiring, connections, page ${i + 2}</figcaption></figure>`);
  });

  const nav = [
    ["#how", "How it works"],
    ["#inside", "What's inside"],
    ["#build", "Build"],
    ["#files", "Files"],
  ];

  const css = `
:root{--bg:${m.bg};--surface:${m.surface};--ink:${m.ink};--muted:${m.muted};--line:${m.line};--accent:${s.theme.accent};--invert:${m.invert};--ink-on:${m.inkOn};
--display:"${s.theme.display}",ui-sans-serif,system-ui,-apple-system,"Helvetica Neue",Arial,sans-serif;--text:"${s.theme.text}",ui-sans-serif,system-ui,-apple-system,"Helvetica Neue",Arial,sans-serif;--r:28px;--w:1120px}
*{box-sizing:border-box}html{scroll-behavior:smooth;-webkit-text-size-adjust:100%}
body{margin:0;background:var(--bg);color:var(--ink);font:400 17px/1.5 var(--text);-webkit-font-smoothing:antialiased;text-rendering:optimizeLegibility}
a{color:inherit;text-decoration:none}img,svg{display:block;max-width:100%}
:focus-visible{outline:2px solid var(--accent);outline-offset:3px;border-radius:8px}
.wrap{max-width:var(--w);margin:0 auto;padding:0 24px}
h1,h2,h3{font-family:var(--display);font-weight:600;letter-spacing:-.035em;line-height:1.02;margin:0;text-wrap:balance}
h1{font-size:clamp(44px,7.4vw,92px)}h1 span,h2 span{color:var(--muted)}
h2{font-size:clamp(32px,4.4vw,54px);letter-spacing:-.03em}
h3{font-size:20px;letter-spacing:-.015em;line-height:1.2}
p{margin:0;text-wrap:pretty}.lede{font-size:clamp(18px,1.6vw,21px);color:var(--muted);max-width:34em}
section{padding:112px 0}
.eyebrow{font:500 13px/1 var(--text);letter-spacing:.08em;text-transform:uppercase;color:var(--muted);margin-bottom:20px}
header.nav{position:sticky;top:14px;z-index:20;margin-top:14px}
header.nav .wrap{display:flex;align-items:center;justify-content:space-between;gap:16px}
.mark{font:600 17px/1 var(--display);letter-spacing:-.02em;padding:11px 16px;border-radius:999px;background:color-mix(in srgb,var(--surface) 78%,transparent);backdrop-filter:saturate(1.6) blur(18px);-webkit-backdrop-filter:saturate(1.6) blur(18px);border:1px solid var(--line)}
nav.pill{display:flex;gap:2px;padding:5px;border-radius:999px;background:color-mix(in srgb,var(--surface) 78%,transparent);backdrop-filter:saturate(1.6) blur(18px);-webkit-backdrop-filter:saturate(1.6) blur(18px);border:1px solid var(--line)}
nav.pill a{font-size:14px;padding:8px 14px;border-radius:999px;color:var(--muted);transition:color .2s,background .2s}
nav.pill a:hover{color:var(--ink);background:color-mix(in srgb,var(--ink) 7%,transparent)}
.btn{display:inline-flex;align-items:center;gap:8px;font:500 15px/1 var(--text);padding:13px 20px;border-radius:999px;background:var(--invert);color:var(--ink-on);border:1px solid var(--invert);transition:transform .2s cubic-bezier(.2,.8,.2,1),opacity .2s}
.btn:hover{transform:translateY(-1px)}.btn:active{transform:translateY(0) scale(.98)}
.btn.ghost{background:transparent;color:var(--ink);border-color:var(--line)}
.btn.small{padding:10px 16px;font-size:14px}
.hero{padding:72px 0 0}
.hero .top{display:grid;grid-template-columns:1.25fr 1fr;gap:48px;align-items:end}
.hero .side{display:flex;flex-direction:column;gap:24px;padding-bottom:8px}
.cta{display:flex;gap:10px;flex-wrap:wrap}
.pills{display:flex;gap:8px;flex-wrap:wrap;margin-bottom:28px}
.chip{font-size:13px;line-height:1;padding:8px 12px;border-radius:999px;border:1px solid var(--line);color:var(--muted);background:color-mix(in srgb,var(--surface) 70%,transparent);white-space:nowrap}
.stage{position:relative;margin-top:56px;border-radius:var(--r);background:${m.stage};border:1px solid var(--line);overflow:hidden;aspect-ratio:16/9;display:grid;place-items:center;isolation:isolate}
.stage .ghost{position:absolute;inset:0;display:flex;align-items:center;justify-content:space-between;padding:0 4%;font:600 clamp(72px,17vw,250px)/1 var(--display);letter-spacing:-.02em;color:color-mix(in srgb,var(--ink) 6%,transparent);z-index:-1;user-select:none}
.stage .art{width:min(62%,620px);height:82%;transition:opacity .5s}
.stage model-viewer{position:absolute;inset:0;width:100%;height:100%;--poster-color:transparent;background:transparent;opacity:0;transition:opacity .5s}
.stage.live model-viewer{opacity:1}.stage.live .art,.stage.live .shot{opacity:0}
.stage .shot{width:min(82%,900px);height:96%;object-fit:contain;transition:opacity .5s}
.views{display:grid;grid-template-columns:repeat(auto-fit,minmax(280px,1fr));gap:16px}
.views figure{margin:0;border-radius:22px;overflow:hidden;border:1px solid var(--line);background:var(--surface)}
.views img{display:block;width:100%;height:auto}
.views .sheet{background:#fff;padding:18px}
.views figcaption{padding:14px 20px 16px;font-size:14px;color:var(--muted)}
.art svg{width:100%;height:100%}
.art{${m.dark ? "filter:invert(1) hue-rotate(180deg);mix-blend-mode:screen" : "mix-blend-mode:multiply"}}
${m.dark ? "" : ".stage .art{mix-blend-mode:normal}"}
.stage .spec{position:absolute;font-size:13px;line-height:1;padding:9px 13px;border-radius:999px;background:color-mix(in srgb,var(--surface) 82%,transparent);border:1px solid var(--line);backdrop-filter:blur(12px);-webkit-backdrop-filter:blur(12px);display:flex;align-items:center;gap:7px;white-space:nowrap}
.stage .spec::before{content:"";width:6px;height:6px;border-radius:50%;background:var(--accent)}
.spec:nth-of-type(1){left:7%;top:16%}.spec:nth-of-type(2){right:8%;top:24%}.spec:nth-of-type(3){left:10%;bottom:18%}.spec:nth-of-type(4){right:9%;bottom:14%}
.head{display:grid;grid-template-columns:1fr 1fr;gap:48px;align-items:end;margin-bottom:56px}
.cards{display:grid;grid-template-columns:repeat(3,1fr);gap:16px}
.card{background:var(--surface);border:1px solid var(--line);border-radius:22px;padding:28px;display:flex;flex-direction:column;gap:10px}
.card .n{font:500 13px/1 var(--text);width:28px;height:28px;border-radius:50%;border:1px solid var(--line);display:grid;place-items:center;color:var(--muted);margin-bottom:36px}
.card p{color:var(--muted);font-size:15.5px}
.stats{display:grid;grid-template-columns:repeat(4,1fr);border:1px solid var(--line);border-radius:22px;background:var(--surface);overflow:hidden}
.stats div{padding:30px 28px;border-left:1px solid var(--line)}.stats div:first-child{border-left:0}
.stats b{display:block;font:600 clamp(34px,4vw,52px)/1 var(--display);letter-spacing:-.04em}
.stats b small{font-size:.42em;font-weight:500;letter-spacing:-.01em;margin-left:4px;color:var(--muted)}
.stats span{display:block;margin-top:10px;font-size:14px;color:var(--muted)}
.band{background:var(--invert);color:var(--ink-on);border-radius:var(--r);padding:72px 56px}
.band h2 span{color:color-mix(in srgb,var(--ink-on) 55%,transparent)}
.feats{display:grid;grid-template-columns:repeat(3,1fr);gap:40px 32px;margin-top:56px}
.feats div{border-top:1px solid color-mix(in srgb,var(--ink-on) 18%,transparent);padding-top:20px}
.feats p{color:color-mix(in srgb,var(--ink-on) 62%,transparent);font-size:15.5px;margin-top:8px}
.parts{display:grid;grid-template-columns:repeat(4,1fr);gap:16px}
.part{background:var(--surface);border:1px solid var(--line);border-radius:22px;padding:20px;display:flex;flex-direction:column;gap:6px}
.part .art{height:150px;margin-bottom:10px;display:grid;place-items:center}
.part .art svg{max-height:150px;width:auto;max-width:100%}
.part small{color:var(--muted);font-size:14px;line-height:1.4}
.part .row{display:flex;justify-content:space-between;align-items:baseline;gap:8px;margin-top:auto;padding-top:12px;font-size:14px;color:var(--muted)}
.build{display:grid;grid-template-columns:repeat(3,1fr);gap:16px;margin-bottom:28px}
.build figure{margin:0;background:#fff;border:1px solid var(--line);border-radius:22px;padding:18px 18px 14px;position:relative;aspect-ratio:3/2;display:flex;align-items:center}
.build figure svg{width:100%;height:100%}
.build figure b{position:absolute;left:20px;top:14px;font:800 34px/1 var(--display);color:#111}
.files{border:1px solid var(--line);border-radius:22px;background:var(--surface);overflow:hidden}
.files a{display:grid;grid-template-columns:54px 1fr auto;align-items:center;gap:16px;padding:18px 22px;border-top:1px solid var(--line);transition:background .2s}
.files a:first-child{border-top:0}.files a:hover{background:color-mix(in srgb,var(--ink) 4%,transparent)}
.files .k{font:600 11px/1 ui-monospace,SFMono-Regular,Menlo,monospace;letter-spacing:.04em;text-transform:uppercase;width:54px;height:36px;border-radius:10px;border:1px solid var(--line);display:grid;place-items:center;color:var(--muted)}
.files small{display:block;color:var(--muted);font-size:14px}
.files .get{font-size:14px;padding:9px 14px;border-radius:999px;border:1px solid var(--line)}
.faq{max-width:760px;margin:0 auto;border:1px solid var(--line);border-radius:22px;background:var(--surface);overflow:hidden}
.faq details{border-top:1px solid var(--line);padding:0 24px}.faq details:first-child{border-top:0}
.faq summary{list-style:none;cursor:pointer;padding:20px 0;font-weight:500;display:flex;justify-content:space-between;gap:16px}
.faq summary::-webkit-details-marker{display:none}
.faq summary::after{content:"+";color:var(--muted);font-weight:400;transition:transform .25s}
.faq details[open] summary::after{transform:rotate(45deg)}
.faq p{padding:0 0 22px;color:var(--muted);max-width:60ch}
.close{background:var(--surface);border:1px solid var(--line);border-radius:var(--r);padding:44px 48px;display:flex;justify-content:space-between;align-items:center;gap:24px;flex-wrap:wrap}
.close p{color:var(--muted);margin-top:8px}
footer.end{padding:56px 0 64px;color:var(--muted);font-size:14px}
footer.end .wrap{display:flex;justify-content:space-between;gap:16px;flex-wrap:wrap;border-top:1px solid var(--line);padding-top:28px}
@media (max-width:900px){section{padding:76px 0}.hero .top,.head{grid-template-columns:1fr;gap:24px}.cards,.feats,.build{grid-template-columns:1fr}.card .n{margin-bottom:24px}.stats{grid-template-columns:1fr 1fr}.stats div:nth-child(odd){border-left:0}.stats div:nth-child(n+3){border-top:1px solid var(--line)}.parts{grid-template-columns:1fr 1fr}.band{padding:48px 26px}.stage{aspect-ratio:4/5}.stage .art{width:88%;height:62%}nav.pill{display:none}.close{padding:32px 26px}.spec:nth-of-type(1){left:5%;top:6%}.spec:nth-of-type(2){right:5%;top:13%}.spec:nth-of-type(3){left:5%;bottom:12%}.spec:nth-of-type(4){right:5%;bottom:5%}}
@media (max-width:520px){.parts{grid-template-columns:1fr}.files a{grid-template-columns:54px 1fr}.files .get{display:none}.wrap{padding:0 16px}}
@media (prefers-reduced-motion:reduce){html{scroll-behavior:auto}*{transition:none!important}}
`;

  const primaryHref = ctx.zipHref ?? ctx.guideHref ?? "#files";
  const primaryLabel = ctx.zipHref ? "Download the kit" : "Read the guide";

  const body =
    `<header class="nav"><div class="wrap"><a class="mark" href="#top">${esc(project.name)}</a>` +
    `<nav class="pill" aria-label="Sections">${nav.map(([h, l]) => `<a href="${h}">${l}</a>`).join("")}</nav>` +
    `<a class="btn small" href="${esc(primaryHref)}">${primaryLabel}</a></div></header>` +
    `<main id="top">` +
    // Hero
    `<section class="hero"><div class="wrap"><div class="pills">${pills.map((p) => `<span class="chip">${esc(p)}</span>`).join("")}</div>` +
    `<div class="top"><h1>${headline(s.headline)}</h1><div class="side"><p class="lede">${esc(s.subhead)}</p>` +
    `<div class="cta"><a class="btn" href="${esc(primaryHref)}">${primaryLabel}</a>` +
    (ctx.guideHref && ctx.zipHref ? `<a class="btn ghost" href="${esc(ctx.guideHref)}">Read the guide</a>` : "") +
    `</div></div></div>` +
    `<div class="stage"><div class="ghost" aria-hidden="true">${[...project.name.toUpperCase()].map((c) => `<span>${esc(c)}</span>`).join("")}</div>` +
    visual +
    specs.map((x) => `<span class="spec">${esc(x)}</span>`).join("") +
    `</div></div></section>` +
    // How it works
    `<section id="how"><div class="wrap"><div class="head"><h2>How it works.</h2><p class="lede">${esc(project.summary)}</p></div>` +
    `<div class="cards">${s.howItWorks
      .slice(0, 3)
      .map((c, i) => `<article class="card"><span class="n">${i + 1}</span><h3>${esc(c.title)}</h3><p>${esc(c.body)}</p></article>`)
      .join("")}</div></div></section>` +
    // Stats
    (s.stats.length
      ? `<section style="padding-top:0"><div class="wrap"><div class="stats">${s.stats
          .slice(0, 4)
          .map((x) => `<div><b>${esc(x.value)}${x.unit ? `<small>${esc(x.unit)}</small>` : ""}</b><span>${esc(x.label)}</span></div>`)
          .join("")}</div></div></section>`
      : "") +
    // Features
    `<section style="padding-top:0"><div class="wrap"><div class="band"><h2>${headline(s.featuresHeading ?? `${project.tagline}.`)}</h2>` +
    `<div class="feats">${s.features.map((x) => `<div><h3>${esc(x.title)}</h3><p>${esc(x.body)}</p></div>`).join("")}</div></div></div></section>` +
    // Views: renders and drawings, when the project has them
    (views.length
      ? `<section style="padding-top:0"><div class="wrap"><div class="head"><h2>From every side.</h2>` +
        `<p class="lede">${viewsLede} from the same files the case is printed from.</p></div>` +
        `<div class="views">${views.join("")}</div></div></section>`
      : "") +
    // Parts
    `<section id="inside" style="padding-top:0"><div class="wrap"><div class="head"><h2>What's inside.</h2>` +
    `<p class="lede">${project.parts.length} parts. Total: ${esc(ctx.total)}.</p></div>` +
    `<div class="parts">${ctx.parts
      .map(
        (p) =>
          `<article class="part"><div class="art">${p.svg}</div><h3>${esc(p.name)}</h3><small>${esc(p.blurb)}</small>` +
          `<div class="row"><span>${p.qty} x</span><span>${esc(p.price)}</span></div></article>`,
      )
      .join("")}</div>` +
    (ctx.shoppingHref ? `<a class="btn" style="margin-top:28px" href="${esc(ctx.shoppingHref)}">Open the shopping list</a>` : "") +
    `</div></section>` +
    // Build
    `<section id="build" style="padding-top:0"><div class="wrap"><div class="head"><h2>Build it <span>in ${project.build.minutes} minutes.</span></h2>` +
    `<p class="lede">${pathName}. The guide is drawn to scale from the real parts, one connection per step, with a close-up of every pad.</p></div>` +
    `<div class="build">${ctx.steps.map((svg, i) => `<figure><b>${i + 1}</b>${svg}</figure>`).join("")}</div>` +
    (ctx.guideHref ? `<a class="btn" href="${esc(ctx.guideHref)}">Open the full guide</a>` : "") +
    `</div></section>` +
    // Files
    (ctx.downloads.length
      ? `<section id="files" style="padding-top:0"><div class="wrap"><div class="head"><h2>Everything you need.</h2><p class="lede">Open files, no account. Print it, order it, flash it.</p></div>` +
        `<div class="files">${ctx.downloads
          .map(
            (d) =>
              `<a href="${esc(d.href)}"><span class="k">${esc(d.kind)}</span><span><b>${esc(d.label)}</b><small>${esc(d.detail)}</small></span><span class="get">Download</span></a>`,
          )
          .join("")}</div></div></section>`
      : "") +
    // FAQ
    (s.faq.length
      ? `<section style="padding-top:0"><div class="wrap"><div class="head" style="grid-template-columns:1fr;text-align:center;justify-items:center"><h2>Questions, answered.</h2></div>` +
        `<div class="faq">${s.faq.map((q, i) => `<details${i === 0 ? " open" : ""}><summary>${esc(q.q)}</summary><p>${esc(q.a)}</p></details>`).join("")}</div></div></section>`
      : "") +
    // Close
    `<section style="padding-top:0"><div class="wrap"><div class="close"><div><h2 style="font-size:clamp(26px,3vw,36px)">Ready when you are.</h2>` +
    `<p>One download with the guide, the files and the firmware.</p></div><a class="btn" href="${esc(primaryHref)}">${primaryLabel}</a></div></div></section>` +
    `</main><footer class="end"><div class="wrap"><span>${esc(project.name)}${s.author ? ` by ${esc(s.author)}` : ""}${s.license ? ` &middot; ${esc(s.license)}` : ""}</span><span>Made with benchtop</span></div></footer>`;

  return (
    `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">` +
    `<title>${esc(project.name)} &middot; ${esc(project.tagline)}</title><meta name="description" content="${esc(s.subhead)}">` +
    `<meta name="theme-color" content="${m.bg}"><meta property="og:title" content="${esc(project.name)}"><meta property="og:description" content="${esc(s.subhead)}">` +
    `<link rel="preconnect" href="https://fonts.googleapis.com"><link rel="preconnect" href="https://fonts.gstatic.com" crossorigin>` +
    `<link rel="stylesheet" href="https://fonts.googleapis.com/css2?family=${font(s.theme.display)}:wght@500;600;800&family=${font(s.theme.text)}:wght@400;500;600&display=swap">` +
    (ctx.model ? `<script type="module" src="https://ajax.googleapis.com/ajax/libs/model-viewer/4.4.0/model-viewer.min.js"></script>` : "") +
    `<style>${css}</style></head><body>${body}` +
    (ctx.model
      ? // ?still=1 keeps the line drawing: screenshot tools without a GPU would otherwise capture an empty stage.
        `<script>if(!/[?&]still\\b/.test(location.search))document.querySelector("model-viewer")?.addEventListener("load",e=>e.target.closest(".stage").classList.add("live"))</script>`
      : "") +
    `</body></html>`
  );
}

function cap(x: string): string {
  return x.charAt(0).toUpperCase() + x.slice(1);
}
