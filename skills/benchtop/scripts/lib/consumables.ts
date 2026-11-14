// Everything a build needs besides its electronic parts: wire by colour, solder,
// heat-shrink, and the screws the case was cut for. One list, used by the BOM and the
// shopping page, derived from the same project data as the guide.

import type { Loaded } from "./project";
import { wireColor } from "./scenes";
import { strictGeometry, unresolvedGeometry } from "./geometry-evidence";

export interface Consumable {
  qty: number;
  name: string;
  value: string;
  blurb: string;
  search: string;
  /** Rough share of a typical retail pack, for the estimate only. */
  unitUsd: number;
}

export const WIRE_MM = 120;
const WIRE_USD_PER_M = 0.6;
const SOLDER_USD = 4;
const HEATSHRINK_USD = 3;
// Screws are sold by the bag; this is a per-piece share of a small assortment.
const SCREW_USD = 0.1;

export async function consumables(loaded: Loaded): Promise<Consumable[]> {
  const { project } = loaded;
  const { path, joint } = project.build;
  const list: Consumable[] = [];
  if (path === "wire") {
    // Same colour rule as the guide, so the list asks for the colours the steps use.
    const byColor = new Map<string, number>();
    project.connections.forEach((c, i) => {
      const color = wireColor(loaded, c, i);
      byColor.set(color, (byColor.get(color) ?? 0) + 1);
    });
    for (const [color, n] of [...byColor].sort((a, b) => a[0].localeCompare(b[0]))) {
      list.push({
        qty: n,
        name: joint === "dupont" ? `Dupont jumper wire, ${color}` : `Hook-up wire, ${color}`,
        value: `${WIRE_MM} mm each`,
        blurb: `${n} wire${n === 1 ? "" : "s"} x ${WIRE_MM} mm = ${n * WIRE_MM} mm in total (suggested length; trim to fit).`,
        search: joint === "dupont" ? "dupont jumper wires female to female 10 cm" : "22 AWG silicone hook-up wire kit 6 colours",
        unitUsd: (WIRE_MM / 1000) * WIRE_USD_PER_M,
      });
    }
  }
  if ((path === "wire" && joint === "solder") || path === "pcb-diy") {
    list.push({
      qty: 1,
      name: "Solder",
      value: "60/40 or lead-free, 0.8 mm",
      blurb: "Joins the parts. One small reel is plenty for this build.",
      search: "solder wire 0.8 mm rosin core",
      unitUsd: SOLDER_USD,
    });
  }
  if (path === "wire" && joint === "solder") {
    list.push({
      qty: 1,
      name: "Heat-shrink tubing",
      value: "assorted 1-3 mm",
      blurb: "Insulates soldered joints so bare metal cannot touch and short.",
      search: "heat shrink tubing assortment",
      unitUsd: HEATSHRINK_USD,
    });
  }
  // The case is generated unless strict mode refuses it for an unresolved part, so its screws are listed.
  if (project.enclosure && !(strictGeometry() && unresolvedGeometry(loaded).length > 0)) {
    const { layoutEnclosure } = await import("./enclosure-layout");
    for (const h of layoutEnclosure(loaded).hardware) {
      list.push({ qty: h.qty, name: h.name, value: "", blurb: `Enclosure: ${h.use}.`, search: h.name, unitUsd: SCREW_USD });
    }
  }
  return list;
}
