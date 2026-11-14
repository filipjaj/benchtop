import { Database } from "bun:sqlite";
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { build, keepIndex, parseArgs, slimGeometryPayload, slimPinNotes, stripTableUniques } from "./catalog-snapshot";

const dir = mkdtempSync(join(tmpdir(), "catalog-snapshot-"));
const srcPath = join(dir, "full.sqlite");
const outPath = join(dir, "snap.sqlite");
afterAll(() => rmSync(dir, { recursive: true, force: true }));

const PAD = {
  reference: "J1", pad_number: "3", net_name: "GND", x_mm: 2.54, y_mm: 5.08, pad_type: "through_hole", footprint_side: "top",
  drill_mm: 1.0, package: "1X08", pad_shape_as_source: null,
  source_evidence: { element: { name: "J1", x: "2.54" }, pad: { name: "3" } }, source_locator: "/eagle/drawing/board/elements/element[4]",
};

/** A source catalog with the real DDL shapes that matter: UNIQUE constraints, an FTS table, indexes and a view. */
function makeSource(): void {
  const db = new Database(srcPath, { create: true });
  db.exec(`
    PRAGMA user_version = 2;
    CREATE TABLE metadata(key TEXT PRIMARY KEY, value TEXT NOT NULL);
    CREATE TABLE sources(source_id INTEGER PRIMARY KEY, url TEXT NOT NULL, publisher TEXT NOT NULL, source_type TEXT NOT NULL,
      authority TEXT NOT NULL, retrieved_at TEXT NOT NULL, content_sha256 TEXT NOT NULL, source_text TEXT NOT NULL,
      extraction_method TEXT NOT NULL, notes TEXT, UNIQUE(url,content_sha256));
    CREATE TABLE parts(part_id TEXT PRIMARY KEY, name TEXT NOT NULL, category TEXT NOT NULL,
      primary_source_id INTEGER NOT NULL REFERENCES sources, selection_rank INTEGER NOT NULL UNIQUE);
    CREATE TABLE specifications(spec_id INTEGER PRIMARY KEY, part_id TEXT NOT NULL REFERENCES parts, key TEXT NOT NULL,
      value_text TEXT NOT NULL, source_id INTEGER NOT NULL REFERENCES sources, evidence_text TEXT NOT NULL,
      UNIQUE(part_id,key,value_text,source_id));
    CREATE TABLE pin_definitions(pin_id INTEGER PRIMARY KEY, part_id TEXT NOT NULL REFERENCES parts, name TEXT NOT NULL,
      source_id INTEGER NOT NULL REFERENCES sources);
    CREATE TABLE geometry_objects(geometry_id INTEGER PRIMARY KEY, part_id TEXT NOT NULL REFERENCES parts,
      source_id INTEGER NOT NULL REFERENCES sources, kind TEXT NOT NULL, payload_json TEXT NOT NULL);
    CREATE TABLE assets(asset_id INTEGER PRIMARY KEY, part_id TEXT NOT NULL REFERENCES parts, kind TEXT NOT NULL,
      url TEXT NOT NULL, source_id INTEGER NOT NULL REFERENCES sources, UNIQUE(part_id,url));
    CREATE TABLE asset_files(url TEXT PRIMARY KEY, relative_path TEXT, status TEXT NOT NULL);
    CREATE TABLE data_issues(issue_id INTEGER PRIMARY KEY, part_id TEXT REFERENCES parts, code TEXT NOT NULL,
      detail TEXT NOT NULL, source_id INTEGER REFERENCES sources);
    CREATE TABLE family_memberships(part_id TEXT NOT NULL REFERENCES parts, family TEXT NOT NULL, PRIMARY KEY(part_id,family));
    CREATE TABLE market_evidence(evidence_id INTEGER PRIMARY KEY, family TEXT NOT NULL, url TEXT NOT NULL,
      source_id INTEGER NOT NULL REFERENCES sources);
    CREATE INDEX specifications_part ON specifications(part_id);
    CREATE INDEX specifications_key ON specifications(key,value_text);
    CREATE VIRTUAL TABLE parts_fts USING fts5(part_id UNINDEXED, name, specifications);
    CREATE VIEW v_curated AS SELECT * FROM parts WHERE selection_rank <= 1000;
    INSERT INTO metadata VALUES ('created_at_utc', '2026-11-13T22:19:14+00:00'), ('schema_version', '2');
  `);
  const src = db.prepare(`INSERT INTO sources VALUES (?, ?, 'pub', 'page', 'manufacturer', '2026-11-13', ?, ?, 'html', ?)`);
  for (let i = 1; i <= 6; i++) src.run(i, `https://example.test/${i}`, `hash${i}`, `long page text ${i}`.repeat(50), `note ${i}`);
  db.exec(`
    INSERT INTO parts VALUES ('a:1','Board One','development_board',1,1), ('a:2','Sensor Two','sensor',2,2),
      ('a:pins','Unranked With Pins','development_board',3,5000), ('a:out','Unranked Plain','sensor',4,6000),
      ('a:lib','Unranked Library Match','sensor',4,7000);
    INSERT INTO specifications VALUES (1,'a:1','voltage','3.3 V',1,'Operating voltage: 3.3 V'), (2,'a:out','voltage','5 V',4,'5 V');
    INSERT INTO pin_definitions VALUES (1,'a:pins','GP0',3);
    INSERT INTO assets VALUES (1,'a:1','pinout','https://example.test/pinout.pdf',1), (2,'a:1','product_image','https://example.test/photo.jpg',1);
    INSERT INTO asset_files VALUES ('https://example.test/pinout.pdf','references/ab/pinout.pdf','downloaded');
    INSERT INTO data_issues VALUES (1,'a:1','pcb_only_envelope','bare board',1), (2,NULL,'catalog_wide','applies to all',NULL), (3,'a:out','x','dropped',5);
    INSERT INTO family_memberships VALUES ('a:1','pico'), ('a:out','uno');
    INSERT INTO market_evidence VALUES (1,'pico','https://example.test/ali/pico',6), (2,'uno','https://example.test/ali/uno',5);
    INSERT INTO parts_fts(part_id,name,specifications) VALUES ('a:1','Board One','voltage 3.3 V'), ('a:out','Unranked Plain','voltage 5 V');
  `);
  db.prepare(`INSERT INTO geometry_objects VALUES (1,'a:1',2,'pcb_pad_centers',?)`).run(JSON.stringify({ payload_schema_version: 1, frame: "eagle", pads: [PAD] }));
  db.prepare(`INSERT INTO geometry_objects VALUES (2,'a:1',2,'pcb_outline_and_drills',?)`).run(JSON.stringify({ outline: [[0, 0], [10, 0]] }));
  db.close();
}

const args = (extra: string[] = []): ReturnType<typeof parseArgs> => parseArgs(["--src", srcPath, "--out", outPath, ...extra], {});

beforeAll(makeSource);

describe("helpers", () => {
  test("slimGeometryPayload keeps coordinates and identifiers, drops evidence and nulls, and says so", () => {
    const slim = JSON.parse(slimGeometryPayload(JSON.stringify({ payload_schema_version: 1, frame: "eagle", pads: [PAD] })));
    expect(slim.pads[0]).toEqual({ reference: "J1", pad_number: "3", net_name: "GND", x_mm: 2.54, y_mm: 5.08, pad_type: "through_hole", footprint_side: "top", drill_mm: 1.0, package: "1X08" });
    expect(slim.frame).toBe("eagle");
    expect(slim.payload_schema_version).toBe(1);
    expect(slim.bundle_slim.dropped_pad_fields).toEqual(["pad_shape_as_source", "source_evidence", "source_locator"]);
  });

  test("slimGeometryPayload leaves payloads without pads untouched", () => {
    const outline = JSON.stringify({ outline: [[0, 0]] });
    expect(slimGeometryPayload(outline)).toBe(outline);
  });

  // A refresh from a grown catalog came out at 150 MB instead of 34: newer payloads carry
  // per-component and per-net parser records, and every drill of every pad, that nothing reads.
  test("a bulky top-level record that nothing reads is left out, and the payload says which", () => {
    const bulk = Array.from({ length: 200 }, (_, i) => ({ component: `R${i}`, value: "10k", evidence: "x".repeat(20) }));
    const slim = JSON.parse(slimGeometryPayload(JSON.stringify({ frame: "eagle", pads: [PAD], native_components: bulk, skipped_pads: [{ ...PAD, why: "no net" }], parser: "v3" })));
    expect(slim.native_components).toBeUndefined();
    expect(slim.bundle_slim.dropped_keys).toEqual(["native_components"]);
    // Small descriptive keys stay, read or not.
    expect(slim.parser).toBe("v3");
    // Skipped pads are only counted: one entry in, one entry out, without its evidence.
    expect(slim.skipped_pads).toHaveLength(1);
    expect(slim.skipped_pads[0].why).toBeUndefined();
  });

  test("an outline keeps its bounds and holes however large, and loses the per-pad drill list", () => {
    const holes = Array.from({ length: 150 }, (_, i) => ({ x_mm: i, y_mm: 2, drill_mm: 3.2, note: "mounting hole candidate" }));
    const drills = Array.from({ length: 300 }, (_, i) => ({ reference: `U${i}`, x_mm: i, y_mm: 1, drill_mm: 0.4 }));
    const slim = JSON.parse(slimGeometryPayload(JSON.stringify({ outline_bounds: { min_mm: [0, 0], max_mm: [50, 20] }, source_pcb_thickness_mm: 1.6, explicit_holes: holes, pad_drills: drills })));
    expect(slim.outline_bounds).toEqual({ min_mm: [0, 0], max_mm: [50, 20] });
    expect(slim.explicit_holes).toHaveLength(150);
    expect(slim.pad_drills).toBeUndefined();
    expect(slim.bundle_slim.dropped_keys).toEqual(["pad_drills"]);
    expect(slim.bundle_slim.dropped_pad_fields).toBeUndefined();
  });

  test("a 3D model's boards are kept whole", () => {
    const model = JSON.stringify({ boards: [{ maximum_height_above_pcb_mm: 8.5, connectors: Array.from({ length: 60 }, (_, i) => ({ source_names: [`JST:X${i}`], apertures: [{ edge: "x_max", width_mm: 5 }] })) }] });
    expect(slimGeometryPayload(model)).toBe(model);
  });

  test("a 3D model's drilled holes keep where they are and how wide, and lose the parser's evidence", () => {
    // Catalog revision 4 lists every hole of a board with 23 fields: 22 MB over 235 models.
    const hole = { center_xy_mm: [3.2, 4.1], diameter_mm: 1.02, kind: "drilled_hole", plating: "plated", center_x_mm: 3.2, source_topology: "cylindrical face 41", validation: "nominal_model_feature", z_min_mm: 0, z_max_mm: 1.6 };
    const slim = JSON.parse(slimGeometryPayload(JSON.stringify({ boards: [{ maximum_height_above_pcb_mm: 8.5, drilled_holes: [hole, hole] }] })));
    expect(slim.boards[0].drilled_holes).toEqual([
      { center_xy_mm: [3.2, 4.1], diameter_mm: 1.02, kind: "drilled_hole", plating: "plated" },
      { center_xy_mm: [3.2, 4.1], diameter_mm: 1.02, kind: "drilled_hole", plating: "plated" },
    ]);
    expect(slim.boards[0].maximum_height_above_pcb_mm).toBe(8.5);
    expect(slim.bundle_slim.dropped_hole_fields).toEqual(["center_x_mm", "source_topology", "validation", "z_max_mm", "z_min_mm"]);
  });

  test("slimPinNotes keeps short notes and plain text, and cuts long JSON down to the dataset bindings", () => {
    expect(slimPinNotes(null)).toBeNull();
    expect(slimPinNotes("conflicts with the silkscreen")).toBe("conflicts with the silkscreen");
    const long = JSON.stringify({ supported_geometry_ids: [12, 14], name_conflict: "D7 on the silkscreen, GPIO13 in the table", pin_evidence: "(pin passive line ".repeat(200) });
    const slim = JSON.parse(slimPinNotes(long)!);
    expect(slim.supported_geometry_ids).toEqual([12, 14]);
    expect(slim.name_conflict).toContain("silkscreen");
    expect(slim.pin_evidence).toBeUndefined();
    expect(typeof slim.bundle_slim).toBe("string");
    // Long text that is not JSON is someone's sentence, not parser output: left alone.
    const prose = "note ".repeat(400);
    expect(slimPinNotes(prose)).toBe(prose);
  });

  test("stripTableUniques removes table constraints but not a column-level UNIQUE", () => {
    const sql = "CREATE TABLE t(a TEXT, b INTEGER NOT NULL UNIQUE, c TEXT,\n UNIQUE(a,c))";
    expect(stripTableUniques(sql)).toBe("CREATE TABLE t(a TEXT, b INTEGER NOT NULL UNIQUE, c TEXT)");
  });

  test("keepIndex keeps only indexes that lead with part_id", () => {
    expect(keepIndex("CREATE INDEX s_part ON specifications(part_id)")).toBe(true);
    expect(keepIndex("CREATE INDEX s_key ON specifications(key,unit,value_num)")).toBe(false);
  });

  test("parseArgs refuses to write over the source", () => {
    expect(() => parseArgs(["--src", srcPath, "--out", srcPath], {})).toThrow(/must not be the source/);
  });
});

describe("build", () => {
  test("selects ranked parts plus parts with pins or geometry, and the include list", () => {
    const include = join(dir, "ids.json");
    writeFileSync(include, JSON.stringify(["a:lib", "a:missing"]));
    const r = build(args(["--include", include]));
    const db = new Database(outPath, { readonly: true });
    const ids = (db.query(`SELECT part_id FROM parts ORDER BY part_id`).all() as { part_id: string }[]).map((x) => x.part_id);
    expect(ids).toEqual(["a:1", "a:2", "a:lib", "a:pins"]);
    expect(r.unknownIncludes).toEqual(["a:missing"]);
    db.close();
  });

  test("drops source text, unreferenced sources, uncached-only asset kinds and write-guard indexes", () => {
    build(args());
    const db = new Database(outPath, { readonly: true });
    const one = <T>(sql: string): T => db.query(sql).get() as T;
    const all = <T>(sql: string): T[] => db.query(sql).all() as T[];

    expect(one<{ user_version: number }>(`PRAGMA user_version`).user_version).toBe(2);
    expect(one<{ journal_mode: string }>(`PRAGMA journal_mode`).journal_mode).toBe("delete");

    // Sources 1-3 and 6 are referenced by kept rows; 4 and 5 only by the dropped part.
    expect(all<{ source_id: number }>(`SELECT source_id FROM sources ORDER BY 1`).map((s) => s.source_id)).toEqual([1, 2, 3, 6]);
    expect(one<{ n: number }>(`SELECT count(*) AS n FROM sources WHERE source_text != '' OR notes IS NOT NULL`).n).toBe(0);
    expect(one<{ url: string }>(`SELECT url FROM sources WHERE source_id = 1`).url).toBe("https://example.test/1");

    expect(all<{ kind: string }>(`SELECT kind FROM assets`).map((a) => a.kind)).toEqual(["pinout"]);
    expect(one<{ n: number }>(`SELECT count(*) AS n FROM asset_files`).n).toBe(0);

    expect(all<{ issue_id: number }>(`SELECT issue_id FROM data_issues ORDER BY 1`).map((i) => i.issue_id)).toEqual([1, 2]);
    expect(all<{ family: string }>(`SELECT family FROM market_evidence`).map((m) => m.family)).toEqual(["pico"]);
    expect(one<{ evidence_text: string }>(`SELECT evidence_text FROM specifications WHERE spec_id = 1`).evidence_text).toBe("");

    const pad = JSON.parse(one<{ payload_json: string }>(`SELECT payload_json FROM geometry_objects WHERE geometry_id = 1`).payload_json);
    expect(Object.keys(pad.pads[0])).not.toContain("source_evidence");
    expect(pad.pads[0].x_mm).toBe(2.54);

    const objects = all<{ name: string }>(`SELECT name FROM sqlite_master`).map((o) => o.name);
    expect(objects).toContain("specifications_part");
    expect(objects).toContain("v_curated");
    expect(objects).not.toContain("specifications_key");
    expect(objects).not.toContain("sqlite_autoindex_specifications_1");

    // Full-text search still answers, and only for bundled parts.
    expect(all<{ part_id: string }>(`SELECT part_id FROM parts_fts WHERE parts_fts MATCH 'voltage'`).map((f) => f.part_id)).toEqual(["a:1"]);

    const meta = Object.fromEntries(all<{ key: string; value: string }>(`SELECT key, value FROM metadata`).map((m) => [m.key, m.value]));
    expect(meta.bundle_kind).toBe("skill_snapshot");
    expect(meta.bundle_part_count).toBe("3");
    expect(meta.bundle_source_part_count).toBe("5");
    expect(meta.schema_version).toBe("2");
    db.close();
  });

  test("the same source and options give the same bytes", () => {
    build(args());
    const first = readFileSync(outPath);
    build(args());
    expect(readFileSync(outPath).equals(first)).toBe(true);
  });

  test("--keep-spec-evidence keeps the evidence line", () => {
    build(args(["--keep-spec-evidence"]));
    const db = new Database(outPath, { readonly: true });
    expect((db.query(`SELECT evidence_text FROM specifications WHERE spec_id = 1`).get() as { evidence_text: string }).evidence_text).toBe("Operating voltage: 3.3 V");
    db.close();
  });

  test("a source with a different schema version is refused", () => {
    const other = join(dir, "v3.sqlite");
    const db = new Database(other, { create: true });
    db.exec(`PRAGMA user_version = 3; CREATE TABLE metadata(key TEXT PRIMARY KEY, value TEXT NOT NULL);`);
    db.close();
    expect(() => build(parseArgs(["--src", other, "--out", outPath], {}))).toThrow(/schema version 3/);
  });

  test("a table without a copy rule stops the build", () => {
    const other = join(dir, "extra.sqlite");
    const db = new Database(other, { create: true });
    db.exec(`PRAGMA user_version = 2; CREATE TABLE metadata(key TEXT PRIMARY KEY, value TEXT NOT NULL); CREATE TABLE brand_new(x TEXT);`);
    db.close();
    expect(() => build(parseArgs(["--src", other, "--out", outPath], {}))).toThrow(/no rule for: brand_new/);
  });
});
