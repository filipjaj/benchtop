#!/usr/bin/env bun
// Derive the public, redistributable parts catalog from a catalog snapshot (or the full catalog).
//
// The public catalog keeps facts a manufacturer published about its own product, each with
// the URL it came from, and drops everything taken from a retailer. The rules:
//   1. Parts: only parts identified by their maker (not a retailer's listing id, not a
//      "supplier-specific, manufacturer unresolved" record) whose primary source is the
//      manufacturer's own documentation or CAD.
//   2. Facts (specifications, pins, dimensions, pad geometry, document links) are kept only
//      when their source is the manufacturer. Retailer-sourced facts are dropped, even for
//      kept parts: a systematic copy of a shop's catalog is what the EEA database right
//      protects, whatever the copyright status of the single facts.
//   3. No copied prose: part descriptions, evidence quotes, source text and source notes are
//      emptied, and specification values that read as text rather than a value (over MAX_VALUE
//      characters or MAX_WORDS words, or a PROSE_KEYS key such as "feature") are dropped.
//   4. No commercial data: prices, stock, listings, variants, market evidence and the
//      curation ranking (built from retailer stock and popularity) are removed. Parts are
//      ranked alphabetically instead.
//   5. Sources keep url, publisher, type, authority, retrieval date and content hash: the
//      citation, never the content.
// The schema is unchanged, so scripts/catalog.ts reads the result as it reads the snapshot.
//
// Usage:
//   bun catalog-public.ts --src <maker_catalog.sqlite> --out <maker_catalog.public.sqlite>
// The source is opened read-only. Exit codes: 0 ok, 2 usage error, 3 source missing or
// unexpected schema, 4 result failed checks.

import { Database } from "bun:sqlite";
import { copyFileSync, existsSync, renameSync, rmSync } from "node:fs";
import { resolve } from "node:path";

export const PUBLIC_BUILDER_VERSION = "2";

/** Source authorities whose facts are kept: the manufacturer's own claims, documents and CAD. */
export const KEEP_AUTHORITIES = [
  "manufacturer_claim",
  "manufacturer_primary",
  "manufacturer_source_reference",
  "derived_from_manufacturer_cad",
];

/** Specification values longer than this, or with more words than MAX_WORDS, are descriptive text, not a value. */
export const MAX_VALUE = 160;
export const MAX_WORDS = 15;
/** Specification keys that hold marketing sentences or page callouts rather than values. */
export const PROSE_KEYS = ["feature", "pdf_page1_visible_callout"];
const words = (col: string) => `(length(trim(${col})) - length(replace(trim(${col}), ' ', '')) + 1)`;
const proseSpec = `(length(value_text) > ${MAX_VALUE} OR ${words("value_text")} > ${MAX_WORDS} OR key IN (${PROSE_KEYS.map((k) => `'${k}'`).join(",")}))`;

/**
 * What happens to each table. A table missing from this map stops the build, so a table added
 * to the catalog later is a decision someone makes, not a silent leak.
 *   facts   rows of kept parts whose source is a kept authority; evidence_text emptied when present
 *   part    rows of kept parts
 *   drop    all rows deleted (schema kept)
 *   custom  handled by name below
 */
const PLAN: Record<string, "facts" | "part" | "drop" | "custom"> = {
  metadata: "custom",
  sources: "custom",
  parts: "custom",
  specifications: "custom",
  measurements: "facts",
  envelopes: "facts",
  pin_definitions: "facts",
  geometry_objects: "facts",
  assets: "facts",
  family_memberships: "part",
  data_issues: "custom",
  variants: "drop",
  listings: "drop",
  listing_observations: "drop",
  purchase_links: "drop",
  manufacturer_market_links: "drop",
  marketplace_observations: "drop",
  market_evidence: "drop",
  popularity_signals: "drop",
  initial_selection: "drop",
  geometry_reviews: "drop",
  derived_assets: "drop",
  asset_files: "drop",
  source_captures: "drop",
  parts_fts: "custom",
};

/** Metadata keys carried over; the rest describe the retailer-based curation and are removed. */
const KEEP_META = [
  "schema_version", "schema_compatibility_policy", "coordinate_payload_schema_version",
  "coordinate_policy", "geometry_policy", "physical_scope", "canonical_voltage_selection_rule",
  "bundle_kind", "bundle_builder_version", "bundle_source_sha256", "bundle_source_created_at_utc",
  "bundle_source_part_count",
];

export const LICENSE_NOTE =
  "Facts (dimensions, pin assignments, voltages, pad coordinates) as published by each part's manufacturer, " +
  "with the source URL for every value. Compilation released under CC BY 4.0. No text, images, CAD files or " +
  "retailer data are included. Product and brand names belong to their owners and are used only to identify parts.";

function fail(code: number, msg: string): never {
  console.error(msg);
  process.exit(code);
}

function tables(db: Database): string[] {
  return db
    .query<{ name: string }, []>(
      `SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%' AND name NOT LIKE 'parts_fts_%' ORDER BY name`,
    )
    .all()
    .map((r) => r.name);
}

function columns(db: Database, table: string): string[] {
  return db.query<{ name: string }, []>(`SELECT name FROM pragma_table_info('${table}')`).all().map((r) => r.name);
}

/** Prefix of the data_issues notes that hold a raw page capture. */
export const CAPTURE_PREFIX = "Source capture metadata:";

/** An absolute path on the machine that built the catalog: POSIX home/temp dirs or a Windows drive. */
const LOCAL_PATH = /(?:\/(?:Users|home|private|tmp|var\/folders)\/|\b[A-Za-z]:\\)[^"\s,}]*/g;
/** SQL test for the same, used by the audit over every text column. */
const LOCAL_PATH_SQL = (col: string) =>
  `(${col} LIKE '%/Users/%' OR ${col} LIKE '%/home/%' OR ${col} LIKE '%/private/%' OR ${col} LIKE '%/var/folders/%')`;

/** Drops every JSON member whose string value is a local path; other strings get the path replaced. */
export function stripLocalPaths(text: string): string {
  const isLocal = (v: unknown) => typeof v === "string" && new RegExp(`^${LOCAL_PATH.source}$`).test(v);
  const clean = (v: unknown): unknown => {
    if (Array.isArray(v)) return v.filter((x) => !isLocal(x)).map(clean);
    if (v && typeof v === "object") {
      return Object.fromEntries(Object.entries(v).filter(([, x]) => !isLocal(x)).map(([k, x]) => [k, clean(x)]));
    }
    return typeof v === "string" ? v.replace(LOCAL_PATH, "<local file>") : v;
  };
  // A detail may be "Label: {json}"; clean the JSON part as JSON so no key is left with a dangling value.
  const brace = text.indexOf("{");
  if (brace >= 0) {
    try {
      return text.slice(0, brace) + JSON.stringify(clean(JSON.parse(text.slice(brace))));
    } catch {
      // Not JSON after all: fall through to plain replacement.
    }
  }
  return text.replace(LOCAL_PATH, "<local file>");
}

function scrubLocalPaths(db: Database, table: string, key: string, col: string): void {
  const rows = db.query<Record<string, string | number>, []>(`SELECT "${key}" AS k, "${col}" AS v FROM "${table}" WHERE ${LOCAL_PATH_SQL(`"${col}"`)} OR "${col}" GLOB '*[A-Za-z]:\\*'`).all();
  const update = db.prepare(`UPDATE "${table}" SET "${col}" = ? WHERE "${key}" = ?`);
  for (const r of rows) {
    const next = stripLocalPaths(String(r.v));
    if (next !== r.v) update.run(next, r.k);
  }
}

export interface PublicReport {
  parts_in: number;
  parts_out: number;
  rows: Record<string, { before: number; after: number }>;
}

/** Rewrites `db` in place into the public subset. Exported for tests. */
export function makePublic(db: Database): PublicReport {
  const names = tables(db);
  const unplanned = names.filter((n) => !(n in PLAN));
  if (unplanned.length) throw new Error(`no rule for table(s): ${unplanned.join(", ")}; add them to PLAN in catalog-public.ts`);
  const count = (t: string) => db.query<{ n: number }, []>(`SELECT count(*) AS n FROM "${t}"`).get()!.n;
  const before = Object.fromEntries(names.map((n) => [n, count(n)]));

  const auth = KEEP_AUTHORITIES.map((a) => `'${a}'`).join(",");
  const keptSource = (col: string) => `${col} IN (SELECT source_id FROM sources WHERE authority IN (${auth}))`;

  db.exec("BEGIN");
  // 1. Parts.
  db.exec(`DELETE FROM parts WHERE NOT (
      ${keptSource("primary_source_id")}
      AND identity_scope <> 'supplier_specific_product_manufacturer_unresolved'
      AND instr(substr(part_id, 1, instr(part_id, ':') - 1), '.') = 0)`);
  const partScoped = (t: string) => `DELETE FROM "${t}" WHERE part_id NOT IN (SELECT part_id FROM parts)`;

  for (const [t, rule] of Object.entries(PLAN)) {
    if (!names.includes(t)) continue;
    if (rule === "drop") db.exec(`DELETE FROM "${t}"`);
    if (rule === "part") db.exec(partScoped(t));
    if (rule === "facts") {
      db.exec(partScoped(t));
      db.exec(`DELETE FROM "${t}" WHERE NOT ${keptSource("source_id")}`);
      if (columns(db, t).includes("evidence_text")) db.exec(`UPDATE "${t}" SET evidence_text = ''`);
    }
  }

  // 2. Specifications: facts plus the length rule.
  db.exec(partScoped("specifications"));
  db.exec(`DELETE FROM specifications WHERE NOT ${keptSource("source_id")} OR ${proseSpec}`);
  db.exec(`UPDATE specifications SET evidence_text = ''`);

  // 3. Data issues are our own findings; keep those about kept parts that cite no retailer.
  //    Capture-metadata notes carry the scraped page itself (text, JSON-LD, prices): never ours to publish.
  db.exec(`DELETE FROM data_issues WHERE part_id IS NULL OR part_id NOT IN (SELECT part_id FROM parts)
           OR (source_id IS NOT NULL AND NOT ${keptSource("source_id")})
           OR detail LIKE '${CAPTURE_PREFIX}%'`);
  scrubLocalPaths(db, "data_issues", "issue_id", "detail");
  if (names.includes("geometry_objects")) scrubLocalPaths(db, "geometry_objects", "geometry_id", "payload_json");

  // 4. Part rows: no prose, no curation. selection_rank is UNIQUE, so renumber through negatives.
  db.exec(`UPDATE parts SET description = NULL, supplier_category = NULL, selection_score = 0,
           selection_reason = 'public catalog: ranked by name, not by popularity'`);
  db.exec(`UPDATE parts SET selection_rank = -selection_rank`);
  db.exec(`UPDATE parts SET selection_rank = (SELECT count(*) FROM parts q WHERE lower(q.name) || q.part_id <= lower(parts.name) || parts.part_id)`);

  // 5. Sources: only those still cited, and only the citation.
  const citing = names
    .filter((t) => t !== "sources" && columns(db, t).includes("source_id"))
    .map((t) => `SELECT source_id FROM "${t}" WHERE source_id IS NOT NULL`);
  citing.push(`SELECT primary_source_id FROM parts`);
  db.exec(`DELETE FROM sources WHERE source_id NOT IN (${citing.join(" UNION ")})`);
  db.exec(`UPDATE sources SET source_text = '', notes = NULL`);

  // 6. Search index rebuilt from what is left.
  if (names.includes("parts_fts")) {
    db.exec(`DELETE FROM parts_fts`);
    db.exec(`INSERT INTO parts_fts(part_id, name, brand, category, families, specifications)
      SELECT p.part_id, p.name, coalesce(p.brand, ''), p.category,
        coalesce((SELECT group_concat(family, ' ') FROM family_memberships f WHERE f.part_id = p.part_id), ''),
        coalesce((SELECT group_concat(key || ' ' || value_text, ' ; ') FROM specifications s WHERE s.part_id = p.part_id), '')
      FROM parts p ORDER BY p.part_id`);
    db.exec(`INSERT INTO parts_fts(parts_fts) VALUES('optimize')`);
  }

  // 7. Metadata.
  db.exec(`DELETE FROM metadata WHERE key NOT IN (${KEEP_META.map((k) => `'${k}'`).join(",")})`);
  const partsOut = count("parts");
  const setMeta = db.prepare(`INSERT OR REPLACE INTO metadata(key, value) VALUES (?, ?)`);
  setMeta.run("title", "Benchtop public parts catalog: manufacturer-published facts with sources");
  setMeta.run("bundle_part_count", String(partsOut));
  setMeta.run("bundle_public", "1");
  setMeta.run("public_builder_version", PUBLIC_BUILDER_VERSION);
  setMeta.run("public_kept_authorities", KEEP_AUTHORITIES.join(","));
  setMeta.run("license", LICENSE_NOTE);
  db.exec("COMMIT");

  const rows = Object.fromEntries(names.map((n) => [n, { before: before[n]!, after: count(n) }]));
  return { parts_in: before.parts!, parts_out: partsOut, rows };
}

/** Checks the result holds no retailer data or prose. Returns the problems found. */
export function auditPublic(db: Database): string[] {
  const problems: string[] = [];
  const n = (sql: string) => db.query<{ n: number }, []>(sql).get()!.n;
  const auth = KEEP_AUTHORITIES.map((a) => `'${a}'`).join(",");
  for (const [t, rule] of Object.entries(PLAN)) {
    if (rule === "drop" && tables(db).includes(t) && n(`SELECT count(*) AS n FROM "${t}"`) > 0) problems.push(`${t} is not empty`);
  }
  if (n(`SELECT count(*) AS n FROM sources WHERE authority NOT IN (${auth})`)) problems.push("a source with a non-manufacturer authority is cited");
  if (n(`SELECT count(*) AS n FROM sources WHERE source_text <> '' OR notes IS NOT NULL`)) problems.push("source text or notes retained");
  if (n(`SELECT count(*) AS n FROM parts WHERE description IS NOT NULL`)) problems.push("part descriptions retained");
  if (n(`SELECT count(*) AS n FROM parts WHERE instr(substr(part_id, 1, instr(part_id, ':') - 1), '.') > 0`)) problems.push("a retailer-keyed part remains");
  for (const t of ["specifications", "measurements", "envelopes", "pin_definitions"]) {
    if (tables(db).includes(t) && n(`SELECT count(*) AS n FROM "${t}" WHERE evidence_text <> ''`)) problems.push(`${t}.evidence_text retained`);
  }
  if (n(`SELECT count(*) AS n FROM specifications WHERE ${proseSpec}`)) problems.push("descriptive specification text retained");
  if (n(`SELECT count(*) AS n FROM data_issues WHERE detail LIKE '${CAPTURE_PREFIX}%'`)) problems.push("raw page captures retained in data_issues");
  // Every text column of every table: no local paths, no scraped JSON-LD or offers.
  for (const t of tables(db)) {
    const textCols = db
      .query<{ name: string; type: string }, []>(`SELECT name, type FROM pragma_table_info('${t}')`)
      .all()
      .filter((c) => c.type === "" || /TEXT|CHAR|CLOB/i.test(c.type))
      .map((c) => `"${c.name}"`);
    for (const c of textCols) {
      if (n(`SELECT count(*) AS n FROM "${t}" WHERE ${LOCAL_PATH_SQL(c)}`)) problems.push(`${t}.${c.replaceAll('"', "")} holds a local file path`);
      if (n(`SELECT count(*) AS n FROM "${t}" WHERE ${c} LIKE '%"@context"%' OR ${c} LIKE '%"offers"%'`)) problems.push(`${t}.${c.replaceAll('"', "")} holds scraped product JSON-LD`);
    }
  }
  return problems;
}

if (import.meta.main) {
  const args = process.argv.slice(2);
  const get = (flag: string) => {
    const i = args.indexOf(flag);
    return i >= 0 ? args[i + 1] : undefined;
  };
  const src = get("--src") ?? process.env.BENCHTOP_CATALOG;
  const out = get("--out");
  if (!src || !out) fail(2, "usage: bun catalog-public.ts --src <maker_catalog.sqlite> --out <public.sqlite>");
  const srcPath = resolve(src);
  const outPath = resolve(out);
  if (!existsSync(srcPath)) fail(3, `source not found: ${srcPath}`);
  const tmp = `${outPath}.tmp`;
  rmSync(tmp, { force: true });
  copyFileSync(srcPath, tmp);
  const db = new Database(tmp);
  let report: PublicReport;
  try {
    report = makePublic(db);
  } catch (e) {
    db.close();
    rmSync(tmp, { force: true });
    fail(3, e instanceof Error ? e.message : String(e));
  }
  const problems = auditPublic(db);
  db.exec("VACUUM");
  db.close();
  if (problems.length) {
    rmSync(tmp, { force: true });
    fail(4, `public catalog failed checks:\n- ${problems.join("\n- ")}`);
  }
  renameSync(tmp, outPath);
  console.log(`${outPath}: ${report.parts_out} of ${report.parts_in} parts`);
  for (const [t, r] of Object.entries(report.rows)) if (r.before) console.log(`  ${t.padEnd(26)} ${String(r.before).padStart(6)} -> ${r.after}`);
}
