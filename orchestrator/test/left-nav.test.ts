// The owner, 2026-11-20 (via the CoS): "Left nav only". No tab row on top; every page he had as a tab on 11-19 is its own
// visible item in the left Sidebar, groups expanded, nothing tucked behind a menu. His earlier choices still hold: Scope and
// Pathways live in Projects, the used-only pages show once used, and his hiddenTabs setting hides what it names.
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { navOf } from "../app/nav.ts";

const visible = [
  { id: "home", label: "Home" },
  { id: "chat", label: "Chat" },
  { id: "projects", label: "Projects" },
  { id: "open-prs", label: "Open PRs" },
  { id: "multiplayer", label: "Multiplayer" },
  { id: "coderabbit", label: "CodeRabbit" },
  { id: "rules", label: "Rules" },
];

test("a Reviews section in use is its own Sidebar item under Reviews; one not in use isn't", () => {
  const nav = navOf(visible, new Set(["multiplayer"]));
  assert.deepEqual(nav.sections["open-prs"]?.map((s) => s.label), ["Multiplayer"]);
  assert.ok(nav.tools.some((t) => t.label === "Set up CodeRabbit"), "an unused section keeps its Set up item, in view under Tools");
});

test("the phone's rows don't grow: sections are not place sub-pages", () => {
  const nav = navOf(visible, new Set(["multiplayer", "coderabbit"]));
  assert.deepEqual(nav.main.find((m) => m.id === "open-prs")?.subs, [], "a sub-page would draw a second row of tabs on a phone");
});

test("no tab strip; the Sidebar opens by default and shows Tools as an expanded group", () => {
  const app = readFileSync(new URL("../app.tsx", import.meta.url), "utf8");
  const nav = readFileSync(new URL("../app/page-nav.tsx", import.meta.url), "utf8");
  assert.doesNotMatch(app, /TopTabs|data-top-tabs/, "the owner chose no tab row on top");
  assert.match(app, /return localStorage\.getItem\(SIDEBAR_KEY\) === "rail";/, "the Sidebar is open unless the owner collapsed it");
  assert.match(nav, /\{!rail \? \(\s*<SidebarGroup data-tools-group="">/, "the open Sidebar lists Tools' items in view, not behind a menu");
});
