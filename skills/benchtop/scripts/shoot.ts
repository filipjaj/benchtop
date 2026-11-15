#!/usr/bin/env bun
// Screenshot a generated HTML file with headless Chrome so the agent can look at
// what it built before showing it to anyone.
//
// Usage: bun shoot.ts <file.html> <outDir> [--pages 1,2,5] [--from 2400] [--width 820] [--height 1175]
// --from <px> captures the window that starts that far down the page, so a long
// landing page can be read in screen-sized pieces (writes shot-from-<px>.png).
// With --pages, captures the guide one page per image (index.html?only=N). Without it,
// captures the top of the document at the given size (use a tall --height for a
// long landing page).

import { mkdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { fileUrl, findChrome } from "./lib/tools";

const args = process.argv.slice(2);
const flag = (name: string, fallback: string): string => {
  const i = args.indexOf(`--${name}`);
  return i >= 0 && args[i + 1] ? args[i + 1]! : fallback;
};
const positional = args.filter((a, i) => !a.startsWith("--") && !(args[i - 1] ?? "").startsWith("--"));
const [file, outDir] = positional;
if (!file || !outDir) {
  console.error("usage: bun shoot.ts <file.html> <outDir> [--pages 1,2,5] [--width 820] [--height 1175]");
  process.exit(2);
}
const chrome = await findChrome();
if (!chrome) {
  console.error("no Chrome, Chromium or Edge found; open the file in a browser instead");
  process.exit(3);
}
await mkdir(outDir, { recursive: true });
const width = flag("width", "820");
const height = flag("height", "1175");
const pages = flag("pages", "");
const from = Number(flag("from", "0"));
let source = resolve(file);
let shotName = "shot.png";
if (!pages && from > 0) {
  // Headless Chrome cannot scroll before a screenshot, so the page is framed in a
  // wrapper that shifts it up by the requested offset.
  const wrap = join(tmpdir(), `benchtop-shoot-${process.pid}.html`);
  await Bun.write(
    wrap,
    `<!doctype html><meta charset="utf-8"><style>html,body{margin:0;overflow:hidden}iframe{position:absolute;left:0;top:-${from}px;width:100%;height:${from + Number(height)}px;border:0}</style><iframe src="${fileUrl(source, "?still=1")}"></iframe>`,
  );
  source = wrap;
  shotName = `shot-from-${from}.png`;
}
// ?still=1 asks a benchtop landing page to keep its line drawing on the stage. Headless
// Chrome runs without a GPU here, so a loaded 3D model would show as an empty stage.
const targets = pages ? pages.split(",").map((p) => ({ hash: `?only=${p.trim()}`, name: `page-${p.trim()}.png` })) : [{ hash: "?still=1", name: shotName }];
for (const t of targets) {
  const out = join(resolve(outDir), t.name);
  await rm(out, { force: true });
  const proc = Bun.spawn(
    [
      chrome,
      "--headless=new",
      "--disable-gpu",
      "--hide-scrollbars",
      // A private profile: sharing the user's running Chrome profile makes headless runs fail at random.
      `--user-data-dir=${join(tmpdir(), `benchtop-chrome-${process.pid}`)}`,
      "--virtual-time-budget=5000",
      `--window-size=${width},${height}`,
      `--screenshot=${out}`,
      // Only the --from wrapper needs it, to frame one local file inside another.
      ...(from > 0 ? ["--allow-file-access-from-files"] : []),
      fileUrl(source, t.hash),
    ],
    { stdout: "ignore", stderr: "ignore" },
  );
  // WebGL content can keep headless Chrome alive after the screenshot is written.
  const timer = setTimeout(() => proc.kill(), 45_000);
  await proc.exited;
  clearTimeout(timer);
  console.log((await Bun.file(out).exists()) ? out : `failed: ${t.name}`);
}
