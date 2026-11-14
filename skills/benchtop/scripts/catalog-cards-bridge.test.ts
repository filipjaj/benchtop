// Tests for the `card` and `cards` subcommands of catalog.ts. The card file is built here by the
// generator's own `build` from a tiny fixture catalog; the real catalog is never opened.

import { Database } from "bun:sqlite";
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { CatalogUnavailable, run } from "./catalog";
import { build, getCard, openCards } from "./catalog-cards";

const dir = mkdtempSync(join(tmpdir(), "catalog-cards-bridge-"));
const catalogPath = join(dir, "catalog.sqlite");
const cardsPath = join(dir, "cards.sqlite");
afterAll(() => rmSync(dir, { recursive: true, force: true }));

// Same tables the generator reads (see catalog-cards.test.ts), with one part that has everything the bridge shows.
function makeCatalog(): void {
  const db = new Database(catalogPath, { create: true });
  db.exec(`
    PRAGMA user_version = 2;
    CREATE TABLE metadata(key TEXT PRIMARY KEY, value TEXT NOT NULL);
    CREATE TABLE sources(source_id INTEGER PRIMARY KEY, url TEXT, publisher TEXT, authority TEXT, retrieved_at TEXT);
    CREATE TABLE parts(part_id TEXT PRIMARY KEY, name TEXT, brand TEXT, manufacturer_part_number TEXT, category TEXT, identity_scope TEXT,
      primary_url TEXT, primary_source_id INTEGER, description TEXT, variant_count INTEGER, selection_rank INTEGER, geometry_status TEXT);
    CREATE TABLE envelopes(part_id TEXT PRIMARY KEY, a_mm REAL, b_mm REAL, c_mm REAL, axis_labels_json TEXT, scope TEXT, source_id INTEGER,
      evidence_text TEXT, verification_status TEXT, exact_variant_required INTEGER, variant_sku TEXT);
    CREATE TABLE measurements(measurement_id INTEGER PRIMARY KEY, part_id TEXT, kind TEXT, scope TEXT, values_mm_json TEXT, axis_labels_json TEXT,
      evidence_text TEXT, extraction_status TEXT, source_id INTEGER);
    CREATE TABLE specifications(spec_id INTEGER PRIMARY KEY, part_id TEXT, domain TEXT, key TEXT, value_text TEXT, source_id INTEGER,
      validation_status TEXT, claim_scope TEXT, value_num REAL, minimum_num REAL, maximum_num REAL, scope_note TEXT);
    CREATE TABLE pin_definitions(pin_id INTEGER PRIMARY KEY, part_id TEXT, connector TEXT, pin_number TEXT, name TEXT, electrical_type_as_source TEXT,
      functions_as_source TEXT, source_id INTEGER, revision TEXT, notes TEXT);
    CREATE TABLE geometry_objects(geometry_id INTEGER PRIMARY KEY, part_id TEXT, kind TEXT, source_id INTEGER, revision TEXT, source_url TEXT,
      source_sha256 TEXT, payload_json TEXT, validation_status TEXT);
    CREATE TABLE assets(asset_id INTEGER PRIMARY KEY, part_id TEXT, kind TEXT, title TEXT, url TEXT, revision TEXT, applicability_note TEXT);
    CREATE TABLE asset_files(url TEXT PRIMARY KEY, relative_path TEXT, sha256 TEXT, byte_count INTEGER, media_type TEXT, status TEXT);
    CREATE TABLE derived_assets(derived_asset_id INTEGER PRIMARY KEY, part_id TEXT, kind TEXT, title TEXT, source_url TEXT, relative_path TEXT,
      sha256 TEXT, byte_count INTEGER, media_type TEXT, derivation_method TEXT);
    CREATE TABLE listings(listing_id INTEGER PRIMARY KEY, part_id TEXT, supplier TEXT, url TEXT, supplier_sku TEXT, identity_match TEXT,
      domestic_market TEXT, currency TEXT, price REAL, price_basis TEXT, stock_status TEXT, observed_at TEXT, source_id INTEGER);
    CREATE TABLE variants(variant_id INTEGER PRIMARY KEY, part_id TEXT, supplier TEXT, sku TEXT, title TEXT);
    CREATE TABLE data_issues(issue_id INTEGER PRIMARY KEY, part_id TEXT, severity TEXT, code TEXT, detail TEXT, source_id INTEGER);
    CREATE TABLE family_memberships(part_id TEXT, family TEXT);
    CREATE TABLE market_evidence(evidence_id INTEGER PRIMARY KEY, family TEXT, market TEXT);
    CREATE VIRTUAL TABLE parts_fts USING fts5(part_id UNINDEXED, name, brand, category, families, specifications);
    INSERT INTO metadata VALUES ('created_at_utc', '2026-11-13T23:55:54+00:00');
    INSERT INTO sources VALUES (1, 'https://maker.test/board', 'Maker', 'manufacturer_claim', '2026-11-13T10:00:00+00:00');
    INSERT INTO parts VALUES ('m:board', 'Maker Board One', 'Maker', 'MB-1', 'development_board', 'exact_manufacturer_sku', 'https://maker.test/board', 1, 'A small board.', 1, 1, 'published_3d_unverified');
    INSERT INTO envelopes VALUES ('m:board', 70, 55, 15, '["length","width","height"]', 'assembly', 1, '70 x 55 x 15 mm', 'parser_selected_source_claim_not_fit_verified', 0, NULL);
    INSERT INTO specifications VALUES (1, 'm:board', 'electrical', 'operating_voltage', '5V', 1, 'source_claim_not_independently_verified', 'unspecified', 5, NULL, NULL, NULL);
    INSERT INTO assets VALUES (1, 'm:board', 'pinout', 'Pinout', 'https://maker.test/pinout.pdf', NULL, NULL);
    INSERT INTO asset_files VALUES ('https://maker.test/pinout.pdf', 'references/ab/pinout.pdf', 'abc', 1234, 'application/pdf', 'downloaded');
    INSERT INTO listings VALUES (1, 'm:board', 'Elkim', 'https://elkim.test/board', 'E1', 'this_source_product', 'NO', 'NOK', 299, 'catalog price, incl. mva as price_html states', 'in_stock', '2026-11-13T22:00:00+00:00', 1);
    INSERT INTO parts_fts(part_id, name, brand, category, families, specifications) VALUES ('m:board', 'Maker Board One', 'Maker', 'development_board', '', 'operating voltage 5V');
  `);
  db.close();
}

const lines: string[] = [];
const realLog = console.log;
async function cli(argv: string[], env: Record<string, string | undefined> = {}): Promise<string> {
  lines.length = 0;
  console.log = (...a: unknown[]) => void lines.push(a.join(" "));
  try {
    await run(argv, env);
  } finally {
    console.log = realLog;
  }
  return lines.join("\n");
}

beforeAll(() => {
  makeCatalog();
  build(catalogPath, cardsPath);
});

describe("card", () => {
  test("prints the rendered card for a part", async () => {
    const text = await cli(["card", "m:board", "--cards", cardsPath]);
    expect(text).toContain("# Maker Board One");
    expect(text).toContain("m:board | Maker");
    expect(text).toContain("70 x 55");
  });

  test("the card file comes from BENCHTOP_CARDS when --cards is absent", async () => {
    expect(await cli(["card", "m:board"], { BENCHTOP_CARDS: cardsPath })).toContain("# Maker Board One");
  });

  test("cached paths are relative and flagged when the full catalog is not known, absolute when it is", async () => {
    const rel = await cli(["card", "m:board", "--cards", cardsPath]);
    expect(rel).toContain("LOCAL references/ab/pinout.pdf");
    expect(rel).toContain("need the full catalog");
    const abs = await cli(["card", "m:board", "--cards", cardsPath, "--db", catalogPath]);
    expect(abs).toContain(`LOCAL ${join(dir, "references/ab/pinout.pdf")} (missing on disk)`);
    expect(abs).not.toContain("need the full catalog");
    // BENCHTOP_CATALOG works like --db.
    expect(await cli(["card", "m:board", "--cards", cardsPath], { BENCHTOP_CATALOG: catalogPath })).toContain(join(dir, "references/ab/pinout.pdf"));
  });

  test("--json passes the card through untouched, paths included", async () => {
    const db = openCards(cardsPath);
    const expected = getCard(db, "m:board");
    db.close();
    const out = JSON.parse(await cli(["card", "m:board", "--cards", cardsPath, "--db", catalogPath, "--json"])) as { references: { path: string | null }[] };
    expect(out).toEqual(JSON.parse(JSON.stringify(expected)));
    expect(out.references[0]!.path).toBe("references/ab/pinout.pdf");
  });

  test("a missing card never reads as 'does not exist'", async () => {
    const err = await cli(["card", "nope:1", "--cards", cardsPath]).catch((e: Error) => e.message);
    expect(err).toContain('no card for "nope:1"');
    expect(err).toContain("does not mean the part does not exist");
  });

  test("no card file configured: one line on how to get one, exit-3 error type", async () => {
    const e = await cli(["card", "m:board"]).catch((x: unknown) => x);
    expect(e).toBeInstanceOf(CatalogUnavailable);
    const msg = (e as Error).message;
    expect(msg.split("\n")).toHaveLength(1);
    expect(msg).toContain("catalog-cards.ts build --src <full catalog> --out <file>");
    expect(msg).toContain("BENCHTOP_CARDS");
    // A path that does not exist is the same kind of "not available".
    const e2 = await cli(["card", "m:board", "--cards", join(dir, "absent.sqlite")]).catch((x: unknown) => x);
    expect(e2).toBeInstanceOf(CatalogUnavailable);
  });
});

describe("cards", () => {
  test("searches the card index with the generator's filters", async () => {
    expect(await cli(["cards", "board", "--norway", "--cards", cardsPath])).toContain("m:board");
    expect(await cli(["cards", "board", "--fits", "80", "60", "20", "--cards", cardsPath])).toContain("m:board");
    expect(await cli(["cards", "board", "--fits", "10", "10", "10", "--cards", cardsPath])).toContain("does not mean the part does not exist");
  });

  test("--json is the generator's result", async () => {
    const out = JSON.parse(await cli(["cards", "board", "--json", "--cards", cardsPath])) as { rows: { part_id: string }[]; loose: boolean };
    expect(out.rows.map((r) => r.part_id)).toEqual(["m:board"]);
  });

  test("without a card file it is the same single-line not-available error", async () => {
    await expect(cli(["cards", "board"])).rejects.toBeInstanceOf(CatalogUnavailable);
  });
});
