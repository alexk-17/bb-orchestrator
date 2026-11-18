// Resizable Open PRs columns (2026-11-18, the owner: "the columns aren't individually adjustable in width"). Each rule of
// column-widths.ts on the Open PRs table's own columns. Each test fails if its rule goes.
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";
import { MAX_WIDTH, clampWidth, freeze, loadWidths, parseWidths, resizeFrom, saveWidths, tableLayout, type ColumnSpec, type Widths } from "../app/column-widths.ts";

const COLS: ColumnSpec[] = [
  { id: "title", label: "Title", width: null, min: 160 },
  { id: "pr", label: "PR", width: 128, min: 64 },
  { id: "state", label: "State", width: 176, min: 72 },
];

test("untouched, the table looks as before: Title fills what the others leave, and never goes below its minimum", () => {
  const l = tableLayout(COLS, {});
  assert.deepEqual(l.cols, [null, 128, 176]);
  assert.equal(l.filler, false);
  assert.equal(l.span, 3);
  assert.deepEqual(l.style, { width: "100%", minWidth: 160 + 128 + 176 });
});

test("dragging one column sizes that column alone: the others keep their widths", () => {
  const l = tableLayout(COLS, { pr: 300 });
  assert.deepEqual(l.cols, [null, 300, 176]);
});

test("once every column has a width, the table is their sum and a filler takes the rest, so no column stretches away from the pointer", () => {
  const l = tableLayout(COLS, { title: 200 });
  assert.deepEqual(l.cols, [200, 128, 176]);
  assert.equal(l.filler, true);
  // the expanded row's colSpan must cover the filler too, or it lays out one column short
  assert.equal(l.span, 4);
  assert.deepEqual(l.style, { width: 200 + 128 + 176, minWidth: "100%" });
});

test("a width never goes below the column's minimum or above the cap, and is whole pixels", () => {
  assert.equal(clampWidth(COLS[1]!, 10), 64);
  assert.equal(clampWidth(COLS[1]!, 99999), MAX_WIDTH);
  assert.equal(clampWidth(COLS[1]!, 100.6), 101);
});

test("stored widths: unknown columns, non-numbers and malformed text are dropped, never shown", () => {
  assert.deepEqual(parseWidths('{"pr":200,"gone":50,"state":"wide","title":null}', COLS), { pr: 200 });
  assert.deepEqual(parseWidths('{"pr":1}', COLS), { pr: 64 });
  assert.deepEqual(parseWidths("not json", COLS), {});
  assert.deepEqual(parseWidths("[1,2]", COLS), {});
  assert.deepEqual(parseWidths(null, COLS), {});
});

test("blocked storage gives the defaults and never throws; a save round-trips, and resetting every column removes the key", () => {
  const blocked = {
    getItem: () => {
      throw new Error("SecurityError");
    },
    setItem: () => {
      throw new Error("SecurityError");
    },
    removeItem: () => {
      throw new Error("SecurityError");
    },
  };
  assert.deepEqual(loadWidths("k", COLS, blocked), {});
  assert.doesNotThrow(() => saveWidths("k", { pr: 200 }, blocked));
  assert.deepEqual(loadWidths("k", COLS, null), {});

  const m = new Map<string, string>();
  const store = { getItem: (k: string) => m.get(k) ?? null, setItem: (k: string, v: string) => void m.set(k, v), removeItem: (k: string) => void m.delete(k) };
  saveWidths("k", { pr: 200, title: 300 }, store);
  assert.deepEqual(loadWidths("k", COLS, store), { pr: 200, title: 300 });
  saveWidths("k", {}, store);
  assert.equal(m.has("k"), false);
});

test("the Open PRs table: every column has a labelled handle, and the expanded row spans the drawn columns, not a fixed 6", () => {
  const src = readFileSync(new URL("../app/open-prs.tsx", import.meta.url), "utf8");
  assert.match(src, /<ColHandle \{\.\.\.handle\(c\)\} \/>/);
  assert.match(src, /PR_COLS\.map\(\(c\) => \(\s*<TableHead/);
  assert.match(src, /colSpan=\{span\}/);
  assert.doesNotMatch(src, /colSpan=\{6\}/);
  const hook = readFileSync(new URL("../app/column-widths.ts", import.meta.url), "utf8");
  assert.match(hook, /"aria-label": `Resize \$\{c\.label\} column`/);
  assert.match(hook, /onPointerDown/);
  assert.doesNotMatch(hook, /onMouse(Down|Move|Up)|onTouch/);
});

// The Open PRs columns (app/open-prs.tsx PR_COLS) and the tab's widest box.
const PR_COLS: ColumnSpec[] = [
  { id: "title", label: "Title", width: null, min: 160 },
  { id: "pr", label: "PR", width: 128, min: 64 },
  { id: "state", label: "State", width: 176, min: 72 },
  { id: "ci", label: "CI", width: 112, min: 56 },
  { id: "reviewers", label: "Reviewers", width: 160, min: 72 },
  { id: "updated", label: "Updated", width: 96, min: 64 },
];
const BOX = 1022;

/** Where each column's edges are drawn, as a browser lays out tableLayout's fixed table in a box BOX px wide. */
function draw(cols: ColumnSpec[], widths: Widths, box = BOX) {
  const l = tableLayout(cols, widths);
  const fixed = l.cols.reduce<number>((s, w) => s + (w ?? 0), 0);
  const fills = l.cols.filter((w) => w === null).length;
  const tableW = l.filler ? Math.max(box, fixed) : Math.max(box, l.style.minWidth as number);
  const fillW = fills ? (tableW - fixed) / fills : 0;
  const edges: Record<string, { left: number; right: number }> = {};
  let x = 0;
  cols.forEach((c, i) => {
    const w = l.cols[i] ?? fillW;
    edges[c.id] = { left: x, right: x + w };
    x += w;
  });
  return edges;
}
const widthsOf = (e: ReturnType<typeof draw>) => Object.fromEntries(Object.entries(e).map(([k, v]) => [k, v.right - v.left]));

test("a drag's right edge follows the pointer: +N px moves the handle +N, and every column to its left stays put", () => {
  // the owner (2026-11-18): "if i drag, it opens up in the opposite direction versus following the direction that i'm
  // dragging". Widening PR took the width from Title on its left, so PR's handle stayed put and its left edge moved.
  for (const id of ["title", "pr", "state", "updated"])
    for (const dx of [60, -30]) {
      const before = draw(PR_COLS, {});
      const drawn = widthsOf(before);
      const after = draw(PR_COLS, resizeFrom(PR_COLS, {}, drawn, id, drawn[id]!, dx));
      assert.equal(after[id]!.right - before[id]!.right, dx, `${id} ${dx}: handle moved ${after[id]!.right - before[id]!.right}`);
      for (const c of PR_COLS.slice(0, PR_COLS.findIndex((x) => x.id === id) + 1).slice(0, -1)) assert.deepEqual(after[c.id], before[c.id], `${id} ${dx}: ${c.id} moved`);
      assert.equal(after[id]!.left, before[id]!.left, `${id} ${dx}: its own left edge moved`);
    }
});

test("drags compose: a second drag on another column moves only that column's right edge", () => {
  const d0 = widthsOf(draw(PR_COLS, {}));
  const w1 = resizeFrom(PR_COLS, {}, d0, "state", d0.state!, 40);
  const e1 = draw(PR_COLS, w1);
  const w2 = resizeFrom(PR_COLS, w1, widthsOf(e1), "pr", widthsOf(e1).pr!, -24);
  const e2 = draw(PR_COLS, w2);
  assert.equal(e2.pr!.right - e1.pr!.right, -24);
  assert.deepEqual(e2.title, e1.title);
  assert.equal(e2.state!.right - e2.state!.left, e1.state!.right - e1.state!.left);
});

test("freezing keeps the drawn layout: a filling column is pinned at its drawn width, set and fixed columns are left alone", () => {
  const drawn = widthsOf(draw(PR_COLS, { pr: 200 }));
  const f = freeze(PR_COLS, { pr: 200 }, drawn);
  assert.deepEqual(f, { pr: 200, title: Math.round(drawn.title!) });
  assert.deepEqual(widthsOf(draw(PR_COLS, f)), drawn);
});

test("a drag past a column's minimum stops at the minimum", () => {
  const drawn = widthsOf(draw(PR_COLS, {}));
  assert.equal(resizeFrom(PR_COLS, {}, drawn, "updated", 96, -80).updated, 64);
});

test("a drag that starts scrolled holds the table at the scrolled view's width, so narrowing a column never pulls the scroll back", () => {
  // Updated widened past the box and scrolled into view (scrollLeft 60 in a 1022 px box): narrowing it by 60 would make
  // the table 1022 px, the browser would clamp the scroll to 0, and the table would slide 60 px right under the pointer.
  const w = { title: 350, updated: 96 };
  const sum = 350 + 128 + 176 + 112 + 160 + 96;
  assert.equal(tableLayout(PR_COLS, w).style.width, sum);
  assert.equal(tableLayout(PR_COLS, w, 60 + BOX).style.width, 60 + BOX);
  // never narrower than the columns: a hold below their sum changes nothing
  assert.equal(tableLayout(PR_COLS, { ...w, updated: 300 }, 60 + BOX).style.width, sum - 96 + 300);
});
