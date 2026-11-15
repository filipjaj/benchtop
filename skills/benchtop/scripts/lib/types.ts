// Data model shared by every benchtop script.
//
// Two documents exist:
//   PartDef  - one JSON file per component in assets/parts/ (or <project>/parts/ for
//              project-local parts). Describes the physical and electrical reality of
//              a component: where its pins are, how big it is, what it tolerates.
//   Project  - <project>/project.json. Describes one build: which parts, how they are
//              connected, how they sit in the enclosure, and the showcase copy.
//
// Everything downstream (electrical checks, BOM, guide illustrations, enclosure CAD,
// carrier PCB, firmware pin map, landing page) is derived from these two documents,
// which is what keeps the drawings and the instructions in agreement with each other.
//
// Units: millimetres, volts, milliamps. Part origin is the top-left corner of the
// part seen from above with its component side up; x runs right, y runs down the
// page (away from the viewer in the isometric view), z runs up from the bench.

export type PinRole = "power-in" | "power-out" | "gnd" | "io" | "passive" | "nc";

export type PinCap =
  | "adc"
  | "dac"
  | "pwm"
  | "i2c"
  | "spi"
  | "uart"
  | "touch"
  | "input-only" // cannot drive an output (ESP32 GPIO34-39)
  | "strapping" // sampled at reset; an external load can stop the chip booting
  | "flash" // wired to the on-module flash; must stay unconnected
  | "usb" // native USB D+/D-; using it as GPIO loses USB serial
  | "onboard-led"
  | "boot-button";

export interface PinDef {
  /** Label exactly as printed on the part's silkscreen, e.g. "GPIO8", "3V3", "SDA". */
  name: string;
  aliases?: string[];
  role: PinRole;
  /** Pad centre, mm from the part origin. */
  x: number;
  y: number;
  /**
   * Height of the solder point above the top face of the body, when the lead does not
   * end in a pad on that face: negative for a leg that leaves the body lower down (a
   * tactile switch, an axial resistor, an LED), e.g. -3.4 for a leg at the foot of a
   * 3.4 mm body. The booklet then draws the lead as a tab on the nearest body edge and
   * ends the wire on it, instead of on a pad that is not there. Omit for a pad on the
   * top face, which is what every header and castellated pad is.
   */
  z?: number;
  /**
   * Only with `z`: how much bare lead there is beyond the body to solder to, in mm,
   * e.g. 20 for an axial resistor, 17 for an LED leg, 3.5 for a tactile switch. The
   * booklet draws only as much of it as it takes for the solder point to be seen past
   * the part's own body, so a long lead on the far side of a part is still shown.
   * Defaults to 1.5, a short leg.
   */
  lead?: number;
  /** power-out: nominal rail voltage. io: logic-high level the pin drives. */
  volts?: number;
  /** Highest voltage the pin survives. Defaults to the part's logic voltage. */
  maxVolts?: number;
  /** power-in only: lowest supply voltage the part runs from. */
  minVolts?: number;
  /**
   * Inputs only: the lowest voltage guaranteed to read as high, when that is more than
   * 3.3 V logic delivers. A WS2812B on 5 V needs 3.5 V on its data pin.
   */
  minHighVolts?: number;
  /**
   * Inputs only: the pin reads as high only within this many volts of the part's own
   * supply, whatever that supply is. True of an input that switches a transistor tied
   * to the supply rail: a low-triggered buzzer module on 5 V stays on unless its input
   * reaches about 4.4 V, so a 3.3 V controller pin can turn it on but never off. Fed
   * from 3.3 V the same module switches cleanly. Typical value 0.6.
   */
  highWithinOfSupply?: number;
  /**
   * Inputs only: the level at which the part does nothing. A low-triggered buzzer or relay
   * input idles high: held low it sounds or switches. Default "low". The bring-up test
   * puts every output at its idle level before it does anything else.
   */
  idle?: "high" | "low";
  /** Signal direction seen from this part. Omit for bidirectional and bus pins. */
  dir?: "in" | "out";
  /** Capabilities the controller pin on the other end must have, e.g. ["adc"] for an analogue output. */
  needs?: PinCap[];
  /** power-out only: how much the rail can supply to other parts. */
  supplyMa?: number;
  /**
   * power-out only: the pin also accepts an external supply in this range. A dev
   * board's 5V pin delivers USB power when a cable is plugged in and is where a
   * battery or boost converter feeds the board when it is not.
   */
  backfeed?: { minVolts: number; maxVolts: number };
  /** MCU GPIO number, used for the firmware pin map. */
  gpio?: number;
  caps?: PinCap[];
  /** Shown in the guide and the validator output when this pin is used. */
  note?: string;
  /**
   * The pin is a contact inside a connector (a battery socket): a lead that ends here
   * arrives on a plug and is pushed in, not soldered. The guide words the step that way.
   */
  plug?: boolean;
  /**
   * The pin is a screw clamp (a terminal block, a relay's load contacts): a wire that ends
   * here is stripped and clamped under the screw, never soldered or tinned, because solder
   * under a screw creeps and the clamp works loose. The guide words that end of the step
   * that way, and the cover and the BOM count it apart from the solder joints.
   */
  screw?: boolean;
  /**
   * Set by `catalog.ts import-part`: where each value it filled in on this pin came from, as the
   * catalog pin row and the published text it read. Absent on a pin set by hand, and on a value a
   * person has since changed it is stale. Nothing in a build reads it; it is for the human who
   * reviews the draft. `pad` is the CAD reference.pad the pin was read from (e.g. "JP1.1"): kept
   * here, not as an alias, because a CAD reference designator is not printed on the part.
   */
  importedFrom?: { role?: string; gpio?: string; pad?: string };
}

/**
 * Set by `catalog.ts import-part` on a draft: which catalog record it came from, and a hash of the
 * geometry the importer wrote so a later tool can tell that the pads or outline were edited by hand
 * (check-parts reports it; see lib/import-provenance.ts for what is hashed).
 */
export interface ImportProvenance {
  /** Catalog part id. */
  catalogPart: string;
  /** Geometry datasets the pads and, when there is one, the outline were read from. */
  geometry: { pads: number; padsKind: "pcb_pad_centers" | "module_land_pattern"; outline: number | null };
  /** Where the part's outline came from: an outline dataset of the same CAD file, the catalog's selected envelope, the pad bounding box, or the command line. */
  outlineFrom: "outline dataset" | "catalog envelope" | "bounding box of all pads" | "outline supplied on the command line";
  /** The source files' sha256 as the catalog records them; null where it records none. */
  sourceSha256: { pads: string | null; outline: string | null };
  /** sha256 over the pad positions and the body's w and d exactly as the importer wrote them. */
  geometrySha256: string;
  /** Other values the importer copied from the catalog, each with what it read. */
  fields?: { field: string; value: number; from: string }[];
  /**
   * Set when `ports` came from the connector openings of the maker's 3D model: which model, and how
   * it was matched to the pads (connectors named alike in both, how many agreed on the board side,
   * the fit's residual). `marginMm` is the default added around each opening, not a catalog figure.
   */
  ports?: { modelGeometry: number; count: number; rotationDeg: number; reflected: boolean; features: number; sideEvidence: number; residualMm: number; marginMm: number };
}

/** Decoration drawn on a face of a box: silkscreen text, a window, a port opening. */
export type Decal =
  | { kind: "rect"; face: Face; x: number; y: number; w: number; h: number; fill?: "none" | "black" | "hatch"; r?: number }
  | { kind: "circle"; face: Face; x: number; y: number; r: number; fill?: "none" | "black" }
  | { kind: "text"; face: Face; x: number; y: number; text: string; size: number; along?: "x" | "y" };

/** top = facing up; right = the +x face; left = the +y face (both visible in the iso view). */
export type Face = "top" | "right" | "left";

export type Shape =
  | { kind: "box"; x: number; y: number; z?: number; w: number; d: number; h: number; tag?: string; decals?: Decal[] }
  | { kind: "cyl"; x: number; y: number; z?: number; r: number; h: number; tag?: string };

/**
 * Something on the part that needs an opening in the enclosure: a USB socket, a
 * display's visible area, a button cap, a sensor that must reach outside air.
 */
export interface PortDef {
  name: string;
  /** Which way the port faces relative to the part: -y is "back", +y "front", etc. */
  faces: "x-" | "x+" | "y-" | "y+" | "up";
  /** Centre of the opening along the part edge (or x,y for "up"), mm from origin. */
  x: number;
  y: number;
  /** Centre height above the top of the part's body for side ports. */
  z?: number;
  w: number;
  h: number;
  shape?: "rect" | "round";
  /** Extra clearance around the opening, e.g. room for a USB plug overmould. */
  margin?: number;
  /**
   * Something has to physically pass through or be touched through this opening: a button
   * cap, a switch lever, an encoder shaft. The enclosure seats a lid-mounted part so this
   * stays proud of the lid, and warns when the part is too short to reach.
   */
  reach?: boolean;
}

export interface PartDef {
  id: string;
  name: string;
  kind: "board" | "sensor" | "display" | "actuator" | "power" | "passive" | "input" | "audio" | "connector" | "light";
  /** One line a beginner understands: what the part does in a build. */
  blurb: string;
  /** Outline. h is PCB thickness for boards, body height for everything else. */
  body: { w: number; d: number; h: number };
  /** Tallest point above the bench, including components and headers. */
  maxHeight: number;
  shapes?: Shape[];
  decals?: Decal[];
  pins: PinDef[];
  holes?: { x: number; y: number; dia: number }[];
  ports?: PortDef[];
  electrical: {
    /** IO logic level. Omit for passives and purely powered parts. */
    logicVolts?: number;
    /** True when IO pins survive 5 V even though the part runs at 3.3 V. */
    fiveVoltTolerant?: boolean;
    /** Current the part draws from its supply. peak covers radio bursts, motors, LEDs at full white. */
    currentMa?: { typical: number; peak: number };
    /** 7-bit I2C addresses the part can answer on. First is the default. */
    i2cAddresses?: number[];
    /** Onboard I2C pull-ups present, so no external resistors are needed. */
    i2cPullups?: boolean;
    /** Bare LEDs and similar: connecting one straight to a pin or rail destroys it. */
    needsSeriesResistor?: boolean;
    /**
     * "pulse": the generated bring-up test may switch this part on for 400 ms. Say so only
     * for a part that cannot move, heat or switch a load when driven: an LED, a buzzer. A
     * part that does not say so is held at its idle level and never exercised, so a relay,
     * servo, motor driver or heater is safe by default, including in part files nobody reviewed.
     */
    bringUp?: "pulse";
    /**
     * Set when `currentMa` is the draw of one unit of something sold by count or
     * length (one LED pixel). The project then says how many with `units` on the part.
     */
    perUnit?: { name: string };
  };
  footprint?: {
    /** How the part attaches to a carrier PCB. */
    mount: "header" | "tht" | "smd" | "wire" | "none";
    /** Hole pitch for header/tht parts. */
    pitch?: number;
    /** JLCPCB/LCSC part number when the bare component can be machine-assembled. */
    lcsc?: string;
    /** KiCad or tscircuit footprint string when one fits. */
    ref?: string;
  };
  sourcing: {
    /** Search strings that find the right listing at a retailer. */
    search: string[];
    /** Rough single-unit street price, for the budget estimate only. */
    priceUsd: number;
    links?: { store: string; url: string }[];
  };
  /**
   * What to measure on the physical part before printing or ordering. Hobby modules
   * are cloned by many factories and dimensions drift between batches.
   */
  verify?: string;
  /** Where the dimensions and pinout came from. */
  sources: string[];
  /** "datasheet" means source drawings support outline/pads; neither label means physically measured. "typical" is an approximate model. */
  confidence: "datasheet" | "typical";
  /**
   * Per-part evidence limitation. An unresolved part is still drawn and built from this
   * file's numbers, with a warning and "LAYOUT NOT VERIFIED" on every affected output;
   * strict mode and carrier PCBs refuse it. See lib/geometry-evidence.ts.
   */
  geometryEvidence?: {
    status: "unresolved" | "source-supported";
    reason: string;
    /** Unpublished or contradictory values. Never fill these merely to pass validation. */
    unknown: string[];
  };
  /** Present on a draft written by `catalog.ts import-part`; see ImportProvenance. */
  imported?: ImportProvenance;

  // --- Parts sold by the unit or by length ---------------------------------------------
  /**
   * The part repeats along x, once per unit: an LED strip cut to N pixels. When set, the
   * rest of the file describes ONE unit: `body.w` is the length of one unit (normally
   * equal to `repeat.pitch`), the pins are the ones at the input end, and `ports` may hold
   * the opening for the first unit. The project says how many with `units` on its entry in
   * `parts`; resolveProject then hands every consumer (guide, drawings, enclosure, 3D mesh,
   * BOM) an ordinary part with the body grown by (units - 1) x pitch, the per-unit shapes
   * copied once per unit and the spanning port stretched over all of them. Pads and every
   * other pin stay where the file puts them. Without `units` the part is one unit long.
   */
  repeat?: PartRepeat;
}

/** See PartDef.repeat. */
export interface PartRepeat {
  /** Distance from one unit to the next along x, in mm: 1000 / LEDs per metre for a strip. */
  pitch: number;
  /**
   * What is drawn per unit, positioned for the first unit; unit k (from 0) is the same
   * shape moved k x pitch along x. A shape's `tag` gets "-<k+1>" appended ("led" becomes
   * "led-1", "led-2", ...), because the 3D renders light every shape tagged led-<n>.
   */
  shapes: Shape[];
  /**
   * Name of the entry in `ports` that must cover every unit: its x moves to the middle
   * of the run and its w grows by (units - 1) x pitch. Every other port is left alone.
   */
  span?: string;
}

export interface PartUse {
  /** Short reference used in connections, e.g. "mcu", "oled", "r1". */
  ref: string;
  /** PartDef id. */
  part: string;
  /** Human label for the guide when the part name is not enough, e.g. "Status LED". */
  label?: string;
  /** For passives: the value printed in the BOM and guide, e.g. "220 ohm", "100 nF". */
  value?: string;
  /**
   * The user already has this part. It stays in the guide and the checks, costs
   * nothing, needs no sourcing line, and the shopping page lists it under "already on
   * your bench" with what to verify on it.
   */
  owned?: boolean;
  /** Position on the bench for the wiring illustrations. Auto-laid-out when omitted. */
  bench?: Placement;
  /**
   * Position in the top-down wiring diagram (drawing.ts), in millimetres, when its own
   * layout reads badly. Separate from `bench`, which places the part in the booklet.
   */
  plan?: Placement;
  /**
   * This build's peak current for the part, when something outside the part limits it:
   * firmware capping an LED strip at 25 % brightness, a servo that never stalls.
   * Overrides the part file in the power checks. Needs `peakMaWhy`, which is shown to
   * the user, because the limit is only as real as the firmware that enforces it.
   */
  peakMa?: number;
  peakMaWhy?: string;
  /**
   * For parts whose file gives current per unit (`electrical.perUnit`): how many
   * units this build has, e.g. 8 pixels of LED strip. The power checks multiply by it.
   */
  units?: number;
}

export interface Placement {
  x: number;
  y: number;
  z?: number;
  rot?: 0 | 90 | 180 | 270;
}

export type WireColor =
  | "red"
  | "black"
  | "yellow"
  | "green"
  | "blue"
  | "white"
  | "orange"
  | "purple"
  | "grey"
  | "brown";

export interface Connection {
  /** "<ref>.<pin name>", e.g. "mcu.GPIO8". */
  from: string;
  to: string;
  /** Net name for schematics and firmware comments, e.g. "I2C_SDA". Derived when omitted. */
  net?: string;
  color?: WireColor;
  /** Why this connection exists, in a few words. Shown as the step caption. */
  why?: string;
}

/**
 * An opening the parts do not imply, such as a cable exit for a probe or LED strip that
 * lives outside the case on a lead. Side faces: u runs along the wall from the outer corner
 * at minimum x or y, v is height above the outer bottom. Lid: u = world x, v = world y.
 */
export interface CustomOpening {
  face: "x-" | "x+" | "y-" | "y+" | "lid";
  u: number;
  v: number;
  w: number;
  h: number;
  shape: "rect" | "round";
  /** Shown in the guide and used as the opening's port name, e.g. "probe cable". */
  label: string;
  /**
   * Refs of the unmounted parts whose lead leaves the case through this opening. Only an
   * opening that names a part here answers that part's "not mounted" warning.
   */
  cableFor?: string[];
}

/**
 * A printed cap over the stem of a button, so the button is as large as the cap and not as
 * small as the stem. Only on a floor mount: the part then stands on a post from the floor,
 * tall enough for its stem to reach through the lid, and the lid opening is cut to the cap.
 * A flange under the lid keeps the cap in, so it needs no glue and cannot fall out.
 */
export interface CapSpec {
  shape: "round" | "rect";
  /** Diameter of a round cap, or the size of a rect cap along x, in mm. */
  w: number;
  /** Size of a rect cap along y. Defaults to `w`. */
  h?: number;
  /** Colour in the renders and the 3D model. It is printed in whatever filament the user loads. */
  color?: string;
}

/** A part that is mounted inside the case, with a position. */
export type PlacedMount = Placement & { ref: string; on: "floor" | "lid"; standoff?: number; cap?: CapSpec };

/** A part soldered into a wire (a resistor, a diode): it hangs in the wiring, gets no posts and needs no mount. */
export interface WireMount {
  ref: string;
  on: "wire";
}

export interface EnclosureSpec {
  /** Inner cavity. Computed from the mounted parts when omitted. */
  inner?: { w: number; d: number; h: number };
  wall: number;
  /** Gap added around parts and between lid and body so prints from an ordinary FDM printer fit. */
  fit: number;
  /** Outside corner radius. */
  radius: number;
  lid: "screw" | "snap" | "slide";
  /**
   * Where each part sits inside the cavity. x and y are measured from the inner front-left
   * corner (the wall is not included); x: 0, y: 0 asks the layout to place the part.
   * `{ ref, on: "wire" }` marks a part that hangs in the wiring and needs no mount.
   */
  mounts: (PlacedMount | WireMount)[];
  /**
   * Openings. "auto" derives every opening from the ports of the mounted parts. A list names
   * the ports to open, and may also hold custom entries such as a cable exit.
   */
  openings: "auto" | ({ ref: string; port: string } | CustomOpening)[];
  /** Custom openings added to whatever `openings` produces, e.g. "auto" plus a cable exit for a probe on a lead. */
  extraOpenings?: CustomOpening[];
  material: string;
  color: string;
}

export interface Showcase {
  /** Five to nine words. The promise, not the parts list. */
  headline: string;
  subhead: string;
  /** Three steps describing how the finished thing is used, not how it is built. */
  howItWorks: { title: string; body: string }[];
  features: { title: string; body: string }[];
  /** Headline numbers shown in the stats grid, e.g. { value: "14", unit: "days", label: "battery life" }. */
  stats: { value: string; unit?: string; label: string }[];
  faq: { q: string; a: string }[];
  theme: {
    mood: "minimal-light" | "stage-dark" | "blueprint" | "warm-paper";
    accent: string;
    /** Display font family name available on Google Fonts. */
    display: string;
    text: string;
  };
  /** Heading of the dark features band. Two short sentences read best. Defaults to the tagline. */
  featuresHeading?: string;
  author?: string;
  license?: string;
  /**
   * What the LEDs show in the product renders (render.ts): a hex colour that lights every
   * LED shape of every part ("#ff2a1a"), or a map from part ref to colour, which lights
   * only those parts ({ "bar": "#ff2a1a" }). The lit LEDs glow and light the plastic
   * around them. Leave it out and LEDs render unlit, as before.
   */
  lit?: string | Record<string, string>;
}

export interface Project {
  schema: 1;
  slug: string;
  name: string;
  tagline: string;
  /** Two or three sentences: who it is for, what it does, why it exists. */
  summary: string;
  build: {
    /** wire: hand-wired modules. pcb-diy: carrier PCB the user solders. pcb-assembled: factory-assembled board. */
    path: "wire" | "pcb-diy" | "pcb-assembled";
    /** wire path only: soldered joints or push-on jumper leads. */
    joint?: "solder" | "dupont";
    difficulty: 1 | 2 | 3;
    minutes: number;
  };
  power: {
    source: "usb" | "lipo" | "aa" | "dc-jack";
    volts: number;
    /** What the source can deliver. 500 for a plain USB port. */
    budgetMa: number;
    /** Ref and pin where power enters, e.g. "mcu.5V". */
    entry?: string;
  };
  parts: PartUse[];
  connections: Connection[];
  enclosure?: EnclosureSpec;
  firmware?: {
    framework: "arduino" | "esp-idf" | "esphome" | "micropython";
    /** PlatformIO board id, e.g. "esp32-c3-devkitm-1". */
    board: string;
    libs?: string[];
    /**
     * Extra compiler flags, one per entry, e.g. ["-DBOARD_HAS_PSRAM"]. Written into the
     * generated platformio.ini, which is rewritten on every run, so this is the only
     * place they survive.
     */
    buildFlags?: string[];
    /**
     * PlatformIO `board_*` settings for the module actually fitted, e.g.
     * { "board_build.arduino.memory_type": "qio_opi" } to enable the 8 MB of extra RAM
     * on an ESP32-S3 N8R8 or N16R8. Keys must start with "board_".
     */
    boardOptions?: Record<string, string>;
    behaviour: string;
  };
  showcase?: Showcase;
  /** Filled by the sourcing step. */
  sourcing?: {
    region: string;
    /** Default currency for lines and shipping. A line or shipping entry can name its own `currency`; amounts in different currencies are never added together or converted. */
    currency: string;
    /**
     * One line per part to buy. `price` is what the buyer pays for the listing; when
     * the listing is a pack that also supplies other parts of the build, name their
     * refs in `covers` so the pack is counted once.
     */
    lines: { ref: string; store: string; url: string; price: number; note?: string; covers?: string[]; currency?: string }[];
    /**
     * Shipping per shop, in `currency` unless the entry names its own, so the total the user sees is what they pay.
     * Leave `price` out when a shop only shows shipping at checkout; the totals then say so instead of assuming zero.
     */
    shipping?: { store: string; price?: number; note?: string; currency?: string }[];
    checkedAt: string;
  };
}

/** A part placed in a scene, with its definition resolved. */
export interface PlacedPart {
  use: PartUse;
  def: PartDef;
  at: Required<Placement>;
}
