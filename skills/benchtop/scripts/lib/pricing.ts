// What the parts cost, for the concept sheet, the shopping page and the landing page.
//
// Real prices once the sourcing step has a line for every part that has to be bought,
// else the part files' rough USD estimates. Never a mix. Money in different currencies
// is never added together and no exchange rate is ever assumed: a build that buys from a
// NOK shop and a USD shop shows "515 NOK + 12.50 USD", and a single figure only when every
// line shares one currency. Parts the user already owns cost nothing and need no line.
// One listing can cover several parts (a pack of resistors): the line is counted once.

import type { Loaded } from "./project";

export interface Money {
  amount: number;
  currency: string;
}

/** "3 USD", "0.10 USD", "59 NOK": short enough for a chip, never a bare symbol that hides the currency. */
export function money(n: number, currency = "USD"): string {
  const num = n >= 100 ? n.toFixed(0) : n.toFixed(n % 1 ? 2 : 0);
  return `${num} ${currency}`;
}

/** Sum per currency, in the order each currency first appears. Different currencies are never combined. */
export function sumByCurrency(items: Money[]): Money[] {
  const sums = new Map<string, number>();
  for (const { amount, currency } of items) sums.set(currency, (sums.get(currency) ?? 0) + amount);
  // Rounded so 0.1 + 0.2 does not print as 0.30000000000000004.
  return [...sums].map(([currency, amount]) => ({ currency, amount: Math.round(amount * 100) / 100 }));
}

/** "515 NOK + 12.50 USD". One entry gives a plain figure. */
export function formatTotals(totals: Money[]): string {
  if (totals.length === 0) return money(0);
  return totals.map((t) => money(t.amount, t.currency)).join(" + ");
}

/** "A", "A and B", "A, B and C". */
export function listJoin(names: string[]): string {
  if (names.length <= 1) return names.join("");
  return `${names.slice(0, -1).join(", ")} and ${names[names.length - 1]}`;
}

/** Said wherever a price comes from the part files instead of from a shop. */
export const ESTIMATE_WORDS = "estimated from typical prices, not sourced";

export interface Pricing {
  /**
   * What is left to buy, parts only, formatted. For estimates it says so in words
   * ("about 24 USD, estimated from typical prices, not sourced"), so every page that
   * prints it carries the caveat without having to remember it.
   */
  total: string;
  /** The same figure without the estimate wording, e.g. "515 NOK + 12.50 USD". */
  figure: string;
  /** The total per currency. One entry unless the sourced lines mix currencies. */
  totals: Money[];
  /** True when the figures are prices the agent looked up, false for estimates. */
  sourced: boolean;
  /** A price, "owned", or "with <ref>" when another part's pack covers this one. */
  priceOf: (ref: string, each?: boolean) => string;
  /** The shop a sourced part comes from, and the variant note for it. */
  shopOf: (ref: string) => { store: string; note?: string } | undefined;
  isOwned: (ref: string) => boolean;
}

export function pricing(loaded: Loaded): Pricing {
  const src = loaded.project.sourcing;
  const isOwned = (ref: string): boolean => !!loaded.byRef.get(ref)?.use.owned;
  const line = (ref: string) => src?.lines.find((l) => l.ref === ref);
  const pack = (ref: string) => src?.lines.find((l) => l.covers?.includes(ref));
  const toBuy = loaded.placed.filter((p) => !p.use.owned);
  const sourced = !!src && toBuy.length > 0 && toBuy.every((p) => line(p.use.ref) || pack(p.use.ref));
  const bought = (src?.lines ?? []).filter((l) => !isOwned(l.ref));
  const totals = sourced
    ? sumByCurrency(bought.map((l) => ({ amount: l.price, currency: l.currency ?? src!.currency })))
    : sumByCurrency(toBuy.map((p) => ({ amount: p.def.sourcing.priceUsd, currency: "USD" })));
  const figure = formatTotals(totals);
  const estimate = (n: number): string => (n >= 10 ? money(Math.round(n)) : money(n));
  return {
    sourced,
    isOwned,
    totals,
    figure,
    total: sourced ? figure : `about ${totals.length ? estimate(totals[0]!.amount) : money(0)}, ${ESTIMATE_WORDS}`,
    priceOf: (ref, each = false) => {
      if (isOwned(ref)) return "owned";
      const suffix = each ? " each" : "";
      const l = line(ref);
      if (sourced && l) return `${money(l.price, l.currency ?? src!.currency)}${suffix}`;
      const p = pack(ref);
      if (sourced && p) return `with ${p.ref}`;
      return `about ${money(loaded.byRef.get(ref)!.def.sourcing.priceUsd)}${suffix}, estimated`;
    },
    shopOf: (ref) => {
      if (!sourced || isOwned(ref)) return undefined;
      const l = line(ref) ?? pack(ref);
      return l ? { store: l.store, note: l.note } : undefined;
    },
  };
}

export interface ShippingSummary {
  /** Shipping that has a price, per currency. */
  known: Money[];
  /** Shops whose shipping is priced. */
  pricedShops: string[];
  /** Every shop used in the build whose shipping is not known: a null price or no entry at all. */
  unknownShops: string[];
}

/**
 * Shipping across every shop the build buys from. A shop with no price, or no entry at
 * all, is listed by name: assuming zero would make the total lie.
 */
export function shippingSummary(loaded: Loaded): ShippingSummary | undefined {
  const src = loaded.project.sourcing;
  if (!src) return undefined;
  const entries = src.shipping ?? [];
  const used = [...new Set(src.lines.filter((l) => !loaded.byRef.get(l.ref)?.use.owned).map((l) => l.store))];
  const priced = entries.filter((e) => e.price !== undefined);
  const pricedShops = [...new Set(priced.map((e) => e.store))];
  const unknownShops = [...new Set([...used, ...entries.map((e) => e.store)])].filter((s) => !pricedShops.includes(s));
  return {
    known: sumByCurrency(priced.map((e) => ({ amount: e.price!, currency: e.currency ?? src.currency }))),
    pricedShops,
    unknownShops,
  };
}
