// Tests for catalog.ts against a small fixture database built in a temp directory.
// The real catalog is never opened.

import { Database } from "bun:sqlite";
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  CatalogUnavailable,
  checkLibrary,
  find,
  fitsBox,
  formatListing,
  listings,
  openCatalog,
  parseArgs,
  run,
  resolveDbPath,
  show,
  snapshotHint,
  snapshotInfo,
  snapshotLine,
  type Identity,
} from "./catalog";
import type { PartDef } from "./lib/types";

// Table definitions copied from the catalog's schema.sql (only what catalog.ts reads).
const SCHEMA = `
PRAGMA user_version=2;
CREATE TABLE sources(
 source_id INTEGER PRIMARY KEY, url TEXT NOT NULL, publisher TEXT NOT NULL,
 source_type TEXT NOT NULL, authority TEXT NOT NULL, retrieved_at TEXT NOT NULL,
 content_sha256 TEXT NOT NULL, source_text TEXT NOT NULL,
 extraction_method TEXT NOT NULL, notes TEXT,
 UNIQUE(url,content_sha256)
);
CREATE TABLE parts(
 part_id TEXT PRIMARY KEY, name TEXT NOT NULL, brand TEXT, manufacturer_part_number TEXT,
 category TEXT NOT NULL, supplier_category TEXT, identity_scope TEXT NOT NULL,
 primary_url TEXT NOT NULL, primary_source_id INTEGER NOT NULL REFERENCES sources,
 description TEXT, variant_count INTEGER NOT NULL DEFAULT 1,
 selection_rank INTEGER NOT NULL UNIQUE, selection_score REAL NOT NULL,
 selection_reason TEXT NOT NULL, global_market_rank INTEGER CHECK(global_market_rank IS NULL),
 geometry_status TEXT NOT NULL, physical_verification TEXT NOT NULL DEFAULT 'not_physically_measured',
 observed_at TEXT NOT NULL
);
CREATE TABLE variants(
 variant_id INTEGER PRIMARY KEY, part_id TEXT NOT NULL REFERENCES parts,
 supplier TEXT NOT NULL, supplier_variant_id TEXT, sku TEXT, title TEXT NOT NULL,
 options_json TEXT NOT NULL, price REAL, currency TEXT, stock_status TEXT NOT NULL DEFAULT 'unknown',
 shipping_mass_g REAL, source_id INTEGER NOT NULL REFERENCES sources,
 UNIQUE(part_id,supplier,supplier_variant_id)
);
CREATE TABLE listings(
 listing_id INTEGER PRIMARY KEY, part_id TEXT NOT NULL REFERENCES parts,
 supplier TEXT NOT NULL, url TEXT NOT NULL, supplier_sku TEXT,
 identity_match TEXT NOT NULL, domestic_market TEXT, currency TEXT, price REAL,
 price_basis TEXT NOT NULL, stock_status TEXT NOT NULL,
 stock_quantity REAL, lifecycle TEXT, source_id INTEGER NOT NULL REFERENCES sources,
 observed_at TEXT NOT NULL, shipping_to_norway TEXT NOT NULL DEFAULT 'not_verified',
 UNIQUE(part_id,supplier,url)
);
CREATE TABLE specifications(
 spec_id INTEGER PRIMARY KEY, part_id TEXT NOT NULL REFERENCES parts,
 domain TEXT NOT NULL, key TEXT NOT NULL, value_text TEXT NOT NULL,
 value_num REAL, minimum_num REAL, maximum_num REAL, unit TEXT,
 source_id INTEGER NOT NULL REFERENCES sources, evidence_text TEXT NOT NULL,
 validation_status TEXT NOT NULL DEFAULT 'source_claim_not_independently_verified',
 UNIQUE(part_id,key,value_text,source_id)
);
CREATE TABLE measurements(
 measurement_id INTEGER PRIMARY KEY, part_id TEXT NOT NULL REFERENCES parts,
 kind TEXT NOT NULL, scope TEXT NOT NULL, values_mm_json TEXT NOT NULL,
 axis_labels_json TEXT, evidence_text TEXT NOT NULL,
 extraction_status TEXT NOT NULL, source_id INTEGER NOT NULL REFERENCES sources,
 notes TEXT
);
CREATE TABLE envelopes(
 part_id TEXT PRIMARY KEY REFERENCES parts, a_mm REAL NOT NULL CHECK(a_mm>0),
 b_mm REAL NOT NULL CHECK(b_mm>0), c_mm REAL CHECK(c_mm>0),
 axis_labels_json TEXT, scope TEXT NOT NULL, source_id INTEGER NOT NULL REFERENCES sources,
 evidence_text TEXT NOT NULL, verification_status TEXT NOT NULL,
 exact_variant_required INTEGER NOT NULL DEFAULT 0, variant_sku TEXT,
 tolerance_mm REAL, connector_clearance_mm REAL, mounting_holes_verified INTEGER NOT NULL DEFAULT 0
);
CREATE TABLE assets(
 asset_id INTEGER PRIMARY KEY, part_id TEXT NOT NULL REFERENCES parts,
 kind TEXT NOT NULL, title TEXT, url TEXT NOT NULL, source_id INTEGER NOT NULL REFERENCES sources,
 fetch_status TEXT NOT NULL DEFAULT 'linked_not_downloaded', revision TEXT, UNIQUE(part_id,url)
);
CREATE TABLE asset_files(
 url TEXT PRIMARY KEY, relative_path TEXT, sha256 TEXT, byte_count INTEGER,
 media_type TEXT, pixel_width INTEGER, pixel_height INTEGER, fetched_at TEXT,
 status TEXT NOT NULL, error TEXT, final_url TEXT,
 verification_status TEXT NOT NULL DEFAULT 'downloaded_reference_not_geometry_verified'
);
CREATE TABLE pin_definitions(
 pin_id INTEGER PRIMARY KEY,part_id TEXT NOT NULL REFERENCES parts,connector TEXT NOT NULL,
 pin_number TEXT NOT NULL,name TEXT NOT NULL,electrical_type_as_source TEXT,
 functions_as_source TEXT NOT NULL,source_id INTEGER NOT NULL REFERENCES sources,
 evidence_text TEXT NOT NULL,revision TEXT,notes TEXT,
 validation_status TEXT NOT NULL DEFAULT 'source_claim_not_wiring_verified',
 UNIQUE(part_id,connector,pin_number,source_id,evidence_text)
);
CREATE TABLE data_issues(
 issue_id INTEGER PRIMARY KEY, part_id TEXT REFERENCES parts, severity TEXT NOT NULL,
 code TEXT NOT NULL, detail TEXT NOT NULL, source_id INTEGER REFERENCES sources
);
CREATE VIRTUAL TABLE parts_fts USING fts5(part_id UNINDEXED,name,brand,category,families,specifications,tokenize='unicode61 remove_diacritics 2');
`;

let dir: string;
let dbPath: string;
let rank = 0;

function part(db: Database, id: string, name: string, brand: string | null, scope = "supplier_specific_product_manufacturer_unresolved"): void {
  db.query(
    `INSERT INTO parts(part_id,name,brand,category,identity_scope,primary_url,primary_source_id,selection_rank,selection_score,selection_reason,geometry_status,observed_at)
     VALUES(?,?,?,'sensor',?,'https://example.test/'||?,1,?,1,'t','x','2026-11-13')`,
  ).run(id, name, brand, scope, id, ++rank);
  db.query(`INSERT INTO parts_fts(part_id,name,brand,category,families,specifications) VALUES(?,?,?,?,?,?)`).run(id, name, brand ?? "", "sensor", "", "");
}
function envelope(db: Database, id: string, a: number, b: number, c: number | null, scope: string): void {
  db.query(`INSERT INTO envelopes(part_id,a_mm,b_mm,c_mm,scope,source_id,evidence_text,verification_status) VALUES(?,?,?,?,?,1,'e','source_claim')`).run(id, a, b, c, scope);
}
function bbox(db: Database, id: string, values: number[], scope: string): void {
  db.query(`INSERT INTO measurements(part_id,kind,scope,values_mm_json,evidence_text,extraction_status,source_id) VALUES(?,'bounding_box',?,?,'e','source_stated',1)`).run(id, scope, JSON.stringify(values));
}
function spec(db: Database, id: string, key: string, text: string, unit: string | null, min: number | null, max: number | null): void {
  db.query(`INSERT INTO specifications(part_id,domain,key,value_text,minimum_num,maximum_num,unit,source_id,evidence_text) VALUES(?,'electrical',?,?,?,?,?,1,'e')`).run(id, key, text, min, max, unit);
}
function pin(db: Database, id: string, n: number, name: string): void {
  db.query(`INSERT INTO pin_definitions(part_id,connector,pin_number,name,functions_as_source,source_id,evidence_text) VALUES(?,'J1',?,?,'f',1,?)`).run(id, String(n), name, `${n} ${name}`);
}

function buildFixture(path: string): void {
  const db = new Database(path);
  db.exec(SCHEMA);
  db.query(`INSERT INTO sources VALUES(1,'https://src.test/a','Shop','retailer','seller_claim','2026-11-13T00:00:00Z','h','t','x',NULL)`).run();
  // Fits tests: 20x10x5 fits a 25x15x8 box, a two-value outline never does, a bare PCB only on request.
  part(db, "t:fits", "Fixture Box Sensor", null);
  envelope(db, "t:fits", 20, 10, 5, "product_unspecified");
  part(db, "t:twovalue", "Fixture Box Sensor Flat", null);
  envelope(db, "t:twovalue", 20, 10, null, "product_unspecified");
  part(db, "t:pcb", "Fixture Box Sensor Board", null);
  envelope(db, "t:pcb", 20, 10, 1.6, "pcb");
  part(db, "t:big", "Fixture Box Sensor Large", null);
  envelope(db, "t:big", 60, 30, 5, "product_unspecified");
  part(db, "t:partial", "Fixture Box Sensor Body", null);
  envelope(db, "t:partial", 10, 10, 3, "partial_body_only");
  // check-library fixtures. Library ids: hc-sr04 (agree), bme280-breakout (disagree), inmp441-mic (no evidence).
  part(db, "t:srf", "HC-SR04 ultrasonic module", null);
  bbox(db, "t:srf", [45, 20, 15], "product_unspecified");
  spec(db, "t:srf", "operating_voltage", "5V DC", "V", 5, 5);
  part(db, "t:bme", "BME280 temperature module", null);
  bbox(db, "t:bme", [25, 18], "product_unspecified");
  spec(db, "t:bme", "operating_voltage", "1.8V - 5V", "V", 1.8, 5);
  part(db, "t:mic", "INMP441 microphone module", null);
  // A branded cousin of a clone: Adafruit's BME280, a different board.
  part(db, "t:ada", "Adafruit BME280 breakout", "Adafruit", "branded_product");
  bbox(db, "t:ada", [25.2, 18, 4.6], "product_unspecified");
  // Branded part with pin definitions in a different order than the part file.
  part(db, "t:pico", "Raspberry Pi Pico W", "Raspberry Pi", "branded_product");
  pin(db, "t:pico", 1, "GP0");
  pin(db, "t:pico", 2, "GP1");
  pin(db, "t:pico", 3, "GND");
  // Listings and assets
  db.query(`INSERT INTO listings(part_id,supplier,url,supplier_sku,identity_match,domestic_market,currency,price,price_basis,stock_status,source_id,observed_at) VALUES('t:srf','Elkim','https://elkim.test/x','S1','this_source_product','NO','NOK',49,'incl mva','in_stock',1,'2026-11-13T10:00:00Z'),('t:srf','Pimoroni','https://pim.test/x',NULL,'this_source_product',NULL,'GBP',3,'ex vat','unknown',1,'2026-11-13T10:00:00Z'),('t:srf','JLCPCB','https://jlc.test/C1',NULL,'this_source_product',NULL,'USD',1.05,'unit','in_stock_assembly_inventory',1,'2026-11-14T10:00:00Z')`).run();
  db.query(`INSERT INTO variants(part_id,supplier,sku,title,options_json,source_id) VALUES('t:srf','Elkim','S1','HC-SR04 5-pakning','{}',1)`).run();
  db.query(`INSERT INTO assets(part_id,kind,title,url,source_id) VALUES('t:srf','product_image','photo','https://img.test/a.jpg',1),('t:srf','pinout','pinout','https://img.test/pinout.png',1),('t:srf','mechanical_drawing','drawing','https://img.test/drawing.pdf',1)`).run();
  db.query(`INSERT INTO asset_files(url,relative_path,status) VALUES('https://img.test/drawing.pdf','references/aa/drawing.pdf','downloaded')`).run();
  db.close();
}

function partFile(over: Partial<PartDef> & Pick<PartDef, "id">): PartDef {
  return {
    name: over.id,
    kind: "sensor",
    blurb: "fixture part",
    body: { w: 45, d: 20, h: 1.6 },
    maxHeight: 15,
    pins: [],
    electrical: {},
    sourcing: { search: ["x"], priceUsd: 1 },
    sources: ["x"],
    confidence: "typical",
    ...over,
  };
}

const IDENT: Record<string, Identity> = {
  "hc-sr04": { nature: "clone", model: /HC-?SR04/i },
  "bme280-breakout": { nature: "clone", model: /BME280/i },
  "inmp441-mic": { nature: "clone", model: /INMP441/i },
  "pi-pico-w": { nature: "branded", brand: /raspberry/i, model: /Pico\s*W/i },
};

beforeAll(() => {
  dir = mkdtempSync(join(tmpdir(), "catalog-test-"));
  dbPath = join(dir, "maker_catalog.sqlite");
  buildFixture(dbPath);
});
afterAll(() => rmSync(dir, { recursive: true, force: true }));

describe("location and open", () => {
  test("--db wins over the environment, which wins over the default", () => {
    expect(resolveDbPath({ db: dbPath, env: "/nonexistent/x.sqlite", skillRoot: "/nonexistent" })).toEqual({ path: dbPath, via: "--db" });
    expect(resolveDbPath({ env: dbPath, skillRoot: "/nonexistent" })).toEqual({ path: dbPath, via: "BENCHTOP_CATALOG" });
    const root = join(dir, "skill");
    mkdirSync(join(root, "assets", "catalog"), { recursive: true });
    writeFileSync(join(root, "assets", "catalog", "maker_catalog.sqlite"), "");
    expect(resolveDbPath({ skillRoot: root }).via).toBe("default location");
  });

  test("a missing database gives one plain line naming where it looked and how to point at it", () => {
    let message = "";
    try {
      resolveDbPath({ skillRoot: join(dir, "empty-skill") });
    } catch (e) {
      expect(e).toBeInstanceOf(CatalogUnavailable);
      message = (e as Error).message;
    }
    expect(message).toContain("optional");
    expect(message).toContain(join(dir, "empty-skill", "assets", "catalog", "maker_catalog.sqlite"));
    expect(message).toContain("--db");
    expect(message).toContain("BENCHTOP_CATALOG");
    expect(message).not.toContain("\n");
  });

  test("the CLI exits 3 when the catalog is missing", async () => {
    const proc = Bun.spawn(["bun", join(import.meta.dir, "catalog.ts"), "find", "x", "--db", join(dir, "nope.sqlite")], { stdout: "pipe", stderr: "pipe" });
    const out = await new Response(proc.stdout).text();
    expect(await proc.exited).toBe(3);
    expect(out.trim().split("\n")).toHaveLength(1);
  });

  test("schema check names the missing column and table", () => {
    const path = join(dir, "changed.sqlite");
    const db = new Database(path);
    db.exec(SCHEMA);
    db.exec("ALTER TABLE envelopes RENAME COLUMN c_mm TO height_mm");
    db.exec("DROP TABLE variants");
    db.close();
    expect(() => openCatalog(path)).toThrow(/envelopes lacks column c_mm/);
    expect(() => openCatalog(path)).toThrow(/table variants is missing/);
  });

  test("a different user_version warns once and still opens", () => {
    const path = join(dir, "v3.sqlite");
    const db = new Database(path);
    db.exec(SCHEMA);
    db.exec("PRAGMA user_version=3");
    db.close();
    const warnings: string[] = [];
    const cat = openCatalog(path, (l) => warnings.push(l));
    cat.db.close();
    expect(warnings).toHaveLength(1);
    expect(warnings[0]).toContain("tested against schema version 2 and found 3");
  });
});

describe("find --fits", () => {
  const cat = () => openCatalog(dbPath);
  test("rotation is allowed", () => {
    expect(fitsBox([20, 10, 5], [5, 10, 20])).toBe(true);
    expect(fitsBox([20, 10, 5], [5, 10, 19])).toBe(false);
  });

  test("a two-value outline is never treated as fitting, and bare PCBs and partial bodies are excluded", () => {
    const c = cat();
    const ids = find(c.db, "Fixture Box Sensor", { fits: [25, 15, 8] }).hits.map((h) => h.part_id);
    c.db.close();
    expect(ids).toEqual(["t:fits"]);
  });

  test("--include-pcb adds the bare board scope", () => {
    const c = cat();
    const ids = find(c.db, "Fixture Box Sensor", { fits: [25, 15, 8], includePcb: true }).hits.map((h) => h.part_id).sort();
    c.db.close();
    expect(ids).toEqual(["t:fits", "t:pcb"]);
  });

  test("without --fits the two-value outline is shown with its unknown third dimension", () => {
    const c = cat();
    const hit = find(c.db, "Fixture Box Sensor Flat").hits.find((h) => h.part_id === "t:twovalue");
    c.db.close();
    expect(hit?.outline?.text).toContain("20 x 10 x ?");
    expect(hit?.outline?.text).toContain("third dimension unknown");
  });
});

describe("show and listings", () => {
  test("only downloaded assets get a local path, drawings come before photos, and gaps are stated", () => {
    const c = cat();
    const r = show(c, "t:srf")!;
    c.db.close();
    const kinds = r.assets.map((a) => a.kind);
    expect(kinds[0]).toBe("pinout");
    expect(kinds[1]).toBe("mechanical_drawing");
    expect(kinds).not.toContain("product_image");
    expect(r.assets.find((a) => a.kind === "pinout")?.cache_state).toBe("not cached");
    // The file is recorded as downloaded but is not on disk in the fixture.
    expect(r.assets.find((a) => a.kind === "mechanical_drawing")?.cache_state).toBe("downloaded per catalog but file missing on disk");
    expect(r.not_in_catalog.join("\n")).toContain("pad or pin centre coordinates");
  });

  test("listings print as candidates with title, price and currency", () => {
    const c = cat();
    const r = listings(c.db, "t:srf", { norway: true });
    c.db.close();
    expect(r.listings).toHaveLength(1);
    expect(r.listings[0]).toMatchObject({ shop: "Elkim", title: "HC-SR04 5-pakning", price: 49, currency: "NOK", sold_loose: true });
  });

  test("an assembly service's stock is not a place to buy the part: it sorts last and says so", () => {
    // JLCPCB's parts library lists what it can fit to a board it builds; none of it is sold loose.
    const c = cat();
    const r = listings(c.db, "t:srf", {});
    c.db.close();
    expect(r.listings.map((l) => [l.shop, l.sold_loose])).toEqual([["Elkim", true], ["Pimoroni", true], ["JLCPCB", false]]);
    const line = formatListing(r.listings[2]!);
    expect(line).toContain("NOT SOLD LOOSE: assembly-service stock");
    expect(line).not.toContain("in_stock");
    // A limit keeps the shops, not the assembly line.
    const c2 = cat();
    expect(listings(c2.db, "t:srf", { limit: 2 }).listings.every((l) => l.sold_loose)).toBe(true);
    c2.db.close();
  });

  function cat() {
    return openCatalog(dbPath);
  }
});

describe("check-library", () => {
  function libraryDir(files: PartDef[]): string {
    const d = mkdtempSync(join(dir, "lib-"));
    for (const f of files) writeFileSync(join(d, `${f.id}.json`), JSON.stringify(f));
    return d;
  }

  test("reports agree, disagree and no evidence for three fixture parts", () => {
    const lib = libraryDir([
      partFile({ id: "hc-sr04", body: { w: 45, d: 20, h: 1.6 }, maxHeight: 15, pins: [{ name: "VCC", role: "power-in", x: 0, y: 0, minVolts: 4.5, volts: 5, maxVolts: 5.5 }] }),
      partFile({ id: "bme280-breakout", body: { w: 15, d: 11.5, h: 1.6 }, maxHeight: 4 }),
      partFile({ id: "inmp441-mic", body: { w: 14, d: 14, h: 1.6 }, maxHeight: 3 }),
    ]);
    const c = openCatalog(dbPath);
    const res = checkLibrary(c, lib, { identities: IDENT });
    c.db.close();
    const by = (id: string) => res.find((r) => r.id === id)!;

    const srf = by("hc-sr04").matches.find((m) => m.part_id === "t:srf")!;
    expect(srf.lines.find((l) => l.topic === "outline")?.verdict).toBe("agree");
    expect(srf.lines.find((l) => l.topic === "supply")?.verdict).toBe("agree");
    expect(srf.lines.find((l) => l.topic === "pins")?.verdict).toBe("no evidence");

    const bme = by("bme280-breakout").matches.find((m) => m.part_id === "t:bme")!;
    const outline = bme.lines.find((l) => l.topic === "outline")!;
    expect(outline.verdict).toBe("disagree");
    expect(outline.detail).toContain("file 15 x 11.5 vs catalog 25 x 18");
    expect(outline.source_url).toBe("https://src.test/a");

    const mic = by("inmp441-mic").matches.find((m) => m.part_id === "t:mic")!;
    expect(mic.lines.every((l) => l.verdict === "no evidence")).toBe(true);
    expect(by("inmp441-mic").status).toBe("exact");
  });

  test("a branded board matched to a clone is labelled a cousin and is not evidence", () => {
    const lib = libraryDir([partFile({ id: "bme280-breakout", body: { w: 25.2, d: 18, h: 1.6 }, maxHeight: 4.6 })]);
    // Only the branded record is visible: use an identity that rejects the generic fixture.
    const c = openCatalog(dbPath);
    const res = checkLibrary(c, lib, { identities: { "bme280-breakout": { nature: "clone", model: /BME280/i, reject: /module/i } } });
    c.db.close();
    const r = res[0]!;
    expect(r.status).toBe("branded cousin only");
    expect(r.matches[0]!.kind).toBe("branded cousin");
    expect(r.matches[0]!.note).toContain("not evidence for a clone");
    // The cousin's 25.2 x 18 x 4.6 equals the file, yet it must not count as agreement.
    expect(r.matches[0]!.lines.every((l) => l.verdict === "no evidence")).toBe(true);
    expect(r.matches[0]!.lines.find((l) => l.topic === "outline")?.detail).toContain("informational: cousin agree");
  });

  test("pin names and order are compared for a branded part", () => {
    const pins = (names: string[]) => names.map((name, i) => ({ name, role: "io" as const, x: i, y: 0 }));
    const lib = libraryDir([partFile({ id: "pi-pico-w", pins: pins(["GP1", "GP0", "GND"]) })]);
    const c = openCatalog(dbPath);
    const res = checkLibrary(c, lib, { identities: IDENT });
    c.db.close();
    const line = res[0]!.matches[0]!.lines.find((l) => l.topic === "pins")!;
    expect(line.verdict).toBe("disagree");
    expect(line.detail).toContain("order differs");
  });
});

describe("pads and import-part commands", () => {
  const GEOMETRY = `CREATE TABLE geometry_objects(geometry_id INTEGER PRIMARY KEY, part_id TEXT NOT NULL, kind TEXT NOT NULL, unit TEXT NOT NULL DEFAULT 'mm', coordinate_frame TEXT NOT NULL, revision TEXT, source_url TEXT NOT NULL, source_sha256 TEXT, payload_json TEXT NOT NULL, validation_status TEXT NOT NULL DEFAULT 'v');`;
  let padsDb: string;
  const lines: string[] = [];
  const realLog = console.log;

  beforeAll(() => {
    padsDb = join(dir, "pads.sqlite");
    buildFixture(padsDb);
    const db = new Database(padsDb);
    db.exec(GEOMETRY);
    const pads = [
      { reference: "J1", pad_number: "1", net_name: "A", x_mm: 1, y_mm: 1, pad_type: "through_hole" },
      { reference: "J1", pad_number: "2", net_name: "B", x_mm: 3.54, y_mm: 1, pad_type: "through_hole" },
    ];
    db.query(`INSERT INTO geometry_objects(part_id,kind,coordinate_frame,revision,source_url,source_sha256,payload_json) VALUES('t:srf','pcb_pad_centers','X right, Y down','r1','https://cad.test/a.brd','sha1',?)`).run(
      JSON.stringify({ frame: { x_direction: "right", y_direction: "down", view: "top" }, pads }),
    );
    db.close();
  });

  const capture = async (argv: string[]): Promise<string> => {
    lines.length = 0;
    console.log = (...a: unknown[]) => void lines.push(a.join(" "));
    try {
      await run([...argv, "--db", padsDb]);
    } finally {
      console.log = realLog;
    }
    return lines.join("\n");
  };

  test("parseArgs reads the import flags and rejects a bad rotation", () => {
    const a = parseArgs(["import-part", "p", "--header", "J1,J2", "--id", "x", "--out", "o.json", "--geometry", "3", "--rot", "90", "--mirror"]);
    expect(a).toMatchObject({ cmd: "import-part", pos: ["p"], header: "J1,J2", id: "x", out: "o.json", geometry: 3, rot: 90, mirror: true });
    expect(() => parseArgs(["import-part", "--rot", "45"])).toThrow(/--rot needs 0, 90, 180 or 270/);
  });

  test("pads lists the dataset and references", async () => {
    const text = await capture(["pads", "t:srf"]);
    expect(text).toContain("geometry 1 (selected)");
    expect(text).toContain("J1 | 2 pads");
  });

  test("import-part writes the draft, refuses to overwrite, and needs its flags", async () => {
    const out = join(dir, "drafts", "t-draft.json");
    const text = await capture(["import-part", "t:srf", "--header", "J1", "--id", "t-draft", "--out", out]);
    expect(text).toContain("2 of 2 pads imported");
    const def = JSON.parse(readFileSync(out, "utf8")) as PartDef;
    expect(def.id).toBe("t-draft");
    expect(def.pins.map((p) => [p.name, p.x, p.y])).toEqual([["A", 0, 0], ["B", 2.54, 0]]);
    await expect(capture(["import-part", "t:srf", "--header", "J1", "--id", "t-draft", "--out", out])).rejects.toThrow(/--overwrite/);
    await expect(capture(["import-part", "t:srf", "--id", "x"])).rejects.toThrow(/needs --out/);
    expect(existsSync(join(dir, "drafts", "x.json"))).toBe(false);
  });

  test("import-part without --header takes the pad groups the card generator classes as headers, and says so", async () => {
    const out = join(dir, "drafts", "t-default.json");
    const text = await capture(["import-part", "t:srf", "--id", "t-default", "--out", out]);
    expect(text).toContain("headers taken: J1 (default; pin_header; reference J1; 2.54 mm pitch)");
    const def = JSON.parse(readFileSync(out, "utf8")) as PartDef;
    expect(def.pins.map((p) => [p.name, p.x, p.y])).toEqual([["A", 0, 0], ["B", 2.54, 0]]);
  });

  test("--outline is passed through and the draft says it was supplied on the command line", async () => {
    const out = join(dir, "drafts", "t-outline.json");
    const text = await capture(["import-part", "t:srf", "--header", "J1", "--id", "t-outline", "--out", out, "--outline", "0,0,10,5"]);
    expect(text).toContain("--outline you supplied on the command line");
    const def = JSON.parse(readFileSync(out, "utf8")) as PartDef;
    expect(def.body).toMatchObject({ w: 10, d: 5 });
    expect(def.verify).toContain("SUPPLIED ON THE COMMAND LINE");
    await expect(capture(["import-part", "t:srf", "--header", "J1", "--id", "t", "--out", join(dir, "drafts", "t.json"), "--outline", "1,2,3"])).rejects.toThrow(/four numbers/);
  });
});

describe("bundled snapshot", () => {
  let snapDb: string;
  const lines: string[] = [];
  const realLog = console.log;

  beforeAll(() => {
    snapDb = join(dir, "snapshot.sqlite");
    buildFixture(snapDb);
    const db = new Database(snapDb);
    db.exec(`CREATE TABLE metadata(key TEXT PRIMARY KEY, value TEXT NOT NULL);`);
    const meta: [string, string][] = [
      ["bundle_kind", "skill_snapshot"],
      ["bundle_part_count", "1056"],
      ["bundle_source_part_count", "4237"],
      ["bundle_source_created_at_utc", "2026-11-13T23:55:54.672657+00:00"],
    ];
    for (const [k, v] of meta) db.query(`INSERT INTO metadata VALUES(?,?)`).run(k, v);
    db.close();
  });

  const capture = async (argv: string[], dbFile: string): Promise<string> => {
    lines.length = 0;
    console.log = (...a: unknown[]) => void lines.push(a.join(" "));
    try {
      await run([...argv, "--db", dbFile]);
    } finally {
      console.log = realLog;
    }
    return lines.join("\n");
  };

  test("the snapshot marks are read; the full catalog has none", () => {
    const s = openCatalog(snapDb);
    const f = openCatalog(dbPath);
    expect(s.snapshot).toEqual({ bundled_snapshot: true, part_count: 1056, source_part_count: 4237, source_date: "2026-11-13", public: false });
    expect(snapshotLine("/x.sqlite", s.snapshot!)).toBe("catalog: /x.sqlite (bundled snapshot, 1,056 of 4,237 parts, listings as of 2026-11-13; prices and stock are frozen at that date)");
    expect(f.snapshot).toBeNull();
    expect(snapshotInfo(f.db)).toBeNull();
    expect(snapshotHint(null)).toBe("");
    s.db.close();
    f.db.close();
  });

  test("every human output starts with the snapshot line; the full catalog prints none", async () => {
    for (const argv of [["find", "HC-SR04"], ["show", "t:srf"], ["listings", "t:srf"], ["pads", "t:srf"], ["check-library"]]) {
      const text = await capture(argv, snapDb);
      expect(text.split("\n")[0]).toContain("bundled snapshot, 1,056 of 4,237 parts");
    }
    expect(await capture(["find", "HC-SR04"], dbPath)).not.toContain("bundled snapshot");
  });

  test("not found never reads as does-not-exist, in text and in --json", async () => {
    expect(await capture(["find", "zzzqqq"], snapDb)).toMatch(/may exist in the full catalog[\s\S]*--db[\s\S]*BENCHTOP_CATALOG/);
    await expect(capture(["show", "nope:1"], snapDb)).rejects.toThrow(/may exist in the full catalog/);
    await expect(capture(["pads", "nope:1"], snapDb)).rejects.toThrow(/may exist in the full catalog/);
    await expect(capture(["show", "nope:1"], dbPath)).rejects.not.toThrow(/full catalog/);
    const json = JSON.parse(await capture(["find", "zzzqqq", "--json"], snapDb)) as { catalog: { bundled_snapshot: boolean; part_count: number }; hint: string };
    expect(json.catalog).toMatchObject({ bundled_snapshot: true, part_count: 1056 });
    expect(json.hint).toContain("may exist in the full catalog");
    const full = JSON.parse(await capture(["find", "HC-SR04", "--json"], dbPath)) as { catalog: { bundled_snapshot: boolean }; hint?: string };
    expect(full.catalog.bundled_snapshot).toBe(false);
    expect(full.hint).toBeUndefined();
  });
});
