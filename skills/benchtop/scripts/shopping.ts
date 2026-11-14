#!/usr/bin/env bun
// Shopping list: one page a person can buy from. For every part: a drawing of the
// exact variant, what a listing must match, and one-click searches at retailers for
// the buyer's region. Needs no API and no account; it only builds search links.
//
// Usage: bun shopping.ts <projectDir> [--region NO]
// Writes <projectDir>/out/shopping/index.html and prints the path.
// Region defaults to project.sourcing.region, else ALL (stores that ship anywhere).

import { mkdir } from "node:fs/promises";
import { join } from "node:path";
import { type Consumable, consumables } from "./lib/consumables";
import { strictGeometry, unresolvedGeometry } from "./lib/geometry-evidence";
import { esc } from "./lib/iso";
import { ESTIMATE_WORDS, formatTotals, listJoin, money, pricing, type ShippingSummary, shippingSummary } from "./lib/pricing";
import { type Loaded, ProjectError, SKILL_ROOT, loadProject, main } from "./lib/project";
import { partSvg } from "./lib/scenes";
import type { PartDef, PlacedPart } from "./lib/types";

interface Store {
  id: string;
  name: string;
  regions: string[];
  search: string;
  good: string;
  kinds: string[];
  /** "broken": the pattern is known not to work, so no button is offered. */
  checked: "ok" | "blocked" | "broken";
  /** "model": the shop matches every word in its own language, so search the model number only. */
  query?: "model";
  note?: string;
}

const EU = ["AT", "BE", "BG", "HR", "CY", "CZ", "DK", "EE", "FI", "FR", "DE", "GR", "HU", "IE", "IT", "LV", "LT", "LU", "MT", "NL", "PL", "PT", "RO", "SK", "SI", "ES", "SE"];

/** Stores worth showing for a region, local ones first, then the ones that ship anywhere. */
export function storesFor(stores: Store[], region: string, kind: string): Store[] {
  const r = region.toUpperCase();
  const local = stores.filter((s) => s.regions.includes(r));
  const bloc = EU.includes(r) ? stores.filter((s) => s.regions.includes("EU") && !local.includes(s)) : [];
  const anywhere = stores.filter((s) => s.regions.includes("ALL") && !local.includes(s));
  return [...local, ...bloc, ...anywhere].filter((s) => s.checked !== "broken" && s.kinds.includes(kind)).slice(0, 5);
}

/** A model number like BME280, INMP441 or ESP32-C3: letters then digits. */
const MODEL = /\b[A-Za-z]{2,}\d[A-Za-z0-9-]*/;

export function searchUrl(store: Store, term: string): string {
  // "INMP441 I2S microphone module" finds nothing at a shop whose titles are Norwegian
  // and whose search wants every word; "INMP441" finds the part.
  const q = store.query === "model" ? (term.match(MODEL)?.[0] ?? term) : term;
  return store.search.replace("{q}", () => encodeURIComponent(q));
}

/**
 * What a listing has to match for the guide and the case to be right, taken from the
 * part file: the things clones get wrong are size, pin order and supply voltage.
 */
export function mustMatch(def: PartDef, units?: number): string[] {
  const out: string[] = [];
  const unresolved = def.geometryEvidence?.status === "unresolved";
  if (unresolved) out.push("Physical size and pin layout unresolved — confirm the exact variant using its source pinout and drawing");
  if (def.electrical.perUnit) {
    // Sold by count or length: the part file's outline is a drawing sample, not a size to match.
    out.push(units ? `${units} ${def.electrical.perUnit.name}s` : `Count the ${def.electrical.perUnit.name}s you need`);
  } else if (!unresolved && def.kind !== "passive") out.push(`Board or body about ${def.body.w} x ${def.body.d} mm`);
  const names = def.pins.filter((p) => p.role !== "nc").map((p) => p.name);
  if (!unresolved && def.kind !== "board" && names.length >= 2 && names.length <= 8) out.push(`Pins in this order: ${names.join(", ")}`);
  if (!unresolved && def.kind === "board") out.push(`${def.pins.length} pins, ${def.footprint?.pitch ?? 2.54} mm apart`);
  const supply = def.pins.find((p) => p.role === "power-in" && p.minVolts !== undefined && p.maxVolts !== undefined);
  if (supply) out.push(`Runs from ${supply.minVolts} to ${supply.maxVolts} V`);
  if (!unresolved && def.holes?.length) out.push(`${def.holes.length} mounting holes`);
  // Height is what decides whether a button or knob reaches through a lid.
  if (!unresolved && def.ports?.some((p) => p.reach)) out.push(`About ${def.maxHeight} mm tall overall`);
  return out;
}

// Abbreviations whose full stop does not end a sentence.
const ABBREV = /(?:^|[\s(])(?:e\.g|i\.e|approx|vs|etc|incl|max|min|ca|no|nr|fig|dia)$/i;

/**
 * The first sentence of a note, whole. Ends at . ! or ? followed by a capital letter, a
 * digit or the end; a colon never ends it ("Variants: A, B" is one sentence), nor does
 * an abbreviation ("approx. 5 mm") or a decimal. Long ones are cut at a word.
 */
export function firstSentence(s: string, max = 170): string {
  const text = s.replace(/\s+/g, " ").trim();
  const end = /[.!?](?=\s|$)/g;
  let cut = text.length;
  for (let m = end.exec(text); m; m = end.exec(text)) {
    const before = text.slice(0, m.index);
    const next = text.slice(m.index + 1).trimStart()[0];
    if (m[0] === "." && (ABBREV.test(before))) continue;
    if (next !== undefined && /[a-z]/.test(next)) continue;
    cut = m.index + 1;
    break;
  }
  const one = text.slice(0, cut);
  if (one.length <= max) return one;
  const room = one.slice(0, max - 3);
  return `${room.slice(0, Math.max(room.lastIndexOf(" "), 1)).trimEnd()}...`;
}

/** Wire is bought as one kit, not one row per colour: fold the colour lines into one. */
export function foldWire(list: Consumable[]): Consumable[] {
  const wire = list.filter((c) => /wire,/i.test(c.name));
  if (wire.length < 2) return list;
  const kind = wire[0]!.name.split(",")[0]!;
  const folded: Consumable = {
    qty: wire.reduce((n, c) => n + c.qty, 0),
    name: `${kind}s`,
    value: wire.map((c) => `${c.qty} ${c.name.split(", ")[1]}`).join(", "),
    blurb: `${wire[0]!.value}. A small multi-colour kit covers it.`,
    search: wire[0]!.search,
    unitUsd: wire[0]!.unitUsd,
  };
  return [folded, ...list.filter((c) => !wire.includes(c))];
}

function partRow(group: { part: PlacedPart; refs: string[] }, stores: Store[], cost: ReturnType<typeof pricing>, region: string): string {
  const { def, use } = group.part;
  const term = def.sourcing.search[0] ?? def.name;
  const kind = def.kind === "passive" ? "passive" : "module";
  const links = storesFor(stores, region, kind)
    .map((s) => `<a class="store" href="${esc(searchUrl(s, term))}" target="_blank" rel="noopener" title="${esc(s.good)}">${esc(s.name)}</a>`)
    .join("");
  const pick = cost.shopOf(use.ref);
  const line = cost.priceOf(use.ref, group.refs.length > 1);
  const checks = mustMatch(def, use.units)
    .map((c) => `<li>${esc(c)}</li>`)
    .join("");
  const unresolved = def.geometryEvidence?.status === "unresolved";
  const art = unresolved
    ? `<div class="geometry-unknown" role="img" aria-label="Physical layout unresolved">Pin layout unresolved<br><small>Use the exact source pinout</small></div>`
    : partSvg(group.part).svg;
  // A legacy verify sentence may itself describe the superseded size or row order.
  const verify = unresolved ? def.geometryEvidence!.reason : def.verify && firstSentence(def.verify);
  if (cost.isOwned(use.ref)) {
    // Nothing to buy, but the part in the drawer still has to be the variant drawn.
    return (
      `<article class="item"><label class="tick"><input type="checkbox"><span></span></label>` +
      `<div class="art">${art}</div>` +
      `<div class="what"><h3><b>${group.refs.length}x</b> ${esc(use.label ?? def.name)}</h3>` +
      `<p class="name">${esc(def.name)}</p><ul class="match">${checks}</ul>` +
      (verify ? `<p class="verify">${esc(verify)}</p>` : "") +
      `</div><div class="buy"><span class="price">You have this</span>` +
      `<p class="pick">${unresolved ? "Confirm your exact variant against its source pinout; no physical drawing is asserted here." : "Check yours against the drawing and the list before you start."}</p></div></article>`
    );
  }
  return (
    `<article class="item"><label class="tick"><input type="checkbox"><span></span></label>` +
    `<div class="art">${art}</div>` +
    `<div class="what"><h3><b>${group.refs.length}x</b> ${esc(use.label ?? def.name)}${use.value ? ` <em>${esc(use.value)}</em>` : ""}</h3>` +
    `<p class="name">${esc(def.name)}</p><p class="blurb">${esc(def.blurb)}</p>` +
    `<ul class="match">${checks}</ul>` +
    (verify ? `<p class="verify">${esc(verify)}</p>` : "") +
    `</div>` +
    `<div class="buy"><span class="price">${esc(line)}</span>` +
    (pick
      ? `<p class="pick">Picked: <b>${esc(pick.store)}</b>${pick.note ? `<br>${esc(pick.note)}` : ""}</p>`
      : "") +
    `<code class="term">${esc(term)}</code><div class="stores">${links}</div></div></article>`
  );
}

const CSS = `
@import url("https://fonts.googleapis.com/css2?family=Noto+Sans:wght@400;600;800&display=swap");
*{box-sizing:border-box}body{margin:0;background:#f4f4f1;color:#111;font:15px/1.45 "Noto Sans","Helvetica Neue",Arial,sans-serif}
main{max-width:980px;margin:0 auto;padding:44px 22px 72px}
h1{font-size:clamp(40px,8vw,72px);font-weight:800;line-height:.92;letter-spacing:-.02em;margin:0}
.sub{display:flex;justify-content:space-between;align-items:baseline;gap:16px;flex-wrap:wrap;border-bottom:2px solid #111;padding:10px 0 14px;margin-bottom:8px}
.sub b{font-size:22px;font-weight:800}
.how{color:#555;max-width:62ch;margin:14px 0 22px}
h2{font-size:13px;letter-spacing:.08em;text-transform:uppercase;color:#666;margin:34px 0 10px;font-weight:600}
.item{display:grid;grid-template-columns:26px 150px 1fr 250px;gap:18px;align-items:start;background:#fff;border:1px solid #dedcd5;border-radius:16px;padding:18px;margin-bottom:10px}
.item.small{grid-template-columns:26px 1fr 250px}
.tick input{position:absolute;opacity:0}.tick span{display:block;width:22px;height:22px;border:2px solid #111;border-radius:6px;margin-top:2px;cursor:pointer}
.tick input:checked+span{background:#111 url("data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 22 22'%3E%3Cpath d='M5 11.5l4 4 8-9' fill='none' stroke='%23fff' stroke-width='2.6' stroke-linecap='round' stroke-linejoin='round'/%3E%3C/svg%3E") center/100% no-repeat}
.tick input:focus-visible+span{outline:2px solid #1f6fd6;outline-offset:2px}
.art{height:110px;display:grid;place-items:center}.art svg{max-width:150px;max-height:110px;width:auto;height:auto}
.geometry-unknown{border:1px dashed #777;padding:12px;text-align:center;font-size:13px}.geometry-unknown small{display:block;margin-top:6px;color:#555}
h3{margin:0;font-size:17px;font-weight:800}h3 b{font-weight:400;margin-right:4px}h3 em{font-style:normal;font-weight:600}
.name{margin:2px 0 6px;color:#666;font-size:13px}.blurb{margin:0 0 8px}
.match{margin:0;padding:0;list-style:none;font-size:13.5px}.match li{padding-left:18px;position:relative;margin:2px 0}
.match li::before{content:"";position:absolute;left:2px;top:.5em;width:8px;height:8px;border:2px solid #111;border-radius:50%}
.verify{margin:8px 0 0;font-size:12.5px;color:#666}
.buy{display:flex;flex-direction:column;gap:8px;align-items:flex-start}
.price{font-size:20px;font-weight:800}
.pick{margin:0;font-size:13px;background:#f4f4f1;border-radius:10px;padding:8px 10px;width:100%}
.term{font:12.5px ui-monospace,Menlo,monospace;background:#f4f4f1;border-radius:8px;padding:6px 8px;width:100%;user-select:all}
.stores{display:flex;flex-wrap:wrap;gap:6px}
.store{font-size:13px;text-decoration:none;color:#111;border:1px solid #111;border-radius:999px;padding:5px 11px}
.store:hover{background:#111;color:#fff}
.total{display:flex;justify-content:space-between;gap:16px;flex-wrap:wrap;border-top:2px solid #111;margin-top:26px;padding-top:14px}
.total b{font-size:22px;font-weight:800}.total span{color:#555;max-width:58ch}
footer{margin-top:28px;color:#777;font-size:12.5px}
@media(max-width:820px){.item,.item.small{grid-template-columns:26px 1fr}.art{grid-column:2;justify-items:start}.buy{grid-column:2}}
@media print{body{background:#fff}.item{break-inside:avoid;border-color:#999}.store{border-color:#999}}
`;

/**
 * What the page says about shipping. A shop whose shipping is unknown is named, every one
 * of them: the total must not read as if delivery were free.
 */
export function shippingSentence(s: ShippingSummary | undefined): string {
  if (!s || (s.known.length === 0 && s.unknownShops.length === 0)) return " Shipping is not included.";
  const unknown = s.unknownShops.length ? `shipping from ${listJoin(s.unknownShops)} is not known until checkout` : "";
  if (s.known.length === 0) return ` Shipping is not included: ${unknown}.`;
  const known = `Shipping ${formatTotals(s.known)} (${listJoin(s.pricedShops)})`;
  return unknown ? ` ${known}, but ${unknown}.` : ` ${known}.`;
}

export async function buildShopping(loaded: Loaded, region: string): Promise<string> {
  const { project } = loaded;
  const unresolved = unresolvedGeometry(loaded).length > 0;
  // Per part, an unresolved layout is never shown as something to match in a shop. The case's
  // screws are another matter: they are withheld only when strict mode withholds the case.
  const hardwareWithheld = unresolved && !!project.enclosure && strictGeometry();
  const stores = ((await Bun.file(join(SKILL_ROOT, "assets", "stores.json")).json()) as { stores: Store[] }).stores;
  const cost = pricing(loaded);
  const groups = new Map<string, { part: PlacedPart; refs: string[] }>();
  for (const p of loaded.placed) {
    // Owned and to-buy copies of the same part are separate rows: one is a purchase.
    const key = `${p.def.id}|${p.use.value ?? ""}|${p.use.owned ? "owned" : "buy"}`;
    if (!groups.has(key)) groups.set(key, { part: p, refs: [] });
    groups.get(key)!.refs.push(p.use.ref);
  }
  const toBuy = [...groups.values()].filter((g) => !g.part.use.owned);
  const have = [...groups.values()].filter((g) => g.part.use.owned);
  const extras = foldWire(await consumables(loaded));
  const extraRows = extras
    .map((c) => {
      const kind = /screw/i.test(c.name) ? "hardware" : "consumable";
      const links = storesFor(stores, region, kind)
        .map((s) => `<a class="store" href="${esc(searchUrl(s, c.search))}" target="_blank" rel="noopener">${esc(s.name)}</a>`)
        .join("");
      return (
        `<article class="item small"><label class="tick"><input type="checkbox"><span></span></label>` +
        `<div class="what"><h3><b>${c.qty}x</b> ${esc(c.name)}${c.value ? ` <em>${esc(c.value)}</em>` : ""}</h3><p class="blurb">${esc(c.blurb)}</p></div>` +
        `<div class="buy"><code class="term">${esc(c.search)}</code><div class="stores">${links}</div></div></article>`
      );
    })
    .join("");
  const extrasUsd = extras.reduce((s, c) => s + c.unitUsd * c.qty, 0);
  const shipLine = shippingSentence(cost.sourced ? shippingSummary(loaded) : undefined);
  return (
    `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">` +
    `<title>${esc(project.name)} shopping list</title><style>${CSS}</style></head><body><main>` +
    `<h1>${esc(project.name.toUpperCase())}</h1>` +
    `<div class="sub"><span>Shopping list${region !== "ALL" ? `, ${esc(region)}` : ""}</span><b>${esc(cost.total)}</b></div>` +
    `<p class="how">Each button opens that shop's search for the part. ${unresolved ? "Some physical layouts are unresolved and have placeholders. Confirm their exact variants against source pinouts and dimensional drawings; no legacy size or pin order is a purchase criterion." : "Before you buy, compare the listing's photo with the drawing and tick off what must match: sellers use the same name for boards with different sizes and pin orders."} Nothing here is a purchase link, and a price that says estimated comes from typical prices, not from a shop.</p>` +
    (hardwareWithheld ? `<p class="verify"><b>Enclosure hardware withheld:</b> screw sizes and quantities need resolved physical geometry. Those costs are not included.</p>` : "") +
    (toBuy.length ? `<h2>Parts to buy</h2>${toBuy.map((g) => partRow(g, stores, cost, region)).join("")}` : "") +
    (have.length ? `<h2>Already on your bench</h2>${have.map((g) => partRow(g, stores, cost, region)).join("")}` : "") +
    (extraRows ? `<h2>Also needed</h2>${extraRows}` : "") +
    `<div class="total"><b>${esc(cost.total)} for the parts</b>` +
    `<span>${hardwareWithheld ? "General wiring consumables" : "Wire, solder and screws"} add about ${money(extrasUsd)}, ${ESTIMATE_WORDS}, if you have none.${shipLine}` +
    `${cost.sourced && project.sourcing ? ` Prices checked ${esc(project.sourcing.checkedAt)}.` : ""}</span></div>` +
    `<footer>Generated from project.json. Search links only: nothing is ordered for you.</footer>` +
    `</main></body></html>`
  );
}

if (import.meta.main) {
  await main(async () => {
    const args = process.argv.slice(2);
    const dir = args.find((a, i) => !a.startsWith("--") && args[i - 1] !== "--region");
    if (!dir) throw new ProjectError("usage: bun shopping.ts <projectDir> [--region NO]");
    const loaded = await loadProject(dir);
    const flag = args.indexOf("--region");
    const region = (flag >= 0 ? args[flag + 1] : loaded.project.sourcing?.region) ?? "ALL";
    const out = join(loaded.dir, "out", "shopping");
    await mkdir(out, { recursive: true });
    await Bun.write(join(out, "index.html"), await buildShopping(loaded, region));
    console.log(join(out, "index.html"));
  });
}
