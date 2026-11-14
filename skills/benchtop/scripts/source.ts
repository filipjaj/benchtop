// Parts sourcing helper: gathers live price and stock candidates per part. It does not choose;
// the agent picks listings and writes them into project.json (Project.sourcing).
//
//   bun source.ts <projectDir> [--stores jlc,adafruit,pimoroni] [--limit 3] [--json] [--fresh]
//   bun source.ts --query "<search text>" [--stores ...] [--limit 3] [--json] [--fresh]
//
// Only the search text and store URLs leave the machine, with a generic User-Agent.

import { createHash } from "node:crypto";
import { mkdir } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { loadPartDefs, main, ProjectError } from "./lib/project";
import type { PartDef, Project } from "./lib/types";

// ---------------------------------------------------------------------------
// Types

export interface Candidate {
  store: string;
  title: string;
  url: string;
  price: { amount: number; currency: string } | null;
  /** Units in stock when the store reports a count. */
  stock: number | null;
  /** True/false when the store says; null when unknown. */
  inStock: boolean | null;
  /** jlc only. */
  lcsc?: string;
  basic?: boolean;
  /** Extra text matched against the search words but not shown (descriptions). */
  haystack?: string;
  /** Set when the listing was fetched by its exact LCSC number; exempt from the title filter. */
  exact?: boolean;
}

export interface Ctx {
  /** GET a URL and parse JSON. Applies timeout, UA, concurrency limit and one retry. */
  getJson: (url: string) => Promise<unknown>;
  /** Run `load` unless a fresh cache entry exists for (store, query). */
  cached: <T>(store: string, query: string, load: () => Promise<T>) => Promise<T>;
}

/** One store = one adapter. Adding a store means adding one of these and registering it. */
export interface StoreAdapter {
  id: string;
  name: string;
  /** Free-text search. Return raw candidates; ranking happens outside. */
  search: (query: string, ctx: Ctx) => Promise<Candidate[]>;
  /** Direct lookup by LCSC number. Only jlc implements it. */
  byLcsc?: (lcsc: string, ctx: Ctx) => Promise<Candidate[]>;
}

// ---------------------------------------------------------------------------
// Pure helpers: tokenising, ranking, cache keys (tested in lib/source.test.ts)

const SHORT_WORD = 3;

export function tokens(text: string): string[] {
  return text.toLowerCase().split(/[^a-z0-9]+/).filter((t) => t.length > 0);
}

/** Number of search words found in the text. Words under 3 chars must match a token exactly; longer ones may be a token prefix. */
export function matchedWords(search: string, text: string): { matched: number; total: number; ids: number } {
  const words = [...new Set(tokens(search))];
  const hay = tokens(text);
  let matched = 0;
  let ids = 0; // matched words containing a digit, i.e. model numbers like "bme280"
  for (const w of words) {
    const hit = w.length < SHORT_WORD ? hay.includes(w) : hay.some((t) => t.startsWith(w));
    if (hit) {
      matched++;
      if (/\d/.test(w)) ids++;
    }
  }
  return { matched, total: words.length, ids };
}

function stockRank(c: Candidate): number {
  if (c.inStock === true) return 0;
  if (c.inStock === null) return 1;
  return 2;
}

/**
 * Keep candidates whose title shares at least half the search words with one of the search
 * strings, then order by words matched (desc), in stock first, then unit price (asc).
 * Exact LCSC lookups bypass the filter and come first. Prices are only compared within one
 * currency, so call this per store.
 */
export function rankCandidates(cands: Candidate[], searches: string[], limit: number): Candidate[] {
  const scored: { c: Candidate; frac: number; matched: number; ids: number }[] = [];
  const seen = new Set<string>();
  for (const c of cands) {
    if (seen.has(c.url)) continue;
    seen.add(c.url);
    let best = { matched: 0, frac: 0, ids: 0 };
    for (const s of searches) {
      const text = c.haystack ? `${c.title} ${c.haystack}` : c.title;
      const { matched, total, ids } = matchedWords(s, text);
      if (total === 0) continue;
      const frac = matched / total;
      if (frac > best.frac || (frac === best.frac && matched > best.matched)) best = { matched, frac, ids };
    }
    // "Fewer than half" is dropped: exactly half survives.
    if (!c.exact && best.frac < 0.5) continue;
    scored.push({ c, ...best });
  }
  scored.sort((a, b) => {
    if (!!a.c.exact !== !!b.c.exact) return a.c.exact ? -1 : 1;
    if (a.frac !== b.frac) return b.frac - a.frac;
    if (a.matched !== b.matched) return b.matched - a.matched;
    // At equal counts a model-number hit ("bme280") outranks a generic word ("breakout").
    if (a.ids !== b.ids) return b.ids - a.ids;
    const s = stockRank(a.c) - stockRank(b.c);
    if (s !== 0) return s;
    return (a.c.price?.amount ?? Infinity) - (b.c.price?.amount ?? Infinity);
  });
  return scored.slice(0, limit).map((x) => x.c);
}

export const CACHE_TTL_MS = 24 * 60 * 60 * 1000;

/** Cache file stem for a store and query. Case and whitespace insensitive. */
export function cacheKey(store: string, query: string): string {
  const norm = query.toLowerCase().trim().replace(/\s+/g, " ");
  return `${store}-${createHash("sha256").update(norm).digest("hex").slice(0, 20)}`;
}

export function isFresh(fetchedAt: number, now: number, ttlMs = CACHE_TTL_MS): boolean {
  return Number.isFinite(fetchedAt) && fetchedAt <= now && now - fetchedAt < ttlMs;
}

// ---------------------------------------------------------------------------
// Context: network and cache

const USER_AGENT = "benchtop-sourcing/1";
const TIMEOUT_MS = 8000;
const MAX_IN_FLIGHT = 4;

function makeLimiter(max: number): <T>(fn: () => Promise<T>) => Promise<T> {
  let active = 0;
  const waiting: (() => void)[] = [];
  return async <T>(fn: () => Promise<T>): Promise<T> => {
    if (active >= max) await new Promise<void>((r) => waiting.push(r));
    active++;
    try {
      return await fn();
    } finally {
      active--;
      waiting.shift()?.();
    }
  };
}

class HttpError extends Error {
  constructor(readonly status: number, url: string) {
    super(`HTTP ${status} from ${new URL(url).host}`);
  }
}

function makeCtx(cacheDir: string, fresh: boolean): Ctx {
  const limit = makeLimiter(MAX_IN_FLIGHT);
  const attempt = async (url: string): Promise<unknown> => {
    const res = await fetch(url, {
      headers: { "User-Agent": USER_AGENT, Accept: "application/json" },
      signal: AbortSignal.timeout(TIMEOUT_MS),
    });
    if (!res.ok) throw new HttpError(res.status, url);
    return (await res.json()) as unknown;
  };
  const getJson = (url: string): Promise<unknown> =>
    limit(async () => {
      try {
        return await attempt(url);
      } catch (err) {
        // One retry on network failure, timeout or 5xx. 4xx will not improve.
        if (err instanceof HttpError && err.status < 500) throw err;
        return await attempt(url);
      }
    });
  const cached = async <T>(store: string, query: string, load: () => Promise<T>): Promise<T> => {
    const file = join(cacheDir, `${cacheKey(store, query)}.json`);
    if (!fresh) {
      try {
        const hit = (await Bun.file(file).json()) as { fetchedAt: number; data: T };
        if (isFresh(hit.fetchedAt, Date.now())) return hit.data;
      } catch {
        // missing or corrupt entry: fall through to a live fetch
      }
    }
    const data = await load();
    try {
      await mkdir(cacheDir, { recursive: true });
      await Bun.write(file, JSON.stringify({ fetchedAt: Date.now(), data }));
    } catch {
      // read-only location: the run still works, it just is not cached
    }
    return data;
  };
  return { getJson, cached };
}

// ---------------------------------------------------------------------------
// Store adapters. Each response is parsed defensively: the shape is checked, not assumed.

type Json = Record<string, unknown>;
const isObj = (v: unknown): v is Json => typeof v === "object" && v !== null && !Array.isArray(v);
const num = (v: unknown): number | null => {
  const n = typeof v === "string" ? Number(v) : typeof v === "number" ? v : NaN;
  return Number.isFinite(n) ? n : null;
};
const str = (v: unknown): string => (typeof v === "string" ? v : "");

function jlcCandidate(raw: unknown, exact: boolean): Candidate | null {
  if (!isObj(raw)) return null;
  const lcsc = num(raw.lcsc);
  const mfr = str(raw.mfr);
  if (lcsc === null || !mfr) return null;
  const price = num(raw.price);
  const stock = num(raw.stock); // null when the mirror has no stock figure
  const pkg = str(raw.package);
  const desc = str(raw.description);
  return {
    store: "jlc",
    title: [mfr, pkg].filter(Boolean).join(" "),
    url: `https://www.lcsc.com/product-detail/C${lcsc}.html`,
    // The mirror does not state a currency; JLCPCB/LCSC list USD.
    price: price === null ? null : { amount: price, currency: "USD" },
    stock,
    inStock: stock === null ? null : stock > 0,
    lcsc: `C${lcsc}`,
    basic: raw.is_basic === true,
    haystack: desc,
    exact,
  };
}

async function jlcFetch(q: string, ctx: Ctx, exact: boolean): Promise<Candidate[]> {
  const raw = await ctx.cached("jlc", q, () =>
    ctx.getJson(`https://jlcsearch.tscircuit.com/api/search?q=${encodeURIComponent(q)}&limit=20`),
  );
  if (!isObj(raw) || !Array.isArray(raw.components)) throw new Error("unexpected response shape");
  return raw.components.map((c) => jlcCandidate(c, exact)).filter((c): c is Candidate => c !== null);
}

const jlc: StoreAdapter = {
  id: "jlc",
  name: "JLCPCB/LCSC",
  search: (q, ctx) => jlcFetch(q, ctx, false),
  async byLcsc(lcsc, ctx) {
    const id = `C${lcsc.replace(/^c/i, "")}`;
    const hits = await jlcFetch(id, ctx, true);
    // Keep only the listing whose number matches; a prefix query can return neighbours.
    return hits.filter((c) => c.lcsc === id);
  },
};

interface AdafruitItem {
  id: string;
  name: string;
  price: number | null;
  stock: string;
  url: string;
  discontinued: boolean;
}

async function adafruitCatalogue(ctx: Ctx): Promise<AdafruitItem[]> {
  // Whole catalogue (~8 MB) once per day, cached in trimmed form.
  return ctx.cached("adafruit", "catalogue", async () => {
    const raw = await ctx.getJson("https://www.adafruit.com/api/products");
    if (!Array.isArray(raw)) throw new Error("unexpected response shape");
    const items: AdafruitItem[] = [];
    for (const p of raw) {
      if (!isObj(p)) continue;
      const name = str(p.product_name);
      const url = str(p.product_url);
      if (!name || !url) continue;
      items.push({
        id: str(p.product_id),
        name,
        price: num(p.product_price),
        stock: str(p.product_stock),
        url,
        discontinued: str(p.discontinue_status) !== "None" && str(p.discontinue_status) !== "",
      });
    }
    return items;
  });
}

const adafruit: StoreAdapter = {
  id: "adafruit",
  name: "Adafruit",
  async search(q, ctx) {
    const items = await adafruitCatalogue(ctx);
    const out: Candidate[] = [];
    for (const it of items) {
      // product_stock is "in stock" or an integer string; zero and negative mean none.
      const count = num(it.stock);
      const inStock = !it.discontinued && (it.stock === "in stock" || (count !== null && count > 0));
      const { matched, total } = matchedWords(q, it.name);
      if (total === 0 || matched === 0) continue; // cheap pre-filter; ranking applies the real threshold
      out.push({
        store: "adafruit",
        title: it.name,
        url: it.url,
        price: it.price === null ? null : { amount: it.price, currency: "USD" },
        stock: count !== null && count > 0 ? count : null,
        inStock,
      });
    }
    return out;
  },
};

const pimoroni: StoreAdapter = {
  id: "pimoroni",
  name: "Pimoroni",
  async search(q, ctx) {
    const url =
      `https://shop.pimoroni.com/search/suggest.json?q=${encodeURIComponent(q)}` +
      `&resources%5Btype%5D=product&resources%5Blimit%5D=10`;
    // The response carries full HTML bodies (tens of KB); keep only what the ranking needs.
    const products = await ctx.cached("pimoroni", q, async () => {
      const raw = await ctx.getJson(url);
      const list = isObj(raw) && isObj(raw.resources) && isObj(raw.resources.results) ? raw.resources.results.products : undefined;
      if (!Array.isArray(list)) throw new Error("unexpected response shape");
      return list.filter(isObj).map((p) => ({
        title: str(p.title),
        url: str(p.url),
        price: str(p.price),
        available: p.available === true,
      }));
    });
    return products
      .filter((p) => p.title && p.url)
      .map((p): Candidate => {
        const price = num(p.price);
        return {
          store: "pimoroni",
          title: p.title,
          // Drop the search-tracking query string Shopify appends.
          url: `https://shop.pimoroni.com${p.url.split("?")[0]}`,
          // shop.pimoroni.com prices are GBP (cart.js reports it); the store gives no stock count.
          price: price === null ? null : { amount: price, currency: "GBP" },
          stock: null,
          inStock: p.available,
        };
      });
  },
};

export const ADAPTERS: Record<string, StoreAdapter> = { jlc, adafruit, pimoroni };

// ---------------------------------------------------------------------------
// Orchestration

export interface PartLookup {
  ref: string;
  refs: string[];
  part: string;
  searches: string[];
  lcsc?: string;
}

export interface Report {
  parts: { ref: string; refs: string[]; part: string; candidates: Candidate[] }[];
  unavailable: { store: string; reason: string }[];
}

export async function gather(lookups: PartLookup[], stores: StoreAdapter[], limit: number, ctx: Ctx): Promise<Report> {
  const failed = new Map<string, string>();
  const parts: Report["parts"] = [];
  const work = lookups.map(async (lk) => {
    const perStore = await Promise.all(
      stores.map(async (store): Promise<Candidate[]> => {
        try {
          const lists = await Promise.all([
            ...lk.searches.map((s) => store.search(s, ctx)),
            ...(lk.lcsc && store.byLcsc ? [store.byLcsc(lk.lcsc, ctx)] : []),
          ]);
          return rankCandidates(lists.flat(), lk.searches, limit);
        } catch (err) {
          failed.set(store.id, err instanceof Error ? err.message : String(err));
          return [];
        }
      }),
    );
    return { ref: lk.ref, refs: lk.refs, part: lk.part, candidates: perStore.flat() };
  });
  parts.push(...(await Promise.all(work)));
  return { parts, unavailable: [...failed].map(([store, reason]) => ({ store, reason })) };
}

function normalizeLcsc(v: string | undefined): string | undefined {
  if (!v) return undefined;
  const digits = v.replace(/^c/i, "").trim();
  return /^\d+$/.test(digits) ? digits : undefined;
}

export function lookupsFromProject(project: Project, defs: Map<string, PartDef>): PartLookup[] {
  const byPart = new Map<string, PartLookup>();
  for (const use of project.parts) {
    const existing = byPart.get(use.part);
    if (existing) {
      existing.refs.push(use.ref);
      continue;
    }
    const def = defs.get(use.part);
    if (!def) {
      throw new ProjectError(
        `part "${use.part}" (ref ${use.ref}) is not in the library. Add ${use.part}.json to the project's parts/ folder.`,
      );
    }
    byPart.set(use.part, {
      ref: use.ref,
      refs: [use.ref],
      part: use.part,
      searches: def.sourcing.search,
      lcsc: normalizeLcsc(def.footprint?.lcsc),
    });
  }
  return [...byPart.values()];
}

// ---------------------------------------------------------------------------
// Output

const cell = (s: string): string => s.replace(/\|/g, "\\|").replace(/\s+/g, " ").trim();

function fmtPrice(c: Candidate): string {
  if (!c.price) return "?";
  return `${c.price.amount.toFixed(2)} ${c.price.currency}`;
}

function fmtStock(c: Candidate): string {
  if (c.stock !== null) return String(c.stock);
  if (c.inStock === true) return "in stock";
  if (c.inStock === false) return "out";
  return "?";
}

export function renderMarkdown(report: Report): string {
  const lines: string[] = [];
  for (const p of report.parts) {
    const refs = p.refs.length > 1 ? ` (${p.refs.join(", ")})` : "";
    lines.push(`### ${p.ref}${refs}: ${p.part}`, "");
    if (p.candidates.length === 0) {
      lines.push("No matching candidates.", "");
      continue;
    }
    lines.push("| Store | Title | Price | Stock | Notes | URL |", "|---|---|---|---|---|---|");
    for (const c of p.candidates) {
      const notes = c.lcsc ? `${c.lcsc}${c.basic ? " basic" : " extended"}` : "";
      lines.push(`| ${c.store} | ${cell(c.title).slice(0, 90)} | ${fmtPrice(c)} | ${fmtStock(c)} | ${notes} | ${c.url} |`);
    }
    lines.push("");
  }
  for (const u of report.unavailable) lines.push(`store unavailable: ${u.store} (${u.reason})`);
  return lines.join("\n");
}

// ---------------------------------------------------------------------------
// CLI

interface Args {
  dir?: string;
  query?: string;
  stores: string[];
  limit: number;
  json: boolean;
  fresh: boolean;
}

function parseArgs(argv: string[]): Args {
  const args: Args = { stores: Object.keys(ADAPTERS), limit: 3, json: false, fresh: false };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i]!;
    const value = (): string => {
      const v = argv[++i];
      if (v === undefined) throw new ProjectError(`${a} needs a value`);
      return v;
    };
    if (a === "--json") args.json = true;
    else if (a === "--fresh") args.fresh = true;
    else if (a === "--query") args.query = value();
    else if (a === "--stores") args.stores = value().split(",").map((s) => s.trim()).filter(Boolean);
    else if (a === "--limit") {
      const n = Number(value());
      if (!Number.isInteger(n) || n < 1) throw new ProjectError("--limit must be a positive integer");
      args.limit = n;
    } else if (a.startsWith("--")) throw new ProjectError(`unknown option ${a}`);
    else if (args.dir === undefined) args.dir = a;
    else throw new ProjectError(`unexpected argument "${a}"`);
  }
  for (const s of args.stores) {
    if (!(s in ADAPTERS)) throw new ProjectError(`unknown store "${s}". Known stores: ${Object.keys(ADAPTERS).join(", ")}`);
  }
  if (args.stores.length === 0) throw new ProjectError("--stores is empty");
  if (args.query === undefined && args.dir === undefined) {
    throw new ProjectError(
      'usage: bun source.ts <projectDir> [--stores jlc,adafruit,pimoroni] [--limit 3] [--json] [--fresh]\n       bun source.ts --query "<search text>" [...]',
    );
  }
  if (args.query !== undefined && args.dir !== undefined) throw new ProjectError("pass either <projectDir> or --query, not both");
  return args;
}

async function run(): Promise<void> {
  const args = parseArgs(process.argv.slice(2));
  const stores = args.stores.map((s) => ADAPTERS[s]!);
  let lookups: PartLookup[];
  let cacheDir: string;
  if (args.query !== undefined) {
    lookups = [{ ref: "query", refs: ["query"], part: args.query, searches: [args.query] }];
    cacheDir = join(tmpdir(), "benchtop-source-cache");
  } else {
    const dir = resolve(args.dir!);
    const file = Bun.file(join(dir, "project.json"));
    if (!(await file.exists())) {
      throw new ProjectError(`${join(dir, "project.json")} not found. Pass the folder that holds project.json.`);
    }
    // JSON.parse returns any; the shape is the Project contract from types.ts.
    const project = (await file.json()) as Project;
    lookups = lookupsFromProject(project, await loadPartDefs(dir));
    cacheDir = join(dir, "out", ".cache", "source");
  }
  const report = await gather(lookups, stores, args.limit, makeCtx(cacheDir, args.fresh));
  console.log(args.json ? JSON.stringify(report, null, 2) : renderMarkdown(report));
  if (report.unavailable.length === stores.length) process.exit(1);
}

if (import.meta.main) await main(run);
