// Keys per pane: root-cause 4, two panes on one list shared one handler and selection; now each pane has its own.
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";
import { dropPane, handlerFor, keyState, registerKeys, selKey, selOf } from "../app/key-state.ts";

const src = (f: string) => readFileSync(new URL(`../${f}`, import.meta.url), "utf8");

test("two panes on the same list each keep their handler; the focused one gets the key", () => {
  const got: string[] = [];
  const offA = registerKeys("A", () => (got.push("A"), true));
  const offB = registerKeys("B", () => (got.push("B"), true));
  handlerFor("A")?.({ t: "move", dir: 1 });
  handlerFor("B")?.({ t: "move", dir: 1 });
  assert.deepEqual(got, ["A", "B"]);
  offA();
  assert.equal(handlerFor("A"), undefined);
  assert.ok(handlerFor("B"), "unregistering one pane leaves the other");
  offB();
});

test("each pane's selection is its own, and goes when the pane closes", () => {
  selOf("A", "needs-you").id = "card-2";
  assert.equal(selOf("B", "needs-you").id, null, "B starts where it was, not at A's card");
  dropPane("A");
  assert.equal(keyState.sel[selKey("A", "needs-you")], undefined);
  assert.ok(keyState.sel[selKey("B", "needs-you")]);
  dropPane("B");
});

test("the wiring: a list registers under its pane, and the page asks the focused pane only", () => {
  const view = src("app/key-view.ts");
  assert.match(view, /const pane = usePaneId\(\);/);
  assert.match(view, /registerKeys\(pane, /);
  assert.match(src("app.tsx"), /done = handlerFor\(lay\.current!\.focus\)\?\.\(a\) \?\? false;/);
  assert.match(src("app/panes.tsx"), /<PaneContext\.Provider value=\{pane\.id\}>/);
});
