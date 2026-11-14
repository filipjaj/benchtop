// Where the connections list goes when the plan cannot share a sheet with it.
//
// Regression: a plan that fits no scale above its list reports the scale that overflows
// least. The "list on its own sheet" rule compared scales only, read that as "barely
// smaller", kept the list under the plan and then split a five-part project over two
// sheets for no reason. The fixture is that project: a meeting recorder from the
// three-model trial (fixtures/recorder), which fits one sheet at 1 : 1.3 on its own.

import { describe, expect, test } from "bun:test";
import { join } from "node:path";
import { buildWiring } from "./drawing";
import { loadProject } from "./lib/project";

describe("the connections list and a plan that cannot sit above it", () => {
  test("the list moves to its own sheet instead of the plan being split", async () => {
    const w = buildWiring(await loadProject(join(import.meta.dir, "fixtures", "recorder")));
    expect(w.checks).toEqual([]);
    expect(w.sheets ?? [w]).toHaveLength(1);
    expect(w.scale).toBeCloseTo(0.75, 5);
    expect(w.legendSheet).not.toBeNull();
    expect(w.svg).not.toContain('class="row"');
  });
});
