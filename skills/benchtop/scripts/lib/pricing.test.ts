import { expect, test } from "bun:test";
import { formatTotals, listJoin, money, pricing, shippingSummary, sumByCurrency } from "./pricing";
import { resolveProject } from "./project";
import type { PartDef, Project } from "./types";

const def = (id: string, priceUsd: number): PartDef => ({
  id,
  name: id,
  kind: id === "board" ? "board" : "sensor",
  blurb: "a part for the pricing tests",
  body: { w: 10, d: 10, h: 1 },
  maxHeight: 2,
  pins: [
    { name: "GND", role: "gnd", x: 1, y: 1 },
    { name: "IO", role: "io", x: 1, y: 3, gpio: 1 },
  ],
  electrical: { logicVolts: 3.3 },
  sourcing: { search: [id], priceUsd },
  sources: ["test"],
  confidence: "typical",
});

const defs = new Map([
  ["board", def("board", 3)],
  ["sensor", def("sensor", 4)],
  ["resistor", def("resistor", 0.1)],
]);

const project = (over: Partial<Project>): Project => ({
  schema: 1,
  slug: "t",
  name: "T",
  tagline: "",
  summary: "",
  build: { path: "wire", joint: "solder", difficulty: 1, minutes: 10 },
  power: { source: "usb", volts: 5, budgetMa: 500 },
  parts: [
    { ref: "mcu", part: "board" },
    { ref: "s1", part: "sensor" },
    { ref: "r1", part: "resistor" },
    { ref: "r2", part: "resistor" },
  ],
  connections: [],
  ...over,
});

test("without sourcing the total is the sum of the part estimates, in USD", () => {
  const cost = pricing(resolveProject(project({}), defs));
  expect(cost.sourced).toBe(false);
  // Every place that prints the total carries the caveat, in words.
  expect(cost.total).toBe("about 7.20 USD, estimated from typical prices, not sourced");
  expect(cost.figure).toBe("7.20 USD");
  expect(cost.priceOf("s1")).toBe("about 4 USD, estimated");
  expect(cost.priceOf("r1", true)).toBe("about 0.10 USD each, estimated");
});

test("an owned part costs nothing, needs no sourcing line, and is reported as owned", () => {
  const p = project({});
  p.parts[0]!.owned = true;
  const cost = pricing(resolveProject(p, defs));
  expect(cost.isOwned("mcu")).toBe(true);
  expect(cost.priceOf("mcu")).toBe("owned");
  expect(cost.total).toBe("about 4.20 USD, estimated from typical prices, not sourced");
});

test("sourcing is complete when every part still to buy has a line or is covered by a pack", () => {
  const p = project({
    sourcing: {
      region: "NO",
      currency: "NOK",
      checkedAt: "2026-11-13",
      lines: [
        { ref: "s1", store: "A", url: "https://a.example/s", price: 149 },
        { ref: "r1", store: "B", url: "https://b.example/r", price: 25, note: "pack of 100", covers: ["r2"] },
      ],
    },
  });
  p.parts[0]!.owned = true;
  const cost = pricing(resolveProject(p, defs));
  expect(cost.sourced).toBe(true);
  // The pack is counted once, the owned board not at all.
  expect(cost.total).toBe("174 NOK");
  expect(cost.priceOf("r2")).toBe("with r1");
  expect(cost.shopOf("r2")?.store).toBe("B");
  expect(cost.shopOf("mcu")).toBeUndefined();
});

test("a part to buy with neither a line nor a pack keeps the page on estimates, never a mix", () => {
  const p = project({
    sourcing: { region: "NO", currency: "NOK", checkedAt: "2026-11-13", lines: [{ ref: "s1", store: "A", url: "u", price: 149 }] },
  });
  const cost = pricing(resolveProject(p, defs));
  expect(cost.sourced).toBe(false);
  expect(cost.total).toContain("USD");
  expect(cost.total).not.toContain("NOK");
  expect(cost.priceOf("s1")).toBe("about 4 USD, estimated");
});

test("an estimate of 10 or more is rounded to whole units", () => {
  const big = new Map([["board", def("board", 23.6)]]);
  const p = project({ parts: [{ ref: "mcu", part: "board" }] });
  expect(pricing(resolveProject(p, big)).total).toBe("about 24 USD, estimated from typical prices, not sourced");
});

const mixed = (): Project =>
  project({
    sourcing: {
      region: "NO",
      currency: "NOK",
      checkedAt: "2026-11-13",
      lines: [
        { ref: "mcu", store: "Elkim", url: "u1", price: 249 },
        { ref: "s1", store: "Electrokit", url: "u2", price: 1.35, currency: "SEK" },
        { ref: "r1", store: "Adafruit", url: "u3", price: 12.5, currency: "USD", covers: ["r2"] },
      ],
    },
  });

test("lines in different currencies give one total per currency, never one converted figure", () => {
  const cost = pricing(resolveProject(mixed(), defs));
  expect(cost.sourced).toBe(true);
  expect(cost.total).toBe("249 NOK + 1.35 SEK + 12.50 USD");
  expect(cost.totals).toHaveLength(3);
  expect(cost.priceOf("s1")).toBe("1.35 SEK");
  expect(cost.priceOf("r1", true)).toBe("12.50 USD each");
});

test("a line without a currency takes the project's, and one currency gives one figure", () => {
  const p = mixed();
  p.sourcing!.lines = p.sourcing!.lines.map((l) => ({ ...l, currency: undefined }));
  expect(pricing(resolveProject(p, defs)).total).toBe("263 NOK"); // 262.85, shown whole from 100 up
});

test("sums, formats and lists", () => {
  expect(sumByCurrency([{ amount: 0.1, currency: "USD" }, { amount: 0.2, currency: "USD" }, { amount: 5, currency: "NOK" }])).toEqual([
    { amount: 0.3, currency: "USD" },
    { amount: 5, currency: "NOK" },
  ]);
  expect(formatTotals([{ amount: 515, currency: "NOK" }, { amount: 12.5, currency: "USD" }])).toBe("515 NOK + 12.50 USD");
  expect(money(3)).toBe("3 USD");
  expect(listJoin(["A", "B", "C"])).toBe("A, B and C");
  expect(listJoin(["A", "B"])).toBe("A and B");
  expect(listJoin(["A"])).toBe("A");
});

test("shipping names every shop that is unknown, including a shop with no entry at all", () => {
  const p = mixed();
  p.sourcing!.shipping = [{ store: "Elkim", price: 69 }, { store: "Electrokit", note: "shown at checkout" }];
  const s = shippingSummary(resolveProject(p, defs))!;
  expect(s.known).toEqual([{ amount: 69, currency: "NOK" }]);
  expect(s.pricedShops).toEqual(["Elkim"]);
  // Electrokit has an entry without a price; Adafruit has no entry.
  expect(s.unknownShops).toEqual(["Electrokit", "Adafruit"]);
});

test("shipping in another currency is a separate figure", () => {
  const p = mixed();
  p.sourcing!.shipping = [{ store: "Elkim", price: 69 }, { store: "Adafruit", price: 9, currency: "USD" }, { store: "Electrokit", price: 35, currency: "SEK" }];
  const s = shippingSummary(resolveProject(p, defs))!;
  expect(formatTotals(s.known)).toBe("69 NOK + 9 USD + 35 SEK");
  expect(s.unknownShops).toEqual([]);
});
