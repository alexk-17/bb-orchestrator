import assert from "node:assert/strict";
import { test } from "node:test";
import { readFileSync } from "node:fs";
import { BOARD_COLUMNS, type BoardColumn } from "../contract.ts";
import { FOLDED_FIRST, boardOf, boardRows, drawnFolds, foldCopyKey, loadFoldCopy, resolveFolds, saveFoldCopy } from "../app/board-fold.ts";

function memory(seed: Record<string, string> = {}) {
  const m = new Map(Object.entries(seed));
  return { getItem: (k: string) => m.get(k) ?? null, setItem: (k: string, v: string) => void m.set(k, v), m };
}
const blocked = {
  getItem: (): string | null => {
    throw new Error("SecurityError");
  },
  setItem: () => {
    throw new Error("QuotaExceededError");
  },
};
const sorted = (s: Set<BoardColumn>) => BOARD_COLUMNS.filter((c) => s.has(c));
const set = (...c: BoardColumn[]) => new Set<BoardColumn>(c);

test("a board the viewer never folded shows Shipped folded and every other column open", () => {
  assert.deepEqual(FOLDED_FIRST, ["shipped"]);
  assert.deepEqual(sorted(resolveFolds({ mine: undefined, server: undefined, copy: null })), ["shipped"], "the first paint, nothing known");
  assert.deepEqual(sorted(resolveFolds({ mine: undefined, server: null, copy: null })), ["shipped"], "the plugin holds none for this board");
});

test("the viewer's folds are restored after a reload, from the plugin or this browser's copy; opening Shipped is kept too", () => {
  assert.deepEqual(sorted(resolveFolds({ mine: undefined, server: ["planned", "shipped"], copy: null })), ["planned", "shipped"], "a new window: the plugin's");
  assert.deepEqual(sorted(resolveFolds({ mine: undefined, server: [], copy: null })), [], "Shipped opened stays open: an empty list is a choice");
  assert.deepEqual(sorted(resolveFolds({ mine: undefined, server: undefined, copy: set("planned") })), ["planned"], "before the read lands: the copy");
  const store = memory();
  saveFoldCopy(boardOf(null), set(), store);
  assert.deepEqual(loadFoldCopy(boardOf(null), store), set(), "the copy keeps an empty list, not nothing");
  assert.equal(store.m.get(foldCopyKey("-")), "[]");
});

test("the plugin's word wins over this browser's copy once it lands; the viewer's change on this page wins over both", () => {
  assert.deepEqual(sorted(resolveFolds({ mine: undefined, server: ["blocked"], copy: set("planned") })), ["blocked"], "folded elsewhere since");
  assert.deepEqual(sorted(resolveFolds({ mine: set("waiting"), server: ["blocked"], copy: set("planned") })), ["waiting"]);
  assert.deepEqual(sorted(resolveFolds({ mine: undefined, server: null, copy: set("planned") })), ["planned"], "the plugin's write never landed: the copy");
});

test("each board keeps its own folds", () => {
  const store = memory();
  saveFoldCopy(boardOf("birch-billing"), set("planned"), store);
  assert.deepEqual(loadFoldCopy(boardOf("birch-billing"), store), set("planned"));
  assert.equal(loadFoldCopy(boardOf(null), store), null, "the all-projects board is untouched");
  assert.notEqual(boardOf(null), boardOf("all"), "no project's slug is the all-projects board's key");
});

test("blocked or junk storage never breaks the board: no copy, and a save that fails quietly", () => {
  assert.equal(loadFoldCopy("-", blocked), null);
  assert.doesNotThrow(() => saveFoldCopy("-", set("blocked"), blocked));
  for (const junk of ["{", "{}", '"shipped"', "42"]) assert.equal(loadFoldCopy("-", memory({ [foldCopyKey("-")]: junk })), null, junk);
  assert.deepEqual(loadFoldCopy("-", memory({ [foldCopyKey("-")]: '["waiting","archived",3,null]' })), set("waiting"));
  assert.deepEqual(sorted(resolveFolds({ mine: undefined, server: ["archived", "blocked"], copy: null })), ["blocked"]);
});

test("a folded column keeps its place: one row of six, or three by two in the board's order", () => {
  assert.deepEqual(boardRows(BOARD_COLUMNS, "six"), [[...BOARD_COLUMNS]]);
  assert.deepEqual(boardRows(BOARD_COLUMNS, "three"), [BOARD_COLUMNS.slice(0, 3), BOARD_COLUMNS.slice(3)]);
  assert.equal(BOARD_COLUMNS.at(-1), "shipped", "Shipped closes the last row, so folding it hands its width to Waiting and Blocked");
});

test("the board draws a folded column as its header in place, never a strip or an edge; a fold is kept as it is made", () => {
  const src = readFileSync(new URL("../app/work-board.tsx", import.meta.url), "utf8");
  assert.match(src, /useFolded\(place\.project\)/, "the board reads this board's folds");
  assert.match(src, /\.wb-col\[data-folded\] \{[^}]*flex: 0 0 auto;/, "a folded column takes only its header's width");
  assert.doesNotMatch(src.match(/\.wb-col\[data-folded\] \{[^}]*\}/)?.[0] ?? "", /writing-mode|height: 100%|align-self: stretch/, "never a full-height vertical strip");
  const fold = readFileSync(new URL("../app/board-fold.ts", import.meta.url), "utf8");
  const toggle = fold.slice(fold.indexOf("const toggle = useCallback("));
  assert.match(toggle, /keep\(\{ board, folded: /, "the toggle keeps the change in the plugin, once, as the viewer makes it");
  assert.doesNotMatch(fold.slice(0, fold.indexOf("const toggle = useCallback(")), /keep\(/, "nothing is written as the board draws");
});

test("a picked count pill opens the folded columns holding its cards while it is picked, and the kept folds stay", () => {
  const cols = BOARD_COLUMNS.map((column) => ({ column, tasks: column === "shipped" ? ["t-1", "t-2"] : column === "planned" ? [] : ["t-3"] }));
  const kept = set("shipped", "planned");
  assert.deepEqual(sorted(drawnFolds(kept, cols, true)), ["planned"], "\"7 shipped\" picked with Shipped folded: Shipped opens; Planned, with none of them, stays folded");
  assert.deepEqual(sorted(drawnFolds(kept, cols, false)), ["planned", "shipped"], "no pill picked: the kept folds");
  assert.deepEqual(sorted(kept), ["planned", "shipped"], "the viewer's folds are untouched");
  const src = readFileSync(new URL("../app/work-board.tsx", import.meta.url), "utf8");
  assert.match(src, /drawnFolds\(folded, cols, !!lens\?\.pick\)/, "the board draws the folds a picked pill leaves");
  assert.match(src, /folded=\{drawn\.has\(c\.column\)\}/, "a column is drawn folded from those, not from the kept folds");
  assert.match(src, /onFold=\{lens\?\.pick && c\.tasks\.length \? undefined : toggle\}/, "while a pill is picked, no column holding its cards has a fold toggle: a fold there would be kept but not drawn, and leave no way back");
});
