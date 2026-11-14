import { describe, expect, test } from "bun:test";
import { classify } from "./build";

const VALIDATE = [
  "WARN (1)",
  "  [logic-level-low] mcu pin 12 drives 3.3 V but bar pin DIN needs at least 3.5 V to read a high.",
  "    where: mcu.12, bar.DIN",
  "    fix: Put a level shifter in the signal line.",
  "INFO (1)",
  '  [declared-limit] The power budget assumes bar never draws more than 120 mA. Reason given: "cap".',
  "    fix: Make sure the firmware enforces the 120 mA limit.",
  "0 error(s), 1 warning(s), 1 info: OK",
];

describe("build report: what is flagged and what is only on record", () => {
  test("a warning is flagged, an information line is not", () => {
    const r = classify(VALIDATE);
    expect(r.flagged.length).toBe(1);
    expect(r.flagged[0]).toContain("logic-level-low");
    expect(r.info.length).toBe(1);
    expect(r.info[0]).toContain("declared-limit");
  });

  test("checks from other generators are flagged; a check that found nothing is not", () => {
    const r = classify(["check: label mic.GND is overlapped by the wire of step 5", "check: No shorts detected", "drawing check: 23 drawings, no problems"]);
    expect(r.flagged).toEqual(["check: label mic.GND is overlapped by the wire of step 5"]);
    expect(r.info).toEqual([]);
  });

  test("an error under its heading is flagged", () => {
    expect(classify(["ERROR (1)", "  [high-below-supply] buzzer stays on"]).flagged.length).toBe(1);
  });
});
