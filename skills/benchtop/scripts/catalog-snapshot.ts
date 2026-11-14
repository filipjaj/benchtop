#!/usr/bin/env bun
// Build a small snapshot of the maker parts catalog for bundling with the skill.
//
// The snapshot has the same schema as the full catalog (same tables, views, indexes, same
// PRAGMA user_version), so scripts/catalog.ts reads it unchanged. It differs in three ways:
//   1. Fewer parts: the curated selection plus every part with pad geometry or pin
//      definitions, plus any part ids passed with --include.
//   2. No retained source text and no cached files: sources keep url/publisher/hash, and
//      asset rows keep their url. Nothing under references/ is copied.
//   3. Geometry payloads keep what the skill reads (pad coordinates and identifiers, outline
//      bounds and holes, 3D-model boards) and drop per-pad parser evidence and any other
//      top-level record that is bulky and unread. Long pin-definition notes keep only their
//      dataset bindings, and metadata values above a size limit (audit reports) are left out.
// What was dropped is recorded in the snapshot's metadata table under bundle_* keys, and in
// each slimmed payload under bundle_slim.
//
// Usage:
//   bun catalog-snapshot.ts --src <full maker_catalog.sqlite> --out <snapshot.sqlite>
//                           [--max-rank 1000] [--include ids.json] [--all]
//                           [--keep-spec-evidence]
// --src defaults to $BENCHTOP_CATALOG. The source is opened read-only and never written.
// The same source and options produce the same bytes; no wall-clock time is stored.
// Exit codes: 0 ok, 2 usage error, 3 source missing or unexpected schema, 4 snapshot failed checks.

import { Database } from "bun:sqlite";
import { createHash } from "node:crypto";
import { existsSync, readFileSync, renameSync, rmSync, statSync } from "node:fs";
import { resolve } from "node:path";

export const SNAPSHOT_BUILDER_VERSION = "2";
export const SOURCE_SCHEMA_VERSION = 2;

type Cell = string | number | null;
type Row = Record<string, Cell>;

/** Asset kinds the bridge lists without a local file. Photos and doc pages are only shown when cached, which a bundle never is. */
const ASSET_KINDS = ["pinout", "mechanical_drawing", "cad_or_mechanical", "schematic", "source_repository", "datasheet_or_pdf", "block_diagram"];

/** Per-pad fields kept in geometry payloads. Everything else is parser evidence that the full catalog retains. */
const PAD_FIELDS = [
  "reference", "pad_number", "net_name", "x_mm", "y_mm", "footprint_side", "pad_type", "drill_mm",
  "footprint_name", "package", "external_connection_role", "electrical_contact_candidate",
];
/**
 * Top-level keys of a geometry payload that the bridge, the importer or the card generator
 * reads: pads and their frame, outline bounds and holes, a 3D model's boards. These are always
 * kept. Any other key is kept while it is small and dropped once it is bulky (per-component and
 * per-net parser records, every drill of every pad), so a key the catalog adds later cannot
 * quietly multiply the bundle's size.
 */
const READ_PAYLOAD_KEYS = new Set([
  "pads", "frame", "format", "coordinate_scope", "completeness", "reference_path", "native_reference_path", "skipped_pads", "payload_schema_version",
  "outline_bounds", "bounds_mm", "source_pcb_thickness_mm", "explicit_holes", "plated_package_pad_holes",
  "boards",
]);
/** Per-hole fields kept in a 3D model's `boards[].drilled_holes`: where it is, how wide, and what the catalog calls it. */
const HOLE_FIELDS = ["center_xy_mm", "diameter_mm", "kind", "plating"];
/** An unread key is dropped when its JSON is longer than this. */
const BULKY_KEY_BYTES = 2048;

/** Keys of a pin definition's notes JSON that the importer and the cards read: which datasets a row is bound to. */
const READ_PIN_NOTE_KEYS = ["supported_geometry_ids", "geometry_bindings"];
/** Notes longer than this are cut down to those keys (and any that speak of a conflict, which `show` prints). */
const BULKY_NOTES_BYTES = 1024;

/** Metadata values the skill reads whatever their size; other values above the limit are audit reports and are left out. */
const READ_METADATA_KEYS = new Set(["product_revision_reference_links", "product_sku_identity_links"]);
const BULKY_METADATA_BYTES = 65536;

/**
 * How each source table is carried over. A table missing from this map stops the build, so a
 * table added to the catalog later is a decision someone makes, not a silent omission.
 *   part    rows whose part_id is selected
 *   all     every row
 *   empty   schema only
 *   custom  handled by name in copyTable
 */
const PLAN: Record<string, "part" | "all" | "empty" | "custom"> = {
  metadata: "custom", // audit reports above a size limit are left out
  parts: "part",
  envelopes: "part",
  measurements: "part",
  pin_definitions: "custom", // long notes cut down to what is read
  specifications: "custom", // optional evidence_text blanking
  listings: "part",
  variants: "part",
  initial_selection: "part",
  family_memberships: "part",
  purchase_links: "part",
  manufacturer_market_links: "part",
  data_issues: "custom", // selected parts plus catalog-wide rows (part_id NULL)
  assets: "custom", // ASSET_KINDS only
  geometry_objects: "custom", // slimmed payloads
  market_evidence: "custom", // families of selected parts
  parts_fts: "custom", // virtual table
  sources: "custom", // referenced rows only, text removed; copied last
  source_captures: "empty",
  asset_files: "empty",
  derived_assets: "empty",
  listing_observations: "empty",
  marketplace_observations: "empty",
  geometry_reviews: "empty",
  popularity_signals: "empty",
};

interface Args {
  src: string;
  out: string;
  maxRank: number;
  include: string | null;
  all: boolean;
  keepSpecEvidence: boolean;
}

class UsageError extends Error {}
class SourceError extends Error {}
class CheckError extends Error {}

export function parseArgs(argv: string[], env: Record<string, string | undefined>): Args {
  const a: Args = { src: env.BENCHTOP_CATALOG ?? "", out: "", maxRank: 1000, include: null, all: false, keepSpecEvidence: false };
  for (let i = 0; i < argv.length; i++) {
    const flag = argv[i];
    const value = (): string => {
      const v = argv[++i];
      if (v === undefined) throw new UsageError(`${flag} needs a value`);
      return v;
    };
    if (flag === "--src") a.src = value();
    else if (flag === "--out") a.out = value();
    else if (flag === "--max-rank") {
      a.maxRank = Number(value());
      if (!Number.isInteger(a.maxRank) || a.maxRank < 0) throw new UsageError("--max-rank must be a whole number, 0 or more");
    } else if (flag === "--include") a.include = value();
    else if (flag === "--all") a.all = true;
    else if (flag === "--keep-spec-evidence") a.keepSpecEvidence = true;
    else throw new UsageError(`unknown argument ${flag}`);
  }
  if (!a.src) throw new UsageError("no source catalog: pass --src or set BENCHTOP_CATALOG");
  if (!a.out) throw new UsageError("pass --out <snapshot.sqlite>");
  a.src = resolve(a.src);
  a.out = resolve(a.out);
  if (a.src === a.out) throw new UsageError("--out must not be the source catalog");
  return a;
}

/** Part ids from a JSON array of strings, or one id per line. */
export function readIncludeFile(path: string): string[] {
  const text = readFileSync(path, "utf8").trim();
  if (text.startsWith("[")) {
    const parsed: unknown = JSON.parse(text);
    if (!Array.isArray(parsed) || parsed.some((x) => typeof x !== "string")) throw new UsageError(`${path} must be a JSON array of part ids`);
    return parsed as string[];
  }
  return text.split("\n").map((l) => l.trim()).filter((l) => l && !l.startsWith("#"));
}

function rows(db: Database, sql: string, ...params: Cell[]): Row[] {
  return db.query(sql).all(...params) as Row[];
}

function columns(db: Database, table: string): string[] {
  // Table names come from the source's own sqlite_master, never from user input.
  return rows(db, `PRAGMA table_info("${table}")`).map((r) => String(r.name));
}

/** Keep coordinates and identifiers of each pad; drop nulls and per-pad parser evidence. */
export function slimGeometryPayload(payloadJson: string): string {
  const payload = JSON.parse(payloadJson) as Record<string, unknown>;
  const droppedFields = new Set<string>();
  const slimPad = (pad: Record<string, unknown>): Record<string, unknown> => {
    const kept: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(pad)) {
      if (!PAD_FIELDS.includes(k)) droppedFields.add(k);
      else if (v !== null) kept[k] = v;
    }
    return kept;
  };
  const hasPads = Array.isArray(payload.pads);
  if (hasPads) {
    payload.pads = (payload.pads as Record<string, unknown>[]).map(slimPad);
    // Pads the parser set aside: only how many there are is read, so each keeps its identifiers and nothing else.
    if (Array.isArray(payload.skipped_pads)) payload.skipped_pads = (payload.skipped_pads as Record<string, unknown>[]).map((p) => (p && typeof p === "object" ? slimPad(p) : p));
  }
  // A 3D model lists every drilled hole of the board with two dozen fields each. Matching a
  // model to the pad data reads where a hole is and how wide; the rest is parser evidence.
  const droppedHoleFields = new Set<string>();
  if (Array.isArray(payload.boards)) {
    for (const board of payload.boards as Record<string, unknown>[]) {
      if (!board || typeof board !== "object" || !Array.isArray(board.drilled_holes)) continue;
      board.drilled_holes = (board.drilled_holes as Record<string, unknown>[]).map((hole) => {
        const kept: Record<string, unknown> = {};
        for (const [k, v] of Object.entries(hole)) {
          if (HOLE_FIELDS.includes(k)) kept[k] = v;
          else droppedHoleFields.add(k);
        }
        return kept;
      });
    }
  }
  const droppedKeys: string[] = [];
  for (const [k, v] of Object.entries(payload)) {
    if (READ_PAYLOAD_KEYS.has(k)) continue;
    if (JSON.stringify(v).length > BULKY_KEY_BYTES) {
      delete payload[k];
      droppedKeys.push(k);
    }
  }
  if (!hasPads && !droppedKeys.length && !droppedHoleFields.size) return payloadJson;
  payload.bundle_slim = {
    note: `${hasPads ? "Pad entries keep coordinates and identifiers only; null fields are omitted. " : ""}${
      droppedHoleFields.size ? "Drilled holes keep position, diameter, kind and plating only. " : ""
    }${droppedKeys.length ? "Bulky top-level records that nothing in the skill reads are left out. " : ""}The full catalog holds the complete payload under the same geometry_id.`,
    ...(hasPads ? { dropped_pad_fields: [...droppedFields].sort() } : {}),
    ...(droppedHoleFields.size ? { dropped_hole_fields: [...droppedHoleFields].sort() } : {}),
    ...(droppedKeys.length ? { dropped_keys: droppedKeys.sort() } : {}),
  };
  return JSON.stringify(payload);
}

/**
 * A pin definition's notes, cut down when long. The catalog keeps the parser's whole evidence
 * there (symbol text, crosswalks); the skill reads which datasets the row is bound to, and
 * prints a note that speaks of a conflict. Short notes and plain text pass through.
 */
export function slimPinNotes(notes: string | null): string | null {
  if (notes === null || notes.length <= BULKY_NOTES_BYTES) return notes;
  let parsed: unknown;
  try {
    parsed = JSON.parse(notes);
  } catch {
    return notes;
  }
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return notes;
  const kept: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(parsed as Record<string, unknown>)) {
    if (READ_PIN_NOTE_KEYS.includes(k) || /conflict/i.test(k)) kept[k] = v;
  }
  kept.bundle_slim = "Parser evidence left out; the full catalog holds the complete notes for this pin row.";
  return JSON.stringify(kept);
}

/**
 * Table-level UNIQUE(...) constraints only guard writes, and each one costs an index that
 * repeats the constrained columns. A read-only snapshot drops them. Columns are untouched;
 * build() verifies that against the source after creating the tables.
 */
export function stripTableUniques(createSql: string): string {
  return createSql.replace(/,\s*UNIQUE\s*\([^()]*\)/gi, "");
}

/** Secondary indexes are kept only when they serve the bridge's access path: lookups by part_id. */
export function keepIndex(createSql: string): boolean {
  return /\(\s*"?part_id"?\s*[,)]/i.test(createSql);
}

function selectParts(src: Database, a: Args): { ids: Set<string>; unknown: string[]; reasons: Record<string, number> } {
  const ids = new Set<string>();
  const reasons: Record<string, number> = {};
  const add = (reason: string, list: string[]): void => {
    let n = 0;
    for (const id of list) {
      if (!ids.has(id)) n++;
      ids.add(id);
    }
    reasons[reason] = n;
  };
  const col = (sql: string, ...p: Cell[]): string[] => rows(src, sql, ...p).map((r) => String(r.part_id));
  if (a.all) add("all", col(`SELECT part_id FROM parts ORDER BY selection_rank`));
  else {
    add(`selection_rank<=${a.maxRank}`, col(`SELECT part_id FROM parts WHERE selection_rank <= ? ORDER BY selection_rank`, a.maxRank));
    add("has_geometry_objects", col(`SELECT DISTINCT part_id FROM geometry_objects ORDER BY part_id`));
    add("has_pin_definitions", col(`SELECT DISTINCT part_id FROM pin_definitions ORDER BY part_id`));
  }
  const unknown: string[] = [];
  if (a.include) {
    const known = new Set(col(`SELECT part_id FROM parts`));
    const wanted = readIncludeFile(a.include);
    unknown.push(...wanted.filter((id) => !known.has(id)));
    add("include_file", wanted.filter((id) => known.has(id)));
  }
  return { ids, unknown, reasons };
}

export interface BuildReport {
  out: string;
  bytes: number;
  parts: number;
  reasons: Record<string, number>;
  unknownIncludes: string[];
  rowCounts: Record<string, number>;
}

export function build(a: Args): BuildReport {
  if (!existsSync(a.src)) throw new SourceError(`source catalog not found at ${a.src}`);
  const src = new Database(a.src, { readonly: true });
  const tmp = `${a.out}.tmp`;
  rmSync(tmp, { force: true });
  let out: Database | null = null;
  try {
    const version = Number((src.query("PRAGMA user_version").get() as { user_version: number }).user_version);
    if (version !== SOURCE_SCHEMA_VERSION) {
      throw new SourceError(`source catalog has schema version ${version}; this builder was written for ${SOURCE_SCHEMA_VERSION}. Review PLAN and the bridge before bumping.`);
    }

    const master = rows(src, `SELECT type, name, tbl_name, sql FROM sqlite_master WHERE sql IS NOT NULL AND name NOT LIKE 'sqlite\\_%' ESCAPE '\\' ORDER BY rowid`);
    const virtual = master.filter((m) => m.type === "table" && /^CREATE VIRTUAL TABLE/i.test(String(m.sql))).map((m) => String(m.name));
    const isShadow = (name: string): boolean => virtual.some((v) => name.startsWith(`${v}_`));
    const tables = master.filter((m) => m.type === "table" && !isShadow(String(m.name)));
    const unplanned = tables.map((t) => String(t.name)).filter((n) => !(n in PLAN));
    if (unplanned.length) throw new SourceError(`source catalog has tables this builder has no rule for: ${unplanned.join(", ")}. Add them to PLAN.`);

    const sel = selectParts(src, a);
    const keep = sel.ids;

    out = new Database(tmp, { create: true });
    const dst = out;
    dst.exec("PRAGMA page_size = 4096; PRAGMA journal_mode = OFF; PRAGMA synchronous = OFF; PRAGMA foreign_keys = OFF;");
    for (const t of tables) {
      const name = String(t.name);
      dst.exec(stripTableUniques(String(t.sql)));
      const shape = (db: Database): string => JSON.stringify(rows(db, `PRAGMA table_info("${name}")`).map((r) => [r.name, r.type, r.notnull, r.pk]));
      if (shape(src) !== shape(dst)) throw new CheckError(`columns of ${name} differ from the source after removing UNIQUE constraints; refusing to build`);
    }

    const usedSources = new Set<number>();
    const rowCounts: Record<string, number> = {};
    const omittedMetadata: string[] = [];

    const insert = (table: string, data: Row[]): void => {
      rowCounts[table] = data.length;
      if (!data.length) return;
      const cols = Object.keys(data[0]!);
      const stmt = dst.prepare(`INSERT INTO "${table}" (${cols.map((c) => `"${c}"`).join(",")}) VALUES (${cols.map(() => "?").join(",")})`);
      dst.transaction(() => {
        for (const r of data) {
          for (const c of cols) if ((c === "source_id" || c === "primary_source_id") && typeof r[c] === "number") usedSources.add(r[c] as number);
          stmt.run(...cols.map((c) => r[c] ?? null));
        }
      })();
    };
    const byPart = (table: string): Row[] => rows(src, `SELECT * FROM "${table}" ORDER BY rowid`).filter((r) => keep.has(String(r.part_id)));

    for (const t of tables) {
      const name = String(t.name);
      const rule = PLAN[name]!;
      if (name === "sources") continue; // last, once every reference is known
      if (rule === "empty") rowCounts[name] = 0;
      else if (rule === "all") insert(name, rows(src, `SELECT * FROM "${name}" ORDER BY rowid`));
      else if (rule === "part") insert(name, byPart(name));
      else if (name === "metadata") {
        insert(
          name,
          rows(src, `SELECT * FROM metadata ORDER BY rowid`).map((r) => {
            const value = r.value === null ? "" : String(r.value);
            if (value.length <= BULKY_METADATA_BYTES || READ_METADATA_KEYS.has(String(r.key))) return r;
            omittedMetadata.push(String(r.key));
            return { ...r, value: `omitted from the bundle (${value.length} characters); the full catalog holds it under the same key` };
          }),
        );
      } else if (name === "pin_definitions") {
        insert(name, byPart(name).map((r) => ("notes" in r ? { ...r, notes: slimPinNotes(r.notes === null ? null : String(r.notes)) } : r)));
      } else if (name === "specifications") {
        insert(name, byPart(name).map((r) => (a.keepSpecEvidence ? r : { ...r, evidence_text: "" })));
      } else if (name === "data_issues") {
        insert(name, rows(src, `SELECT * FROM data_issues ORDER BY issue_id`).filter((r) => r.part_id === null || keep.has(String(r.part_id))));
      } else if (name === "assets") {
        insert(name, byPart(name).filter((r) => ASSET_KINDS.includes(String(r.kind))));
      } else if (name === "geometry_objects") {
        insert(name, byPart(name).map((r) => ({ ...r, payload_json: slimGeometryPayload(String(r.payload_json)) })));
      } else if (name === "market_evidence") {
        const families = new Set(rows(src, `SELECT part_id, family FROM family_memberships`).filter((r) => keep.has(String(r.part_id))).map((r) => String(r.family)));
        insert(name, rows(src, `SELECT * FROM market_evidence ORDER BY evidence_id`).filter((r) => families.has(String(r.family))));
      } else if (name === "parts_fts") {
        const cols = columns(src, name);
        insert(name, rows(src, `SELECT rowid, ${cols.map((c) => `"${c}"`).join(",")} FROM parts_fts ORDER BY rowid`).filter((r) => keep.has(String(r.part_id))));
        dst.exec(`INSERT INTO parts_fts(parts_fts) VALUES('optimize')`);
      } else throw new SourceError(`no copy rule implemented for ${name}`);
    }

    // Sources: only rows something points at, without the retained page text.
    const sourceCols = columns(src, "sources").map((c) => (c === "source_text" ? `'' AS source_text` : c === "notes" ? `NULL AS notes` : `"${c}"`));
    insert("sources", rows(src, `SELECT ${sourceCols.join(",")} FROM sources ORDER BY source_id`).filter((r) => usedSources.has(Number(r.source_id))));

    for (const m of master) {
      if (m.type === "table") continue;
      if (m.type === "index" && !keepIndex(String(m.sql))) continue;
      dst.exec(String(m.sql));
    }

    const meta = dst.prepare(`INSERT OR REPLACE INTO metadata(key, value) VALUES (?, ?)`);
    const sourceCreated = rows(src, `SELECT value FROM metadata WHERE key = 'created_at_utc'`)[0]?.value ?? "unknown";
    const sourceParts = Number(rows(src, `SELECT count(*) AS n FROM parts`)[0]!.n);
    const notes: Record<string, string> = {
      bundle_kind: "skill_snapshot",
      bundle_builder_version: SNAPSHOT_BUILDER_VERSION,
      bundle_source_sha256: createHash("sha256").update(readFileSync(a.src)).digest("hex"),
      bundle_source_created_at_utc: String(sourceCreated),
      bundle_source_part_count: String(sourceParts),
      bundle_part_count: String(keep.size),
      bundle_part_selection: JSON.stringify(sel.reasons),
      bundle_empty_tables: Object.entries(PLAN).filter(([, r]) => r === "empty").map(([n]) => n).sort().join(", "),
      bundle_omissions: [
        "This is a subset of the full maker catalog. A part that is absent here may exist in the full catalog; absence is not evidence that a part does not exist.",
        "sources.source_text is empty and sources.notes is NULL; urls, publishers and content hashes are kept.",
        "Table-level UNIQUE constraints and indexes that do not start with part_id are not carried over; tables, columns and views match the source.",
        a.keepSpecEvidence ? "specifications.evidence_text is kept." : "specifications.evidence_text is empty; the source url is kept.",
        `assets holds only these kinds: ${ASSET_KINDS.join(", ")}. No file is cached: asset_files and derived_assets are empty and references/ is not bundled.`,
        "geometry_objects payloads keep what the skill reads (pad coordinates and identifiers, outline bounds and holes, 3D-model boards) and leave out bulky parser records; see bundle_slim inside each payload.",
        "pin_definitions.notes longer than a few lines keep only the dataset bindings.",
        omittedMetadata.length ? `metadata values left out as too large (audit reports): ${[...omittedMetadata].sort().join(", ")}.` : "No metadata value was left out.",
        "Views compute over bundled rows only, so counts and coverage flags describe the snapshot, not the full catalog.",
        "Prices and stock are the source catalog's point-in-time observations.",
      ].join(" "),
    };
    dst.transaction(() => {
      for (const [k, v] of Object.entries(notes)) meta.run(k, v);
    })();
    rowCounts.metadata = Number(rows(dst, `SELECT count(*) AS n FROM metadata`)[0]!.n);

    dst.exec(`PRAGMA user_version = ${version}`);
    const fk = rows(dst, `PRAGMA foreign_key_check`);
    if (fk.length) throw new CheckError(`snapshot has ${fk.length} dangling foreign key(s), first: ${JSON.stringify(fk[0])}`);
    const integrity = rows(dst, `PRAGMA integrity_check`).map((r) => String(Object.values(r)[0]));
    if (integrity.join() !== "ok") throw new CheckError(`snapshot failed integrity_check: ${integrity.slice(0, 3).join("; ")}`);
    dst.exec("VACUUM; PRAGMA journal_mode = DELETE;");
    dst.close();
    out = null;
    renameSync(tmp, a.out);
    return { out: a.out, bytes: statSync(a.out).size, parts: keep.size, reasons: sel.reasons, unknownIncludes: sel.unknown, rowCounts };
  } finally {
    out?.close();
    src.close();
    rmSync(tmp, { force: true });
  }
}

if (import.meta.main) {
  try {
    const r = build(parseArgs(process.argv.slice(2), process.env));
    console.log(`wrote ${r.out}: ${(r.bytes / 1048576).toFixed(2)} MB, ${r.parts} parts`);
    console.log(`selection: ${Object.entries(r.reasons).map(([k, n]) => `${k} +${n}`).join(", ")}`);
    if (r.unknownIncludes.length) console.log(`not in the source catalog, skipped: ${r.unknownIncludes.join(", ")}`);
    console.log(Object.entries(r.rowCounts).filter(([, n]) => n > 0).map(([t, n]) => `${t} ${n}`).join(", "));
  } catch (e) {
    console.error(e instanceof Error ? e.message : String(e));
    process.exit(e instanceof UsageError ? 2 : e instanceof SourceError ? 3 : e instanceof CheckError ? 4 : 1);
  }
}
