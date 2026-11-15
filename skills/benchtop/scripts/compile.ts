#!/usr/bin/env bun
// Compile the project's firmware: bun compile.ts <projectDir> [--env bringup,main]
//
// Firmware that has never been through a compiler is a guess. A trial build shipped a
// "clean" package whose main program stopped on one misspelled identifier, because
// compiling was a step the builder could choose to skip. It is now part of build.ts.
//
// Exit codes: 0 every environment compiled; 1 a compile failed (the errors are printed
// last, one per line, as file:line: message); 3 could not compile here (PlatformIO is
// not installed, or the project's framework is not one this script builds).
//
// The first compile for a chip family downloads its toolchain (about 1 GB, several
// minutes). That is PlatformIO fetching what the pinned platform in platformio.ini
// names; it is expected and is not "installing software" in any sense a build should
// avoid. Later compiles take 10 to 30 seconds.

import { existsSync } from "node:fs";
import { join } from "node:path";
import { resolveBoard } from "./lib/platform";
import { ProjectError, loadProject, main } from "./lib/project";
import { findPio, pioEnv } from "./lib/tools";

const SOFT = 3;

/** Compiler diagnostics worth repeating: `src/main.cpp:70:53: error: ...` and linker errors. */
const ERROR_LINE = /(:\d+:\d+: (fatal )?error: |undefined reference to |^\*\*\* \[.*\] Error |: error: )/;

export interface CompileResult {
  env: string;
  ok: boolean;
  seconds: number;
  /** "Flash: [==  ] 34.5% (used 1153973 bytes from 3342336 bytes)" style lines, as printed. */
  size: string[];
  errors: string[];
}

/** Pulls the useful lines out of PlatformIO's output. Pure, so it can be tested without a toolchain. */
export function summarise(env: string, output: string, exitCode: number, seconds: number): CompileResult {
  const lines = output.split("\n").map((l) => l.trimEnd());
  return {
    env,
    ok: exitCode === 0,
    seconds,
    size: lines.filter((l) => /^(RAM|Flash):\s/.test(l)).map((l) => l.replace(/\s*\[[=\s]*\]\s*/, " ")),
    // The same error is often printed once per translation unit that includes a header.
    errors: [...new Set(lines.filter((l) => ERROR_LINE.test(l)).map((l) => l.trim()))],
  };
}

if (import.meta.main) {
  await main(async () => {
    const args = process.argv.slice(2);
    const dir = args.find((a, i) => !a.startsWith("--") && args[i - 1] !== "--env");
    if (!dir) throw new ProjectError("usage: bun compile.ts <projectDir> [--env bringup,main]");
    const i = args.indexOf("--env");
    const loaded = await loadProject(dir);
    const fw = loaded.project.firmware;
    if (!fw) {
      console.log("compile skipped: the project has no firmware block");
      process.exit(SOFT);
    }
    if (fw.framework !== "arduino") {
      console.log(`compile skipped: this script builds arduino projects with PlatformIO; "${fw.framework}" has its own tool (for ESPHome: esphome compile <file>.yaml)`);
      process.exit(SOFT);
    }
    // Same decision firmware.ts made: a board without a scaffold platform has no platformio.ini
    // to build, which is "could not compile here" (soft), not a failure of the project's code.
    const target = await resolveBoard(fw.board);
    if (!target.ok) {
      console.log(`warning: NOT COMPILED: ${target.reason}`);
      process.exit(SOFT);
    }
    const fwDir = join(loaded.dir, "firmware");
    if (!existsSync(join(fwDir, "platformio.ini"))) throw new ProjectError(`no ${join(fwDir, "platformio.ini")}: run firmware.ts first`);
    const pio = findPio();
    if (!pio) {
      console.log("compile skipped: PlatformIO (pio) is not on PATH or in ~/.platformio, so the firmware has NOT been compiled. Install it (https://platformio.org/install/cli) and run this again before trusting main.cpp.");
      process.exit(SOFT);
    }
    // Bring-up first: it is generated, so a failure there is a skill or toolchain problem,
    // and a failure only in main is the hand-written program.
    const envs = i >= 0 && args[i + 1] ? args[i + 1]!.split(",").filter(Boolean) : ["bringup", "main"];
    const results: CompileResult[] = [];
    for (const env of envs) {
      const t0 = performance.now();
      const proc = Bun.spawn([pio, "run", "-d", fwDir, "-e", env], { stdout: "pipe", stderr: "pipe", env: pioEnv() });
      const [out, err, code] = await Promise.all([new Response(proc.stdout).text(), new Response(proc.stderr).text(), proc.exited]);
      const r = summarise(env, `${out}\n${err}`, code, (performance.now() - t0) / 1000);
      results.push(r);
      await Bun.write(join(fwDir, `compile-${env}.log`), `${out}\n${err}`);
      if (r.ok) console.log(`compiled ${env} in ${r.seconds.toFixed(0)} s${r.size.length ? `: ${r.size.join(", ")}` : ""}`);
      else console.log(`FAILED ${env} after ${r.seconds.toFixed(0)} s (full output: ${join(fwDir, `compile-${env}.log`)})`);
    }
    const failed = results.filter((r) => !r.ok);
    if (failed.length) {
      // Last, so build.ts (which keeps the tail of a failed step) shows exactly these.
      for (const r of failed) {
        if (!r.errors.length) console.log(`error: ${r.env} did not compile and PlatformIO printed no compiler error; read compile-${r.env}.log`);
        for (const e of r.errors.slice(0, 10)) console.log(`error: [${r.env}] ${e}`);
      }
      process.exit(1);
    }
  });
}
