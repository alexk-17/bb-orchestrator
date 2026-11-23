// A card's unticked list items (selectable list blocks), kept by block and item index for the revision they were picked
// on. Its asker may revise the card in place (same id, so CardView keeps its state) and reorder or replace those items:
// picks from an earlier revision would land on other items, so a new revision starts with none.

export type Picks = { revised: number; off: ReadonlyMap<number, ReadonlySet<number>> };

const NONE: ReadonlyMap<number, ReadonlySet<number>> = new Map();

/** The exclusions that apply to the card as it is now (its revision count; 0 or undefined: never revised). */
export const picksFor = (p: Picks, revised: number | undefined): ReadonlyMap<number, ReadonlySet<number>> => (p.revised === (revised ?? 0) ? p.off : NONE);

/** Tick or untick one item on the card as it is now; picks from an earlier revision are dropped. */
export function togglePick(p: Picks, revised: number | undefined, block: number, item: number): Picks {
  const now = revised ?? 0;
  const next = new Map(picksFor(p, now));
  const off = new Set(next.get(block) ?? []);
  if (off.has(item)) off.delete(item);
  else off.add(item);
  next.set(block, off);
  return { revised: now, off: next };
}
