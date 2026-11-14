// Laying out an exploded step: how high each part hovers before it is fitted, and
// where its name goes.
//
// Parts that sit side by side in the finished build are drawn hovering above where
// they land. At one common height their outlines run into each other on the page and
// their names collide. Here each part is raised just far enough that its outline, its
// name and its arrow are clear of every part placed before it, working from the part
// nearest the viewer back. When a part would have to rise beyond a set height the
// step is split, so the rule holds for any number of parts.

import { type Pt, inflate, pointInConvex, polyBounds, polysOverlap, proj, silhouette, textQuad } from "./geom";
import type { FreeText, Solid } from "./iso";

export interface HoverItem {
  /** Part ref, used in messages and as the hover item id. */
  id: string;
  /** Name printed beside the part. Omit for no name. */
  label?: string;
  /** The part's solids where they end up once fitted. The first is its body. */
  solids: Solid[];
  /** Extra page shapes that travel with the part (its arrow), given for a hover of zero. */
  extras?: Pt[][];
}

export interface HoverPlaced {
  item: HoverItem;
  /** How far above its landing place the part is drawn. */
  dz: number;
  text?: FreeText;
}

export interface HoverOptions {
  /** Lowest hover height, mm. */
  base: number;
  /** Highest hover height before the step is split. */
  max: number;
  /** Clear space kept between two hovering parts on the page, mm. */
  clearance?: number;
  labelSize?: number;
}

export const liftSolid = (s: Solid, dz: number): Solid => ({ ...s, z: s.z + dz });

/** Raising a part by dz moves everything about it this far up the page. */
const rise = (dz: number): number => proj(0, 0, dz)[1];

const shift = (poly: readonly Pt[], dy: number): Pt[] => poly.map((p) => [p[0], p[1] + dy] as Pt);

/** Page shapes of an item hovering at dz: its solids' outlines and its extras. */
export function hoverShapes(item: HoverItem, dz: number): Pt[][] {
  return [...item.solids.map((s) => silhouette(liftSolid(s, dz))), ...(item.extras ?? []).map((e) => shift(e, rise(dz)))];
}

/** Where the name of a hovering part may go, best first: on its top face if it fits there, else beside or above it. */
export function labelPlaces(item: HoverItem, dz: number, size: number): FreeText[] {
  if (!item.label) return [];
  const body = liftSolid(item.solids[0]!, dz);
  const top = body.z + body.h;
  const face: Pt[] = [proj(body.x, body.y, top), proj(body.x + body.w, body.y, top), proj(body.x + body.w, body.y + body.d, top), proj(body.x, body.y + body.d, top)];
  const centre = proj(body.x + body.w / 2, body.y + body.d / 2, top);
  const all = hoverShapes(item, dz).flat();
  const bounds = polyBounds(all);
  const mk = (at: Pt, anchor: FreeText["anchor"]): FreeText => ({ text: item.label!, at, anchor, size, part: item.id });
  const out: FreeText[] = [];
  const onFace = mk([centre[0], centre[1] + size * 0.36], "middle");
  const quad = inflate(textQuad(onFace.at, [1, 0], [0, 1], onFace.text, size, "middle"), 0.6);
  // On the face only when no shape of the part stands there to be written across.
  if (item.solids.length === 1 && quad.every((p) => pointInConvex(p, face))) out.push(onFace);
  out.push(mk([bounds.maxX + 1.8, centre[1] + size * 0.36], "start"));
  out.push(mk([bounds.minX - 1.8, centre[1] + size * 0.36], "end"));
  out.push(mk([centre[0], bounds.minY - 1.6], "middle"));
  return out;
}

const textBox = (t: FreeText): Pt[] => textQuad(t.at, [1, 0], [0, 1], t.text, t.size, t.anchor);

/** Nearest the viewer first: the part whose body centre is furthest along the view direction. */
const nearness = (it: HoverItem): number => {
  const b = it.solids[0]!;
  return b.x + b.w / 2 + b.y + b.d / 2;
};

/**
 * Hover heights and name positions for the parts of one exploded step, split into as
 * many steps as it takes for no part to rise above `max`. Within a returned group no
 * two parts, names or arrows overlap on the page.
 */
export function planHover(items: readonly HoverItem[], opts: HoverOptions): HoverPlaced[][] {
  const clearance = opts.clearance ?? 1.2;
  const size = opts.labelSize ?? 2.1;
  const groups: HoverPlaced[][] = [];
  let group: HoverPlaced[] = [];
  let taken: Pt[][] = [];
  const tryPlace = (item: HoverItem, dz: number): HoverPlaced | null => {
    const shapes = hoverShapes(item, dz);
    if (shapes.some((s) => taken.some((t) => polysOverlap(s, t, clearance)))) return null;
    const places = labelPlaces(item, dz, size);
    if (places.length === 0) return { item, dz };
    for (const text of places) {
      const box = textBox(text);
      if (!taken.some((t) => polysOverlap(box, t, clearance))) return { item, dz, text };
    }
    return null;
  };
  const commit = (p: HoverPlaced): void => {
    group.push(p);
    taken.push(...hoverShapes(p.item, p.dz));
    if (p.text) taken.push(textBox(p.text));
  };
  for (const item of [...items].sort((a, b) => nearness(b) - nearness(a))) {
    let placed: HoverPlaced | null = null;
    for (let dz = opts.base; dz <= opts.max && !placed; dz += 1) placed = tryPlace(item, dz);
    if (!placed) {
      // No room left in this step: start another one, where the part is first and so always fits.
      if (group.length) groups.push(group);
      group = [];
      taken = [];
      placed = tryPlace(item, opts.base) ?? { item, dz: opts.base, text: labelPlaces(item, opts.base, size)[0] };
    }
    commit(placed);
  }
  if (group.length) groups.push(group);
  return groups;
}
