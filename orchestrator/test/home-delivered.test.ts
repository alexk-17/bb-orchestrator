// Why: Home first step 3 (2026-11-20) folds the Deliverables tab into Home's Delivered filter; A pressed twice must still approve there, and every link into Deliverables must still land.
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";
import { decide } from "../app/keys.ts";
import { RENAMED_VIEWS } from "../app/layout.ts";
import { filterOfPath, navOf, placeOf } from "../app/nav.ts";
import { fromPath } from "../app/route.ts";

const src = (f: string) => readFileSync(new URL(`../${f}`, import.meta.url), "utf8");
const app = src("app.tsx");
const feed = src("app/feed.tsx");
const key = (k: string, code: string, shiftKey = false) => decide({ key: k, code, shiftKey, metaKey: false, ctrlKey: false, altKey: false }, null);

test("on Home's Delivered, J, K and A (twice) are Deliverables' keys", () => {
  assert.match(app, /: filter === "delivered" \? <DeliverablesView /, "Home on Delivered draws Deliverables' list, whose keys are its pane's");
  assert.deepEqual(key("a", "KeyA"), { t: "approve" });
  assert.match(src("app/deliverables.tsx"), /useViewKeys\("deliverables", root, "\[data-deliverable\]"/, "Deliverables' list still registers under its old id");
});

test("Shift+D, deliverables links and old outputs links open Home on Delivered", () => {
  assert.deepEqual(key("D", "KeyD", true), { t: "tab", view: "deliverables" });
  assert.equal(filterOfPath("deliverables"), "delivered");
  assert.equal(filterOfPath("outputs"), "delivered", "an Outputs link still opens on its Files filter (fromOutputs)");
  assert.equal(RENAMED_VIEWS.deliverables, "home");
  assert.equal(RENAMED_VIEWS.outputs, "home");
  assert.deepEqual(fromPath("deliverables", [{ id: "home", subPath: "" }]), { view: "home", path: [], params: { filter: "delivered" } });
  assert.equal(placeOf("deliverables"), "home");
  assert.match(src("app/refs.ts"), /panel\("deliverables", `\[data-deliverable="\$\{deliv\}"\], \[data-tree-key="d:\$\{deliv\}"\]`, deliv\)/, "a reference reveals the deliverable, which Home's Delivered now draws");
});

test("Home's Delivered is today's Deliverables view; the Sidebar's, the header's and Deliverables' counts are the same number", () => {
  assert.doesNotMatch(app, /id: "deliverables", subPath/, "no Deliverables tab");
  assert.match(app, /filter === "delivered" \? <DeliverablesView q=\{deliverables\} refetchAll=\{refetchAll\} files=\{route\.params\.files === "1"\} \/>/);
  assert.match(app, /delivered: reviewCount \|\| undefined,/);
  assert.match(feed, /f === "delivered" \? inReview\(deliverables\)\.length/);
});

test("Home has no pages under it any more: its four filters are all it holds", () => {
  const nav = navOf([{ id: "home", label: "Home" }, { id: "chat", label: "Chat" }], new Set());
  assert.deepEqual(nav.main.find((m) => m.id === "home")!.subs, []);
});
