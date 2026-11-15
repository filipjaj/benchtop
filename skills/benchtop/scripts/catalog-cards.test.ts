import { Database } from "bun:sqlite";
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  build, buildBoard, buildBoardAndJoin, buildCaveats, buildListings, buildMissing, buildModel, buildObservations, buildOutline, buildReferences, readSeeAlso,
  classifyGroup, distillSpecs, findCards, getCard, joinPinFunctions, openCards, parseI2cAddresses, parseInterfaces, parseMilliamps,
  parseVolts, pickDataset, rankByName, renderCard, rowShape, slotOf, supportedGeometry, voltageSummary,
  type AssetRow, type Claim, type GeometryRow, type MeasurementRow, type PadGroup, type PinDefRow, type RawPad, type SpecRow,
} from "./catalog-cards";

// ---------------------------------------------------------------------------------------
// Text parsing. Every input below is a value that occurs in the catalog.

describe("parseVolts", () => {
  const cases: [string, number[]][] = [
    ["3V-3.6V", [3, 3.6]],
    ["5.0V ± 0.3V", [5]],
    ["4,5–24V DC", [4.5, 24]],
    ["3,3 til 5,5 V DC", [3.3, 5.5]],
    ["3.3V – 5.0V DC", [3.3, 5]],
    ["DC 3.3V~5V", [3.3, 5]],
    ["2.15~5.5V", [2.15, 5.5]],
    ["5V @ 500mA", [5]],
    ["Inngangseffekt, 1,8V til 3,3V.", [1.8, 3.3]],
    ["3.3V / 5V", [3.3, 5]],
    ["3V3", [3.3]],
    ["0.5W@24V", [24]],
    ["5V, passer til de fleste prosjekter.", [5]],
    ["200 mV ripple", []],
    ["250VAC", []],
    ["USB-C", []],
  ];
  for (const [text, want] of cases) test(text, () => expect(parseVolts(text)).toEqual(want));
});

test("parseMilliamps converts amps and microamps", () => {
  expect(parseMilliamps("65mA (Typical)")).toEqual([65]);
  expect(parseMilliamps("2 A per kanal")).toEqual([2000]);
  expect(parseMilliamps("200μA")).toEqual([0.2]);
  expect(parseMilliamps("0.5W@24V")).toEqual([]);
});

test("parseI2cAddresses keeps 7-bit hex addresses only", () => {
  expect(parseI2cAddresses("0x47 (Default) / 0x46")).toEqual(["0x47", "0x46"]);
  expect(parseI2cAddresses("0x70 (0x71, 0x72, 0x73)")).toEqual(["0x70", "0x71", "0x72", "0x73"]);
  expect(parseI2cAddresses("register 0xFF")).toEqual([]);
  expect(parseI2cAddresses("3")).toEqual([]);
});

test("parseInterfaces does not read the word 'can' as CAN bus", () => {
  expect(parseInterfaces("I2C Communication @0x35")).toEqual(["I2C"]);
  expect(parseInterfaces("You can use it with SPI")).toEqual(["SPI"]);
  expect(parseInterfaces("CAN bus, UART")).toEqual(["UART", "CAN"]);
});

test("slotOf maps English and Norwegian keys, and skips pin-table rows", () => {
  expect(slotOf("driftsspenning")).toBe("operating");
  expect(slotOf("operating_voltage")).toBe("operating");
  expect(slotOf("driftsspenning_logikkniv")).toBe("logic");
  expect(slotOf("power_i_o_voltage")).toBe("logic");
  expect(slotOf("input_voltage")).toBe("input");
  expect(slotOf("str_mforsyning")).toBe("input");
  expect(slotOf("maks_str_m")).toBe("current");
  expect(slotOf("i2c_address")).toBe("i2c");
  expect(slotOf("1_vcc")).toBeNull();
  expect(slotOf("vcc")).toBeNull();
  expect(slotOf("product_name")).toBeNull();
});

// ---------------------------------------------------------------------------------------
// Electrical summary

let specId = 0;
const spec = (key: string, value: string, source = 1, extra: Partial<SpecRow> = {}): SpecRow => ({
  spec_id: ++specId, domain: "electrical", key, value_text: value, source_id: source,
  validation_status: "source_claim_not_independently_verified", claim_scope: "unspecified", ...extra,
});
const authority = (id: number): string => (id === 1 ? "manufacturer_claim" : "specialist_retailer_claim");

describe("distillSpecs", () => {
  test("an Uno runs at 5 V and accepts 7-12 V: two facts, not a conflict", () => {
    const { electrical } = distillSpecs([spec("input_voltage", "7-12V"), spec("operating_voltage", "5V"), spec("power_i_o_voltage", "5V")], authority);
    expect(electrical.input).toMatchObject({ min_v: 7, max_v: 12, conflict: false });
    expect(electrical.operating).toMatchObject({ min_v: 5, max_v: 5, conflict: false });
    expect(electrical.logic?.min_v).toBe(5);
  });

  test("the same key with ranges that do not overlap is a conflict", () => {
    const { electrical } = distillSpecs([spec("operating_voltage", "3.3V", 1), spec("operating_voltage", "5V", 2)], authority);
    expect(electrical.operating).toMatchObject({ min_v: 3.3, max_v: 5, conflict: true });
  });

  test("synonym keys are compared; overlapping ranges agree", () => {
    expect(distillSpecs([spec("supply_voltage", "3.3V～5.5V"), spec("operating_voltage", "3.0V")], authority).electrical.operating?.conflict).toBe(true);
    expect(distillSpecs([spec("driftsspenning", "3,3–5 V"), spec("operating_voltage", "3.3V")], authority).electrical.operating?.conflict).toBe(false);
  });

  test("keys naming different pins are not compared", () => {
    const { electrical } = distillSpecs([spec("power_input_voltage_vin", "6 - 21 V"), spec("power_input_voltage_5v", "5 V")], authority);
    expect(electrical.input).toMatchObject({ min_v: 5, max_v: 21, conflict: false });
  });

  test("a disputed claim is kept but does not set the range", () => {
    const { electrical } = distillSpecs([spec("operating_voltage", "3.3V"), spec("operating_voltage", "12V", 2, { validation_status: "disputed_source_claim" })], authority);
    expect(electrical.operating).toMatchObject({ min_v: 3.3, max_v: 3.3, conflict: false });
    expect(electrical.operating?.claims.find((c) => c.v === "12V")?.disputed).toBe(true);
  });

  test("a claim without a readable voltage is not a voltage claim", () => {
    expect(distillSpecs([spec("operating_voltage", "USB powered")], authority).electrical.operating).toBeNull();
  });

  test("I2C address comes from a spec table; prose is the fallback only", () => {
    const table = distillSpecs([spec("i2c_address", "0x76 (0x77 alternate)"), spec("feature", "I2C address 0x40 on the companion chip")], authority).electrical;
    expect(table.i2c_addresses).toEqual(["0x76", "0x77"]);
    const prose = distillSpecs([spec("feature", "Default I2C address is 0x3C")], authority).electrical;
    expect(prose.i2c_addresses).toEqual(["0x3C"]);
    expect(prose.i2c_claims[0]?.from_feature_text).toBe(true);
    expect(distillSpecs([spec("feature", "Colour code 0x3C for the LED")], authority).electrical.i2c_addresses).toEqual([]);
  });

  test("manufacturer claims come before retailer claims; repeats are counted once", () => {
    const { specs } = distillSpecs([spec("mcu", "ESP32-S3", 2), spec("mcu", "ESP32-S3FN8", 1), spec("mcu", "ESP32-S3", 2)], authority);
    expect(specs.mcu?.map((c: Claim) => [c.v, c.n])).toEqual([["ESP32-S3FN8", 1], ["ESP32-S3", 2]]);
  });

  test("interfaces are read from interface keys, not from prose", () => {
    const { electrical } = distillSpecs([spec("communication_interface", "I2C / SPI"), spec("feature", "Works great over UART too")], authority);
    expect(electrical.interfaces).toEqual(["I2C", "SPI"]);
  });
});

test("voltageSummary is null when no claim has a voltage", () => {
  expect(voltageSummary([])).toBeNull();
});

// ---------------------------------------------------------------------------------------
// Pad classification. Package names below are real ones from the catalog's CAD files.

const th = (n: number, x: number, y: number, extra: Partial<RawPad> = {}): RawPad => ({ pad_number: String(n), x_mm: x, y_mm: y, pad_type: "through_hole", ...extra });
const row = (count: number, pitch = 2.54): RawPad[] => Array.from({ length: count }, (_, i) => th(i + 1, i * pitch, 0));

describe("classifyGroup", () => {
  const byPackage: [string, string, string][] = [
    ["1X08", "header", "pin_header"],
    ["2X03", "header", "pin_header"],
    ["1X08_SMD_COMBINED", "header", "pin_header"],
    ["1X15-CASTELL", "header", "castellated_edge"],
    ["H7-HALF-HOLE-2.54", "header", "castellated_edge"],
    ["PINHEAD_2X05_127", "header", "pin_header"],
    ["Connector:H7-2.54", "header", "pin_header"],
    ["HEAD17-NOSS", "header", "pin_header"],
    ["MLCCs:XIAO_Socket", "header", "pin_header"],
    ["HDR1X22", "header", "pin_header"],
    // Body sizes that look like rows-by-pins must not become headers.
    ["CRYSTAL_2.5X2", "component", "component"],
    ["BTN_KMR2_4.6X2.8", "component", "component"],
    ["SW4-SMD-2.8-2.6X1.6X0.53MM", "component", "component"],
    ["RESONATOR-SMD-3.2X1.3", "component", "component"],
    ["INDUCTOR_5X5MM_NR5040_NOTHERMALS", "component", "component"],
    ["2X3DFN", "component", "component"],
    ["SMA-DIODE", "component", "component"],
    ["LED_5MM_NOSILK", "component", "component"],
    ["DIL28-3", "component", "ic"],
    ["MLCCs:QFN-16-EP_3x3mm_P0.5mm_EP1x1mm", "component", "ic"],
    ["Ic:DFN6-0.5-1.5X1.5X0.65MM", "component", "ic"],
    ["USON8_4X4", "component", "ic"],
    ["FIDUCIAL_1MM", "component", "ignored"],
    ["PN61729", "connector", "usb"],
    ["ZX62-AB-5PA", "connector", "usb"],
    ["MLCCs:USB2.0-TYPE-C", "connector", "usb"],
    ["JST_SH4", "connector", "jst_sh_4pin"],
    ["1X04_1MM_RA", "connector", "jst_sh_4pin"],
    ["JSTPH2_BATT", "connector", "jst"],
    ["POWERSUPPLY_DC-21MM", "connector", "dc_jack"],
    ["MICROSD", "connector", "sd_card"],
    ["EYE_SPI_DISPLAY_BOTCONTACT", "connector", "flat_cable"],
    ["U.FL-R-SMT-1(60)/NO_CREAM", "connector", "rf"],
    ["TERMBLOCK_1X3-3.5MM", "connector", "terminal_block"],
    ["MOUNTINGHOLE_2.5_PLATED", "mounting_hole", "mounting_hole"],
    ["SMT_NUT_3MM", "mounting_hole", "mounting_hole"],
    ["TP-1.00MM", "test_point", "test_point"],
    ["2X03-TP1", "test_point", "test_point"],
    ["Misc:TP-D35MIL", "test_point", "test_point"],
  ];
  for (const [pkg, cls, kind] of byPackage) {
    test(pkg, () => expect(classifyGroup("U$1", pkg, row(3))).toMatchObject({ cls, kind }));
  }

  test("without a telling package, a connector-style reference on a header pitch is a header", () => {
    expect(classifyGroup("IOH", "CUSTOM_FP", row(10))).toMatchObject({ cls: "header", basis: ["reference IOH", "2.54 mm pitch"] });
    expect(classifyGroup("J4", "CUSTOM_FP", row(4))).toMatchObject({ cls: "header" });
  });

  test("a component reference on a header pitch stays a component", () => {
    expect(classifyGroup("U3", "CUSTOM_FP", row(8))).toMatchObject({ cls: "component" });
    // A word reference on a header pitch, but the package says what it is (SparkFun SEN-15050).
    expect(classifyGroup("BULB3", "LED_5MM_NOSILK", row(2))).toMatchObject({ cls: "component", basis: ["package LED_5MM_NOSILK"] });
    for (const pkg of ["CAP_PTH_5MM", "RES-PTH-0.4", "DIODE_DO35", "XTAL-HC49", "POT_9MM", "FUSE5X20", "TACT_6MM", "BUZZ_12MM"]) {
      expect(classifyGroup("PART", pkg, row(2))).toMatchObject({ cls: "component" });
    }
    // Words that only start like a discrete part: the reference and pitch still decide.
    for (const pkg of ["CAPTOUCH_PADS", "RESET_PADS", "SWD-CONTACTS", "POTTED_MODULE"]) {
      expect(classifyGroup("IOH", pkg, row(6))).toMatchObject({ cls: "header" });
    }
    expect(classifyGroup("IOH", "CUSTOM_FP", row(4, 1.7))).toMatchObject({ cls: "component" });
  });

  test("an unrecognised package on a J reference is reported as an unidentified connector", () => {
    const smd = row(6, 0.5).map((p) => ({ ...p, pad_type: "smd" }));
    expect(classifyGroup("J3", "SOMETHING_NEW", smd)).toMatchObject({ cls: "connector", kind: "unidentified" });
  });

  test("an unplated hole is a hole whose purpose the source does not state", () => {
    expect(classifyGroup("H1", null, [th(1, 0, 0, { pad_type: "np_thru_hole" })])).toMatchObject({ cls: "mounting_hole", kind: "unplated_hole" });
  });
});

describe("rowShape", () => {
  test("a single row", () => expect(rowShape(row(4).map((p) => ({ x: p.x_mm!, y: p.y_mm! })))).toEqual({ rows: 1, pitch_mm: 2.54, along: "x" }));
  test("a 2x3 block, as on an ICSP header", () => {
    const pts = [0, 2.54, 5.08].flatMap((y) => [{ x: 63.627, y }, { x: 66.167, y }]);
    expect(rowShape(pts)).toEqual({ rows: 2, pitch_mm: 2.54, along: "y" });
  });
  test("a gap of two pitches still counts as one pitch", () => expect(rowShape([{ x: 0, y: 0 }, { x: 2.54, y: 0 }, { x: 7.62, y: 0 }]).pitch_mm).toBe(2.54));
  test("uneven spacing has no pitch", () => expect(rowShape([{ x: 0, y: 0 }, { x: 2.54, y: 0 }, { x: 6, y: 0 }]).pitch_mm).toBeNull());
  test("scattered pads form no rows", () => expect(rowShape([{ x: 0, y: 0 }, { x: 3, y: 4 }, { x: 7, y: 1 }]).rows).toBe(0));
});

test("pickDataset prefers a placed board, then a full parse, then more pads", () => {
  const sets = [
    { geometry_id: 1, kind: "module_land_pattern", validation_status: "ok", pads: 90 },
    { geometry_id: 2, kind: "pcb_pad_centers", validation_status: "parser_derived_partial_native_pad_centers", pads: 300 },
    { geometry_id: 3, kind: "pcb_pad_centers", validation_status: "parser_derived_native_pad_centers", pads: 120 },
    { geometry_id: 4, kind: "pcb_pad_centers", validation_status: "parser_derived_native_pad_centers", pads: 200 },
  ];
  expect(pickDataset(sets)?.geometry_id).toBe(4);
  expect(pickDataset([])).toBeNull();
});

// ---------------------------------------------------------------------------------------
// Joining pin functions to pads

const def = (id: number, connector: string, pin: string, name: string, functions = ""): PinDefRow => ({
  pin_id: id, connector, pin_number: pin, name, electrical_type_as_source: null, functions_as_source: functions, source_id: 9, revision: null,
});
const group = (ref: string, pads: { n: string; net?: string }[]): PadGroup => ({
  ref, package: null, kind: "pin_header", basis: [], mount: "through_hole", side: "top", rows: 1, pitch_mm: 2.54, along: "x",
  pads: pads.map((p, i) => ({ ...p, x: i * 2.54, y: 0 })),
});

describe("joinPinFunctions", () => {
  test("connector and pin number match first", () => {
    const g = group("J1", [{ n: "1" }, { n: "2" }]);
    const joined = joinPinFunctions([g], [def(1, "J1", "1", "3V3", "3.3 V power supply"), def(2, "J1", "2", "RST"), def(3, "J3", "1", "G")], "board");
    expect(g.pads.map((p) => p.fn?.name)).toEqual(["3V3", "RST"]);
    expect(g.pads[0]!.fn?.basis).toBe("connector_and_pin_number");
    expect([...joined]).toEqual([1, 2]);
  });

  test("a net name joins only when it equals a pin name that occurs once", () => {
    const g = group("HDR", [{ n: "1", net: "GPIO4" }, { n: "2", net: "GND" }, { n: "3", net: "IO17" }]);
    joinPinFunctions([g], [def(1, "J1", "4", "GPIO4", "ADC"), def(2, "J1", "1", "GND"), def(3, "J3", "1", "GND"), def(4, "J1", "9", "17", "GPIO17")], "board");
    expect(g.pads[0]!.fn).toMatchObject({ name: "GPIO4", basis: "net_name_equals_pin_name" });
    // GND names two pins, so it cannot say which one this pad is.
    expect(g.pads[1]!.fn).toBeUndefined();
    // "IO17" is not "17": no fuzzy matching.
    expect(g.pads[2]!.fn).toBeUndefined();
  });

  test("module pin numbers join on a land pattern with a single pin table, never on a board", () => {
    const defs = [def(1, "40 external pins", "1", "GP0", "UART0 TX"), def(2, "40 external pins", "2", "GP1")];
    const land = group("module:row1", [{ n: "1" }, { n: "2" }]);
    joinPinFunctions([land], defs, "land_pattern");
    expect(land.pads.map((p) => [p.fn?.name, p.fn?.basis])).toEqual([["GP0", "module_pin_number"], ["GP1", "module_pin_number"]]);

    const board = group("U7", [{ n: "1" }]);
    joinPinFunctions([board], defs, "board");
    expect(board.pads[0]!.fn).toBeUndefined();

    const twoTables = group("module:row1", [{ n: "1" }]);
    joinPinFunctions([twoTables], [def(1, "J1", "1", "3V3"), def(2, "J3", "1", "G")], "land_pattern");
    expect(twoTables.pads[0]!.fn).toBeUndefined();
  });
});

const boundDef = (id: number, connector: string, pin: string, name: string, geometry: number[], functions = ""): PinDefRow => ({
  ...def(id, connector, pin, name, functions), notes: JSON.stringify({ supported_geometry_ids: geometry, join_rule: "connector=reference, pin_number=pad_number" }),
});

test("supportedGeometry reads the catalog's binding and ignores free-text notes", () => {
  expect(supportedGeometry(JSON.stringify({ supported_geometry_ids: [74, 75] }))).toEqual([74, 75]);
  expect(supportedGeometry(JSON.stringify({ note: "no binding here" }))).toBeNull();
  expect(supportedGeometry("Manual transcription of Figure 2")).toBeNull();
  expect(supportedGeometry(null)).toBeNull();
});

describe("joinPinFunctions with rows the catalog bound to a geometry dataset", () => {
  test("a bound row is used for its own dataset and never for another", () => {
    const defs = [boundDef(1, "AD", "1", "A0", [74], "Published terminal label: A0; native net: AD0"), boundDef(2, "AD", "1", "A0-old", [12])];
    const mine = group("AD", [{ n: "1", net: "AD0" }]);
    expect([...joinPinFunctions([mine], defs, "board", 74)]).toEqual([1]);
    expect(mine.pads[0]!.fn).toMatchObject({ name: "A0", basis: "catalog_geometry_binding" });

    const other = group("AD", [{ n: "1", net: "AD0" }]);
    joinPinFunctions([other], defs, "board", 99);
    expect(other.pads[0]!.fn).toBeUndefined();
  });

  test("a bound row beats this generator's own rules for the same pad", () => {
    const g = group("J1", [{ n: "1" }]);
    joinPinFunctions([g], [def(1, "J1", "1", "legacy name"), boundDef(2, "J1", "1", "3V3", [139], "3.3 V power supply")], "board", 139);
    expect(g.pads[0]!.fn).toMatchObject({ name: "3V3", basis: "catalog_geometry_binding" });
  });

  test("on a module footprint only rows with connector 'module' bind, by pad number", () => {
    const g = group("U2:row1", [{ n: "1" }, { n: "2" }]);
    joinPinFunctions([g], [boundDef(1, "module", "1", "GPIO0", [86], "GPIO0"), boundDef(2, "J9", "2", "wrong", [86])], "land_pattern", 86);
    expect(g.pads.map((p) => p.fn?.name)).toEqual(["GPIO0", undefined]);
  });

  test("when a bound module row only repeats the pin name, the module's own pin table says what the pin does", () => {
    const g = group("U2:row1", [{ n: "1" }, { n: "3" }]);
    const defs = [
      boundDef(1, "module", "1", "GPIO0", [86], "GPIO0"), boundDef(2, "module", "3", "GND", [86], "GND"),
      def(3, "40 external pins (Figure 2)", "1", "GP0", "UART0 TX [default]; I2C0 SDA"), def(4, "40 external pins (Figure 2)", "3", "GND", ""),
    ];
    const joined = joinPinFunctions([g], defs, "land_pattern", 86);
    expect(g.pads[0]!.fn).toEqual({
      name: "GPIO0", functions: "UART0 TX [default]; I2C0 SDA", type: null, basis: "catalog_geometry_binding", src: 9,
      functions_from: { connector: "40 external pins (Figure 2)", src: 9 },
    });
    // The table has nothing to add for ground, so the bound row stands as it is.
    expect(g.pads[1]!.fn).toMatchObject({ name: "GND", functions: "GND" });
    expect(g.pads[1]!.fn!.functions_from).toBeUndefined();
    // All four rows are accounted for, so the pin table is not printed again.
    expect([...joined].sort()).toEqual([1, 2, 3, 4]);
  });
});

test("pickDataset prefers the dataset the catalog published pin rows for", () => {
  const sets = [
    { geometry_id: 1, kind: "pcb_pad_centers", validation_status: "parser_derived_native_pad_centers", pads: 300, bound: false },
    { geometry_id: 2, kind: "pcb_pad_centers", validation_status: "parser_derived_native_pad_centers", pads: 120, bound: true },
  ];
  expect(pickDataset(sets)?.geometry_id).toBe(2);
});

describe("voltage claims the catalog selected", () => {
  const selected = (key: string, value: string, nums: Partial<SpecRow>): SpecRow => spec(key, value, 1, { scope_note: JSON.stringify({ canonical_voltage: true }), ...nums });

  test("a selected claim sets the range; other claims stay listed after it", () => {
    const { electrical } = distillSpecs([spec("operating_voltage", "5V", 2), selected("operating_voltage", "3.3V", { value_num: 3.3 })], authority);
    expect(electrical.operating).toMatchObject({ min_v: 3.3, max_v: 3.3, conflict: false, selected: true });
    expect(electrical.operating!.claims.map((c) => [c.v, c.selected ?? false])).toEqual([["3.3V", true], ["5V", false]]);
  });

  test("numeric limits from the catalog are used as given, not re-read from the text", () => {
    const { electrical } = distillSpecs([selected("input_voltage", "see the power chapter", { minimum_num: 7, maximum_num: 12 })], authority);
    expect(electrical.input).toMatchObject({ min_v: 7, max_v: 12, selected: true });
  });

  test("a nominal value alone is a single point", () => {
    expect(distillSpecs([selected("logic_level", "3.3 V logic", { value_num: 3.3 })], authority).electrical.logic).toMatchObject({ min_v: 3.3, max_v: 3.3 });
  });

  test("without a selection the range spans every readable claim, and says so", () => {
    expect(distillSpecs([spec("operating_voltage", "3.3-5V")], authority).electrical.operating).toMatchObject({ min_v: 3.3, max_v: 5, selected: false });
  });
});

// ---------------------------------------------------------------------------------------
// Board geometry from CAD payloads

const geo = (id: number, kind: string, payload: object, sha = "sha-board", status = "parser_derived_native_pad_centers_not_physical_fit_verified"): GeometryRow => ({
  geometry_id: id, kind, source_id: 7, revision: "rev A", source_url: `https://example.test/files/board-${id}.brd`, source_sha256: sha,
  payload_json: JSON.stringify(payload), validation_status: status,
});
const header = (ref: string, pkg: string, count: number, x0: number, y: number, nets: string[] = []): RawPad[] =>
  Array.from({ length: count }, (_, i) => ({ reference: ref, package: pkg, pad_number: String(i + 1), x_mm: x0 + i * 2.54, y_mm: y, pad_type: "through_hole", footprint_side: "top", net_name: nets[i] ?? null }));

const BOARD_PADS: RawPad[] = [
  ...header("POWER", "1X04", 4, 12.54, 12.54, ["+5V", "GND", "VIN", ""]),
  ...header("AD", "1X03", 3, 30, 12.54, ["AD0", "AD1", "AD2"]),
  { reference: "X2", package: "PN61729", pad_number: "1", x_mm: 5, y_mm: 30, pad_type: "through_hole", net_name: "D+" },
  { reference: "X2", package: "PN61729", pad_number: "2", x_mm: 7.5, y_mm: 30, pad_type: "through_hole", net_name: "D-" },
  { reference: "U$1", package: "MOUNTINGHOLE_2.5_PLATED", pad_number: "P$1", x_mm: 12.54, y_mm: 60, pad_type: "through_hole", drill_mm: 2.5 },
  { reference: "ZU4", package: "DIL28-3", pad_number: "1", x_mm: 40, y_mm: 40, pad_type: "through_hole", net_name: "RESET" },
  { reference: "ZU4", package: "DIL28-3", pad_number: "2", x_mm: 42.54, y_mm: 40, pad_type: "through_hole", net_name: "IO0" },
  { reference: "C1", package: "0805", pad_number: "1", x_mm: 20, y_mm: 20, pad_type: "smd" },
  { reference: "TP1", package: "TP-1.00MM", pad_number: "1", x_mm: 22, y_mm: 22, pad_type: "smd" },
];
const padPayload = { format: "eagle_xml", archive_member: "files/BOARD.brd", frame: { units: "mm", x_direction: "right", y_direction: "up", view: "top" }, completeness: { complete_for_all_placed_pad_instances: true }, skipped_pads: [], pads: BOARD_PADS };
const outlinePayload = { outline_bounds: { min_mm: [10, 10], max_mm: [78.6, 63.4], extent_mm: [68.6, 53.4] }, explicit_holes: [{ x_mm: 76, y_mm: 12, drill_mm: 3.2 }], plated_package_pad_holes: [{ placement_origin_mm: [12.54, 60], local_xy_mm: [0, 0], drill_mm: 2.5, package: "MOUNTINGHOLE_2.5_PLATED" }] };

describe("buildBoard", () => {
  test("keeps headers and connectors, lists holes, and counts what it leaves out", () => {
    const b = buildBoard([geo(1, "pcb_pad_centers", padPayload)], [])!;
    expect(b.scope).toBe("board");
    expect(b.headers.map((h) => [h.ref, h.pads.length, h.pitch_mm])).toEqual([["POWER", 4, 2.54], ["AD", 3, 2.54]]);
    expect(b.connectors.map((c) => [c.ref, c.kind])).toEqual([["X2", "usb"]]);
    expect(b.holes).toEqual([{ x: 12.54, y: 60, drill_mm: 2.5, mounting: true, basis: "package MOUNTINGHOLE_2.5_PLATED" }]);
    expect(b.excluded).toEqual({ components: 2, test_points: 1, pads: 4 });
    expect(b.frame.y).toBe("up");
    expect(b.source_file).toBe("files/BOARD.brd");
    // An empty net name is not a label.
    expect(b.headers[0]!.pads[3]!.net).toBeUndefined();
    expect(b.headers[0]!.pads[0]).toMatchObject({ n: "1", x: 12.54, y: 12.54, net: "+5V" });
    expect(b.headers[0]!.pads[0]!.rx).toBeUndefined();
  });

  test("an outline from the same file gives offsets from its corner and adds drawn holes once", () => {
    const b = buildBoard([geo(1, "pcb_pad_centers", padPayload), geo(2, "pcb_outline_and_drills", outlinePayload)], [])!;
    expect(b.outline).toMatchObject({ same_file: true, extent: [68.6, 53.4] });
    expect(b.headers[0]!.pads[0]).toMatchObject({ x: 12.54, y: 12.54, rx: 2.54, ry: 2.54 });
    // The plated hole is already known from its pad; the drawn hole is new.
    expect(b.holes.map((h) => [h.rx, h.ry, h.drill_mm, h.mounting])).toEqual([[2.54, 50, 2.5, true], [66, 2, 3.2, false]]);
  });

  test("an outline from a different file is reported but never used as an origin", () => {
    const b = buildBoard([geo(1, "pcb_pad_centers", padPayload), geo(2, "pcb_outline_and_drills", outlinePayload, "sha-other")], [])!;
    expect(b.outline?.same_file).toBe(false);
    expect(b.headers[0]!.pads[0]!.rx).toBeUndefined();
    expect(b.holes).toHaveLength(1);
  });

  test("datasets are not merged; the others are listed", () => {
    const partial = geo(3, "pcb_pad_centers", { ...padPayload, pads: BOARD_PADS.slice(0, 4) }, "sha-old", "parser_derived_partial_native_pad_centers_not_physical_fit_verified");
    const b = buildBoard([partial, geo(1, "pcb_pad_centers", padPayload)], [])!;
    expect(b.geometry_id).toBe(1);
    expect(b.other_datasets).toEqual([{ geometry_id: 3, kind: "pcb_pad_centers", revision: "rev A", source_file: "files/BOARD.brd", pads: 4 }]);
  });

  test("a module footprint becomes contact rows; a pad and hole on one spot are one contact", () => {
    const pads: RawPad[] = [];
    for (let i = 0; i < 5; i++) {
      for (const type of ["smd", "through_hole"]) {
        pads.push({ pad_number: String(i + 1), x_mm: -8.89, y_mm: -5.08 + i * 2.54, pad_type: type, footprint_name: "RPi_Pico_SMD_TH" });
        pads.push({ pad_number: String(10 - i), x_mm: 8.89, y_mm: -5.08 + i * 2.54, pad_type: type, footprint_name: "RPi_Pico_SMD_TH" });
      }
    }
    pads.push({ pad_number: "", x_mm: 0, y_mm: 20, pad_type: "through_hole", footprint_name: "RPi_Pico_SMD_TH" });
    const defs = Array.from({ length: 10 }, (_, i) => def(i + 1, "10 external pins", String(i + 1), `GP${i}`, `function ${i}`));
    const { board, joined } = buildBoardAndJoin([geo(5, "module_land_pattern", { format: "kicad_mod", frame: { y_direction: "down" }, pads })], defs);
    expect(board!.scope).toBe("land_pattern");
    expect(board!.headers.map((h) => [h.kind, h.pads.length, h.mount, h.pitch_mm])).toEqual([["module_contact_row", 5, "mixed", 2.54], ["module_contact_row", 5, "mixed", 2.54]]);
    expect(board!.headers[0]!.pads[0]!.fn).toMatchObject({ name: "GP0", basis: "module_pin_number" });
    expect(joined.size).toBe(10);
    expect(board!.excluded.pads).toBe(1);
    expect(board!.frame.origin).toContain("footprint-local");
  });

  test("pads calculated from a drawing: headers by the drawing's own label, positions from the board corner", () => {
    const anchors: RawPad[] = [1, 2, 3].map((n) => ({ reference: "J1", pad_number: String(n), x_mm: 1.27, y_mm: 1.4 + (n - 1) * 2.54, pad_type: "header_center_anchor" }));
    const pads = geo(139, "pcb_pad_centers", {
      format: "dimensioned_pdf_header_centers", coordinate_scope: "drawing_registered_board", reference_path: "references/5c/drawing.pdf",
      frame: { y_direction: "down", rebased_to_board_edge: true, origin: "Intersection of the drawing PCB left and top extent lines" }, pads: anchors,
    }, "sha-drawing", "published_dimension_callouts_derived_not_physical_fit_verified");
    const outline = geo(140, "pcb_outline_and_drills", { bounds_mm: { min_x: 0, min_y: 0, max_x: 25.4, max_y: 62.74 } }, "sha-drawing");
    const { board, joined } = buildBoardAndJoin([pads, outline], [boundDef(1, "J1", "1", "3V3", [139], "3.3 V power supply"), boundDef(2, "J1", "2", "3V3", [139], "3.3 V power supply")]);
    expect(board).toMatchObject({ derivation: "drawing_callouts", native_path: "references/5c/drawing.pdf" });
    expect(board!.frame.origin).toContain("drawing PCB left and top extent");
    expect(board!.outline).toMatchObject({ extent: [25.4, 62.74], same_file: true });
    expect(board!.headers.map((h) => [h.ref, h.kind, h.mount, h.pitch_mm, h.basis[0]])).toEqual([["J1", "pin_header", "unstated", 2.54, "header centres named in the source drawing"]]);
    expect(board!.headers[0]!.pads[0]).toMatchObject({ n: "1", x: 1.27, y: 1.4, rx: 1.27, ry: 1.4, fn: { name: "3V3", basis: "catalog_geometry_binding" } });
    expect(joined.size).toBe(2);
  });

  test("native CAD is labelled as such", () => {
    expect(buildBoard([geo(1, "pcb_pad_centers", padPayload)], [])!.derivation).toBe("native_cad");
  });

  test("no pad data, no board", () => {
    expect(buildBoard([geo(2, "pcb_outline_and_drills", outlinePayload)], [])).toBeNull();
  });
});

describe("buildModel", () => {
  const aperture = { edge: "y_max", center_along_edge_mm: 29.3216, width_mm: 3.2000000000000064, opening_height_mm: 4.6, lower_height_above_pcb_mm: 0.1202, upper_height_above_pcb_mm: 4.7202, overhang_beyond_outline_mm: -0.22 };
  const model = (above: number | null, connectors: object[] = []) => ({
    coordinate_scope: "step_model_assembly", reference_path: "references/aa/board.step",
    boards: [{ maximum_height_above_pcb_mm: above, maximum_height_below_pcb_mm: 2.00982348797996, pcb_thickness_model_mm: 1.57, maximum_height_status: "nominal_STEP_assembly_geometry_not_physical_measurement", modeled_height_scope: "Only modeled leaves of the named PCB assembly.", connectors }],
  });

  test("heights and openings come from the model, rounded, with a set-back opening reported as no overhang", () => {
    const m = buildModel([geo(200, "pcb_model_clearances", model(8.52017651202005, [
      { source_names: ["TERMBLOCK_1X2-3.5MM:J1", "TERMBLOCK_1X2-3.5MM"], apertures: [aperture] },
      { source_names: ["JSTPH2_BATT:X1", "JSTPH2_BATT"], apertures: [] },
    ]))])!;
    expect(m).toMatchObject({ geometry_id: 200, above_pcb_mm: 8.52, below_pcb_mm: 2.01, pcb_thickness_mm: 1.57, path: "references/aa/board.step", other_models: 0 });
    expect(m.openings).toEqual([{ connector: "TERMBLOCK_1X2-3.5MM", edge: "y_max", center_along_edge_mm: 29.32, width_mm: 3.2, height_mm: 4.6, lower_above_pcb_mm: 0.12, upper_above_pcb_mm: 4.72, overhang_mm: 0 }]);
    expect(m.connectors_without_opening).toEqual(["JSTPH2_BATT"]);
  });

  test("a board-only model has no height, and a model that states one is preferred", () => {
    expect(buildModel([geo(200, "pcb_model_clearances", model(null))])).toMatchObject({ above_pcb_mm: null });
    expect(buildModel([geo(200, "pcb_model_clearances", model(null)), geo(201, "pcb_model_clearances", model(4.8))])).toMatchObject({ geometry_id: 201, above_pcb_mm: 4.8, other_models: 1 });
    expect(buildModel([geo(1, "pcb_pad_centers", padPayload)])).toBeNull();
  });
});

test("readSeeAlso reads both link kinds, pointing from the linked record to its reference", () => {
  const meta = new Map([
    ["product_revision_reference_links", JSON.stringify({ links: [{ identity_status: "verified_marketed_model_revision_not_supplied_unit_revision", direction: { linked_part_id: "shop:1", reference_part_id: "arduino:A000067", reference_geometry_holder_part_id: "arduino:A000067" } }] })],
    ["product_sku_identity_links", JSON.stringify({ links: [
      { identity_status: "verified_exact_product_sku_not_verified_hardware_revision", direction: { linked_part_id: "shop:2", reference_record_part_id: "m5stack:A052", reference_geometry_holder_part_id: null } },
      { identity_status: "x", direction: { linked_part_id: "shop:2", reference_record_part_id: "m5stack:A052" } },
    ] })],
  ]);
  const links = readSeeAlso(meta);
  expect(links.get("shop:1")).toEqual([{ part_id: "arduino:A000067", relation: "marketed_revision_reference", identity_status: "verified_marketed_model_revision_not_supplied_unit_revision", holds_geometry: true }]);
  expect(links.get("shop:2")).toEqual([{ part_id: "m5stack:A052", relation: "same_sku", identity_status: "verified_exact_product_sku_not_verified_hardware_revision", holds_geometry: false }]);
  expect(readSeeAlso(new Map([["product_sku_identity_links", "not json"]])).size).toBe(0);
});

describe("I2C addresses the catalog selected", () => {
  const pick = (value: string, n: number | null): SpecRow => spec("i2c_address", value, 1, { scope_note: JSON.stringify({ selected_i2c_address: true }), value_num: n });

  test("the catalog's number is the address; other claims do not add to it", () => {
    const e = distillSpecs([spec("i2c_address", "0x77 alternate", 2), pick("0x36", 54)], authority).electrical;
    expect(e).toMatchObject({ i2c_addresses: ["0x36"], i2c_selected: true });
  });

  test("a selected claim without one number yields no address instead of every hex value in its text", () => {
    const e = distillSpecs([pick("7-bit reported strap range0x40–0x7F; default0x40; extra All-Call0x70", null)], authority).electrical;
    expect(e).toMatchObject({ i2c_addresses: [], i2c_selected: true });
    expect(e.i2c_claims[0]!.v).toContain("strap range");
  });

  test("without a selection the addresses are read from the spec table as before", () => {
    expect(distillSpecs([spec("i2c_address", "0x76")], authority).electrical).toMatchObject({ i2c_addresses: ["0x76"], i2c_selected: false });
  });
});

// ---------------------------------------------------------------------------------------
// Outline and observations

const env = (a: number, b: number, c: number | null, axes: string[] | null, scope = "pcb") => ({
  a_mm: a, b_mm: b, c_mm: c, axis_labels_json: axes ? JSON.stringify(axes) : null, scope, source_id: 3, evidence_text: "51 x 21 mm",
  verification_status: "manually_transcribed_source_not_fit_verified", exact_variant_required: 0, variant_sku: null,
});
let mid = 0;
const meas = (kind: string, scope: string, values: number[], status = "source_stated", axes: string[] | null = null): MeasurementRow => ({
  measurement_id: ++mid, kind, scope, values_mm_json: JSON.stringify(values), axis_labels_json: axes ? JSON.stringify(axes) : null,
  evidence_text: "evidence", extraction_status: status, source_id: 3,
});

describe("buildOutline", () => {
  test("a third value labelled as PCB thickness is not a height", () => {
    expect(buildOutline(env(51, 21, 1, ["length", "width", "pcb_thickness"]))).toMatchObject({ height_known: false, pcb_thickness_mm: 1 });
  });
  test("two values leave the height unknown", () => expect(buildOutline(env(68.6, 53.4, null, ["length", "width"]))).toMatchObject({ height_known: false, mm: [68.6, 53.4, null] }));
  test("three values with a height", () => expect(buildOutline(env(54, 54, 17, null, "assembly"))).toMatchObject({ height_known: true, axes: null, scope_meaning: "assembled product, as the source states it" }));
  test("no envelope, no outline", () => expect(buildOutline(undefined)).toBeNull());
});

test("buildObservations drops repeats, flags disagreement and keeps the better-sourced value", () => {
  const selected = buildOutline(env(51, 21, null, ["length", "width"], "pcb"));
  const { outlines, dimensions } = buildObservations([
    meas("bounding_box", "pcb", [21, 51]), // the selected outline again
    meas("bounding_box", "pcb", [51.3, 21]), // same scope, different numbers
    meas("bounding_box", "product_unspecified", [51.3, 21, 3.9]),
    meas("model_bounds", "cad_model", [52, 22, 4], "parser_derived_model_bounds"),
    meas("axis", "pcb", [51], "source_stated", ["length"]), // repeats the outline
    meas("pitch", "unknown", [2.54], "candidate_ambiguous"),
    meas("pin_pitch", "main_interface", [2.54], "manual_source_transcription", ["pitch"]),
    meas("mounting_hole", "component", [2.1], "candidate_ambiguous"),
  ], selected);
  expect(outlines.map((o) => [o.scope, o.mm, o.differs_from_selected ?? false])).toEqual([
    ["pcb", [51.3, 21], true],
    ["product_unspecified", [51.3, 21, 3.9], false],
    ["cad_model", [52, 22, 4], false],
  ]);
  expect(dimensions.map((d) => [d.kind, d.status])).toEqual([["pin_pitch", "manual_source_transcription"], ["mounting_hole", "candidate_ambiguous"]]);
});

// ---------------------------------------------------------------------------------------
// Caveats, references, listings, missing

test("buildCaveats keeps warnings and part-specific notes, and counts what it drops", () => {
  const issue = (id: number, severity: string, code: string, detail: string) => ({ issue_id: id, severity, code, detail, source_id: 1 });
  const { caveats, omitted } = buildCaveats([
    issue(1, "info", "mounting_and_clearance_unverified", "true of every part"),
    issue(2, "info", "source_note", "Source capture metadata: {\"commit\": null}"),
    issue(3, "info", "source_note", "Technical tables are source claims. No physical measurement."),
    issue(4, "info", "source_note", "The prose states four mounting holes, but the drawing shows two."),
    issue(5, "info", "source_note", "PCB-only scope excludes the antenna."),
    issue(6, "warning", "pcb_only_envelope", "PCB-only scope excludes the antenna."),
  ], (detail) => detail.startsWith("Technical tables"));
  expect(caveats.map((c) => [c.severity, c.code])).toEqual([["warning", "pcb_only_envelope"], ["info", "source_note"]]);
  expect(caveats[1]!.text).toContain("four mounting holes");
  expect(omitted).toBe(2);
});

test("buildReferences puts what an agent can look at first, and leaves out licence files and uncached photos", () => {
  const asset = (id: number, kind: string, cached: boolean, title = kind): AssetRow => ({
    asset_id: id, kind, title, url: `https://example.test/${id}`, revision: null, applicability_note: null,
    relative_path: cached ? `references/aa/${id}` : null, sha256: cached ? `sha${id}` : null, byte_count: cached ? 100 : null,
    media_type: "application/pdf", local_status: cached ? "downloaded" : "fetch_failed",
  });
  const derived = (kind: string, title: string) => ({ kind, title, source_url: "https://example.test/src", relative_path: `references/bb/${title}`, sha256: "s", byte_count: 5, media_type: "image/png", derivation_method: "Rendered page 1" });
  const { references, counts } = buildReferences(
    [asset(1, "product_image", false), asset(2, "schematic", true), asset(3, "pinout", false), asset(4, "pinout", true), asset(5, "product_image", true), asset(6, "product_image", true)],
    [derived("archive_member_reference", "files/License.txt"), derived("archive_member_reference", "files/BOARD.brd"), derived("pdf_page_render", "Rendered drawing")],
  );
  expect(references.map((r) => [r.kind, r.path != null])).toEqual([
    ["pinout", true], ["pinout", false], ["rendered_drawing", true], ["board_file", true], ["schematic", true], ["product_image", true],
  ]);
  expect(counts).toMatchObject({ pinout: 2, product_image: 3, board_file: 1, rendered_drawing: 1 });
});

test("buildListings puts Norwegian in-stock listings first and names the variant", () => {
  const listing = (id: number, supplier: string, market: string | null, stock: string, sku: string | null = null) => ({
    listing_id: id, supplier, url: `https://example.test/${id}`, supplier_sku: sku, identity_match: "this_source_product", domestic_market: market,
    currency: market ? "NOK" : "USD", price: 100, price_basis: market ? "catalog price, incl. mva as price_html states" : "listed_base_or_lowest_variant_price; taxes_and_shipping_not_normalized",
    stock_status: stock, observed_at: "2026-11-13T22:19:14+00:00", source_id: 1,
  });
  const { buy, norway, international } = buildListings(
    [listing(1, "Adafruit", null, "in_stock"), listing(2, "Elkim", "NO", "out_of_stock"), listing(3, "Kjell", "NO", "in_stock", "K1")],
    [{ supplier: "Kjell", sku: "K1", title: "With headers" }, { supplier: "Adafruit", sku: null, title: "Default Title" }],
  );
  expect(buy.map((b) => [b.supplier, b.basis, b.variant, b.observed])).toEqual([
    ["Kjell", "incl. VAT", "With headers", "2026-11-13"],
    ["Elkim", "incl. VAT", null, "2026-11-13"],
    ["Adafruit", "listed price; tax and shipping not normalised", null, "2026-11-13"],
  ]);
  expect([norway, international]).toEqual([2, 1]);
});

test("buildMissing says what a bare-board, net-names-only part still lacks", () => {
  const board = buildBoard([geo(1, "pcb_pad_centers", padPayload)], [])!;
  const codes = buildMissing({
    category: "development_board",
    identity: { scope: "branded_product", variants: 2, variant_choice_required: true, families: [], geometry_status: "published_2d_height_unknown" },
    outline: buildOutline(env(51, 21, 1, ["length", "width", "pcb_thickness"])), board, pins: [],
    electrical: distillSpecs([spec("operating_voltage", "3.3V", 1), spec("operating_voltage", "5V", 2)], authority).electrical,
    references: [], buy_counts: { norway: 0, international: 2, family_level_marketplace: 0 },
  }).map((m) => m.code);
  expect(codes).toEqual(["height", "component_heights", "variant", "board_frame", "pin_functions", "operating_voltage_conflict", "logic_level", "mechanical_reference", "norwegian_listing"]);
});

test("buildMissing has nothing to say about pads when there is no CAD data, only that they are missing", () => {
  const m = buildMissing({
    category: "sensor", identity: { scope: "x", variants: 1, variant_choice_required: false, families: [], geometry_status: "x" },
    outline: null, board: null, pins: [], electrical: distillSpecs([], authority).electrical, references: [],
    buy_counts: { norway: 0, international: 0, family_level_marketplace: 0 },
  });
  expect(m.map((x) => x.code)).toEqual(["outline", "pad_coordinates", "pin_functions", "supply_voltage", "mechanical_reference", "listing"]);
  expect(m.find((x) => x.code === "pad_coordinates")!.detail).toContain("do not estimate them from a photo");
});

test("rankByName puts the part named by the query before accessories that mention it", () => {
  // Arrival order is text relevance, which favours the accessory that repeats the phrase.
  const rows = [
    { name: "FlexyPin Adapter for Raspberry Pi Pico W", score: 60 },
    { name: "Waveshare 1.3inch Display for Raspberry Pi Pico W and Pico", score: 70 },
    { name: "Raspberry Pi Pico W", score: 15 },
    { name: "Raspberry Pi Pico 2 W", score: 50 },
    { name: "Raspberry Pi Pico W", score: 60 },
    { name: "Pico display, works with the W", score: 90 },
  ];
  expect(rankByName(rows, "Raspberry Pi Pico W").map((r) => [r.name, r.score])).toEqual([
    ["Raspberry Pi Pico W", 60], // exact name, fuller card first
    ["Raspberry Pi Pico W", 15],
    ["Raspberry Pi Pico 2 W", 50], // one extra word
    ["FlexyPin Adapter for Raspberry Pi Pico W", 60],
    ["Waveshare 1.3inch Display for Raspberry Pi Pico W and Pico", 70],
    ["Pico display, works with the W", 90], // lacks a query word in its name: relevance order
  ]);
  expect(rankByName(rows, "").map((r) => r.name)).toEqual(rows.map((r) => r.name));
});

// ---------------------------------------------------------------------------------------
// End to end on a small catalog with the real table shapes

const dir = mkdtempSync(join(tmpdir(), "catalog-cards-"));
const srcPath = join(dir, "catalog.sqlite");
const outPath = join(dir, "cards.sqlite");
afterAll(() => rmSync(dir, { recursive: true, force: true }));

function makeCatalog(): void {
  const db = new Database(srcPath, { create: true });
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
      source_sha256 TEXT, payload_json TEXT, validation_status TEXT, coordinate_frame TEXT);
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
    INSERT INTO sources VALUES (1, 'https://maker.test/board', 'Maker', 'manufacturer_claim', '2026-11-13T10:00:00+00:00'),
      (2, 'https://shop.test/sensor', 'Shop', 'specialist_retailer_claim', '2026-11-13T11:00:00+00:00'), (3, 'https://unused.test', 'Nobody', 'x', '2026-11-13');
    INSERT INTO parts VALUES ('m:board', 'Maker Board One', 'Maker', 'MB-1', 'development_board', 'exact_manufacturer_sku', 'https://maker.test/board', 1, 'A small board.', 1, 1, 'published_3d_unverified'),
      ('s:sensor', 'Climate Sensor Breakout', NULL, NULL, 'sensor', 'supplier_specific_product_manufacturer_unresolved', 'https://shop.test/sensor', 2, NULL, 1, 2, 'not_found_in_sources');
    INSERT INTO envelopes VALUES ('m:board', 70, 55, 15, '["length","width","height"]', 'assembly', 1, '70 x 55 x 15 mm', 'parser_selected_source_claim_not_fit_verified', 0, NULL);
    INSERT INTO specifications(spec_id, part_id, domain, key, value_text, source_id, validation_status, claim_scope) VALUES
      (1, 'm:board', 'electrical', 'operating_voltage', '5V', 1, 'source_claim_not_independently_verified', 'unspecified'),
      (2, 'm:board', 'electrical', 'input_voltage', '7-12V', 1, 'source_claim_not_independently_verified', 'unspecified'),
      (3, 's:sensor', 'interface', 'i2c_address', '0x76', 2, 'source_claim_not_independently_verified', 'unspecified'),
      (4, 's:sensor', 'interface', 'communication_interface', 'I2C', 2, 'source_claim_not_independently_verified', 'unspecified');
    INSERT INTO pin_definitions VALUES (1, 'm:board', 'POWER', '1', '5V', 'P', '5 V output', 1, NULL, NULL), (2, 'm:board', 'POWER', '2', 'GND', 'G', 'Ground', 1, NULL, NULL);
    INSERT INTO assets VALUES (1, 'm:board', 'pinout', 'Pinout', 'https://maker.test/pinout.pdf', NULL, NULL);
    INSERT INTO asset_files VALUES ('https://maker.test/pinout.pdf', 'references/ab/pinout.pdf', 'abc', 1234, 'application/pdf', 'downloaded');
    INSERT INTO listings VALUES (1, 'm:board', 'Elkim', 'https://elkim.test/board', 'E1', 'this_source_product', 'NO', 'NOK', 299, 'catalog price, incl. mva as price_html states', 'in_stock', '2026-11-13T22:00:00+00:00', 1);
    INSERT INTO data_issues VALUES (1, 'm:board', 'warning', 'variant_selection_required', 'Pick the exact SKU.', 1);
    INSERT INTO family_memberships VALUES ('m:board', 'Arduino UNO');
    INSERT INTO market_evidence VALUES (1, 'Arduino UNO', 'AliExpress');
    INSERT INTO parts_fts(part_id, name, brand, category, families, specifications) VALUES ('m:board', 'Maker Board One', 'Maker', 'development_board', 'Arduino UNO', 'operating voltage 5V atmega328p'),
      ('s:sensor', 'Climate Sensor Breakout', '', 'sensor', '', 'i2c address 0x76 bme280');
  `);
  // query(), not prepare(): close() finalizes cached statements, so Windows can delete the file afterwards.
  db.query(`INSERT INTO geometry_objects VALUES (1, 'm:board', 'pcb_pad_centers', 1, 'rev A', 'https://maker.test/files/board.brd', 'sha-board', ?, 'parser_derived_native_pad_centers_not_physical_fit_verified', NULL)`).run(JSON.stringify(padPayload));
  db.close();
}

describe("build and read", () => {
  beforeAll(() => {
    makeCatalog();
    build(srcPath, outPath);
  });

  test("a card carries the joined facts and only the sources it cites", () => {
    const db = openCards(outPath);
    const c = getCard(db, "m:board")!;
    db.close();
    expect(c.v).toBe(1);
    expect(c.outline).toMatchObject({ mm: [70, 55, 15], height_known: true, scope: "assembly" });
    expect(c.board!.headers.map((h) => h.ref)).toEqual(["POWER", "AD"]);
    // POWER pin 1 and 2 are joined by connector and pin number, so the pin table is not repeated.
    expect(c.board!.headers[0]!.pads.slice(0, 2).map((p) => p.fn?.name)).toEqual(["5V", "GND"]);
    expect(c.pins).toEqual([]);
    expect(c.electrical.operating?.min_v).toBe(5);
    expect(c.electrical.input).toMatchObject({ min_v: 7, max_v: 12 });
    expect(c.references[0]).toMatchObject({ kind: "pinout", path: "references/ab/pinout.pdf", sha256: "abc" });
    expect(c.buy[0]).toMatchObject({ supplier: "Elkim", market: "NO", price: 299 });
    expect(c.buy_counts).toEqual({ norway: 1, international: 0, family_level_marketplace: 1 });
    expect(c.identity.variant_choice_required).toBe(true);
    expect(Object.keys(c.sources)).toEqual(["1"]);
    expect(c.missing.map((m) => m.code)).toEqual(["variant", "board_frame", "logic_level", "mechanical_reference"]);
  });

  test("a part the catalog knows little about says so", () => {
    const db = openCards(outPath);
    const c = getCard(db, "s:sensor")!;
    expect(getCard(db, "nope")).toBeNull();
    db.close();
    expect(c.outline).toBeNull();
    expect(c.board).toBeNull();
    expect(c.electrical.i2c_addresses).toEqual(["0x76"]);
    expect(c.electrical.interfaces).toEqual(["I2C"]);
    expect(c.missing.map((m) => m.code)).toEqual(["outline", "pad_coordinates", "pin_functions", "supply_voltage", "mechanical_reference", "listing"]);
    expect(c.score).toBeLessThan(20);
  });

  test("the rendered card states scope, frame and gaps in plain words", () => {
    const db = openCards(outPath);
    const text = renderCard(getCard(db, "m:board")!);
    db.close();
    expect(text).toContain("70 x 55 x 15 mm (length, width, height) | scope assembly");
    expect(text).toContain("POWER | pin_header | 1X04 | through_hole | 1 row(s), 2.54 mm pitch | basis: package 1X04");
    expect(text).toContain("1@12.54,12.54 5V = 5 V output");
    expect(text).toContain("no outline from the same file: coordinates are not tied to the board edge");
    expect(text).toContain("operating voltage: 5 V");
    expect(text).toContain("input voltage: 7–12 V");
    expect(text).toContain("(CHOOSE THE EXACT VARIANT FIRST)");
    expect(text).toContain("AliExpress: 1 family-level listing(s)");
  });

  test("find searches text and filters on fit, pads and Norwegian listings", () => {
    const db = openCards(outPath);
    expect(findCards(db, "bme280").rows.map((r) => r.part_id)).toEqual(["s:sensor"]);
    expect(findCards(db, "maker board").rows[0]).toMatchObject({ part_id: "m:board", header_pads: 9, pin_functions: 2, norway_listings: 1, supply_min_v: 5 });
    expect(findCards(db, "", { fits: [80, 60, 20] }).rows.map((r) => r.part_id)).toEqual(["m:board"]);
    expect(findCards(db, "", { fits: [60, 60, 20] }).rows).toEqual([]);
    expect(findCards(db, "", { pads: true }).rows.map((r) => r.part_id)).toEqual(["m:board"]);
    expect(findCards(db, "", { norway: true }).rows.map((r) => r.part_id)).toEqual(["m:board"]);
    const loose = findCards(db, "bme280 nonexistentword");
    expect([loose.loose, loose.rows.map((r) => r.part_id)]).toEqual([true, ["s:sensor"]]);
    db.close();
  });

  test("the same catalog gives the same bytes", () => {
    const first = readFileSync(outPath);
    build(srcPath, outPath);
    expect(readFileSync(outPath).equals(first)).toBe(true);
  });

  test("a catalog with another schema version is refused", () => {
    const other = join(dir, "v3.sqlite");
    const db = new Database(other, { create: true });
    db.exec("PRAGMA user_version = 3; CREATE TABLE t(x);");
    db.close();
    expect(() => build(other, join(dir, "x.sqlite"))).toThrow(/schema version 3/);
  });
});

// ---------------------------------------------------------------------------------------
// Checks against the real catalog. They run when BENCHTOP_CATALOG points at it.

const real = process.env.BENCHTOP_CATALOG;
describe.skipIf(!real || !existsSync(real))("real catalog", () => {
  const realOut = join(dir, "real-cards.sqlite");
  let db: Database;
  beforeAll(() => {
    build(real!, realOut);
    db = openCards(realOut);
  }, 120_000);
  afterAll(() => db?.close());

  test("Arduino Uno Rev3: the six headers, the jack and the USB socket, and nothing else", () => {
    const b = getCard(db, "arduino:A000066")!.board!;
    expect(b.headers.map((h) => `${h.ref}:${h.pads.length}`).sort()).toEqual(["AD:6", "ICSP1:6", "ICSP:6", "IOH:10", "IOL:8", "JP2:4", "POWER:8"]);
    expect(b.connectors.map((c) => c.kind).sort()).toEqual(["dc_jack", "usb"]);
    expect(b.headers.find((h) => h.ref === "AD")!.pads.map((p) => p.net)).toEqual(["AD0", "AD1", "AD2", "AD3", "AD4/SDA", "AD5/SCL"]);
    expect(b.headers.every((h) => h.pitch_mm === 2.54)).toBe(true);
    // Published labels are attached through the catalog's own binding, and the pads are tied to the board outline.
    expect(b.headers.find((h) => h.ref === "AD")!.pads.map((p) => [p.fn?.name, p.fn?.basis])).toEqual(
      ["A0", "A1", "A2", "A3", "A4", "A5"].map((n) => [n, "catalog_geometry_binding"]),
    );
    expect(b.outline).toMatchObject({ same_file: true, extent: [68.58, 53.34] });
  });

  test("ESP32-S3-DevKitC-1 v1.0: header positions from the dimension drawing, with the pin table attached", () => {
    const c = getCard(db, "espressif:esp32-s3-devkitc-1:v1.0")!;
    expect(c.board).toMatchObject({ derivation: "drawing_callouts", scope: "board" });
    expect(c.board!.headers.map((h) => `${h.ref}:${h.pads.length}:${h.mount}`).sort()).toEqual(["J1:22:unstated", "J3:22:unstated"]);
    expect(c.board!.headers.find((h) => h.ref === "J1")!.pads[0]).toMatchObject({ n: "1", rx: 1.27, ry: 1.4, fn: { name: "3V3" } });
    expect(c.pins).toEqual([]);
  });

  test("Raspberry Pi Pico W: two rows of twenty contacts with all forty pin functions attached", () => {
    const c = getCard(db, "pimoroni:6780985475155")!;
    expect(c.board!.scope).toBe("land_pattern");
    expect(c.board!.headers.map((h) => h.pads.length)).toEqual([20, 20]);
    const pads = c.board!.headers.flatMap((h) => h.pads);
    expect(pads.every((p) => p.fn?.basis === "catalog_geometry_binding")).toBe(true);
    // The bound row names the pin; the module's pin table says what it does.
    expect(pads.find((p) => p.n === "1")!.fn).toMatchObject({ name: "GPIO0", functions: "UART0 TX [default]; I2C0 SDA; SPI0 RX" });
    expect(pads.find((p) => p.n === "1")!.fn!.functions_from?.connector).toContain("40 external pins");
    // The forty header pins are on the pads, so the pin table is not repeated; only pins without a listed pad remain.
    expect(c.pins.map((g) => g.connector)).not.toContain("40 external pins (Figure 2)");
    expect(c.pins.flatMap((g) => g.pins).length).toBeLessThan(8);
    expect(c.outline).toMatchObject({ height_known: false, pcb_thickness_mm: 1 });
  });

  test("searching for a product by name returns that product first, not its accessories", () => {
    expect(findCards(db, "Raspberry Pi Pico W").rows[0]).toMatchObject({ part_id: "pimoroni:6780985475155", name: "Raspberry Pi Pico W" });
    expect(findCards(db, "arduino uno rev3").rows[0]!.part_id).toBe("arduino:A000066");
    // The Pico W outline is 51 x 21 mm with a 1 mm PCB thickness: the index holds the board extent, not the thickness.
    expect(findCards(db, "Raspberry Pi Pico W").rows[0]).toMatchObject({ dim_min: 21, dim_mid: null, dim_max: 51, height_known: 0 });
  });

  test("a board with a 3D model reports its height separately from the outline, with connector openings", () => {
    const c = getCard(db, "adafruit:815")!;
    expect(c.model).toMatchObject({ above_pcb_mm: 8.52, below_pcb_mm: 2.01, pcb_thickness_mm: 1.57, coordinate_scope: "step_model_assembly" });
    expect(c.model!.openings.length).toBeGreaterThan(0);
    expect(c.model!.openings.every((o) => o.width_mm > 0 && o.overhang_mm >= 0)).toBe(true);
  });

  test("a model is registered to its board's pads, and the USB opening lands on the right edge", () => {
    const m = getCard(db, "adafruit:5724")!.model!;
    expect(m.registration).toMatchObject({ pad_geometry_id: 55, outline_geometry_id: 21, side_evidence: 4, feature_count: 4, transform: { rotation_deg: 0, reflected: false, seen_from_underside: false } });
    expect(m.registration!.features.map((f) => f.ref).sort()).toEqual(["CONN1", "NEOPIX1", "X1", "X6"]);
    expect(m.registration!.runner_up_residual_mm!).toBeGreaterThan(20);
    // USB-C on the short left edge of the Feather, 11.43 mm up, facing out, 1.18 mm proud of the board.
    expect(m.registration!.openings).toEqual([
      { connector: "USB_C_CUSB31-CFM2AX-01-X", ref: "X6", center: [0, 11.43], outward: [-1, 0], width_mm: 8.64, lower_above_pcb_mm: 0.14, upper_above_pcb_mm: 3.05, overhang_mm: 1.18 },
    ]);
  });

  test("a KiCad board, whose frame is Y-down, registers as seen from the top", () => {
    const g = getCard(db, "sparkfun:GPS-28871")!.model!.registration!;
    // The map is a pure Y flip: Y-up model onto a Y-down pad frame. All its connectors are on the front copper layer.
    expect(g.transform).toMatchObject({ m: [[1, 0], [0, -1]], reflected: true, seen_from_underside: false });
    expect(g.side_evidence).toBeGreaterThan(0);
  });

  test("the drilled holes confirm the Feather's connector-based registration", () => {
    const g = getCard(db, "adafruit:5724")!.model!.registration!;
    expect(g.basis).toBe("connectors");
    // 34 of the CAD file's 38 through-hole pads have a hole of the model on them (the rest are slots, which the
    // model's circular-hole list leaves out). A half turn still lines up 26, because the two header rows are
    // nearly symmetric: the holes agree with the connectors here but could not have decided it alone.
    expect(g.hole_check).toMatchObject({ pad_holes: 38, matched: 34, best_other_matched: 26 });
    // Seen from the underside, far fewer holes line up: here the holes confirm the face as well.
    expect(g.hole_check!.best_excluded_matched!).toBeLessThan(34);
  });

  test("across the catalog, holes never contradict a connector-based registration, and decide some on their own", () => {
    const ids = (db.query(`SELECT part_id FROM card_index WHERE header_pads > 0`).all() as { part_id: string }[]).map((r) => r.part_id);
    let byHoles = 0;
    let checked = 0;
    const beaten: string[] = [];
    for (const id of ids) {
      const g = getCard(db, id)!.model?.registration;
      if (!g) continue;
      if (g.basis === "holes") byHoles++;
      if (g.basis === "connectors" && g.hole_check) {
        checked++;
        if (g.hole_check.best_other_matched > g.hole_check.matched) beaten.push(`${id} ${g.hole_check.matched} vs ${g.hole_check.best_other_matched}`);
      }
    }
    // Two hole-based registrations lean on the one-face rule: seen from the other face, too many holes still
    // line up (49 of 69, and all 15 of 15). They must say so. One that the holes carry alone must say that too.
    for (const [id, excluded] of [["adafruit:3201", 49], ["adafruit:4313", 15]] as const) {
      const g = getCard(db, id)!.model!.registration!;
      expect([id, g.basis, g.side_basis, g.hole_check!.best_excluded_matched, g.hole_check!.holes_alone_decide]).toEqual([id, "holes", "one_face", excluded, false]);
    }
    expect(getCard(db, "adafruit:1487")!.model!.registration).toMatchObject({ basis: "holes", side_basis: null, hole_check: { holes_alone_decide: true } });
    expect(byHoles).toBeGreaterThan(5);
    expect(checked).toBeGreaterThan(140);
    expect(beaten).toEqual([]);
  });

  test("across the catalog, a registered opening sits on its own connector's pads", () => {
    const ids = (db.query(`SELECT part_id FROM card_index WHERE header_pads > 0`).all() as { part_id: string }[]).map((r) => r.part_id);
    let registered = 0;
    let checked = 0;
    const off: string[] = [];
    for (const id of ids) {
      const c = getCard(db, id)!;
      const g = c.model?.registration;
      if (!g) continue;
      registered++;
      const groups = [...c.board!.headers, ...c.board!.connectors];
      for (const o of g.openings) {
        const grp = groups.find((x) => x.ref.toUpperCase() === (o.ref ?? "").toUpperCase());
        // A header or terminal block has one opening per position; only a lone opening is centred on its pads.
        if (!grp || g.openings.filter((x) => x.ref === o.ref).length !== 1) continue;
        const cx = grp.pads.reduce((s, p) => s + p.x, 0) / grp.pads.length;
        const cy = grp.pads.reduce((s, p) => s + p.y, 0) / grp.pads.length;
        const along = Math.abs(o.outward[0] !== 0 ? o.center[1] - cy : o.center[0] - cx);
        checked++;
        if (along > 0.5) off.push(`${id} ${o.ref} ${along.toFixed(2)} mm`);
      }
    }
    expect(registered).toBeGreaterThan(150);
    expect(checked).toBeGreaterThan(180);
    expect(off).toEqual([]);
  });

  test("a model is not registered when nothing ties it to the pads, and says why", () => {
    const notes = (db.query(`SELECT part_id FROM card_index WHERE header_pads > 0`).all() as { part_id: string }[])
      .map((r) => getCard(db, r.part_id)!.model)
      .filter((m) => m && !m.registration)
      .map((m) => m!.registration_note);
    expect(notes.length).toBeGreaterThan(20);
    expect(notes.every((n) => typeof n === "string" && n.length > 10)).toBe(true);
  });

  test("a JLCPCB component is listed as assembly inventory, not as something to buy loose", () => {
    const c = getCard(db, "jlcpcb:C2040")!;
    expect(c.buy[0]).toMatchObject({ supplier: "JLCPCB", stock: "in_stock_assembly_inventory" });
    expect(c.buy[0]!.basis).toContain("not sold as a loose part");
    expect(renderCard(c)).toContain("assembly-service inventory");
  });

  test("a shop record points at the manufacturer's record for the same marketed product", () => {
    expect(getCard(db, "skolehuset.no:7193937412305")!.see_also).toEqual([
      { part_id: "arduino:A000067", relation: "marketed_revision_reference", identity_status: "verified_marketed_model_revision_not_supplied_unit_revision", holds_geometry: true },
    ]);
  });

  test("no card calls a crystal, button or IC a header", () => {
    const ids = (db.query(`SELECT part_id FROM card_index WHERE header_pads > 0`).all() as { part_id: string }[]).map((r) => r.part_id);
    const bad: string[] = [];
    for (const id of ids) {
      // Module contact rows are named after the module's footprint, so only board headers are checked.
      for (const h of getCard(db, id)!.board!.headers.filter((x) => x.kind !== "module_contact_row")) {
        if (/CRYSTAL|RESONATOR|BTN|(^|[_:-])SW\d|QFN|DFN|LGA|SOT\d|SOIC|INDUCTOR|(^|[_:-])LED/i.test(h.package ?? "")) bad.push(`${id} ${h.ref} ${h.package}`);
      }
    }
    expect(bad).toEqual([]);
  });

  test("every card decompresses, cites only sources it carries, and never invents a height", () => {
    const rows = db.query(`SELECT part_id FROM card_index`).all() as { part_id: string }[];
    expect(rows.length).toBeGreaterThan(4000);
    for (const { part_id } of rows) {
      const c = getCard(db, part_id)!;
      if (c.outline && c.outline.mm[2] == null) expect(c.outline.height_known).toBe(false);
      for (const claim of [...(c.electrical.operating?.claims ?? []), ...(c.electrical.input?.claims ?? [])]) expect(c.sources[String(claim.src)]).toBeDefined();
    }
  });
});
