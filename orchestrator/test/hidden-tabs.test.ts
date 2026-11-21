// The hiddenTabs setting (2026-11-17). Why it matters: the owner hides tabs they never use, but a setting that names
// every tab, or a capitalised label, must not leave a blank page, and the default (empty) must show every tab. Scoping
// cards and deliverables wait only in the Scope tab, so a hidden Scope tab must still show while something waits there,
// or a project scoping later files cards nobody sees; and while a pane is on it, so a link to it, a reload, or answering
// its last card never throws the owner off it.
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";
import { shownTabs } from "../app/hidden-tabs.ts";

const app = readFileSync(new URL("../app.tsx", import.meta.url), "utf8");
const server = readFileSync(new URL("../server.ts", import.meta.url), "utf8");

const VIEWS = [
  { id: "deliverables", label: "Deliverables" },
  { id: "projects", label: "Projects" },
  { id: "scope", label: "Scope" },
  { id: "open-prs", label: "Open PRs" },
  { id: "board", label: "Activity" },
];
const ALL = VIEWS.map((v) => v.id);
const ids = (hidden: string[], scopeWaiting: number, onPanes: string[] = ["deliverables"]) =>
  shownTabs(VIEWS, new Set(hidden), scopeWaiting, new Set(onPanes)).map((v) => v.id);

test("a hidden Scope tab shows, in its place, while something waits in it, and hides as set when nothing does", () => {
  assert.deepEqual(ids(["scope", "open-prs"], 1), ["deliverables", "projects", "scope", "board"], "one waiting card brings Scope back");
  assert.deepEqual(ids(["scope", "open-prs"], 0), ["deliverables", "projects", "board"], "nothing waiting: hidden as set");
  assert.deepEqual(ids(["scope"], 3), ids([], 3), "hidden by id or not, the strip is the same while something waits");
  // the page passes what waits in Scope (its open cards and its scoping deliverables to review, the number drawn on the
  // tab) and the views its panes are on, so the rule is wired, not only defined
  assert.match(app, /const visible = shownTabs\(VIEWS, new Set\(config\.data\?\.hiddenTabs \?\? \[\]\), scopeWaiting, new Set\(panes\(layout\.root\)\.map\(\(p\) => p\.route\.view\)\), inUse, PLACES\);/);
  assert.match(app, /const scopeWaiting = owner\.scope;/, "the rail badge's Scope part (kit.ts ownerCounts: its cards and scoping deliverables)");
  assert.match(app, /projects: scopeWaiting \|\| /, "what waits in Scoping is the number the nav draws on Projects, where its group now is");
});

test("a hidden Scope tab stays while a pane is on it, with nothing waiting, and goes once no pane is", () => {
  assert.deepEqual(ids(["scope", "open-prs"], 0, ["scope"]), ["deliverables", "projects", "scope", "board"], "a link or reload onto Scope, or its last card answered");
  assert.deepEqual(ids(["scope", "open-prs"], 0, ["projects", "scope"]), ["deliverables", "projects", "scope", "board"], "any pane of a split");
  assert.deepEqual(ids(["scope", "open-prs"], 0, ["deliverables"]), ["deliverables", "projects", "board"], "the owner left it");
});

test("what waits in Scope, or a pane on it, changes no other tab", () => {
  assert.deepEqual(ids(["open-prs", "activity"], 2, ["scope"]), ["deliverables", "projects", "scope"], "other hidden tabs stay hidden");
  assert.deepEqual(ids(["scope", "open-prs"], 0, ["open-prs"]), ["deliverables", "projects", "board"], "a pane on another hidden tab still moves (PR #5)");
  assert.deepEqual(ids(ALL, 2, ["scope"]), ALL, "a setting naming every tab still shows them all");
});

test("hiding every tab shows them all; a pane left on a hidden tab moves to one that shows", () => {
  assert.deepEqual(ids(ALL, 0), ALL);
  assert.match(app, /setRoute\(l, p\.id, rootOf\(visible\[0\]!\.id\)\)/);
});

test("the setting is empty by default and matched case-insensitively against ids and labels", () => {
  assert.match(server, /hiddenTabs: \{ type: "string", [^\n]*default: "" \}/);
  assert.match(server, /hiddenTabs: cfg\.hiddenTabs\.split\(","\)\.map\(\(t\) => t\.trim\(\)\.toLowerCase\(\)\)\.filter\(Boolean\)/);
  assert.deepEqual(ids([], 0), ALL, "empty: every tab");
  assert.deepEqual(ids(["activity", "open prs"], 0), ["deliverables", "projects", "scope"], "lower-cased labels match");
});

test("the CodeRabbit tab (2026-11-18) is listed, shown once set up (2026-11-20), and hidden by hiddenTabs: coderabbit", () => {
  assert.match(app, /\{ id: "coderabbit", subPath: "coderabbit", label: "CodeRabbit" \}/);
  const views = [...VIEWS, { id: "coderabbit", label: "CodeRabbit" }];
  const on = new Set(["coderabbit"]);
  assert.ok(!shownTabs(views, new Set(["coderabbit"]), 0, new Set(["deliverables"]), on).some((v) => v.id === "coderabbit"), "hidden by name even when set up");
  assert.ok(shownTabs(views, new Set(), 0, new Set(["deliverables"]), on).some((v) => v.id === "coderabbit"), "shown once set up");
  assert.ok(!shownTabs(views, new Set(), 0, new Set(["deliverables"])).some((v) => v.id === "coderabbit"), "not set up: hidden");
});

test("hiddenTabs never hides the four places (Home first, step 2): it applies to the rest", () => {
  const views = [{ id: "home", label: "Home" }, { id: "chat", label: "Chat" }, { id: "rules", label: "Rules" }];
  const keep = new Set(["home", "chat"]);
  assert.deepEqual(shownTabs(views, new Set(["home", "chat", "rules"]), 0, new Set(["home"]), new Set(), keep).map((v) => v.id), ["home", "chat"]);
  assert.match(app, /const PLACES = new Set\(MAIN\.map\(\(m\) => m\.id\)\);/);
});
