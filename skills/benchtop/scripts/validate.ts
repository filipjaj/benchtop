// Usage: bun validate.ts <projectDir> [--json]
// Exit 0: no errors. 1: at least one error. 2: the project could not be loaded.

import { loadProject, main, ProjectError } from "./lib/project";
import { checkProject } from "./lib/rules";
import type { Finding } from "./lib/rules";

const LEVELS: Finding["level"][] = ["error", "warn", "info"];

await main(async () => {
  const args = process.argv.slice(2);
  const json = args.includes("--json");
  const dir = args.find((a) => !a.startsWith("--"));
  if (!dir) throw new ProjectError("usage: bun validate.ts <projectDir> [--json]");

  const findings = checkProject(await loadProject(dir));
  const count = (level: Finding["level"]): number => findings.filter((f) => f.level === level).length;
  const ok = count("error") === 0;

  if (json) {
    console.log(JSON.stringify({ ok, findings }, null, 2));
  } else {
    for (const level of LEVELS) {
      const group = findings.filter((f) => f.level === level);
      if (group.length === 0) continue;
      console.log(`${level.toUpperCase()} (${group.length})`);
      for (const f of group) {
        console.log(`  [${f.code}] ${f.message}`);
        if (f.refs.length > 0) console.log(`    where: ${f.refs.join(", ")}`);
        console.log(`    fix: ${f.fix}`);
      }
      console.log("");
    }
    console.log(`${count("error")} error(s), ${count("warn")} warning(s), ${count("info")} info: ${ok ? "OK" : "FAILED"}`);
  }
  process.exitCode = ok ? 0 : 1;
});
