import { Database } from "bun:sqlite";
import { describe, expect, test } from "bun:test";
import { auditPublic, makePublic } from "./catalog-public";

// Minimal tables with the catalog's column names; only what catalog-public.ts touches.
const SCHEMA = `
CREATE TABLE metadata(key TEXT PRIMARY KEY, value TEXT NOT NULL);
CREATE TABLE sources(source_id INTEGER PRIMARY KEY, url TEXT NOT NULL, publisher TEXT NOT NULL, source_type TEXT NOT NULL,
  authority TEXT NOT NULL, retrieved_at TEXT NOT NULL, content_sha256 TEXT NOT NULL, source_text TEXT NOT NULL,
  extraction_method TEXT NOT NULL, notes TEXT);
CREATE TABLE parts(part_id TEXT PRIMARY KEY, name TEXT NOT NULL, brand TEXT, category TEXT NOT NULL, supplier_category TEXT,
  identity_scope TEXT NOT NULL, primary_source_id INTEGER NOT NULL, description TEXT, selection_rank INTEGER NOT NULL UNIQUE,
  selection_score REAL NOT NULL, selection_reason TEXT NOT NULL);
CREATE TABLE specifications(spec_id INTEGER PRIMARY KEY, part_id TEXT NOT NULL, key TEXT NOT NULL, value_text TEXT NOT NULL,
  source_id INTEGER NOT NULL, evidence_text TEXT NOT NULL);
CREATE TABLE measurements(measurement_id INTEGER PRIMARY KEY, part_id TEXT NOT NULL, values_mm_json TEXT NOT NULL,
  source_id INTEGER NOT NULL, evidence_text TEXT NOT NULL);
CREATE TABLE pin_definitions(pin_id INTEGER PRIMARY KEY, part_id TEXT NOT NULL, name TEXT NOT NULL, source_id INTEGER NOT NULL,
  evidence_text TEXT NOT NULL);
CREATE TABLE listings(listing_id INTEGER PRIMARY KEY, part_id TEXT NOT NULL, url TEXT NOT NULL, price REAL, source_id INTEGER NOT NULL);
CREATE TABLE family_memberships(part_id TEXT NOT NULL, family TEXT NOT NULL);
CREATE TABLE data_issues(issue_id INTEGER PRIMARY KEY, part_id TEXT, code TEXT NOT NULL, detail TEXT NOT NULL, source_id INTEGER);
CREATE VIRTUAL TABLE parts_fts USING fts5(part_id UNINDEXED,name,brand,category,families,specifications);
`;

function fixture(): Database {
  const db = new Database(":memory:");
  db.exec(SCHEMA);
  db.exec(`INSERT INTO metadata VALUES ('bundle_kind','skill_snapshot'),('ranking_method','Norway stock +22'),('schema_version','2')`);
  db.exec(`INSERT INTO sources VALUES
    (1,'https://maker.test/datasheet.pdf','Maker','official_documentation','manufacturer_primary','2026-11-13','h1','datasheet text','x','note'),
    (2,'https://shop.test/p/1','Shop','product_page','specialist_retailer_claim','2026-11-13','h2','shop text','x',NULL),
    (3,'https://unused.test','Maker','official_documentation','manufacturer_claim','2026-11-13','h3','','x',NULL)`);
  db.exec(`INSERT INTO parts VALUES
    ('maker:board-z','Zeta Board','Maker','development_board',NULL,'branded_product',1,'Marketing copy',1,9,'stock in Norway'),
    ('maker:board-a','Alpha Board','Maker','development_board','Boards','exact_manufacturer_sku',1,'More copy',2,8,'popular'),
    ('shop.test:77','Generic sensor','','sensor',NULL,'branded_product',1,NULL,3,7,'x'),
    ('maker:clone','Clone','Maker','sensor',NULL,'supplier_specific_product_manufacturer_unresolved',1,NULL,4,6,'x'),
    ('maker:shop-sourced','Shop board','Maker','sensor',NULL,'branded_product',2,NULL,5,5,'x')`);
  db.exec(`INSERT INTO specifications(part_id,key,value_text,source_id,evidence_text) VALUES
    ('maker:board-a','operating_voltage','3.3 V',1,'quoted sentence'),
    ('maker:board-a','operating_voltage','3.3V',2,'shop quote'),
    ('maker:board-a','feature','Fast chip',1,''),
    ('maker:board-a','notes','one two three four five six seven eight nine ten eleven twelve thirteen fourteen fifteen sixteen',1,'')`);
  db.exec(`INSERT INTO measurements(part_id,values_mm_json,source_id,evidence_text) VALUES
    ('maker:board-a','[51,21]',1,'Mechanical spec quote'),('maker:board-a','[50,20]',2,'Formfaktor')`);
  db.exec(`INSERT INTO pin_definitions(part_id,name,source_id,evidence_text) VALUES ('maker:board-a','GP0',1,'1 GP0'),('shop.test:77','VCC',1,'x')`);
  db.exec(`INSERT INTO listings(part_id,url,price,source_id) VALUES ('maker:board-a','https://shop.test/p/1',99,2)`);
  db.exec(`INSERT INTO data_issues(part_id,code,detail,source_id) VALUES
    ('maker:board-a','pcb_only_envelope','own finding',1),('maker:board-a','conflict','cites shop',2),(NULL,'global','x',NULL)`);
  return db;
}

describe("public catalog", () => {
  test("keeps manufacturer-identified parts and their manufacturer facts, nothing from retailers", () => {
    const db = fixture();
    const r = makePublic(db);
    expect(r.parts_out).toBe(2);
    const ids = db.query<{ part_id: string }, []>(`SELECT part_id FROM parts ORDER BY selection_rank`).all().map((x) => x.part_id);
    expect(ids).toEqual(["maker:board-a", "maker:board-z"]); // ranked by name, not popularity
    const specs = db.query<{ key: string; value_text: string; evidence_text: string }, []>(`SELECT key, value_text, evidence_text FROM specifications`).all();
    expect(specs).toEqual([{ key: "operating_voltage", value_text: "3.3 V", evidence_text: "" }]);
    expect(db.query(`SELECT values_mm_json, evidence_text FROM measurements`).all()).toEqual([{ values_mm_json: "[51,21]", evidence_text: "" }]);
    expect(db.query(`SELECT count(*) AS n FROM pin_definitions`).get()).toEqual({ n: 1 });
    expect(db.query(`SELECT count(*) AS n FROM listings`).get()).toEqual({ n: 0 });
    expect(db.query(`SELECT code FROM data_issues`).all()).toEqual([{ code: "pcb_only_envelope" }]);
    expect(db.query(`SELECT source_id, source_text, notes FROM sources`).all()).toEqual([{ source_id: 1, source_text: "", notes: null }]);
    expect(db.query(`SELECT count(*) AS n FROM parts WHERE description IS NOT NULL OR supplier_category IS NOT NULL`).get()).toEqual({ n: 0 });
    const meta = new Map(db.query<{ key: string; value: string }, []>(`SELECT key, value FROM metadata`).all().map((m) => [m.key, m.value]));
    expect(meta.has("ranking_method")).toBe(false);
    expect(meta.get("bundle_public")).toBe("1");
    expect(meta.get("license")).toContain("CC BY 4.0");
    expect(db.query(`SELECT part_id FROM parts_fts WHERE parts_fts MATCH 'voltage'`).all()).toEqual([{ part_id: "maker:board-a" }]);
    expect(auditPublic(db)).toEqual([]);
  });

  test("drops raw page captures and strips local file paths from kept notes and geometry", () => {
    const db = fixture();
    db.exec(`CREATE TABLE geometry_objects(geometry_id INTEGER PRIMARY KEY, part_id TEXT NOT NULL, source_id INTEGER NOT NULL, payload_json TEXT NOT NULL)`);
    const capture = JSON.stringify({ raw_file: "/Users/someone/work/page.html", raw_product_json_ld: { "@context": "https://schema.org/", offers: { price: 9.99 } } });
    const conflict = JSON.stringify({ local_path: "/Users/someone/work/ds.md", url: "https://maker.test/ds.pdf", rows: ["/home/x/a.txt", "3.3 V"] });
    const payload = JSON.stringify({ pads: [1], source_document: { page_number: 1, render_path: "/private/tmp/r.png" }, origin: "C:\\Users\\Admin\\board.PcbDoc" });
    db.prepare(`INSERT INTO data_issues(part_id,code,detail,source_id) VALUES ('maker:board-a','source_note',?,1)`).run(`Source capture metadata: ${capture}`);
    db.prepare(`INSERT INTO data_issues(part_id,code,detail,source_id) VALUES ('maker:board-a','conflict_note',?,1)`).run(conflict);
    db.prepare(`INSERT INTO data_issues(part_id,code,detail,source_id) VALUES ('maker:board-a','plain_note',?,1)`).run("Read from /Users/someone/work/x.pdf page 2");
    db.prepare(`INSERT INTO geometry_objects(part_id,source_id,payload_json) VALUES ('maker:board-a',1,?)`).run(payload);
    expect(auditPublic(db)).toEqual(
      expect.arrayContaining([
        "raw page captures retained in data_issues",
        "data_issues.detail holds a local file path",
        "data_issues.detail holds scraped product JSON-LD",
        "geometry_objects.payload_json holds a local file path",
      ]),
    );

    makePublic(db);
    const details = new Map(db.query<{ code: string; detail: string }, []>(`SELECT code, detail FROM data_issues`).all().map((r) => [r.code, r.detail] as const));
    expect(details.has("source_note")).toBe(false);
    expect(JSON.parse(String(details.get("conflict_note")))).toEqual({ url: "https://maker.test/ds.pdf", rows: ["3.3 V"] });
    expect(details.get("plain_note")).toBe("Read from <local file> page 2");
    const geo = JSON.parse(db.query<{ p: string }, []>(`SELECT payload_json AS p FROM geometry_objects`).get()!.p);
    expect(geo).toEqual({ pads: [1], source_document: { page_number: 1 } });
    expect(auditPublic(db)).toEqual([]);
  });

  test("drops quoted source text and local paths from scope notes, keeps the flags cards read", () => {
    const db = fixture();
    db.exec(`ALTER TABLE specifications ADD COLUMN scope_note TEXT`);
    const note = JSON.stringify({
      selected_i2c_address: true,
      evidence_fragments: ["The chip has a base address of 0x48 and a clever scheme."],
      full_evidence_as_submitted: "The chip has a base address of 0x48 and a clever scheme.",
      source_notes: { extra: [{ source_url: "https://maker.test/ds.pdf", evidence_fragments: ["quoted"] }], visual: { local_path: "/Users/someone/cap/x.png", capture_path: "work/enrichment/x.md", page: 3 } },
    });
    db.prepare(`UPDATE specifications SET scope_note = ? WHERE key = 'operating_voltage' AND source_id = 1`).run(note);
    expect(auditPublic(db)).toEqual(
      expect.arrayContaining(["specifications.scope_note holds quoted source text or a workspace path", "specifications.scope_note holds a local file path"]),
    );

    makePublic(db);
    const kept = JSON.parse(db.query<{ n: string }, []>(`SELECT scope_note AS n FROM specifications`).get()!.n);
    expect(kept).toEqual({ selected_i2c_address: true, source_notes: { extra: [{ source_url: "https://maker.test/ds.pdf" }], visual: { page: 3 } } });
    expect(auditPublic(db)).toEqual([]);
  });

  test("a table without a rule stops the build", () => {
    const db = fixture();
    db.exec(`CREATE TABLE new_prices(part_id TEXT, price REAL)`);
    expect(() => makePublic(db)).toThrow(/no rule for table\(s\): new_prices/);
  });

  test("the audit catches retailer data left behind", () => {
    const db = fixture();
    expect(auditPublic(db)).toEqual(
      expect.arrayContaining(["listings is not empty", "a retailer-keyed part remains", "part descriptions retained", "source text or notes retained"]),
    );
  });
});
