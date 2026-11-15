// Which PlatformIO platform a firmware.board belongs to, and what the scaffold writes for it.
//
// The board id decides the platform. PlatformIO knows that (`pio boards --json-output <id>`
// lists the platform of every board in its registry), so it is asked first; a small set of
// name patterns stands in when PlatformIO is not installed or does not know the id. The
// pinned versions below are the part that is a hand-kept table: each family is built and
// checked by hand, and only a family in this table gets a platformio.ini.

import { findPio, pioEnv } from "./tools";

export type FamilyId = "esp32" | "rp2040" | "avr";

export interface Family {
  id: FamilyId;
  /** PlatformIO platform name, as `pio boards` reports it in "platform". */
  platform: string;
  /** Exact version written to platformio.ini. Bump deliberately, see the comment on each. */
  version: string;
  /** Set when the platform comes from a git repository, not the registry: `version` is then a tag. */
  url?: string;
  /** Short name for messages. */
  label: string;
  /** Comment lines written above `platform =`, saying why it is pinned. */
  comment: string[];
  /** Extra [env] lines written after `framework = arduino`. */
  envLines: string[];
}

// Pinned on purpose: a new release can change the Arduino core and board definitions
// underneath a project that built yesterday. Each version was the latest stable release in
// the PlatformIO registry on the date beside it. Bump deliberately, rebuild both envs.
export const FAMILIES: readonly Family[] = [
  {
    id: "esp32",
    platform: "espressif32",
    version: "8.0.0",
    label: "ESP32",
    comment: [
      "; Pinned, not 'espressif32': a new release can change the Arduino core and board",
      "; definitions under a project that built yesterday. 8.0.0 was the latest stable",
      "; release in the PlatformIO registry on 2026-11-13. Bump it deliberately and rebuild both envs.",
    ],
    envLines: [],
  },
  {
    id: "rp2040",
    platform: "raspberrypi",
    // Official platform, earlephilhower core (arduino-pico). The platform's default Arduino
    // core is Arduino-Mbed, which has no Wi-Fi for the Pico W, no Serial.printf and no
    // Wire.setSDA; arduino-pico has all three and the same board ids (pico, rpipico, rpipicow).
    // 1.20.0 pins arduino-pico to a fixed commit, so the core cannot move under the project.
    version: "1.20.0",
    label: "RP2040",
    comment: [
      "; Pinned, not 'raspberrypi': a new release can change the Arduino core and board",
      "; definitions under a project that built yesterday. 1.20.0 was the latest stable",
      "; release in the PlatformIO registry on 2026-11-14. Bump it deliberately and rebuild both envs.",
      "; The core is arduino-pico (earlephilhower), not the platform's default Arduino-Mbed:",
      "; only arduino-pico supports Wi-Fi on the Pico W. Its commit is fixed by this platform version.",
    ],
    envLines: ["board_build.core = earlephilhower"],
  },
  {
    id: "avr",
    platform: "atmelavr",
    version: "5.3.0",
    label: "AVR",
    comment: [
      "; Pinned, not 'atmelavr': a new release can change the Arduino core and board",
      "; definitions under a project that built yesterday. 5.3.0 was the latest stable",
      "; release in the PlatformIO registry on 2026-11-14. Bump it deliberately and rebuild both envs.",
    ],
    envLines: [],
  },
];

export const familyByPlatform = (platform: string): Family | undefined => FAMILIES.find((f) => f.platform === platform);

/**
 * ESP32-P4, C5 and C61 boards. The registry's espressif32 (8.0.0, see above) has no board for
 * these chips: PlatformIO stops with "Unknown board ID". pioarduino's fork of the same platform
 * has them, and reports itself as "espressif32" too, so the board id picks it, not the lookup.
 */
export const ESP32_PIOARDUINO: Family = {
  ...FAMILIES[0]!,
  url: "https://github.com/pioarduino/platform-espressif32.git",
  version: "55.03.312-1",
  label: "ESP32 (pioarduino)",
  comment: [
    "; ESP32-P4, C5 and C61 are not in the registry's espressif32 (8.0.0 has no such board:",
    "; \"Unknown board ID\"), so this is pioarduino's fork, pinned to a git tag. 55.03.312-1",
    "; (Arduino core 3.3.12) is the tag a working ESP32-P4 Arduino project builds with, checked",
    "; 2026-11-15. C5 and C61 boards are listed in it but were not built. Bump it deliberately",
    "; and rebuild both envs.",
  ],
};

const PIOARDUINO_BOARD = /esp32[-_]?(p4|c5|c61)|(^|[-_])(p4|c5|c61)([-_]|$)/i;

/** The family a board really builds with: an ESP32 chip the registry platform lacks moves to pioarduino. */
const forBoard = (family: Family, board: string): Family => (family.id === "esp32" && PIOARDUINO_BOARD.test(board) ? ESP32_PIOARDUINO : family);

/** The `platform =` value: name@version from the registry, or url#tag from git. */
export const platformSpec = (f: Family): string => (f.url ? `${f.url}#${f.version}` : `${f.platform}@${f.version}`);

/** What `pio boards` said about a board id. */
export type Lookup =
  | { kind: "found"; platform: string; frameworks: string[] }
  | { kind: "unknown"; suggestions: string[] }
  /** PlatformIO is not installed, timed out or printed something unreadable. */
  | { kind: "unavailable" };

export type Resolution = { ok: true; family: Family; how: "PlatformIO" | "board name" } | { ok: false; reason: string };

/** Pure: turns the JSON of `pio boards --json-output <id>` into a Lookup for exactly that id. */
export function parseBoards(json: string, board: string): Lookup {
  let list: unknown;
  try {
    list = JSON.parse(json);
  } catch {
    return { kind: "unavailable" };
  }
  if (!Array.isArray(list)) return { kind: "unavailable" };
  const rows: { id: string; platform: string; frameworks: string[] }[] = [];
  for (const r of list as unknown[]) {
    if (!r || typeof r !== "object") continue;
    const o = r as { id?: unknown; platform?: unknown; frameworks?: unknown };
    if (typeof o.id !== "string" || typeof o.platform !== "string") continue;
    rows.push({ id: o.id, platform: o.platform, frameworks: Array.isArray(o.frameworks) ? o.frameworks.filter((f): f is string => typeof f === "string") : [] });
  }
  const exact = rows.filter((r) => r.id === board);
  if (exact.length) {
    // One id can be listed twice (rpipico is, once per core). Prefer a platform the scaffold knows.
    const first = exact.find((r) => familyByPlatform(r.platform)) ?? exact[0]!;
    const frameworks = [...new Set(exact.filter((r) => r.platform === first.platform).flatMap((r) => r.frameworks))];
    return { kind: "found", platform: first.platform, frameworks };
  }
  return { kind: "unknown", suggestions: [...new Set(rows.map((r) => r.id))].slice(0, 6) };
}

/** Asks PlatformIO. It reads its cached registry, so this takes about a second. */
export async function pioLookup(board: string): Promise<Lookup> {
  try {
    const pio = findPio();
    if (!pio) return { kind: "unavailable" };
    const proc = Bun.spawn([pio, "boards", "--json-output", board], { stdout: "pipe", stderr: "ignore", timeout: 30_000, env: pioEnv() });
    const [out, code] = await Promise.all([new Response(proc.stdout).text(), proc.exited]);
    return code === 0 ? parseBoards(out, board) : { kind: "unavailable" };
  } catch {
    return { kind: "unavailable" };
  }
}

// Used only when PlatformIO cannot be asked, or does not know the id. Ids PlatformIO knows are
// never routed by these. RP2040 first: "nanorp2040connect" also starts like an AVR Nano.
const BY_NAME: readonly [FamilyId, RegExp][] = [
  ["rp2040", /rp2040|rp2350|^(rpi)?pico/i],
  ["avr", /^(uno|unomini|nanoatmega\d+\w*|megaatmega\d+\w*|leonardo(eth)?|micro|pro(8|16)MHzatmega\d+|diecimila\w*|miniatmega\d+|attiny\d+\w*|atmega\d+\w*|sparkfun_promicro\w*)$/i],
  ["esp32", /esp32|wrover|(^|[_-])(c3|c6|s2|s3|d32)([_-]|$)|^(m5|ttgo|heltec_wifi|firebeetle|featheresp32|nodemcu-32)/i],
];

export function guessFamily(board: string): Family | undefined {
  const hit = BY_NAME.find(([, re]) => re.test(board));
  return hit ? FAMILIES.find((f) => f.id === hit[0]) : undefined;
}

const SUPPORTED = FAMILIES.map((f) => `${f.platform} (${f.label})`).join(", ");

/**
 * The platform for a board, or the reason the scaffold has none. `lookup` is injectable so
 * tests need no PlatformIO.
 */
export async function resolveBoard(board: string, lookup: (b: string) => Promise<Lookup> = pioLookup): Promise<Resolution> {
  const found = await lookup(board);
  if (found.kind === "found") {
    const family = familyByPlatform(found.platform);
    if (!family) {
      return {
        ok: false,
        reason: `board "${board}" belongs to the PlatformIO platform "${found.platform}". The scaffold has a pinned platform and generated code for ${SUPPORTED} only, so it writes include/pins.h and no platformio.ini. Set up the PlatformIO project by hand, or choose a board from a supported family.`,
      };
    }
    if (found.frameworks.length && !found.frameworks.includes("arduino")) {
      return { ok: false, reason: `board "${board}" has no Arduino framework in PlatformIO (it offers: ${found.frameworks.join(", ")}). The scaffold only writes Arduino projects, so it writes include/pins.h and no platformio.ini.` };
    }
    return { ok: true, family: forBoard(family, board), how: "PlatformIO" };
  }
  const guess = guessFamily(board);
  if (guess) return { ok: true, family: forBoard(guess, board), how: "board name" };
  if (found.kind === "unavailable") {
    // Cannot tell, and nothing compiles without PlatformIO anyway: keep the long-standing default.
    return { ok: true, family: FAMILIES[0]!, how: "board name" };
  }
  const near = found.suggestions.length ? ` Ids that contain it: ${found.suggestions.join(", ")}.` : "";
  return { ok: false, reason: `PlatformIO has no board with the id "${board}", and the name does not look like an ESP32, RP2040 or AVR board.${near} Fix firmware.board in project.json (see \`pio boards\`); until then the scaffold writes include/pins.h only.` };
}

/** esp-idf and ESPHome's esp32 block are ESP32-only: used to flag them on another family's board. */
export function isEsp32(family: Family | undefined): boolean {
  return family?.id === "esp32";
}
