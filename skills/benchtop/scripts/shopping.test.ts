import { expect, test } from "bun:test";
import { firstSentence, foldWire, mustMatch, searchUrl, shippingSentence, storesFor } from "./shopping";
import type { PartDef } from "./lib/types";

const stores = [
  { id: "local", name: "Local", regions: ["NO"], search: "https://local.example/?s={q}", good: "", kinds: ["module", "hardware"], checked: "ok" as const },
  { id: "eu", name: "Bloc", regions: ["EU"], search: "https://eu.example/s?q={q}", good: "", kinds: ["module"], checked: "ok" as const },
  { id: "any", name: "Anywhere", regions: ["ALL"], search: "https://any.example/w?t={q}", good: "", kinds: ["module"], checked: "ok" as const },
  { id: "us", name: "Far", regions: ["US"], search: "https://us.example/?q={q}", good: "", kinds: ["module"], checked: "ok" as const },
];

test("stores are local first, then the bloc, then ship-anywhere, and never another region's", () => {
  expect(storesFor(stores, "NO", "module").map((s) => s.id)).toEqual(["local", "any"]);
  expect(storesFor(stores, "SE", "module").map((s) => s.id)).toEqual(["eu", "any"]);
  expect(storesFor(stores, "ALL", "module").map((s) => s.id)).toEqual(["any"]);
});

test("stores are filtered by what they sell", () => {
  expect(storesFor(stores, "NO", "hardware").map((s) => s.id)).toEqual(["local"]);
});

test("search terms are URL-encoded into the store's pattern", () => {
  expect(searchUrl(stores[0]!, "0.96 inch OLED & I2C")).toBe("https://local.example/?s=0.96%20inch%20OLED%20%26%20I2C");
});

const part = (over: Partial<PartDef>): PartDef => ({
  id: "x",
  name: "X",
  kind: "sensor",
  blurb: "",
  body: { w: 15, d: 11.5, h: 1.6 },
  maxHeight: 3,
  pins: [
    { name: "VCC", role: "power-in", x: 1, y: 1, minVolts: 1.8, maxVolts: 3.6 },
    { name: "GND", role: "gnd", x: 1, y: 2 },
    { name: "SCL", role: "io", x: 1, y: 3 },
    { name: "SDA", role: "io", x: 1, y: 4 },
  ],
  electrical: {},
  sourcing: { search: ["x"], priceUsd: 1 },
  sources: ["s"],
  confidence: "typical",
  ...over,
});

test("a listing must match size, pin order and supply range", () => {
  const m = mustMatch(part({}));
  expect(m).toContain("Board or body about 15 x 11.5 mm");
  expect(m).toContain("Pins in this order: VCC, GND, SCL, SDA");
  expect(m).toContain("Runs from 1.8 to 3.6 V");
});

test("a part that must reach through a lid also states its height", () => {
  const m = mustMatch(part({ kind: "input", maxHeight: 9.5, ports: [{ name: "cap", faces: "up", x: 3, y: 3, w: 3.5, h: 3.5, reach: true }] }));
  expect(m).toContain("About 9.5 mm tall overall");
});

test("wire colours fold into one row with every colour counted", () => {
  const c = (name: string, qty: number) => ({ qty, name, value: "120 mm each", blurb: "", search: "kit", unitUsd: 0.07 });
  const out = foldWire([c("Hook-up wire, black", 3), c("Hook-up wire, red", 2), { qty: 1, name: "Solder", value: "", blurb: "", search: "solder", unitUsd: 4 }]);
  expect(out).toHaveLength(2);
  expect(out[0]!.qty).toBe(5);
  expect(out[0]!.value).toBe("3 black, 2 red");
  expect(out[1]!.name).toBe("Solder");
});

test("a note is cut at the end of a sentence, never at a colon", () => {
  expect(firstSentence("Variants: this file is the 4-pin module. Measure yours.")).toBe("Variants: this file is the 4-pin module.");
  expect(firstSentence("Check where the data comes from a source: the seller's photo, not the title. Then measure.")).toBe(
    "Check where the data comes from a source: the seller's photo, not the title.",
  );
});

test("abbreviations, decimals and lower-case continuations do not end a sentence", () => {
  expect(firstSentence("Hole pitch approx. 2.54 mm, e.g. 0.1 inch. Measure it.")).toBe("Hole pitch approx. 2.54 mm, e.g. 0.1 inch.");
  expect(firstSentence("Is it 27 mm? Measure.")).toBe("Is it 27 mm?");
  expect(firstSentence("No full stop at all")).toBe("No full stop at all");
});

test("a long first sentence is cut at a word with an ellipsis", () => {
  const out = firstSentence(`${"word ".repeat(60)}end.`, 50);
  expect(out.length).toBeLessThanOrEqual(50);
  expect(out.endsWith("...")).toBe(true);
  expect(out).not.toMatch(/wor\.\.\.$/);
});

test("a shop marked broken is never offered", () => {
  const withBroken = [...stores, { id: "bad", name: "Bad", regions: ["NO"], search: "https://bad.example/?q={q}", good: "", kinds: ["module"], checked: "broken" as const }];
  expect(storesFor(withBroken, "NO", "module").map((s) => s.id)).toEqual(["local", "any"]);
});

test("a shop that wants every word in its own language is searched by model number only", () => {
  const shop = { ...stores[0]!, query: "model" as const };
  expect(searchUrl(shop, "INMP441 I2S MEMS microphone module")).toBe("https://local.example/?s=INMP441");
  expect(searchUrl(shop, "ESP32-C3 SuperMini board")).toBe("https://local.example/?s=ESP32-C3");
  // No model number in the term: the whole term is used.
  expect(searchUrl(shop, "momentary push button")).toBe("https://local.example/?s=momentary%20push%20button");
  // Other shops always get the whole term.
  expect(searchUrl(stores[1]!, "INMP441 I2S microphone")).toBe("https://eu.example/s?q=INMP441%20I2S%20microphone");
});

test("shipping text names every shop whose shipping is unknown", () => {
  const nok = { amount: 69, currency: "NOK" };
  expect(shippingSentence({ known: [nok], pricedShops: ["Elkim"], unknownShops: ["Electrokit", "Adafruit", "Kjell"] })).toBe(
    " Shipping 69 NOK (Elkim), but shipping from Electrokit, Adafruit and Kjell is not known until checkout.",
  );
  expect(shippingSentence({ known: [], pricedShops: [], unknownShops: ["Elkim", "Fibel"] })).toBe(
    " Shipping is not included: shipping from Elkim and Fibel is not known until checkout.",
  );
  expect(shippingSentence({ known: [nok, { amount: 9, currency: "USD" }], pricedShops: ["Elkim", "Adafruit"], unknownShops: [] })).toBe(
    " Shipping 69 NOK + 9 USD (Elkim and Adafruit).",
  );
  expect(shippingSentence(undefined)).toBe(" Shipping is not included.");
});
