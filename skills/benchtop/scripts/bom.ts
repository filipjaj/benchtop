// Usage: bun bom.ts <projectDir>
// Writes <projectDir>/out/bom.csv and <projectDir>/out/bom.md and prints the estimated total.

import { consumables as listConsumables } from "./lib/consumables";
import { strictGeometry, unresolvedGeometry } from "./lib/geometry-evidence";
import { ESTIMATE_WORDS, formatTotals, listJoin, type Money, shippingSummary, sumByCurrency } from "./lib/pricing";
import { mkdir } from "node:fs/promises";
import { join } from "node:path";
import { loadProject, main, ProjectError } from "./lib/project";


interface Row {
  refs: string;
  qty: number;
  part: string;
  value: string;
  blurb: string;
  search: string;
  unitUsd: number;
  totalUsd: number;
  store?: string;
  url?: string;
  note?: string;
  actualUnit?: number;
  actualTotal?: number;
  actualCurrency?: string;
}

const money = (n: number): string => n.toFixed(2);
const csvCell = (s: string | number): string => {
  const t = String(s);
  return /[",\n]/.test(t) ? `"${t.replace(/"/g, '""')}"` : t;
};
const mdCell = (s: string | number): string => String(s).replace(/\|/g, "\\|").replace(/\n/g, " ");

await main(async () => {
  const dir = process.argv.slice(2).find((a) => !a.startsWith("--"));
  if (!dir) throw new ProjectError("usage: bun bom.ts <projectDir>");
  const loaded = await loadProject(dir);
  const { project } = loaded;
  // Only in strict mode: by default the case is generated (with a warning), so its screws are real.
  const hardwareWithheld = strictGeometry() && !!project.enclosure && unresolvedGeometry(loaded).length > 0;
  const hardwareNote = "Enclosure hardware withheld: screw sizes and quantities need resolved physical geometry. These items and their costs are not included; electronic parts and general wiring consumables remain listed.";
  const sourcing = project.sourcing;
  const lineByRef = new Map((sourcing?.lines ?? []).map((l) => [l.ref, l]));

  // Parts: identical part id + value collapse into one line.
  const groups = new Map<string, { refs: string[]; placed: (typeof loaded.placed)[number] }>();
  for (const p of loaded.placed) {
    // A line can name its own currency, and one row never mixes two.
    const cur = lineByRef.get(p.use.ref)?.currency ?? sourcing?.currency ?? "";
    const k = `${p.def.id}\u0000${p.use.value ?? ""}\u0000${p.use.units ?? ""}\u0000${p.use.owned ? "owned" : ""}\u0000${cur}`;
    const g = groups.get(k);
    if (g) g.refs.push(p.use.ref);
    else groups.set(k, { refs: [p.use.ref], placed: p });
  }
  const parts: Row[] = [];
  for (const { refs, placed } of groups.values()) {
    // Parts the user already has stay on the list, at no cost, so the list is still the whole build.
    const owned = refs.every((r) => loaded.byRef.get(r)?.use.owned);
    const unit = owned ? 0 : placed.def.sourcing.priceUsd;
    const row: Row = {
      refs: refs.join(" "),
      qty: refs.length,
      part: placed.def.name,
      value: valueText(placed),
      blurb: owned ? `Already owned. ${placed.def.blurb}` : placed.def.blurb,
      search: placed.def.sourcing.search[0] ?? "",
      unitUsd: unit,
      totalUsd: unit * refs.length,
    };
    // A pack bought for another part can cover this one: it is then counted there, once.
    const packFor = (r: string) => (sourcing?.lines ?? []).find((l) => l.covers?.includes(r));
    const lines = refs.map((r) => lineByRef.get(r)).filter((l): l is NonNullable<typeof l> => l !== undefined);
    const first = lines[0];
    if (first) {
      row.store = uniqueJoin(lines.map((l) => l.store));
      row.url = uniqueJoin(lines.map((l) => l.url));
      row.note = uniqueJoin(lines.flatMap((l) => (l.note ? [l.note] : [])));
      row.actualUnit = first.price;
      row.actualCurrency = first.currency ?? sourcing!.currency;
      row.actualTotal = refs.reduce((s, r) => s + (lineByRef.get(r)?.price ?? (packFor(r) ? 0 : first.price)), 0);
    } else if (owned) {
      row.store = "owned";
      row.url = "";
      row.note = "Already owned: check it against the guide's inventory page.";
      row.actualUnit = 0;
      row.actualTotal = 0;
    } else if (sourcing && refs.every((r) => packFor(r))) {
      const pack = packFor(refs[0]!)!;
      row.store = pack.store;
      row.url = pack.url;
      row.note = `In the pack bought for ${pack.ref}.`;
      row.actualUnit = 0;
      row.actualTotal = 0;
    }
    parts.push(row);
  }

  // Shipping, one row per shop, in the shop's own currency. Not part of the USD estimate.
  const shipping: Row[] = (sourcing?.shipping ?? []).map((s) => ({
    refs: "shipping",
    qty: 1,
    part: `Shipping: ${s.store}`,
    value: "",
    blurb: s.price === undefined ? "Delivery charge from this shop: not known until checkout." : "Delivery charge from this shop.",
    search: "",
    unitUsd: 0,
    totalUsd: 0,
    store: s.store,
    url: "",
    note: s.note ?? "",
    actualUnit: s.price,
    actualTotal: s.price,
    actualCurrency: s.price === undefined ? undefined : (s.currency ?? sourcing!.currency),
  }));

  // Wire, solder, heat-shrink and case screws: one shared list (lib/consumables.ts),
  // so the BOM and the shopping page always ask for the same things.
  const { path, joint } = project.build;
  const consumables: Row[] = (await listConsumables(loaded)).map((c) => ({
    refs: "",
    qty: c.qty,
    part: c.name,
    value: c.value,
    blurb: c.blurb,
    search: c.search,
    unitUsd: c.unitUsd,
    totalUsd: c.unitUsd * c.qty,
  }));

  const partsUsd = parts.reduce((s, r) => s + r.totalUsd, 0);
  const consUsd = consumables.reduce((s, r) => s + r.totalUsd, 0);
  const totalUsd = partsUsd + consUsd;
  const sourced = parts.filter((r) => r.actualTotal !== undefined);
  // Per currency, never converted: "515 NOK + 12.50 USD".
  const moneyOf = (rows: Row[]): Money[] =>
    sumByCurrency(rows.flatMap((r) => (r.actualTotal !== undefined && r.actualCurrency ? [{ amount: r.actualTotal, currency: r.actualCurrency }] : [])));
  const partsActual = moneyOf(sourced);
  const ship = shippingSummary(loaded);
  const sourcedTotals = sumByCurrency([...partsActual, ...(ship?.known ?? [])]);
  const unknownShops = ship?.unknownShops ?? [];
  const knownShipping = (ship?.known.length ?? 0) > 0;
  const sourcedLine = `Sourced total: ${formatTotals(sourcedTotals)}${
    knownShipping ? ` including ${formatTotals(ship!.known)} shipping` : ""
  }${
    unknownShops.length ? `, ${knownShipping ? "plus" : "excluding"} shipping from ${listJoin(unknownShops)} (shown at checkout)` : ""
  }${
    !knownShipping && !unknownShops.length ? ", shipping not included" : ""
  }${
    sourced.length < parts.length ? ` (${sourced.length} of ${parts.length} part lines sourced)` : ""
  }`;
  const currencies = sourcedTotals.map((t) => t.currency);

  const header = ["refs", "qty", "part", "value", "what it does", "search term", "estimated unit price USD", "line total USD"];
  if (sourcing) header.push("store", "url", "note", "actual price", "actual line total", "currency");
  const cells = (r: Row): (string | number)[] => {
    const base: (string | number)[] = [r.refs, r.qty, r.part, r.value, r.blurb, r.search, money(r.unitUsd), money(r.totalUsd)];
    if (sourcing) {
      base.push(r.store ?? "", r.url ?? "", r.note ?? "", r.actualUnit !== undefined ? money(r.actualUnit) : "", r.actualTotal !== undefined ? money(r.actualTotal) : "", r.actualCurrency ?? "");
    }
    return base;
  };
  const blank = (label: string, usd: number, actual?: Money): (string | number)[] => {
    const row: (string | number)[] = [label, "", "", "", "", "", "", money(usd)];
    if (sourcing) row.push("", "", "", "", actual ? money(actual.amount) : "", actual?.currency ?? "");
    return row;
  };
  // One row per currency: amounts in different currencies are never added together.
  const perCurrency = (label: string, usd: number, totals: Money[]): (string | number)[][] =>
    totals.length > 0 ? totals.map((t, i) => blank(label, i === 0 ? usd : 0, t)) : [blank(label, usd)];

  const csvRows: (string | number)[][] = [
    header,
    ...parts.map(cells),
    ...shipping.map(cells),
    ...consumables.map(cells),
    ...perCurrency("TOTAL parts", partsUsd, partsActual),
    blank("TOTAL consumables", consUsd),
    blank("TOTAL estimated", totalUsd),
    ...(sourcing && sourced.length > 0 ? perCurrency("TOTAL sourced incl. shipping", 0, sourcedTotals) : []),
  ];
  if (hardwareWithheld) {
    const note: (string | number)[] = Array(header.length).fill("");
    note[0] = "NOTE";
    note[4] = hardwareNote;
    csvRows.push(note);
  }

  const out = join(loaded.dir, "out");
  await mkdir(out, { recursive: true });
  await Bun.write(join(out, "bom.csv"), csvRows.map((r) => r.map(csvCell).join(",")).join("\n") + "\n");

  const table = (rows: Row[]): string => {
    const h = ["Refs", "Qty", "Part", "Value", "What it does", "Search term", "Est. unit USD", "Line USD"];
    if (sourcing) h.push("Store", "Link", "Note", "Actual", "Actual line", "Currency");
    const body = rows.map((r) => {
      const c = cells(r).map(mdCell);
      if (sourcing && r.url) c[9] = r.url.split("; ").map((u) => `[link](${u})`).join(" ");
      return `| ${c.join(" | ")} |`;
    });
    return [`| ${h.join(" | ")} |`, `| ${h.map(() => "---").join(" | ")} |`, ...body].join("\n");
  };
  const md = [
    `# Bill of materials: ${project.name}`,
    "",
    `Build path: ${path}${joint ? `, ${joint} joints` : ""}. ${
      sourcing && sourced.length > 0
        ? `The USD columns are rough estimates for budgeting; the actual columns are prices found on ${sourcing.checkedAt}, in ${listJoin(currencies)} as each shop shows them and never converted, for the listing named (a multi-pack is priced as the pack).`
        : `Prices are rough single-unit street prices in USD, ${ESTIMATE_WORDS}.`
    }`,
    "",
    ...(hardwareWithheld ? [`**Partial mechanical BOM.** ${hardwareNote}`, ""] : []),
    "## Parts",
    "",
    table([...parts, ...shipping]),
    "",
    ...(consumables.length > 0 ? ["## Consumables", "", table(consumables), ""] : []),
    "## Totals",
    "",
    `- Parts: about ${money(partsUsd)} USD`,
    `- Consumables: about ${money(consUsd)} USD`,
    `- Estimated total: about ${money(totalUsd)} USD, ${ESTIMATE_WORDS}`,
    ...(sourcing && sourced.length > 0
      ? [`- ${sourcedLine} (checked ${sourcing.checkedAt})`]
      : []),
    "",
  ].join("\n");
  await Bun.write(join(out, "bom.md"), md);

  console.log(`Wrote ${join(out, "bom.csv")} and ${join(out, "bom.md")}`);
  console.log(`Estimated total: about ${money(totalUsd)} USD, ${ESTIMATE_WORDS}`);
  if (sourcing && sourced.length > 0) console.log(sourcedLine);
  if (hardwareWithheld) console.log(hardwareNote);
});

function uniqueJoin(xs: string[]): string {
  return [...new Set(xs)].join("; ");
}

function valueText(p: { use: { value?: string; units?: number }; def: { electrical: { perUnit?: { name: string } } } }): string {
  const unit = p.def.electrical.perUnit;
  const count = unit && p.use.units !== undefined ? `${p.use.units} ${unit.name}${p.use.units === 1 ? "" : "s"}` : "";
  return [p.use.value ?? "", count].filter(Boolean).join(", ");
}
