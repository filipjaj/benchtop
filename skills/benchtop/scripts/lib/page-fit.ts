// Does every page of the guide hold its content? A page is a fixed A4 box with overflow
// hidden, so anything taller than the box is cut off without a trace in the file. This
// measures each page in headless Chrome and names what does not fit.
//
// The guide also paginates every list by estimated heights (guide.ts), so a measured
// overflow is a fault in an estimate or in a block no estimate covers. It must never be
// silent: guide.ts turns each result into a `drawing:` finding, and says so when there is no
// Chrome to measure with.

import { mkdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileUrl, findChrome } from "./tools";

export { findChrome };

export interface PageOverflow {
  /** 1-based page number in the booklet. */
  page: number;
  /** What was cut off, as the text of the elements that run past the page's usable area. */
  cut: string[];
}

/**
 * Runs in the page. The usable area of a page ends where its footer starts; an element
 * that reaches below that line, or past the right margin, is reported. Only the deepest
 * such elements are named, and a drawing is named as "a drawing".
 */
const MEASURE = `
(() => {
  const mm = (v) => (v * 96) / 25.4;
  const out = [];
  document.querySelectorAll("section.page").forEach((pg, i) => {
    const box = pg.getBoundingClientRect();
    const footer = pg.querySelector("footer");
    const bottom = (footer ? footer.getBoundingClientRect().top : box.bottom - mm(15)) - mm(0.5);
    const right = box.right - mm(17);
    const over = [];
    for (const el of pg.querySelectorAll("*")) {
      if (footer && footer.contains(el)) continue;
      if (el.closest("svg") && el.tagName.toLowerCase() !== "svg") continue;
      const r = el.getBoundingClientRect();
      if (r.width === 0 && r.height === 0) continue;
      if (r.bottom > bottom + 1 || r.right > right + 1) over.push(el);
    }
    const deepest = over.filter((el) => !over.some((o) => o !== el && el.contains(o)));
    const cut = deepest.map((el) => {
      if (el.tagName.toLowerCase() === "svg") return "a drawing";
      const t = (el.innerText || el.textContent || "").replace(/\\s+/g, " ").trim();
      return t ? t.slice(0, 70) : "<" + el.tagName.toLowerCase() + ">";
    });
    if (cut.length) out.push({ page: i + 1, cut });
  });
  const s = document.createElement("script");
  s.id = "page-fit";
  s.type = "application/json";
  s.textContent = JSON.stringify(out);
  document.body.appendChild(s);
})();
`;

/**
 * Measure every page of a guide's HTML. Null when no browser is available; otherwise the
 * pages that overflow (empty when all fit). The HTML is written to a temporary file with
 * the measuring script added, so any guide, old or new, can be measured.
 */
export async function measurePages(html: string): Promise<PageOverflow[] | null> {
  const chrome = await findChrome();
  if (!chrome) return null;
  const dir = join(tmpdir(), `benchtop-fit-${process.pid}-${Date.now()}`);
  await mkdir(dir, { recursive: true });
  try {
    const file = join(dir, "guide.html");
    // A wide window keeps the booklet in its print layout (the narrow layout starts below 230 mm).
    await Bun.write(file, html.replace("</body>", `<script>${MEASURE}</script></body>`));
    const proc = Bun.spawn(
      [
        chrome,
        "--headless=new",
        "--disable-gpu",
        "--window-size=1200,1600",
        `--user-data-dir=${join(dir, "profile")}`,
        "--virtual-time-budget=4000",
        "--dump-dom",
        fileUrl(file),
      ],
      { stdout: "pipe", stderr: "ignore" },
    );
    const timer = setTimeout(() => proc.kill(), 60_000);
    const dom = await new Response(proc.stdout).text();
    await proc.exited;
    clearTimeout(timer);
    const m = /<script id="page-fit" type="application\/json">([\s\S]*?)<\/script>/.exec(dom);
    if (!m) return null;
    return JSON.parse(m[1]!.replace(/&quot;/g, '"').replace(/&amp;/g, "&").replace(/&lt;/g, "<").replace(/&gt;/g, ">")) as PageOverflow[];
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}

/** One line per overflowing page, for the drawing check's output. */
export function overflowText(o: PageOverflow): string {
  const shown = o.cut.slice(0, 4).map((c) => `"${c}"`).join(", ");
  return `page ${o.page} is taller than its box, so ${shown}${o.cut.length > 4 ? ` and ${o.cut.length - 4} more` : ""} ${o.cut.length > 1 ? "are" : "is"} cut off or runs over the footer.`;
}
