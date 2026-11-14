#!/usr/bin/env bun
// Part cards: one pre-joined reference document per catalog part.
//
// The maker catalog spreads a part over about fifteen tables. A card gathers what a project
// needs to place, wire and buy that part: the selected outline with its scope, the headers
// and connectors with pad coordinates, pin functions, the electrical essentials, caveats,
// reference files and listings, and an explicit list of what the catalog does not know.
//
// A card adds no facts. Every value comes from a catalog row and carries its source id.
// Three things are interpretation, and each is labelled as such in the card:
//   - which pad groups are headers, connectors or mounting holes ("basis" on each group)
//   - which pad carries which published pin function ("basis" on each joined function)
//   - voltage, current and address values parsed out of free-text spec claims
//
// Usage:
//   bun catalog-cards.ts build --src <maker_catalog.sqlite> --out <maker_cards.sqlite>
//   bun catalog-cards.ts show <part_id> [--json] [--db <maker_cards.sqlite>]
//   bun catalog-cards.ts find <text> [--fits W D H] [--include-pcb] [--norway] [--pads] [--limit N] [--json] [--db ...]
//   bun catalog-cards.ts stats [--db ...]
// --src defaults to $BENCHTOP_CATALOG, --db to $BENCHTOP_CARDS. The catalog is opened read-only.
// Exit codes: 0 ok, 1 not found, 2 usage error, 3 source or cards file missing or wrong version.

import { Database } from "bun:sqlite";
import { createHash } from "node:crypto";
import { existsSync, readFileSync, renameSync, rmSync, statSync } from "node:fs";
import { resolve } from "node:path";
import { registerModel, type ModelConnector, type Registration } from "./lib/model-frame";

export const CARD_SCHEMA_VERSION = 1;
export const CATALOG_SCHEMA_VERSION = 2;

type Cell = string | number | null;
type Row = Record<string, Cell>;

// ---------------------------------------------------------------------------------------
// Card shape

export interface SourceRef {
  url: string;
  publisher: string;
  authority: string;
  retrieved: string;
}

export interface Outline {
  /** Values in the source's own order. The third is null when the source gave two. */
  mm: [number, number, number | null];
  /** Axis names as the source labelled them, or null when it did not. */
  axes: string[] | null;
  scope: string;
  scope_meaning: string;
  /** True only when a third value exists and it is a product height, not a PCB thickness. */
  height_known: boolean;
  pcb_thickness_mm: number | null;
  status: string;
  variant_required: boolean;
  variant_sku: string | null;
  evidence: string;
  src: number;
}

export interface Observation {
  kind: string;
  scope: string;
  mm: number[];
  axes: string[] | null;
  status: string;
  evidence: string;
  src: number;
  /** Same scope as the selected outline but different numbers. */
  differs_from_selected?: true;
}

export interface PinFunction {
  name: string;
  functions: string;
  type: string | null;
  /**
   * catalog_geometry_binding: the catalog published this pin row for this exact geometry dataset.
   * The other three are this generator's own rules, used only for rows the catalog did not bind.
   */
  basis: "catalog_geometry_binding" | "connector_and_pin_number" | "net_name_equals_pin_name" | "module_pin_number";
  src: number;
  /** Set when `functions` was taken from the module's separate pin table because the bound row only repeats the pin name. */
  functions_from?: { connector: string; src: number };
}

export interface Pad {
  /** Pad number as the CAD file names it. Not a GPIO number. */
  n: string;
  x: number;
  y: number;
  /** Offset from the CAD outline's minimum corner, when an outline from the same file exists. */
  rx?: number;
  ry?: number;
  /** Net name in the CAD file. A label, not a verified function. */
  net?: string;
  fn?: PinFunction;
}

export type GroupClass = "header" | "connector" | "mounting_hole" | "test_point" | "component";

export interface PadGroup {
  ref: string;
  package: string | null;
  kind: string;
  /** Why this group was classified as it was. */
  basis: string[];
  /** "unstated" when the source gives a pad position without saying how the pad is made, as a drawing does. */
  mount: "through_hole" | "smd" | "mixed" | "unstated";
  side: string | null;
  rows: number;
  /** Centre-to-centre spacing along a row, when uniform. */
  pitch_mm: number | null;
  /** Axis the rows run along, in the frame's coordinates. */
  along: "x" | "y" | null;
  pads: Pad[];
}

export interface Hole {
  x: number;
  y: number;
  rx?: number;
  ry?: number;
  drill_mm: number | null;
  /** True when the CAD package is named as a mounting hole. False for a hole the file draws without saying what it is for: it may locate a connector. */
  mounting: boolean;
  basis: string;
}

export interface Board {
  geometry_id: number;
  /** "board": pads placed on this part's own PCB. "land_pattern": the footprint used to mount this module on a carrier, in footprint-local coordinates. */
  scope: "board" | "land_pattern";
  format: string | null;
  source_file: string | null;
  source_url: string;
  sha256: string | null;
  native_path: string | null;
  revision: string | null;
  status: string;
  frame: { units: string; x: string; y: string; origin: string; view: string };
  /** native_cad: positions read from a board or footprint file. drawing_callouts: positions calculated from the dimension callouts of a published drawing. */
  derivation: "native_cad" | "drawing_callouts";
  complete: boolean;
  skipped_pads: number;
  pad_count: number;
  pad_bounds: { min: [number, number]; max: [number, number] };
  outline: { min: [number, number]; max: [number, number]; extent: [number, number]; geometry_id: number; same_file: boolean; status: string } | null;
  headers: PadGroup[];
  connectors: PadGroup[];
  holes: Hole[];
  /** Pad groups left out of the card: ICs, passives, test points. */
  excluded: { components: number; test_points: number; pads: number };
  /** Other datasets for this part. Never merged with this one. */
  other_datasets: { geometry_id: number; kind: string; revision: string | null; source_file: string | null; pads: number }[];
  src: number;
}

/** An opening in a connector, as an inner wire of the 3D model's connector body. A candidate: the model does not say what mates with it. */
export interface ModelOpening {
  connector: string;
  /** Board edge the opening faces, in the model's own frame (x_min, x_max, y_min, y_max). */
  edge: string;
  /** Centre along that edge, from the minimum PCB bound on the edge's axis. */
  center_along_edge_mm: number;
  width_mm: number;
  height_mm: number;
  lower_above_pcb_mm: number;
  upper_above_pcb_mm: number;
  /** How far the opening sits beyond the board outline; 0 when it is flush or set back. */
  overhang_mm: number;
}

/**
 * Heights and connector openings read from a published 3D model of the board. Nominal model
 * geometry, never a measurement, and never a replacement for the selected outline: the model's
 * frame is not registered to the pad coordinates, and parts absent from the model are not counted.
 */
export interface ModelHeights {
  geometry_id: number;
  path: string | null;
  coordinate_scope: string;
  above_pcb_mm: number | null;
  below_pcb_mm: number | null;
  pcb_thickness_mm: number | null;
  status: string;
  covers: string;
  openings: ModelOpening[];
  /** Connectors in the model for which no opening could be identified. */
  connectors_without_opening: string[];
  other_models: number;
  /**
   * How this model's frame maps onto the pad coordinates of the board dataset shown on the card,
   * with each opening placed on the board outline in pad-frame coordinates. Null when no unique
   * mapping was found; `registration_note` then says why. Valid only for the three geometry ids named.
   */
  registration: (Registration & { pad_geometry_id: number; outline_geometry_id: number; model_geometry_id: number }) | null;
  registration_note: string | null;
  src: number;
}

/**
 * Another catalog record for the same marketed product. Nothing is inherited through it: the
 * catalog verified the product identity, not that both records describe the same hardware revision.
 */
export interface SeeAlso {
  part_id: string;
  relation: "marketed_revision_reference" | "same_sku";
  identity_status: string;
  /** The other record holds pad or outline geometry worth consulting. */
  holds_geometry: boolean;
}

export interface PinGroupOut {
  connector: string;
  revision: string | null;
  pins: { n: string; name: string; type: string | null; functions: string; src: number }[];
}

export interface Claim {
  /** Spec key as the source table had it. */
  k: string;
  /** The claim text, clipped. */
  v: string;
  src: number;
  /** How many spec rows said the same. */
  n: number;
  disputed?: true;
  /** The catalog marked this as its selected claim for the field. */
  selected?: true;
  /** Lowest and highest voltage, from the catalog's numeric fields when it filled them. */
  range?: [number, number];
  /** A selected I2C address the catalog normalised to a 7-bit number. */
  address?: string;
  /** Chip capability, not established for this board. */
  silicon?: true;
  from_feature_text?: true;
}

export interface VoltageSummary {
  min_v: number;
  max_v: number;
  /** Claims whose voltage ranges do not overlap. */
  conflict: boolean;
  /** True when min_v and max_v come from claims the catalog selected; false when they span every readable claim. */
  selected: boolean;
  claims: Claim[];
}

export interface Electrical {
  /** The voltage the part runs at. */
  operating: VoltageSummary | null;
  /** What the part accepts on its supply pin or jack, when the source states that separately. */
  input: VoltageSummary | null;
  logic: VoltageSummary | null;
  output: VoltageSummary | null;
  current: Claim[];
  i2c_addresses: string[];
  /** True when the addresses are the catalog's selected, encoding-reviewed ones. When true and the list is empty, read i2c_claims: the catalog selected a claim it could not reduce to one number. */
  i2c_selected: boolean;
  i2c_claims: Claim[];
  interfaces: string[];
}

export interface Reference {
  kind: string;
  title: string | null;
  url: string;
  /** Path relative to the catalog folder, when the file is cached there. */
  path: string | null;
  sha256: string | null;
  type: string | null;
  bytes: number | null;
  revision: string | null;
  note: string | null;
  derived?: string;
}

export interface Listing {
  supplier: string;
  market: string | null;
  price: number | null;
  currency: string | null;
  basis: string;
  stock: string;
  observed: string;
  url: string;
  sku: string | null;
  variant: string | null;
  match: string;
  src: number;
}

export interface Missing {
  code: string;
  detail: string;
}

export interface Card {
  v: number;
  part_id: string;
  name: string;
  brand: string | null;
  mpn: string | null;
  category: string;
  rank: number;
  url: string;
  description: string | null;
  identity: { scope: string; variants: number; variant_choice_required: boolean; families: string[]; geometry_status: string };
  outline: Outline | null;
  outline_observations: Observation[];
  dimensions: Observation[];
  board: Board | null;
  model: ModelHeights | null;
  pins: PinGroupOut[];
  electrical: Electrical;
  specs: Record<string, Claim[]>;
  see_also: SeeAlso[];
  caveats: { severity: string; code: string; text: string; src: number | null }[];
  caveats_omitted: number;
  references: Reference[];
  reference_counts: Record<string, number>;
  buy: Listing[];
  buy_counts: { norway: number; international: number; family_level_marketplace: number };
  missing: Missing[];
  /** Completeness of the card, 0 to 100. It says how much the catalog has, not how accurate it is. */
  score: number;
  sources: Record<string, SourceRef>;
}

// ---------------------------------------------------------------------------------------
// Text parsing. All of it is conservative: when a value is not plainly there, return nothing.

const clip = (s: string, n: number): string => {
  const t = s.replace(/\s+/g, " ").trim();
  return t.length > n ? `${t.slice(0, n - 1)}…` : t;
};
const round = (n: number, d = 3): number => Number(n.toFixed(d));
const uniq = <T>(xs: T[]): T[] => [...new Set(xs)];

/** Decimal commas between digits ("3,3 V") become points; list commas ("3.3V, 5V") stay. */
const decimalPoints = (s: string): string => s.replace(/(\d),(\d)(?!\d{2})/g, "$1.$2");

/**
 * Voltages stated in a text, ascending. Ranges give both ends; tolerances ("± 0.3V") are ignored.
 * "3,3–5 V DC" -> [3.3, 5]; "3V3" -> [3.3]; "5V @ 500mA" -> [5]; "200 mV" -> [].
 */
export function parseVolts(text: string): number[] {
  let t = decimalPoints(text).replace(/[±]\s*\d+(?:\.\d+)?\s*(?:%|m?V)?/g, " ");
  t = t.replace(/\b(\d)V(\d)\b/g, "$1.$2 V");
  const out: number[] = [];
  const range = /(\d+(?:\.\d+)?)\s*V?(?:DC|AC)?\s*(?:-|–|—|~|to|til)\s*(\d+(?:\.\d+)?)\s*V(?:DC|AC)?(?![a-zA-Z])/gi;
  t = t.replace(range, (_m, a: string, b: string) => {
    out.push(Number(a), Number(b));
    return " ";
  });
  for (const m of t.matchAll(/(?<![\d.])(\d+(?:\.\d+)?)\s*V(?:DC|AC)?(?![a-zA-Z])/g)) out.push(Number(m[1]));
  return uniq(out.filter((v) => v > 0 && v <= 60)).sort((a, b) => a - b);
}

/** Currents stated in a text, in milliamps. "65mA (Typical)" -> [65]; "2 A" -> [2000]; "200μA" -> [0.2]. */
export function parseMilliamps(text: string): number[] {
  const out: number[] = [];
  for (const m of decimalPoints(text).matchAll(/(?<![\d.])(\d+(?:\.\d+)?)\s*(µA|μA|uA|mA|A)(?![a-zA-Z])/g)) {
    const n = Number(m[1]);
    const unit = m[2]!;
    out.push(round(unit === "A" ? n * 1000 : unit === "mA" ? n : n / 1000, 4));
  }
  return uniq(out).sort((a, b) => a - b);
}

/** 7-bit I2C addresses written as hex. "0x47 (Default) / 0x46" -> ["0x47", "0x46"]. */
export function parseI2cAddresses(text: string): string[] {
  const out: string[] = [];
  for (const m of text.matchAll(/0x([0-9a-fA-F]{2})\b/g)) {
    if (parseInt(m[1]!, 16) <= 0x7f) out.push(`0x${m[1]!.toUpperCase()}`);
  }
  return uniq(out);
}

const INTERFACE_TOKENS: [string, RegExp][] = [
  ["I2C", /\bI2C\b|\bIIC\b|I²C|\bTWI\b|qwiic|stemma\s*qt/i],
  ["SPI", /\bQ?SPI\b/i],
  ["UART", /\bUART\b|\bUSART\b/i],
  ["USB", /\bUSB\b/i],
  ["I2S", /\bI2S\b/i],
  ["CAN", /\bCAN\b(?!\s+(be|use|also|not))|CAN\s*bus/],
  ["1-Wire", /\b1-?wire\b|\bone-?wire\b/i],
  ["RS-485", /\bRS-?485\b/i],
  ["RS-232", /\bRS-?232\b/i],
  ["PWM", /\bPWM\b/i],
  ["analog", /\banalog(ue)?\b|\bADC\b/i],
  ["SDIO", /\bSDIO\b/i],
  ["Ethernet", /\bethernet\b/i],
  ["Wi-Fi", /\bwi-?fi\b|802\.11/i],
  ["Bluetooth", /\bbluetooth\b|\bBLE\b/i],
  ["LoRa", /\bLoRa(WAN)?\b/],
  ["Zigbee", /\bzigbee\b/i],
  ["Thread", /\bThread\b/],
  ["NFC", /\bNFC\b/],
];

export function parseInterfaces(text: string): string[] {
  return INTERFACE_TOKENS.filter(([, re]) => re.test(text)).map(([name]) => name);
}

// ---------------------------------------------------------------------------------------
// Specifications -> electrical essentials and key specs

export interface SpecRow {
  spec_id: number;
  domain: string;
  key: string;
  value_text: string;
  source_id: number;
  validation_status: string;
  claim_scope: string;
  value_num?: number | null;
  minimum_num?: number | null;
  maximum_num?: number | null;
  scope_note?: string | null;
}

type Slot =
  | "logic" | "output" | "operating" | "input" | "current" | "i2c" | "interfaces"
  | "mcu" | "memory" | "wireless" | "clock" | "io" | "connector" | "temperature" | "performance" | "weight" | "mounting";

/**
 * First match wins, so the narrower slots come first. Keys are the catalog's snake_case, English and Norwegian.
 * "operating" is the voltage the part runs at; "input" is what a board accepts on its supply pin or
 * jack (an Uno runs at 5 V and accepts 7-12 V). Keeping them apart avoids reporting that as a conflict.
 */
const SLOT_RULES: [Slot, RegExp][] = [
  ["logic", /logikkniv|logic_?(level|voltage)|(^|_)i_?o_voltage|gpio_voltage|signal_(level|voltage)/],
  ["output", /^(output_voltage|utgangsspenning|vout|utgang|output_voltage_range)$/],
  ["i2c", /i2c_addr|^i2c_addresses$|^(default_)?address(es)?$|^adresse$/],
  ["current", /current|consumption|str_mforbruk|str_mstyrke|^maks_str_m$|^str_m$/],
  ["input", /^(input|power_supply|power_input)_voltage|^(inngangsspenning|power_supply|power_input|input_power|vin|str_mforsyning|type_c_input_voltage|power)$/],
  ["operating", /^(operating|working|supply|node_operational)_voltage|^(driftsspenning|forsyningsspenning|spenning|voltage)$/],
  ["interfaces", /^(communication|interface|grensesnitt|bus_interfaces|tilkobling|connectivity|protocol|node_communications)|^(i2c|spi|uart|usb)(_interface)?$/],
  ["mcu", /^(mcu|microcontroller|mikrokontroller|soc|processor|prosessor|main_chip|chipset|cpu|sensor|sensor_chip|chip|driver|driver_chip|controller_ic)$/],
  ["memory", /^(flash|psram|sram|ram|memory|minne|eeprom|flash_(memory|minne|size)|parameters_memory)$/],
  ["wireless", /^(wi_fi|wifi|wireless|wireless_connectivity|bluetooth|ble|tr_dl_s_tilkobling|lora|antenna)$/],
  ["clock", /^(clock_speed|klokkefrekvens|klokkehastighet|operating_frequency)/],
  ["io", /^(antall_pinner|pin_count|pins|gpio|digitale?_i_o_pin|pins_(digital|analog|pwm)|analog_input_pins|pwm_pins)/],
  ["connector", /^(usb_connector|usb_port|connector|battery_connector|formfaktor|form_factor)$/],
  ["temperature", /^(operating|working)_temp|^driftstemperatur|^temperature_range$/],
  ["performance", /^(resolution|oppl_sning|accuracy|n_yaktighet|measurement_range|measuring_range|m_leomr_de|range|response_time|sensitivity|display|display_size|skjermst_rrelse)$/],
  ["weight", /^(product_weight|weight|net_weight|vekt)$/],
  ["mounting", /mounting_hole|monteringshull/],
];

/** Pin-table rows ("1_vcc", "2_gnd") and bookkeeping keys are not specs of the part. */
const NOT_A_SPEC = /^\d|^(note|please_note|product_name|name|figure|warning|repository_commit|folder_s|board_sku|board_name|label_name|num_label|primary_guide|development|gravity|parameter)$/;

export function slotOf(key: string): Slot | null {
  if (NOT_A_SPEC.test(key)) return null;
  for (const [slot, re] of SLOT_RULES) if (re.test(key)) return slot;
  return null;
}

/** Keys that mean the same thing. Other keys stand alone: "power_input_voltage_vin" and "power_input_voltage_5v" are two pins, not two opinions. */
const KEY_SYNONYMS: [string, RegExp][] = [
  ["operating", /^(operating_voltage|working_voltage|supply_voltage|driftsspenning|forsyningsspenning)$/],
  ["input", /^(input_voltage|inngangsspenning|power_supply|power_supply_voltage|power_input)$/],
  ["generic", /^(voltage|spenning)$/],
];
const claimFamily = (key: string): string => KEY_SYNONYMS.find(([, re]) => re.test(key))?.[0] ?? key;

/**
 * min_v and max_v span every claim. `conflict` is narrower: two claims about the same thing
 * (the same key, or keys that are synonyms) whose voltage ranges do not overlap.
 */
export function voltageSummary(claims: Claim[]): VoltageSummary | null {
  const span = (c: Claim): { family: string; lo: number; hi: number } | null => {
    const v = c.range ?? parseVolts(c.v);
    return v.length ? { family: claimFamily(c.k), lo: v[0]!, hi: v[v.length - 1]! } : null;
  };
  const usable = claims.filter((c) => !c.disputed);
  // Where the catalog selected a claim for this field, that is the answer; the rest stay listed.
  const chosen = usable.filter((c) => c.selected);
  const spans = (chosen.length ? chosen : usable).map(span).filter((s): s is NonNullable<typeof s> => s !== null);
  if (!spans.length) return null;
  const conflict = spans.some((a) => spans.some((b) => a.family === b.family && a.hi + 0.25 < b.lo));
  return {
    min_v: Math.min(...spans.map((s) => s.lo)), max_v: Math.max(...spans.map((s) => s.hi)), conflict, selected: chosen.length > 0,
    claims: [...claims].sort((a, b) => Number(b.selected ?? false) - Number(a.selected ?? false)).slice(0, 5),
  };
}

/** The catalog marks its selected claim per field in scope_note, as JSON: canonical_voltage, selected_i2c_address. */
function noteFlag(scopeNote: string | null | undefined, flag: string): boolean {
  if (!scopeNote || scopeNote[0] !== "{") return false;
  try {
    return (JSON.parse(scopeNote) as Record<string, unknown>)[flag] === true;
  } catch {
    return false;
  }
}
const isSelectedVoltage = (scopeNote: string | null | undefined): boolean => noteFlag(scopeNote, "canonical_voltage");

/** Voltage limits from the catalog's numeric fields. A nominal value alone is a single point, not a range. */
function numericRange(r: SpecRow): [number, number] | undefined {
  const lo = r.minimum_num ?? r.value_num ?? r.maximum_num;
  const hi = r.maximum_num ?? r.value_num ?? r.minimum_num;
  return typeof lo === "number" && typeof hi === "number" && lo > 0 && hi <= 60 ? [Math.min(lo, hi), Math.max(lo, hi)] : undefined;
}

const AUTHORITY_ORDER = (authority: string): number => (/manufacturer/.test(authority) ? 0 : /retailer_claim/.test(authority) ? 1 : 2);

export function distillSpecs(
  specs: SpecRow[],
  authorityOf: (sourceId: number) => string,
): { electrical: Electrical; specs: Record<string, Claim[]> } {
  const bySlot = new Map<Slot, Map<string, Claim & { rank: number; id: number }>>();
  const add = (slot: Slot, r: SpecRow, extra: Partial<Claim> = {}): void => {
    const text = clip(r.value_text, 160);
    if (!text || text === "|") return;
    const key = `${r.key}|${text.toLowerCase()}`;
    const m = bySlot.get(slot) ?? new Map();
    bySlot.set(slot, m);
    const have = m.get(key);
    if (have) {
      have.n++;
      return;
    }
    m.set(key, {
      k: r.key, v: text, src: r.source_id, n: 1, rank: AUTHORITY_ORDER(authorityOf(r.source_id)), id: r.spec_id,
      ...(r.validation_status === "disputed_source_claim" ? { disputed: true as const } : {}),
      ...(r.claim_scope === "silicon_capability" ? { silicon: true as const } : {}),
      ...extra,
    });
  };

  for (const r of specs) {
    if (r.key === "feature") {
      // Prose. Only an explicit I2C address is taken from it.
      if (/i2c|address|adresse/i.test(r.value_text) && parseI2cAddresses(r.value_text).length) add("i2c", r, { from_feature_text: true });
      continue;
    }
    const slot = slotOf(r.key);
    if (!slot) continue;
    if (slot === "operating" || slot === "input" || slot === "logic" || slot === "output") {
      const selected = isSelectedVoltage(r.scope_note);
      const range = selected ? numericRange(r) : undefined;
      if (!range && !parseVolts(r.value_text).length) continue;
      add(slot, r, { ...(selected ? { selected: true as const } : {}), ...(range ? { range } : {}) });
      continue;
    }
    if (slot === "i2c") {
      // A selected address is the catalog's reviewed answer; its numeric value is already 7-bit.
      if (noteFlag(r.scope_note, "selected_i2c_address")) {
        const n = r.value_num;
        const address = typeof n === "number" && Number.isInteger(n) && n >= 0 && n <= 0x7f ? `0x${n.toString(16).toUpperCase().padStart(2, "0")}` : undefined;
        add(slot, r, { selected: true as const, ...(address ? { address } : {}) });
        continue;
      }
      if (!parseI2cAddresses(r.value_text).length) continue;
    }
    if (slot === "current" && !parseMilliamps(r.value_text).length) continue;
    if (slot === "interfaces" && !parseInterfaces(r.value_text).length) continue;
    add(slot, r);
  }

  const claims = (slot: Slot): Claim[] =>
    [...(bySlot.get(slot)?.values() ?? [])]
      .sort((a, b) => a.rank - b.rank || b.n - a.n || a.id - b.id)
      .map(({ rank: _rank, id: _id, ...c }) => c);

  const i2cClaims = claims("i2c");
  // Addresses from spec tables first; prose only when no table gave one.
  const tableAddresses = uniq(i2cClaims.filter((c) => !c.from_feature_text).flatMap((c) => parseI2cAddresses(c.v)));
  const selectedI2c = i2cClaims.filter((c) => c.selected);
  const electrical: Electrical = {
    operating: voltageSummary(claims("operating")),
    input: voltageSummary(claims("input")),
    logic: voltageSummary(claims("logic")),
    output: voltageSummary(claims("output")),
    current: claims("current").slice(0, 6),
    // With a selected claim, only the catalog's own number counts: a text such as "strap range 0x40-0x7F,
    // All-Call 0x70" would otherwise be read as three addresses.
    i2c_addresses: selectedI2c.length
      ? uniq(selectedI2c.flatMap((c) => (c.address ? [c.address] : [])))
      : tableAddresses.length ? tableAddresses : uniq(i2cClaims.flatMap((c) => parseI2cAddresses(c.v))),
    i2c_selected: selectedI2c.length > 0,
    i2c_claims: [...i2cClaims].sort((a, b) => Number(b.selected ?? false) - Number(a.selected ?? false)).slice(0, 4),
    interfaces: uniq(claims("interfaces").flatMap((c) => parseInterfaces(c.v))),
  };
  const out: Record<string, Claim[]> = {};
  for (const slot of ["mcu", "memory", "wireless", "clock", "io", "connector", "temperature", "performance", "weight", "mounting"] as Slot[]) {
    const c = claims(slot).slice(0, 4);
    if (c.length) out[slot] = c;
  }
  return { electrical, specs: out };
}

// ---------------------------------------------------------------------------------------
// Outline

export interface EnvelopeRow {
  a_mm: number;
  b_mm: number;
  c_mm: number | null;
  axis_labels_json: string | null;
  scope: string;
  source_id: number;
  evidence_text: string;
  verification_status: string;
  exact_variant_required: number;
  variant_sku: string | null;
}

export interface MeasurementRow {
  measurement_id: number;
  kind: string;
  scope: string;
  values_mm_json: string;
  axis_labels_json: string | null;
  evidence_text: string;
  extraction_status: string;
  source_id: number;
}

const SCOPE_MEANING: Record<string, string> = {
  pcb: "bare circuit board; excludes headers, connectors and components",
  assembly: "assembled product, as the source states it",
  product_unspecified: "the source did not say what the size includes",
  board_without_headers: "board without header pins fitted",
  board_assembly_without_headers: "assembled board without header pins fitted",
  partial_body_only: "one part of the product, not the whole",
  individual_item_in_multipack: "one item out of a multipack",
  cad_model: "bounding box of a CAD model; never a physical envelope",
  component: "a component on the product, not the product",
  unknown: "the source did not say what was measured",
};
export const scopeMeaning = (scope: string): string => SCOPE_MEANING[scope] ?? scope.replace(/_/g, " ");

function labels(json: string | null): string[] | null {
  if (!json) return null;
  try {
    const v: unknown = JSON.parse(json);
    return Array.isArray(v) && v.every((x) => typeof x === "string") ? (v as string[]) : null;
  } catch {
    return null;
  }
}

function numbers(json: string): number[] {
  try {
    const v: unknown = JSON.parse(json);
    return Array.isArray(v) ? v.filter((x): x is number => typeof x === "number" && Number.isFinite(x)) : [];
  } catch {
    return [];
  }
}

export function buildOutline(env: EnvelopeRow | undefined): Outline | null {
  if (!env) return null;
  const axes = labels(env.axis_labels_json);
  const thirdIsThickness = env.c_mm != null && !!axes && /thickness/i.test(axes[2] ?? "");
  return {
    mm: [env.a_mm, env.b_mm, env.c_mm],
    axes,
    scope: env.scope,
    scope_meaning: scopeMeaning(env.scope),
    height_known: env.c_mm != null && !thirdIsThickness,
    pcb_thickness_mm: thirdIsThickness ? env.c_mm : null,
    status: env.verification_status,
    variant_required: env.exact_variant_required === 1,
    variant_sku: env.variant_sku,
    evidence: clip(env.evidence_text, 200),
    src: env.source_id,
  };
}

const sameNumbers = (a: number[], b: number[], tol = 0.05): boolean => {
  if (a.length !== b.length) return false;
  const x = [...a].sort((p, q) => p - q);
  const y = [...b].sort((p, q) => p - q);
  return x.every((v, i) => Math.abs(v - y[i]!) <= tol);
};

const STATUS_ORDER = (s: string): number => (/manual|reviewed/.test(s) ? 0 : s === "source_stated" ? 1 : /parser_derived/.test(s) ? 2 : 3);

/** Bounding boxes other than the selected one, and every other dimensional claim (pitch, holes, single axes). */
export function buildObservations(ms: MeasurementRow[], selected: Outline | null): { outlines: Observation[]; dimensions: Observation[] } {
  const selectedValues = selected ? selected.mm.filter((v): v is number => v != null) : [];
  const seen = new Set<string>();
  const outlines: Observation[] = [];
  const dimensions: Observation[] = [];
  for (const m of [...ms].sort((a, b) => STATUS_ORDER(a.extraction_status) - STATUS_ORDER(b.extraction_status) || a.measurement_id - b.measurement_id)) {
    const mm = numbers(m.values_mm_json);
    if (!mm.length) continue;
    // Rows are visited best status first, so an ambiguous parser candidate that only repeats a
    // transcribed pitch or hole size is dropped here.
    const isBox = m.kind === "bounding_box" || m.kind === "model_bounds";
    const family = isBox ? `${m.kind}|${m.scope}` : /pitch/.test(m.kind) ? "pitch" : /hole|diameter/.test(m.kind) ? "hole" : `${m.kind}|${m.scope}`;
    const key = `${family}|${[...mm].sort((a, b) => a - b).join(",")}`;
    if (seen.has(key)) continue;
    seen.add(key);
    const o: Observation = { kind: m.kind, scope: m.scope, mm, axes: labels(m.axis_labels_json), status: m.extraction_status, evidence: clip(m.evidence_text, 140), src: m.source_id };
    if (m.kind === "bounding_box" || m.kind === "model_bounds") {
      if (selected && m.scope === selected.scope && sameNumbers(mm, selectedValues)) continue;
      if (selected && m.kind === "bounding_box" && m.scope === selected.scope && mm.length === selectedValues.length) o.differs_from_selected = true;
      outlines.push(o);
    } else {
      // A single labelled axis that only repeats a value of the selected outline says nothing new.
      if (m.kind === "axis" && selected && m.scope === selected.scope && mm.length === 1 && selectedValues.some((v) => Math.abs(v - mm[0]!) <= 0.05)) continue;
      dimensions.push(o);
    }
  }
  return { outlines: outlines.slice(0, 6), dimensions: dimensions.slice(0, 10) };
}

// ---------------------------------------------------------------------------------------
// Pad geometry -> headers, connectors, mounting holes

export interface RawPad {
  reference?: string | null;
  pad_number?: string | null;
  net_name?: string | null;
  x_mm?: number | null;
  y_mm?: number | null;
  pad_type?: string | null;
  footprint_side?: string | null;
  drill_mm?: number | null;
  package?: string | null;
  footprint_name?: string | null;
}

// Package names are tested without their library prefix ("Connector:H7-2.54" -> "H7-2.54").
const bare = (pkg: string): string => pkg.replace(/^[A-Za-z0-9_ ]+:/, "");

const CONNECTOR_KINDS: [string, RegExp][] = [
  ["usb", /USB|ZX62|4UCONN|CUSB|MCR-AB1|^PN61729/i],
  ["jst_sh_4pin", /JST_?SH4|JST04_1MM|1X04_1MM_RA|SM04B-SRSS|QWIIC|STEMMA/i],
  ["jst", /JST|SM0\dB|S\dB-PH|PH1X\d|^53398|_BATT\b/i],
  ["grove", /GROVE|4P-SMD-2\.0mm|HY2\.0/i],
  ["terminal_block", /TERM(INAL)?_?BLOCK|SCREW_?TERM|\bKF\d{3}\b/i],
  ["dc_jack", /POWER_?JACK|POWERSUPPLY_DC|DC[-_]?JACK|BARREL|^PJ-\d/i],
  ["sd_card", /MICROSD|SD-TF|SD_?CARD|TF_?CARD|^AMPHENOL_114/i],
  ["hdmi", /HDMI/i],
  ["flat_cable", /\bFPC\b|\bFFC\b|FPC_|EYE_?SPI/i],
  ["board_to_board", /^BTB/i],
  ["rf", /U[.-]?FL|IPEX|^SMA([-_](CONN|EDGE|JACK|RF)|$)/i],
  ["audio_jack", /AUDIO|TRRS/i],
];

const MOUNTING = /MOUNT(ING)?[-_ ]?HOLE|SMT_NUT|STANDOFF|^HOLE[-_]|[-_]HOLE$/i;
const IGNORED = /FIDUCIA|^FD-\d|LOGO|^dummyfp/i;
const TEST_POINT = /^TP(\d|[-_]|$)|TEST_?(POINT|PAD)|[-_]TP\d*$/i;
const IC_PACKAGE = /^(DIL|DIP|SOIC|SO\d|SO-|QFN|QFP|TQFP|LQFP|BGA|SOT|TSSOP|MSOP|LGA|DFN|USON|WLCSP|MODULE\d|ESP-?\d|ESP32-|WROOM|WROVER)/i;
/**
 * Pin headers, sockets and castellated edges: "1X08", "2X03", "1X15-CASTELL", "PINHEAD_2X05_127",
 * "HEAD17-NOSS", "H7-2.54". The rows-by-pins form must open the name with one or two rows, so that
 * body sizes such as "CRYSTAL_2.5X2" or "BTN_KMR2_4.6X2.8" are not read as headers.
 */
const HEADER = /^[12]X\d{1,2}(?![\d.X])(?!\s*(DFN|QFN|LGA|MM))|PIN_?HEAD|PINHD|HEADER|^HEAD\d|^HDR\d|CASTELL|HALF-?HOLE|^H\d+-|^STRIP-\d|XIAO_Socket/i;
const CASTELLATED = /CASTELL|HALF-?HOLE/i;
/**
 * Packages named after a discrete part with leads on a header pitch: "LED_5MM_NOSILK",
 * "CRYSTAL_HC49", "BTN_6MM", "CAP_PTH_5MM", "POT-9MM". The short words must open the name
 * and end there, so "CAPTOUCH_PADS", "RESET_PADS" and "SWD-1X5" are not read as a
 * capacitor, a resistor and a switch.
 */
const DISCRETE_PACKAGE = /(^|[_:-])LED|CRYSTAL|RESONATOR|(^|[_:-])BTN|(^|[_:-])SW\d|INDUCTOR|BUZZ|^(CAP|RES|DIODE|XTAL|BUTTON|TACT|POT|TRIM|FUSE|BATTERY)(?![A-Z])/i;
/** References that only ever name a connector. X and P are left out: they also name crystals and test pads. */
const SURE_CONNECTOR_REF = /^(J|CN|CON)\d+$/;
/** Reference designators that name a connector: J1, JP2, CN3, P4, SV1, or a word label such as IOH, POWER, ICSP. */
const CONNECTOR_REF = /^(J|JP|CN|CON|P|SV|HDR|H|K)\d+$|^[A-Z]{2,}[A-Z0-9_]*$/;
const COMPONENT_REF = /^(U|IC|ZU|Q|Y|C|R|L|D|T|SW|S|LED|F|FB|TP|RN|XTAL)\$?\d*$/i;
const HEADER_PITCHES = [1.0, 1.27, 2.0, 2.54, 3.5, 3.81, 5.0, 5.08];

export interface RowShape {
  rows: number;
  pitch_mm: number | null;
  along: "x" | "y" | null;
}

/** Whether pads sit in straight rows with one spacing. Works in the file's own axes. */
export function rowShape(points: { x: number; y: number }[]): RowShape {
  if (points.length < 2) return { rows: points.length, pitch_mm: null, along: null };
  const key = (n: number): number => Math.round(n * 100) / 100;
  const xs = uniq(points.map((p) => key(p.x)));
  const ys = uniq(points.map((p) => key(p.y)));
  if (xs.length === points.length && ys.length === points.length && xs.length > 2) return { rows: 0, pitch_mm: null, along: null };
  const along: "x" | "y" = ys.length <= xs.length ? "x" : "y";
  const lines = new Map<number, number[]>();
  for (const p of points) {
    const line = key(along === "x" ? p.y : p.x);
    lines.set(line, [...(lines.get(line) ?? []), along === "x" ? p.x : p.y]);
  }
  const gaps: number[] = [];
  for (const line of lines.values()) {
    const sorted = [...line].sort((a, b) => a - b);
    for (let i = 1; i < sorted.length; i++) gaps.push(sorted[i]! - sorted[i - 1]!);
  }
  const positive = gaps.filter((g) => g > 0.01);
  const min = positive.length ? Math.min(...positive) : null;
  // Uniform when every gap is a whole multiple of the smallest one.
  const uniform = min != null && positive.every((g) => Math.abs(g / min - Math.round(g / min)) < 0.03);
  return { rows: lines.size, pitch_mm: uniform ? round(min!, 2) : null, along };
}

export function classifyGroup(ref: string, pkg: string | null, pads: RawPad[]): { cls: GroupClass; kind: string; basis: string[] } {
  const p = bare(pkg ?? "");
  // A drawing-derived dataset holds nothing but header centres, and says so on every pad.
  if (pads.length && pads.every((x) => x.pad_type === "header_center_anchor")) return { cls: "header", kind: "pin_header", basis: ["header centres named in the source drawing"] };
  if (IGNORED.test(p)) return { cls: "component", kind: "ignored", basis: [`package ${p}`] };
  if (MOUNTING.test(p) && !CASTELLATED.test(p)) return { cls: "mounting_hole", kind: "mounting_hole", basis: [`package ${p}`] };
  if (TEST_POINT.test(p) || /^TP\d+$/i.test(ref)) return { cls: "test_point", kind: "test_point", basis: [`package ${p || ref}`] };
  for (const [kind, re] of CONNECTOR_KINDS) if (re.test(p)) return { cls: "connector", kind, basis: [`package ${p}`] };
  if (IC_PACKAGE.test(p)) return { cls: "component", kind: "ic", basis: [`package ${p}`] };
  if (HEADER.test(p)) return { cls: "header", kind: CASTELLATED.test(p) ? "castellated_edge" : "pin_header", basis: [`package ${p}`] };
  if (pads.every((x) => x.pad_type === "np_thru_hole")) return { cls: "mounting_hole", kind: "unplated_hole", basis: ["unplated through hole; purpose not stated by the source"] };
  // A package that names a discrete part is that part, whatever its reference and pitch: a
  // 5 mm LED labelled "BULB3" has two through holes 2.54 mm apart and is not a header.
  if (DISCRETE_PACKAGE.test(p)) return { cls: "component", kind: "component", basis: [`package ${p}`] };
  // No telling package name. A connector-style reference plus pads on a standard header pitch is enough; either alone is not.
  const shape = rowShape(pads.map((x) => ({ x: x.x_mm ?? 0, y: x.y_mm ?? 0 })));
  const throughHole = pads.every((x) => x.pad_type === "through_hole");
  if (pads.length >= 2 && throughHole && shape.pitch_mm != null && HEADER_PITCHES.includes(shape.pitch_mm) && CONNECTOR_REF.test(ref) && !COMPONENT_REF.test(ref)) {
    return { cls: "header", kind: "pin_header", basis: [`reference ${ref}`, `${shape.pitch_mm} mm pitch`] };
  }
  if (pads.length >= 2 && SURE_CONNECTOR_REF.test(ref)) return { cls: "connector", kind: "unidentified", basis: [`reference ${ref}; package ${p || "unnamed"} not recognised`] };
  return { cls: "component", kind: "component", basis: [] };
}

export interface PinDefRow {
  pin_id: number;
  connector: string;
  pin_number: string;
  name: string;
  electrical_type_as_source: string | null;
  functions_as_source: string;
  source_id: number;
  revision: string | null;
  notes?: string | null;
}

const norm = (s: string): string => s.toUpperCase().replace(/[^A-Z0-9]/g, "");

/** The geometry datasets a pin row was published for, or null when the catalog recorded no binding on it. */
export function supportedGeometry(notes: string | null | undefined): number[] | null {
  if (!notes || notes[0] !== "{") return null;
  try {
    const ids = (JSON.parse(notes) as { supported_geometry_ids?: unknown }).supported_geometry_ids;
    return Array.isArray(ids) ? ids.filter((x): x is number => typeof x === "number") : null;
  } catch {
    return null;
  }
}

/**
 * Attach published pin functions to pads. Nothing here is fuzzy.
 *
 * Rows the catalog bound to this geometry dataset come first: on a board the row's connector is
 * the pad group's reference, on a module footprint the connector is "module", and in both the pin
 * number is the pad number. A row bound only to other datasets is never used for this one.
 *
 * Rows without any binding fall back to this generator's own rules, strongest first:
 *   1. the pin table's connector is this group's reference and the pin number is the pad number
 *   2. the pad's net name equals exactly one pin name, and that pin name occurs once
 *   3. (module footprints only) the pad number is the module's pin number, when the part has a
 *      single unbound pin table
 *
 * Returns the ids of the pin rows that ended up described by a pad.
 */
export function joinPinFunctions(
  groups: PadGroup[],
  defs: PinDefRow[],
  scope: "board" | "land_pattern",
  geometryId: number | null = null,
  /** Called once per joined pad with the pin rows its function text was read from (the importer reads roles and GPIO numbers from them). */
  onJoin?: (pad: Pad, rows: PinDefRow[]) => void,
): Set<number> {
  const joined = new Set<number>();
  if (!defs.length) return joined;
  const bound = new Map<string, PinDefRow>();
  const unbound: PinDefRow[] = [];
  for (const d of defs) {
    const ids = supportedGeometry(d.notes);
    if (ids === null) unbound.push(d);
    else if (geometryId != null && ids.includes(geometryId)) {
      if (scope === "land_pattern" && d.connector !== "module") continue;
      bound.set(scope === "land_pattern" ? d.pin_number.trim() : `${norm(d.connector)}|${d.pin_number.trim()}`, d);
    }
  }
  const byConnPin = new Map(unbound.map((d) => [`${norm(d.connector)}|${d.pin_number.trim()}`, d]));
  const nameCount = new Map<string, number>();
  for (const d of unbound) nameCount.set(norm(d.name), (nameCount.get(norm(d.name)) ?? 0) + 1);
  const byName = new Map(unbound.filter((d) => nameCount.get(norm(d.name)) === 1).map((d) => [norm(d.name), d]));
  const tables = uniq(unbound.map((d) => `${d.connector}|${d.revision ?? ""}`));
  const byPin = tables.length === 1 ? new Map(unbound.map((d) => [d.pin_number.trim(), d])) : null;
  const fn = (d: PinDefRow, basis: PinFunction["basis"]): PinFunction => ({
    name: d.name, functions: clip(d.functions_as_source, 120), type: d.electrical_type_as_source, basis, src: d.source_id,
  });
  const says = (d: PinDefRow): boolean => !!d.functions_as_source.trim() && norm(d.functions_as_source) !== norm(d.name);
  for (const g of groups) {
    for (const pad of g.pads) {
      const binding = bound.get(scope === "land_pattern" ? pad.n : `${norm(g.ref)}|${pad.n}`);
      const direct = byConnPin.get(`${norm(g.ref)}|${pad.n}`);
      const named = pad.net && pad.net.length > 1 ? byName.get(norm(pad.net)) : undefined;
      const modulePin = scope === "land_pattern" && byPin ? byPin.get(pad.n) : undefined;
      const own = direct ?? named ?? modulePin;
      const hit = binding ?? own;
      if (!hit) continue;
      pad.fn = fn(hit, binding ? "catalog_geometry_binding" : direct ? "connector_and_pin_number" : named ? "net_name_equals_pin_name" : "module_pin_number");
      joined.add(hit.pin_id);
      const rowsRead = [hit];
      // The binding settles which pin this pad is. If its row only repeats the pin name, the module's
      // own pin table, matched on that same pin number, supplies what the pin does.
      if (binding && modulePin && !direct && !named) {
        joined.add(modulePin.pin_id);
        if (!says(binding) && says(modulePin)) {
          pad.fn.functions = clip(modulePin.functions_as_source, 120);
          pad.fn.functions_from = { connector: modulePin.connector, src: modulePin.source_id };
          rowsRead.push(modulePin);
        }
      }
      onJoin?.(pad, rowsRead);
    }
  }
  return joined;
}

export interface GeometryRow {
  geometry_id: number;
  kind: string;
  source_id: number;
  revision: string | null;
  source_url: string;
  source_sha256: string | null;
  payload_json: string;
  validation_status: string;
  /** The catalog's own description of the frame, e.g. "Native KiCad X right/Y down". Used when the payload does not state the Y direction. */
  coordinate_frame?: string | null;
}

interface Payload {
  format?: string;
  archive_member?: string;
  native_reference_path?: string;
  reference_path?: string;
  coordinate_scope?: string;
  frame?: { units?: string; x_direction?: string; y_direction?: string; origin?: string; view?: string; rebased_to_board_edge?: boolean };
  bounds_mm?: { min_x?: number; min_y?: number; max_x?: number; max_y?: number };
  completeness?: Record<string, unknown>;
  skipped_pads?: unknown[];
  pads?: RawPad[];
  outline_bounds?: { min_mm?: number[]; max_mm?: number[]; extent_mm?: number[] };
  explicit_holes?: { x_mm?: number; y_mm?: number; drill_mm?: number }[];
  plated_package_pad_holes?: { placement_origin_mm?: number[]; local_xy_mm?: number[]; drill_mm?: number; package?: string }[];
  source_sha256?: string;
}

const parsePayload = (json: string): Payload => JSON.parse(json) as Payload;

/** Outline extent from either payload shape: parsed CAD outlines and outlines derived from drawing callouts. */
function outlineBounds(p: Payload): { min: [number, number]; max: [number, number] } | null {
  const ob = p.outline_bounds;
  if (ob?.min_mm?.length === 2 && ob.max_mm?.length === 2) return { min: [ob.min_mm[0]!, ob.min_mm[1]!], max: [ob.max_mm[0]!, ob.max_mm[1]!] };
  const b = p.bounds_mm;
  if (b && typeof b.min_x === "number" && typeof b.min_y === "number" && typeof b.max_x === "number" && typeof b.max_y === "number") {
    return { min: [b.min_x, b.min_y], max: [b.max_x, b.max_y] };
  }
  return null;
}
const fileOf = (p: Payload, url: string): string | null => p.archive_member ?? decodeURIComponent(url.split(/[/#]/).pop() ?? "") ?? null;

/**
 * Datasets are never merged. The one shown is a placed board before a module footprint, then one
 * the catalog published pin rows for, then a full parse before a partial one, then the most pads.
 */
export function pickDataset<T extends { geometry_id: number; kind: string; validation_status: string; pads: number; bound?: boolean }>(sets: T[]): T | null {
  const order = (s: T): number[] => [s.kind === "pcb_pad_centers" ? 0 : 1, s.bound ? 0 : 1, /partial/.test(s.validation_status) ? 1 : 0, -s.pads, s.geometry_id];
  return [...sets].sort((a, b) => {
    const x = order(a);
    const y = order(b);
    for (let i = 0; i < x.length; i++) if (x[i] !== y[i]) return x[i]! - y[i]!;
    return 0;
  })[0] ?? null;
}

export interface ContactRow<P extends RawPad = RawPad> {
  /** Footprint reference as the file names it ("module" when the pads carry none). */
  ref: string;
  /** 1-based index among the rows of this reference. */
  row: number;
  package: string | null;
  /** One entry per contact: a surface pad and a through hole on the same spot for one pin count once. */
  pads: P[];
  pitch_mm: number;
  /** A contact in this row is both a surface pad and a through hole. */
  mixed: boolean;
}

/**
 * The contact rows of a module footprint (kind `module_land_pattern`): four or more pads in a line on
 * one pitch. Everything else in the footprint (mounting holes, debug and test pads) is counted, not
 * returned. Shared by the card generator and the importer so there is one reading of a footprint.
 */
export function moduleContactRows<P extends RawPad>(raw: P[]): { rows: ContactRow<P>[]; excluded: { rows: number; pads: number } } {
  const groupsByRef = new Map<string, P[]>();
  for (const p of raw) {
    const ref = p.reference ?? "module";
    groupsByRef.set(ref, [...(groupsByRef.get(ref) ?? []), p]);
  }
  const rows: ContactRow<P>[] = [];
  const excluded = { rows: 0, pads: 0 };
  // One footprint. Its contact rows are found by shape: four or more pads in a line on one pitch.
  for (const [ref, pads] of groupsByRef) {
    const pkg = pads[0]!.footprint_name ?? pads[0]!.package ?? null;
    const lines = new Map<string, P[]>();
    const whole = rowShape(pads.map((p) => ({ x: p.x_mm!, y: p.y_mm! })));
    const along = whole.along ?? "y";
    // A combined footprint puts a surface pad and a through hole on the same spot for one pin.
    // That is one contact: keep a single entry and record the group as mixed mounting.
    const spot = new Map<string, P[]>();
    for (const p of pads) {
      const k = `${p.pad_number}|${p.x_mm!.toFixed(3)}|${p.y_mm!.toFixed(3)}`;
      spot.set(k, [...(spot.get(k) ?? []), p]);
    }
    const mixedSpots = new Set<P>();
    for (const same of spot.values()) {
      const first = same[0]!;
      if (uniq(same.map((p) => p.pad_type)).length > 1) mixedSpots.add(first);
      const k = (along === "x" ? first.y_mm! : first.x_mm!).toFixed(2);
      lines.set(k, [...(lines.get(k) ?? []), first]);
    }
    let rowIndex = 0;
    for (const line of lines.values()) {
      const shape = rowShape(line.map((p) => ({ x: p.x_mm!, y: p.y_mm! })));
      if (line.length >= 4 && shape.pitch_mm != null) {
        rows.push({ ref, row: ++rowIndex, package: pkg, pads: line, pitch_mm: shape.pitch_mm, mixed: line.some((p) => mixedSpots.has(p)) });
      } else {
        excluded.rows++;
        excluded.pads += line.length;
      }
    }
  }
  return { rows, excluded };
}

export function buildBoard(objects: GeometryRow[], defs: PinDefRow[]): Board | null {
  return buildBoardAndJoin(objects, defs).board;
}

/** The board, plus the ids of the pin-table rows that were attached to one of its pads. */
export function buildBoardAndJoin(objects: GeometryRow[], defs: PinDefRow[]): { board: Board | null; joined: Set<number> } {
  const joined = new Set<number>();
  const board = buildBoardInner(objects, defs, joined);
  return { board, joined };
}

function buildBoardInner(objects: GeometryRow[], defs: PinDefRow[], joinedOut: Set<number>): Board | null {
  const boundIds = new Set(defs.flatMap((d) => supportedGeometry(d.notes) ?? []));
  const padSets = objects
    .filter((o) => o.kind === "pcb_pad_centers" || o.kind === "module_land_pattern")
    .map((o) => ({ ...o, payload: parsePayload(o.payload_json), bound: boundIds.has(o.geometry_id) }))
    .map((o) => ({ ...o, pads: (o.payload.pads ?? []).filter((p) => typeof p.x_mm === "number" && typeof p.y_mm === "number").length }))
    .filter((o) => o.pads > 0);
  const chosen = pickDataset(padSets);
  if (!chosen) return null;
  const payload = chosen.payload;
  const scope: Board["scope"] = chosen.kind === "pcb_pad_centers" ? "board" : "land_pattern";
  const raw = (payload.pads ?? []).filter((p) => typeof p.x_mm === "number" && typeof p.y_mm === "number");

  // The CAD outline is only used as an origin when it was parsed from the same file as the pads.
  const outlines = objects
    .filter((o) => o.kind === "pcb_outline_and_drills")
    .map((o) => ({ ...o, payload: parsePayload(o.payload_json) }))
    .map((o) => ({ ...o, bounds: outlineBounds(o.payload) }))
    .filter((o): o is typeof o & { bounds: NonNullable<ReturnType<typeof outlineBounds>> } => o.bounds !== null);
  const sameFile = outlines.find((o) => o.source_sha256 != null && o.source_sha256 === chosen.source_sha256);
  const outlineObj = scope === "board" ? (sameFile ?? outlines[0]) : undefined;
  const origin = outlineObj && outlineObj === sameFile ? outlineObj.bounds.min : null;
  const rel = (x: number, y: number): { rx?: number; ry?: number } => (origin ? { rx: round(x - origin[0]), ry: round(y - origin[1]) } : {});

  const groupsByRef = new Map<string, RawPad[]>();
  for (const p of raw) {
    const ref = p.reference ?? (scope === "land_pattern" ? "module" : "?");
    groupsByRef.set(ref, [...(groupsByRef.get(ref) ?? []), p]);
  }

  const headers: PadGroup[] = [];
  const connectors: PadGroup[] = [];
  const holes: Hole[] = [];
  const excluded = { components: 0, test_points: 0, pads: 0 };

  const toGroup = (ref: string, pkg: string | null, kind: string, basis: string[], pads: RawPad[]): PadGroup => {
    const shape = rowShape(pads.map((p) => ({ x: p.x_mm!, y: p.y_mm! })));
    const types = uniq(pads.map((p) => (p.pad_type === "smd" ? "smd" : p.pad_type === "through_hole" || p.pad_type === "np_thru_hole" ? "through_hole" : "unstated")));
    const numeric = pads.every((p) => /^\d+$/.test(p.pad_number ?? ""));
    const sorted = [...pads].sort((a, b) =>
      numeric ? Number(a.pad_number) - Number(b.pad_number) || a.x_mm! - b.x_mm! || a.y_mm! - b.y_mm! : a.y_mm! - b.y_mm! || a.x_mm! - b.x_mm!,
    );
    return {
      ref, package: pkg, kind, basis,
      mount: types.length > 1 ? "mixed" : (types[0] as "smd" | "through_hole" | "unstated"),
      side: uniq(pads.map((p) => p.footprint_side ?? null)).length === 1 ? (pads[0]!.footprint_side ?? null) : null,
      rows: shape.rows, pitch_mm: shape.pitch_mm, along: shape.along,
      pads: sorted.map((p) => ({
        n: String(p.pad_number ?? ""), x: round(p.x_mm!), y: round(p.y_mm!), ...rel(p.x_mm!, p.y_mm!),
        ...(p.net_name ? { net: p.net_name } : {}),
      })),
    };
  };

  if (scope === "land_pattern") {
    const found = moduleContactRows(raw);
    for (const r of found.rows) {
      const g = toGroup(`${r.ref}:row${r.row}`, r.package, "module_contact_row", [`${r.pads.length} pads in a line`, `${r.pitch_mm} mm pitch`], r.pads);
      if (r.mixed) g.mount = "mixed";
      headers.push(g);
    }
    excluded.components += found.excluded.rows;
    excluded.pads += found.excluded.pads;
  } else {
    for (const [ref, pads] of groupsByRef) {
      const pkg = pads[0]!.package ?? pads[0]!.footprint_name ?? null;
      const c = classifyGroup(ref, pkg, pads);
      if (c.cls === "header") headers.push(toGroup(ref, pkg, c.kind, c.basis, pads));
      else if (c.cls === "connector") connectors.push(toGroup(ref, pkg, c.kind, c.basis, pads));
      else if (c.cls === "mounting_hole") {
        for (const p of pads) holes.push({ x: round(p.x_mm!), y: round(p.y_mm!), ...rel(p.x_mm!, p.y_mm!), drill_mm: p.drill_mm ?? null, mounting: c.kind === "mounting_hole", basis: c.basis[0]! });
      } else {
        if (c.cls === "test_point") excluded.test_points++;
        else excluded.components++;
        excluded.pads += pads.length;
      }
    }
  }

  // Holes the outline parser found, when they are in the same frame as the pads.
  if (outlineObj && origin) {
    const have = new Set(holes.map((h) => `${h.x.toFixed(2)}|${h.y.toFixed(2)}`));
    const addHole = (x: number, y: number, drill: number | undefined, mounting: boolean, basis: string): void => {
      const k = `${x.toFixed(2)}|${y.toFixed(2)}`;
      if (have.has(k)) return;
      have.add(k);
      holes.push({ x: round(x), y: round(y), ...rel(x, y), drill_mm: drill ?? null, mounting, basis });
    };
    for (const h of outlineObj.payload.explicit_holes ?? []) {
      if (typeof h.x_mm === "number" && typeof h.y_mm === "number") addHole(h.x_mm, h.y_mm, h.drill_mm, false, "hole drawn in the CAD file; purpose not stated");
    }
    for (const h of outlineObj.payload.plated_package_pad_holes ?? []) {
      const o = h.placement_origin_mm;
      const l = h.local_xy_mm ?? [0, 0];
      if (o?.length === 2 && l[0] === 0 && l[1] === 0) addHole(o[0]!, o[1]!, h.drill_mm, true, `package ${h.package ?? "mounting hole"}`);
    }
  }

  const sortGroups = (gs: PadGroup[]): PadGroup[] => gs.sort((a, b) => b.pads.length - a.pads.length || a.ref.localeCompare(b.ref));
  sortGroups(headers);
  sortGroups(connectors);
  for (const id of joinPinFunctions([...headers, ...connectors], defs, scope, chosen.geometry_id)) joinedOut.add(id);

  const xs = raw.map((p) => p.x_mm!);
  const ys = raw.map((p) => p.y_mm!);
  const ob = outlineObj?.bounds;
  const completeness = payload.completeness ?? {};
  const fromDrawing = payload.coordinate_scope === "drawing_registered_board" || payload.format === "dimensioned_pdf_header_centers";
  return {
    geometry_id: chosen.geometry_id,
    scope,
    format: payload.format ?? null,
    source_file: fileOf(payload, chosen.source_url),
    source_url: chosen.source_url,
    sha256: chosen.source_sha256,
    native_path: payload.native_reference_path ?? payload.reference_path ?? null,
    revision: chosen.revision ? clip(chosen.revision, 120) : null,
    status: chosen.validation_status,
    frame: {
      units: payload.frame?.units ?? "mm",
      x: payload.frame?.x_direction ?? "right",
      y: payload.frame?.y_direction ?? /\bY[\s_-]*(up|down)\b/i.exec(chosen.coordinate_frame ?? "")?.[1]?.toLowerCase() ?? "unknown",
      origin: scope === "land_pattern"
        ? "footprint-local origin, not a position on the module"
        : payload.frame?.rebased_to_board_edge && payload.frame.origin
          ? clip(payload.frame.origin, 160)
          : "the CAD file's own origin, which may lie outside the board",
      view: payload.frame?.view ?? "top",
    },
    derivation: fromDrawing ? "drawing_callouts" : "native_cad",
    complete: completeness.complete_for_all_placed_pad_instances === true || completeness.all_native_pad_anchors_parsed === true,
    skipped_pads: (payload.skipped_pads ?? []).length,
    pad_count: raw.length,
    pad_bounds: { min: [round(Math.min(...xs)), round(Math.min(...ys))], max: [round(Math.max(...xs)), round(Math.max(...ys))] },
    outline: outlineObj && ob
      ? {
          min: ob.min, max: ob.max,
          extent: [round(ob.max[0] - ob.min[0]), round(ob.max[1] - ob.min[1])],
          geometry_id: outlineObj.geometry_id, same_file: outlineObj === sameFile, status: outlineObj.validation_status,
        }
      : null,
    headers,
    connectors,
    holes,
    excluded,
    other_datasets: padSets
      .filter((s) => s.geometry_id !== chosen.geometry_id)
      .map((s) => ({ geometry_id: s.geometry_id, kind: s.kind, revision: s.revision ? clip(s.revision, 80) : null, source_file: fileOf(s.payload, s.source_url), pads: s.pads })),
    src: chosen.source_id,
  };
}

interface ModelPayload {
  coordinate_scope?: string;
  reference_path?: string;
  boards?: {
    maximum_height_above_pcb_mm?: number | null;
    maximum_height_below_pcb_mm?: number | null;
    maximum_height_status?: string;
    modeled_height_scope?: string;
    pcb_thickness_model_mm?: number | null;
    pcb_bounds_mm?: { min_mm?: number[]; max_mm?: number[] };
    pcb_positive_z_face_mm?: number | null;
    pcb_negative_z_face_mm?: number | null;
    connectors?: {
      source_names?: string[];
      reference_candidates?: string[];
      housing_and_pins_bounds_mm?: { min_mm?: number[]; max_mm?: number[] };
      apertures?: {
        edge?: string; center_along_edge_mm?: number; width_mm?: number; opening_height_mm?: number;
        lower_height_above_pcb_mm?: number; upper_height_above_pcb_mm?: number; overhang_beyond_outline_mm?: number;
        edge_axis?: number; edge_outward_sign?: number; bounds?: { min_mm?: number[]; max_mm?: number[] };
      }[];
    }[];
  }[];
}

const MAX_OPENINGS = 12;

export type ModelBoard = NonNullable<ModelPayload["boards"]>[number];

/** Which face of the PCB a housing sits on, by where most of its height lies. Null when it is not clearly one side. */
function housingSide(zMin: number | undefined, zMax: number | undefined, pcbBottom: number | null | undefined, pcbTop: number | null | undefined): "above" | "below" | null {
  if (typeof zMin !== "number" || typeof zMax !== "number" || typeof pcbBottom !== "number" || typeof pcbTop !== "number") return null;
  const above = Math.max(0, zMax - pcbTop);
  const below = Math.max(0, pcbBottom - zMin);
  if (above > 0.5 && above > below * 3) return "above";
  if (below > 0.5 && below > above * 3) return "below";
  return null;
}

/** The model's connectors in the form the registration takes: plan-view centres, named by reference designator where the model gives one. */
export function modelConnectors(b: ModelBoard): ModelConnector[] {
  const out: ModelConnector[] = [];
  for (const c of b.connectors ?? []) {
    const lo = c.housing_and_pins_bounds_mm?.min_mm;
    const hi = c.housing_and_pins_bounds_mm?.max_mm;
    if (!lo || !hi || lo.length < 2 || hi.length < 2) continue;
    const names = c.source_names ?? [];
    // "JSTPH2_BATT:X1" carries the designator after the colon.
    const ref = names.map((n) => n.split(":")[1]).find((r) => !!r) ?? c.reference_candidates?.[0] ?? null;
    out.push({
      name: names.at(-1) ?? "connector", ref, center: [(lo[0]! + hi[0]!) / 2, (lo[1]! + hi[1]!) / 2],
      side: housingSide(lo[2], hi[2], b.pcb_negative_z_face_mm, b.pcb_positive_z_face_mm),
      openings: (c.apertures ?? []).flatMap((a) => {
        const amin = a.bounds?.min_mm;
        const amax = a.bounds?.max_mm;
        if (!amin || !amax || (a.edge_axis !== 0 && a.edge_axis !== 1) || !a.edge_outward_sign || typeof a.width_mm !== "number") return [];
        return [{
          center: [(amin[0]! + amax[0]!) / 2, (amin[1]! + amax[1]!) / 2] as [number, number],
          outward: (a.edge_axis === 0 ? [a.edge_outward_sign, 0] : [0, a.edge_outward_sign]) as [number, number],
          width_mm: a.width_mm, lower_above_pcb_mm: a.lower_height_above_pcb_mm ?? 0, upper_above_pcb_mm: a.upper_height_above_pcb_mm ?? 0,
        }];
      }),
    });
  }
  return out;
}

/**
 * Heights and connector openings from the first 3D model that states a height. Models are not merged.
 * Given the card's board, the model is also registered to that board's pad coordinates when its
 * outline comes from the same CAD file as the pads.
 */
export function buildModel(objects: GeometryRow[], board: Board | null = null): ModelHeights | null {
  const models = objects
    .filter((o) => o.kind === "pcb_model_clearances")
    .map((o) => ({ row: o, payload: JSON.parse(o.payload_json) as ModelPayload }))
    .filter((m) => m.payload.boards?.length);
  if (!models.length) return null;
  const withHeight = models.find((m) => typeof m.payload.boards![0]!.maximum_height_above_pcb_mm === "number");
  const { row, payload } = withHeight ?? models[0]!;
  const b = payload.boards![0]!;
  const num = (n: number | null | undefined): number | null => (typeof n === "number" && Number.isFinite(n) ? round(n, 2) : null);
  const openings: ModelOpening[] = [];
  const without: string[] = [];
  for (const c of b.connectors ?? []) {
    const name = (c.source_names ?? []).at(-1) ?? "connector";
    const found = (c.apertures ?? []).filter((a) => typeof a.center_along_edge_mm === "number" && typeof a.width_mm === "number" && !!a.edge);
    if (!found.length) without.push(name);
    for (const a of found) {
      openings.push({
        connector: name, edge: a.edge!, center_along_edge_mm: round(a.center_along_edge_mm!, 2), width_mm: round(a.width_mm!, 2),
        height_mm: round(a.opening_height_mm ?? 0, 2), lower_above_pcb_mm: round(a.lower_height_above_pcb_mm ?? 0, 2),
        upper_above_pcb_mm: round(a.upper_height_above_pcb_mm ?? 0, 2), overhang_mm: round(Math.max(0, a.overhang_beyond_outline_mm ?? 0), 2),
      });
    }
  }
  return {
    geometry_id: row.geometry_id, path: payload.reference_path ?? null, coordinate_scope: payload.coordinate_scope ?? "unknown",
    above_pcb_mm: num(b.maximum_height_above_pcb_mm), below_pcb_mm: num(b.maximum_height_below_pcb_mm), pcb_thickness_mm: num(b.pcb_thickness_model_mm),
    status: b.maximum_height_status ?? row.validation_status, covers: clip(b.modeled_height_scope ?? "", 200),
    openings: openings.slice(0, MAX_OPENINGS), connectors_without_opening: uniq(without), other_models: models.length - 1,
    ...register(row.geometry_id, b, board), src: row.source_id,
  };
}

/** EAGLE-derived data says "top"/"bottom"; KiCad names the copper layer, "F.Cu"/"B.Cu". */
export function boardSide(side: string | null): "top" | "bottom" | null {
  if (!side) return null;
  if (/^(top|f\.cu|front)$/i.test(side)) return "top";
  if (/^(bottom|b\.cu|back)$/i.test(side)) return "bottom";
  return null;
}

function register(modelId: number, b: ModelBoard, board: Board | null): Pick<ModelHeights, "registration" | "registration_note"> {
  const none = (registration_note: string | null): Pick<ModelHeights, "registration" | "registration_note"> => ({ registration: null, registration_note });
  if (!board) return none(null);
  if (board.scope !== "board") return none("the pad data is a module footprint in its own frame, not a placed board");
  if (board.derivation !== "native_cad") return none("the pad positions were calculated from a drawing; only pads read from a CAD file are registered");
  if (!board.outline?.same_file) return none("no board outline from the same CAD file as the pads");
  const lo = b.pcb_bounds_mm?.min_mm;
  const hi = b.pcb_bounds_mm?.max_mm;
  if (!lo || !hi || lo.length < 2 || hi.length < 2) return none("the model does not give its PCB bounds");
  if (board.frame.y !== "up" && board.frame.y !== "down") return none("the pad data does not say which way its Y axis points");
  const center = (g: PadGroup): [number, number] => [g.pads.reduce((s, p) => s + p.x, 0) / g.pads.length, g.pads.reduce((s, p) => s + p.y, 0) / g.pads.length];
  const r = registerModel({
    modelPcb: { min: [lo[0]!, lo[1]!], max: [hi[0]!, hi[1]!] },
    outline: { min: board.outline.min, max: board.outline.max },
    connectors: modelConnectors(b),
    padGroups: [...board.headers, ...board.connectors].map((g) => ({ ref: g.ref, center: center(g), side: boardSide(g.side) })),
    padFrameY: board.frame.y === "down" ? "down" : "up",
  });
  if (!r.ok) return none(r.reason);
  return { registration: { ...r.registration, pad_geometry_id: board.geometry_id, outline_geometry_id: board.outline.geometry_id, model_geometry_id: modelId }, registration_note: null };
}

/** Identity links the catalog keeps in metadata, grouped by the part they point from. */
export function readSeeAlso(metadata: Map<string, string>): Map<string, SeeAlso[]> {
  const out = new Map<string, SeeAlso[]>();
  const take = (key: string, relation: SeeAlso["relation"]): void => {
    const raw = metadata.get(key);
    if (!raw) return;
    let links: unknown;
    try {
      links = (JSON.parse(raw) as { links?: unknown }).links;
    } catch {
      return;
    }
    if (!Array.isArray(links)) return;
    for (const l of links as { identity_status?: string; direction?: Record<string, string | null> }[]) {
      const d = l.direction ?? {};
      const from = d.linked_part_id;
      const to = d.reference_part_id ?? d.reference_record_part_id;
      if (!from || !to || from === to) continue;
      const list = out.get(from) ?? [];
      out.set(from, list);
      if (list.some((x) => x.part_id === to)) continue;
      list.push({ part_id: to, relation, identity_status: l.identity_status ?? "unknown", holds_geometry: !!d.reference_geometry_holder_part_id });
    }
  };
  take("product_revision_reference_links", "marketed_revision_reference");
  take("product_sku_identity_links", "same_sku");
  return out;
}

export function buildPins(defs: PinDefRow[]): PinGroupOut[] {
  const groups = new Map<string, PinGroupOut>();
  for (const d of [...defs].sort((a, b) => a.connector.localeCompare(b.connector) || Number(a.pin_number) - Number(b.pin_number) || a.pin_id - b.pin_id)) {
    const k = `${d.connector}|${d.revision ?? ""}`;
    const g = groups.get(k) ?? { connector: d.connector, revision: d.revision, pins: [] };
    groups.set(k, g);
    g.pins.push({ n: d.pin_number, name: d.name, type: d.electrical_type_as_source, functions: clip(d.functions_as_source, 120), src: d.source_id });
  }
  return [...groups.values()];
}

// ---------------------------------------------------------------------------------------
// References, listings, caveats

export interface AssetRow {
  asset_id: number;
  kind: string;
  title: string | null;
  url: string;
  revision: string | null;
  applicability_note: string | null;
  relative_path: string | null;
  sha256: string | null;
  byte_count: number | null;
  media_type: string | null;
  local_status: string | null;
}

export interface DerivedRow {
  kind: string;
  title: string;
  source_url: string;
  relative_path: string;
  sha256: string;
  byte_count: number;
  media_type: string;
  derivation_method: string;
}

/**
 * Most useful first. Pinouts and rendered drawings are what an agent can look at directly; board
 * files carry exact geometry; photos come last. Kinds derived by the catalog from an original file:
 * rendered_drawing (a PDF page as an image), cad_preview (an SVG drawn from CAD outline segments),
 * board_file and native_file (a member extracted byte-for-byte from a source archive).
 */
const REFERENCE_ORDER = [
  "pinout", "rendered_drawing", "mechanical_drawing", "cad_preview", "board_file", "cad_or_mechanical", "schematic",
  "native_file", "datasheet_or_pdf", "block_diagram", "source_repository", "documentation", "product_image",
];
const PER_KIND = 4;
const BOARD_FILE = /\.(brd|kicad_pcb|kicad_mod|dxf|pcbdoc)$/i;

export function buildReferences(assets: AssetRow[], derived: DerivedRow[]): { references: Reference[]; counts: Record<string, number> } {
  const counts: Record<string, number> = {};
  for (const a of assets) counts[a.kind] = (counts[a.kind] ?? 0) + 1;
  const rank = (k: string): number => (REFERENCE_ORDER.includes(k) ? REFERENCE_ORDER.indexOf(k) : 99);
  const cached = (a: AssetRow): boolean => a.local_status === "downloaded" && !!a.relative_path;
  const all: Reference[] = [];
  for (const d of derived) {
    if (/licen[sc]e|readme/i.test(d.title)) continue;
    const kind = d.kind === "pdf_page_render" ? "rendered_drawing" : d.kind === "derived_cad_preview" ? "cad_preview" : BOARD_FILE.test(d.title) || BOARD_FILE.test(d.relative_path) ? "board_file" : "native_file";
    counts[kind] = (counts[kind] ?? 0) + 1;
    all.push({
      kind, title: clip(d.title, 90), url: d.source_url, path: d.relative_path, sha256: d.sha256, type: d.media_type, bytes: d.byte_count,
      revision: null, note: null, derived: clip(d.derivation_method, 100),
    });
  }
  for (const a of [...assets].sort((x, y) => Number(cached(y)) - Number(cached(x)) || x.asset_id - y.asset_id)) {
    // Photos and documentation pages are only worth a line when the file is on disk.
    if ((a.kind === "product_image" || rank(a.kind) === 99) && !cached(a)) continue;
    all.push({
      kind: a.kind, title: a.title ? clip(a.title, 90) : null, url: a.url, path: cached(a) ? a.relative_path : null,
      sha256: cached(a) ? a.sha256 : null, type: a.media_type, bytes: cached(a) ? a.byte_count : null,
      revision: a.revision ? clip(a.revision, 80) : null, note: a.applicability_note ? clip(a.applicability_note, 140) : null,
    });
  }
  const perKind = new Map<string, number>();
  const out: Reference[] = [];
  // Array.prototype.sort is stable, so cached-first order within a kind survives.
  for (const r of all.sort((x, y) => rank(x.kind) - rank(y.kind))) {
    const n = perKind.get(r.kind) ?? 0;
    const limit = r.kind === "product_image" ? 1 : r.kind === "documentation" ? 2 : PER_KIND;
    if (n >= limit) continue;
    perKind.set(r.kind, n + 1);
    out.push(r);
  }
  return { references: out, counts };
}

export interface ListingRow {
  listing_id: number;
  supplier: string;
  url: string;
  supplier_sku: string | null;
  identity_match: string;
  domestic_market: string | null;
  currency: string | null;
  price: number | null;
  price_basis: string;
  stock_status: string;
  observed_at: string;
  source_id: number;
}

export interface VariantRow {
  supplier: string;
  sku: string | null;
  title: string;
}

const STOCK_ORDER = (s: string): number => (s === "in_stock" ? 0 : s === "backorder" ? 1 : s === "unknown" ? 2 : 3);

export function buildListings(listings: ListingRow[], variants: VariantRow[]): { buy: Listing[]; norway: number; international: number } {
  const sorted = [...listings].sort(
    (a, b) =>
      Number(b.domestic_market === "NO") - Number(a.domestic_market === "NO") ||
      STOCK_ORDER(a.stock_status) - STOCK_ORDER(b.stock_status) ||
      a.supplier.localeCompare(b.supplier) || a.listing_id - b.listing_id,
  );
  const buy = sorted.slice(0, 8).map((l): Listing => {
    const v = l.supplier_sku ? variants.find((x) => x.supplier === l.supplier && x.sku === l.supplier_sku) : undefined;
    return {
      supplier: l.supplier, market: l.domestic_market, price: l.price, currency: l.currency,
      basis: /incl\. mva/.test(l.price_basis) ? "incl. VAT" : /excluding VAT/.test(l.price_basis) ? "excl. VAT" : "listed price; tax and shipping not normalised",
      stock: l.stock_status, observed: l.observed_at.slice(0, 10), url: l.url, sku: l.supplier_sku,
      variant: v && !/^default title$/i.test(v.title) ? clip(v.title, 60) : null, match: l.identity_match, src: l.source_id,
    };
  });
  const norway = listings.filter((l) => l.domestic_market === "NO").length;
  return { buy, norway, international: listings.length - norway };
}

export interface IssueRow {
  issue_id: number;
  severity: string;
  code: string;
  detail: string;
  source_id: number | null;
}

/** Boilerplate that is true of every part and is stated once in the card's contract instead. */
const UNIVERSAL_ISSUES = new Set(["mounting_and_clearance_unverified"]);
const MAX_INFO = 6;
/** A source note repeated on this many parts describes the source, not the part. */
export const BOILERPLATE_PART_COUNT = 15;
export const noteKey = (detail: string): string => detail.slice(0, 60);

/**
 * Warnings are all kept. Of the informational notes, only those specific to this part are kept:
 * `isBoilerplate` says whether a source note is one the catalog repeats across many parts.
 */
export function buildCaveats(issues: IssueRow[], isBoilerplate: (detail: string) => boolean = () => false): { caveats: Card["caveats"]; omitted: number } {
  const seen = new Set<string>();
  const warnings: Card["caveats"] = [];
  const info: Card["caveats"] = [];
  let boilerplate = 0;
  // Warnings first, so a note that only repeats a warning's text is the one dropped.
  for (const i of [...issues].sort((a, b) => Number(b.severity === "warning") - Number(a.severity === "warning") || a.issue_id - b.issue_id)) {
    if (UNIVERSAL_ISSUES.has(i.code)) continue;
    if (i.code === "source_note" && (/^Source capture metadata:/.test(i.detail) || isBoilerplate(i.detail))) {
      boilerplate++;
      continue;
    }
    const text = clip(i.detail, 260);
    const k = text.toLowerCase();
    if (seen.has(k)) continue;
    seen.add(k);
    (i.severity === "warning" ? warnings : info).push({ severity: i.severity, code: i.code, text, src: i.source_id });
  }
  // Notes about geometry, scope and variants before generic source notes.
  info.sort((a, b) => Number(a.code === "source_note") - Number(b.code === "source_note"));
  return { caveats: [...warnings, ...info.slice(0, MAX_INFO)], omitted: Math.max(0, info.length - MAX_INFO) + boilerplate };
}

// ---------------------------------------------------------------------------------------
// What the catalog does not know

export function buildMissing(c: Pick<Card, "outline" | "board" | "pins" | "electrical" | "references" | "buy_counts" | "category" | "identity">): Missing[] {
  const m: Missing[] = [];
  const add = (code: string, detail: string): void => void m.push({ code, detail });
  const hasRef = (kinds: string[]): boolean => c.references.some((r) => kinds.includes(r.kind) && r.path);
  const pinoutHint = hasRef(["pinout", "rendered_drawing"]) ? "a cached pinout or drawing is listed under references" : "no pinout is cached either";

  if (!c.outline) add("outline", "No outline was selected for this part. Check the outline observations, which may be partial or disagree, or measure it.");
  else {
    if (!c.outline.height_known) {
      add("height", c.outline.pcb_thickness_mm != null
        ? "The third value is the PCB thickness. The height with components is unknown, not zero."
        : "The outline has two values. Height is unknown, not zero.");
    }
    if (c.outline.scope === "pcb" || /without_headers/.test(c.outline.scope)) add("component_heights", "The outline is the board alone. Connector overhang, headers and component heights are not included.");
    if (c.outline.scope === "product_unspecified") add("outline_scope", "The source did not say whether the size includes connectors, headers or cables.");
  }
  if (c.identity.variant_choice_required) add("variant", "This record covers several variants. Choose the exact one before trusting dimensions or pins.");

  const padGroups = c.board ? [...c.board.headers, ...c.board.connectors] : [];
  const pads = padGroups.flatMap((g) => g.pads);
  if (!c.board) add("pad_coordinates", `No numeric pad positions. Read them from a drawing or CAD file, or measure; do not estimate them from a photo (${pinoutHint}).`);
  else if (!padGroups.length) add("pad_coordinates", "The CAD data was parsed, but no header or connector could be identified among its pads.");
  else if (c.board.scope === "land_pattern") add("board_frame", "Pad positions are in the footprint's own frame. They are not positions on the module's board outline.");
  else if (!c.board.outline?.same_file) add("board_frame", "Pad positions use the CAD file's own origin. No outline from the same file ties them to the board edge.");

  if (pads.length && !pads.some((p) => p.fn)) {
    add("pin_functions", pads.some((p) => p.net)
      ? "Pads carry CAD net names only. A net name is a label from the design file, not a verified pin function."
      : "Pads have positions but no names or functions.");
  }
  if (!pads.length && !c.pins.length && (c.category === "development_board" || c.category === "sensor" || c.category === "display")) {
    add("pin_functions", `No pin table in the catalog (${pinoutHint}).`);
  }
  const { operating, input } = c.electrical;
  if (!operating && !input) add("supply_voltage", "No operating or input voltage could be read from the spec claims.");
  if (operating?.conflict) add("operating_voltage_conflict", "Sources state operating voltages that do not overlap. Check which applies to this exact part.");
  if (input?.conflict) add("input_voltage_conflict", "Sources state input voltages that do not overlap. Check which applies to this exact part.");
  if (!c.electrical.logic && c.category === "development_board") add("logic_level", "No logic level stated. Do not assume 5 V tolerance.");
  if (!hasRef(["mechanical_drawing", "cad_or_mechanical", "rendered_drawing", "cad_preview", "board_file"])) add("mechanical_reference", "No mechanical drawing or CAD file is cached.");
  if (c.buy_counts.norway + c.buy_counts.international === 0) add("listing", "No shop listing in the catalog; this record comes from documentation only.");
  else if (c.buy_counts.norway === 0) add("norwegian_listing", "No Norwegian listing in the catalog.");
  return m;
}

export function scoreCard(c: Pick<Card, "outline" | "board" | "pins" | "electrical" | "references" | "buy_counts" | "caveats">): number {
  const pads = c.board ? [...c.board.headers, ...c.board.connectors].flatMap((g) => g.pads) : [];
  let s = 0;
  if (c.outline) s += 20;
  if (c.outline?.height_known) s += 10;
  if (pads.length) s += 15;
  if (c.pins.length || pads.some((p) => p.fn || p.net)) s += 10;
  if ((c.electrical.operating || c.electrical.input) && !c.electrical.operating?.conflict && !c.electrical.input?.conflict) s += 15;
  if (c.electrical.interfaces.length || c.electrical.i2c_addresses.length) s += 5;
  if (c.references.some((r) => r.path && ["pinout", "mechanical_drawing", "cad_or_mechanical", "rendered_drawing"].includes(r.kind))) s += 10;
  if (c.buy_counts.norway + c.buy_counts.international > 0) s += 5;
  if (c.buy_counts.norway > 0) s += 5;
  if (!c.caveats.some((x) => x.severity === "warning")) s += 5;
  return s;
}

// ---------------------------------------------------------------------------------------
// Build

class UsageError extends Error {}
class SourceError extends Error {}
class NotFound extends Error {}

function q<T>(db: Database, sql: string, ...params: Cell[]): T[] {
  return db.query(sql).all(...params) as T[];
}

function groupBy<T extends { part_id: string }>(rowsIn: T[]): Map<string, T[]> {
  const m = new Map<string, T[]>();
  for (const r of rowsIn) {
    const list = m.get(r.part_id);
    if (list) list.push(r);
    else m.set(r.part_id, [r]);
  }
  return m;
}

interface PartRow {
  part_id: string;
  name: string;
  brand: string | null;
  manufacturer_part_number: string | null;
  category: string;
  identity_scope: string;
  primary_url: string;
  primary_source_id: number;
  description: string | null;
  variant_count: number;
  selection_rank: number;
  geometry_status: string;
}

export interface BuildReport {
  out: string;
  bytes: number;
  cards: number;
  json_bytes: number;
  stats: Record<string, number>;
}

const CARDS_DDL = `
  CREATE TABLE meta(key TEXT PRIMARY KEY, value TEXT NOT NULL) WITHOUT ROWID;
  -- A rowid table on purpose: WITHOUT ROWID keeps little of a blob in the tree and spills the rest
  -- to overflow pages, which more than doubled the file.
  CREATE TABLE cards(part_id TEXT PRIMARY KEY, card BLOB NOT NULL);
  CREATE TABLE card_index(
    part_id TEXT PRIMARY KEY, name TEXT NOT NULL, brand TEXT, category TEXT NOT NULL, rank INTEGER NOT NULL,
    outline_scope TEXT, dim_min REAL, dim_mid REAL, dim_max REAL, height_known INTEGER NOT NULL,
    header_pads INTEGER NOT NULL, pin_functions INTEGER NOT NULL, supply_min_v REAL, supply_max_v REAL,
    norway_listings INTEGER NOT NULL, listings INTEGER NOT NULL, score INTEGER NOT NULL
  ) WITHOUT ROWID;
  CREATE VIRTUAL TABLE card_fts USING fts5(part_id UNINDEXED, name, brand, category, families, keywords, specifications, tokenize='unicode61 remove_diacritics 2');
`;

export function build(srcPath: string, outPath: string): BuildReport {
  if (!existsSync(srcPath)) throw new SourceError(`catalog not found at ${srcPath}`);
  const src = new Database(srcPath, { readonly: true });
  const tmp = `${outPath}.tmp`;
  rmSync(tmp, { force: true });
  let dst: Database | null = null;
  try {
    const version = (src.query("PRAGMA user_version").get() as { user_version: number }).user_version;
    if (version !== CATALOG_SCHEMA_VERSION) throw new SourceError(`catalog has schema version ${version}; the card generator was written for ${CATALOG_SCHEMA_VERSION}`);

    const parts = q<PartRow>(src, `SELECT part_id, name, brand, manufacturer_part_number, category, identity_scope, primary_url, primary_source_id, description, variant_count, selection_rank, geometry_status FROM parts ORDER BY selection_rank`);
    type P<T> = T & { part_id: string };
    const envelopes = new Map(q<P<EnvelopeRow>>(src, `SELECT * FROM envelopes`).map((e) => [e.part_id, e]));
    const measurements = groupBy(q<P<MeasurementRow>>(src, `SELECT part_id, measurement_id, kind, scope, values_mm_json, axis_labels_json, evidence_text, extraction_status, source_id FROM measurements ORDER BY measurement_id`));
    const specs = groupBy(q<P<SpecRow>>(src, `SELECT part_id, spec_id, domain, key, value_text, source_id, validation_status, claim_scope, value_num, minimum_num, maximum_num, scope_note FROM specifications ORDER BY spec_id`));
    const pinDefs = groupBy(q<P<PinDefRow>>(src, `SELECT part_id, pin_id, connector, pin_number, name, electrical_type_as_source, functions_as_source, source_id, revision, notes FROM pin_definitions ORDER BY pin_id`));
    // coordinate_frame is part of the catalog schema; a cut-down test catalog may leave it out.
    const frameColumn = q<{ name: string }>(src, `PRAGMA table_info(geometry_objects)`).some((c) => c.name === "coordinate_frame") ? "coordinate_frame" : "NULL AS coordinate_frame";
    const geometry = groupBy(q<P<GeometryRow>>(src, `SELECT part_id, geometry_id, kind, source_id, revision, source_url, source_sha256, payload_json, validation_status, ${frameColumn} FROM geometry_objects ORDER BY geometry_id`));
    const assets = groupBy(q<P<AssetRow>>(src, `SELECT a.part_id, a.asset_id, a.kind, a.title, a.url, a.revision, a.applicability_note, f.relative_path, f.sha256, f.byte_count, f.media_type, f.status AS local_status FROM assets a LEFT JOIN asset_files f ON f.url = a.url ORDER BY a.asset_id`));
    const derived = groupBy(q<P<DerivedRow>>(src, `SELECT part_id, kind, title, source_url, relative_path, sha256, byte_count, media_type, derivation_method FROM derived_assets ORDER BY derived_asset_id`));
    const listings = groupBy(q<P<ListingRow>>(src, `SELECT part_id, listing_id, supplier, url, supplier_sku, identity_match, domestic_market, currency, price, price_basis, stock_status, observed_at, source_id FROM listings ORDER BY listing_id`));
    const variants = groupBy(q<P<VariantRow>>(src, `SELECT part_id, supplier, sku, title FROM variants ORDER BY variant_id`));
    const issues = groupBy(q<P<IssueRow>>(src, `SELECT part_id, issue_id, severity, code, detail, source_id FROM data_issues WHERE part_id IS NOT NULL ORDER BY issue_id`));
    const families = groupBy(q<{ part_id: string; family: string }>(src, `SELECT part_id, family FROM family_memberships ORDER BY family`));
    const marketplaceFamilies = new Map(q<{ family: string; n: number }>(src, `SELECT family, count(*) AS n FROM market_evidence WHERE market = 'AliExpress' GROUP BY family`).map((r) => [r.family, r.n]));
    const sources = new Map(q<{ source_id: number; url: string; publisher: string; authority: string; retrieved_at: string }>(src, `SELECT source_id, url, publisher, authority, retrieved_at FROM sources`).map((s) => [s.source_id, s]));
    const fts = new Map(q<{ part_id: string; families: string; specifications: string }>(src, `SELECT part_id, families, specifications FROM parts_fts`).map((f) => [f.part_id, f]));
    const authorityOf = (id: number): string => sources.get(id)?.authority ?? "";
    const seeAlso = readSeeAlso(new Map(q<{ key: string; value: string }>(src, `SELECT key, value FROM metadata WHERE key IN ('product_revision_reference_links', 'product_sku_identity_links')`).map((m) => [m.key, m.value])));
    const noteParts = new Map<string, Set<string>>();
    for (const [partId, list] of issues) {
      for (const i of list) {
        if (i.code !== "source_note") continue;
        const k = noteKey(i.detail);
        const set = noteParts.get(k) ?? new Set<string>();
        noteParts.set(k, set);
        set.add(partId);
      }
    }
    const isBoilerplateNote = (detail: string): boolean => (noteParts.get(noteKey(detail))?.size ?? 0) >= BOILERPLATE_PART_COUNT;

    dst = new Database(tmp, { create: true });
    const out = dst;
    out.exec("PRAGMA page_size = 4096; PRAGMA journal_mode = OFF; PRAGMA synchronous = OFF;");
    out.exec(CARDS_DDL);
    const insCard = out.prepare(`INSERT INTO cards VALUES (?, ?)`);
    const insIndex = out.prepare(`INSERT INTO card_index VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`);
    const insFts = out.prepare(`INSERT INTO card_fts(part_id, name, brand, category, families, keywords, specifications) VALUES (?,?,?,?,?,?,?)`);

    const stats: Record<string, number> = {};
    const bump = (k: string, by = 1): void => void (stats[k] = (stats[k] ?? 0) + by);
    let jsonBytes = 0;

    out.transaction(() => {
      for (const p of parts) {
        const card = buildCard(p, {
          envelope: envelopes.get(p.part_id), measurements: measurements.get(p.part_id) ?? [], specs: specs.get(p.part_id) ?? [],
          pinDefs: pinDefs.get(p.part_id) ?? [], geometry: geometry.get(p.part_id) ?? [], assets: assets.get(p.part_id) ?? [],
          derived: derived.get(p.part_id) ?? [], listings: listings.get(p.part_id) ?? [], variants: variants.get(p.part_id) ?? [],
          issues: issues.get(p.part_id) ?? [], families: (families.get(p.part_id) ?? []).map((f) => f.family),
          marketplaceFamilies, sources, authorityOf, isBoilerplateNote, seeAlso: seeAlso.get(p.part_id) ?? [],
        });
        const json = JSON.stringify(card);
        jsonBytes += json.length;
        insCard.run(p.part_id, Bun.zstdCompressSync(Buffer.from(json), { level: 19 }));

        const dims = card.outline ? card.outline.mm.filter((v): v is number => v != null).sort((a, b) => a - b) : [];
        // Without a known height only the first two source values are an extent: a third value, when present, is a PCB thickness.
        const planar = card.outline ? [card.outline.mm[0], card.outline.mm[1]].sort((a, b) => a - b) : [];
        const groups = card.board ? [...card.board.headers, ...card.board.connectors] : [];
        const pads = groups.flatMap((g) => g.pads);
        const fnCount = pads.filter((x) => x.fn).length + card.pins.reduce((n, g) => n + g.pins.length, 0);
        const whole = card.outline?.height_known ? dims : planar;
        const supply = card.electrical.operating ?? card.electrical.input;
        insIndex.run(
          p.part_id, p.name, p.brand, p.category, p.selection_rank, card.outline?.scope ?? null,
          whole[0] ?? null, whole.length === 3 ? whole[1]! : null, whole[whole.length - 1] ?? null, card.outline?.height_known ? 1 : 0,
          pads.length, fnCount, supply?.min_v ?? null, supply?.max_v ?? null,
          card.buy_counts.norway, card.buy_counts.norway + card.buy_counts.international, card.score,
        );
        const keywords = uniq([
          p.manufacturer_part_number ?? "", ...card.electrical.interfaces, ...card.electrical.i2c_addresses,
          ...Object.values(card.specs).flat().map((c) => c.v), ...groups.map((g) => g.kind.replace(/_/g, " ")),
        ]).join(" ");
        const f = fts.get(p.part_id);
        insFts.run(p.part_id, p.name, p.brand ?? "", p.category.replace(/_/g, " "), f?.families ?? "", keywords, f?.specifications ?? "");

        bump("cards");
        if (card.outline) bump("with_outline");
        if (card.outline?.height_known) bump("with_height");
        if (card.board) bump("with_cad_pads");
        if (card.board?.scope === "board" && card.board.headers.length) bump("with_board_headers");
        if (card.board?.scope === "land_pattern" && card.board.headers.length) bump("with_land_pattern_rows");
        if (card.board?.outline?.same_file) bump("with_pads_tied_to_outline");
        if (card.board?.holes.some((h) => h.mounting)) bump("with_mounting_hole_positions");
        if (pads.some((x) => x.fn)) bump("with_pads_joined_to_functions");
        bump("pads_with_a_function", pads.filter((x) => x.fn).length);
        if (card.board?.derivation === "drawing_callouts") bump("with_pads_from_drawing_callouts");
        if (card.model?.above_pcb_mm != null) bump("with_model_height");
        if (card.model?.openings.length) bump("with_connector_openings");
        if (card.model?.registration) bump("with_model_registered_to_pads");
        if (card.model?.registration?.openings.length) bump("with_openings_in_pad_coordinates");
        if (card.model?.registration?.transform.seen_from_underside) bump("with_model_seen_from_underside");
        if (card.model?.registration?.feature_count === 1) bump("with_registration_resting_on_one_connector");
        if (card.model && card.board && !card.model.registration) bump(`not_registered:${(card.model.registration_note ?? "").replace(/[\d.]+( x [\d.]+)?( and [\d.]+)? mm/g, "N mm").slice(0, 70)}`);
        if (card.see_also.length) bump("with_see_also");
        if (card.electrical.i2c_selected) bump("with_catalog_selected_i2c_address");
        if (card.electrical.operating?.selected || card.electrical.input?.selected || card.electrical.logic?.selected) bump("with_catalog_selected_voltage");
        if (pads.some((x) => x.net)) bump("with_pad_net_names");
        if (card.pins.length) bump("with_pin_table");
        if (supply) bump("with_supply_voltage");
        if (card.electrical.operating?.conflict || card.electrical.input?.conflict) bump("with_supply_conflict");
        if (card.electrical.logic) bump("with_logic_level");
        if (card.electrical.i2c_addresses.length) bump("with_i2c_address");
        if (card.electrical.interfaces.length) bump("with_interfaces");
        if (card.references.some((r) => r.path && (r.kind === "pinout" || r.kind === "rendered_drawing"))) bump("with_cached_pinout_or_drawing");
        if (card.references.some((r) => r.path)) bump("with_any_cached_reference");
        if (card.buy_counts.norway) bump("with_norwegian_listing");
        if (card.buy.length) bump("with_any_listing");
        if (card.caveats.some((x) => x.severity === "warning")) bump("with_warning");
        bump("pads_in_headers_and_connectors", pads.length);
        bump("pads_excluded_as_components", card.board?.excluded.pads ?? 0);
        for (const m of card.missing) bump(`missing:${m.code}`);
      }
    })();

    out.exec(`INSERT INTO card_fts(card_fts) VALUES('optimize')`);
    const meta = out.prepare(`INSERT INTO meta VALUES (?, ?)`);
    const sourceCreated = q<{ value: string }>(src, `SELECT value FROM metadata WHERE key = 'created_at_utc'`)[0]?.value ?? "unknown";
    out.transaction(() => {
      meta.run("card_schema_version", String(CARD_SCHEMA_VERSION));
      meta.run("catalog_schema_version", String(version));
      meta.run("catalog_sha256", createHash("sha256").update(readFileSync(srcPath)).digest("hex"));
      meta.run("catalog_created_at_utc", sourceCreated);
      meta.run("compression", "zstd");
      meta.run("stats", JSON.stringify(stats));
      meta.run("contract", [
        "Every value is a source claim copied from the maker catalog; nothing was physically measured.",
        "Mounting, clearance and tolerance are unverified for every part.",
        "Header, connector and mounting-hole classification is inferred from CAD package names and pad layout; each group states its basis.",
        "Net names are labels from a design file. Pin functions are attached only by the rules named in each function's basis.",
        "Reference paths are relative to the catalog folder and exist only where the full catalog is present.",
        "Prices and stock are point-in-time observations.",
      ].join(" "));
    })();
    out.exec(`PRAGMA user_version = ${CARD_SCHEMA_VERSION}; VACUUM; PRAGMA journal_mode = DELETE;`);
    out.close();
    dst = null;
    renameSync(tmp, outPath);
    return { out: outPath, bytes: statSync(outPath).size, cards: parts.length, json_bytes: jsonBytes, stats };
  } finally {
    dst?.close();
    src.close();
    rmSync(tmp, { force: true });
  }
}

export interface CardInputs {
  envelope: EnvelopeRow | undefined;
  measurements: MeasurementRow[];
  specs: SpecRow[];
  pinDefs: PinDefRow[];
  geometry: GeometryRow[];
  assets: AssetRow[];
  derived: DerivedRow[];
  listings: ListingRow[];
  variants: VariantRow[];
  issues: IssueRow[];
  families: string[];
  marketplaceFamilies: Map<string, number>;
  sources: Map<number, { url: string; publisher: string; authority: string; retrieved_at: string }>;
  authorityOf: (sourceId: number) => string;
  isBoilerplateNote: (detail: string) => boolean;
  seeAlso?: SeeAlso[];
}

export function buildCard(p: PartRow, d: CardInputs): Card {
  const outline = buildOutline(d.envelope);
  const obs = buildObservations(d.measurements, outline);
  const { board, joined } = buildBoardAndJoin(d.geometry, d.pinDefs);
  const model = buildModel(d.geometry, board);
  const { electrical, specs } = distillSpecs(d.specs, d.authorityOf);
  const { caveats, omitted } = buildCaveats(d.issues, d.isBoilerplateNote);
  const { references, counts } = buildReferences(d.assets, d.derived);
  const { buy, norway, international } = buildListings(d.listings, d.variants);
  const variantRequired = (outline?.variant_required ?? false) || d.issues.some((i) => i.code === "variant_selection_required");

  const partial = {
    category: p.category,
    identity: { scope: p.identity_scope, variants: p.variant_count, variant_choice_required: variantRequired, families: d.families, geometry_status: p.geometry_status },
    outline, board,
    // Pin rows that are not already shown on a pad. Rows the catalog bound to a different geometry
    // dataset than the one shown describe that other dataset, so they are left out too.
    pins: buildPins(d.pinDefs.filter((row) => {
      if (joined.has(row.pin_id)) return false;
      const ids = supportedGeometry(row.notes);
      return !board || ids === null || ids.includes(board.geometry_id);
    })),
    electrical, references, caveats,
    buy_counts: { norway, international, family_level_marketplace: d.families.reduce((n, f) => n + (d.marketplaceFamilies.get(f) ?? 0), 0) },
  };
  const card: Card = {
    v: CARD_SCHEMA_VERSION,
    part_id: p.part_id, name: p.name, brand: p.brand, mpn: p.manufacturer_part_number, category: p.category, rank: p.selection_rank,
    url: p.primary_url, description: p.description ? clip(p.description, 320) : null,
    identity: partial.identity,
    outline, outline_observations: obs.outlines, dimensions: obs.dimensions,
    board, model, pins: partial.pins, electrical, specs, see_also: d.seeAlso ?? [],
    caveats, caveats_omitted: omitted,
    references, reference_counts: counts,
    buy, buy_counts: partial.buy_counts,
    missing: buildMissing(partial),
    score: scoreCard(partial),
    sources: {},
  };
  // The outline still lacks a height, but a 3D model has something to say about it.
  if (model?.above_pcb_mm != null) {
    for (const m of card.missing) {
      if (m.code === "height" || m.code === "component_heights") {
        m.detail += ` A 3D model of the board shows ${model.above_pcb_mm} mm above the PCB and ${model.below_pcb_mm ?? "?"} mm below it (nominal model geometry, see model).`;
      }
    }
  }

  const used = new Set<number>([p.primary_source_id]);
  const visit = (v: unknown): void => {
    if (Array.isArray(v)) v.forEach(visit);
    else if (v && typeof v === "object") {
      for (const [k, x] of Object.entries(v)) {
        if (k === "src" && typeof x === "number") used.add(x);
        else if (k !== "sources") visit(x);
      }
    }
  };
  visit(card);
  for (const id of [...used].sort((a, b) => a - b)) {
    const s = d.sources.get(id);
    if (s) card.sources[String(id)] = { url: s.url, publisher: s.publisher, authority: s.authority, retrieved: s.retrieved_at.slice(0, 10) };
  }
  return card;
}

// ---------------------------------------------------------------------------------------
// Reading

export function openCards(path: string): Database {
  if (!existsSync(path)) throw new SourceError(`cards file not found at ${path}; build it with: bun catalog-cards.ts build --src <catalog> --out ${path}`);
  const db = new Database(path, { readonly: true });
  const v = (db.query("PRAGMA user_version").get() as { user_version: number }).user_version;
  if (v !== CARD_SCHEMA_VERSION) {
    db.close();
    throw new SourceError(`cards file has schema version ${v}; this reader expects ${CARD_SCHEMA_VERSION}. Rebuild it.`);
  }
  return db;
}

export function getCard(db: Database, partId: string): Card | null {
  const row = db.query(`SELECT card FROM cards WHERE part_id = ?`).get(partId) as { card: Uint8Array } | null;
  return row ? (JSON.parse(Buffer.from(Bun.zstdDecompressSync(row.card)).toString("utf8")) as Card) : null;
}

export interface FindOptions {
  fits?: [number, number, number];
  includePcb?: boolean;
  norway?: boolean;
  pads?: boolean;
  limit?: number;
}

export interface FindRow {
  part_id: string;
  name: string;
  brand: string | null;
  category: string;
  rank: number;
  outline_scope: string | null;
  dim_min: number | null;
  dim_mid: number | null;
  dim_max: number | null;
  height_known: number;
  header_pads: number;
  pin_functions: number;
  supply_min_v: number | null;
  supply_max_v: number | null;
  norway_listings: number;
  listings: number;
  score: number;
}

export function ftsQuery(text: string, join: "AND" | "OR"): string {
  const tokens = text.toLowerCase().split(/[^\p{L}\p{N}]+/u).filter((t) => t.length > 0);
  return tokens.map((t) => `"${t}"*`).join(` ${join} `);
}

const words = (s: string): string[] => s.toLowerCase().split(/[^\p{L}\p{N}]+/u).filter((t) => t.length > 0);

/**
 * Order full-text candidates so that a part whose name is the query comes before parts that
 * merely mention it. Text relevance alone ranks an adapter "for Raspberry Pi Pico W" above the
 * Pico W, because the accessory repeats the phrase in its spec text.
 *   tier 0  the name is exactly the query
 *   tier 1  the name contains every query word; fewer extra words first, then the fuller card
 *   tier 2  everything else, in text-relevance order
 * `rows` must arrive in text-relevance order.
 */
export function rankByName<T extends { name: string; score: number }>(rows: T[], text: string): T[] {
  const query = words(text);
  if (!query.length) return rows;
  const keyed = rows.map((row, order) => {
    const name = words(row.name);
    const hasAll = query.every((w) => name.includes(w));
    const tier = hasAll && name.length === query.length ? 0 : hasAll ? 1 : 2;
    return { row, order, tier, extra: name.length - query.length };
  });
  return keyed
    .sort((a, b) => a.tier - b.tier || (a.tier < 2 ? a.extra - b.extra || b.row.score - a.row.score : 0) || a.order - b.order)
    .map((k) => k.row);
}

/** How many full-text candidates are re-ranked by name before the limit is applied. */
const CANDIDATE_POOL = 200;

export function findCards(db: Database, text: string, o: FindOptions = {}): { rows: FindRow[]; loose: boolean } {
  const where: string[] = [];
  const params: Cell[] = [];
  if (o.norway) where.push(`i.norway_listings > 0`);
  if (o.pads) where.push(`i.header_pads > 0`);
  if (o.fits) {
    const box = [...o.fits].sort((a, b) => a - b);
    const scopes = ["assembly", "product_unspecified", ...(o.includePcb ? ["pcb", "board_without_headers", "board_assembly_without_headers"] : [])];
    // Only outlines with a known height can be said to fit a box.
    where.push(`i.height_known = 1 AND i.outline_scope IN (${scopes.map(() => "?").join(",")}) AND i.dim_min <= ? AND i.dim_mid <= ? AND i.dim_max <= ?`);
    params.push(...scopes, ...box);
  }
  const run = (match: string | null): FindRow[] => {
    const filters = [...(match ? [`card_fts MATCH ?`] : []), ...where];
    const sql = match
      ? `SELECT i.* FROM card_fts f JOIN card_index i ON i.part_id = f.part_id WHERE ${filters.join(" AND ")} ORDER BY bm25(card_fts, 0, 10, 4, 2, 4, 3, 1), i.rank LIMIT ?`
      : `SELECT i.* FROM card_index i ${filters.length ? `WHERE ${filters.join(" AND ")}` : ""} ORDER BY i.rank LIMIT ?`;
    const limit = o.limit ?? 10;
    if (!match) return q<FindRow>(db, sql, ...params, limit);
    return rankByName(q<FindRow>(db, sql, match, ...params, Math.max(limit, CANDIDATE_POOL)), text).slice(0, limit);
  };
  if (!text.trim()) return { rows: run(null), loose: false };
  const strict = run(ftsQuery(text, "AND"));
  if (strict.length) return { rows: strict, loose: false };
  return { rows: run(ftsQuery(text, "OR")), loose: true };
}

// ---------------------------------------------------------------------------------------
// Rendering for an agent: the whole card in a screen of text

const fmt = (n: number | null): string => (n == null ? "?" : String(round(n, 2)));
const volts = (v: VoltageSummary | null): string =>
  !v ? "not stated" : `${v.min_v === v.max_v ? v.min_v : `${v.min_v}–${v.max_v}`} V${v.selected ? " (catalog-selected claim)" : v.claims.length > 1 && v.min_v !== v.max_v ? " across claims" : ""}${v.conflict ? " (SOURCES CONFLICT)" : ""}`;

export function renderCard(c: Card): string {
  const L: string[] = [];
  const s = (id: number | null): string => (id == null ? "" : ` [${id}]`);
  L.push(`# ${c.name}`, `${c.part_id} | ${c.brand ?? "no brand"}${c.mpn ? ` | ${c.mpn}` : ""} | ${c.category} | rank ${c.rank} | completeness ${c.score}/100`);
  L.push(`identity: ${c.identity.scope}${c.identity.variants > 1 ? `, ${c.identity.variants} variants` : ""}${c.identity.variant_choice_required ? " (CHOOSE THE EXACT VARIANT FIRST)" : ""}${c.identity.families.length ? ` | families: ${c.identity.families.join(", ")}` : ""}`);

  L.push("", "## Outline");
  if (!c.outline) L.push("none selected");
  else {
    const o = c.outline;
    L.push(`${o.mm.map(fmt).join(" x ")} mm${o.axes ? ` (${o.axes.join(", ")})` : " (axes unlabelled, source order)"} | scope ${o.scope}: ${o.scope_meaning}${s(o.src)}`);
    if (!o.height_known) L.push(o.pcb_thickness_mm != null ? `height unknown; ${o.pcb_thickness_mm} mm is the PCB thickness` : "height unknown");
  }
  for (const o of c.outline_observations) {
    const note = o.kind === "model_bounds" ? " | CAD model bounds, never a physical envelope" : o.differs_from_selected ? " | DIFFERS FROM SELECTED" : "";
    L.push(`also: ${o.mm.map(fmt).join(" x ")} mm | ${o.kind} ${o.scope} | ${o.status}${note}${s(o.src)}`);
  }
  for (const o of c.dimensions) L.push(`${o.kind} ${o.scope}: ${o.mm.map(fmt).join(", ")} mm${o.axes ? ` (${o.axes.join(", ")})` : ""} | ${o.status}${s(o.src)}`);

  if (c.model) {
    const m = c.model;
    L.push("", "## 3D model (nominal geometry, not a measurement)");
    L.push(`above the PCB ${m.above_pcb_mm ?? "?"} mm | below ${m.below_pcb_mm ?? "?"} mm | PCB ${m.pcb_thickness_mm ?? "?"} mm thick | ${m.status}${s(m.src)}`);
    if (m.covers) L.push(`covers: ${m.covers}`);
    for (const o of m.openings) {
      L.push(`opening ${o.connector} | edge ${o.edge} | centre ${o.center_along_edge_mm} mm along it | ${o.width_mm} x ${o.height_mm} mm | ${o.lower_above_pcb_mm} to ${o.upper_above_pcb_mm} mm above the PCB${o.overhang_mm ? ` | overhangs ${o.overhang_mm} mm` : ""}`);
    }
    if (m.connectors_without_opening.length) L.push(`no opening identified for: ${m.connectors_without_opening.join(", ")}`);
    if (m.other_models) L.push(`${m.other_models} other model(s) for this part, not merged`);
    if (m.registration) {
      const g = m.registration;
      L.push(`registered to pad dataset #${g.pad_geometry_id}: rotation ${g.transform.rotation_deg} deg${g.transform.seen_from_underside ? ", SEEN FROM THE UNDERSIDE (the model's 'above' is the pad data's underside)" : ""} | matched on ${g.features.map((f) => `${f.ref} ${f.distance_mm} mm`).join(", ")} | ${g.side_evidence ? `top and bottom agree for ${g.side_evidence} connector(s)` : "mirror state decided by positions alone"} | residual ${g.residual_mm} mm, next best ${g.runner_up_residual_mm ?? "none"} mm`);
      if (g.holdout.length) L.push(`check without each connector in turn: ${g.holdout.map((h) => `${h.ref} ${h.distance_mm} mm`).join(", ")}`);
      for (const o of g.openings) L.push(`opening ${o.connector}${o.ref ? ` (${o.ref})` : ""} at ${o.center.join(",")} facing ${o.outward.join(",")} | ${o.width_mm} mm wide | ${o.lower_above_pcb_mm} to ${o.upper_above_pcb_mm} mm above the PCB | ${o.overhang_mm >= 0 ? `${o.overhang_mm} mm beyond` : `${-o.overhang_mm} mm inside`} the outline`);
    } else if (m.registration_note) L.push(`not registered to the pad coordinates: ${m.registration_note}`);
  }

  if (c.board) {
    const b = c.board;
    L.push("", `## Pads (${b.scope === "board" ? "on this board" : "module footprint, footprint-local"})`);
    L.push(`from ${b.source_file ?? b.source_url} | ${b.format ?? "?"} | y ${b.frame.y} | origin: ${b.frame.origin}${s(b.src)}`);
    if (b.derivation === "drawing_callouts") L.push("positions are calculated from the drawing's dimension callouts, not read from a CAD file");
    L.push(b.outline?.same_file ? `rx/ry are offsets from the ${b.derivation === "drawing_callouts" ? "drawing's board extent" : "CAD outline's"} minimum corner; outline extent ${b.outline.extent.join(" x ")} mm` : "no outline from the same file: coordinates are not tied to the board edge");
    if (b.skipped_pads) L.push(`parse incomplete: ${b.skipped_pads} pad(s) skipped`);
    else if (!b.complete) L.push("the source parse does not claim to cover every pad in the file");
    const line = (g: PadGroup): string => {
      const pads = g.pads.map((p) => {
        const at = p.rx != null ? `${p.rx},${p.ry}` : `${p.x},${p.y}`;
        // "Published terminal label: D8; native net: IO8" repeats the name it is shown next to.
        const what = p.fn ? p.fn.functions.replace(/^Published terminal label: [^;]*;?\s*/, "") : "";
        const label = p.fn ? (what && what !== p.fn.name ? `${p.fn.name} = ${what}` : p.fn.name) : (p.net ?? "");
        return `${p.n || "-"}@${at}${label ? ` ${label}` : ""}`;
      });
      return `${g.ref} | ${g.kind} | ${g.package ?? "?"} | ${g.mount} | ${g.rows} row(s)${g.pitch_mm ? `, ${g.pitch_mm} mm pitch` : ""} | basis: ${g.basis.join("; ")}\n  ${pads.join(" | ")}`;
    };
    for (const g of b.headers) L.push(line(g));
    for (const g of b.connectors) L.push(line(g));
    const holeList = (hs: Hole[]): string => hs.map((h) => `${h.rx ?? h.x},${h.ry ?? h.y}${h.drill_mm ? ` ⌀${h.drill_mm}` : ""}`).join(" | ");
    const mounting = b.holes.filter((h) => h.mounting);
    const other = b.holes.filter((h) => !h.mounting);
    if (mounting.length) L.push(`mounting holes: ${holeList(mounting)}`);
    if (other.length) L.push(`other holes, purpose not stated (may locate a connector): ${holeList(other)}`);
    L.push(`left out: ${b.excluded.pads} pad(s) on ${b.excluded.components} component(s) and ${b.excluded.test_points} test point(s)`);
    if (b.other_datasets.length) L.push(`other datasets, not merged: ${b.other_datasets.map((d) => `#${d.geometry_id} ${d.source_file ?? d.kind} (${d.pads} pads)`).join("; ")}`);
  }

  if (c.pins.length) {
    L.push("", "## Pin table");
    for (const g of c.pins) {
      L.push(`${g.connector}${g.revision ? ` (rev ${g.revision})` : ""}${s(g.pins[0]?.src ?? null)}`);
      L.push(`  ${g.pins.map((p) => `${p.n} ${p.name}${p.functions && p.functions !== p.name ? ` = ${p.functions}` : ""}`).join(" | ")}`);
    }
  }

  L.push("", "## Electrical");
  const e = c.electrical;
  const vline = (label: string, v: VoltageSummary | null, always: boolean): void => {
    if (!v && !always) return;
    L.push(`${label}: ${volts(v)}${v ? ` — ${v.claims.slice(0, 3).map((x) => `${x.k} "${x.v}"${x.disputed ? " (disputed)" : ""}${s(x.src)}`).join("; ")}` : ""}`);
  };
  vline("operating voltage", e.operating, true);
  vline("input voltage", e.input, false);
  vline("logic level", e.logic, true);
  vline("output voltage", e.output, false);
  if (e.interfaces.length) L.push(`interfaces: ${e.interfaces.join(", ")}`);
  if (e.i2c_addresses.length) L.push(`I2C address: ${e.i2c_addresses.join(", ")}${e.i2c_selected ? " (catalog-selected, 7-bit)" : e.i2c_claims[0]?.from_feature_text && e.i2c_claims.every((x) => x.from_feature_text) ? " (from prose, not a spec table)" : ""}`);
  else if (e.i2c_selected) L.push(`I2C address: the catalog selected a claim it could not reduce to one number: "${e.i2c_claims[0]?.v ?? ""}"`);
  for (const x of e.current.slice(0, 4)) L.push(`${x.k}: ${x.v}${s(x.src)}`);
  if (Object.keys(c.specs).length) L.push("", "## Specs");
  for (const [slot, claims] of Object.entries(c.specs)) {
    const keyed = uniq(claims.map((x) => x.k)).length > 1;
    L.push(`${slot}: ${claims.map((x) => `${keyed ? `${x.k} ` : ""}${x.v}${x.disputed ? " (disputed)" : ""}${x.silicon ? " (chip capability)" : ""}`).join("; ")}`);
  }

  L.push("", `## Caveats (${c.caveats.length}${c.caveats_omitted ? `, ${c.caveats_omitted} more notes omitted` : ""})`);
  for (const x of c.caveats) L.push(`${x.severity} ${x.code}: ${x.text}${s(x.src)}`);
  if (!c.caveats.length) L.push("none recorded");

  L.push("", "## References");
  for (const r of c.references) L.push(`${r.kind} | ${r.path ? `LOCAL ${r.path}` : "not cached"} | ${r.title ?? ""} | ${r.url}`);
  if (!c.references.length) L.push("none");

  L.push("", `## Buy (Norway ${c.buy_counts.norway}, elsewhere ${c.buy_counts.international})`);
  for (const b of c.buy) L.push(`${b.supplier}${b.market ? ` (${b.market})` : ""} | ${b.price ?? "?"} ${b.currency ?? ""} ${b.basis} | ${b.stock} | ${b.variant ?? ""} | ${b.url} | seen ${b.observed}`);
  if (c.buy_counts.family_level_marketplace) L.push(`AliExpress: ${c.buy_counts.family_level_marketplace} family-level listing(s) in the catalog; a clone does not inherit this part's dimensions`);

  if (c.see_also.length) {
    L.push("", "## See also (same marketed product; nothing is inherited, the hardware revision is not verified)");
    for (const x of c.see_also) L.push(`${x.part_id} | ${x.relation} | ${x.identity_status}${x.holds_geometry ? " | holds geometry" : ""}`);
  }

  L.push("", "## Not in the catalog");
  for (const m of c.missing) L.push(`${m.code}: ${m.detail}`);
  if (!c.missing.length) L.push("nothing flagged");

  L.push("", "## Sources");
  for (const [id, x] of Object.entries(c.sources)) L.push(`[${id}] ${x.publisher} (${x.authority}, ${x.retrieved}) ${x.url}`);
  return L.join("\n");
}

export function renderFind(rows: FindRow[], loose: boolean): string {
  if (!rows.length) return "no match";
  const L = loose ? ["no part matched every word; showing parts that match any of them"] : [];
  for (const r of rows) {
    const dims = [r.dim_min, r.dim_mid, r.dim_max].filter((v): v is number => v != null);
    L.push([
      r.part_id, r.brand ?? "no brand", r.name,
      dims.length ? `${dims.map(fmt).join(" x ")} mm (${r.outline_scope}${r.height_known ? "" : ", height unknown"}; sorted, not the source's axis order)` : "no outline",
      r.header_pads ? `${r.header_pads} pads with coordinates` : "no pad coordinates",
      r.pin_functions ? `${r.pin_functions} pin functions` : "no pin functions",
      r.supply_min_v != null ? `${r.supply_min_v === r.supply_max_v ? r.supply_min_v : `${r.supply_min_v}–${r.supply_max_v}`} V` : "supply not stated",
      `Norway ${r.norway_listings}`, `completeness ${r.score}`,
    ].join(" | "));
  }
  return L.join("\n");
}

// ---------------------------------------------------------------------------------------
// CLI

if (import.meta.main) {
  const argv = process.argv.slice(2);
  const cmd = argv.shift();
  const flags = new Map<string, string[]>();
  const positional: string[] = [];
  const ARITY: Record<string, number> = { "--src": 1, "--out": 1, "--db": 1, "--limit": 1, "--fits": 3, "--json": 0, "--norway": 0, "--pads": 0, "--include-pcb": 0 };
  try {
    for (let i = 0; i < argv.length; i++) {
      const a = argv[i]!;
      if (a.startsWith("--")) {
        const n = ARITY[a];
        if (n === undefined) throw new UsageError(`unknown flag ${a}`);
        const vals = argv.slice(i + 1, i + 1 + n);
        if (vals.length < n) throw new UsageError(`${a} needs ${n} value(s)`);
        flags.set(a, vals);
        i += n;
      } else positional.push(a);
    }
    const one = (f: string): string | undefined => flags.get(f)?.[0];
    const dbPath = (): string => {
      const p = one("--db") ?? process.env.BENCHTOP_CARDS;
      if (!p) throw new UsageError("no cards file: pass --db or set BENCHTOP_CARDS");
      return resolve(p);
    };
    if (cmd === "build") {
      const srcPath = one("--src") ?? process.env.BENCHTOP_CATALOG;
      const outPath = one("--out");
      if (!srcPath || !outPath) throw new UsageError("build needs --src <maker_catalog.sqlite> (or BENCHTOP_CATALOG) and --out <maker_cards.sqlite>");
      if (resolve(srcPath) === resolve(outPath)) throw new UsageError("--out must not be the catalog");
      const r = build(resolve(srcPath), resolve(outPath));
      console.log(`wrote ${r.out}: ${r.cards} cards, ${(r.bytes / 1048576).toFixed(2)} MB (${(r.json_bytes / 1048576).toFixed(1)} MB of JSON before compression)`);
      for (const [k, n] of Object.entries(r.stats)) console.log(`${k}: ${n}`);
    } else if (cmd === "show") {
      if (!positional[0]) throw new UsageError("show needs a part id");
      const db = openCards(dbPath());
      const card = getCard(db, positional[0]);
      db.close();
      if (!card) throw new NotFound(`no card for ${positional[0]}`);
      console.log(flags.has("--json") ? JSON.stringify(card, null, 2) : renderCard(card));
    } else if (cmd === "find") {
      const db = openCards(dbPath());
      const fits = flags.get("--fits")?.map(Number);
      if (fits && fits.some((n) => !(n > 0))) throw new UsageError("--fits needs three positive numbers in mm");
      const r = findCards(db, positional.join(" "), {
        fits: fits as [number, number, number] | undefined, includePcb: flags.has("--include-pcb"),
        norway: flags.has("--norway"), pads: flags.has("--pads"), limit: one("--limit") ? Number(one("--limit")) : undefined,
      });
      db.close();
      console.log(flags.has("--json") ? JSON.stringify(r, null, 2) : renderFind(r.rows, r.loose));
    } else if (cmd === "stats") {
      const db = openCards(dbPath());
      const meta = Object.fromEntries(q<{ key: string; value: string }>(db, `SELECT key, value FROM meta`).map((m) => [m.key, m.value]));
      db.close();
      for (const [k, v] of Object.entries(meta)) if (k !== "stats") console.log(`${k}: ${v}`);
      for (const [k, n] of Object.entries(JSON.parse(meta.stats ?? "{}") as Record<string, number>)) console.log(`${k}: ${n}`);
    } else throw new UsageError("usage: bun catalog-cards.ts <build|show|find|stats> ...");
  } catch (e) {
    console.error(e instanceof Error ? e.message : String(e));
    process.exit(e instanceof UsageError ? 2 : e instanceof SourceError ? 3 : e instanceof NotFound ? 1 : 1);
  }
}
