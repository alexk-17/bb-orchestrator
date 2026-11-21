// Drag to dock (app/layout.ts, split panes release 3): a moved pane keeps its id, so it is never remounted; its old room goes to its neighbours.
import assert from "node:assert/strict";
import { test } from "node:test";
import { besideOf, dock, dropAt, panes, type Layout, type Node, type Split } from "../app/layout.ts";
import { rootOf } from "../app/route.ts";

const pane = (id: string, view = id): Node => ({ kind: "pane", id, route: rootOf(view) });
/** a | b | c side by side, the focus on a */
const row3 = (): Layout => ({ v: 2, focus: "a", root: { kind: "split", id: "s", dir: "row", sizes: [0.2, 0.3, 0.5], children: [pane("a"), pane("b"), pane("c")] } });
/** The tree as text: a pane is its id, a split is row(...) or col(...) */
const shape = (n: Node): string => (n.kind === "pane" ? n.id : `${n.dir}(${n.children.map(shape).join(",")})`);

test("dock on each edge: the pane leaves its place and sits on that side of the target, with the focus", () => {
  const cases: [string, string][] = [
    ["left", "row(b,a,c)"],
    ["right", "row(b,c,a)"],
    ["top", "row(b,col(a,c))"],
    ["bottom", "row(b,col(c,a))"],
  ];
  for (const [edge, want] of cases) {
    const l = dock(row3(), "a", "c", edge as "left");
    assert.equal(shape(l.root), want, edge);
    assert.equal(l.focus, "a", `${edge}: the moved pane has the focus`);
    assert.deepEqual(panes(l.root).map((p) => p.id).sort(), ["a", "b", "c"], `${edge}: same panes, same ids`);
  }
});

test("dock beside a target in a split of the same direction splits the target's room, not the whole split", () => {
  const l = dock(row3(), "a", "c", "left");
  // a's 0.2 goes to b (its neighbour); c's 0.5 is halved between a and c
  const sizes = (l.root as Split).sizes.map((x) => +x.toFixed(3));
  assert.deepEqual(sizes, [0.375, 0.313, 0.313]);
  assert.equal(+sizes.reduce((x, y) => x + y, 0).toFixed(2), 1);
});

test("the centre swaps the two panes and nothing else", () => {
  const l = dock(row3(), "a", "c", "center");
  assert.equal(shape(l.root), "row(c,b,a)");
  assert.deepEqual((l.root as Split).sizes, [0.2, 0.3, 0.5], "the sizes stay with their places");
  assert.equal(l.focus, "a");
});

test("docking onto itself, or with an unknown pane, changes nothing", () => {
  const l = row3();
  assert.equal(dock(l, "a", "a", "left"), l);
  assert.equal(dock(l, "x", "a", "left"), l);
  assert.equal(dock(l, "a", "x", "left"), l);
});

test("a Sidebar item dropped on an edge is a new pane there; on the centre that pane changes page", () => {
  const two: Layout = { v: 2, focus: "a", root: { kind: "split", id: "s", dir: "row", sizes: [0.5, 0.5], children: [pane("a", "home"), pane("b", "projects")] } };
  for (const [edge, want] of [["left", "row(a,new,b)"], ["right", "row(a,b,new)"], ["top", "row(a,col(new,b))"], ["bottom", "row(a,col(b,new))"]] as const) {
    const l = dropAt(two, rootOf("chat"), "b", edge);
    const added = panes(l.root).find((p) => p.route.view === "chat")!;
    assert.equal(shape(l.root).replace(added.id, "new"), want, edge);
    assert.equal(l.focus, added.id, `${edge}: the new pane has the focus`);
  }
  const centre = dropAt(two, rootOf("chat"), "b", "center");
  assert.deepEqual(panes(centre.root).map((p) => `${p.id}:${p.route.view}`), ["a:home", "b:chat"]);
  assert.equal(centre.focus, "b");
});

test("the pane beside (Ctrl/Cmd+click): the next one to the right, at any depth; none at the right edge", () => {
  const l: Layout = { v: 2, focus: "a", root: { kind: "split", id: "s", dir: "row", sizes: [0.5, 0.5], children: [{ kind: "split", id: "t", dir: "col", sizes: [0.5, 0.5], children: [pane("a"), pane("b")] }, { kind: "split", id: "u", dir: "col", sizes: [0.5, 0.5], children: [pane("c"), pane("d")] }] } };
  assert.equal(besideOf(l, "a"), "c", "out of its column, to the first pane of the next");
  assert.equal(besideOf(l, "b"), "c");
  assert.equal(besideOf(l, "c"), null, "the right-most column has none");
  assert.equal(besideOf(row3(), "b"), "c");
  assert.equal(besideOf(row3(), "x"), null);
});

test("the drop zone: the nearest edge within 30% of it, else the centre; the preview covers that half, inset 4 px", async () => {
  const { EDGE_SHARE, edgeAt, zoneRect } = await import("../app/drag.ts");
  assert.equal(EDGE_SHARE, 0.3);
  assert.equal(edgeAt(0.1, 0.5), "left");
  assert.equal(edgeAt(0.9, 0.5), "right");
  assert.equal(edgeAt(0.5, 0.05), "top");
  assert.equal(edgeAt(0.5, 0.95), "bottom");
  assert.equal(edgeAt(0.5, 0.5), "center");
  assert.equal(edgeAt(0.35, 0.5), "center", "just past 30% from the left is the centre");
  assert.equal(edgeAt(0.05, 0.02), "top", "a corner goes to the nearer edge");
  const r = { left: 100, top: 50, width: 400, height: 300 };
  assert.deepEqual(zoneRect(r, "right"), { left: 304, top: 54, width: 192, height: 292 });
  assert.deepEqual(zoneRect(r, "bottom"), { left: 104, top: 204, width: 392, height: 142 });
  assert.deepEqual(zoneRect(r, "center"), { left: 104, top: 54, width: 392, height: 292 }, "the centre is the whole pane, inset like the halves");
});

test("the zone holds until the pointer is 8 px into the next one, so the preview never flickers on a boundary", async () => {
  const { zoneAt, DEAD_BAND } = await import("../app/drag.ts");
  const all = () => true;
  assert.equal(DEAD_BAND, 8);
  // a 400 × 300 pane: the left zone ends at x = 120
  assert.equal(zoneAt(119, 150, 400, 300, null, all), "left", "with no zone yet it is the raw one");
  assert.equal(zoneAt(121, 150, 400, 300, "left", all), "left", "1 px past the boundary is still left");
  assert.equal(zoneAt(127, 150, 400, 300, "left", all), "left");
  assert.equal(zoneAt(129, 150, 400, 300, "left", all), "center", "8 px past it, the centre");
  assert.equal(zoneAt(115, 150, 400, 300, "center", all), "center", "and back: the centre holds until 8 px into left");
  assert.equal(zoneAt(111, 150, 400, 300, "center", all), "left");
  assert.equal(zoneAt(150, 150, 400, 300, "right", all), "center", "a jump far from the old zone changes at once");
});

test("an edge with no room is never offered: that part of the pane is the centre, so a drop there swaps instead of being refused", async () => {
  const { zoneAt } = await import("../app/drag.ts");
  const noLeft = (e: string) => e !== "left";
  assert.equal(zoneAt(10, 150, 400, 300, null, noLeft), "center");
  assert.equal(zoneAt(390, 150, 400, 300, null, noLeft), "right", "the others still are");
  assert.equal(zoneAt(10, 150, 400, 300, null, () => false), "center", "no room anywhere: the whole pane is the centre");
});

test("the ghost stays inside the window: right of and below the pointer, flipped to its left or above where it would cross the edge", async () => {
  const { ghostAt, GHOST_OFFSET } = await import("../app/drag.ts");
  const [w, h, vw, vh] = [120, 28, 1440, 900];
  assert.deepEqual(ghostAt(600, 400, w, h, vw, vh), { left: 600 + GHOST_OFFSET, top: 400 + GHOST_OFFSET }, "in the middle: the usual offset");
  for (const [x, y] of [[1430, 400], [600, 890], [1435, 895], [1440 - GHOST_OFFSET - w + 1, 900 - GHOST_OFFSET - h + 1]]) {
    const g = ghostAt(x, y, w, h, vw, vh);
    assert.ok(g.left >= 0 && g.left + w <= vw && g.top >= 0 && g.top + h <= vh, `pointer at ${x},${y}: ghost at ${JSON.stringify(g)} leaves the window`);
    assert.ok(!(x >= g.left && x <= g.left + w && y >= g.top && y <= g.top + h), `pointer at ${x},${y}: the ghost covers the point being dropped on`);
  }
  assert.deepEqual(ghostAt(1430, 400, w, h, vw, vh), { left: 1430 - GHOST_OFFSET - w, top: 400 + GHOST_OFFSET }, "only the axis that crosses flips");
});
