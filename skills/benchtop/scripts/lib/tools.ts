// Where the external tools are: Chrome (PDF, screenshots, page measuring), Blender,
// PlatformIO and a zip writer. One finder per tool, so macOS, Linux and Windows are
// handled in one place instead of in every script that needs the tool.
//
// Every finder takes the environment and platform as arguments, so the Windows lookup
// can be tested on any machine.

import { existsSync, readdirSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";

export type Env = Record<string, string | undefined>;

/** Windows keeps the case it was given ("ProgramFiles"), a copied env may be upper case. */
const get = (env: Env, key: string): string | undefined => env[key] ?? env[key.toUpperCase()];

const which = (bin: string, env: Env): string | null => Bun.which(bin, { PATH: get(env, "PATH") ?? "" });

const MAC_CHROME = [
  "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome",
  "/Applications/Chromium.app/Contents/MacOS/Chromium",
  "/Applications/Microsoft Edge.app/Contents/MacOS/Microsoft Edge",
];
const CHROME_ON_PATH = ["google-chrome", "chromium", "chromium-browser", "chrome", "msedge"];

/** Install folders to look in, in order: BENCHTOP_CHROME, macOS apps, then the Windows installs. */
export function chromePaths(env: Env = process.env, platform: string = process.platform): string[] {
  // Chrome and Edge install per machine (Program Files) or per user (LOCALAPPDATA).
  const roots = platform === "win32" ? ["ProgramFiles", "ProgramFiles(x86)", "LOCALAPPDATA"].map((k) => get(env, k)).filter((r): r is string => !!r) : [];
  const win = roots.flatMap((r) => [
    join(r, "Google", "Chrome", "Application", "chrome.exe"),
    join(r, "Chromium", "Application", "chrome.exe"),
    join(r, "Microsoft", "Edge", "Application", "msedge.exe"),
  ]);
  return [get(env, "BENCHTOP_CHROME"), ...MAC_CHROME, ...win].filter((p): p is string => !!p);
}

/** Path of a Chrome-family browser that can run headless, or null. */
export async function findChrome(env: Env = process.env, platform: string = process.platform): Promise<string | null> {
  for (const p of chromePaths(env, platform)) if (await Bun.file(p).exists()) return p;
  for (const bin of CHROME_ON_PATH) {
    const found = which(bin, env);
    if (found) return found;
  }
  return null;
}

/**
 * file:// URL of a local file, with an optional "?only=3" style suffix. `file://${path}`
 * is wrong on Windows (drive letter, backslashes) and for any path with a space or "#".
 */
export function fileUrl(path: string, suffix = "", windows = process.platform === "win32"): string {
  return pathToFileURL(path, { windows }).href + suffix;
}

/** Blender: BLENDER_EXE, then PATH, then the usual installs (newest Windows version first). */
export function findBlender(env: Env = process.env, platform: string = process.platform): string | null {
  const own = get(env, "BLENDER_EXE");
  if (own && existsSync(own)) return own;
  const onPath = which("blender", env);
  if (onPath) return onPath;
  const installs: string[] = [];
  if (platform === "win32") {
    for (const root of ["ProgramFiles", "ProgramFiles(x86)"].map((k) => get(env, k))) {
      const dir = root && join(root, "Blender Foundation");
      if (!dir || !existsSync(dir)) continue;
      const versions = readdirSync(dir).filter((d) => d.startsWith("Blender")).sort((a, b) => b.localeCompare(a, undefined, { numeric: true }));
      installs.push(...versions.map((v) => join(dir, v, "blender.exe")));
    }
  }
  if (platform === "darwin") installs.push("/Applications/Blender.app/Contents/MacOS/Blender");
  return installs.find((p) => existsSync(p)) ?? null;
}

/** PlatformIO: PATH, then its default install, which the installer does not add to PATH. */
export function findPio(env: Env = process.env, platform: string = process.platform, home: string = homedir()): string | null {
  const own = which("pio", env);
  if (own) return own;
  const def = platform === "win32" ? join(home, ".platformio", "penv", "Scripts", "pio.exe") : join(home, ".platformio", "penv", "bin", "pio");
  return existsSync(def) ? def : null;
}

/** Environment for pio: PlatformIO refuses to run under MSYS (Git Bash sets MSYSTEM). */
export function pioEnv(env: Env = process.env, platform: string = process.platform): Env {
  const out = { ...env };
  if (platform === "win32") for (const k of Object.keys(out)) if (k.toUpperCase() === "MSYSTEM") delete out[k];
  return out;
}

/**
 * Command that zips `folder` (relative to the working directory) into `zipPath`, or null.
 * `zip` first; Windows has no zip but ships bsdtar, which writes a zip for a .zip name with -a.
 */
export function zipCommand(zipPath: string, folder: string, env: Env = process.env, platform: string = process.platform): string[] | null {
  const zip = which("zip", env);
  if (zip) return [zip, "-qr", zipPath, folder];
  if (platform !== "win32") return null;
  const tar = join(get(env, "SystemRoot") ?? "C:\\Windows", "System32", "tar.exe");
  return existsSync(tar) ? [tar, "-a", "-c", "-f", zipPath, folder] : null;
}
