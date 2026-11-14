import { describe, expect, test } from "bun:test";
import { CACHE_TTL_MS, cacheKey, isFresh, matchedWords, rankCandidates, type Candidate } from "../source";

function cand(over: Partial<Candidate> & { title: string; url: string }): Candidate {
  return { store: "test", price: null, stock: null, inStock: null, ...over };
}
const gbp = (amount: number) => ({ amount, currency: "GBP" });

describe("matchedWords", () => {
  test("counts distinct search words found in the title", () => {
    expect(matchedWords("BME280 breakout", "Adafruit BME280 I2C Sensor")).toEqual({ matched: 1, total: 2, ids: 1 });
    expect(matchedWords("bme280 bme280 breakout", "BME280 Breakout Board")).toEqual({ matched: 2, total: 2, ids: 1 });
  });

  test("a model-number match outranks a generic word at equal counts, regardless of price", () => {
    const out = rankCandidates(
      [
        cand({ title: "IDC Breakout Helper", url: "generic", inStock: true, price: gbp(1) }),
        cand({ title: "Adafruit BME280 Sensor", url: "model", inStock: true, price: gbp(15) }),
      ],
      ["BME280 breakout"],
      10,
    );
    expect(out.map((c) => c.url)).toEqual(["model", "generic"]);
  });

  test("long words match token prefixes, short words need an exact token", () => {
    expect(matchedWords("esp32", "ESP32-C3FH4 QFN").matched).toBe(1);
    expect(matchedWords("c3", "ESP32-C3FH4").matched).toBe(0);
    expect(matchedWords("c3", "ESP32 C3 Mini").matched).toBe(1);
  });
});

describe("rankCandidates", () => {
  const searches = ["BME280 breakout"];

  test("drops titles that share fewer than half the search words, keeps exactly half", () => {
    const out = rankCandidates(
      [
        cand({ title: "USB-C Cable 1m", url: "u1" }),
        cand({ title: "BME280 Sensor", url: "u2" }), // 1 of 2 words: kept
        cand({ title: "Resistor Pack Breakout", url: "u3" }), // 1 of 2: kept
      ],
      searches,
      10,
    );
    expect(out.map((c) => c.url).sort()).toEqual(["u2", "u3"]);
    // 1 of 3 is dropped
    expect(rankCandidates([cand({ title: "BME280 Sensor", url: "x" })], ["bme280 breakout board"], 10)).toEqual([]);
  });

  test("orders by words matched, then in stock, then price", () => {
    const out = rankCandidates(
      [
        cand({ title: "BME280 Sensor", url: "partial-cheap", inStock: true, price: gbp(1) }),
        cand({ title: "BME280 Breakout", url: "full-out", inStock: false, price: gbp(5) }),
        cand({ title: "BME280 Breakout Pro", url: "full-in-dear", inStock: true, price: gbp(20) }),
        cand({ title: "BME280 Breakout Mini", url: "full-in-cheap", inStock: true, price: gbp(9) }),
        cand({ title: "BME280 Breakout XL", url: "full-unknown", inStock: null, price: gbp(2) }),
      ],
      searches,
      10,
    );
    expect(out.map((c) => c.url)).toEqual(["full-in-cheap", "full-in-dear", "full-unknown", "full-out", "partial-cheap"]);
  });

  test("scores against the best of several search strings and honours limit", () => {
    const out = rankCandidates(
      [
        cand({ title: "Bosch BME280 humidity sensor", url: "a" }),
        cand({ title: "BME280 module", url: "b" }),
        cand({ title: "DHT22", url: "c" }),
      ],
      ["bme280 module", "bosch humidity sensor"],
      1,
    );
    expect(out.map((c) => c.url)).toEqual(["a"]);
  });

  test("dedupes by url, uses the haystack for matching, and puts exact LCSC hits first even when unrelated", () => {
    const out = rankCandidates(
      [
        cand({ title: "ESP32-C3FH4 QFN-32", url: "j1", haystack: "Microcontrollers", inStock: true }),
        cand({ title: "ESP32-C3FH4 QFN-32", url: "j1", inStock: true }),
        cand({ title: "XYZ123", url: "j2", exact: true, lcsc: "C2858491" }),
        cand({ title: "Unrelated", url: "j3" }),
      ],
      ["esp32-c3 microcontrollers"],
      10,
    );
    expect(out.map((c) => c.url)).toEqual(["j2", "j1"]);
  });
});

describe("cache key and expiry", () => {
  test("key is stable, store-scoped, and ignores case and whitespace", () => {
    expect(cacheKey("jlc", "BME280  breakout")).toBe(cacheKey("jlc", " bme280 breakout "));
    expect(cacheKey("jlc", "bme280")).not.toBe(cacheKey("pimoroni", "bme280"));
    expect(cacheKey("jlc", "bme280")).not.toBe(cacheKey("jlc", "bme680"));
    expect(cacheKey("jlc", "../../etc/passwd")).toMatch(/^jlc-[0-9a-f]{20}$/);
  });

  test("entries are fresh for 24 hours and not after", () => {
    const now = 1_700_000_000_000;
    expect(isFresh(now - 1000, now)).toBe(true);
    expect(isFresh(now - CACHE_TTL_MS + 1, now)).toBe(true);
    expect(isFresh(now - CACHE_TTL_MS, now)).toBe(false);
    expect(isFresh(now + 60_000, now)).toBe(false); // clock skew or corrupt timestamp
    expect(isFresh(Number.NaN, now)).toBe(false);
  });
});
