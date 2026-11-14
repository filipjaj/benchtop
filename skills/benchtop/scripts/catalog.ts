#!/usr/bin/env bun
// Read-only bridge to the local maker parts catalog (SQLite). Optional: the skill works
// without it. See references/catalog.md for how an agent uses it.
//
// Usage:
//   bun catalog.ts find <text> [--norway] [--fits W D H] [--include-pcb] [--limit N]
//   bun catalog.ts show <part_id>
//   bun catalog.ts listings <part_id | text> [--norway] [--limit N]
//   bun catalog.ts check-library [--tolerance MM]
//   bun catalog.ts card <part_id> | cards <text> [--fits W D H] [--norway] [--pads] [--cards FILE]
//       (reads a card file built by catalog-cards.ts: --cards, else $BENCHTOP_CARDS; none is bundled)
//   bun catalog.ts pads <part_id> [--geometry ID]
//   bun catalog.ts import-part <part_id> --id NEW_ID --out FILE.json [--header REF[,REF...]]
//                  [--geometry ID] [--rot 0|90|180|270] [--mirror] [--outline x0,y0,x1,y1] [--overwrite]
// Every command accepts --json and --db <path>.
// Database: --db, then $BENCHTOP_CATALOG, then assets/catalog/maker_catalog.sqlite.
// Exit codes: 0 ok, 2 usage error, 3 catalog missing / locked / unexpected schema.

import { Database } from "bun:sqlite";
import { existsSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import { basename, dirname, join, resolve } from "node:path";
import { findCards, getCard, openCards, renderCard, renderFind, type Card } from "./catalog-cards";
import { PadsError, describePads, formatImport, formatPads, importPart, parseHeaderSpecs, parseOutlineArg, type Rot } from "./lib/catalog-pads";
import { LIBRARY_DIR, ProjectError, SKILL_ROOT, main } from "./lib/project";
import type { PartDef } from "./lib/types";

export const TESTED_SCHEMA_VERSION = 2;
export const DEFAULT_TOLERANCE_MM = 0.5;

/** The catalog is absent, locked, half-written or has a different schema. Exit code 3. */
export class CatalogUnavailable extends Error {}

// ---------------------------------------------------------------------------------------
// Location, opening, schema check

export function resolveDbPath(opts: { db?: string; env?: string; skillRoot: string }): { path: string; via: string } {
  const candidates: { path: string; via: string }[] = [];
  if (opts.db) candidates.push({ path: resolve(opts.db), via: "--db" });
  else if (opts.env) candidates.push({ path: resolve(opts.env), via: "BENCHTOP_CATALOG" });
  else candidates.push({ path: join(opts.skillRoot, "assets", "catalog", "maker_catalog.sqlite"), via: "default location" });
  const hit = candidates[0]!;
  if (!existsSync(hit.path)) {
    throw new CatalogUnavailable(
      `The parts catalog is optional and was not found (looked at ${hit.path} via ${hit.via}); point at it with --db <path>, the BENCHTOP_CATALOG environment variable, or by placing it at assets/catalog/maker_catalog.sqlite.`,
    );
  }
  return hit;
}

/** Tables and columns this script reads. Checked on open so a changed schema fails early. */
export const REQUIRED_SCHEMA: Record<string, string[]> = {
  parts: ["part_id", "name", "brand", "manufacturer_part_number", "category", "identity_scope", "primary_url", "description", "geometry_status", "selection_rank"],
  envelopes: ["part_id", "a_mm", "b_mm", "c_mm", "axis_labels_json", "scope", "source_id", "evidence_text", "verification_status", "exact_variant_required", "variant_sku"],
  measurements: ["measurement_id", "part_id", "kind", "scope", "values_mm_json", "axis_labels_json", "evidence_text", "extraction_status", "source_id", "notes"],
  sources: ["source_id", "url", "publisher", "authority", "retrieved_at"],
  pin_definitions: ["pin_id", "part_id", "connector", "pin_number", "name", "electrical_type_as_source", "functions_as_source", "source_id", "revision", "notes"],
  specifications: ["spec_id", "part_id", "domain", "key", "value_text", "value_num", "minimum_num", "maximum_num", "unit", "source_id", "validation_status"],
  listings: ["listing_id", "part_id", "supplier", "url", "supplier_sku", "identity_match", "domestic_market", "currency", "price", "price_basis", "stock_status", "observed_at", "shipping_to_norway", "source_id"],
  variants: ["variant_id", "part_id", "supplier", "sku", "title"],
  assets: ["asset_id", "part_id", "kind", "title", "url", "source_id", "fetch_status", "revision"],
  asset_files: ["url", "relative_path", "sha256", "status", "error"],
  data_issues: ["issue_id", "part_id", "severity", "code", "detail", "source_id"],
  parts_fts: ["part_id", "name", "brand", "category", "families", "specifications"],
};

export interface Catalog {
  db: Database;
  path: string;
  /** Folder that holds the database; cached reference files are relative to it. */
  root: string;
  userVersion: number;
  /** Set when this is the slim snapshot bundled with the skill, not the full catalog. */
  snapshot: SnapshotInfo | null;
}

export interface SnapshotInfo {
  bundled_snapshot: true;
  part_count: number;
  source_part_count: number;
  /** Date of the full catalog the snapshot was cut from; prices and stock are frozen at that date. */
  source_date: string;
  /** The public catalog (catalog-public.ts): manufacturer facts only, no listings, prices or stock. */
  public: boolean;
}

/** Reads the `bundle_*` marks the snapshot builder writes into `metadata`; null for the full catalog. */
export function snapshotInfo(db: Database): SnapshotInfo | null {
  if (!hasTable(db, "metadata")) return null;
  const meta = new Map(all<{ key: string; value: string }>(db, `SELECT key, value FROM metadata WHERE key LIKE 'bundle_%'`).map((r) => [r.key, r.value]));
  if (meta.get("bundle_kind") !== "skill_snapshot") return null;
  return {
    bundled_snapshot: true,
    part_count: Number(meta.get("bundle_part_count")) || 0,
    source_part_count: Number(meta.get("bundle_source_part_count")) || 0,
    source_date: (meta.get("bundle_source_created_at_utc") ?? "unknown").slice(0, 10),
    public: meta.get("bundle_public") === "1",
  };
}

/** The line shown on top of every human output, and the hint appended when a lookup finds nothing. */
export function snapshotLine(path: string, s: SnapshotInfo): string {
  if (s.public) return `catalog: ${path} (public catalog, ${s.part_count.toLocaleString("en-US")} of ${s.source_part_count.toLocaleString("en-US")} parts: manufacturer-published facts as of ${s.source_date}, no listings, prices or stock)`;
  return `catalog: ${path} (bundled snapshot, ${s.part_count.toLocaleString("en-US")} of ${s.source_part_count.toLocaleString("en-US")} parts, listings as of ${s.source_date}; prices and stock are frozen at that date)`;
}
export function snapshotHint(s: SnapshotInfo | null): string {
  return s
    ? `Not found in the bundled snapshot (${s.part_count.toLocaleString("en-US")} of ${s.source_part_count.toLocaleString("en-US")} parts); the part may exist in the full catalog. Point at it with --db <path> or the BENCHTOP_CATALOG environment variable.`
    : "";
}

function isTransient(e: unknown): boolean {
  return e instanceof Error && /locked|busy|malformed|disk i\/o|not a database|unable to open|corrupt/i.test(e.message);
}

/** Run `fn`; if the database is momentarily locked or half-written, retry once, then report. */
export function withRetry<T>(fn: () => T, wait = 750): T {
  try {
    return fn();
  } catch (e) {
    if (e instanceof CatalogUnavailable || !isTransient(e)) throw e;
    Bun.sleepSync(wait);
    try {
      return fn();
    } catch (e2) {
      if (!isTransient(e2)) throw e2;
      throw new CatalogUnavailable(
        `The catalog is locked or half-written (${(e2 as Error).message}); retried once. It is probably still being built; try again in a minute.`,
      );
    }
  }
}

export function checkSchema(db: Database): string[] {
  const problems: string[] = [];
  for (const [table, cols] of Object.entries(REQUIRED_SCHEMA)) {
    // Table names come from the constant above, never from user input.
    const have = new Set((db.query(`PRAGMA table_info(${table})`).all() as { name: string }[]).map((r) => r.name));
    if (have.size === 0) {
      problems.push(`table ${table} is missing`);
      continue;
    }
    const missing = cols.filter((c) => !have.has(c));
    if (missing.length) problems.push(`${table} lacks column${missing.length > 1 ? "s" : ""} ${missing.join(", ")}`);
  }
  return problems;
}

export function openCatalog(path: string, warn: (line: string) => void = (l) => console.error(l)): Catalog {
  return withRetry(() => {
    const db = new Database(path, { readonly: true });
    try {
      const problems = checkSchema(db);
      if (problems.length) {
        throw new CatalogUnavailable(
          `The catalog at ${path} does not have the schema benchtop reads: ${problems.join("; ")}. The bridge was tested against schema version ${TESTED_SCHEMA_VERSION}.`,
        );
      }
      const row = db.query("PRAGMA user_version").get() as { user_version: number } | null;
      const userVersion = row?.user_version ?? 0;
      if (userVersion !== TESTED_SCHEMA_VERSION) {
        warn(`catalog bridge was tested against schema version ${TESTED_SCHEMA_VERSION} and found ${userVersion}; the tables and columns it reads are present, continuing`);
      }
      return { db, path, root: dirname(path), userVersion, snapshot: snapshotInfo(db) };
    } catch (e) {
      db.close();
      throw e;
    }
  });
}

// ---------------------------------------------------------------------------------------
// Small helpers

function all<T>(db: Database, sql: string, ...params: (string | number)[]): T[] {
  return db.query(sql).all(...params) as T[];
}
function one<T>(db: Database, sql: string, ...params: (string | number)[]): T | undefined {
  return (db.query(sql).get(...params) as T | null) ?? undefined;
}
function hasTable(db: Database, name: string): boolean {
  return !!one(db, "SELECT 1 AS x FROM sqlite_master WHERE name = ?", name);
}
function num(n: number): string {
  return String(Number(n.toFixed(2)));
}
function clip(s: string, n: number): string {
  const t = s.replace(/\s+/g, " ").trim();
  return t.length > n ? `${t.slice(0, n - 1)}…` : t;
}
function parseLabels(s: string | null): string[] | null {
  if (!s) return null;
  try {
    const v: unknown = JSON.parse(s);
    return Array.isArray(v) && v.every((x): x is string => typeof x === "string") ? v : null;
  } catch {
    return null;
  }
}
function parseValues(s: string): number[] {
  try {
    const v: unknown = JSON.parse(s);
    return Array.isArray(v) ? v.filter((x): x is number => typeof x === "number") : [];
  } catch {
    return [];
  }
}

export interface Outline {
  /** Source order, third entry null when the source gave two values. */
  values: [number, number, number | null];
  labels: string[] | null;
  scope: string;
}

export function fmtOutline(o: Outline): string {
  const parts = o.values.map((v, i) => {
    if (v === null) return "?";
    const l = o.labels?.[i];
    return l ? `${num(v)} ${l}` : num(v);
  });
  const notes = [`scope ${o.scope}`, o.labels ? `axes in source order` : "axes unlabeled, source order"];
  if (o.values[2] === null) notes.push("third dimension unknown");
  return `${parts.join(" x ")} mm [${notes.join("; ")}]`;
}

function ftsQuery(text: string, mode: "and" | "or"): string {
  const quote = (t: string): string => `"${t.replace(/"/g, '""')}"`;
  const toks = text
    .split(/\s+/)
    .filter(Boolean)
    // "SuperMini" also finds "super mini": sellers spell model names both ways.
    .map((t) => (/[a-z][A-Z]/.test(t) ? `(${quote(t)} OR ${quote(t.replace(/([a-z])([A-Z])/g, "$1 $2"))})` : quote(t)));
  return toks.join(mode === "and" ? " AND " : " OR ");
}

/** FTS search, AND of all words first, then OR when nothing matches. */
function searchIds(db: Database, text: string, limit: number): { ids: string[]; loose: boolean } {
  const run = (q: string): string[] =>
    all<{ part_id: string }>(
      db,
      `SELECT p.part_id FROM parts_fts f JOIN parts p ON p.part_id = f.part_id
       WHERE parts_fts MATCH ? ORDER BY bm25(parts_fts, 0, 8, 3, 1, 5, 1), p.selection_rank LIMIT ?`,
      q,
      limit,
    ).map((r) => r.part_id);
  const strict = run(ftsQuery(text, "and"));
  if (strict.length) return { ids: strict, loose: false };
  return { ids: run(ftsQuery(text, "or")), loose: true };
}

// ---------------------------------------------------------------------------------------
// find

interface FindRow {
  part_id: string;
  name: string;
  brand: string | null;
  identity_scope: string;
  a_mm: number | null;
  b_mm: number | null;
  c_mm: number | null;
  axis_labels_json: string | null;
  scope: string | null;
  pins: number;
  no_listings: number;
}

export interface FindHit {
  part_id: string;
  brand: string | null;
  name: string;
  identity_scope: string;
  outline: { text: string; scope: string; values_mm: (number | null)[]; axis_labels: string[] | null; selected: boolean } | null;
  /** Why there is no outline, when observations exist but none was selected. */
  outline_note: string | null;
  pin_definitions: number;
  norwegian_listings: number;
}

// Scopes the README allows as a whole-product outline for box-fit; pcb only on request.
const FIT_SCOPES = ["product_unspecified", "assembly"];

export function fitsBox(values: number[], box: number[]): boolean {
  const a = [...values].sort((x, y) => x - y);
  const b = [...box].sort((x, y) => x - y);
  return a.length === 3 && a.every((v, i) => v <= b[i]!);
}

export function find(
  db: Database,
  text: string,
  opts: { norway?: boolean; fits?: [number, number, number]; includePcb?: boolean; limit?: number } = {},
): { hits: FindHit[]; loose: boolean } {
  const limit = opts.limit ?? 20;
  const { ids, loose } = searchIds(db, text, 1000);
  if (!ids.length) return { hits: [], loose };
  const rows: FindRow[] = [];
  for (let i = 0; i < ids.length; i += 200) {
    const chunk = ids.slice(i, i + 200);
    rows.push(
      ...all<FindRow>(
        db,
        `SELECT p.part_id, p.name, p.brand, p.identity_scope, e.a_mm, e.b_mm, e.c_mm, e.axis_labels_json, e.scope,
           (SELECT count(*) FROM pin_definitions d WHERE d.part_id = p.part_id) AS pins,
           (SELECT count(*) FROM listings l WHERE l.part_id = p.part_id AND l.domestic_market = 'NO') AS no_listings
         FROM parts p LEFT JOIN envelopes e ON e.part_id = p.part_id
         WHERE p.part_id IN (${chunk.map(() => "?").join(",")})`,
        ...chunk,
      ),
    );
  }
  const order = new Map(ids.map((id, i) => [id, i]));
  rows.sort((x, y) => order.get(x.part_id)! - order.get(y.part_id)!);
  const hits: FindHit[] = [];
  for (const r of rows) {
    if (opts.norway && r.no_listings === 0) continue;
    if (opts.fits) {
      const scopes = opts.includePcb ? [...FIT_SCOPES, "pcb"] : FIT_SCOPES;
      // A two-value outline has an unknown third dimension: it cannot be shown to fit.
      if (r.a_mm === null || r.b_mm === null || r.c_mm === null || !r.scope || !scopes.includes(r.scope)) continue;
      if (!fitsBox([r.a_mm, r.b_mm, r.c_mm], opts.fits)) continue;
    }
    let hint: string | null = null;
    let outline: FindHit["outline"] =
      r.a_mm !== null && r.b_mm !== null && r.scope
        ? (() => {
            const o: Outline = { values: [r.a_mm, r.b_mm, r.c_mm], labels: parseLabels(r.axis_labels_json), scope: r.scope };
            return { text: fmtOutline(o), scope: r.scope, values_mm: o.values, axis_labels: o.labels, selected: true };
          })()
        : null;
    if (!outline) {
      // The catalog selects no outline when sources conflict or scope is unclear; say what exists instead.
      const obs = all<{ scope: string; values_mm_json: string }>(
        db,
        `SELECT scope, values_mm_json FROM measurements WHERE part_id = ? AND kind = 'bounding_box' ORDER BY measurement_id`,
        r.part_id,
      );
      const plain = obs.filter((m) => PLAIN_SCOPES.includes(m.scope) && parseValues(m.values_mm_json).length >= 2);
      const distinct = [...new Set(plain.map((m) => `${m.scope}|${m.values_mm_json}`))];
      if (distinct.length === 1 && obs.length === plain.length) {
        const m = plain[0]!;
        const v = parseValues(m.values_mm_json);
        const o: Outline = { values: [v[0]!, v[1]!, v[2] ?? null], labels: null, scope: m.scope };
        outline = { text: `${fmtOutline(o)} (unselected observation, not the catalog's chosen outline)`, scope: m.scope, values_mm: o.values, axis_labels: null, selected: false };
      } else if (obs.length) {
        hint = `${obs.length} dimension observation(s), none selected as the outline; run show`;
      }
    }
    hits.push({
      part_id: r.part_id,
      brand: r.brand,
      name: r.name,
      identity_scope: r.identity_scope,
      outline,
      outline_note: hint,
      pin_definitions: r.pins,
      norwegian_listings: r.no_listings,
    });
    if (hits.length >= limit) break;
  }
  return { hits, loose };
}

function formatFind(res: { hits: FindHit[]; loose: boolean }, text: string): string {
  if (!res.hits.length) return `no catalog parts match "${text}"${res.loose ? " (also tried any-word matching)" : ""}`;
  const lines = res.hits.map(
    (h) =>
      `${h.part_id} | ${h.brand ?? "no brand"} | ${h.name} | ${h.outline ? h.outline.text : `no outline${h.outline_note ? ` (${h.outline_note})` : ""}`} | pin definitions: ${
        h.pin_definitions ? `yes (${h.pin_definitions})` : "no"
      } | Norwegian listings: ${h.norwegian_listings}`,
  );
  if (res.loose) lines.unshift(`no part contains every word of "${text}"; showing parts that match any word:`);
  return lines.join("\n");
}

// ---------------------------------------------------------------------------------------
// show

interface SourceRef {
  source_id: number;
  url: string;
  publisher: string;
  authority: string;
  retrieved_at: string;
}

interface IssueRow {
  issue_id: number;
  severity: string;
  code: string;
  detail: string;
  source_id: number | null;
}

const DIMENSION_ISSUE = /dimension|geometry|envelope|mounting|pcb_only|scope|axis|unit|clearance/i;

// Assets an agent needs to place pads come first.
const ASSET_ORDER = ["pinout", "mechanical_drawing", "cad_or_mechanical", "schematic", "source_repository", "datasheet_or_pdf", "block_diagram"];
const ASSET_CAP = 12;

export interface ShowResult {
  part: {
    part_id: string;
    brand: string | null;
    name: string;
    manufacturer_part_number: string | null;
    category: string;
    identity_scope: string;
    geometry_status: string;
    primary_url: string;
    description: string | null;
  };
  selected_outline: (Outline & { verification_status: string; exact_variant_required: boolean; variant_sku: string | null; source_id: number; evidence: string }) | null;
  dimensions: {
    kind: string;
    scope: string;
    values_mm: number[];
    axis_labels: string[] | null;
    extraction_status: string;
    evidence: string;
    notes: string | null;
    source_id: number;
    flagged_by: string[];
  }[];
  pins: { connector: string; pin_number: string; name: string; electrical_type: string | null; functions: string; source_id: number; notes: string | null }[];
  specifications: { key: string; value: string; unit: string | null; from: string; source_id: number }[];
  listings: ListingOut[];
  assets: {
    kind: string;
    title: string | null;
    url: string;
    local_path: string | null;
    cache_state: "cached" | "downloaded per catalog but file missing on disk" | "not cached";
    fetch_status: string;
  }[];
  asset_counts: Record<string, number>;
  data_issues: IssueRow[];
  not_in_catalog: string[];
  sources: SourceRef[];
}

const SPEC_KEY = /volt|spenning|supply|vcc|current|str[øo]m|power|logic|i2c|address|interface|grensesnitt|protocol|communication|^uart$|^spi$/i;
const SPEC_TEXT = /\b\d+(\.\d+)?\s*(-|–|~|to)?\s*\d*(\.\d+)?\s*V\b|0x[0-9a-f]{2}|\bi2c\b|logic level/i;

interface SpecRow {
  domain: string;
  key: string;
  value_text: string;
  value_num: number | null;
  minimum_num: number | null;
  maximum_num: number | null;
  unit: string | null;
  source_id: number;
}

export function show(cat: Catalog, partId: string): ShowResult | null {
  const { db } = cat;
  const p = one<ShowResult["part"]>(
    db,
    `SELECT part_id, brand, name, manufacturer_part_number, category, identity_scope, geometry_status, primary_url, description FROM parts WHERE part_id = ?`,
    partId,
  );
  if (!p) return null;
  const used = new Set<number>();
  const touch = (id: number | null): void => {
    if (id !== null) used.add(id);
  };

  const issues = all<IssueRow>(db, `SELECT issue_id, severity, code, detail, source_id FROM data_issues WHERE part_id = ? ORDER BY severity, issue_id`, partId);

  const env = one<{
    a_mm: number; b_mm: number; c_mm: number | null; axis_labels_json: string | null; scope: string; source_id: number;
    evidence_text: string; verification_status: string; exact_variant_required: number; variant_sku: string | null;
  }>(db, `SELECT * FROM envelopes WHERE part_id = ?`, partId);
  touch(env?.source_id ?? null);

  const dims = all<{
    kind: string; scope: string; values_mm_json: string; axis_labels_json: string | null; extraction_status: string;
    evidence_text: string; notes: string | null; source_id: number;
  }>(db, `SELECT kind, scope, values_mm_json, axis_labels_json, extraction_status, evidence_text, notes, source_id FROM measurements WHERE part_id = ? ORDER BY kind, scope, measurement_id`, partId).map((m) => {
    touch(m.source_id);
    return {
      kind: m.kind,
      scope: m.scope,
      values_mm: parseValues(m.values_mm_json),
      axis_labels: parseLabels(m.axis_labels_json),
      extraction_status: m.extraction_status,
      evidence: clip(m.evidence_text, 160),
      notes: m.notes,
      source_id: m.source_id,
      flagged_by: issues
        .filter((i) => DIMENSION_ISSUE.test(i.code) && (i.source_id === null || i.source_id === m.source_id))
        .map((i) => i.code),
    };
  });

  const pins = all<{
    connector: string; pin_number: string; name: string; electrical_type_as_source: string | null; functions_as_source: string; source_id: number; notes: string | null;
  }>(db, `SELECT connector, pin_number, name, electrical_type_as_source, functions_as_source, source_id, notes FROM pin_definitions WHERE part_id = ? ORDER BY connector, CAST(pin_number AS INTEGER), pin_id`, partId).map((r) => {
    touch(r.source_id);
    return { connector: r.connector, pin_number: r.pin_number, name: r.name, electrical_type: r.electrical_type_as_source, functions: r.functions_as_source, source_id: r.source_id, notes: r.notes };
  });

  const specRows = all<SpecRow>(db, `SELECT domain, key, value_text, value_num, minimum_num, maximum_num, unit, source_id FROM specifications WHERE part_id = ? AND domain != 'mechanical' ORDER BY spec_id`, partId);
  const seen = new Set<string>();
  const specs: ShowResult["specifications"] = [];
  for (const s of specRows) {
    const structured = s.key !== "feature" && SPEC_KEY.test(s.key);
    const fromText = s.key === "feature" && SPEC_TEXT.test(s.value_text);
    if (!structured && !fromText) continue;
    const id = `${s.key}|${s.value_text}`;
    if (seen.has(id)) continue;
    seen.add(id);
    touch(s.source_id);
    specs.push({ key: s.key, value: clip(s.value_text, 220), unit: s.unit, from: structured ? "spec" : "feature text", source_id: s.source_id });
    if (specs.length >= 30) break;
  }

  const listings = listingsFor(db, [partId], {}, new Map([[partId, p.name]]));
  listings.forEach((l) => touch(l.source_id));

  const rawAssets = all<{ kind: string; title: string | null; url: string; fetch_status: string; relative_path: string | null; local_status: string | null }>(
    db,
    `SELECT a.kind, a.title, a.url, a.fetch_status, f.relative_path, f.status AS local_status
     FROM assets a LEFT JOIN asset_files f ON f.url = a.url WHERE a.part_id = ? ORDER BY a.asset_id`,
    partId,
  );
  const counts: Record<string, number> = {};
  for (const a of rawAssets) counts[a.kind] = (counts[a.kind] ?? 0) + 1;
  const assets: ShowResult["assets"] = [];
  const rank = (k: string): number => (ASSET_ORDER.includes(k) ? ASSET_ORDER.indexOf(k) : 99);
  for (const kind of [...new Set(rawAssets.map((a) => a.kind))].sort((x, y) => rank(x) - rank(y))) {
    const ofKind = rawAssets.filter((a) => a.kind === kind);
    const prioritised = rank(kind) < 99;
    // Other kinds (photos, documentation pages) are listed only when a local copy exists.
    for (const a of ofKind) {
      const downloaded = a.local_status === "downloaded" && !!a.relative_path;
      if (!prioritised && !downloaded) continue;
      const localPath = downloaded ? join(cat.root, a.relative_path!) : null;
      const onDisk = localPath ? existsSync(localPath) : false;
      assets.push({
        kind,
        title: a.title,
        url: a.url,
        local_path: onDisk ? localPath : null,
        cache_state: onDisk ? "cached" : downloaded ? "downloaded per catalog but file missing on disk" : "not cached",
        fetch_status: a.fetch_status,
      });
    }
  }
  // Within a kind, cached files first; cap the uncached tail so the output stays readable.
  const capped: ShowResult["assets"] = [];
  const perKind = new Map<string, number>();
  for (const a of [...assets].sort((x, y) => rank(x.kind) - rank(y.kind) || Number(y.cache_state === "cached") - Number(x.cache_state === "cached"))) {
    const n = perKind.get(a.kind) ?? 0;
    if (n < ASSET_CAP || a.cache_state === "cached") capped.push(a);
    perKind.set(a.kind, n + 1);
  }

  const missing = notInCatalog({ hasEnv: !!env, env3: env?.c_mm != null, envScope: env?.scope ?? null, dims, pins, specs, db, partId, hasLocalDrawing: capped.some((a) => a.cache_state === "cached" && (a.kind === "mechanical_drawing" || a.kind === "cad_or_mechanical")) });
  issues.forEach((i) => touch(i.source_id));
  const sources = used.size
    ? all<SourceRef>(db, `SELECT source_id, url, publisher, authority, retrieved_at FROM sources WHERE source_id IN (${[...used].map(() => "?").join(",")}) ORDER BY source_id`, ...[...used])
    : [];

  return {
    part: p,
    selected_outline: env
      ? {
          values: [env.a_mm, env.b_mm, env.c_mm],
          labels: parseLabels(env.axis_labels_json),
          scope: env.scope,
          verification_status: env.verification_status,
          exact_variant_required: !!env.exact_variant_required,
          variant_sku: env.variant_sku,
          source_id: env.source_id,
          evidence: clip(env.evidence_text, 160),
        }
      : null,
    dimensions: dims,
    pins,
    specifications: specs,
    listings,
    assets: capped,
    asset_counts: counts,
    data_issues: issues,
    not_in_catalog: missing,
    sources,
  };
}

function notInCatalog(a: {
  hasEnv: boolean; env3: boolean; envScope: string | null; dims: ShowResult["dimensions"]; pins: ShowResult["pins"];
  specs: ShowResult["specifications"]; db: Database; partId: string; hasLocalDrawing: boolean;
}): string[] {
  const out: string[] = [];
  let padGeometry = 0;
  if (hasTable(a.db, "geometry_objects")) {
    padGeometry = one<{ n: number }>(a.db, `SELECT count(*) AS n FROM geometry_objects WHERE part_id = ?`, a.partId)?.n ?? 0;
  }
  if (padGeometry === 0) out.push("pad or pin centre coordinates (read them off the cached drawing or CAD, or ask the user to measure; do not invent them)");
  else out.push(`pad coordinates: ${padGeometry} geometry object(s) exist in the catalog's geometry_objects table; run: pads ${a.partId} to see which hold numeric pad centres (then import-part)`);
  if (!a.hasEnv) out.push("a selected whole-product or PCB outline (see the dimension observations, which may conflict or be partial)");
  else if (!a.env3) out.push(`a third dimension (the ${a.envScope} outline has two values; height unknown, not zero)`);
  if (a.envScope === "pcb") out.push("component and header heights (the outline is the bare board)");
  if (!a.dims.some((d) => d.kind.startsWith("mounting_hole"))) out.push("mounting hole positions");
  if (!a.pins.length) out.push("pin definitions");
  const has = (re: RegExp): boolean => a.specs.some((s) => re.test(s.key) || re.test(s.value));
  if (!has(/volt|spenning|vcc|supply/i)) out.push("a supply voltage range");
  if (!has(/current|str[øo]m|power_consumption/i)) out.push("supply current");
  if (!has(/logic|logikk/i)) out.push("logic level");
  if (!has(/0x[0-9a-f]{2}|i2c_address/i)) out.push("I2C address");
  out.push("physical verification (nothing in the catalog was measured or fit-tested)");
  out.push("opening positions for an enclosure (ports): derive them from the drawing");
  return out;
}

function formatShow(r: ShowResult): string {
  const L: string[] = [];
  const src = (id: number | null): string => (id === null ? "" : ` [S${id}]`);
  const p = r.part;
  L.push(`# ${p.part_id}: ${p.name}`);
  L.push(`brand: ${p.brand ?? "none recorded"} | manufacturer part number: ${p.manufacturer_part_number ?? "none"} | category: ${p.category}`);
  L.push(`identity: ${p.identity_scope} | geometry status: ${p.geometry_status} | primary page: ${p.primary_url}`);
  if (p.description) L.push(`description: ${clip(p.description, 300)}`);
  if (/supplier_specific|family|options|variants/.test(p.identity_scope)) {
    L.push("note: identity is supplier-specific or family-level. Do not carry this record's data over to a different board that merely shares a chip.");
  }

  L.push("", "## Selected outline (the catalog's own pick, a source claim)");
  if (r.selected_outline) {
    const o = r.selected_outline;
    L.push(`${fmtOutline(o)}${src(o.source_id)}; verification: ${o.verification_status}${o.exact_variant_required ? `; exact variant required${o.variant_sku ? ` (${o.variant_sku})` : ""}` : ""}`);
    L.push(`evidence: ${o.evidence}`);
  } else L.push("none selected (see observations below; the catalog withholds an outline when sources conflict or scope is unclear)");

  L.push("", `## Dimension observations (${r.dimensions.length}; source axis order kept, all mm)`);
  if (!r.dimensions.length) L.push("none");
  for (const d of r.dimensions) {
    const vals = d.values_mm.map((v, i) => (d.axis_labels?.[i] ? `${num(v)} ${d.axis_labels[i]}` : num(v))).join(" x ");
    const third = d.kind === "bounding_box" && d.values_mm.length === 2 ? " (two values: third dimension unknown)" : "";
    L.push(
      `${d.kind} | scope ${d.scope} | ${vals}${third}${d.axis_labels ? "" : " | axes unlabeled"} | ${d.extraction_status}${src(d.source_id)}${
        d.flagged_by.length ? ` | FLAGGED by data issue: ${[...new Set(d.flagged_by)].join(", ")}` : ""
      }`,
    );
    L.push(`    evidence: ${d.evidence}`);
  }

  L.push("", `## Pin definitions (${r.pins.length}, in catalog order; source claims, not wiring-verified)`);
  if (!r.pins.length) L.push("none");
  for (const x of r.pins) {
    L.push(`${x.connector} #${x.pin_number} | ${x.name} | ${x.electrical_type ?? "-"} | ${clip(x.functions, 120)}${src(x.source_id)}${x.notes && /conflict/i.test(x.notes) ? ` | note: ${clip(x.notes, 100)}` : ""}`);
  }

  L.push("", "## Specifications relevant to electrical checks (source claims)");
  if (!r.specifications.length) L.push("none found");
  for (const s of r.specifications) L.push(`${s.key}${s.unit ? ` (${s.unit})` : ""}: ${s.value} (${s.from})${src(s.source_id)}`);

  L.push("", `## Listings (${r.listings.length}; candidates to check, not recommendations)`);
  if (!r.listings.length) L.push("none");
  for (const l of r.listings.slice(0, 12)) L.push(formatListing(l));
  if (r.listings.length > 12) L.push(`... ${r.listings.length - 12} more; run: listings ${r.part.part_id}`);

  L.push("", "## Cached drawings, pinouts, CAD and other references (pinout and mechanical drawing first)");
  if (!r.assets.length) L.push("none recorded");
  for (const a of r.assets) {
    L.push(`${a.kind} | ${a.cache_state === "cached" ? `LOCAL ${a.local_path}` : `${a.cache_state.toUpperCase()}: ${a.url}`}${a.title ? ` | ${clip(a.title, 80)}` : ""}${a.cache_state === "cached" ? ` | origin ${a.url}` : ` | fetch: ${a.fetch_status}`}`);
  }
  L.push(`asset counts by kind: ${Object.entries(r.asset_counts).map(([k, v]) => `${k} ${v}`).join(", ") || "none"}`);

  L.push("", `## Data issues (${r.data_issues.length})`);
  if (!r.data_issues.length) L.push("none");
  const notes = r.data_issues.filter((i) => i.code === "source_note");
  for (const i of r.data_issues.filter((x) => x.code !== "source_note")) L.push(`${i.severity} ${i.code}: ${clip(i.detail, 240)}${src(i.source_id)}`);
  if (notes.length) L.push(`${notes.length} source_note issue(s) omitted from this view (use --json)`);

  L.push("", "## Not in the catalog for this part (do not invent)");
  for (const m of r.not_in_catalog) L.push(`- ${m}`);

  L.push("", "## Sources");
  for (const s of r.sources) L.push(`S${s.source_id} ${s.publisher} (${s.authority}) ${s.url} retrieved ${s.retrieved_at}`);
  return L.join("\n");
}

// ---------------------------------------------------------------------------------------
// listings

export interface ListingOut {
  part_id: string;
  part_name: string;
  shop: string;
  domestic_market: string | null;
  title: string;
  title_is_part_name: boolean;
  price: number | null;
  currency: string | null;
  price_basis: string;
  stock_status: string;
  /**
   * False when the stock is an assembly service's inventory (JLCPCB's parts library): the part is
   * fitted to a board the supplier builds and cannot be bought on its own. Such a listing is a price
   * for a PCB order, never a line on a shopping list.
   */
  sold_loose: boolean;
  url: string;
  observed_at: string;
  identity_match: string;
  shipping_to_norway: string;
  source_id: number;
}

/** Stock held for an assembly service, by the catalog's own status text ("in_stock_assembly_inventory"). */
const ASSEMBLY_STOCK = /assembl/i;

function listingsFor(db: Database, ids: string[], opts: { norway?: boolean; limit?: number }, names: Map<string, string>): ListingOut[] {
  if (!ids.length) return [];
  const rows = all<{
    part_id: string; supplier: string; url: string; supplier_sku: string | null; identity_match: string; domestic_market: string | null;
    currency: string | null; price: number | null; price_basis: string; stock_status: string; observed_at: string; shipping_to_norway: string; source_id: number;
  }>(
    db,
    `SELECT part_id, supplier, url, supplier_sku, identity_match, domestic_market, currency, price, price_basis, stock_status, observed_at, shipping_to_norway, source_id
     FROM listings WHERE part_id IN (${ids.map(() => "?").join(",")}) ${opts.norway ? "AND domestic_market = 'NO'" : ""}
     ORDER BY (domestic_market = 'NO') DESC, supplier, part_id, listing_id`,
    ...ids,
  );
  const variants = all<{ part_id: string; supplier: string; sku: string | null; title: string }>(
    db,
    `SELECT part_id, supplier, sku, title FROM variants WHERE part_id IN (${ids.map(() => "?").join(",")})`,
    ...ids,
  );
  const out = rows.map((r): ListingOut => {
    const found = r.supplier_sku ? variants.find((x) => x.part_id === r.part_id && x.supplier === r.supplier && x.sku === r.supplier_sku) : undefined;
    // Shopify's placeholder variant title says nothing; fall back to the part name.
    const v = found && !/^default title$/i.test(found.title) ? found : undefined;
    return {
      part_id: r.part_id,
      part_name: names.get(r.part_id) ?? "",
      shop: r.supplier,
      domestic_market: r.domestic_market,
      title: v?.title ?? names.get(r.part_id) ?? r.part_id,
      title_is_part_name: !v,
      price: r.price,
      currency: r.currency,
      price_basis: r.price_basis,
      stock_status: r.stock_status,
      sold_loose: !ASSEMBLY_STOCK.test(r.stock_status),
      url: r.url,
      observed_at: r.observed_at,
      identity_match: r.identity_match,
      shipping_to_norway: r.shipping_to_norway,
      source_id: r.source_id,
    };
  });
  // Places a builder can buy from come first, so a limit never keeps an assembly-only line over a shop.
  out.sort((a, b) => Number(b.sold_loose) - Number(a.sold_loose));
  return opts.limit ? out.slice(0, opts.limit) : out;
}

export function formatListing(l: ListingOut): string {
  const stock = l.sold_loose ? l.stock_status : "NOT SOLD LOOSE: assembly-service stock, fitted to a board the supplier builds; not for a shopping list";
  return `${l.shop}${l.domestic_market === "NO" ? " (NO)" : ""} | ${l.price === null ? "no price" : `${num(l.price)} ${l.currency ?? "?"}`} | ${stock} | ${clip(l.title, 90)}${
    l.title_is_part_name ? " (catalog part name)" : ""
  } | ${l.url} | observed ${l.observed_at.slice(0, 10)}`;
}

export function listings(db: Database, query: string, opts: { norway?: boolean; limit?: number }): { parts: { part_id: string; name: string }[]; listings: ListingOut[]; loose: boolean } {
  const exact = one<{ part_id: string; name: string }>(db, `SELECT part_id, name FROM parts WHERE part_id = ?`, query);
  let loose = false;
  let ids: string[];
  if (exact) ids = [exact.part_id];
  else {
    const s = searchIds(db, query, 25);
    ids = s.ids;
    loose = s.loose;
  }
  const names = new Map<string, string>();
  for (let i = 0; i < ids.length; i += 200) {
    const chunk = ids.slice(i, i + 200);
    for (const r of all<{ part_id: string; name: string }>(db, `SELECT part_id, name FROM parts WHERE part_id IN (${chunk.map(() => "?").join(",")})`, ...chunk)) names.set(r.part_id, r.name);
  }
  return {
    parts: ids.map((id) => ({ part_id: id, name: names.get(id) ?? "" })),
    listings: listingsFor(db, ids, opts, names),
    loose,
  };
}

const LISTING_NOTICE =
  "Candidates to check, not recommendations. Prices are point-in-time seller claims: VAT, shipping and variant choice are not normalised, and stock and shipping to Norway are not verified. A listing for a generic module says nothing about the size of the unit you will receive.";

// ---------------------------------------------------------------------------------------
// check-library

export interface Identity {
  /** branded: the part file describes a named manufacturer's board. clone: a generic module sold by many sellers. */
  nature: "branded" | "clone";
  /** branded only: manufacturer regex tested against catalog brand and name. */
  brand?: RegExp;
  /** Must match the catalog name or manufacturer part number. */
  model: RegExp;
  /** A catalog record matching this is a different part with a similar name. */
  reject?: RegExp;
}

export const LIBRARY_IDENTITY: Record<string, Identity> = {
  "active-buzzer-module": { nature: "clone", model: /active\s+buzzer|aktiv\w*\s+buzzer/i, reject: /passive|passiv/i },
  "battery-holder-18650": { nature: "clone", model: /18650.{0,30}(holder|batteriholder)|(holder|batteriholder).{0,30}18650/i },
  "bme280-breakout": { nature: "clone", model: /BME280/i, reject: /feather|esp32|shield|multi-?sensor|stick|BME680|BMP280\s+and|combo/i },
  "dht22-module": { nature: "clone", model: /DHT22|AM2302/i },
  "esp32-c3-supermini": { nature: "clone", model: /ESP32-?C3.{0,40}super\s?mini|super\s?mini.{0,40}ESP32-?C3/i },
  "esp32-devkit-v1": { nature: "clone", model: /DevKit\s*V1|DOIT.{0,20}DevKit/i },
  "esp32-s3-devkitc-1": { nature: "branded", brand: /espressif/i, model: /ESP32-S3-DevKitC-1/i },
  "hc-sr04": { nature: "clone", model: /HC-?SR04/i },
  "hc-sr501-pir": { nature: "clone", model: /HC-?SR501/i },
  "inmp441-mic": { nature: "clone", model: /INMP441/i },
  "led-5mm": { nature: "clone", model: /\b5\s?mm\b.{0,25}\bLED\b|\bLED\b.{0,25}\b5\s?mm\b/i, reject: /strip|matrix|display|module|modul|sortiment|assort|kit|pakning|pack|\d+[\s-]?stk|\brgb\b/i },
  "lipo-1s-cell": { nature: "clone", model: /(lipo|li-?po).{0,40}1000\s?mAh|1000\s?mAh.{0,40}(lipo|li-?po)/i },
  "max98357a-breakout": { nature: "clone", model: /MAX98357/i },
  "mpu6050-gy521": { nature: "clone", model: /GY-?521|MPU-?6050/i },
  "pi-pico-w": { nature: "branded", brand: /raspberry\s*pi/i, model: /Pico\s*W\b/i, reject: /Pico\s*2/i },
  "relay-module-1ch": { nature: "clone", model: /relay.{0,40}\b(1|one|single|enkel)[\s-]*(ch|channel|kanal)|\b(1|one|single)[\s-]*(ch|channel|kanal).{0,40}relay/i },
  "resistor-axial": { nature: "clone", model: /(1\/4\s?W|0\.25\s?W).{0,30}(resistor|motstand)|(resistor|motstand).{0,30}(1\/4\s?W|0\.25\s?W)/i, reject: /sett|kit|assort|sortiment|\d+\s?stk/i },
  "ssd1306-oled-096-i2c": { nature: "clone", model: /(0[.,]96|SSD1306).{0,60}OLED|OLED.{0,60}(0[.,]96|SSD1306)/i, reject: /ESP32|utviklingskort|LCD|TFT|IPS|0[.,]66|XIAO|dongle|shield|colou?r/i },
  "rotary-encoder-ky040": { nature: "clone", model: /KY-?040/i },
  "sg90-servo": { nature: "clone", model: /SG-?90/i, reject: /MG-?90/i },
  "slide-switch-ss12d00": { nature: "clone", model: /SS-?12D00/i },
  "soil-probe-capacitive-v12": { nature: "clone", model: /capacitive.{0,30}soil|soil.{0,30}capacitive|kapasitiv.{0,30}(jord|fukt)/i },
  "speaker-40mm": { nature: "clone", model: /40\s?mm.{0,30}(speaker|h[øo]yttaler)|(speaker|h[øo]yttaler).{0,30}40\s?mm/i },
  "tactile-button-6mm": { nature: "clone", model: /(tactile|taktil\w*).{0,40}6\s?[x×]\s?6|6\s?[x×]\s?6.{0,40}(tactile|taktil|trykknapp)/i, reject: /9\.5\s?mm/i },
  "tactile-button-6mm-tall": { nature: "clone", model: /(tactile|taktil\w*).{0,60}6\s?[x×]\s?6.{0,60}9\.5|6\s?[x×]\s?6.{0,60}9\.5\s?mm/i },
  "tp4056-usbc-module": { nature: "clone", model: /TP4056/i },
  "ws2812b-strip": { nature: "clone", model: /WS2812B?.{0,40}(strip|stripe|list)|(strip|stripe|led-?list).{0,40}WS2812B?/i },
  "xiao-esp32-c3": { nature: "branded", brand: /seeed/i, model: /XIAO.{0,10}ESP32-?C3/i },
};

/** Used for a part file with no entry above: the first model-like token in its name. */
function fallbackIdentity(def: PartDef): Identity {
  const tok = def.name.split(/[\s,()]+/).find((t) => /\d/.test(t) && /[A-Za-z]/.test(t)) ?? def.name;
  return { nature: "clone", model: new RegExp(tok.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"), "i") };
}

export type Verdict = "agree" | "disagree" | "no evidence";
export interface CheckLine {
  topic: "outline" | "pins" | "supply";
  verdict: Verdict;
  detail: string;
  source_id: number | null;
  source_url: string | null;
}
export interface MatchOut {
  part_id: string;
  name: string;
  brand: string | null;
  identity_scope: string;
  kind: "exact" | "branded cousin";
  /** Plain-language reason this record is or is not evidence for the part file. */
  note: string;
  lines: CheckLine[];
}
export interface LibraryPartOut {
  id: string;
  name: string;
  confidence: string;
  nature: Identity["nature"];
  status: "exact" | "branded cousin only" | "none";
  summary: string;
  matches: MatchOut[];
}

const PLAIN_SCOPES = ["pcb", "assembly", "product_unspecified", "board_without_headers", "board_assembly_without_headers", "product_body_planform_height_unreported"];
const XY_ONLY_SCOPES = ["board_without_headers", "board_assembly_without_headers", "product_body_planform_height_unreported"];

function cmpAxes(file: number[], cat: number[], tol: number): { ok: boolean; text: string } {
  const f = [...file].sort((a, b) => b - a);
  const c = [...cat].sort((a, b) => b - a);
  const ok = f.every((v, i) => Math.abs(v - c[i]!) <= tol);
  return { ok, text: `file ${f.map(num).join(" x ")} vs catalog ${c.map(num).join(" x ")}` };
}

function compareOutline(def: PartDef, m: { values: number[]; scope: string }, tol: number): { verdict: Verdict; detail: string } | null {
  if (!PLAIN_SCOPES.includes(m.scope) || m.values.length < 2) return null;
  const v = m.values;
  const fileXY = [def.body.w, def.body.d];
  if (v.length === 2 || XY_ONLY_SCOPES.includes(m.scope)) {
    const catXY = v.length === 3 ? [...v].sort((a, b) => b - a).slice(0, 2) : v;
    const r = cmpAxes(fileXY, catXY, tol);
    const why = v.length === 2 ? "source gives two values, height unknown" : "source does not state a height";
    return { verdict: r.ok ? "agree" : "disagree", detail: `footprint (${m.scope}; ${why}): ${r.text} (tolerance ${tol} mm)` };
  }
  // Three values. A bare board is compared with the part file's PCB thickness, anything else with its tallest point.
  const fileH = m.scope === "pcb" ? def.body.h : def.maxHeight;
  const full = cmpAxes([...fileXY, fileH], v, tol);
  const xy = cmpAxes(fileXY, [...v].sort((a, b) => b - a).slice(0, 2), tol);
  if (full.ok) return { verdict: "agree", detail: `${m.scope}: ${full.text} (tolerance ${tol} mm; file height = ${m.scope === "pcb" ? "body.h" : "maxHeight"})` };
  const extra = m.scope === "product_unspecified" ? "; source does not say whether headers are included" : "";
  return {
    verdict: "disagree",
    detail: `${m.scope}: ${full.text} (tolerance ${tol} mm; file height = ${m.scope === "pcb" ? "body.h" : "maxHeight"}${xy.ok ? "; the footprint alone agrees, only the height differs" : ""}${extra})`,
  };
}

function normPin(s: string): string {
  let n = s.toUpperCase().replace(/\.\d+$/, "").replace(/^GPIO/, "").replace(/[\s_-]/g, "");
  if (n === "G" || n === "GROUND") n = "GND";
  return n;
}

function comparePins(def: PartDef, cat: { name: string }[]): { verdict: Verdict; detail: string } {
  if (!cat.length) return { verdict: "no evidence", detail: "catalog has no pin definitions for this record" };
  // Collapse repeated ground pins on both sides so a part file with GND.2 and a table with three GND rows compare.
  const dedupe = (xs: string[]): string[] => xs.filter((x, i) => x !== "GND" || xs.indexOf("GND") === i);
  const catSeq = dedupe(cat.map((c) => normPin(c.name)));
  const fileLabels = def.pins.map((p) => [p.name, ...(p.aliases ?? [])].map(normPin));
  // Each catalog pin is matched to the first file pin carrying that name or alias, in file order.
  const matchedIdx: number[] = [];
  const unmatchedCat: string[] = [];
  // Each file pin can answer one catalog pin: a second "3V3" row pairs with the file's "3V3.2".
  for (const c of catSeq) {
    const idx = fileLabels.findIndex((labels, i) => !matchedIdx.includes(i) && labels.includes(c));
    if (idx < 0) unmatchedCat.push(c);
    else matchedIdx.push(idx);
  }
  const unmatchedFile = def.pins
    .filter((p, i) => !matchedIdx.includes(i) && normPin(p.name) !== "GND")
    .map((p) => p.name);
  let monotone = 0;
  for (let i = 1; i < matchedIdx.length; i++) if (matchedIdx[i]! > matchedIdx[i - 1]!) monotone++;
  const orderOk = matchedIdx.length < 2 || monotone === matchedIdx.length - 1;
  const ok = !unmatchedCat.length && !unmatchedFile.length && orderOk;
  const detail = `names ${catSeq.length - unmatchedCat.length}/${catSeq.length} of the catalog's found in the file${
    unmatchedCat.length ? `; catalog-only: ${unmatchedCat.join(", ")}` : ""
  }${unmatchedFile.length ? `; file-only: ${unmatchedFile.join(", ")}` : ""}; order ${orderOk ? "same" : "differs"}. file: ${def.pins
    .map((p) => p.name)
    .join(" ")} | catalog: ${cat.map((c) => c.name).join(" ")}`;
  return { verdict: ok ? "agree" : "disagree", detail: clip(detail, 700) };
}

const SUPPLY_KEY = /^(operating_voltage|input_voltage|power_supply|supply_voltage|working_voltage|power_supply_voltage|driftsspenning|inngangsspenning|spenning|vcc|1_vcc|voltage)$/i;

function voltRange(s: SpecRow): { lo: number; hi: number } | null {
  if (s.unit === "V" && (s.minimum_num !== null || s.maximum_num !== null || s.value_num !== null)) {
    const lo = s.minimum_num ?? s.value_num ?? s.maximum_num!;
    return { lo, hi: s.maximum_num ?? s.value_num ?? lo };
  }
  const text = s.value_text.replace(/(\d),(\d)/g, "$1.$2");
  const r = /(\d+(?:\.\d+)?)\s*V?\s*(?:-|–|~|to|til)\s*(\d+(?:\.\d+)?)\s*V/i.exec(text);
  if (r) return { lo: Number(r[1]), hi: Number(r[2]) };
  const one1 = /(\d+(?:\.\d+)?)\s*V\b/i.exec(text);
  return one1 ? { lo: Number(one1[1]), hi: Number(one1[1]) } : null;
}

function filePowerRange(def: PartDef): { lo: number; hi: number } | null {
  const ins = def.pins.filter((p) => p.role === "power-in" && (p.minVolts !== undefined || p.volts !== undefined));
  if (!ins.length) return null;
  return {
    lo: Math.min(...ins.map((p) => p.minVolts ?? p.volts!)),
    hi: Math.max(...ins.map((p) => p.maxVolts ?? p.volts!)),
  };
}

function compareSupply(def: PartDef, specs: SpecRow[], srcUrl: (id: number) => string | null): CheckLine[] {
  const file = filePowerRange(def);
  const cand = specs.filter((s) => SUPPLY_KEY.test(s.key));
  if (!file) return [{ topic: "supply", verdict: "no evidence", detail: "the part file has no power-in pin with a voltage range", source_id: null, source_url: null }];
  if (!cand.length) return [{ topic: "supply", verdict: "no evidence", detail: `catalog has no supply-voltage specification (file: ${num(file.lo)} to ${num(file.hi)} V)`, source_id: null, source_url: null }];
  const lines: CheckLine[] = [];
  const seen = new Set<string>();
  for (const s of cand) {
    const r = voltRange(s);
    if (!r) continue;
    const key = `${r.lo}-${r.hi}`;
    if (seen.has(key)) continue;
    seen.add(key);
    const single = r.lo === r.hi;
    const ok = single ? file.lo - 0.01 <= r.lo && r.lo <= file.hi + 0.01 : Math.abs(r.lo - file.lo) <= 0.3 && Math.abs(r.hi - file.hi) <= 0.3;
    lines.push({
      topic: "supply",
      verdict: ok ? "agree" : "disagree",
      detail: `file ${num(file.lo)} to ${num(file.hi)} V vs catalog ${single ? `${num(r.lo)} V (single value; the spec may be the logic or nominal level)` : `${num(r.lo)} to ${num(r.hi)} V`} ("${clip(s.value_text, 80)}", key ${s.key})`,
      source_id: s.source_id,
      source_url: srcUrl(s.source_id),
    });
    if (lines.length >= 3) break;
  }
  return lines.length ? lines : [{ topic: "supply", verdict: "no evidence", detail: "catalog supply specs could not be read as a voltage", source_id: null, source_url: null }];
}

export function checkLibrary(
  cat: Catalog,
  libraryDir: string,
  opts: { identities?: Record<string, Identity>; tolerance?: number } = {},
): LibraryPartOut[] {
  const { db } = cat;
  const identities = opts.identities ?? LIBRARY_IDENTITY;
  const tol = opts.tolerance ?? DEFAULT_TOLERANCE_MM;
  const catalog = all<{ part_id: string; name: string; brand: string | null; manufacturer_part_number: string | null; identity_scope: string }>(
    db,
    `SELECT part_id, name, brand, manufacturer_part_number, identity_scope FROM parts`,
  );
  const srcCache = new Map<number, string | null>();
  const srcUrl = (id: number): string | null => {
    if (!srcCache.has(id)) srcCache.set(id, one<{ url: string }>(db, `SELECT url FROM sources WHERE source_id = ?`, id)?.url ?? null);
    return srcCache.get(id)!;
  };
  const files = readdirSync(libraryDir).filter((f) => f.endsWith(".json")).sort();
  const out: LibraryPartOut[] = [];
  for (const f of files) {
    const def = JSON.parse(readFileSync(join(libraryDir, f), "utf8")) as PartDef;
    const idn = identities[def.id] ?? fallbackIdentity(def);
    const exact: typeof catalog = [];
    const cousins: typeof catalog = [];
    for (const r of catalog) {
      const text = `${r.name} ${r.manufacturer_part_number ?? ""}`;
      if (!idn.model.test(text) || (idn.reject && idn.reject.test(text))) continue;
      if (idn.nature === "branded") {
        if (idn.brand!.test(`${r.brand ?? ""} ${r.name}`)) exact.push(r);
      } else if (r.brand) cousins.push(r);
      else exact.push(r);
    }
    const score = (r: { part_id: string }): number =>
      (one<{ n: number }>(db, `SELECT (SELECT count(*) FROM measurements WHERE part_id = ?1) + (SELECT count(*) FROM pin_definitions WHERE part_id = ?1) * 2 + (SELECT count(*) FROM specifications WHERE part_id = ?1) AS n`, r.part_id)?.n ?? 0);
    const rank = (rs: typeof catalog): typeof catalog => [...rs].sort((a, b) => score(b) - score(a)).slice(0, 3);
    const chosen = [
      ...rank(exact).map((r) => ({ r, kind: "exact" as const })),
      ...(exact.length ? [] : rank(cousins).slice(0, 2).map((r) => ({ r, kind: "branded cousin" as const }))),
    ];
    const matches: MatchOut[] = chosen.map(({ r, kind }) => {
      const lines: CheckLine[] = [];
      const ms = all<{ scope: string; values_mm_json: string; source_id: number; kind: string }>(db, `SELECT kind, scope, values_mm_json, source_id FROM measurements WHERE part_id = ? AND kind = 'bounding_box' ORDER BY measurement_id`, r.part_id);
      const seenObs = new Set<string>();
      for (const m of ms) {
        const cmp = compareOutline(def, { values: parseValues(m.values_mm_json), scope: m.scope }, tol);
        if (!cmp) continue;
        const k = `${m.scope}|${m.values_mm_json}`;
        if (seenObs.has(k)) continue;
        seenObs.add(k);
        lines.push({ topic: "outline", verdict: cmp.verdict, detail: cmp.detail, source_id: m.source_id, source_url: srcUrl(m.source_id) });
      }
      if (!lines.length) {
        const other = ms.length ? ` (observations exist only for scopes that are not comparable: ${[...new Set(ms.map((m) => m.scope))].join(", ")})` : "";
        lines.push({ topic: "outline", verdict: "no evidence", detail: `catalog has no comparable whole-product or PCB outline${other}`, source_id: null, source_url: null });
      }
      const pins = all<{ name: string; source_id: number }>(db, `SELECT name, source_id FROM pin_definitions WHERE part_id = ? ORDER BY connector, CAST(pin_number AS INTEGER), pin_id`, r.part_id);
      const pc = comparePins(def, pins);
      lines.push({ topic: "pins", verdict: pc.verdict, detail: pc.detail, source_id: pins[0]?.source_id ?? null, source_url: pins[0] ? srcUrl(pins[0].source_id) : null });
      const specs = all<SpecRow>(db, `SELECT domain, key, value_text, value_num, minimum_num, maximum_num, unit, source_id FROM specifications WHERE part_id = ?`, r.part_id);
      lines.push(...compareSupply(def, specs, srcUrl));
      let note: string;
      if (kind === "branded cousin") {
        note = `branded cousin: "${r.name}" (${r.brand}) is a different board from the generic part file; per the catalog README a branded board's data is not evidence for a clone, so every line below is informational only`;
        for (const l of lines) {
          l.detail = `${l.detail} [informational: cousin ${l.verdict}]`;
          l.verdict = "no evidence";
        }
      } else if (idn.nature === "clone") {
        note = "seller listing of the same generic model (brand unresolved); its numbers are a seller's claim for that listing, not a verified clone size";
      } else {
        note = r.brand ? "same manufacturer and model" : "same model by name; the brand is not recorded for this seller listing";
      }
      return { part_id: r.part_id, name: r.name, brand: r.brand, identity_scope: r.identity_scope, kind, note, lines };
    });
    const status: LibraryPartOut["status"] = exact.length ? "exact" : cousins.length ? "branded cousin only" : "none";
    const summary =
      status === "exact"
        ? `${exact.length} exact record(s)${idn.nature === "clone" ? " (generic seller listings)" : ""}${cousins.length ? `, ${cousins.length} branded cousin(s) ignored` : ""}`
        : status === "branded cousin only"
          ? `only ${cousins.length} branded cousin record(s); not evidence for this clone`
          : "no catalog record";
    out.push({ id: def.id, name: def.name, confidence: def.confidence, nature: idn.nature, status, summary, matches });
  }
  return out;
}

function formatCheck(res: LibraryPartOut[], tol: number): string {
  const L: string[] = [];
  const c = (s: LibraryPartOut["status"]): number => res.filter((r) => r.status === s).length;
  L.push(`check-library: ${res.length} part files | exact match ${c("exact")} | branded cousin only ${c("branded cousin only")} | none ${c("none")} | dimension tolerance ${tol} mm`);
  L.push("Exact for a generic module means a seller listing of the same model with no brand; for a named board it means same manufacturer and model. Report only; nothing was changed.");
  for (const r of res) {
    L.push("", `## ${r.id} (${r.confidence}, ${r.nature}): ${r.summary}`);
    for (const m of r.matches) {
      L.push(`match ${m.part_id} | ${m.brand ?? "no brand"} | ${clip(m.name, 90)} | ${m.identity_scope}`);
      L.push(`  ${m.note}`);
      for (const l of m.lines) L.push(`  [${l.verdict}] ${l.topic}: ${l.detail}${l.source_url ? ` | source ${l.source_url}` : ""}`);
    }
  }
  return L.join("\n");
}

// ---------------------------------------------------------------------------------------
// CLI

interface Args {
  cmd: string;
  pos: string[];
  db?: string;
  json: boolean;
  norway: boolean;
  includePcb: boolean;
  fits?: [number, number, number];
  limit?: number;
  tolerance?: number;
  geometry?: number;
  header?: string;
  cards?: string;
  pads: boolean;
  outline?: string;
  id?: string;
  out?: string;
  rot?: Rot;
  mirror: boolean;
  overwrite: boolean;
}

export function parseArgs(argv: string[]): Args {
  const a: Args = { cmd: "", pos: [], json: false, norway: false, includePcb: false, mirror: false, overwrite: false, pads: false };
  const need = (i: number, flag: string): string => {
    const v = argv[i];
    if (v === undefined) throw new ProjectError(`${flag} needs a value`);
    return v;
  };
  const number = (v: string, flag: string): number => {
    const n = Number(v);
    if (!Number.isFinite(n) || n <= 0) throw new ProjectError(`${flag} needs a positive number, got "${v}"`);
    return n;
  };
  for (let i = 0; i < argv.length; i++) {
    const t = argv[i]!;
    if (t === "--json") a.json = true;
    else if (t === "--norway") a.norway = true;
    else if (t === "--include-pcb") a.includePcb = true;
    else if (t === "--db") a.db = need(++i, t);
    else if (t === "--limit") a.limit = Math.floor(number(need(++i, t), t));
    else if (t === "--tolerance") a.tolerance = number(need(++i, t), t);
    else if (t === "--geometry") a.geometry = Math.floor(number(need(++i, t), t));
    else if (t === "--header") a.header = need(++i, t);
    else if (t === "--cards") a.cards = need(++i, t);
    else if (t === "--pads") a.pads = true;
    else if (t === "--outline") a.outline = need(++i, t);
    else if (t === "--id") a.id = need(++i, t);
    else if (t === "--out") a.out = need(++i, t);
    else if (t === "--mirror") a.mirror = true;
    else if (t === "--overwrite") a.overwrite = true;
    else if (t === "--rot") {
      const v = need(++i, t);
      if (!["0", "90", "180", "270"].includes(v)) throw new ProjectError(`--rot needs 0, 90, 180 or 270, got "${v}"`);
      a.rot = Number(v) as Rot;
    }
    else if (t === "--fits") {
      a.fits = [number(need(++i, t), t), number(need(++i, t), t), number(need(++i, t), t)];
    } else if (t.startsWith("--")) throw new ProjectError(`unknown option ${t}`);
    else if (!a.cmd) a.cmd = t;
    else a.pos.push(t);
  }
  return a;
}

const USAGE = `usage: bun catalog.ts <find|show|listings|check-library|pads|import-part> ... [--json] [--db <path>]
  find <text> [--norway] [--fits W D H] [--include-pcb] [--limit N]
  show <part_id>
  listings <part_id | text> [--norway] [--limit N]
  check-library [--tolerance MM]
  card <part_id> [--cards FILE]                 one pre-joined reference card (needs a card file, see references/catalog.md)
  cards <text> [--fits W D H] [--include-pcb] [--norway] [--pads] [--limit N] [--cards FILE]
  pads <part_id> [--geometry ID]
  import-part <part_id> --id NEW_ID --out FILE.json [--header REF[,REF...]] [--geometry ID] [--rot 0|90|180|270] [--mirror] [--outline x0,y0,x1,y1] [--overwrite]
    --header is optional: without it the pad groups the card generator classes as headers are taken (a module footprint: its contact rows)
    --header J1 takes every pad of J1; J1:1-7 or J1:1;3;5 takes those pad numbers only
    --outline is the board edge in the CAD file's own frame, for datasets with no outline of their own`;

/** The pad library reports user mistakes as PadsError; the CLI reports those as one clean line (exit 2). */
function padsOrUsage<T>(fn: () => T): T {
  try {
    return fn();
  } catch (e) {
    if (e instanceof PadsError) throw new ProjectError(e.message);
    throw e;
  }
}

const NO_CARDS = "No card file configured. Build one from the full catalog with: bun scripts/catalog-cards.ts build --src <full catalog> --out <file>, then pass --cards <file> or set BENCHTOP_CARDS. No card file is bundled with the skill.";

/** Folder of the full catalog when --db or BENCHTOP_CATALOG names one (not the bundled snapshot, which has no cached files). */
function fullCatalogRoot(db: string | undefined, env: string | undefined): string | null {
  const p = db ?? env;
  if (!p || !existsSync(resolve(p))) return null;
  try {
    const d = new Database(resolve(p), { readonly: true });
    try {
      return snapshotInfo(d) ? null : dirname(resolve(p));
    } finally {
      d.close();
    }
  } catch {
    return null;
  }
}

/** `card` and `cards`: thin wrappers over catalog-cards.ts, which owns the card format. */
function runCards(a: Args, env: Record<string, string | undefined>): void {
  const file = a.cards ?? env.BENCHTOP_CARDS;
  if (!file) throw new CatalogUnavailable(NO_CARDS);
  let db: Database;
  try {
    db = openCards(resolve(file));
  } catch (e) {
    throw new CatalogUnavailable(`${(e as Error).message}. ${NO_CARDS}`);
  }
  try {
    const text = a.pos.join(" ");
    if (a.cmd === "cards") {
      const res = findCards(db, text, { fits: a.fits, includePcb: a.includePcb, norway: a.norway, pads: a.pads, limit: a.limit });
      if (a.json) console.log(JSON.stringify(res, null, 2));
      else
        console.log(
          res.rows.length
            ? renderFind(res.rows, res.loose)
            : `no card matches "${text}" with these filters. That does not mean the part does not exist: the card file only covers the catalog it was built from (${file}). Try: find <text> on the catalog, loosen the filters, or rebuild the cards.`,
        );
      return;
    }
    const card = getCard(db, text);
    if (!card) {
      throw new ProjectError(
        `no card for "${text}" in ${file}. That does not mean the part does not exist: the card file only covers the catalog it was built from, and may be older than the catalog. Run: cards <text> to search, or rebuild with catalog-cards.ts build.`,
      );
    }
    if (a.json) {
      console.log(JSON.stringify(card, null, 2));
      return;
    }
    // Paths in a card are relative to the full catalog's folder; resolve them when that folder is known.
    const root = fullCatalogRoot(a.db, env.BENCHTOP_CATALOG);
    const shown: Card = root
      ? { ...card, references: card.references.map((r) => (r.path ? { ...r, path: `${join(root, r.path)}${existsSync(join(root, r.path)) ? "" : " (missing on disk)"}` } : r)) }
      : card;
    const lines = [renderCard(shown)];
    if (!root && card.references.some((r) => r.path)) {
      lines.push("", "LOCAL paths above are relative to the full catalog's folder; they need the full catalog. Point --db or BENCHTOP_CATALOG at it to print absolute paths.");
    }
    console.log(lines.join("\n"));
  } finally {
    db.close();
  }
}

export async function run(argv: string[], env: Record<string, string | undefined> = process.env): Promise<void> {
  const a = parseArgs(argv);
  if (!["find", "show", "listings", "check-library", "pads", "import-part", "card", "cards"].includes(a.cmd)) throw new ProjectError(USAGE);
  if (["find", "listings", "show", "pads", "import-part", "card"].includes(a.cmd) && a.pos.length === 0) throw new ProjectError(`${a.cmd} needs an argument\n${USAGE}`);
  // Cards live in their own file and need no catalog, so they are answered before the catalog is opened.
  if (a.cmd === "card" || a.cmd === "cards") return runCards(a, env);
  if (a.cmd === "import-part") {
    const lacking = [!a.id && "--id", !a.out && "--out"].filter(Boolean);
    if (lacking.length) throw new ProjectError(`import-part needs ${lacking.join(", ")}\n${USAGE}`);
  }
  const loc = resolveDbPath({ db: a.db, env: env.BENCHTOP_CATALOG, skillRoot: SKILL_ROOT });
  const cat = openCatalog(loc.path);
  try {
    const text = a.pos.join(" ");
    const hint = snapshotHint(cat.snapshot);
    // Human output starts with a line naming the snapshot; --json carries it as a `catalog` field instead.
    const out = (obj: object, plain: string, empty = false): void => {
      if (a.json) console.log(JSON.stringify({ catalog: cat.snapshot ? { path: cat.path, ...cat.snapshot } : { path: cat.path, bundled_snapshot: false }, ...(empty && hint ? { hint } : {}), ...obj }, null, 2));
      else console.log([cat.snapshot ? snapshotLine(cat.path, cat.snapshot) : "", plain, empty ? hint : ""].filter(Boolean).join("\n"));
    };
    const notFound = (e: unknown): never => {
      if (e instanceof ProjectError && hint && /no part with id/.test(e.message)) throw new ProjectError(`${e.message}\n${hint}`);
      throw e;
    };
    // The catalog may be rewritten while we read: retry the whole command once.
    if (a.cmd === "find") {
      const res = withRetry(() => find(cat.db, text, { norway: a.norway, fits: a.fits, includePcb: a.includePcb, limit: a.limit }));
      out({ query: text, loose_match: res.loose, hits: res.hits }, formatFind(res, text), res.hits.length === 0);
    } else if (a.cmd === "show") {
      const res = withRetry(() => show(cat, text));
      if (!res) return notFound(new ProjectError(`no part with id "${text}". Run: find <text> to get an exact id.`));
      out(res, formatShow(res));
    } else if (a.cmd === "listings") {
      const res = withRetry(() => listings(cat.db, text, { norway: a.norway, limit: a.limit ?? 30 }));
      const head = `${LISTING_NOTICE}\nparts searched: ${res.parts.length}${res.loose ? " (any-word match)" : ""}${res.parts.length > 1 ? ` (${res.parts.slice(0, 5).map((p) => p.part_id).join(", ")}${res.parts.length > 5 ? ", ..." : ""})` : ""}`;
      out({ notice: LISTING_NOTICE, ...res }, res.listings.length ? `${head}\n${res.listings.map(formatListing).join("\n")}` : `${head}\nno listings${a.norway ? " in Norway" : ""} for "${text}"`, res.listings.length === 0);
    } else if (a.cmd === "pads") {
      let res: ReturnType<typeof describePads>;
      try {
        res = withRetry(() => padsOrUsage(() => describePads(cat.db, cat.root, text, a.geometry)));
      } catch (e) {
        return notFound(e);
      }
      out(res, formatPads(res), res.datasets.length === 0);
    } else if (a.cmd === "import-part") {
      const outFile = resolve(a.out!);
      if (existsSync(outFile) && !a.overwrite) throw new ProjectError(`${outFile} exists; pass --overwrite to replace it`);
      let res: ReturnType<typeof importPart>;
      try {
        res = withRetry(() =>
          padsOrUsage(() =>
            importPart(cat.db, cat.root, {
              partId: text,
              headers: a.header ? parseHeaderSpecs(a.header) : undefined,
              id: a.id!,
              geometryId: a.geometry,
              rot: a.rot,
              mirror: a.mirror,
              outline: a.outline ? parseOutlineArg(a.outline) : undefined,
              fileName: basename(outFile),
            }),
          ),
        );
      } catch (e) {
        return notFound(e);
      }
      mkdirSync(dirname(outFile), { recursive: true });
      writeFileSync(outFile, `${JSON.stringify(res.part, null, 2)}\n`);
      out({ file: outFile, ...res }, formatImport(res, outFile));
    } else {
      const tol = a.tolerance ?? DEFAULT_TOLERANCE_MM;
      const res = withRetry(() => checkLibrary(cat, LIBRARY_DIR, { tolerance: tol }));
      out(
        {
          summary: { exact: res.filter((r) => r.status === "exact").length, branded_cousin_only: res.filter((r) => r.status === "branded cousin only").length, none: res.filter((r) => r.status === "none").length, tolerance_mm: tol },
          parts: res,
        },
        formatCheck(res, tol),
      );
    }
  } finally {
    cat.db.close();
  }
}

if (import.meta.main) {
  await main(async () => {
    try {
      await run(process.argv.slice(2));
    } catch (e) {
      if (e instanceof CatalogUnavailable) {
        console.log(e.message);
        process.exit(3);
      }
      throw e;
    }
  });
}
