// Hash of the geometry `catalog.ts import-part` wrote, so a later tool can tell whether a person
// moved a pad or resized the outline afterwards. Kept apart from catalog-pads.ts so check-parts can
// use it without loading the catalog code.
//
// What is hashed: the pad positions (x, y of every pin, sorted, so reordering pins changes nothing)
// and body.w and body.d. Not hashed, because a person is expected to change them while filling the
// draft in: pin names, roles, gpio, body.h, maxHeight, shapes, ports and every electrical value.

import { createHash } from "node:crypto";
import type { PartDef } from "./types";

/** The hashed fields of a part, in the form the importer and the check both produce. */
export function geometrySha256(def: Pick<PartDef, "body" | "pins">): string {
  const pads = def.pins.map((p) => [p.x, p.y] as [number, number]).sort((a, b) => a[0] - b[0] || a[1] - b[1]);
  return createHash("sha256")
    .update(JSON.stringify({ pads, body: [def.body.w, def.body.d] }))
    .digest("hex");
}

/**
 * A sentence for check-parts when the part file carries import provenance and its pads or outline no
 * longer hash to the recorded value; null when it has no provenance or the geometry is unchanged.
 */
export function editedAfterImport(def: PartDef): string | null {
  const rec = def.imported?.geometrySha256;
  if (!rec || !Array.isArray(def.pins) || !def.body) return null;
  if (geometrySha256(def) === rec) return null;
  return `${def.id}: pads or outline were changed after import from the catalog (${def.imported!.catalogPart}, geometry ${def.imported!.geometry.pads}); the draft's geometry hash no longer matches, so the CAD-derived positions are no longer what is in this file`;
}
