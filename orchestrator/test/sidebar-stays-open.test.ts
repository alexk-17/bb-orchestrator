// The owner, 2026-11-20 ~20:00Z: "wait where did all the other tabs go for the orchestrator plugin". Three panes side
// by side had folded the Sidebar into its icon rail by itself, which hid every label, Home's filters and Tools. The
// Sidebar is now a rail only by its own toggle; panes that don't fit beside it show one at a time instead.
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

const app = readFileSync(new URL("../app.tsx", import.meta.url), "utf8");

test("the Sidebar becomes the rail only by its toggle, never to make room for panes", () => {
  assert.match(app, /const rail = !compact && railChoice;/, "rail must follow the owner's toggle alone");
  assert.doesNotMatch(app, /fitsRail|!fitsOpen/, "the old rule that collapsed the Sidebar by itself is back");
});

test("a new pane must fit beside the Sidebar as it is drawn now, not beside the rail", () => {
  assert.doesNotMatch(app, /width - sideW\.current\.rail/, "a split or Open beside measured against the rail would force the rail");
  assert.match(app, /Collapse the Sidebar for more/, "the refusal says how to get more room");
});
