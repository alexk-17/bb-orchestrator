// The diagram block (2026-11-13: deliverables "a lot more visual", with "small architecture diagrams explaining
// what this PR is actually changing"). What matters: the agent's diagram is checked before it reaches him (an arrow to a
// box that isn't there is refused, not drawn wrong), arrows read in flow order, a cycle can't hang or explode the
// layout, and no two boxes sit on top of each other.
import assert from "node:assert/strict";
import { test } from "node:test";
import { blockSchema } from "../blocks.ts";
import { layers, layout, type DNode } from "../app/diagram-layout.ts";

const n = (id: string): DNode => ({ id, label: id, change: "same" });
const e = (from: string, to: string) => ({ from, to, change: "same" as const });

test("a diagram whose arrow names a missing box, or with a duplicate id, is refused", () => {
  const ok = { kind: "diagram", nodes: [{ id: "a", label: "A" }, { id: "b", label: "B" }], edges: [{ from: "a", to: "b" }] };
  const parsed = blockSchema.parse(ok);
  assert.equal(parsed.kind === "diagram" && parsed.nodes[0]!.change, "same", "change defaults to same");
  assert.equal(parsed.kind === "diagram" && parsed.direction, "right");
  assert.throws(() => blockSchema.parse({ ...ok, edges: [{ from: "a", to: "zz" }] }), /isn't there/);
  assert.throws(() => blockSchema.parse({ ...ok, nodes: [{ id: "a", label: "A" }, { id: "a", label: "B" }] }), /duplicate/);
  assert.throws(() => blockSchema.parse({ ...ok, nodes: [{ id: "a", label: "A" }] }), "a diagram needs two boxes");
});

test("boxes layer by the longest path, so every arrow but a cycle's closing one runs forward", () => {
  const l = layers([n("ui"), n("api"), n("db"), n("cache")], [e("ui", "api"), e("api", "db"), e("ui", "db"), e("api", "cache"), e("cache", "db")]);
  assert.deepEqual(Object.fromEntries(l), { ui: 0, api: 1, cache: 2, db: 3 });
});

test("a cycle ends: its closing arrow is drawn as a back arrow", () => {
  const nodes = [n("a"), n("b"), n("c")];
  const { lines } = layout(nodes, [e("a", "b"), e("b", "c"), e("c", "a")], "right");
  assert.deepEqual(lines.map((x) => x.back), [false, false, true]);
});

test("no two boxes overlap, in either direction", () => {
  const nodes = ["a", "b", "c", "d", "e", "f", "g"].map(n);
  const edges = [e("a", "b"), e("a", "c"), e("a", "d"), e("b", "e"), e("c", "e"), e("d", "f"), e("e", "g"), e("f", "g")];
  for (const dir of ["right", "down"] as const) {
    const { boxes, width, height } = layout(nodes, edges, dir, 208, 76);
    assert.ok(boxes.every((box) => box.h === 76));
    for (const p of boxes)
      for (const q of boxes) {
        if (p === q) continue;
        const apart = p.x + p.w <= q.x || q.x + q.w <= p.x || p.y + p.h <= q.y || q.y + q.h <= p.y;
        assert.ok(apart, `${dir}: ${p.id} and ${q.id} overlap`);
      }
    assert.ok(boxes.every((b) => b.x + b.w <= width && b.y + b.h <= height), `${dir}: every box inside the canvas`);
  }
  const routed = layout([n("a"), n("b"), n("c")], [e("a", "c"), e("b", "c")], "right", 208, 76, "orthogonal");
  const arrivals = routed.lines.map((line) => line.path.match(/V([\d.]+) H/)?.[1]);
  assert.equal(new Set(arrivals).size, 2);
  const lanes = routed.lines.map((line) => line.path.match(/ H([\d.]+) V/)?.[1]);
  assert.equal(new Set(lanes).size, 2);
  assert(Number(lanes[0]) > Number(lanes[1]));
  const wider = Array.from({ length: 25 }, (_, index) => n(`ticket-${index}`));
  const wideGraph = layout(wider, wider.slice(1).map((node, index) => e(wider[index].id, node.id)), "right", 208, 76, "orthogonal");
  assert.equal(wideGraph.boxes.length, 25);
  assert(wideGraph.boxes.every((box) => box.x + box.w <= wideGraph.width && box.y + box.h <= wideGraph.height));
  const skip = layout([n("a"), n("b"), n("c")], [e("a", "b"), e("b", "c"), e("a", "c")], "right", 208, 76, "orthogonal", 64);
  const midBox = skip.boxes.find((b) => b.id === "b")!;
  const skipLine = skip.lines.find((l) => l.from === "a" && l.to === "c")!;
  assert.ok(skipLine.ly > midBox.y + midBox.h || skipLine.ly < midBox.y, `skip edge routed through intermediate box b: ${skipLine.path}`);
  assert.ok(skipLine.ly < skip.height);
});
