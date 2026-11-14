import { describe, expect, test } from "bun:test";
import { type LaneCheck, type Pt, Sheet, type SheetItem, checkLanes, checkSheet, clipLength, crossingPoints, relate, spreadOut, textWidth } from "./flat";

describe("text", () => {
  test("text width grows with length and is wider in capitals", () => {
    expect(textWidth("GND", 2)).toBeGreaterThan(textWidth("gnd", 2));
    expect(textWidth("GPIO10", 2)).toBeGreaterThan(textWidth("GND", 2));
  });
});

describe("spreading names out of the pad pitch", () => {
  test("names already far enough apart stay at their pads", () => {
    expect(spreadOut([0, 3, 6], -10, 10, 2.5)).toEqual([0, 3, 6]);
  });

  test("names too close are pushed apart, keep their order, and stay centred on the group", () => {
    const b = spreadOut([0, 1, 2, 3], -20, 20, 2.5)!;
    for (let i = 1; i < b.length; i++) expect(b[i]! - b[i - 1]!).toBeGreaterThanOrEqual(2.5 - 1e-9);
    expect(b[0]! + b[3]!).toBeCloseTo(3, 6);
  });

  test("a group against the end of the part is pushed back inside it, not past it", () => {
    const b = spreadOut([9, 9.5, 10], 0, 10, 2)!;
    expect(Math.max(...b)).toBeLessThanOrEqual(10 + 1e-9);
    for (let i = 1; i < b.length; i++) expect(b[i]! - b[i - 1]!).toBeGreaterThanOrEqual(2 - 1e-9);
  });

  test("names that cannot all fit in the room give null", () => {
    expect(spreadOut([0, 1, 2, 3], 0, 5, 2.5)).toBeNull();
    expect(spreadOut([], 0, 1, 2)).toEqual([]);
  });
});

describe("segment relations", () => {
  test("a right-angle crossing, a touch, an overlap and a clear pair", () => {
    expect(relate([[0, 5], [10, 5]], [[5, 0], [5, 10]], 0.5)).toEqual({ kind: "cross", at: [5, 5], perpendicular: true });
    expect(relate([[0, 5], [10, 5]], [[5, 0], [5, 5]], 0.5).kind).toBe("touch");
    expect(relate([[0, 5], [10, 5]], [[4, 5.2], [14, 5.2]], 0.5).kind).toBe("overlap");
    expect(relate([[0, 5], [10, 5]], [[4, 8], [14, 8]], 0.5).kind).toBe("none");
    expect(relate([[0, 0], [10, 10]], [[0, 10], [10, 0]], 0.5)).toMatchObject({ kind: "cross", perpendicular: true });
    expect(relate([[0, 0], [10, 10]], [[0, 10], [10, 6]], 0.5)).toMatchObject({ kind: "cross", perpendicular: false });
  });

  test("clipping measures the length inside a box", () => {
    expect(clipLength([0, 5], [20, 5], { x0: 5, y0: 0, x1: 15, y1: 10 })).toBeCloseTo(10);
    expect(clipLength([0, 12], [20, 12], { x0: 5, y0: 0, x1: 15, y1: 10 })).toBe(0);
    expect(clipLength([5, 0], [5, 10], { x0: 5, y0: 0, x1: 15, y1: 10 })).toBe(0);
  });
});

describe("lane checks", () => {
  const a = { ref: "a", pin: "1" };
  const b = { ref: "b", pin: "1" };
  const base = (wires: LaneCheck["wires"], extra: Partial<LaneCheck> = {}): LaneCheck => ({
    parts: [
      { ref: "a", rect: { x: 0, y: 0, w: 10, d: 10 } },
      { ref: "b", rect: { x: 30, y: 0, w: 10, d: 10 } },
    ],
    labels: [],
    wires,
    pads: new Map<string, Pt>([["a.1", [5, 8]], ["b.1", [35, 8]]]),
    steps: [{ step: 1, from: a, to: b }],
    wire: 0.5,
    ...extra,
  });
  const lane = (step: number, net: string, y: number): LaneCheck["wires"][number] => ({ step, net, from: a, to: b, path: [[5, 8], [5, y], [35, y], [35, 8]] });

  test("a clean wire gives no lines", () => {
    expect(checkLanes(base([lane(1, "n", 15)]))).toEqual([]);
  });

  test("a connection missing, drawn twice or ending on the wrong pad", () => {
    expect(checkLanes(base([]))).toEqual(["step 1 is drawn 0 times, not once"]);
    expect(checkLanes(base([lane(1, "n", 15), lane(1, "n", 18)]))[0]).toContain("drawn 2 times");
    const wrong = { ...lane(1, "n", 15), path: [[5, 8], [5, 15], [35, 15], [36, 8]] as Pt[] };
    expect(checkLanes(base([wrong]))).toEqual(["step 1: the wire does not end on pad b.1"]);
  });

  test("a wire through a part, except out of its own pad", () => {
    expect(checkLanes(base([lane(1, "n", 15)]))).toEqual([]);
    const through = { ...lane(1, "n", 5), path: [[5, 8], [5, 5], [35, 5], [35, 8]] as Pt[] };
    expect(checkLanes(base([through])).some((l) => l.includes("runs through"))).toBe(true);
  });

  test("two nets: a right-angle crossing is fine, running along each other is not", () => {
    const h = lane(1, "n", 15);
    const v = { step: 2, net: "m", from: a, to: b, path: [[20, 12], [20, 25]] as Pt[] };
    const steps = [{ step: 1, from: a, to: b }, { step: 2, from: a, to: b }];
    const pads = new Map<string, Pt>([["a.1", [20, 12]], ["b.1", [20, 25]]]);
    const ok = checkLanes(base([h, v], { steps, pads: new Map([...pads, ["a.1", [5, 8]], ["b.1", [35, 8]]]) }));
    expect(ok.filter((l) => !l.includes("start on") && !l.includes("end on"))).toEqual([]);
    expect(crossingPoints([h, v], 0.5)).toEqual([[20, 15]]);
    const along = { step: 2, net: "m", from: a, to: b, path: [[8, 15.2], [30, 15.2]] as Pt[] };
    expect(checkLanes(base([h, along], { steps })).some((l) => l.includes("overlap along a run"))).toBe(true);
    const touching = { step: 2, net: "m", from: a, to: b, path: [[20, 15], [20, 25]] as Pt[] };
    expect(checkLanes(base([h, touching], { steps })).some((l) => l.includes("touches"))).toBe(true);
  });

  test("labels: under a wire, on each other, on a part; a tag may sit on its own lane", () => {
    const w = lane(1, "n", 15);
    const label = (id: string, x0: number, net?: string) => ({ id, box: { x0, y0: 14, x1: x0 + 4, y1: 16 }, ...(net ? { net } : {}) });
    expect(checkLanes(base([w], { labels: [label("L", 15)] })).some((l) => l.includes("L is overlapped by the wire of step 1"))).toBe(true);
    expect(checkLanes(base([w], { labels: [label("tag", 15, "n")] }))).toEqual([]);
    expect(checkLanes(base([w], { labels: [label("A", 15, "n"), label("B", 17, "n")] })).some((l) => l.includes("A overlaps label B"))).toBe(true);
    expect(checkLanes(base([w], { labels: [{ id: "P", box: { x0: 8, y0: 4, x1: 12, y1: 6 } }] })).some((l) => l.includes("P overlaps part a"))).toBe(true);
    expect(checkLanes(base([w], { labels: [{ id: "P", box: { x0: 2, y0: 4, x1: 6, y1: 6 }, inside: "a" }] }))).toEqual([]);
  });
});

describe("sheet ledger", () => {
  const text = (id: string, x0: number, y0: number, x1: number, y1: number, group?: string): SheetItem => ({ id, kind: "text", box: { x0, y0, x1, y1 }, moves: `the input of ${id}`, group });

  test("a clean sheet reports nothing", () => {
    const s = new Sheet();
    s.add(text("a", 0, 0, 10, 3));
    s.add(text("b", 0, 5, 10, 8));
    s.add({ id: "view", kind: "outline", box: { x0: 20, y0: 0, x1: 60, y1: 40 }, moves: "the case size" });
    s.add(text("inside", 25, 5, 35, 8));
    expect(checkSheet(s, "t.svg")).toEqual([]);
  });

  test("two texts that overlap are reported, naming both and the input that moves them", () => {
    const s = new Sheet();
    s.add(text("USB native", 0, 0, 10, 3));
    s.add(text("UART serial", 8, 1, 20, 4));
    const out = checkSheet(s, "t.svg");
    expect(out).toHaveLength(1);
    expect(out[0]).toContain('"USB native" overlaps "UART serial"');
    expect(out[0]).toContain("the input of USB native");
  });

  test("a text across the line of an outline, or on something solid, is reported; inside or outside is not", () => {
    const s = new Sheet();
    s.add({ id: "view", kind: "outline", box: { x0: 0, y0: 0, x1: 40, y1: 40 }, moves: "the case size" });
    s.add(text("across", 35, 10, 45, 13));
    s.add({ id: "screw", kind: "solid", box: { x0: 10, y0: 20, x1: 14, y1: 24 }, moves: "the screw layout" });
    s.add(text("on screw", 11, 21, 20, 24));
    s.add(text("outside", 50, 10, 60, 13));
    const out = checkSheet(s, "t.svg");
    expect(out.some((l) => l.includes('"across"') && l.includes("view"))).toBe(true);
    expect(out.some((l) => l.includes('"on screw"'))).toBe(true);
    expect(out.some((l) => l.includes('"outside"'))).toBe(false);
  });

  test("a dimension's number may sit on its own line but not on another's", () => {
    const s = new Sheet();
    s.add({ ...text("dim 5", 0, 0, 6, 3, "d1"), kind: "text" });
    s.add({ id: "dim 5 line", kind: "line", box: { x0: 0, y0: 1, x1: 20, y1: 1.2 }, group: "d1", moves: "x" });
    s.add({ id: "other line", kind: "line", box: { x0: 3, y0: 0, x1: 3.2, y1: 20 }, group: "d2", moves: "y" });
    const out = checkSheet(s, "t.svg");
    expect(out).toHaveLength(1);
    expect(out[0]).toContain("other line");
  });

  test("free() says whether a new text would touch what is there", () => {
    const s = new Sheet();
    s.add(text("a", 0, 0, 10, 3));
    expect(s.free(text("n", 5, 1, 15, 4))).toBe(false);
    expect(s.free(text("n", 20, 1, 30, 4))).toBe(true);
  });
});
