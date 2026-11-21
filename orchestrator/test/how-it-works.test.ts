// Why: the guide was 460 stale lines linked from nowhere; it is now one short page the ? sheet opens (2026-11-20).
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";
import { LINKED_ONLY, shownTabs } from "../app/hidden-tabs.ts";

const read = (f: string) => readFileSync(new URL(`../${f}`, import.meta.url), "utf8");
const guide = read("USAGE.md");

test("the guide is one page and describes today's page, not removed parts", () => {
  assert.ok(guide.split("\n").length <= 120, `one page: ${guide.split("\n").length} lines`);
  assert.match(guide, /^# How it works$/m);
  assert.match(guide, /## Start here/);
  assert.match(guide, /\*\*Home\*\* is where the page opens/);
  assert.doesNotMatch(guide, /box above the tabs|usage-images\//, "the docked box went in 1.26.1; screenshots don't render in the page");
  for (const s of ["Pathways", "CodeRabbit", "Tools: Game Boy"]) assert.ok(guide.includes(s), `${s}: the skill and the settings point here`);
});

test("the server serves USAGE.md as the guide, and the page draws it as Markdown", () => {
  assert.match(read("server.ts"), /async howItWorks\(\) \{\s*return \{ markdown: readFileSync\(join\(import\.meta\.dirname, "USAGE\.md"\), "utf8"\) \};/);
  assert.match(read("app/how-it-works.tsx"), /<Markdown content=\{q\.data\.markdown\} \/>/);
});

test("the ? sheet opens it, and it has no tab of its own: it shows only while a pane is on it", () => {
  const sheet = read("app/shortcut-help.tsx");
  assert.match(sheet, /\{ sub: "how-it-works", label: "How it works", show: true \}/);
  assert.match(sheet, /navigate\.toPluginPanel\(PANEL_PATH, \{ subPath: l\.sub \}\)/);
  assert.match(read("app.tsx"), /\{ id: "how-it-works", subPath: "how-it-works", label: "How it works" \}/);
  assert.deepEqual(LINKED_ONLY, ["how-it-works"]);
  const views = [{ id: "feed", label: "Home" }, { id: "how-it-works", label: "How it works" }];
  assert.deepEqual(shownTabs(views, new Set(), 0, new Set(["feed"])).map((v) => v.id), ["feed"]);
  assert.deepEqual(shownTabs(views, new Set(), 0, new Set(["how-it-works"])).map((v) => v.id), ["feed", "how-it-works"]);
});
