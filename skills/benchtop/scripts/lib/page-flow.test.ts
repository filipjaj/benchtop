// Lists on a fixed-size page are cut into pages by what they contain: no item is lost or
// repeated, order is kept, and no page is taller than its box unless one row alone is.

import { describe, expect, test } from "bun:test";
import { type Block, type Item, PAGE, PAGE_GAP, flowBlocks, rowsOf } from "./page-flow";

const item = (n: number, w: number, h: number): Item => ({ html: `<i data-n="${n}" data-w="${w}" data-h="${h}"></i>`, w, h });
const itemsOf = (html: string): { n: number; w: number; h: number }[] =>
  [...html.matchAll(/data-n="(\d+)" data-w="([\d.]+)" data-h="([\d.]+)"/g)].map((m) => ({ n: +m[1]!, w: +m[2]!, h: +m[3]! }));

describe("rows", () => {
  test("wrap where the width runs out, in order", () => {
    const rows = rowsOf([item(1, 60, 5), item(2, 60, 5), item(3, 60, 5), item(4, 120, 5)], 174, 10);
    expect(rows.map((r) => r.map((i) => i.html.match(/data-n="(\d+)"/)![1]))).toEqual([["1", "2"], ["3"], ["4"]]);
  });
});

describe("flowing blocks over pages", () => {
  // A deterministic spread of item sizes.
  const make = (count: number, seed: number): Item[] => Array.from({ length: count }, (_, i) => item(i, 20 + ((i * 37 + seed) % 90), 8 + ((i * 53 + seed * 7) % 60)));

  test("every item appears exactly once and in order, whatever the number of items", () => {
    for (const count of [0, 1, 5, 17, 60, 200]) {
      const blocks: Block[] = [{ open: `<div class="inventory">`, close: `</div>`, items: make(count, count), gapX: 10, gapY: 9, lead: 0 }];
      const pages = flowBlocks(blocks);
      const seen = pages.flatMap((p) => itemsOf(p).map((i) => i.n));
      expect(seen).toEqual(Array.from({ length: count }, (_, i) => i));
    }
  });

  test("no page is taller than the box: the rows on it, with their gaps, fit the capacity", () => {
    for (const seed of [1, 2, 3, 4, 5]) {
      const a: Block = { open: `<div>`, close: `</div>`, items: make(40, seed), gapX: 10, gapY: 9, lead: 0 };
      const b: Block = { open: `<div class="wires">`, close: `</div>`, items: make(25, seed + 9), gapX: 12, gapY: 6, lead: 6.3 };
      for (const page of flowBlocks([a, b])) {
        // Rebuild the page's height the way the flow built it: each container is its own set of rows.
        let used = 0;
        let first = true;
        for (const part of page.split(/(?=<div)/).filter(Boolean)) {
          const block = part.startsWith('<div class="wires">') ? b : a;
          const rows = rowsOf(itemsOf(part).map((i) => item(i.n, i.w, i.h)), PAGE.w, block.gapX);
          const heights = rows.map((r) => Math.max(...r.map((i) => i.h)));
          used += (first ? 0 : PAGE_GAP) + block.lead + heights.reduce((s, h) => s + h, 0) + block.gapY * (heights.length - 1);
          first = false;
        }
        expect(used).toBeLessThanOrEqual(PAGE.h + 0.001);
      }
    }
  });

  test("a continued block opens again on the next page, with its own rule and padding", () => {
    const wires: Block = { open: `<div class="wires">`, close: `</div>`, items: Array.from({ length: 60 }, (_, i) => item(i, 40, 11)), gapX: 12, gapY: 6, lead: 6.3 };
    const pages = flowBlocks([wires]);
    expect(pages.length).toBeGreaterThan(1);
    for (const p of pages) {
      expect(p.startsWith('<div class="wires">')).toBe(true);
      expect(p.endsWith("</div>")).toBe(true);
    }
  });

  test("a row taller than a page goes alone instead of looping", () => {
    const pages = flowBlocks([{ open: "<div>", close: "</div>", items: [item(0, 100, PAGE.h + 40), item(1, 100, 10)], gapX: 10, gapY: 9, lead: 0 }]);
    expect(pages.map((p) => itemsOf(p).map((i) => i.n))).toEqual([[0], [1]]);
  });
});
