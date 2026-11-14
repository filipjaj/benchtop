// Pad positions from the maker catalog's CAD-derived geometry, turned into a draft PartDef.
//
// The catalog stores numeric pad centres for every pad on a board (resistors and test points
// included) in the CAD file's own frame. This module never guesses: the headers are the pad groups
// the card generator classes as headers (`classifyGroup`, the same rule as `board.headers`) or the
// ones the caller names, one dataset (board revision) is used, and anything the data does not say
// stays unset and is listed for a person to fill in. Roles and GPIO numbers are taken from the
// published pin text only where it is unambiguous (see `pinFacts`).
//
// Kept free of catalog.ts so it can be tested against a throwaway database.

import type { Database } from "bun:sqlite";
import { existsSync } from "node:fs";
import { join } from "node:path";
import {
  boardSide,
  classifyGroup,
  distillSpecs,
  joinPinFunctions,
  modelConnectors,
  moduleContactRows,
  type ModelBoard,
  type Pad,
  type PadGroup,
  type PinDefRow as CardPinDefRow,
  type SpecRow,
} from "../catalog-cards";
import { geometrySha256 } from "./import-provenance";
import { registerModel, type Registration } from "./model-frame";
import type { ImportProvenance, PartDef, PinDef, PortDef } from "./types";

/** A request that cannot be satisfied from the data (unknown reference, ambiguous dataset, ...). */
export class PadsError extends Error {}

export const PAD_KIND = "pcb_pad_centers";
/** The footprint that mounts a module on a carrier: footprint-local coordinates, no board outline. */
export const LAND_KIND = "module_land_pattern";
export const OUTLINE_KIND = "pcb_outline_and_drills";
/** Cached files worth opening when there are no numeric pads. */
export const FALLBACK_ASSET_KINDS = ["pinout", "mechanical_drawing", "cad_or_mechanical"];

// ---------------------------------------------------------------------------------------
// Row types (what SQLite hands back)

interface DatasetRow {
  geometry_id: number;
  kind: string;
  revision: string | null;
  coordinate_frame: string;
  source_url: string;
  source_sha256: string | null;
  validation_status: string;
  pad_count: number | null;
  frame_json: string | null;
  native_sha256: string | null;
}

interface PayloadRow {
  payload_json: string;
}

interface AssetRow {
  kind: string;
  title: string | null;
  relative_path: string | null;
  url: string;
}

interface PartRow {
  part_id: string;
  name: string;
  brand: string | null;
}

/** A pin-table row as the importer reads it. Columns an older catalog lacks come back null or empty. */
type PinDefRow = CardPinDefRow;

/** One pad as stored in the payload. Fields other than x_mm and y_mm may be null or absent. */
export interface RawPad {
  reference: string | null;
  pad_number: string | null;
  net_name: string | null;
  x_mm: number;
  y_mm: number;
  pad_type: string | null;
  footprint_side: string | null;
  /** CAD package (boards) or footprint name (module footprints): what `classifyGroup` reads to tell a header from a component. */
  package: string | null;
  footprint_name: string | null;
}

// ---------------------------------------------------------------------------------------
// Frames

export interface Frame {
  /** The only x direction the skill's frame can be reached from without mirroring the board. */
  yDir: "up" | "down";
  /** Where the answer came from, shown to the user. */
  how: string;
  /** Free text kept for display. */
  text: string;
}

function str(v: unknown): string | null {
  return typeof v === "string" && v.trim() !== "" ? v : null;
}

/**
 * Read the axis directions of a dataset. The structured `frame` object wins; the free-text
 * column is the fallback. When neither says X-right and a Y direction clearly, refuse: a
 * wrong flip gives a plausible but mirrored part.
 */
export function readFrame(frameJson: string | null, columnText: string): Frame {
  let obj: Record<string, unknown> | null = null;
  if (frameJson) {
    try {
      const v: unknown = JSON.parse(frameJson);
      if (v && typeof v === "object" && !Array.isArray(v)) obj = v as Record<string, unknown>;
    } catch {
      obj = null;
    }
  }
  const text = columnText;
  if (obj) {
    const x = str(obj.x_direction)?.toLowerCase();
    const y = str(obj.y_direction)?.toLowerCase();
    const view = str(obj.view)?.toLowerCase();
    if (x && y && (y === "up" || y === "down")) {
      if (x !== "right") throw new PadsError(`frame says x runs ${x}; only x-right frames are converted (refusing to guess a mirror). Frame: ${text}`);
      if (view && view !== "top") throw new PadsError(`frame is a ${view} view; only top views are converted (refusing to guess a mirror). Frame: ${text}`);
      return { yDir: y, how: "payload frame (x_direction/y_direction)", text };
    }
  }
  const t = `${text} ${frameJson ?? ""}`;
  const xRight = /\bx[\s_-]*(axis\s*)?(to the\s*)?right\b/i.test(t);
  const yUp = /\by[\s_-]*(axis\s*)?(to the\s*)?up\b/i.test(t);
  const yDown = /\by[\s_-]*(axis\s*)?(to the\s*)?down\b/i.test(t);
  if (xRight && yUp !== yDown) return { yDir: yUp ? "up" : "down", how: "coordinate_frame text", text };
  throw new PadsError(`cannot tell the axis directions of this dataset (need "X right" and "Y up" or "Y down"); refusing to guess. Frame: ${text}`);
}

// ---------------------------------------------------------------------------------------
// Geometry maths

export interface Box {
  minX: number;
  minY: number;
  maxX: number;
  maxY: number;
}

export type Rot = 0 | 90 | 180 | 270;

export function bboxOf(points: { x: number; y: number }[]): Box | null {
  if (!points.length) return null;
  let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
  for (const p of points) {
    minX = Math.min(minX, p.x);
    minY = Math.min(minY, p.y);
    maxX = Math.max(maxX, p.x);
    maxY = Math.max(maxY, p.y);
  }
  return { minX, minY, maxX, maxY };
}

/** Express a source-frame box in a y-down frame. Flipping Y swaps which edge is "min". */
export function boxToYDown(box: Box, frame: Frame): Box {
  return frame.yDir === "down" ? box : { minX: box.minX, maxX: box.maxX, minY: -box.maxY, maxY: -box.minY };
}

export function pointToYDown(p: { x: number; y: number }, frame: Frame): { x: number; y: number } {
  return frame.yDir === "down" ? p : { x: p.x, y: -p.y };
}

const r3 = (v: number): number => {
  const n = Math.round(v * 1000) / 1000;
  return Object.is(n, -0) ? 0 : n;
};

/**
 * Place y-down points into the part frame: origin at the box's top-left corner. `mirror`
 * flips left-right first, `rot` then turns clockwise as seen from above, both about the box.
 */
export function placePoints(
  points: { x: number; y: number }[],
  box: Box,
  rot: Rot,
  mirror: boolean,
): { points: { x: number; y: number }[]; w: number; d: number } {
  const W = box.maxX - box.minX;
  const D = box.maxY - box.minY;
  const swap = rot === 90 || rot === 270;
  const out = points.map((p) => {
    let u = p.x - box.minX;
    let v = p.y - box.minY;
    if (mirror) u = W - u;
    if (rot === 90) [u, v] = [D - v, u];
    else if (rot === 180) [u, v] = [W - u, D - v];
    else if (rot === 270) [u, v] = [v, W - u];
    return { x: r3(u), y: r3(v) };
  });
  return { points: out, w: r3(swap ? D : W), d: r3(swap ? W : D) };
}

// ---------------------------------------------------------------------------------------
// Catalog queries

function all<T>(db: Database, sql: string, ...params: (string | number)[]): T[] {
  return db.query(sql).all(...params) as T[];
}
function one<T>(db: Database, sql: string, ...params: (string | number)[]): T | undefined {
  return (db.query(sql).get(...params) as T | null) ?? undefined;
}
function hasTable(db: Database, name: string): boolean {
  return !!one(db, "SELECT 1 AS x FROM sqlite_master WHERE name = ?", name);
}

export interface DatasetSummary {
  geometry_id: number;
  /** pcb_pad_centers: pads placed on the board. module_land_pattern: the footprint that mounts a module on a carrier. */
  kind: string;
  revision: string | null;
  coordinate_frame: string;
  /** "X right, Y up" style reading of the frame, or the reason it could not be read. */
  frame: string;
  source_url: string;
  source_sha256: string | null;
  validation_status: string;
  pad_count: number;
}

export interface OutlineSummary {
  geometry_id: number;
  revision: string | null;
  source_url: string;
  source_sha256: string | null;
  /** [width, depth] in the source frame, null when the dataset carries no bounds. */
  extent_mm: [number, number] | null;
  scope: string | null;
  /** The outline comes from the same CAD file as the pad dataset it is attached to. */
  same_file_as: number[];
}

interface OutlineBounds {
  box: Box;
  /** Where the bounds come from: parsed CAD edge geometry, or PCB extents from dimension callouts in a drawing. */
  shape: "cad_edge_geometry" | "drawing_callouts";
  scope: string | null;
  thicknessMm: number | null;
  frame: Frame | null;
}

function describeFrame(d: DatasetRow): string {
  try {
    const f = readFrame(d.frame_json, d.coordinate_frame);
    return `X right, Y ${f.yDir}`;
  } catch (e) {
    return `unreadable (${(e as Error).message.split(".")[0]})`;
  }
}

function datasetRowsOfKind(db: Database, partId: string, kind: string): DatasetRow[] {
  if (!hasTable(db, "geometry_objects")) return [];
  return all<DatasetRow>(
    db,
    `SELECT geometry_id, kind, revision, coordinate_frame, source_url, source_sha256, validation_status,
            json_array_length(payload_json, '$.pads') AS pad_count,
            json_extract(payload_json, '$.frame') AS frame_json,
            json_extract(payload_json, '$.native_reference_sha256') AS native_sha256
     FROM geometry_objects WHERE part_id = ? AND kind = ? ORDER BY geometry_id`,
    partId,
    kind,
  );
}

/**
 * The pad datasets in play for a part: the placed-board datasets, or, when the part has none, its
 * module footprints (a part that is itself the module: a Pico, a XIAO). A module footprint is also
 * reachable by naming its geometry id, for a part that has both. The two kinds are never mixed.
 */
function datasetRows(db: Database, partId: string, geometryId?: number): DatasetRow[] {
  const boards = datasetRowsOfKind(db, partId, PAD_KIND);
  if (geometryId === undefined && boards.length) return boards;
  const lands = datasetRowsOfKind(db, partId, LAND_KIND);
  if (geometryId !== undefined) return lands.some((l) => l.geometry_id === geometryId) ? lands : boards.length ? boards : lands;
  return lands;
}

function summarise(d: DatasetRow): DatasetSummary {
  return {
    geometry_id: d.geometry_id,
    kind: d.kind,
    revision: d.revision,
    coordinate_frame: d.coordinate_frame,
    frame: describeFrame(d),
    source_url: d.source_url,
    source_sha256: d.source_sha256,
    validation_status: d.validation_status,
    pad_count: d.pad_count ?? 0,
  };
}

interface OutlineRow {
  geometry_id: number;
  revision: string | null;
  coordinate_frame: string;
  source_url: string;
  source_sha256: string | null;
  payload_json: string;
}

function outlineRows(db: Database, partId: string): OutlineRow[] {
  if (!hasTable(db, "geometry_objects")) return [];
  return all<OutlineRow>(
    db,
    `SELECT geometry_id, revision, coordinate_frame, source_url, source_sha256, payload_json
     FROM geometry_objects WHERE part_id = ? AND kind = ? ORDER BY geometry_id`,
    partId,
    OUTLINE_KIND,
  );
}

function num2(v: unknown): [number, number] | null {
  return Array.isArray(v) && v.length >= 2 && typeof v[0] === "number" && typeof v[1] === "number" && Number.isFinite(v[0]) && Number.isFinite(v[1]) ? [v[0], v[1]] : null;
}

/** Bounds of an outline dataset in its own frame, or null when it carries none. */
function parseOutline(o: OutlineRow): OutlineBounds | null {
  let p: Record<string, unknown>;
  try {
    p = JSON.parse(o.payload_json) as Record<string, unknown>;
  } catch {
    return null;
  }
  // Two payload shapes: parsed CAD edge geometry (outline_bounds.min_mm/max_mm) and extents derived
  // from drawing callouts (bounds_mm.min_x/min_y/max_x/max_y), as catalog-cards.ts also reads.
  const b = p.outline_bounds as Record<string, unknown> | null | undefined;
  const d = p.bounds_mm as Record<string, unknown> | null | undefined;
  let box: Box | null = null;
  let scope: string | null = null;
  let shape: OutlineBounds["shape"] = "cad_edge_geometry";
  const lo = b ? num2(b.min_mm) : null;
  const hi = b ? num2(b.max_mm) : null;
  if (b && lo && hi) {
    box = { minX: lo[0], minY: lo[1], maxX: hi[0], maxY: hi[1] };
    scope = str(b.scope);
  } else if (d && [d.min_x, d.min_y, d.max_x, d.max_y].every((v) => typeof v === "number" && Number.isFinite(v))) {
    box = { minX: d.min_x as number, minY: d.min_y as number, maxX: d.max_x as number, maxY: d.max_y as number };
    scope = str(p.coordinate_scope);
    shape = "drawing_callouts";
  }
  if (!box) return null;
  let frame: Frame | null = null;
  try {
    frame = readFrame(p.frame && typeof p.frame === "object" ? JSON.stringify(p.frame) : null, o.coordinate_frame);
  } catch {
    frame = null;
  }
  return {
    box,
    shape,
    scope,
    thicknessMm: typeof p.source_pcb_thickness_mm === "number" ? p.source_pcb_thickness_mm : null,
    frame,
  };
}

function outlineSummaries(db: Database, partId: string, datasets: DatasetRow[]): OutlineSummary[] {
  return outlineRows(db, partId).map((o) => {
    const ob = parseOutline(o);
    return {
      geometry_id: o.geometry_id,
      revision: o.revision,
      source_url: o.source_url,
      source_sha256: o.source_sha256,
      extent_mm: ob ? [r3(ob.box.maxX - ob.box.minX), r3(ob.box.maxY - ob.box.minY)] : null,
      scope: ob?.scope ?? null,
      same_file_as: datasets.filter((d) => sameFile(d, o)).map((d) => d.geometry_id),
    };
  });
}

/** Same CAD file: identical native hash or identical source URL. Anything looser could mix revisions. */
function sameFile(d: DatasetRow, o: { source_url: string; source_sha256: string | null }): boolean {
  return (!!d.source_sha256 && d.source_sha256 === o.source_sha256) || (!!d.native_sha256 && d.native_sha256 === o.source_sha256) || d.source_url === o.source_url;
}

/** Scopes of a catalog envelope that describe the whole part, as catalog.ts compares them with the library. Others (component, partial body, CAD model, ...) are not an outline. */
const OUTLINE_SCOPES = ["pcb", "assembly", "product_unspecified", "board_without_headers", "board_assembly_without_headers", "product_body_planform_height_unreported"];

interface EnvelopeRow {
  a_mm: number;
  b_mm: number;
  c_mm: number | null;
  axis_labels_json: string | null;
  scope: string;
  source_id: number;
  verification_status: string;
  exact_variant_required: number;
  variant_sku: string | null;
}

/** The catalog's selected envelope for a part, when its scope is a whole-part outline. */
export interface EnvelopeUse {
  /** The two values of the envelope; the order is the source's, not length and width. */
  mm: [number, number];
  /** Third value when its axis label says it is the PCB thickness; a third value of any other kind is not used. */
  thickness: number | null;
  scope: string;
  source_id: number;
  source_url: string | null;
  /** sha256 of the source the catalog retrieved, when it records one. */
  source_sha256: string | null;
  status: string;
  /** The envelope belongs to one variant of the part. */
  variant_sku: string | null;
}

export function selectedEnvelope(db: Database, partId: string): { use: EnvelopeUse | null; why: string } {
  if (!hasTable(db, "envelopes")) return { use: null, why: "the catalog has no envelope table" };
  const e = one<EnvelopeRow>(
    db,
    `SELECT a_mm, b_mm, c_mm, axis_labels_json, scope, source_id, verification_status, exact_variant_required, variant_sku FROM envelopes WHERE part_id = ?`,
    partId,
  );
  if (!e) return { use: null, why: "the catalog has no selected envelope (outer dimensions) for this part" };
  if (!OUTLINE_SCOPES.includes(e.scope)) return { use: null, why: `the catalog's envelope for this part has scope "${e.scope}", which is not a whole-part outline` };
  let axes: unknown = null;
  try {
    axes = e.axis_labels_json ? JSON.parse(e.axis_labels_json) : null;
  } catch {
    axes = null;
  }
  const thirdIsThickness = e.c_mm != null && Array.isArray(axes) && typeof axes[2] === "string" && /thickness/i.test(axes[2]);
  const src = hasTable(db, "sources") ? one<{ url: string; content_sha256: string | null }>(db, `SELECT url, content_sha256 FROM sources WHERE source_id = ?`, e.source_id) : undefined;
  return {
    use: {
      mm: [e.a_mm, e.b_mm],
      thickness: thirdIsThickness ? e.c_mm : null,
      scope: e.scope,
      source_id: e.source_id,
      source_url: src?.url ?? null,
      source_sha256: src?.content_sha256 ?? null,
      status: e.verification_status,
      variant_sku: e.exact_variant_required === 1 ? e.variant_sku : null,
    },
    why: "",
  };
}

export interface CachedFile {
  kind: string;
  title: string | null;
  path: string;
  origin_url: string;
  exists: boolean;
}

/** Cached pinouts and drawings, paths resolved against the database's folder. */
export function cachedPinoutFiles(db: Database, root: string, partId: string): CachedFile[] {
  if (!hasTable(db, "v_assets")) return [];
  const kinds = FALLBACK_ASSET_KINDS.map(() => "?").join(",");
  const rows = all<AssetRow>(
    db,
    `SELECT kind, title, relative_path, url FROM v_assets
     WHERE part_id = ? AND local_status = 'downloaded' AND relative_path IS NOT NULL AND kind IN (${kinds}) ORDER BY kind, asset_id`,
    partId,
    ...FALLBACK_ASSET_KINDS,
  );
  return rows.map((a) => {
    const path = join(root, a.relative_path!);
    return { kind: a.kind, title: a.title, path, origin_url: a.url, exists: existsSync(path) };
  });
}

function loadPads(db: Database, geometryId: number): { pads: RawPad[]; skipped: number } {
  const row = one<PayloadRow>(db, `SELECT payload_json FROM geometry_objects WHERE geometry_id = ?`, geometryId);
  if (!row) throw new PadsError(`geometry ${geometryId} does not exist`);
  const payload = JSON.parse(row.payload_json) as { pads?: Record<string, unknown>[] };
  const pads: RawPad[] = [];
  let skipped = 0;
  for (const p of payload.pads ?? []) {
    const x = p.x_mm;
    const y = p.y_mm;
    if (typeof x !== "number" || typeof y !== "number" || !Number.isFinite(x) || !Number.isFinite(y)) {
      skipped++;
      continue;
    }
    pads.push({
      reference: str(p.reference),
      pad_number: p.pad_number === undefined || p.pad_number === null || String(p.pad_number).trim() === "" ? null : String(p.pad_number),
      net_name: str(p.net_name),
      x_mm: x,
      y_mm: y,
      pad_type: str(p.pad_type),
      footprint_side: str(p.footprint_side),
      package: str(p.package),
      footprint_name: str(p.footprint_name),
    });
  }
  return { pads, skipped };
}

// ---------------------------------------------------------------------------------------
// pads: what exists

export interface RefSummary {
  reference: string;
  pads: number;
  /** Source frame, mm. */
  bbox: [number, number, number, number];
  /** Width and height of the bbox. */
  extent_mm: [number, number];
  pad_types: Record<string, number>;
  /** A few distinct net names, enough to recognise a header. */
  nets: string[];
  /** Board datasets: what `import-part` without --header takes this reference for (the card generator's reading), or null when it would leave it out. */
  default_header: { kind: string; basis: string[] } | null;
  /** Module footprints: the contact rows `import-part` reads in this reference (4 or more pads in a line on one pitch). */
  contact_rows: { pads: number; pitch_mm: number }[];
}

export interface PadsReport {
  part_id: string;
  part_name: string | null;
  datasets: DatasetSummary[];
  /** The kind of the dataset(s) listed: placed board pads, or module footprints. */
  dataset_kind: "board" | "module footprint" | null;
  /** Module footprints only: what the outline would be. */
  envelope: { use: EnvelopeUse | null; why: string } | null;
  /** More than one dataset and none chosen: the caller must pick. */
  needs_choice: boolean;
  chosen: number | null;
  frame_note: string | null;
  skipped_pads: number;
  references: RefSummary[] | null;
  outline_datasets: OutlineSummary[];
  /** The outline that would be used for the chosen dataset. */
  paired_outline: OutlineSummary | null;
  /** Only when there are no datasets. */
  cached_files: CachedFile[];
}

/** Pads by reference designator. A pad without one is left out, unless `unnamed` says what to call it (module footprints: "module"). */
function groupByRef(pads: RawPad[], unnamed?: string): Map<string, RawPad[]> {
  const m = new Map<string, RawPad[]>();
  for (const p of pads) {
    const ref = p.reference ?? unnamed;
    if (ref === undefined) continue;
    const list = m.get(ref) ?? [];
    list.push(p);
    m.set(ref, list);
  }
  return m;
}

function natural(a: string, b: string): number {
  return a.localeCompare(b, "en", { numeric: true });
}

function pickDataset(datasets: DatasetRow[], partId: string, geometryId?: number): DatasetRow | null {
  if (geometryId !== undefined) {
    const d = datasets.find((x) => x.geometry_id === geometryId);
    if (!d) {
      throw new PadsError(
        `geometry ${geometryId} is not a ${datasets.some((x) => x.kind === LAND_KIND) ? LAND_KIND : PAD_KIND} dataset of ${partId}${datasets.length ? ` (have ${datasets.map((x) => x.geometry_id).join(", ")})` : ""}`,
      );
    }
    return d;
  }
  return datasets.length === 1 ? datasets[0]! : null;
}

export function describePads(db: Database, root: string, partId: string, geometryId?: number): PadsReport {
  const part = one<PartRow>(db, `SELECT part_id, name, brand FROM parts WHERE part_id = ?`, partId);
  if (!part) throw new PadsError(`no part with id "${partId}". Run: find <text> to get an exact id.`);
  const rows = datasetRows(db, partId, geometryId);
  const chosenRow = pickDataset(rows, partId, geometryId);
  const isModule = rows.some((r) => r.kind === LAND_KIND);
  const outlines = isModule ? [] : outlineSummaries(db, partId, rows);
  const report: PadsReport = {
    part_id: partId,
    part_name: part.name,
    datasets: rows.map(summarise),
    dataset_kind: rows.length ? (isModule ? "module footprint" : "board") : null,
    envelope: isModule ? selectedEnvelope(db, partId) : null,
    needs_choice: rows.length > 1 && !chosenRow,
    chosen: chosenRow?.geometry_id ?? null,
    frame_note: null,
    skipped_pads: 0,
    references: null,
    outline_datasets: outlines,
    paired_outline: chosenRow && !isModule ? (outlines.find((o) => o.same_file_as.includes(chosenRow.geometry_id)) ?? null) : null,
    cached_files: rows.length ? [] : cachedPinoutFiles(db, root, partId),
  };
  if (!chosenRow) return report;
  const { pads, skipped } = loadPads(db, chosenRow.geometry_id);
  report.skipped_pads = skipped;
  report.frame_note = describeFrame(chosenRow);
  const refs: RefSummary[] = [];
  const contacts = isModule ? moduleContactRows(pads).rows : [];
  for (const [reference, list] of groupByRef(pads, isModule ? "module" : undefined)) {
    const b = bboxOf(list.map((p) => ({ x: p.x_mm, y: p.y_mm })))!;
    const types: Record<string, number> = {};
    for (const p of list) types[p.pad_type ?? "unknown"] = (types[p.pad_type ?? "unknown"] ?? 0) + 1;
    const cls = isModule ? null : classifyGroup(reference, list[0]!.package ?? list[0]!.footprint_name, list);
    refs.push({
      reference,
      pads: list.length,
      bbox: [r3(b.minX), r3(b.minY), r3(b.maxX), r3(b.maxY)],
      extent_mm: [r3(b.maxX - b.minX), r3(b.maxY - b.minY)],
      pad_types: types,
      nets: [...new Set(list.map((p) => p.net_name).filter((n): n is string => !!n))].slice(0, 4),
      default_header: cls && cls.cls === "header" ? { kind: cls.kind, basis: cls.basis } : null,
      contact_rows: contacts.filter((c) => c.ref === reference).map((c) => ({ pads: c.pads.length, pitch_mm: c.pitch_mm })),
    });
  }
  // Through-hole references first: headers are almost always through-hole, passives are not.
  const th = (r: RefSummary): number => r.pad_types.through_hole ?? 0;
  refs.sort((a, b) => Number(th(b) > 0) - Number(th(a) > 0) || natural(a.reference, b.reference));
  report.references = refs;
  return report;
}

const n2 = (n: number): string => String(Number(n.toFixed(3)));

export function formatPads(r: PadsReport): string {
  const L: string[] = [];
  L.push(`# ${r.part_id}: ${r.part_name ?? ""}`);
  if (!r.datasets.length) {
    L.push("no numeric pad data (no pcb_pad_centers or module_land_pattern dataset). Nothing is estimated from images.");
    if (r.cached_files.length) {
      L.push("Cached pinout and drawing files to read the pads from (open them; do not estimate millimetres from a photograph):");
      for (const f of r.cached_files) L.push(`${f.kind} | ${f.exists ? "LOCAL" : "MISSING ON DISK"} ${f.path}${f.title ? ` | ${f.title}` : ""} | origin ${f.origin_url}`);
    } else L.push("No pinout or drawing is cached locally either; run: show " + r.part_id);
    return L.join("\n");
  }
  const isModule = r.dataset_kind === "module footprint";
  L.push(`## ${isModule ? "Module footprint datasets" : "Pad datasets"} (${r.datasets.length}; each is one CAD file and revision, never merge them)`);
  if (isModule) L.push(`kind ${LAND_KIND}: the footprint that mounts the module on a carrier, in footprint-local coordinates, not coordinates on the module's own PCB. import-part reads its contact rows and writes a draft whose geometry is marked unresolved.`);
  for (const d of r.datasets) {
    L.push(
      `geometry ${d.geometry_id}${r.chosen === d.geometry_id ? " (selected)" : ""} | revision ${d.revision ?? "unknown"} | frame ${d.frame} | ${d.pad_count} pads | validation ${d.validation_status}`,
    );
    L.push(`    source ${d.source_url} | sha256 ${d.source_sha256 ?? "none"}`);
    L.push(`    frame text: ${clip(d.coordinate_frame, 200)}`);
  }
  if (isModule) {
    const e = r.envelope;
    L.push(
      "",
      e?.use
        ? `## Module outline\nno outline in the footprint. import-part would use the catalog's selected envelope: ${e.use.mm.map(n2).join(" x ")} mm (scope ${e.use.scope}${e.use.variant_sku ? `, variant ${e.use.variant_sku}` : ""}), with the pads centred in it as an assumption.`
        : `## Module outline\nno outline in the footprint and ${e?.why ?? "no envelope"}: import-part would use the bounding box of all pads.`,
    );
    if (r.needs_choice) L.push("", "More than one module footprint (usually one per way of mounting): choose one with --geometry <id>. No references are listed until you do.");
    else {
      L.push("", `## References in geometry ${r.chosen} (source frame ${r.frame_note}; bbox is minX minY maxX maxY in mm)`);
      for (const x of r.references ?? []) {
        L.push(
          `${x.reference} | ${x.pads} pads | bbox ${x.bbox.map(n2).join(" ")} | ${Object.entries(x.pad_types).map(([k, v]) => `${k} ${v}`).join(", ")} | contact rows ${x.contact_rows.length ? x.contact_rows.map((c) => `${c.pads} pads at ${n2(c.pitch_mm)} mm`).join(", ") : "none"}`,
        );
      }
    }
    return L.join("\n");
  }
  L.push("", `## Board outline (kind ${OUTLINE_KIND})`);
  if (!r.outline_datasets.length) L.push("none: an import would use the bounding box of ALL pads as the board size, which is smaller than the board edge");
  for (const o of r.outline_datasets) {
    L.push(
      `geometry ${o.geometry_id} | revision ${o.revision ?? "unknown"} | ${o.extent_mm ? `${n2(o.extent_mm[0])} x ${n2(o.extent_mm[1])} mm (${o.scope ?? "scope unknown"})` : "no bounds in the payload"} | ${
        o.same_file_as.length ? `same CAD file as pad geometry ${o.same_file_as.join(", ")}` : "not from the same CAD file as any pad dataset (would not be used)"
      }`,
    );
  }
  if (r.needs_choice) {
    L.push("", `More than one pad dataset: choose one with --geometry <id>. No references are listed until you do.`);
    return L.join("\n");
  }
  L.push("", `## References in geometry ${r.chosen} (source frame ${r.frame_note}; bbox is minX minY maxX maxY in mm; through-hole references first)`);
  if (r.skipped_pads) L.push(`${r.skipped_pads} pad(s) without numeric coordinates were left out`);
  for (const x of r.references ?? []) {
    L.push(
      `${x.reference} | ${x.pads} pads | bbox ${x.bbox.map(n2).join(" ")} | ${n2(x.extent_mm[0])} x ${n2(x.extent_mm[1])} mm | ${Object.entries(x.pad_types).map(([k, v]) => `${k} ${v}`).join(", ")}${x.nets.length ? ` | nets ${x.nets.join(", ")}` : ""}${
        x.default_header ? ` | HEADER by default (${x.default_header.kind}; ${x.default_header.basis.join("; ")})` : ""
      }`,
    );
  }
  L.push("", r.paired_outline ? `Board outline: geometry ${r.paired_outline.geometry_id} (same CAD file) would be used.` : "Board outline: none from the same CAD file; an import would use the bounding box of ALL pads, not the board edge.");
  return L.join("\n");
}

function clip(s: string, n: number): string {
  const t = s.replace(/\s+/g, " ").trim();
  return t.length > n ? `${t.slice(0, n - 1)}…` : t;
}

// ---------------------------------------------------------------------------------------
// import-part

export interface HeaderSpec {
  reference: string;
  /** Pad numbers to keep; null keeps every pad of the reference. */
  pads: string[] | null;
}

/** `J1`, `J1:1-7`, `J1:1,3,5`. Ranges are for integer pad numbers only. */
export function parseHeaderSpecs(text: string): HeaderSpec[] {
  const specs: HeaderSpec[] = [];
  // A comma separates references; inside a reference the pad list uses ";" and ranges.
  for (const part of text.split(",")) {
    const t = part.trim();
    if (t) specs.push(parseOne(t));
  }
  return mergeSpecs(specs);
}

/** `x0,y0,x1,y1` in the dataset's source frame; corners in any order. */
export function parseOutlineArg(text: string): Box {
  const v = text.split(",").map((s) => Number(s.trim()));
  if (v.length !== 4 || v.some((n) => !Number.isFinite(n))) throw new PadsError(`--outline needs four numbers x0,y0,x1,y1 (mm, in the CAD file's own frame), got "${text}"`);
  const [x0, y0, x1, y1] = v as [number, number, number, number];
  if (x0 === x1 || y0 === y1) throw new PadsError(`--outline "${text}" has no area`);
  return { minX: Math.min(x0, x1), minY: Math.min(y0, y1), maxX: Math.max(x0, x1), maxY: Math.max(y0, y1) };
}

function parseOne(t: string): HeaderSpec {
  const i = t.indexOf(":");
  if (i < 0) return { reference: t, pads: null };
  const reference = t.slice(0, i);
  const pads: string[] = [];
  for (const tok of t.slice(i + 1).split(";")) {
    const s = tok.trim();
    if (!s) continue;
    const m = /^(\d+)-(\d+)$/.exec(s);
    if (m) {
      const a = Number(m[1]);
      const b = Number(m[2]);
      if (b < a || b - a > 500) throw new PadsError(`pad range "${s}" in --header ${t} is not usable`);
      for (let n = a; n <= b; n++) pads.push(String(n));
    } else pads.push(s);
  }
  if (!reference || !pads.length) throw new PadsError(`--header entry "${t}" needs a reference and at least one pad, e.g. J1:1-7`);
  return { reference, pads };
}

function mergeSpecs(specs: HeaderSpec[]): HeaderSpec[] {
  const seen = new Map<string, HeaderSpec>();
  for (const s of specs) {
    const prev = seen.get(s.reference);
    if (!prev) {
      seen.set(s.reference, s);
      continue;
    }
    // Asking for a whole reference and a slice of it is a contradiction worth stopping on.
    if (prev.pads === null || s.pads === null) throw new PadsError(`--header names ${s.reference} twice, once for all pads and once for a subset`);
    prev.pads.push(...s.pads);
  }
  return [...seen.values()];
}

export interface ImportOptions {
  partId: string;
  /**
   * The pad groups to import. Omitted: the groups the card generator classes as headers
   * (`classifyGroup`, the rule behind `board.headers`), or a module footprint's contact rows.
   * Given, even empty: exactly these.
   */
  headers?: HeaderSpec[];
  id: string;
  geometryId?: number;
  rot?: Rot;
  mirror?: boolean;
  /** Board edge in the dataset's own source frame, mm; replaces the outline and the pad bounding box. */
  outline?: Box;
  /** File the draft will be written to; check-parts needs it to equal `<id>.json`. */
  fileName?: string;
}

/** One pad group the import took, and why. */
export interface HeaderTaken {
  reference: string;
  /** Pad numbers taken; null is every pad of the reference. */
  pads: string[] | null;
  from: "default" | "--header";
  /** What the card generator calls the group ("pin_header", "castellated_edge", "module_contact_row"); null for a group named with --header. */
  kind: string | null;
  /** Why it was taken: the card generator's basis, or "named with --header". */
  basis: string[];
}

export interface ImportResult {
  part: PartDef;
  geometry_id: number;
  /** "board": pads placed on the part's own PCB. "module footprint": the land pattern that mounts the module on a carrier. */
  dataset_kind: "board" | "module footprint";
  revision: string | null;
  frame: string;
  outline: "outline dataset" | "bounding box of all pads" | "outline supplied on the command line" | "catalog envelope";
  outline_geometry_id: number | null;
  /** Dataset pad count, to make clear how few were imported. */
  dataset_pads: number;
  imported_pads: number;
  /** The pad groups taken and the basis of each. */
  headers: HeaderTaken[];
  rot: Rot;
  mirror: boolean;
  name_sources: { pin_definitions: number; net_name: number; reference_pad: number };
  /** Values set from the published pin text: ground pins and GPIO numbers, each recorded on the pin as importedFrom. */
  from_pin_text: { gnd: number; gpio: number };
  /** Ground pins set from a CAD net named GND, on pads with no published pin row. */
  from_net_name: { gnd: number };
  /** Pins whose published name or source type says power. Their role, volts and direction are left for a person. */
  power_pins: string[];
  /** electrical.logicVolts, when the catalog states one logic level for the part and every claim agrees. */
  logic_volts: { value: number; from: string } | null;
  /** maxHeight (and body.h when the outline states no thickness) from the maker's 3D model: nominal, not measured. Null when the catalog has no usable model. */
  model_height: { max_height: number; above_pcb: number; below_pcb: number; pcb_thickness: number | null; geometry_id: number } | null;
  /** Ports taken from the 3D model's connector openings, and how well the model matched these pads. Null when none were imported. */
  model_ports: { names: string[]; features: number; side_evidence: number; residual_mm: number; rotation_deg: number; reflected: boolean } | null;
  warnings: string[];
  /** Fields the type or check-parts needs that the catalog cannot supply. */
  missing: string[];
}

function resolveReference(wanted: string, have: string[]): string {
  if (have.includes(wanted)) return wanted;
  const ci = have.filter((h) => h.toLowerCase() === wanted.toLowerCase());
  if (ci.length === 1) return ci[0]!;
  throw new PadsError(`reference "${wanted}" is not in this dataset. References: ${[...have].sort(natural).join(", ")}`);
}

/** Geometry ids a pin definition is bound to (`notes` JSON), or null when the row carries no binding. */
function boundGeometryIds(notes: string | null): number[] | null {
  if (!notes) return null;
  try {
    const n = JSON.parse(notes) as { supported_geometry_ids?: unknown; geometry_bindings?: { geometry_id?: unknown }[] };
    const ids = Array.isArray(n.supported_geometry_ids) ? n.supported_geometry_ids : Array.isArray(n.geometry_bindings) ? n.geometry_bindings.map((b) => b.geometry_id) : null;
    return ids ? ids.filter((x): x is number => typeof x === "number") : null;
  } catch {
    return null;
  }
}

/** The one pin-table row for this connector and pad number, or null when there is none or two (two would be a guess). */
function pinDefRow(defs: PinDefRow[], reference: string, pad: string | null, geometryId: number): PinDefRow | null {
  if (pad === null) return null;
  const hits = defs.filter((d) => {
    if (d.connector.toLowerCase() !== reference.toLowerCase() || d.pin_number !== pad || d.name.trim() === "") return false;
    // A row bound to other datasets describes another CAD file's numbering; an unbound row is matched by connector and number alone.
    const bound = boundGeometryIds(d.notes ?? null);
    return bound === null || bound.includes(geometryId);
  });
  return hits.length === 1 ? hits[0]! : null;
}

/** Columns of a pin-table row and what stands in for one an older catalog lacks. */
const PIN_COLUMNS: [string, string][] = [
  ["pin_id", "0"],
  ["connector", "''"],
  ["pin_number", "''"],
  ["name", "''"],
  ["electrical_type_as_source", "NULL"],
  ["functions_as_source", "''"],
  ["source_id", "0"],
  ["revision", "NULL"],
  ["notes", "NULL"],
];

function pinDefRows(db: Database, partId: string): PinDefRow[] {
  if (!hasTable(db, "pin_definitions")) return [];
  const have = new Set(all<{ name: string }>(db, `PRAGMA table_info(pin_definitions)`).map((c) => c.name));
  const cols = PIN_COLUMNS.map(([c, fallback]) => (have.has(c) ? c : `${fallback} AS ${c}`)).join(", ");
  return all<PinDefRow>(db, `SELECT ${cols} FROM pin_definitions WHERE part_id = ?`, partId);
}

// ---------------------------------------------------------------------------------------
// Roles and GPIO numbers from the published pin text

/** Ground by its published name: GND, G, AGND, DGND, PGND, GND1, GND.2, GND@3, GROUND. */
const GROUND_NAME = /^(?:[ADPSC]?GND|GROUND)(?:[ _.@-]?\d+)?$/i;
/** Ground by the source's own pin type: the ESP-IDF boards' "G" and the tables that write "GND". */
const GROUND_TYPE = /^(?:G|GND|GROUND)$/i;
/**
 * One GPIO number, in the three forms the catalog's pin tables use: GPIOn (Espressif, Arduino, Adafruit),
 * GPn (the Raspberry Pi Pico tables) and IOn (Espressif's short form: "IO12; MISO", "MTCK/IO39/CAM_SCL",
 * "GPIO label IO9"). Upper case only, no separator, and not part of a longer word or prefixed token:
 * RTC_GPIO3 and LP_GPIO7 are other numbering spaces, DIO2 is not IO2, GP2Y1010 is a sensor.
 */
const GPIO_TOKEN = /(?<![A-Za-z0-9_])(?:GPIO|GP|IO)(\d{1,3})(?![A-Za-z0-9])/g;
/** Pin types a source uses for a supply pin ("P", "power_in", ...). */
const POWER_TYPE = /^(?:P|PWR|POWER|POWER_IN|POWER_OUT|SUP|SUPPLY)$/i;
/** Supply rails by name: 3V3, 3.3V, +5V, 5V, 3V3_OUT, VIN, VBUS, VBAT, VSYS, VCC, VDD, VCC_3V3, IOREF. */
const POWER_NAME = /^(?:[+-]?\d+(?:\.\d+)?V\d*(?:_(?:OUT|IN|EXT))?|[AD]?V(?:CC|DD|IN|BUS|BAT|BATT|SYS|USB|OUT|EXT)\w*|IOREF)$/i;

export interface PinFacts {
  /** Why the pin is a ground, or null. */
  gnd: string | null;
  /** The one GPIO number the published text states, and where; null when it names none or more than one. */
  gpio: { n: number; from: string } | null;
  /** Distinct GPIO numbers the text names (two or more means no gpio is set). */
  gpioCandidates: number[];
  /** The source types the pin as a supply, so its role, volts and direction are a person's call. */
  power: boolean;
}

const where = (r: PinDefRow): string => `pin_definitions #${r.pin_id} (${r.connector} pin ${r.pin_number})`;

function groundEvidence(r: PinDefRow): string | null {
  const name = r.name.trim();
  const type = (r.electrical_type_as_source ?? "").trim();
  const text = r.functions_as_source.trim();
  if (GROUND_NAME.test(name)) return `${where(r)}: published pin name "${name}"`;
  if (GROUND_TYPE.test(type)) return `${where(r)}: source pin type "${type}"`;
  // A bare "G" is a MOSFET gate on a breakout, so it counts only when nothing else in the row says otherwise.
  if (name === "G" && (!text || /gnd|ground/i.test(text)) && (!type || POWER_TYPE.test(type))) return `${where(r)}: published pin name "G"${text ? ` (${text.slice(0, 40)})` : ""}`;
  return null;
}

/** GPIO numbers in a row's published name and function text. A schematic net label ("native net: IO8") is not a function and is ignored. */
function gpioTokens(r: PinDefRow): { n: number; token: string; in: "name" | "function text" }[] {
  const out: { n: number; token: string; in: "name" | "function text" }[] = [];
  for (const [text, label] of [
    [r.name, "name"],
    [r.functions_as_source, "function text"],
  ] as const) {
    const published = text.replace(/native net:[\s\S]*$/i, "");
    for (const m of published.matchAll(GPIO_TOKEN)) out.push({ n: Number(m[1]), token: m[0], in: label });
  }
  return out;
}

/** What the published rows for one pin say. `rows` is every row the pin's text was read from. */
export function pinFacts(rows: PinDefRow[]): PinFacts {
  let gnd: string | null = null;
  for (const r of rows) gnd ??= groundEvidence(r);
  const tokens = rows.flatMap((r) => gpioTokens(r).map((t) => ({ ...t, row: r })));
  const distinct = [...new Set(tokens.map((t) => t.n))];
  const first = tokens[0];
  return {
    gnd,
    gpio: distinct.length === 1 && first ? { n: first.n, from: `${where(first.row)}: published ${first.in} "${first.token}"` } : null,
    gpioCandidates: distinct,
    power: gnd === null && rows.some((r) => POWER_TYPE.test((r.electrical_type_as_source ?? "").trim())),
  };
}

// ---------------------------------------------------------------------------------------
// Logic level from the specifications

export const MODEL_KIND = "pcb_model_clearances";

export interface ModelHeights {
  geometryId: number;
  /** Tallest modelled point above the PCB's top face, mm. */
  above: number;
  /** Lowest modelled point below the PCB's bottom face, mm (0 when nothing is modelled there). */
  below: number;
  /** PCB thickness in the model, mm. */
  thickness: number | null;
  /** The catalog's own words for what the figure is: a nominal model, not a measurement. */
  status: string;
  sourceUrl: string | null;
  sourceSha256: string | null;
  /** The model's board record as the catalog wrote it: PCB bounds and connectors, in the model's own frame. */
  board: ModelBoard;
}

const finite =(v: unknown): v is number => typeof v === "number" && Number.isFinite(v);

/**
 * Heights from the maker's 3D model (`pcb_model_clearances`), when the part has exactly one
 * reading or all its readings agree. They are nominal model figures: parts the model leaves
 * out (headers that ship loose, a display fitted later) are not counted. Height needs no
 * coordinate frame, so it can be used as it is. The connector openings in the same record
 * are in the model's own frame, which the catalog has not matched to the pad coordinates,
 * so they are not read here.
 */
export function modelHeights(db: Database, partId: string): { use: ModelHeights | null; why: string | null } {
  if (!hasTable(db, "geometry_objects")) return { use: null, why: null };
  const rows = all<{ geometry_id: number; payload_json: string | null; source_url: string | null; source_sha256: string | null }>(
    db,
    `SELECT geometry_id, payload_json, source_url, source_sha256 FROM geometry_objects WHERE part_id = ? AND kind = ? ORDER BY geometry_id`,
    partId,
    MODEL_KIND,
  );
  if (!rows.length) return { use: null, why: null };
  const read: ModelHeights[] = [];
  for (const r of rows) {
    let boards: unknown;
    try {
      // The payload is the catalog's JSON; every field is checked before use.
      boards = (JSON.parse(r.payload_json ?? "{}") as { boards?: unknown }).boards;
    } catch {
      continue;
    }
    if (!Array.isArray(boards) || boards.length !== 1) continue;
    const b = boards[0] as Record<string, unknown>;
    const above = b.maximum_height_above_pcb_mm;
    const below = b.maximum_height_below_pcb_mm;
    const t = b.pcb_thickness_model_mm;
    if (!finite(above) || above < 0 || above > 200) continue;
    read.push({
      geometryId: r.geometry_id,
      above,
      below: finite(below) && below > 0 ? below : 0,
      thickness: finite(t) && t > 0 && t < 10 ? t : null,
      status: typeof b.maximum_height_status === "string" ? b.maximum_height_status : "nominal model geometry",
      sourceUrl: r.source_url,
      sourceSha256: r.source_sha256,
      // Same object, read through the card generator's type for the fields the registration uses; each is checked there.
      board: b as ModelBoard,
    });
  }
  if (!read.length) return { use: null, why: `the catalog's 3D-model record(s) for this part (geometry ${rows.map((r) => r.geometry_id).join(", ")}) carry no usable height` };
  const first = read[0]!;
  const agree = read.every((m) => Math.abs(m.above - first.above) <= 0.1 && Math.abs((m.thickness ?? 0) - (first.thickness ?? 0)) <= 0.1);
  if (!agree) {
    return { use: null, why: `the catalog has ${read.length} 3D-model heights for this part that disagree (${read.map((m) => `${n2(m.above)} mm above the PCB in geometry ${m.geometryId}`).join("; ")}); none is used` };
  }
  return { use: first, why: null };
}

/**
 * Room added around every imported opening for the plug's body. The model gives the hole in the
 * connector, not what has to pass through the case wall; 2 mm is what the library's hand-written
 * USB ports use. A default, not a catalog figure.
 */
export const PORT_MARGIN_MM = 2;

export interface ModelPorts {
  ports: PortDef[];
  registration: Registration | null;
  /** Why there are no ports, when there are none. */
  note: string | null;
}

/** A name a builder recognises, from the model's package name. Falls back to the package name itself. */
function portName(model: string, ref: string | null): string {
  const kinds: [RegExp, string][] = [
    [/USB.?C|TYPE.?C/i, "USB-C"],
    [/MICRO.?USB|USB.?MICRO|USB.?B.?MICRO/i, "Micro USB"],
    [/USB/i, "USB"],
    [/TERM|SCREW/i, "Terminal block"],
    [/BARREL|DC.?JACK|POWER.?JACK|PJ-/i, "DC jack"],
    [/MICROSD|SD.?CARD|TF.?CARD/i, "SD card"],
    [/AUDIO|TRRS|3\.5\s?MM/i, "Audio jack"],
    [/JST|QWIIC|STEMMA|GROVE/i, "JST connector"],
  ];
  const kind = kinds.find(([re]) => re.test(model))?.[1];
  // A model part with a name that says nothing to a builder ("Surface 1") is still an opening; say what it was called.
  if (!kind) return `Connector (${ref && !/^\d+$/.test(ref) ? `${ref}, ` : ""}${model})`;
  return ref ? `${kind} (${ref})` : kind;
}

/**
 * Connector openings from the maker's 3D model, as ports in the part's own frame.
 *
 * The model has its own axes, so it is first matched to this pad dataset (`registerModel`:
 * same outline size, connectors named alike in the same places, the side of the board they
 * sit on). No unique match, no ports. One connector can carry several openings (one per
 * position of a terminal block, or nested ones); they become one port per connector and wall.
 *
 * `outline` is the board outline in the pad dataset's source frame; `yDownBox`, `rot` and
 * `mirror` are what the pads themselves were placed with, so a port lands where its pads do.
 */
export function portsFromModel(a: { board: ModelBoard; pads: RawPad[]; frame: Frame; outline: Box; yDownBox: Box; rot: Rot; mirror: boolean }): ModelPorts {
  const lo = a.board.pcb_bounds_mm?.min_mm;
  const hi = a.board.pcb_bounds_mm?.max_mm;
  if (!lo || !hi || lo.length < 2 || hi.length < 2) return { ports: [], registration: null, note: "the 3D model does not give its PCB bounds" };
  const padGroups = [...groupByRef(a.pads)].map(([ref, list]) => {
    const sides = new Set(list.map((p) => boardSide(p.footprint_side)));
    return {
      ref,
      center: [list.reduce((s, p) => s + p.x_mm, 0) / list.length, list.reduce((s, p) => s + p.y_mm, 0) / list.length] as [number, number],
      side: sides.size === 1 ? [...sides][0]! : null,
    };
  });
  const r = registerModel({
    modelPcb: { min: [lo[0]!, lo[1]!], max: [hi[0]!, hi[1]!] },
    outline: { min: [a.outline.minX, a.outline.minY], max: [a.outline.maxX, a.outline.maxY] },
    connectors: modelConnectors(a.board),
    padGroups,
    padFrameY: a.frame.yDir,
  });
  if (!r.ok) return { ports: [], registration: null, note: r.reason };
  const reg = r.registration;
  if (reg.transform.seen_from_underside) {
    return { ports: [], registration: reg, note: "the 3D model shows the board from the other side than the pad data (its top is the pad data's underside); openings are not imported for such a board" };
  }

  // A point and a direction of the pad dataset's source frame, in the part's frame: exactly what the pads went through.
  const place = (p: [number, number]): { x: number; y: number } => placePoints([pointToYDown({ x: p[0], y: p[1] }, a.frame)], a.yDownBox, a.rot, a.mirror).points[0]!;
  const merged = new Map<string, { name: string; faces: PortDef["faces"]; edge: number; lo: number; hi: number; zLo: number; zHi: number }>();
  for (const o of reg.openings) {
    const at = place(o.center);
    const tip = place([o.center[0] + o.outward[0], o.center[1] + o.outward[1]]);
    const dx = Math.round(tip.x - at.x);
    const dy = Math.round(tip.y - at.y);
    const faces: PortDef["faces"] | null = dx === 1 && dy === 0 ? "x+" : dx === -1 && dy === 0 ? "x-" : dx === 0 && dy === 1 ? "y+" : dx === 0 && dy === -1 ? "y-" : null;
    if (!faces || !(o.width_mm > 0) || !(o.upper_above_pcb_mm > o.lower_above_pcb_mm)) continue;
    const alongX = faces === "y+" || faces === "y-";
    const along = alongX ? at.x : at.y;
    const edge = alongX ? at.y : at.x;
    const key = `${o.ref ?? o.connector}|${faces}`;
    const m = merged.get(key);
    if (m) {
      m.lo = Math.min(m.lo, along - o.width_mm / 2);
      m.hi = Math.max(m.hi, along + o.width_mm / 2);
      m.zLo = Math.min(m.zLo, o.lower_above_pcb_mm);
      m.zHi = Math.max(m.zHi, o.upper_above_pcb_mm);
    } else {
      merged.set(key, { name: portName(o.connector, o.ref), faces, edge, lo: along - o.width_mm / 2, hi: along + o.width_mm / 2, zLo: o.lower_above_pcb_mm, zHi: o.upper_above_pcb_mm });
    }
  }
  const r2 = (n: number): number => Number(n.toFixed(2));
  const ports: PortDef[] = [...merged.values()].map((m) => {
    const alongX = m.faces === "y+" || m.faces === "y-";
    const mid = r2((m.lo + m.hi) / 2);
    return {
      name: m.name,
      faces: m.faces,
      x: alongX ? mid : r2(m.edge),
      y: alongX ? r2(m.edge) : mid,
      // Centre of the opening above the PCB's top face, which is the top of a board's body.
      z: r2((m.zLo + m.zHi) / 2),
      w: r2(m.hi - m.lo),
      h: r2(m.zHi - m.zLo),
      shape: "rect",
      margin: PORT_MARGIN_MM,
    };
  });
  return { ports, registration: reg, note: ports.length ? null : "the 3D model was matched to the pads, but it has no connector opening at a board edge" };
}

/** The one logic level the catalog states for the part, when every non-disputed claim agrees. A range, a conflict or a chip-only claim gives nothing. */
function logicFromSpecs(db: Database, partId: string): { value: number; from: string } | null {
  if (!hasTable(db, "specifications")) return null;
  let rows: SpecRow[];
  try {
    rows = all<SpecRow>(
      db,
      `SELECT spec_id, domain, key, value_text, source_id, validation_status, claim_scope, value_num, minimum_num, maximum_num, scope_note
       FROM specifications WHERE part_id = ? ORDER BY spec_id`,
      partId,
    );
  } catch {
    return null;
  }
  const sources = new Map<number, { authority: string; url: string }>();
  if (hasTable(db, "sources")) {
    for (const s of all<{ source_id: number; authority: string; url: string }>(db, `SELECT source_id, authority, url FROM sources`)) sources.set(s.source_id, s);
  }
  const logic = distillSpecs(rows, (id) => sources.get(id)?.authority ?? "").electrical.logic;
  if (!logic || logic.conflict || logic.min_v !== logic.max_v || logic.min_v < 1 || logic.min_v > 6) return null;
  const claim = logic.claims.find((c) => !c.disputed && !c.silicon);
  if (!claim) return null;
  const url = sources.get(claim.src)?.url;
  return { value: logic.min_v, from: `catalog specification "${claim.k}" = "${claim.v}" (${url ? `${url}, ` : ""}source #${claim.src})` };
}

// ---------------------------------------------------------------------------------------
// Module footprints: the outline

/** The pads' bounding box, as a Box, in a y-down frame. */
function envelopeBox(pads: Box, mm: [number, number]): Box | null {
  const pw = pads.maxX - pads.minX;
  const pd = pads.maxY - pads.minY;
  const long = Math.max(mm[0], mm[1]);
  const short = Math.min(mm[0], mm[1]);
  // Nothing says which envelope axis lies along which pad axis: the long one is taken along the longer pad extent.
  const w = pw >= pd ? long : short;
  const d = pw >= pd ? short : long;
  if (w + 0.01 < pw || d + 0.01 < pd) return null;
  const cx = (pads.minX + pads.maxX) / 2;
  const cy = (pads.minY + pads.maxY) / 2;
  return { minX: cx - w / 2, maxX: cx + w / 2, minY: cy - d / 2, maxY: cy + d / 2 };
}

// ---------------------------------------------------------------------------------------

export function importPart(db: Database, root: string, o: ImportOptions): ImportResult {
  const part = one<PartRow>(db, `SELECT part_id, name, brand FROM parts WHERE part_id = ?`, o.partId);
  if (!part) throw new PadsError(`no part with id "${o.partId}". Run: find <text> to get an exact id.`);
  const rows = datasetRows(db, o.partId, o.geometryId);
  if (!rows.length) {
    const files = cachedPinoutFiles(db, root, o.partId);
    throw new PadsError(
      `${o.partId} has no numeric pad data, so there is nothing to import. Nothing is estimated from images.${
        files.length ? ` Cached pinout and drawing files to read:\n${files.map((f) => `  ${f.kind} | ${f.path}${f.exists ? "" : " (MISSING ON DISK)"}`).join("\n")}` : ""
      }`,
    );
  }
  const ds = pickDataset(rows, o.partId, o.geometryId);
  if (!ds) {
    throw new PadsError(
      `${o.partId} has ${rows.length} pad datasets from different CAD files or revisions; they are never merged. Pass --geometry <id>:\n${rows
        .map((d) => `  ${d.geometry_id} | ${d.kind === LAND_KIND ? "module footprint | " : ""}revision ${d.revision ?? "unknown"} | ${d.pad_count ?? 0} pads | ${d.source_url}`)
        .join("\n")}`,
    );
  }
  const isModule = ds.kind === LAND_KIND;
  const frame = readFrame(ds.frame_json, ds.coordinate_frame);
  const { pads: all_, skipped } = loadPads(db, ds.geometry_id);
  // A module footprint holds mounting holes and debug pads too; its candidates are the contact rows only.
  const contacts = isModule ? moduleContactRows(all_) : null;
  const byRef = new Map<string, RawPad[]>();
  if (contacts) for (const r of contacts.rows) byRef.set(r.ref, [...(byRef.get(r.ref) ?? []), ...r.pads]);
  else for (const [k, v] of groupByRef(all_)) byRef.set(k, v);
  const warnings: string[] = [];
  if (skipped) warnings.push(`${skipped} pad(s) in the dataset have no numeric coordinates and were left out`);

  // Which pad groups: the ones named, else the ones the card generator classes as headers.
  const taken: HeaderTaken[] = [];
  let specs: HeaderSpec[];
  if (o.headers) {
    specs = o.headers;
  } else {
    const found = isModule
      ? [...byRef].map(([ref, pads]) => {
          const mine = contacts!.rows.filter((r) => r.ref === ref);
          return { ref, kind: "module_contact_row", basis: [`${mine.length} contact row(s) of ${mine.map((r) => r.pads.length).join(" + ")} pads in a line`, `${[...new Set(mine.map((r) => r.pitch_mm))].join("/")} mm pitch`], n: pads.length };
        })
      : [...byRef]
          .map(([ref, pads]) => ({ ref, c: classifyGroup(ref, pads[0]!.package ?? pads[0]!.footprint_name, pads), n: pads.length }))
          .filter((g) => g.c.cls === "header")
          .map((g) => ({ ref: g.ref, kind: g.c.kind, basis: g.c.basis, n: g.n }))
          // The card generator's order: the larger groups first.
          .sort((a, b) => b.n - a.n || a.ref.localeCompare(b.ref));
    if (!found.length) {
      throw new PadsError(
        isModule
          ? `no contact row (four or more pads in a line on one pitch) in module footprint geometry ${ds.geometry_id} of ${o.partId}, so there is nothing to take by default. Run: pads ${o.partId}, then pass --header with the references to import.`
          : `no pad group in geometry ${ds.geometry_id} of ${o.partId} is classed as a header by the card generator, so there is nothing to take by default. Run: pads ${o.partId}, then pass --header with the references to import.`,
      );
    }
    specs = found.map((f) => ({ reference: f.ref, pads: null }));
    for (const f of found) taken.push({ reference: f.ref, pads: null, from: "default", kind: f.kind, basis: f.basis });
  }

  // Select pads in the order the references were named (or ranked).
  const selected: RawPad[] = [];
  for (const h of specs) {
    const ref = resolveReference(h.reference, [...byRef.keys()]);
    const list = byRef.get(ref)!;
    let take = list;
    if (h.pads) {
      take = list.filter((p) => p.pad_number !== null && h.pads!.includes(p.pad_number));
      const found = new Set(take.map((p) => p.pad_number));
      const absent = h.pads.filter((n) => !found.has(n));
      if (absent.length) throw new PadsError(`${ref} has no pad ${absent.join(", ")}. Its pad numbers: ${list.map((p) => p.pad_number ?? "?").join(" ")}`);
    }
    take = [...take].sort((a, b) => natural(a.pad_number ?? "", b.pad_number ?? ""));
    selected.push(...take);
    if (o.headers) taken.push({ reference: ref, pads: h.pads, from: "--header", kind: null, basis: ["named with --header"] });
  }
  if (!selected.length) throw new PadsError("no pads selected: name at least one reference with --header");

  // Board box: outline from the same CAD file, else the bounding box of every pad. A module footprint
  // has no outline of its own: the catalog's selected envelope, else the bounding box of every pad.
  const outlineRow = isModule ? undefined : outlineRows(db, o.partId).find((r) => sameFile(ds, r));
  const parsed = outlineRow ? parseOutline(outlineRow) : null;
  const allDown = all_.map((p) => pointToYDown({ x: p.x_mm, y: p.y_mm }, frame));
  let box: Box;
  let outlineKind: ImportResult["outline"];
  let thickness: number | null = null;
  let envelope: EnvelopeUse | null = null;
  if (o.outline) {
    // Explicit user input wins over anything in the catalog, and is labelled as such everywhere.
    box = boxToYDown(o.outline, frame);
    outlineKind = "outline supplied on the command line";
    if (outlineRow) warnings.push(`--outline replaces the outline in geometry ${outlineRow!.geometry_id} of the same CAD file`);
  } else if (isModule) {
    const padBox = bboxOf(allDown)!;
    const env = selectedEnvelope(db, o.partId);
    const fitted = env.use ? envelopeBox(padBox, env.use.mm) : null;
    if (env.use && fitted) {
      box = fitted;
      outlineKind = "catalog envelope";
      envelope = env.use;
      thickness = env.use.thickness;
    } else {
      warnings.push(
        env.use
          ? `the catalog's envelope (${env.use.mm.map(n2).join(" x ")} mm, scope ${env.use.scope}) is smaller than the footprint's pad bounding box (${n2(padBox.maxX - padBox.minX)} x ${n2(padBox.maxY - padBox.minY)} mm); not used, the outline is the pad bounding box`
          : `${env.why}; the outline is the bounding box of all pads in the footprint`,
      );
      box = padBox;
      outlineKind = "bounding box of all pads";
    }
  } else if (parsed && (!parsed.frame || parsed.frame.yDir === frame.yDir)) {
    box = boxToYDown(parsed.box, frame);
    outlineKind = "outline dataset";
    thickness = parsed.thicknessMm;
  } else {
    if (parsed) warnings.push(`outline geometry ${outlineRow!.geometry_id} states a different Y direction than the pads; not used`);
    else if (outlineRow) warnings.push(`outline geometry ${outlineRow.geometry_id} carries no bounds; not used`);
    const b = bboxOf(allDown)!;
    box = b;
    outlineKind = "bounding box of all pads";
  }

  const rot = o.rot ?? 0;
  const mirror = o.mirror ?? false;
  const placed = placePoints(selected.map((p) => pointToYDown({ x: p.x_mm, y: p.y_mm }, frame)), box, rot, mirror);

  // Names: pin_definitions (exact connector + number; a module footprint joins by the card generator's rules), then net, then reference.pad.
  const defs = pinDefRows(db, o.partId);
  // The pin-table rows each pad's text is read from, and the name the first of them gives.
  const rowsOf = new Map<RawPad, PinDefRow[]>();
  if (isModule) {
    const padOf = new Map<Pad, RawPad>();
    const groups: PadGroup[] = [...new Set(selected.map((p) => p.reference ?? "module"))].map((ref) => ({
      ref,
      package: null,
      kind: "module_contact_row",
      basis: [],
      mount: "unstated",
      side: null,
      rows: 0,
      pitch_mm: null,
      along: null,
      pads: selected
        .filter((p) => (p.reference ?? "module") === ref)
        .map((p) => {
          const pad: Pad = { n: p.pad_number ?? "", x: p.x_mm, y: p.y_mm };
          padOf.set(pad, p);
          return pad;
        }),
    }));
    joinPinFunctions(groups, defs, "land_pattern", ds.geometry_id, (pad, read) => rowsOf.set(padOf.get(pad)!, read));
  } else {
    for (const p of selected) {
      const row = pinDefRow(defs, p.reference!, p.pad_number, ds.geometry_id);
      if (row) rowsOf.set(p, [row]);
    }
  }
  const used = new Set<string>();
  const unique = (base: string): string => {
    let name = base;
    for (let i = 2; used.has(name); i++) name = `${base}.${i}`;
    used.add(name);
    return name;
  };
  const sources = { pin_definitions: 0, net_name: 0, reference_pad: 0 };
  const renamed = new Set<string>();
  const fromText = { gnd: 0, gpio: 0 };
  const fromNet = { gnd: 0 };
  const powerPins: string[] = [];
  const pins: PinDef[] = selected.map((p, i) => {
    const refPad = `${p.reference ?? "module"}.${p.pad_number ?? "?"}`;
    const read = rowsOf.get(p);
    const fromDef = read && read[0]!.name.trim() !== "" ? read[0]!.name.trim() : null;
    let base: string;
    if (fromDef) {
      base = fromDef;
      sources.pin_definitions++;
    } else if (p.net_name) {
      base = p.net_name;
      sources.net_name++;
    } else {
      base = refPad;
      sources.reference_pad++;
    }
    const name = unique(base);
    if (name !== base) renamed.add(base);
    const pin: PinDef = { name, role: "io", x: placed.points[i]!.x, y: placed.points[i]!.y };
    if (name !== refPad && !used.has(refPad)) {
      used.add(refPad);
      pin.aliases = [refPad];
    }
    // Roles and GPIO numbers come from the published pin row. The one thing taken from a
    // net label is ground, and only for a pad with no published row to say otherwise: a
    // pad the board's own CAD ties to a net named GND is ground. A net label never gives a GPIO number.
    const facts = read ? pinFacts(read) : null;
    if (facts?.gnd) {
      pin.role = "gnd";
      pin.importedFrom = { role: facts.gnd };
      fromText.gnd++;
    } else if (!read && p.net_name && GROUND_NAME.test(p.net_name.trim())) {
      pin.role = "gnd";
      pin.importedFrom = { role: `CAD net name "${p.net_name.trim()}" on pad ${refPad} (no published pin row)` };
      fromNet.gnd++;
    } else if (facts?.gpio) {
      pin.gpio = facts.gpio.n;
      pin.importedFrom = { gpio: facts.gpio.from };
      fromText.gpio++;
    }
    // A supply pin by its source type or its name: the catalog does not say input or output, nor the volts.
    if (!facts?.gnd && (facts?.power || POWER_NAME.test(base))) powerPins.push(name);
    return pin;
  });

  if (renamed.size) warnings.push(`pin names must be unique, so repeats got a .2, .3 suffix: ${[...renamed].slice(0, 6).join(", ")}${renamed.size > 6 ? ", ..." : ""}`);
  const ambiguous = selected.filter((p) => rowsOf.get(p) && pinFacts(rowsOf.get(p)!).gpioCandidates.length > 1);
  if (ambiguous.length) {
    warnings.push(`${ambiguous.length} pin(s) name more than one GPIO number in their published text, so none was set: ${pins.filter((_, i) => ambiguous.includes(selected[i]!)).slice(0, 6).map((q) => q.name).join(", ")}${ambiguous.length > 6 ? ", ..." : ""}`);
  }

  // Likely twin pads (castellated edge pad next to a through-hole pad on the same net).
  for (const ref of new Set(selected.map((p) => p.reference ?? "module"))) {
    const mine = selected.filter((p) => (p.reference ?? "module") === ref);
    const twins = new Set<string>();
    for (let i = 0; i < mine.length; i++) {
      for (let j = i + 1; j < mine.length; j++) {
        const a = mine[i]!;
        const b = mine[j]!;
        if (a.net_name && a.net_name === b.net_name && Math.hypot(a.x_mm - b.x_mm, a.y_mm - b.y_mm) < 2) twins.add(a.net_name);
      }
    }
    if (twins.size) warnings.push(`${ref}: ${twins.size} net(s) (${[...twins].slice(0, 3).join(", ")}${twins.size > 3 ? ", ..." : ""}) appear on two pads less than 2 mm apart; likely twin pads (edge plus inner), so the imported pin count may be double. Restrict with --header ${ref}:<pads>, e.g. ${ref}:1-7`);
    const nums = mine.map((p) => p.pad_number).filter((n): n is string => n !== null);
    if (new Set(nums).size !== nums.length) warnings.push(`${ref}: pad numbers repeat; pad number is not a unique key in this dataset`);
  }

  const outside = placed.points.filter((p) => p.x < 0 || p.y < 0 || p.x > placed.w || p.y > placed.d).length;
  if (outside) warnings.push(`${outside} pad(s) lie outside the ${outlineKind}`);

  const logic = logicFromSpecs(db, o.partId);

  // Heights from the maker's 3D model, where the catalog has one. A thickness stated with the
  // outline wins over the model's; the model's stands in when the outline states none.
  const model = modelHeights(db, o.partId);
  if (model.why) warnings.push(model.why);
  const mh = model.use;
  const modelThickness = thickness === null && mh?.thickness != null ? Number(mh.thickness.toFixed(2)) : null;
  const bodyH = thickness ?? modelThickness ?? 1.6;
  // maxHeight is measured from the underside of the PCB, which is what the case layout stands on its posts.
  const maxH = mh ? Number((bodyH + mh.above).toFixed(2)) : bodyH;
  const modelFrom = mh ? `catalog 3D-model geometry ${mh.geometryId} (${mh.status}${mh.sourceUrl ? `; ${mh.sourceUrl}` : ""})` : "";
  const modelFields: { field: string; value: number; from: string }[] = [];
  if (mh) modelFields.push({ field: "maxHeight", value: maxH, from: `${n2(bodyH)} mm PCB + ${n2(mh.above)} mm tallest modelled point above it, ${modelFrom}` });
  if (modelThickness !== null) modelFields.push({ field: "body.h", value: modelThickness, from: `PCB thickness in ${modelFrom}` });
  if (mh && mh.below > 0.2) {
    warnings.push(`the 3D model has parts reaching ${n2(mh.below)} mm below the PCB: the part file has no field for that, so give the board posts at least that tall, or it will not sit flat`);
  }
  // Connector openings from the same model, as ports. They need the model matched to this pad
  // dataset, which in turn needs pads and outline read from one CAD file.
  let modelPorts: ModelPorts | null = null;
  if (mh) {
    if (isModule) modelPorts = { ports: [], registration: null, note: "the pads are a module footprint in its own frame, not a placed board" };
    else if (outlineKind !== "outline dataset" || !parsed) modelPorts = { ports: [], registration: null, note: "there is no board outline from the same CAD file as the pads to match the 3D model against" };
    else if (parsed.shape === "drawing_callouts" || all_.some((p) => p.pad_type === "header_center_anchor")) {
      modelPorts = { ports: [], registration: null, note: "the pad positions were calculated from a drawing; only pads read from a CAD file are matched to the 3D model" };
    } else modelPorts = portsFromModel({ board: mh.board, pads: all_, frame, outline: parsed.box, yDownBox: box, rot, mirror });
    if (!modelPorts.ports.length && modelPorts.note) warnings.push(`no connector openings imported from the 3D model: ${modelPorts.note}`);
  }
  const ports = modelPorts?.ports ?? [];
  const portReg = ports.length ? modelPorts!.registration : null;
  const placeholders: string[] = [];
  if (thickness === null && modelThickness === null) placeholders.push(`body.h = ${bodyH} (PCB thickness is not in the dataset; placeholder)`);
  if (!mh) placeholders.push(`maxHeight = ${bodyH} (heights are not in the catalog; placeholder equal to body.h)`);

  const sourceLines = [`${ds.source_url} (maker catalog geometry ${ds.geometry_id}, revision ${ds.revision ?? "unknown"}; source_sha256 ${ds.source_sha256 ?? "not recorded"})`];
  if (outlineKind === "outline dataset" && outlineRow && outlineRow.source_url !== ds.source_url) {
    sourceLines.push(`${outlineRow.source_url} (outline, maker catalog geometry ${outlineRow.geometry_id}; source_sha256 ${outlineRow.source_sha256 ?? "not recorded"})`);
  }
  if (envelope) {
    sourceLines.push(
      `${envelope.source_url ?? `maker catalog source #${envelope.source_id}`} (outline from the catalog's selected envelope, scope ${envelope.scope}, source #${envelope.source_id}${envelope.variant_sku ? `, variant ${envelope.variant_sku}` : ""}; source content sha256 ${envelope.source_sha256 ?? "not recorded"})`,
    );
  }

  const fileLabel = `${ds.source_url}, revision ${ds.revision ?? "unknown"}, source_sha256 ${ds.source_sha256 ?? "not recorded"}; catalog validation status: ${ds.validation_status}`;
  const outlineSentence =
    outlineKind === "outline supplied on the command line"
      ? `The board outline was SUPPLIED ON THE COMMAND LINE (--outline ${[o.outline!.minX, o.outline!.minY, o.outline!.maxX, o.outline!.maxY].join(",")} in the CAD frame), NOT read from the CAD file: it is only as right as the person who typed it, and a wrong outline shifts every pad. Check it against the board.`
      : outlineKind === "catalog envelope"
      ? `The outline is the catalog's selected envelope (${envelope!.mm.map(n2).join(" x ")} mm, scope ${envelope!.scope}, source #${envelope!.source_id}${envelope!.variant_sku ? `, for variant ${envelope!.variant_sku}` : ""}), NOT a CAD outline: the footprint has none. Nothing says where the pads sit inside it or which way round it lies, so the long side is taken along the longer pad extent and the pads are CENTRED in it. That is an assumption. Measure the module and move the pads.`
      : outlineKind === "outline dataset"
      ? parsed!.shape === "drawing_callouts"
        ? `Board size is the PCB extent from the dimension callouts of the same drawing (geometry ${outlineRow!.geometry_id}, ${parsed!.scope ?? "scope unknown"}); corner radii, antenna and connector projections are not included.`
        : `Board size is the bounds of the outline geometry in the same file (geometry ${outlineRow!.geometry_id}, centre lines, ${parsed!.scope ?? "scope unknown"}; the catalog does not guarantee it is the outer edge).`
      : isModule
      ? `The module size is the bounding box of ALL ${all_.length} pads in the footprint, not the module edge (the catalog has no usable envelope for it): the real module is larger, and the origin is the top-left pad centre extreme. Measure the module and move the pads.`
      : `The board size is the bounding box of ALL ${all_.length} pads in the dataset, not the board edge: the real board is larger, and the origin is the top-left pad centre extreme, not the board corner. Measure the board and move the pads.`;
  const headerList = taken.map((h) => h.reference + (h.pads ? ":" + h.pads.join(";") : "")).join(", ");
  const verify = [
    isModule
      ? `Pad positions are the LAND PATTERN of the module (the footprint that mounts it on a carrier PCB, footprint-local frame; ${fileLabel}), not coordinates measured on the module or on a bought board.`
      : `Pad positions${outlineKind === "outline supplied on the command line" ? "" : " and board outline"} are parsed from the maker's CAD file (${fileLabel}), not measured on a bought board.`,
    outlineSentence,
    `Frame: ${isModule ? "footprint-local frame" : "CAD frame"} X right, Y ${frame.yDir} converted to origin at the top-left of the ${outlineKind} seen from above, x right, y down; rotation ${rot} degrees clockwise${mirror ? ", mirrored left-right" : ""}. Check that the USB connector is at y = 0 and the pins match the silkscreen before relying on it.`,
    `Only ${pins.length} of ${all_.length} pads were imported (${headerList}${taken.some((h) => h.from === "default") ? `; these ${isModule ? "contact rows" : "pad groups"} were taken by default, as the card generator's classification (the import report gives the basis of each), and --header overrides them` : ""}).`,
    `${ports.length ? "Shapes and electrical values" : mh ? "Shapes, ports and electrical values" : "Heights, shapes, ports and electrical values"} are not in the catalog. Roles: only gnd is set, on pins whose published name or source type says ground, or whose pad has no published row and sits on a CAD net named GND (importedFrom on the pin says which); every other pin is "io", supply pins included, because the catalog does not say input or output or the volts. gpio is set only where the published pin text names exactly one GPIOn (or GPn, IOn); a pad number is not a GPIO number, so every other pin has none. Fill roles, voltages, gpio and caps in by hand from the pinout, and set ${[...(thickness === null && modelThickness === null ? ["body.h"] : []), ...(mh ? [] : ["maxHeight"]), ...(logic ? [] : ["electrical.logicVolts"]), "sourcing.priceUsd"].join(", ")}${placeholders.length ? ` (placeholders: ${placeholders.join("; ")})` : ""}.`,
    ...(mh
      ? [
          `maxHeight ${n2(maxH)} mm is the ${n2(bodyH)} mm PCB plus the tallest point of the maker's 3D model (${n2(mh.above)} mm above the PCB, ${modelFrom}). It is a nominal model figure, not a measurement, and counts only what is modelled: headers that ship loose or anything fitted later are not in it. Measure the part you have before printing a case.${mh.below > 0.2 ? ` The model also has parts ${n2(mh.below)} mm below the PCB.` : ""}`,
        ]
      : []),
    ...(portReg
      ? [
          `The ${ports.length} port(s) (${ports.map((p) => p.name).join(", ")}) are connector openings of the same 3D model, placed by matching the model to these pads (${portReg.feature_count} connector(s) named alike in both, residual ${n2(portReg.residual_mm)} mm${portReg.side_evidence ? `, board side agreeing for ${portReg.side_evidence}` : ""}). Each is the hole in the connector, not the plug: the ${PORT_MARGIN_MM} mm margin is a default, not a catalog figure. Check which wall each is on against the board, and that your plug fits, before printing a case. Buttons, LEDs and anything that faces up are not in it.`,
        ]
      : []),
  ].join(" ");

  const def: PartDef = {
    id: o.id,
    name: part.name,
    kind: "board",
    blurb: isModule
      ? `Draft from the land pattern of ${part.name}: contact positions only, everything else still to fill in.`
      : `Draft from the maker's CAD pads for ${part.name}: pad positions only, everything else still to fill in.`,
    body: { w: placed.w, d: placed.d, h: bodyH },
    maxHeight: maxH,
    pins,
    electrical: logic ? { logicVolts: logic.value } : {},
    sourcing: { search: [part.name], priceUsd: 0 },
    verify,
    sources: sourceLines,
    confidence: "typical",
  };
  if (ports.length) def.ports = ports;
  if (isModule) {
    // A footprint is where the module mounts, not the module: never emit this as resolved.
    def.geometryEvidence = {
      status: "unresolved",
      reason: `Pads are the module's land pattern (the footprint that mounts it on a carrier, geometry ${ds.geometry_id}, footprint-local frame with no outline), not coordinates measured on the module${
        outlineKind === "catalog envelope"
          ? `; the outline is the catalog's selected envelope, not a CAD outline`
          : outlineKind === "outline supplied on the command line"
          ? `; the outline was supplied on the command line`
          : `; the outline is the bounding box of the pads because the catalog has no usable envelope`
      }.`,
      unknown: [
        outlineKind === "bounding box of all pads" ? "the module outline (the catalog has none; the pad bounding box stands in)" : "where the pads sit within the module outline (the pads are centred in it as an assumption)",
        ...(outlineKind === "catalog envelope" ? ["which way round the outline lies against the pads (the long side is taken along the longer pad extent)"] : []),
        mh ? "the height of the tallest component as built (maxHeight is a nominal 3D-model figure, not a measurement)" : "body height and the height of the tallest component (not stated by the catalog)",
        ...(thickness === null && modelThickness === null ? ["PCB thickness (body.h is a placeholder)"] : []),
      ],
    };
  }
  const provenance: ImportProvenance = {
    catalogPart: o.partId,
    geometry: { pads: ds.geometry_id, padsKind: isModule ? LAND_KIND : PAD_KIND, outline: outlineKind === "outline dataset" ? outlineRow!.geometry_id : null },
    outlineFrom: outlineKind,
    sourceSha256: { pads: ds.source_sha256, outline: outlineKind === "outline dataset" ? outlineRow!.source_sha256 : outlineKind === "catalog envelope" ? envelope!.source_sha256 : null },
    geometrySha256: geometrySha256(def),
    ...(logic || modelFields.length ? { fields: [...(logic ? [{ field: "electrical.logicVolts", value: logic.value, from: logic.from }] : []), ...modelFields] } : {}),
    ...(portReg && mh
      ? {
          ports: {
            modelGeometry: mh.geometryId,
            count: ports.length,
            rotationDeg: portReg.transform.rotation_deg,
            reflected: portReg.transform.reflected,
            features: portReg.feature_count,
            sideEvidence: portReg.side_evidence,
            residualMm: portReg.residual_mm,
            marginMm: PORT_MARGIN_MM,
          },
        }
      : {}),
  };
  def.imported = provenance;

  return {
    part: def,
    geometry_id: ds.geometry_id,
    dataset_kind: isModule ? "module footprint" : "board",
    revision: ds.revision,
    frame: `X right, Y ${frame.yDir}`,
    outline: outlineKind,
    outline_geometry_id: outlineKind === "outline dataset" ? outlineRow!.geometry_id : null,
    dataset_pads: all_.length,
    imported_pads: pins.length,
    headers: taken,
    rot,
    mirror,
    name_sources: sources,
    from_pin_text: fromText,
    from_net_name: fromNet,
    power_pins: powerPins,
    logic_volts: logic,
    model_height: mh ? { max_height: maxH, above_pcb: Number(mh.above.toFixed(2)), below_pcb: Number(mh.below.toFixed(2)), pcb_thickness: modelThickness, geometry_id: mh.geometryId } : null,
    model_ports: portReg
      ? { names: ports.map((p) => `${p.name} on ${p.faces}`), features: portReg.feature_count, side_evidence: portReg.side_evidence, residual_mm: portReg.residual_mm, rotation_deg: portReg.transform.rotation_deg, reflected: portReg.transform.reflected }
      : null,
    warnings,
    missing: missingFields(def, thickness !== null || modelThickness !== null, o.fileName, powerPins, mh !== null),
  };
}

/**
 * What check-parts.ts (or the type) needs that an import cannot know. Mirrors only the rules
 * a draft is expected to trip; the authoritative run is `bun check-parts.ts`.
 */
export function missingFields(def: PartDef, hasThickness: boolean, fileName?: string, powerPins: string[] = [], hasModelHeight = false): string[] {
  const m: string[] = [];
  const notGround = def.pins.filter((p) => p.role !== "gnd");
  if (!def.pins.some((p) => p.role === "gnd")) m.push("a pin with role gnd (no imported pin is named or typed as ground in the published pin text; set roles from the pinout)");
  if (!def.pins.some((p) => typeof p.gpio === "number")) m.push("gpio numbers on the io pins (pad numbers are not GPIO numbers)");
  else {
    const without = notGround.filter((p) => typeof p.gpio !== "number").map((p) => p.name);
    if (without.length) {
      m.push(`gpio numbers on ${without.length} of ${notGround.length} non-ground pins (${without.slice(0, 10).join(", ")}${without.length > 10 ? ", ..." : ""}): the published text names exactly one GPIOn only where it is unambiguous; set the rest from the pinout`);
    }
  }
  if (typeof def.electrical?.logicVolts !== "number") m.push("electrical.logicVolts");
  if (!(def.sourcing?.priceUsd > 0)) m.push("sourcing.priceUsd (currently 0)");
  if (!hasThickness) m.push(`body.h (placeholder ${def.body.h}; PCB thickness)`);
  // A model height is set, not missing; the report says separately that it is nominal.
  if (!hasModelHeight) m.push(`maxHeight (placeholder ${def.maxHeight}; tallest point incl. headers)`);
  if (powerPins.length) m.push(`power pins that need role, volts and direction: ${powerPins.join(", ")} (the catalog cannot tell an output from an input, and states no volts)`);
  m.push("role, volts, minVolts, maxVolts, dir, needs and caps on every pin that needs them");
  if (fileName !== undefined && fileName !== `${def.id}.json`) m.push(`file name must be ${def.id}.json (check-parts requires id = file name; got ${fileName})`);
  return m;
}

export function formatImport(r: ImportResult, outFile: string): string {
  const L: string[] = [];
  L.push(`wrote ${outFile}`);
  L.push(`part ${r.part.id} from geometry ${r.geometry_id}${r.dataset_kind === "module footprint" ? " (module footprint)" : ""} (revision ${r.revision ?? "unknown"}) | frame ${r.frame} -> part frame | rot ${r.rot}${r.mirror ? " | mirrored" : ""}`);
  L.push(
    `${r.dataset_kind === "module footprint" ? "pad groups" : "headers"} taken: ${r.headers
      .map((h) => `${h.reference}${h.pads ? `:${h.pads.join(";")}` : ""} (${h.from === "default" ? `default; ${h.kind}; ${h.basis.join("; ")}` : "--header"})`)
      .join(", ")}`,
  );
  L.push(`${r.imported_pads} of ${r.dataset_pads} pads imported | pin names from: pin_definitions ${r.name_sources.pin_definitions}, net ${r.name_sources.net_name}, reference.pad ${r.name_sources.reference_pad}`);
  L.push(
    r.outline === "outline supplied on the command line"
      ? `board ${n2(r.part.body.w)} x ${n2(r.part.body.d)} mm from the --outline you supplied on the command line, NOT read from the CAD file; a wrong outline shifts every pad`
      : r.outline === "outline dataset"
      ? `board ${n2(r.part.body.w)} x ${n2(r.part.body.d)} mm from outline geometry ${r.outline_geometry_id}`
      : r.outline === "catalog envelope"
      ? `module ${n2(r.part.body.w)} x ${n2(r.part.body.d)} mm from the catalog's selected envelope, NOT a CAD outline; the pads are centred in it as an assumption`
      : r.dataset_kind === "module footprint"
      ? `module ${n2(r.part.body.w)} x ${n2(r.part.body.d)} mm is the BOUNDING BOX OF ALL PADS in the footprint, not the module edge (no usable catalog envelope)`
      : `board ${n2(r.part.body.w)} x ${n2(r.part.body.d)} mm is the BOUNDING BOX OF ALL PADS in the dataset, not the board edge (no outline dataset from the same CAD file)`,
  );
  L.push(`from the published pin text: ${r.from_pin_text.gnd} gnd role(s), ${r.from_pin_text.gpio} gpio number(s)${r.from_net_name.gnd ? `; from CAD net names: ${r.from_net_name.gnd} gnd role(s)` : ""}; each is recorded on the pin as importedFrom${r.logic_volts ? ` | electrical.logicVolts ${r.logic_volts.value} from ${r.logic_volts.from}` : ""}`);
  if (r.model_height) {
    L.push(
      `maxHeight ${r.model_height.max_height} mm from the maker's 3D model (geometry ${r.model_height.geometry_id}: ${r.model_height.above_pcb} mm above the PCB${r.model_height.pcb_thickness !== null ? `, PCB ${r.model_height.pcb_thickness} mm` : ""}): nominal, not measured, and only what is modelled; measure before printing a case`,
    );
  }
  if (r.model_ports) {
    L.push(
      `${r.model_ports.names.length} port(s) from the 3D model's connector openings: ${r.model_ports.names.join("; ")} | matched to these pads on ${r.model_ports.features} connector(s), residual ${r.model_ports.residual_mm} mm${r.model_ports.side_evidence ? `, board side agreeing for ${r.model_ports.side_evidence}` : ""} | ${PORT_MARGIN_MM} mm margin is a default; check each wall against the board`,
    );
  }
  if (r.part.geometryEvidence) L.push(`geometryEvidence: ${r.part.geometryEvidence.status}: ${r.part.geometryEvidence.reason} Not known: ${r.part.geometryEvidence.unknown.join("; ")}`);
  if (r.warnings.length) {
    L.push("warnings:");
    for (const w of r.warnings) L.push(`  - ${w}`);
  }
  L.push("not derived, fill in by hand (check-parts fails until the required ones are set):");
  for (const x of r.missing) L.push(`  - ${x}`);
  return L.join("\n");
}
