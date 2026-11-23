// A card's unticked list items after its asker revises it (review of the landing): CardView is keyed by the card's id, so
// its state outlives a revision, and exclusions kept by item index landed on whatever item took that place, then went
// out with the next answer against the new revision.
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { test } from "node:test";
import { picksFor, togglePick, type Picks } from "../app/unticked.ts";

// what the answer's words name, as untickedText does (app/blocks.tsx): each unticked index's label
const v1 = ["staging-old", "preview-1100", "preview-1101"];
const v2 = ["prod-db", "preview-1101"];
const leftOut = (labels: string[], off: ReadonlyMap<number, ReadonlySet<number>>) => [...(off.get(0) ?? [])].map((i) => labels[i]);

test("an exclusion picked on one revision doesn't carry onto the revised card's items", () => {
  let p: Picks = { revised: 0, off: new Map() };
  p = togglePick(p, undefined, 0, 0); // the owner unticks "staging-old" on the card as first filed
  assert.deepEqual(leftOut(v1, picksFor(p, undefined)), ["staging-old"]);
  // the asker revises (revised 1): item 0 is now "prod-db"
  assert.deepEqual(leftOut(v2, picksFor(p, 1)), [], "prod-db is never sent as left out");
  p = togglePick(p, 1, 0, 1);
  assert.deepEqual(leftOut(v2, picksFor(p, 1)), ["preview-1101"], "picks on the new version count, and only they do");
  assert.deepEqual(leftOut(v2, picksFor(togglePick(p, 1, 0, 1), 1)), [], "a second tap ticks it back");
});

test("CardView keeps its list picks per revision, with no effect or extra element", () => {
  const src = readFileSync(join(import.meta.dirname, "..", "app", "needs-you.tsx"), "utf8");
  assert.match(src, /const unticked = picksFor\(picks, card\.revised\);/);
  assert.match(src, /setPicks\(\(p\) => togglePick\(p, card\.revised, block, item\)\)/);
  assert.doesNotMatch(src, /useState<Map<number, Set<number>>>/, "no per-card map that outlives a revision");
});
