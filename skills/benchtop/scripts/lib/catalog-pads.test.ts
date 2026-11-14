// Tests for catalog-pads.ts against a tiny in-memory database. The real catalog is never opened.

import { Database } from "bun:sqlite";
import { afterAll, beforeEach, describe, expect, test } from "bun:test";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { buildBoard, type GeometryRow, type PinDefRow } from "../catalog-cards";
import {
  PadsError,
  boxToYDown,
  cachedPinoutFiles,
  describePads,
  formatImport,
  formatPads,
  importPart,
  missingFields,
  parseHeaderSpecs,
  parseOutlineArg,
  pinFacts,
  placePoints,
  readFrame,
  type HeaderSpec,
  type Rot,
} from "./catalog-pads";
import { editedAfterImport, geometrySha256 } from "./import-provenance";
import { rotPoint } from "./iso";
import type { PartDef } from "./types";

const SCHEMA = `
CREATE TABLE parts(part_id TEXT PRIMARY KEY, name TEXT NOT NULL, brand TEXT);
CREATE TABLE geometry_objects(
 geometry_id INTEGER PRIMARY KEY, part_id TEXT NOT NULL, kind TEXT NOT NULL, unit TEXT NOT NULL DEFAULT 'mm',
 coordinate_frame TEXT NOT NULL, revision TEXT, source_url TEXT NOT NULL, source_sha256 TEXT,
 payload_json TEXT NOT NULL, validation_status TEXT NOT NULL DEFAULT 'not_fit_verified');
CREATE TABLE pin_definitions(pin_id INTEGER PRIMARY KEY, part_id TEXT NOT NULL, connector TEXT NOT NULL, pin_number TEXT NOT NULL, name TEXT NOT NULL,
 electrical_type_as_source TEXT, functions_as_source TEXT NOT NULL DEFAULT '', source_id INTEGER NOT NULL DEFAULT 0, revision TEXT, notes TEXT);
CREATE TABLE assets(asset_id INTEGER PRIMARY KEY, part_id TEXT NOT NULL, kind TEXT NOT NULL, title TEXT, url TEXT NOT NULL);
CREATE TABLE asset_files(url TEXT PRIMARY KEY, relative_path TEXT, status TEXT);
CREATE VIEW v_assets AS SELECT a.*, f.relative_path, f.status AS local_status FROM assets a LEFT JOIN asset_files f USING(url);
CREATE TABLE envelopes(part_id TEXT PRIMARY KEY, a_mm REAL NOT NULL, b_mm REAL NOT NULL, c_mm REAL, axis_labels_json TEXT, scope TEXT NOT NULL, source_id INTEGER NOT NULL DEFAULT 0,
 evidence_text TEXT NOT NULL DEFAULT '', verification_status TEXT NOT NULL DEFAULT 'v', exact_variant_required INTEGER NOT NULL DEFAULT 0, variant_sku TEXT);
CREATE TABLE sources(source_id INTEGER PRIMARY KEY, url TEXT NOT NULL, authority TEXT NOT NULL DEFAULT 'manufacturer', content_sha256 TEXT);
CREATE TABLE specifications(spec_id INTEGER PRIMARY KEY, part_id TEXT NOT NULL, domain TEXT NOT NULL DEFAULT 'electrical', key TEXT NOT NULL, value_text TEXT NOT NULL,
 value_num REAL, minimum_num REAL, maximum_num REAL, unit TEXT, source_id INTEGER NOT NULL DEFAULT 1, evidence_text TEXT NOT NULL DEFAULT '',
 validation_status TEXT NOT NULL DEFAULT 'source_claim_not_independently_verified', claim_scope TEXT NOT NULL DEFAULT 'unspecified', scope_note TEXT);
`;

const UP = { x_direction: "right", y_direction: "up", view: "top" };
const DOWN = { x_direction: "right", y_direction: "down", view: "top" };

interface PadIn {
  ref: string;
  n: string | number;
  x: number;
  y: number;
  net?: string | null;
  type?: string;
  /** CAD package, which is what tells a header from a component. */
  pkg?: string;
}

let db: Database;
let nextId = 1;

function addPart(id: string, name = "Test Board"): void {
  db.query(`INSERT INTO parts(part_id,name,brand) VALUES(?,?,?)`).run(id, name, "Acme");
}

function addPads(part: string, o: { frame: object; text: string; url: string; sha: string; revision?: string; pads: PadIn[] }): number {
  const payload = {
    frame: o.frame,
    pads: o.pads.map((p) => ({ reference: p.ref, pad_number: p.n, net_name: p.net ?? null, x_mm: p.x, y_mm: p.y, pad_type: p.type ?? "through_hole", footprint_side: "top", ...(p.pkg ? { package: p.pkg } : {}) })),
  };
  const id = nextId++;
  db.query(`INSERT INTO geometry_objects(geometry_id,part_id,kind,coordinate_frame,revision,source_url,source_sha256,payload_json) VALUES(?,?,?,?,?,?,?,?)`).run(
    id,
    part,
    "pcb_pad_centers",
    o.text,
    o.revision ?? "rev-a",
    o.url,
    o.sha,
    JSON.stringify(payload),
  );
  return id;
}

function addOutline(part: string, o: { text: string; url: string; sha: string; min: [number, number]; max: [number, number]; thickness?: number }): number {
  const payload = { outline_bounds: { min_mm: o.min, max_mm: o.max, scope: "edge_cuts_geometry_union" }, source_pcb_thickness_mm: o.thickness };
  const id = nextId++;
  db.query(`INSERT INTO geometry_objects(geometry_id,part_id,kind,coordinate_frame,revision,source_url,source_sha256,payload_json) VALUES(?,?,?,?,?,?,?,?)`).run(
    id,
    part,
    "pcb_outline_and_drills",
    o.text,
    "rev-a",
    o.url,
    o.sha,
    JSON.stringify(payload),
  );
  return id;
}

const H = (reference: string, pads: string[] | null = null): HeaderSpec => ({ reference, pads });

interface PinRow {
  connector: string;
  n: string | number;
  name: string;
  type?: string | null;
  fn?: string;
  /** Geometry ids the row is bound to (the catalog's supported_geometry_ids). */
  bound?: number[];
}

function addPinRows(part: string, rows: PinRow[]): void {
  const ins = db.query(`INSERT INTO pin_definitions(part_id,connector,pin_number,name,electrical_type_as_source,functions_as_source,notes) VALUES(?,?,?,?,?,?,?)`);
  for (const r of rows) ins.run(part, r.connector, String(r.n), r.name, r.type ?? null, r.fn ?? "", r.bound ? JSON.stringify({ supported_geometry_ids: r.bound }) : null);
}

/** A module footprint dataset (footprint-local KiCad frame). */
function addLand(part: string, o: { url?: string; sha?: string; pads: PadIn[]; revision?: string }): number {
  const payload = {
    frame: DOWN,
    pads: o.pads.map((p) => ({ reference: p.ref, pad_number: p.n === "" ? "" : p.n, net_name: null, x_mm: p.x, y_mm: p.y, pad_type: p.type ?? "through_hole", footprint_side: "top", footprint_name: "FP" })),
  };
  const id = nextId++;
  db.query(`INSERT INTO geometry_objects(geometry_id,part_id,kind,coordinate_frame,revision,source_url,source_sha256,payload_json) VALUES(?,?,?,?,?,?,?,?)`).run(
    id,
    part,
    "module_land_pattern",
    "source_native_kicad_footprint_local_origin; X_right; Y_down",
    o.revision ?? "fp-a",
    o.url ?? `https://x/${part}-${id}.kicad_mod`,
    o.sha ?? `land${id}`,
    JSON.stringify(payload),
  );
  return id;
}

/** Two contact rows of 20 pads at 2.54 mm pitch, 17.78 apart, plus four unplated holes between them (a Pico-like footprint, 17.78 x 49.26 mm of pads). */
function picoPads(): PadIn[] {
  const n = 20;
  const pads: PadIn[] = [];
  for (let i = 0; i < n; i++) pads.push({ ref: "U2", n: i + 1, x: 0, y: i * 2.54 });
  for (let i = 0; i < n; i++) pads.push({ ref: "U2", n: n + i + 1, x: 17.78, y: (n - 1 - i) * 2.54 });
  for (const [x, y] of [[2.725, -0.5], [15.055, -0.5], [2.725, 48.76], [15.055, 48.76]] as [number, number][]) pads.push({ ref: "U2", n: "", x, y, type: "np_thru_hole" });
  return pads;
}

function addEnvelope(part: string, a: number, b: number, c: number | null, scope = "pcb", labels: string[] | null = ["length", "width", "pcb_thickness"]): void {
  db.query(`INSERT INTO envelopes(part_id,a_mm,b_mm,c_mm,axis_labels_json,scope,source_id) VALUES(?,?,?,?,?,?,7)`).run(part, a, b, c, labels ? JSON.stringify(labels) : null, scope);
  db.query(`INSERT OR IGNORE INTO sources(source_id,url,content_sha256) VALUES(7,'https://x/datasheet.pdf','envsha')`).run();
}

function addSpec(part: string, key: string, value: string, o: { source?: number; scope?: string } = {}): void {
  db.query(`INSERT INTO specifications(part_id,key,value_text,source_id,claim_scope) VALUES(?,?,?,?,?)`).run(part, key, value, o.source ?? 1, o.scope ?? "unspecified");
  db.query(`INSERT OR IGNORE INTO sources(source_id,url,content_sha256) VALUES(?,?,NULL)`).run(o.source ?? 1, `https://x/spec${o.source ?? 1}`);
}

beforeEach(() => {
  db = new Database(":memory:");
  db.exec(SCHEMA);
  nextId = 1;
});

describe("readFrame", () => {
  test("reads the structured frame", () => {
    expect(readFrame(JSON.stringify(UP), "anything").yDir).toBe("up");
    expect(readFrame(JSON.stringify(DOWN), "anything").yDir).toBe("down");
  });
  test("falls back to the free text", () => {
    expect(readFrame(null, "native; top_view; X_right; Y_up; not_rebased").yDir).toBe("up");
    expect(readFrame(null, "KiCad, X right and Y down, origin kept").yDir).toBe("down");
  });
  test("refuses what it cannot read or would have to mirror", () => {
    expect(() => readFrame(null, "some frame")).toThrow(PadsError);
    expect(() => readFrame(JSON.stringify({ x_direction: "left", y_direction: "up" }), "")).toThrow(/x runs left/);
    expect(() => readFrame(JSON.stringify({ x_direction: "right", y_direction: "up", view: "bottom" }), "")).toThrow(/bottom view/);
  });
});

describe("placePoints", () => {
  const box = { minX: 10, minY: 20, maxX: 60, maxY: 50 }; // 50 x 30
  test("identity puts the box corner at the origin", () => {
    const r = placePoints([{ x: 15, y: 25 }], box, 0, false);
    expect(r).toEqual({ points: [{ x: 5, y: 5 }], w: 50, d: 30 });
  });
  test("rotation is clockwise about the box and swaps the size", () => {
    const tl = { x: 10, y: 20 };
    expect(placePoints([tl], box, 90, false).points[0]).toEqual({ x: 30, y: 0 }); // top-left goes to top-right
    expect(placePoints([tl], box, 180, false).points[0]).toEqual({ x: 50, y: 30 });
    expect(placePoints([tl], box, 270, false).points[0]).toEqual({ x: 0, y: 50 }); // top-left goes to bottom-left
    const r = placePoints([tl], box, 90, false);
    expect([r.w, r.d]).toEqual([30, 50]);
  });
  test("mirror flips left-right before rotation", () => {
    expect(placePoints([{ x: 15, y: 25 }], box, 0, true).points[0]).toEqual({ x: 45, y: 5 });
    expect(placePoints([{ x: 10, y: 20 }], box, 90, true).points[0]).toEqual({ x: 30, y: 50 });
  });
  test("a Y-up box becomes a Y-down box with min and max swapped", () => {
    const up = boxToYDown({ minX: 0, minY: 0, maxX: 10, maxY: 4 }, { yDir: "up", how: "", text: "" });
    expect(up).toEqual({ minX: 0, maxX: 10, minY: -4, maxY: -0 });
  });
});

describe("importPart: frames", () => {
  test("Y-up (EAGLE) with an outline: the top-left of the board seen from above is the origin", () => {
    addPart("t:up");
    // Board 50 x 30 at (10,20)-(60,50) in Y-up. Seen from above its top edge is y = 50.
    addPads("t:up", {
      frame: UP,
      text: "X_right; Y_up",
      url: "https://x/a.brd",
      sha: "aa",
      pads: [
        { ref: "J1", n: 1, x: 15, y: 47.46, net: "A" }, // 2.54 below the top edge
        { ref: "J1", n: 2, x: 17.54, y: 47.46, net: "B" },
        { ref: "R1", n: 1, x: 30, y: 30 },
      ],
    });
    addOutline("t:up", { text: "X_right; Y_up", url: "https://x/a.brd", sha: "aa", min: [10, 20], max: [60, 50] });
    const r = importPart(db, "/db", { partId: "t:up", headers: [H("J1")], id: "t-up" });
    expect(r.outline).toBe("outline dataset");
    expect(r.part.body).toMatchObject({ w: 50, d: 30 });
    const [a, b] = r.part.pins;
    expect([a!.x, a!.y]).toEqual([5, 2.54]);
    expect([b!.x, b!.y]).toEqual([7.54, 2.54]);
  });

  test("Y-down (KiCad) with the origin far outside the board", () => {
    addPart("t:down");
    addPads("t:down", {
      frame: DOWN,
      text: "X right, Y down",
      url: "https://x/b.kicad_pcb",
      sha: "bb",
      pads: [
        { ref: "J2", n: 1, x: 141.5, y: 102.54, net: "P" },
        { ref: "J2", n: 2, x: 141.5, y: 105.08, net: "Q" },
      ],
    });
    addOutline("t:down", { text: "X right and Y down", url: "https://x/b.kicad_pcb", sha: "bb", min: [140, 100], max: [160, 120], thickness: 1.2 });
    const r = importPart(db, "/db", { partId: "t:down", headers: [H("J2")], id: "t-down" });
    expect(r.part.body).toEqual({ w: 20, d: 20, h: 1.2 });
    expect(r.part.pins.map((p) => [p.x, p.y])).toEqual([
      [1.5, 2.54],
      [1.5, 5.08],
    ]);
    // PCB thickness came from the outline dataset, so it is not reported as a placeholder.
    expect(r.missing.some((m) => m.startsWith("body.h"))).toBe(false);
  });

  test("rotation and mirror apply about the outline", () => {
    addPart("t:rot");
    addPads("t:rot", { frame: DOWN, text: "X right, Y down", url: "u", sha: "s", pads: [{ ref: "J", n: 1, x: 1, y: 2, net: "N" }] });
    addOutline("t:rot", { text: "X right, Y down", url: "u", sha: "s", min: [0, 0], max: [10, 20] });
    const at = (rot: Rot, mirror = false) => importPart(db, "/db", { partId: "t:rot", headers: [H("J")], id: "t", rot, mirror });
    expect(at(0).part.pins[0]).toMatchObject({ x: 1, y: 2 });
    expect(at(90).part.pins[0]).toMatchObject({ x: 18, y: 1 });
    expect(at(90).part.body).toMatchObject({ w: 20, d: 10 });
    expect(at(180).part.pins[0]).toMatchObject({ x: 9, y: 18 });
    expect(at(270).part.pins[0]).toMatchObject({ x: 2, y: 9 });
    expect(at(0, true).part.pins[0]).toMatchObject({ x: 9, y: 2 });
  });

  test("without an outline the box is the bounding box of ALL pads, and the draft says so", () => {
    addPart("t:nobox");
    addPads("t:nobox", {
      frame: UP,
      text: "X_right; Y_up",
      url: "u",
      sha: "s",
      pads: [
        { ref: "J1", n: 1, x: 10, y: 8, net: "A" },
        { ref: "R9", n: 1, x: 2, y: 1 }, // not imported, but defines the box
        { ref: "R9", n: 2, x: 30, y: 9 },
      ],
    });
    const r = importPart(db, "/db", { partId: "t:nobox", headers: [H("J1")], id: "t" });
    expect(r.outline).toBe("bounding box of all pads");
    expect(r.part.body).toMatchObject({ w: 28, d: 8 });
    expect(r.part.pins[0]).toMatchObject({ x: 8, y: 1 }); // top edge is y = 9
    expect(r.part.verify).toContain("bounding box of ALL 3 pads");
    expect(r.part.verify).toContain("not the board edge");
    expect(formatImport(r, "/o/t.json")).toContain("BOUNDING BOX OF ALL PADS");
    expect(r.missing.some((m) => m.startsWith("body.h"))).toBe(true);
  });

  test("an outline from a different CAD file is not used", () => {
    addPart("t:other");
    addPads("t:other", { frame: DOWN, text: "X right, Y down", url: "u1", sha: "s1", pads: [{ ref: "J", n: 1, x: 5, y: 5, net: "N" }, { ref: "J", n: 2, x: 9, y: 5, net: "M" }] });
    addOutline("t:other", { text: "X right, Y down", url: "u2", sha: "s2", min: [0, 0], max: [100, 100] });
    const r = importPart(db, "/db", { partId: "t:other", headers: [H("J")], id: "t" });
    expect(r.outline).toBe("bounding box of all pads");
    expect(r.part.body).toMatchObject({ w: 4, d: 0 });
  });
});

describe("--outline override", () => {
  test("replaces the pad bounding box, in the dataset's own (Y-up) frame, and says so", () => {
    addPart("t:ov");
    // Pads at 2.54 from the lower-left origin, as on an Uno; the pad box alone would be 10 x 1.
    addPads("t:ov", {
      frame: UP,
      text: "X_right; Y_up",
      url: "u",
      sha: "s",
      pads: [
        { ref: "J1", n: 1, x: 2.54, y: 2.54, net: "A" },
        { ref: "J1", n: 2, x: 12.54, y: 3.54, net: "B" },
      ],
    });
    const r = importPart(db, "/db", { partId: "t:ov", headers: [H("J1")], id: "t", outline: parseOutlineArg("0,0,20,10") });
    expect(r.outline).toBe("outline supplied on the command line");
    expect(r.part.body).toMatchObject({ w: 20, d: 10 });
    // Lower-left origin, Y up: a pad 2.54 above the bottom edge is 7.46 below the top edge.
    expect(r.part.pins.map((p) => [p.x, p.y])).toEqual([
      [2.54, 7.46],
      [12.54, 6.46],
    ]);
    expect(r.part.verify).toContain("SUPPLIED ON THE COMMAND LINE");
    expect(r.part.verify).toContain("NOT read from the CAD file");
    expect(r.part.verify).not.toContain("bounding box of ALL");
    expect(formatImport(r, "/o/t.json")).toContain("supplied on the command line");
  });

  test("wins over a dataset outline and warns; pads outside it are flagged", () => {
    addPart("t:ov2");
    addPads("t:ov2", { frame: DOWN, text: "X right, Y down", url: "u", sha: "s", pads: [{ ref: "J", n: 1, x: 5, y: 5, net: "N" }] });
    addOutline("t:ov2", { text: "X right, Y down", url: "u", sha: "s", min: [0, 0], max: [100, 100] });
    const r = importPart(db, "/db", { partId: "t:ov2", headers: [H("J")], id: "t", outline: parseOutlineArg("10,10,0,0") });
    expect(r.part.body).toMatchObject({ w: 10, d: 10 });
    expect(r.warnings.join("\n")).toMatch(/--outline replaces the outline in geometry/);
    const off = importPart(db, "/db", { partId: "t:ov2", headers: [H("J")], id: "t", outline: parseOutlineArg("6,6,20,20") });
    expect(off.warnings.join("\n")).toContain("lie outside the outline supplied on the command line");
  });

  test("parseOutlineArg rejects anything but four numbers with area", () => {
    expect(parseOutlineArg("0,0,68.58,53.34")).toEqual({ minX: 0, minY: 0, maxX: 68.58, maxY: 53.34 });
    expect(() => parseOutlineArg("1,2,3")).toThrow(/four numbers/);
    expect(() => parseOutlineArg("a,b,c,d")).toThrow(PadsError);
    expect(() => parseOutlineArg("0,0,0,5")).toThrow(/no area/);
  });
});

describe("rotation sense", () => {
  test("--rot turns the same way as iso.ts rotPoint (bench.rot, plan.rot, enclosure mounts)", () => {
    const W = 50;
    const D = 30;
    const box = { minX: 0, minY: 0, maxX: W, maxY: D };
    for (const rot of [0, 90, 180, 270] as Rot[]) {
      for (const [x, y] of [[0, 0], [7, 3], [50, 30], [12.5, 29]] as [number, number][]) {
        expect(placePoints([{ x, y }], box, rot, false).points[0]).toEqual({ x: rotPoint(x, y, W, D, rot)[0], y: rotPoint(x, y, W, D, rot)[1] });
      }
    }
  });
});

describe("drawing-derived outline (bounds_mm shape)", () => {
  // Header centres from a dimensioned drawing, frame X right, Y down, origin at the PCB's top-left corner:
  // two 22-pin rows, 2.54 mm pitch, y = 62.74 - 8 - (22 - n) * 2.54 as in the catalog's calculation.
  const DRAWING = { x_direction: "right", y_direction: "down", view: "top" };
  function drawingBoard(): number {
    addPart("t:dk", "DevKit");
    const pads: PadIn[] = [];
    for (const [ref, x] of [["J1", 1.27], ["J3", 24.13]] as [string, number][]) {
      for (let n = 1; n <= 22; n++) pads.push({ ref, n, x, y: Math.round((62.74 - 8 - (22 - n) * 2.54) * 1000) / 1000, type: "header_center_anchor" });
    }
    const g = addPads("t:dk", { frame: DRAWING, text: "drawing_pcb_extent_top_left; top_view; X_right; Y_down; explicitly_registered", url: "https://x/dk.pdf", sha: "dk", pads });
    const payload = { bounds_mm: { height: 62.74, max_x: 25.4, max_y: 62.74, min_x: 0, min_y: 0, width: 25.4 }, coordinate_scope: "drawing_registered_board", format: "dimensioned_pdf_pcb_extents", frame: DRAWING };
    db.query(`INSERT INTO geometry_objects(geometry_id,part_id,kind,coordinate_frame,revision,source_url,source_sha256,payload_json) VALUES(?,?,?,?,?,?,?,?)`).run(
      nextId++,
      "t:dk",
      "pcb_outline_and_drills",
      "drawing_pcb_extent_top_left; top_view; X_right; Y_down; explicitly_registered",
      "rev-a",
      "https://x/dk.pdf",
      "dk",
      JSON.stringify(payload),
    );
    return g;
  }

  test("pads reports the outline extent and import uses it", () => {
    drawingBoard();
    const rep = describePads(db, "/db", "t:dk");
    expect(rep.paired_outline?.extent_mm).toEqual([25.4, 62.74]);
    expect(formatPads(rep)).toContain("25.4 x 62.74 mm (drawing_registered_board)");
    const r = importPart(db, "/db", { partId: "t:dk", headers: [H("J1"), H("J3")], id: "t" });
    expect(r.outline).toBe("outline dataset");
    expect(r.part.body).toMatchObject({ w: 25.4, d: 62.74 });
    const xs = new Set(r.part.pins.map((p) => p.x));
    expect([...xs].sort((a, b) => a - b)).toEqual([1.27, 24.13]);
    const ys = r.part.pins.map((p) => p.y);
    expect([Math.min(...ys), Math.max(...ys)]).toEqual([1.4, 54.74]);
    expect(r.part.verify).toContain("dimension callouts");
    expect(r.part.verify).not.toContain("centre lines");
  });

  test("--rot 180 puts every pad exactly where the library part has it", () => {
    drawingBoard();
    const r = importPart(db, "/db", { partId: "t:dk", headers: [H("J1"), H("J3")], id: "t", rot: 180 });
    const lib = JSON.parse(readFileSync(join(import.meta.dir, "../../assets/parts/esp32-s3-devkitc-1.json"), "utf8")) as { body: { w: number; d: number }; pins: { x: number; y: number }[] };
    expect(r.part.body).toMatchObject({ w: lib.body.w, d: lib.body.d });
    expect(r.part.pins).toHaveLength(lib.pins.length);
    for (const p of r.part.pins) {
      const near = Math.min(...lib.pins.map((q) => Math.hypot(q.x - p.x, q.y - p.y)));
      expect(near).toBeLessThan(0.005);
    }
  });
});

describe("pin definitions bound to the dataset", () => {
  test("a row bound to the chosen geometry names the pin; rows bound elsewhere do not; gpio and caps stay unset", () => {
    addPart("t:b");
    const g = addPads("t:b", {
      frame: DOWN,
      text: "X right, Y down",
      url: "u",
      sha: "s",
      pads: [
        { ref: "J1", n: 1, x: 0, y: 0, net: "NET1" },
        { ref: "J1", n: 2, x: 2.54, y: 0, net: "NET2" },
        { ref: "J1", n: 3, x: 5.08, y: 0, net: "NET3" },
        { ref: "J1", n: 4, x: 7.62, y: 0, net: null },
      ],
    });
    const ins = db.query(`INSERT INTO pin_definitions(part_id,connector,pin_number,name,notes) VALUES('t:b',?,?,?,?)`);
    ins.run("J1", "1", "OTHER-REV", JSON.stringify({ supported_geometry_ids: [g + 100] }));
    ins.run("J1", "1", "3V3", JSON.stringify({ supported_geometry_ids: [g], geometry_bindings: [{ geometry_id: g }] }));
    ins.run("J1", "2", "OTHER-ONLY", JSON.stringify({ supported_geometry_ids: [g + 100] }));
    ins.run("J1", "3", "LEGACY", null);
    ins.run("J1", "4", "4", JSON.stringify({ geometry_bindings: [{ geometry_id: g }] }));
    const r = importPart(db, "/db", { partId: "t:b", headers: [H("J1")], id: "t" });
    expect(r.part.pins.map((p) => p.name)).toEqual(["3V3", "NET2", "LEGACY", "4"]);
    expect(r.name_sources).toEqual({ pin_definitions: 3, net_name: 1, reference_pad: 0 });
    for (const p of r.part.pins) {
      expect(p.gpio).toBeUndefined();
      expect(p.caps).toBeUndefined();
    }
  });
});

describe("importPart: datasets and headers", () => {
  function two(): { a: number; b: number } {
    addPart("t:two");
    const pads = (x: number): PadIn[] => [{ ref: "J1", n: 1, x, y: 1, net: "A" }, { ref: "J1", n: 2, x: x + 2.54, y: 1, net: "B" }];
    const a = addPads("t:two", { frame: DOWN, text: "X right, Y down", url: "ua", sha: "sa", revision: "rev-1", pads: pads(1) });
    const b = addPads("t:two", { frame: DOWN, text: "X right, Y down", url: "ub", sha: "sb", revision: "rev-2", pads: pads(50) });
    return { a, b };
  }

  test("several datasets without --geometry: stop and list them, never merge", () => {
    const { a, b } = two();
    expect(() => importPart(db, "/db", { partId: "t:two", headers: [H("J1")], id: "t" })).toThrow(new RegExp(`--geometry[\\s\\S]*${a}[\\s\\S]*${b}`));
    const rep = describePads(db, "/db", "t:two");
    expect(rep.needs_choice).toBe(true);
    expect(rep.references).toBeNull();
    expect(formatPads(rep)).toContain("choose one with --geometry");
  });

  test("--geometry picks one dataset and only its pads", () => {
    const { b } = two();
    const r = importPart(db, "/db", { partId: "t:two", headers: [H("J1")], id: "t", geometryId: b });
    expect(r.geometry_id).toBe(b);
    expect(r.part.pins).toHaveLength(2);
    expect(r.part.sources[0]).toContain("ub");
    expect(r.part.sources[0]).toContain("source_sha256 sb");
    expect(() => importPart(db, "/db", { partId: "t:two", headers: [H("J1")], id: "t", geometryId: 999 })).toThrow(/not a pcb_pad_centers dataset/);
  });

  test("only the named references and pads are imported; unknown ones are reported", () => {
    addPart("t:h");
    addPads("t:h", {
      frame: DOWN,
      text: "X right, Y down",
      url: "u",
      sha: "s",
      pads: [
        { ref: "J1", n: 1, x: 0, y: 0, net: "A" },
        { ref: "J1", n: 2, x: 2.54, y: 0, net: "B" },
        { ref: "J1", n: 3, x: 5.08, y: 0, net: "C" },
        { ref: "J2", n: 1, x: 0, y: 10, net: "D" },
        { ref: "R1", n: 1, x: 3, y: 5, net: "E" },
      ],
    });
    const all = importPart(db, "/db", { partId: "t:h", headers: [H("J1"), H("J2")], id: "t" });
    expect(all.part.pins.map((p) => p.name)).toEqual(["A", "B", "C", "D"]);
    expect(all.imported_pads).toBe(4);
    expect(all.dataset_pads).toBe(5);
    const some = importPart(db, "/db", { partId: "t:h", headers: parseHeaderSpecs("j1:1-2"), id: "t" });
    expect(some.part.pins.map((p) => p.name)).toEqual(["A", "B"]);
    expect(() => importPart(db, "/db", { partId: "t:h", headers: [H("J9")], id: "t" })).toThrow(/J1, J2, R1/);
    expect(() => importPart(db, "/db", { partId: "t:h", headers: parseHeaderSpecs("J1:7"), id: "t" })).toThrow(/no pad 7/);
    expect(() => importPart(db, "/db", { partId: "t:h", headers: [], id: "t" })).toThrow(/no pads selected/);
  });

  test("two pads on one net less than 2 mm apart are flagged as likely twin pads", () => {
    addPart("t:tw");
    addPads("t:tw", {
      frame: DOWN,
      text: "X right, Y down",
      url: "u",
      sha: "s",
      pads: [
        { ref: "J1", n: 1, x: 0, y: 0, net: "D0" },
        { ref: "J1", n: 13, x: 1.27, y: 0, net: "D0" },
      ],
    });
    const r = importPart(db, "/db", { partId: "t:tw", headers: [H("J1")], id: "t" });
    expect(r.warnings.join("\n")).toContain("likely twin pads");
    expect(r.part.pins.map((p) => p.name)).toEqual(["D0", "D0.2"]);
  });
});

describe("importPart: names and unset fields", () => {
  test("pin_definitions first (exact connector and number), then net, then reference.pad", () => {
    addPart("t:n");
    addPads("t:n", {
      frame: DOWN,
      text: "X right, Y down",
      url: "u",
      sha: "s",
      pads: [
        { ref: "J1", n: 1, x: 0, y: 0, net: "NETA" },
        { ref: "J1", n: 2, x: 2, y: 0, net: "NETB" },
        { ref: "J1", n: 3, x: 4, y: 0, net: null },
        { ref: "J1", n: 4, x: 6, y: 0, net: "NETD" },
      ],
    });
    db.query(`INSERT INTO pin_definitions(part_id,connector,pin_number,name) VALUES('t:n','J1','1','VIN')`).run();
    // Two definitions for the same connector and number would be a guess: fall through to the net.
    db.query(`INSERT INTO pin_definitions(part_id,connector,pin_number,name) VALUES('t:n','J1','4','X'),('t:n','J1','4','Y')`).run();
    const r = importPart(db, "/db", { partId: "t:n", headers: [H("J1")], id: "t" });
    expect(r.part.pins.map((p) => p.name)).toEqual(["VIN", "NETB", "J1.3", "NETD"]);
    expect(r.name_sources).toEqual({ pin_definitions: 1, net_name: 2, reference_pad: 1 });
    expect(r.part.pins[0]!.aliases).toEqual(["J1.1"]);
  });

  test("without a pin table it sets no gpio, no caps and no role but io, and lists what is missing", () => {
    addPart("t:g");
    // Net names that say nothing about ground: a net named GND is the one label that sets a role (tested with the roles).
    addPads("t:g", { frame: DOWN, text: "X right, Y down", url: "https://src/x.brd", sha: "abc123", revision: "rev-z", pads: [{ ref: "J1", n: 1, x: 0, y: 0, net: "VBUS" }, { ref: "J1", n: 2, x: 2.54, y: 0, net: "IO5" }] });
    const r = importPart(db, "/db", { partId: "t:g", headers: [H("J1")], id: "t-g", fileName: "wrong.json" });
    for (const p of r.part.pins) {
      expect(p.role).toBe("io");
      expect(p.gpio).toBeUndefined();
      expect(p.caps).toBeUndefined();
    }
    expect(r.part.confidence).toBe("typical");
    expect(r.part.sources[0]).toContain("https://src/x.brd");
    expect(r.part.sources[0]).toContain("source_sha256 abc123");
    expect(r.part.verify).toContain("not measured on a bought board");
    expect(r.part.verify).toContain("not a GPIO number");
    expect(r.part.verify).toContain("Heights, shapes, ports and electrical values are not in the catalog");
    expect(r.missing.join("\n")).toMatch(/gnd[\s\S]*gpio[\s\S]*logicVolts[\s\S]*priceUsd[\s\S]*wrong\.json/);
  });

  test("a part with no numeric pads says so and lists cached pinout files resolved against the database folder", () => {
    addPart("t:none");
    db.query(`INSERT INTO assets(part_id,kind,title,url) VALUES('t:none','pinout','Pinout','https://img/p.png'),('t:none','product_image','photo','https://img/x.jpg'),('t:none','mechanical_drawing','Drawing','https://img/d.pdf')`).run();
    db.query(`INSERT INTO asset_files(url,relative_path,status) VALUES('https://img/p.png','references/aa/p.png','downloaded'),('https://img/x.jpg','references/aa/x.jpg','downloaded'),('https://img/d.pdf','references/bb/d.pdf','failed')`).run();
    const files = cachedPinoutFiles(db, "/cat", "t:none");
    expect(files.map((f) => f.path)).toEqual([join("/cat", "references/aa/p.png")]);
    const rep = describePads(db, "/cat", "t:none");
    expect(rep.datasets).toEqual([]);
    const text = formatPads(rep);
    expect(text).toContain("no numeric pad data");
    expect(text).toContain(join("/cat", "references/aa/p.png"));
    expect(() => importPart(db, "/cat", { partId: "t:none", headers: [H("J1")], id: "t" })).toThrow(/no numeric pad data/);
  });
});

describe("describePads", () => {
  test("lists references with counts and boxes, through-hole first, and the outline", () => {
    addPart("t:d");
    addPads("t:d", {
      frame: UP,
      text: "X_right; Y_up",
      url: "u",
      sha: "s",
      pads: [
        { ref: "C1", n: 1, x: 5, y: 5, type: "smd" },
        { ref: "C1", n: 2, x: 6, y: 5, type: "smd" },
        { ref: "J1", n: 1, x: 1, y: 1, net: "A" },
        { ref: "J1", n: 2, x: 3.54, y: 1, net: "B" },
      ],
    });
    addOutline("t:d", { text: "X_right; Y_up", url: "u", sha: "s", min: [0, 0], max: [20, 10] });
    const rep = describePads(db, "/db", "t:d");
    expect(rep.references!.map((r) => r.reference)).toEqual(["J1", "C1"]);
    expect(rep.references![0]).toMatchObject({ pads: 2, bbox: [1, 1, 3.54, 1], extent_mm: [2.54, 0] });
    expect(rep.paired_outline?.extent_mm).toEqual([20, 10]);
    expect(formatPads(rep)).toContain("20 x 10 mm");
  });
  test("unknown part id", () => {
    expect(() => describePads(db, "/db", "nope")).toThrow(/no part with id/);
  });
});

describe("parseHeaderSpecs and missingFields", () => {
  test("parses references, ranges and lists", () => {
    expect(parseHeaderSpecs("J1,J2")).toEqual([H("J1"), H("J2")]);
    expect(parseHeaderSpecs("J1:1-3;7,J2")).toEqual([H("J1", ["1", "2", "3", "7"]), H("J2")]);
    expect(() => parseHeaderSpecs("J1,J1:1")).toThrow(/twice/);
    expect(() => parseHeaderSpecs("J1:")).toThrow(PadsError);
  });
  test("missingFields flags a draft that check-parts would reject", () => {
    const m = missingFields(
      { id: "a", name: "A", kind: "board", blurb: "b", body: { w: 1, d: 1, h: 1 }, maxHeight: 1, pins: [{ name: "x", role: "io", x: 0, y: 0 }], electrical: {}, sourcing: { search: ["a"], priceUsd: 0 }, sources: ["s"], confidence: "typical" },
      true,
    );
    expect(m.join("\n")).toMatch(/gnd[\s\S]*gpio[\s\S]*logicVolts[\s\S]*priceUsd/);
  });
  test("missingFields stops claiming what is set, and still lists what is not", () => {
    const def: PartDef = {
      id: "a", name: "A", kind: "board", blurb: "b", body: { w: 9, d: 9, h: 1 }, maxHeight: 1,
      pins: [
        { name: "GND", role: "gnd", x: 0, y: 0 },
        { name: "D1", role: "io", x: 1, y: 0, gpio: 1 },
        { name: "D2", role: "io", x: 2, y: 0 },
        { name: "3V3", role: "io", x: 3, y: 0 },
      ],
      electrical: { logicVolts: 3.3 }, sourcing: { search: ["a"], priceUsd: 0 }, sources: ["s"], confidence: "typical",
    };
    const m = missingFields(def, true, undefined, ["3V3"]).join("\n");
    expect(m).not.toMatch(/role gnd/);
    expect(m).not.toMatch(/electrical\.logicVolts/);
    expect(m).toContain("gpio numbers on 2 of 3 non-ground pins (D2, 3V3)");
    expect(m).toContain("power pins that need role, volts and direction: 3V3");
    expect(m).toContain("sourcing.priceUsd");
    expect(m).toContain("maxHeight");
  });
});

describe("importPart: headers by default", () => {
  function board(): void {
    addPart("t:dh");
    addPads("t:dh", {
      frame: DOWN,
      text: "X right, Y down",
      url: "u",
      sha: "s",
      pads: [
        { ref: "J2", n: 1, x: 0, y: 20, net: "D", pkg: "1X02" },
        { ref: "J2", n: 2, x: 2.54, y: 20, net: "E", pkg: "1X02" },
        { ref: "J1", n: 1, x: 0, y: 0, net: "A" }, // no package: connector-style reference on a header pitch
        { ref: "J1", n: 2, x: 2.54, y: 0, net: "B" },
        { ref: "J1", n: 3, x: 5.08, y: 0, net: "C" },
        { ref: "J3", n: 1, x: 30, y: 0, net: "V", pkg: "USB-C-16P" }, // a connector, not a header
        { ref: "J3", n: 2, x: 31, y: 0, net: "W", pkg: "USB-C-16P" },
        { ref: "R1", n: 1, x: 3, y: 5, type: "smd", pkg: "0603" },
        { ref: "R1", n: 2, x: 4, y: 5, type: "smd", pkg: "0603" },
        { ref: "MH1", n: 1, x: 9, y: 9, type: "np_thru_hole", pkg: "MOUNTING_HOLE_3.2" },
        { ref: "U1", n: 1, x: 12, y: 9, type: "smd", pkg: "QFN32" },
        { ref: "U1", n: 2, x: 13, y: 9, type: "smd", pkg: "QFN32" },
      ],
    });
  }

  test("without --header, takes the groups the card generator classes as headers (larger first) and names the basis of each", () => {
    board();
    const r = importPart(db, "/db", { partId: "t:dh", id: "t" });
    expect(r.headers.map((h) => [h.reference, h.from, h.kind])).toEqual([
      ["J1", "default", "pin_header"],
      ["J2", "default", "pin_header"],
    ]);
    expect(r.headers[0]!.basis).toEqual(["reference J1", "2.54 mm pitch"]);
    expect(r.headers[1]!.basis).toEqual(["package 1X02"]);
    expect(r.part.pins.map((p) => p.name)).toEqual(["A", "B", "C", "D", "E"]);
    const text = formatImport(r, "/o/t.json");
    expect(text).toContain("headers taken: J1 (default; pin_header; reference J1; 2.54 mm pitch), J2 (default; pin_header; package 1X02)");
    expect(r.part.verify).toContain("taken by default");
  });

  test("it is the card generator's decision: the same references as board.headers", () => {
    board();
    const geometry = db.query(`SELECT geometry_id, kind, 0 AS source_id, revision, source_url, source_sha256, payload_json, validation_status FROM geometry_objects WHERE part_id = 't:dh'`).all() as GeometryRow[];
    const card = buildBoard(geometry, [] as PinDefRow[])!;
    const r = importPart(db, "/db", { partId: "t:dh", id: "t" });
    expect(r.headers.map((h) => h.reference).sort()).toEqual(card.headers.map((h) => h.ref).sort());
  });

  test("--header overrides, and is reported as such", () => {
    board();
    const r = importPart(db, "/db", { partId: "t:dh", headers: [H("J3")], id: "t" });
    expect(r.headers).toEqual([{ reference: "J3", pads: null, from: "--header", kind: null, basis: ["named with --header"] }]);
    expect(r.part.pins).toHaveLength(2);
    expect(formatImport(r, "/o/t.json")).toContain("J3 (--header)");
  });

  test("no group qualifies: fail and say to run pads and pass --header", () => {
    addPart("t:nh");
    addPads("t:nh", { frame: DOWN, text: "X right, Y down", url: "u", sha: "s", pads: [{ ref: "R1", n: 1, x: 0, y: 0, type: "smd", pkg: "0603" }, { ref: "R1", n: 2, x: 1, y: 0, type: "smd", pkg: "0603" }] });
    expect(() => importPart(db, "/db", { partId: "t:nh", id: "t" })).toThrow(/Run: pads t:nh, then pass --header/);
  });

  test("an empty --header is still an error, not the default", () => {
    board();
    expect(() => importPart(db, "/db", { partId: "t:dh", headers: [], id: "t" })).toThrow(/no pads selected/);
  });

  test("pads shows which references the default takes", () => {
    board();
    const refs = describePads(db, "/db", "t:dh").references!;
    expect(refs.find((r) => r.reference === "J1")!.default_header).toEqual({ kind: "pin_header", basis: ["reference J1", "2.54 mm pitch"] });
    expect(refs.find((r) => r.reference === "R1")!.default_header).toBeNull();
    expect(formatPads(describePads(db, "/db", "t:dh"))).toContain("HEADER by default");
  });
});

describe("importPart: roles and GPIO numbers from the published pin text", () => {
  function fixture(): { rows: PinRow[] } {
    addPart("t:rg");
    const pads: PadIn[] = [];
    const rows: PinRow[] = [
      { connector: "J1", n: 1, name: "GND" },
      { connector: "J1", n: 2, name: "AGND" },
      { connector: "J1", n: 3, name: "G", type: "G", fn: "Ground" },
      { connector: "J1", n: 4, name: "G", type: "I/O", fn: "Gate drive input" }, // a MOSFET gate, not a ground
      { connector: "J1", n: 5, name: "7", type: "I/O/T", fn: "GPIO7, ADC1_CH6, FSPID" },
      { connector: "J1", n: 6, name: "GP4", fn: "UART1 TX; I2C0 SDA" },
      { connector: "J1", n: 7, name: "D3", fn: "A3 | IO12 | D3" },
      { connector: "J1", n: 8, name: "D8", fn: "Published terminal label: D8; native net: IO8" }, // a schematic net label, not a function
      { connector: "J1", n: 9, name: "2", fn: "GPIO3, GPIO4" }, // two candidates
      { connector: "J1", n: 10, name: "3V3", type: "P", fn: "3.3 V power supply" },
      { connector: "J1", n: 11, name: "5V" },
      { connector: "J1", n: 12, name: "TOUCH", fn: "RTC_GPIO3, TOUCH3" }, // another numbering space
      { connector: "J1", n: 13, name: "SDA", fn: "GPIO8, RTC_GPIO8, LP_GPIO8" },
      { connector: "J1", n: 14, name: "DIST", fn: "GP2Y1010 dust sensor DIO2" },
      { connector: "J1", n: 15, name: "GND3", type: "power_in" },
      { connector: "J1", n: 16, name: "VIN", type: "passive" },
    ];
    rows.forEach((r, i) => pads.push({ ref: "J1", n: r.n, x: i * 2.54, y: 0, net: `NET${i}` }));
    addPads("t:rg", { frame: DOWN, text: "X right, Y down", url: "u", sha: "s", pads });
    addPinRows("t:rg", rows);
    return { rows };
  }
  const byName = (r: ReturnType<typeof importPart>) => new Map(r.part.pins.map((p) => [p.name, p]));

  test("gnd by published name or by the source's pin type; a bare G with other evidence is not a ground", () => {
    fixture();
    const r = importPart(db, "/db", { partId: "t:rg", headers: [H("J1")], id: "t" });
    const pins = r.part.pins;
    expect(pins.filter((p) => p.role === "gnd").map((p) => p.name)).toEqual(["GND", "AGND", "G", "GND3"]);
    const g4 = pins.find((p) => p.name === "G.2")!;
    expect(g4.role).toBe("io");
    expect(pins[0]!.importedFrom!.role).toMatch(/pin_definitions #\d+ \(J1 pin 1\): published pin name "GND"/);
    expect(pins[2]!.importedFrom!.role).toMatch(/source pin type "G"/);
  });

  test("gpio only where the published text names exactly one GPIOn, GPn or IOn; ambiguous and foreign forms stay unset", () => {
    fixture();
    const m = byName(importPart(db, "/db", { partId: "t:rg", headers: [H("J1")], id: "t" }));
    expect(m.get("7")!.gpio).toBe(7);
    expect(m.get("GP4")!.gpio).toBe(4);
    expect(m.get("D3")!.gpio).toBe(12);
    expect(m.get("SDA")!.gpio).toBe(8);
    expect(m.get("7")!.importedFrom!.gpio).toMatch(/pin_definitions #\d+ \(J1 pin 5\): published function text "GPIO7"/);
    expect(m.get("GP4")!.importedFrom!.gpio).toMatch(/published name "GP4"/);
    for (const n of ["D8", "2", "TOUCH", "DIST", "3V3", "5V", "VIN"]) {
      expect(m.get(n)!.gpio).toBeUndefined();
      expect(m.get(n)!.importedFrom?.gpio).toBeUndefined();
    }
  });

  test("an ambiguous pin is reported, not guessed", () => {
    fixture();
    const r = importPart(db, "/db", { partId: "t:rg", headers: [H("J1")], id: "t" });
    expect(r.warnings.join("\n")).toMatch(/1 pin\(s\) name more than one GPIO number.*: 2/);
    expect(pinFacts([{ pin_id: 1, connector: "J", pin_number: "1", name: "X", electrical_type_as_source: null, functions_as_source: "GPIO3, GPIO4", source_id: 0, revision: null }]).gpioCandidates).toEqual([3, 4]);
  });

  test("power pins keep role io, get no volts, and are listed by name for a person", () => {
    fixture();
    const r = importPart(db, "/db", { partId: "t:rg", headers: [H("J1")], id: "t" });
    expect(r.power_pins).toEqual(["3V3", "5V", "VIN"]);
    for (const p of r.part.pins.filter((q) => r.power_pins.includes(q.name))) {
      expect(p.role).toBe("io");
      expect(p.volts).toBeUndefined();
      expect(p.dir).toBeUndefined();
    }
    expect(r.missing.join("\n")).toContain("power pins that need role, volts and direction: 3V3, 5V, VIN");
  });

  test("missing no longer claims gnd, lists the pins still without a gpio", () => {
    fixture();
    const r = importPart(db, "/db", { partId: "t:rg", headers: [H("J1")], id: "t" });
    expect(r.from_pin_text).toEqual({ gnd: 4, gpio: 4 });
    const text = r.missing.join("\n");
    expect(text).not.toMatch(/role gnd/);
    expect(text).toMatch(/gpio numbers on 8 of 12 non-ground pins \(G\.2, D8, 2,/);
    expect(text).toContain("electrical.logicVolts");
  });

  test("a net label gives ground, and nothing else, on a pad with no published row", () => {
    addPart("t:net");
    addPads("t:net", { frame: DOWN, text: "X right, Y down", url: "u", sha: "s", pads: [{ ref: "J1", n: 1, x: 0, y: 0, net: "GND" }, { ref: "J1", n: 2, x: 2.54, y: 0, net: "GPIO5" }, { ref: "J1", n: 3, x: 5.08, y: 0, net: "3V3" }] });
    const r = importPart(db, "/db", { partId: "t:net", headers: [H("J1")], id: "t" });
    // A net named GPIO5 is a schematic label, not a published function: no gpio from it.
    expect(r.part.pins.map((p) => [p.role, p.gpio])).toEqual([["gnd", undefined], ["io", undefined], ["io", undefined]]);
    expect(r.part.pins[0]!.importedFrom!.role).toBe('CAD net name "GND" on pad J1.1 (no published pin row)');
    expect(r.from_net_name).toEqual({ gnd: 1 });
    expect(r.from_pin_text).toEqual({ gnd: 0, gpio: 0 });
  });

  test("a published row wins over the net label: a pad the pin table calls a signal stays a signal", () => {
    addPart("t:net2");
    addPads("t:net2", { frame: DOWN, text: "X right, Y down", url: "u", sha: "s", pads: [{ ref: "J1", n: 1, x: 0, y: 0, net: "GND" }] });
    addPinRows("t:net2", [{ connector: "J1", n: 1, name: "SHIELD", fn: "Cable shield, not signal ground" }]);
    const r = importPart(db, "/db", { partId: "t:net2", headers: [H("J1")], id: "t" });
    expect(r.part.pins[0]!.role).toBe("io");
    expect(r.from_net_name).toEqual({ gnd: 0 });
  });
});

describe("importPart: electrical.logicVolts", () => {
  function withPads(id: string): void {
    addPart(id);
    addPads(id, { frame: DOWN, text: "X right, Y down", url: "u", sha: "s", pads: [{ ref: "J1", n: 1, x: 0, y: 0, net: "A" }, { ref: "J1", n: 2, x: 2.54, y: 0, net: "B" }] });
  }
  test("one logic level that every claim agrees on is imported, with where it came from", () => {
    withPads("t:l1");
    addSpec("t:l1", "logic_level", "3.3V");
    addSpec("t:l1", "logikkniv", "3,3 V", { source: 2 });
    const r = importPart(db, "/db", { partId: "t:l1", headers: [H("J1")], id: "t" });
    expect(r.part.electrical.logicVolts).toBe(3.3);
    expect(r.part.imported!.fields![0]).toMatchObject({ field: "electrical.logicVolts", value: 3.3 });
    expect(r.part.imported!.fields![0]!.from).toContain("https://x/spec");
    expect(r.missing.join("\n")).not.toContain("electrical.logicVolts");
    expect(r.part.verify).not.toContain("electrical.logicVolts");
  });
  test("a conflict, a range or no claim leaves it unset", () => {
    withPads("t:l2");
    addSpec("t:l2", "logic_level", "3.3V");
    addSpec("t:l2", "logikkniv", "5 V", { source: 2 });
    expect(importPart(db, "/db", { partId: "t:l2", headers: [H("J1")], id: "t" }).part.electrical.logicVolts).toBeUndefined();
    withPads("t:l3");
    addSpec("t:l3", "logic_level", "3.3 to 5V");
    const r3 = importPart(db, "/db", { partId: "t:l3", headers: [H("J1")], id: "t" });
    expect(r3.part.electrical.logicVolts).toBeUndefined();
    expect(r3.missing.join("\n")).toContain("electrical.logicVolts");
    expect(r3.part.imported!.fields).toBeUndefined();
  });
});

describe("importPart: height from the maker's 3D model", () => {
  /** A `pcb_model_clearances` record as the catalog writes it: one board, heights above and below its PCB. */
  function addModel(part: string, above: number, below: number, thickness: number | null, boards = 1): number {
    const board = { maximum_height_above_pcb_mm: above, maximum_height_below_pcb_mm: below, pcb_thickness_model_mm: thickness, maximum_height_status: "nominal_STEP_assembly_geometry_not_physical_measurement", connectors: [] };
    const id = nextId++;
    db.query(`INSERT INTO geometry_objects(geometry_id,part_id,kind,coordinate_frame,revision,source_url,source_sha256,payload_json) VALUES(?,?,?,?,?,?,?,?)`).run(
      id,
      part,
      "pcb_model_clearances",
      "model frame",
      "rev-a",
      "https://src/board.step",
      "feed",
      JSON.stringify({ boards: Array.from({ length: boards }, () => board) }),
    );
    return id;
  }
  function board(id: string): void {
    addPart(id);
    addPads(id, { frame: DOWN, text: "X right, Y down", url: "u", sha: "s", pads: [{ ref: "J1", n: 1, x: 0, y: 0 }, { ref: "J1", n: 2, x: 2.54, y: 0 }] });
  }

  test("maxHeight is the PCB plus the tallest modelled point above it, and says it is nominal", () => {
    board("t:h");
    const g = addModel("t:h", 8.52, 0, 1.57);
    const r = importPart(db, "/db", { partId: "t:h", headers: [H("J1")], id: "t" });
    expect(r.part.body.h).toBe(1.57);
    expect(r.part.maxHeight).toBe(10.09);
    expect(r.model_height).toEqual({ max_height: 10.09, above_pcb: 8.52, below_pcb: 0, pcb_thickness: 1.57, geometry_id: g });
    expect(r.part.imported!.fields!.map((f) => f.field)).toEqual(["maxHeight", "body.h"]);
    expect(r.part.imported!.fields![0]!.from).toContain(`3D-model geometry ${g}`);
    expect(r.part.verify).toContain("nominal model figure, not a measurement");
    // Set, so no longer listed as missing; a draft without a model still lists it.
    expect(r.missing.join("\n")).not.toMatch(/maxHeight|body\.h/);
  });

  test("parts under the board are reported, not added to maxHeight", () => {
    board("t:hb");
    addModel("t:hb", 5, 2.01, 1.6);
    const r = importPart(db, "/db", { partId: "t:hb", headers: [H("J1")], id: "t" });
    // maxHeight is measured from the PCB's underside: what the case layout stands on its posts.
    expect(r.part.maxHeight).toBe(6.6);
    expect(r.warnings.join("\n")).toMatch(/2\.01 mm below the PCB.*posts at least that tall/);
  });

  test("two models that disagree, or a record with several boards, set nothing and say why", () => {
    board("t:h2");
    addModel("t:h2", 5, 0, 1.6);
    addModel("t:h2", 9, 0, 1.6);
    const r = importPart(db, "/db", { partId: "t:h2", headers: [H("J1")], id: "t" });
    expect(r.model_height).toBeNull();
    expect(r.part.maxHeight).toBe(r.part.body.h);
    expect(r.warnings.join("\n")).toContain("3D-model heights for this part that disagree");
    expect(r.missing.join("\n")).toContain("maxHeight (placeholder");

    board("t:h3");
    addModel("t:h3", 5, 0, 1.6, 2);
    const r3 = importPart(db, "/db", { partId: "t:h3", headers: [H("J1")], id: "t" });
    expect(r3.model_height).toBeNull();
    expect(r3.warnings.join("\n")).toContain("carry no usable height");
  });

  test("no model: the placeholder and the missing line stay as they were", () => {
    board("t:h0");
    const r = importPart(db, "/db", { partId: "t:h0", headers: [H("J1")], id: "t" });
    expect(r.model_height).toBeNull();
    expect(r.part.maxHeight).toBe(1.6);
    expect(r.part.verify).toContain("maxHeight = 1.6 (heights are not in the catalog; placeholder equal to body.h)");
  });
});

describe("importPart: ports from the 3D model's connector openings", () => {
  // One physical board, 40 x 20 mm, described three ways. Seen from above with y down from the
  // top-left corner: a header along the top, a USB socket (X1) on the right edge at y = 10, and a
  // JST socket (X2) on the bottom edge at x = 6. The CAD file has its origin 10, 5 away from the
  // corner; the model has its own origin at the board's bottom-left with y up.
  const W = 40;
  const D = 20;
  const physPads: { ref: string; n: number; px: number; py: number }[] = [
    { ref: "J1", n: 1, px: 2, py: 2 }, { ref: "J1", n: 2, px: 4.54, py: 2 }, { ref: "J1", n: 3, px: 7.08, py: 2 },
    { ref: "X1", n: 1, px: 36.5, py: 9 }, { ref: "X1", n: 2, px: 38.5, py: 11 },
    { ref: "X2", n: 1, px: 5, py: 18.5 }, { ref: "X2", n: 2, px: 7, py: 18.5 },
  ];
  function fixture(id: string, y: "up" | "down", opts: { outline?: boolean; modelBelow?: boolean } = {}): void {
    addPart(id);
    const toSource = (px: number, py: number): [number, number] => (y === "down" ? [10 + px, 5 + py] : [10 + px, 5 + (D - py)]);
    addPads(id, {
      frame: y === "down" ? DOWN : UP,
      text: `X right, Y ${y}`,
      url: "https://src/board.brd",
      sha: "s",
      pads: physPads.map((p) => ({ ref: p.ref, n: p.n, x: toSource(p.px, p.py)[0], y: toSource(p.px, p.py)[1] })),
    });
    if (opts.outline !== false) addOutline(id, { text: `X right, Y ${y}`, url: "https://src/board.brd", sha: "s", min: [10, 5], max: [10 + W, 5 + D] });
    // The model: x = px, y = D - py, PCB from z = 0 to 1.6. With modelBelow the sockets hang under the PCB instead.
    const z = (lo: number, hi: number): [number, number] => (opts.modelBelow ? [-hi, -lo] : [1.6 + lo, 1.6 + hi]);
    const board = {
      maximum_height_above_pcb_mm: 3.4, maximum_height_below_pcb_mm: 0, pcb_thickness_model_mm: 1.6, maximum_height_status: "nominal",
      pcb_bounds_mm: { min_mm: [0, 0, 0], max_mm: [W, D, 1.6] }, pcb_negative_z_face_mm: 0, pcb_positive_z_face_mm: 1.6,
      connectors: [
        {
          source_names: ["USB_C_RECEPTACLE:X1"],
          housing_and_pins_bounds_mm: { min_mm: [34, 6, z(0, 3.2)[0]], max_mm: [41, 14, z(0, 3.2)[1]] },
          // Two nested openings of the same socket: they must come out as one port.
          apertures: [
            { edge: "x_max", edge_axis: 0, edge_outward_sign: 1, center_along_edge_mm: 10, width_mm: 9, lower_height_above_pcb_mm: 0.2, upper_height_above_pcb_mm: 3.4, bounds: { min_mm: [41, 5.5, 1.8], max_mm: [41, 14.5, 5] } },
            { edge: "x_max", edge_axis: 0, edge_outward_sign: 1, center_along_edge_mm: 10, width_mm: 6, lower_height_above_pcb_mm: 1, upper_height_above_pcb_mm: 2.6, bounds: { min_mm: [41, 7, 2.6], max_mm: [41, 13, 4.2] } },
          ],
        },
        {
          source_names: ["JST_SH_4:X2"],
          housing_and_pins_bounds_mm: { min_mm: [4, 0, z(0, 2.4)[0]], max_mm: [8, 3, z(0, 2.4)[1]] },
          apertures: [{ edge: "y_min", edge_axis: 1, edge_outward_sign: -1, center_along_edge_mm: 6, width_mm: 4, lower_height_above_pcb_mm: 0.5, upper_height_above_pcb_mm: 2.5, bounds: { min_mm: [4, 0, 2.1], max_mm: [8, 0, 4.1] } }],
        },
      ],
    };
    db.query(`INSERT INTO geometry_objects(geometry_id,part_id,kind,coordinate_frame,revision,source_url,source_sha256,payload_json) VALUES(?,?,?,?,?,?,?,?)`).run(
      nextId++, id, "pcb_model_clearances", "model frame", "rev-a", "https://src/board.step", "feed", JSON.stringify({ boards: [board] }),
    );
  }
  const all = [H("J1"), H("X1"), H("X2")];

  test("each socket becomes one port on the wall it faces, in the part's own frame, whichever way the CAD file's Y points", () => {
    for (const y of ["up", "down"] as const) {
      fixture(`t:p-${y}`, y);
      const r = importPart(db, "/db", { partId: `t:p-${y}`, headers: all, id: "t" });
      expect(r.part.ports).toEqual([
        { name: "USB-C (X1)", faces: "x+", x: 40, y: 10, z: 1.8, w: 9, h: 3.2, shape: "rect", margin: 2 },
        { name: "JST connector (X2)", faces: "y+", x: 6, y: 20, z: 1.5, w: 4, h: 2, shape: "rect", margin: 2 },
      ]);
      expect(r.model_ports).toMatchObject({ features: 2, side_evidence: 2 });
      expect(r.part.imported!.ports).toMatchObject({ count: 2, features: 2, marginMm: 2 });
      expect(r.part.verify).toContain("Check which wall each is on against the board");
    }
  });

  test("turned or mirrored on import, a port stays on the wall next to its own pads", () => {
    fixture("t:p-rot", "up");
    for (const rot of [0, 90, 180, 270] as const) {
      for (const mirror of [false, true]) {
        const r = importPart(db, "/db", { partId: "t:p-rot", headers: all, id: "t", rot, mirror });
        const ports = r.part.ports!;
        expect(ports).toHaveLength(2);
        for (const [ref, port] of [["X1", ports[0]!], ["X2", ports[1]!]] as const) {
          const pins = r.part.pins.filter((p) => p.name.startsWith(`${ref}.`) || (p.aliases ?? []).some((a) => a.startsWith(`${ref}.`)));
          expect(pins.length).toBe(2);
          const cx = pins.reduce((s, p) => s + p.x, 0) / pins.length;
          const cy = pins.reduce((s, p) => s + p.y, 0) / pins.length;
          // The socket's pads are within its own depth of the port, and the port is on the outline edge its face names.
          expect(Math.hypot(cx - port.x, cy - port.y)).toBeLessThan(4);
          const onEdge = { "x-": port.x === 0, "x+": port.x === r.part.body.w, "y-": port.y === 0, "y+": port.y === r.part.body.d, up: false }[port.faces];
          expect(onEdge).toBe(true);
        }
      }
    }
  });

  test("no outline from the same CAD file: no ports, and the report says why", () => {
    fixture("t:p-nooutline", "up", { outline: false });
    const r = importPart(db, "/db", { partId: "t:p-nooutline", headers: all, id: "t" });
    expect(r.part.ports).toBeUndefined();
    expect(r.model_ports).toBeNull();
    expect(r.warnings.join("\n")).toContain("no connector openings imported from the 3D model: there is no board outline from the same CAD file");
    // The height still comes from the model: it needs no frame.
    expect(r.model_height).not.toBeNull();
  });

  test("a model that shows the board from the other side gives no ports", () => {
    // The CAD file says the sockets are on top; in the model they hang under the PCB.
    fixture("t:p-under", "up", { modelBelow: true });
    const r = importPart(db, "/db", { partId: "t:p-under", headers: all, id: "t" });
    expect(r.part.ports).toBeUndefined();
    expect(r.warnings.join("\n")).toMatch(/no connector openings imported from the 3D model: (the 3D model shows the board from the other side|no orientation|two orientations)/);
  });
});

describe("importPart: module footprints", () => {
  function pico(id = "t:mod"): { land: number } {
    addPart(id, "Test Pico");
    const land = addLand(id, { pads: picoPads() });
    addPinRows(
      id,
      Array.from({ length: 40 }, (_, i) => ({ connector: "module", n: i + 1, name: i === 2 ? "GND" : i === 38 ? "VSYS" : `GPIO${i}`, type: i === 2 ? "power_in" : i === 38 ? "power_in" : "bidirectional", fn: i === 2 ? "GND" : i === 38 ? "VSYS" : `GPIO${i}`, bound: [land] })),
    );
    return { land };
  }

  test("a part that is itself the module imports its contact rows, with the catalog envelope as the outline", () => {
    const { land } = pico();
    addEnvelope("t:mod", 51, 21, 1);
    const r = importPart(db, "/db", { partId: "t:mod", id: "pico" });
    expect(r.dataset_kind).toBe("module footprint");
    expect(r.geometry_id).toBe(land);
    expect(r.headers).toHaveLength(1);
    expect(r.headers[0]).toMatchObject({ reference: "U2", from: "default", kind: "module_contact_row" });
    // 40 contacts; the four unplated holes are not imported.
    expect(r.part.pins).toHaveLength(40);
    expect(r.dataset_pads).toBe(44);
    expect(r.outline).toBe("catalog envelope");
    // Long envelope side along the long pad extent; pads centred in it.
    expect(r.part.body).toEqual({ w: 21, d: 51, h: 1 });
    expect([r.part.pins[0]!.x, r.part.pins[0]!.y]).toEqual([1.61, 1.37]);
    expect(r.part.pins[2]).toMatchObject({ name: "GND", role: "gnd" });
    expect(r.part.pins[0]).toMatchObject({ name: "GPIO0", gpio: 0 });
    expect(r.part.pins[38]).toMatchObject({ name: "VSYS", role: "io" });
    expect(r.power_pins).toEqual(["VSYS"]);
    expect(r.missing.join("\n")).not.toMatch(/body\.h/); // the envelope states the PCB thickness
    expect(formatImport(r, "/o/p.json")).toContain("NOT a CAD outline");
  });

  test("it is never emitted as resolved: geometryEvidence is unresolved and names what is not known", () => {
    pico();
    addEnvelope("t:mod", 51, 21, 1);
    const g = importPart(db, "/db", { partId: "t:mod", id: "pico" }).part.geometryEvidence!;
    expect(g.status).toBe("unresolved");
    expect(g.reason).toMatch(/land pattern/);
    expect(g.unknown.join("\n")).toMatch(/where the pads sit within the module outline/);
    expect(g.unknown.join("\n")).toMatch(/body height/);
  });

  test("the draft's verify and provenance say it is a footprint, not the module", () => {
    pico();
    addEnvelope("t:mod", 51, 21, 1);
    const r = importPart(db, "/db", { partId: "t:mod", id: "pico" });
    expect(r.part.verify).toContain("LAND PATTERN");
    expect(r.part.verify).toContain("CENTRED");
    expect(r.part.imported).toMatchObject({ catalogPart: "t:mod", outlineFrom: "catalog envelope", geometry: { padsKind: "module_land_pattern", outline: null } });
    expect(r.part.imported!.sourceSha256.outline).toBe("envsha");
  });

  test("without a usable envelope the outline falls back to the pad bounding box, and says so", () => {
    pico("t:noenv");
    const r = importPart(db, "/db", { partId: "t:noenv", id: "pico" });
    expect(r.outline).toBe("bounding box of all pads");
    expect(r.part.geometryEvidence!.status).toBe("unresolved");
    expect(r.part.geometryEvidence!.unknown[0]).toMatch(/the module outline/);
    expect(r.part.body).toMatchObject({ w: 17.78, d: 49.26 });
    expect(r.warnings.join("\n")).toMatch(/no selected envelope/);
    expect(formatImport(r, "/o/p.json")).toContain("BOUNDING BOX OF ALL PADS");
  });

  test("an envelope that is not a whole-part outline, or is smaller than the pads, is not used", () => {
    pico("t:comp");
    addEnvelope("t:comp", 51, 21, null, "component", null);
    const a = importPart(db, "/db", { partId: "t:comp", id: "pico" });
    expect(a.outline).toBe("bounding box of all pads");
    expect(a.warnings.join("\n")).toMatch(/scope "component"/);
    pico("t:small");
    addEnvelope("t:small", 30, 10, null, "assembly", null);
    const b = importPart(db, "/db", { partId: "t:small", id: "pico" });
    expect(b.outline).toBe("bounding box of all pads");
    expect(b.warnings.join("\n")).toMatch(/smaller than the footprint's pad bounding box/);
  });

  test("several footprints of one module (DIP and SMD) are never merged: stop and list, then --geometry picks one", () => {
    addPart("t:two", "Two Footprints");
    const a = addLand("t:two", { pads: picoPads() });
    const b = addLand("t:two", { pads: picoPads() });
    expect(() => importPart(db, "/db", { partId: "t:two", id: "x" })).toThrow(new RegExp(`--geometry[\\s\\S]*${a} \\| module footprint[\\s\\S]*${b} \\| module footprint`));
    expect(importPart(db, "/db", { partId: "t:two", id: "x", geometryId: b }).geometry_id).toBe(b);
  });

  test("a part with both a placed board and a footprint imports the board; --geometry names the footprint", () => {
    addPart("t:both");
    addPads("t:both", { frame: DOWN, text: "X right, Y down", url: "u", sha: "s", pads: [{ ref: "J1", n: 1, x: 0, y: 0, net: "A" }, { ref: "J1", n: 2, x: 2.54, y: 0, net: "B" }] });
    const land = addLand("t:both", { pads: picoPads() });
    expect(importPart(db, "/db", { partId: "t:both", id: "x" }).dataset_kind).toBe("board");
    expect(importPart(db, "/db", { partId: "t:both", id: "x", geometryId: land }).dataset_kind).toBe("module footprint");
  });

  test("pads lists a module footprint's contact rows and the outline it would use", () => {
    pico();
    addEnvelope("t:mod", 51, 21, 1);
    const text = formatPads(describePads(db, "/db", "t:mod"));
    expect(text).toContain("Module footprint datasets");
    expect(text).toContain("contact rows 20 pads at 2.54 mm, 20 pads at 2.54 mm");
    expect(text).toContain("catalog's selected envelope: 51 x 21 mm");
  });

  test("--header on a footprint selects among its contact rows", () => {
    pico();
    const r = importPart(db, "/db", { partId: "t:mod", headers: parseHeaderSpecs("U2:1-5"), id: "x" });
    expect(r.part.pins).toHaveLength(5);
    expect(r.headers[0]).toMatchObject({ from: "--header", reference: "U2" });
  });
});

describe("provenance", () => {
  function draft(): PartDef {
    addPart("t:pv");
    addPads("t:pv", {
      frame: UP,
      text: "X_right; Y_up",
      url: "https://x/a.brd",
      sha: "aa",
      pads: [{ ref: "J1", n: 1, x: 15, y: 47.46, net: "A" }, { ref: "J1", n: 2, x: 17.54, y: 47.46, net: "B" }],
    });
    const o = addOutline("t:pv", { text: "X_right; Y_up", url: "https://x/a.brd", sha: "aa", min: [10, 20], max: [60, 50] });
    const r = importPart(db, "/db", { partId: "t:pv", headers: [H("J1")], id: "t-pv" });
    expect(r.part.imported).toMatchObject({ catalogPart: "t:pv", geometry: { padsKind: "pcb_pad_centers", outline: o }, outlineFrom: "outline dataset", sourceSha256: { pads: "aa", outline: "aa" } });
    return r.part;
  }

  test("an untouched draft matches its hash; editing a pad, the pad count or the outline does not", () => {
    const part = draft();
    expect(part.imported!.geometrySha256).toBe(geometrySha256(part));
    expect(editedAfterImport(part)).toBeNull();
    const moved = structuredClone(part);
    moved.pins[0]!.x += 0.1;
    expect(editedAfterImport(moved)).toMatch(/^t-pv: pads or outline were changed after import/);
    const added = structuredClone(part);
    added.pins.push({ name: "X", role: "io", x: 1, y: 1 });
    expect(editedAfterImport(added)).not.toBeNull();
    const resized = structuredClone(part);
    resized.body.w += 1;
    expect(editedAfterImport(resized)).not.toBeNull();
  });

  test("filling the draft in does not count: names, roles, gpio, heights, electrical values, pin order", () => {
    const part = draft();
    const filled = structuredClone(part);
    filled.pins[0]!.role = "gnd";
    filled.pins[1]!.gpio = 4;
    filled.pins[1]!.name = "SDA";
    filled.pins.reverse();
    filled.body.h = 1.6;
    filled.maxHeight = 12;
    filled.electrical.logicVolts = 3.3;
    filled.sourcing.priceUsd = 5;
    expect(editedAfterImport(filled)).toBeNull();
  });

  test("a hand-written part has no provenance and is never reported", () => {
    const part = draft();
    delete part.imported;
    part.pins[0]!.x += 5;
    expect(editedAfterImport(part)).toBeNull();
  });

  const tmp: string[] = [];
  afterAll(() => {
    for (const d of tmp) rmSync(d, { recursive: true, force: true });
  });
  function checkParts(part: PartDef): { out: string; code: number } {
    const dir = mkdtempSync(join(tmpdir(), "import-prov-"));
    tmp.push(dir);
    writeFileSync(join(dir, `${part.id}.json`), JSON.stringify(part));
    const script = fileURLToPath(new URL("../check-parts.ts", import.meta.url));
    const res = Bun.spawnSync([process.execPath, script, dir]);
    return { out: res.stdout.toString(), code: res.exitCode ?? -1 };
  }
  /** A draft with everything check-parts requires filled in by hand. */
  function completed(part: PartDef): PartDef {
    const p = structuredClone(part);
    p.pins[0]!.role = "gnd";
    p.pins[1]!.gpio = 2;
    p.electrical.logicVolts = 3.3;
    p.sourcing.priceUsd = 5;
    return p;
  }

  test("check-parts reports a changed pad as information, not as an error", () => {
    const part = completed(draft());
    const clean = checkParts(part);
    expect(clean.code).toBe(0);
    expect(clean.out).not.toContain("INFO");
    part.pins[1]!.x -= 0.2;
    const edited = checkParts(part);
    expect(edited.code).toBe(0);
    expect(edited.out).toContain("ok   t-pv.json");
    expect(edited.out).toMatch(/INFO t-pv: pads or outline were changed after import from the catalog \(t:pv, geometry \d+\)/);
  });
});

// ---------------------------------------------------------------------------------------
// Against the real catalog, when BENCHTOP_CATALOG points at it.

const real = process.env.BENCHTOP_CATALOG;
describe.skipIf(!real || !existsSync(real))("real catalog", () => {
  const root = real ? dirname(real) : "";
  const open = (): Database => new Database(real!, { readonly: true });

  test("the default headers are the card generator's board.headers, for an Uno, a dev board and a castellated module", () => {
    const rdb = open();
    try {
      for (const id of ["arduino:A000066", "espressif:esp32-s3-devkitc-1:v1.1", "seeed:doc:xiao_esp32s3_getting_started"]) {
        const geometry = rdb.query(`SELECT geometry_id, kind, source_id, revision, source_url, source_sha256, payload_json, validation_status FROM geometry_objects WHERE part_id = ?`).all(id) as GeometryRow[];
        const defs = rdb.query(`SELECT pin_id, connector, pin_number, name, electrical_type_as_source, functions_as_source, source_id, revision, notes FROM pin_definitions WHERE part_id = ?`).all(id) as PinDefRow[];
        const card = buildBoard(geometry, defs)!;
        expect(card.scope).toBe("board");
        const r = importPart(rdb, root, { partId: id, id: "x", geometryId: card.geometry_id });
        expect(r.headers.map((h) => h.reference).sort()).toEqual(card.headers.map((h) => h.ref).sort());
      }
    } finally {
      rdb.close();
    }
  });

  test("Pico W: its footprint imports as an unresolved module draft with the grounds and GPIO numbers its pin table states", () => {
    const rdb = open();
    try {
      const r = importPart(rdb, root, { partId: "pimoroni:6780985475155", id: "pico-w" });
      expect(r.dataset_kind).toBe("module footprint");
      expect(r.part.pins).toHaveLength(40);
      expect(r.part.pins.filter((p) => p.role === "gnd")).toHaveLength(8);
      expect(r.part.pins.filter((p) => typeof p.gpio === "number")).toHaveLength(26);
      expect(r.part.geometryEvidence!.status).toBe("unresolved");
      expect(r.part.body).toMatchObject({ w: 21, d: 51, h: 1 });
    } finally {
      rdb.close();
    }
  });

  test("ESP32-S3-DevKitC-1: every imported gpio number and ground agrees with the hand-written library part", () => {
    const rdb = open();
    try {
      const r = importPart(rdb, root, { partId: "espressif:esp32-s3-devkitc-1:v1.1", headers: parseHeaderSpecs("J1,J3"), id: "x", rot: 180 });
      const lib = JSON.parse(readFileSync(join(import.meta.dir, "../../assets/parts/esp32-s3-devkitc-1.json"), "utf8")) as PartDef;
      let gpios = 0;
      for (const p of r.part.pins) {
        const q = lib.pins.find((l) => Math.hypot(l.x - p.x, l.y - p.y) < 0.005)!;
        if (typeof p.gpio === "number") {
          expect(q.gpio).toBe(p.gpio);
          gpios++;
        }
        if (p.role === "gnd") expect(q.role).toBe("gnd");
      }
      expect(gpios).toBeGreaterThan(30);
    } finally {
      rdb.close();
    }
  });
});
