// Home first (2026-11-20). Why: the bare page opened on an empty Deliverables tab on web; it now opens Home everywhere, and old links still land.
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";
import { RENAMED_VIEWS, land, panes, single, split, type Layout } from "../app/layout.ts";
import { fromPath, rootOf } from "../app/route.ts";

const app = readFileSync(new URL("../app.tsx", import.meta.url), "utf8");
const VIEWS = [
  { id: "home", subPath: "" },
  { id: "projects", subPath: "projects" },
  { id: "chat", subPath: "chat" },
];
const viewFor = (subPath: string) => fromPath(subPath, VIEWS).view;

test("the bare page and an unknown sub-path open Home; every view's own sub-path opens that view", () => {
  assert.equal(viewFor(""), "home", "the bare page");
  assert.equal(viewFor("no-such-tab"), "home");
  assert.equal(viewFor("deliverables"), "home", "links into Deliverables (refs, pins, the book) land on Home's Delivered (step 3)");
  assert.equal(viewFor("projects/kite"), "projects", "a project's page");
  assert.equal(viewFor("needs-you"), "home", "openCard's target: Home, on its Needs you filter (step 3)");
});

test("old view ids still redirect through RENAMED_VIEWS", () => {
  for (const [old, now] of Object.entries(RENAMED_VIEWS)) assert.equal(viewFor(old), now, old);
  assert.equal(viewFor("outputs"), "home");
  assert.equal(viewFor("agents"), "projects");
});

test("a link to Home focuses a pane already on Home rather than drawing Home twice", () => {
  const two: Layout = split(single(rootOf("projects"), "a"), "a", "row", rootOf("home"));
  const homeId = panes(two.root).find((p) => p.route.view === "home")!.id;
  const opened = land({ ...two, focus: "a" }, rootOf("home"), VIEWS).layout;
  assert.equal(opened.focus, homeId);
  assert.deepEqual(panes(opened.root).map((p) => p.route.view), ["projects", "home"], "no pane changed its page");
});

test("with no pane on Home, the focused pane switches to it", () => {
  const opened = land(single(rootOf("projects"), "a"), rootOf("home"), VIEWS).layout;
  assert.deepEqual(panes(opened.root).map((p) => p.route.view), ["home"]);
  const same = single(rootOf("home"), "a");
  assert.equal(land(same, rootOf("home"), VIEWS).layout, same, "already there: nothing changes");
});

test("the page wires it: Home is the bare page, first; a feed link redirects", () => {
  assert.match(app, /VIEWS = \[\s*(?:\/\/[^\n]*\n\s*)*\{ id: "home", subPath: "", label: "Home" \},/);
  assert.equal(RENAMED_VIEWS.feed, "home", "step 1's /feed links and saved panes land on Home");
  assert.match(app, /lay\.current = subPath === "" \? saved : land\(saved, fromPath\(subPath, VIEWS\), VIEWS\)\.layout;/, "the bare page keeps the saved layout; a link lands in a pane; no phone-only condition");
  assert.doesNotMatch(app, /phoneFirst/);
  assert.equal(fromPath("", VIEWS).view, "home", "the bare page is Home");
});

test("Home's filters live in the nav: the page Sidebar's sub-items on web, the bar and its More on a phone", () => {
  const feed = readFileSync(new URL("../app/feed.tsx", import.meta.url), "utf8");
  const nav = readFileSync(new URL("../app/page-nav.tsx", import.meta.url), "utf8");
  assert.doesNotMatch(feed, /role="tablist"|role="tab"/, "no hand-made tabs");
  assert.match(nav, /<SubLink key=\{f\.id\} active=\{view === "home" && filter === f\.id\}/);
  // 2026-11-21: the phone bar holds Needs you and Delivered and More holds the feed and Alerts, so a filter row on the
  // page would repeat the bar's labels (one row of tabs at most, and no label repeats between levels)
  assert.doesNotMatch(feed, /<Tabs |\{tabs\}/, "no filter row on the page");
  assert.doesNotMatch(feed, /useState<FeedFilter>/, "each pane's route holds its filter, so the navigation and keys can set it");
  assert.match(app, /const filter = \(route\.params\.filter \?\? "all"\) as FeedFilter;/, "per pane, not per page (split panes, 2026-11-20)");
});
