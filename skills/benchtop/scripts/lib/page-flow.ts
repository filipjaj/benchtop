// Paginating a list that has no fixed length. The guide's pages are fixed A4 boxes, so a
// list of parts, wires, fasteners or checks must be cut into pages by what it contains.
// Each item says how big it will print (estimated in millimetres, generously); rows are
// formed the way the browser wraps them, and a page is closed when the next row would run
// past the usable area. page-fit.ts then measures the real pages as the safety net.

/** The usable area of an A4 page of the guide, in millimetres: inside its padding and above its footer. */
export const PAGE = { w: 174, h: 258 };

/** The gap the page leaves between its direct children (CSS `gap` on `.page`). */
export const PAGE_GAP = 7;

export interface Item {
  html: string;
  /** Printed width and height, mm. */
  w: number;
  h: number;
}

/** A group of items that wrap in rows inside one container, which may continue on the next page. */
export interface Block {
  open: string;
  close: string;
  items: Item[];
  gapX: number;
  gapY: number;
  /** Space above the first row on a page: a rule and its padding. */
  lead: number;
}

/** The rows a wrapping flex container makes of `items` in `maxW`, in order. */
export function rowsOf(items: readonly Item[], maxW: number, gapX: number): Item[][] {
  const rows: Item[][] = [];
  let row: Item[] = [];
  let used = 0;
  for (const it of items) {
    const need = row.length ? gapX + it.w : it.w;
    if (row.length && used + need > maxW) {
      rows.push(row);
      row = [];
      used = 0;
    }
    used += row.length ? gapX + it.w : it.w;
    row.push(it);
  }
  if (row.length) rows.push(row);
  return rows;
}

/**
 * Lay the blocks out page after page. A block is split between pages at a row; each piece
 * is its own container with the block's `open` and `close`. Returns one HTML body per
 * page. A single row taller than a page goes alone on a page (the measured check names it).
 */
export function flowBlocks(blocks: readonly Block[], capacity = PAGE.h): string[] {
  const pages: string[] = [];
  let page = "";
  let used = 0;
  const flush = (): void => {
    if (page) pages.push(page);
    page = "";
    used = 0;
  };
  for (const b of blocks) {
    const rows = rowsOf(b.items, PAGE.w, b.gapX);
    let chunk = "";
    let rowsInChunk = 0;
    const closeChunk = (): void => {
      if (rowsInChunk) page += `${b.open}${chunk}${b.close}`;
      chunk = "";
      rowsInChunk = 0;
    };
    for (const row of rows) {
      const h = Math.max(...row.map((i) => i.h));
      const need = rowsInChunk ? b.gapY + h : (page ? PAGE_GAP : 0) + b.lead + h;
      if (used + need > capacity && (page || rowsInChunk)) {
        closeChunk();
        flush();
        // The row starts a fresh page: no gap above it, but the block's rule and padding again.
        used = b.lead + h;
      } else {
        used += need;
      }
      chunk += row.map((i) => i.html).join("");
      rowsInChunk++;
    }
    closeChunk();
  }
  flush();
  return pages;
}

/** Characters of text at a font size in points, as millimetres of line (an average Noto Sans glyph is about half an em). */
export const textMm = (chars: number, pt: number): number => chars * pt * 0.3528 * 0.52;

/** Lines `chars` characters of `pt` text take in `width` mm. */
export const linesOf = (chars: number, pt: number, width: number): number => Math.max(1, Math.ceil(textMm(chars, pt) / Math.max(1, width)));

/** Height of one line of text at `pt` with the guide's line height of 1.4, mm. */
export const lineMm = (pt: number): number => pt * 0.3528 * 1.4;
