import { afterAll, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { chromePaths, fileUrl, findBlender, findChrome, findPio, pioEnv, zipCommand } from "./tools";

const tmp = mkdtempSync(join(tmpdir(), "benchtop-tools-"));
afterAll(() => rmSync(tmp, { recursive: true, force: true }));
const touch = (...parts: string[]): string => {
  const p = join(tmp, ...parts);
  mkdirSync(join(p, ".."), { recursive: true });
  writeFileSync(p, "");
  return p;
};
// No PATH: only the env override and the install folders can be found.
const bare = { PATH: "" };

describe("findChrome", () => {
  test("BENCHTOP_CHROME wins over everything else", async () => {
    const own = touch("own", "chrome.exe");
    const pf = join(tmp, "pf");
    touch("pf", "Google", "Chrome", "Application", "chrome.exe");
    expect(await findChrome({ ...bare, BENCHTOP_CHROME: own, ProgramFiles: pf }, "win32")).toBe(own);
  });

  test("on Windows it finds Chrome, Chromium or Edge under ProgramFiles, ProgramFiles(x86) and LOCALAPPDATA", async () => {
    const paths = chromePaths({ ProgramFiles: "P", "ProgramFiles(x86)": "X", LOCALAPPDATA: "L" }, "win32");
    expect(paths).toContain(join("P", "Google", "Chrome", "Application", "chrome.exe"));
    expect(paths).toContain(join("X", "Microsoft", "Edge", "Application", "msedge.exe"));
    expect(paths).toContain(join("L", "Chromium", "Application", "chrome.exe"));
    const edge = touch("x86", "Microsoft", "Edge", "Application", "msedge.exe");
    expect(await findChrome({ ...bare, "PROGRAMFILES(X86)": join(tmp, "x86") }, "win32")).toBe(edge);
  });

  test("elsewhere the Windows folders are not looked at, and nothing found is null", async () => {
    expect(chromePaths({ ProgramFiles: "P" }, "linux").some((p) => p.startsWith("P"))).toBe(false);
    expect(await findChrome({ ...bare, ProgramFiles: join(tmp, "pf") }, "linux")).toBeNull();
  });
});

describe("fileUrl", () => {
  test("a Windows path becomes file:///C:/... with forward slashes and escapes", () => {
    expect(fileUrl(String.raw`C:\Users\a b\out\guide\index.html`, "", true)).toBe("file:///C:/Users/a%20b/out/guide/index.html");
  });

  test("a query suffix stays a query, and a # in the path does not become a fragment", () => {
    expect(fileUrl("/tmp/a#b/index.html", "?only=3", false)).toBe("file:///tmp/a%23b/index.html?only=3");
  });
});

describe("findBlender", () => {
  test("BLENDER_EXE wins, then the newest Blender under Program Files", () => {
    const own = touch("bl", "blender.exe");
    const pf = join(tmp, "blpf");
    touch("blpf", "Blender Foundation", "Blender 4.2", "blender.exe");
    const newest = touch("blpf", "Blender Foundation", "Blender 10.0", "blender.exe");
    expect(findBlender({ ...bare, BLENDER_EXE: own, ProgramFiles: pf }, "win32")).toBe(own);
    expect(findBlender({ ...bare, ProgramFiles: pf }, "win32")).toBe(newest);
    expect(findBlender({ ...bare, ProgramFiles: pf }, "linux")).toBeNull();
  });
});

describe("PlatformIO", () => {
  test("found in its default install when not on PATH", () => {
    const home = join(tmp, "home");
    const exe = touch("home", ".platformio", "penv", "Scripts", "pio.exe");
    const bin = touch("home", ".platformio", "penv", "bin", "pio");
    expect(findPio(bare, "win32", home)).toBe(exe);
    expect(findPio(bare, "linux", home)).toBe(bin);
    expect(findPio(bare, "linux", join(tmp, "nobody"))).toBeNull();
  });

  test("MSYSTEM is dropped on Windows only", () => {
    expect(pioEnv({ MSYSTEM: "MINGW64", A: "1" }, "win32")).toEqual({ A: "1" });
    expect(pioEnv({ MSYSTEM: "MINGW64" }, "linux")).toEqual({ MSYSTEM: "MINGW64" });
  });
});

describe("zipCommand", () => {
  test("Windows without zip falls back to the built-in tar, and no tool is null", () => {
    const root = join(tmp, "win");
    const tar = touch("win", "System32", "tar.exe");
    expect(zipCommand("out.zip", "slug", { ...bare, SystemRoot: root }, "win32")).toEqual([tar, "-a", "-c", "-f", "out.zip", "slug"]);
    expect(zipCommand("out.zip", "slug", { ...bare, SystemRoot: join(tmp, "none") }, "win32")).toBeNull();
    expect(zipCommand("out.zip", "slug", bare, "linux")).toBeNull();
  });
});
