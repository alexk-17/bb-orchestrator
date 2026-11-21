// Why: Home first step 3 (2026-11-20) folds the Needs you tab into Home's Needs you filter; 83% of answers are on desktop, so its keys must keep working there.
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";
import { decide } from "../app/keys.ts";
import { RENAMED_VIEWS, panes, parse } from "../app/layout.ts";
import { filterOfPath, placeOf } from "../app/nav.ts";
import { fromPath } from "../app/route.ts";

const src = (f: string) => readFileSync(new URL(`../${f}`, import.meta.url), "utf8");
const app = src("app.tsx");
const feed = src("app/feed.tsx");
const VIEWS = ["home", "chat", "projects"].map((id) => ({ id, subPath: id === "home" ? "" : id }));

test("J, K, 1–4, Enter and A on Home's Needs you are Needs you's keys: its list registers them for the pane it is drawn in", () => {
  assert.match(app, /body=\{filter === "needs" \? <NeedsYouView /, "Home on Needs you draws Needs you's list in that pane");
  assert.match(src("app/needs-you.tsx"), /useViewKeys\("needs-you", root, '\[data-list="cards"\] \[data-card\]'/, "Needs you's list still registers its keys");
  assert.match(app, /done = handlerFor\(lay\.current!\.focus\)\?\.\(a\) \?\? false;/, "the page's one listener asks the focused pane");
  assert.match(app, /keyCtx\.current = \{ views, act, onFilter, step, splitKey, cancelPick \};/, "the listener reads this render's actions, not the first render's");
});

test("Shift+N still opens Needs you: Home on that filter, not a tab that no longer exists", () => {
  const n = decide({ key: "N", code: "KeyN", shiftKey: true, metaKey: false, ctrlKey: false, altKey: false }, null);
  assert.deepEqual(n, { t: "tab", view: "needs-you" });
  assert.equal(filterOfPath("needs-you"), "needs");
  assert.match(app, /const f = filterOfPath\(a\.view\);\s*if \(f\) ctx\.onFilter\(f\);/);
});

test("a needs-you link (openCard, refs, old bookmarks) opens Home on Needs you", () => {
  assert.equal(RENAMED_VIEWS["needs-you"], "home");
  assert.deepEqual(fromPath("needs-you", VIEWS), { view: "home", path: [], params: { filter: "needs" } });
  assert.equal(filterOfPath("needs-you/card-1"), "needs");
  assert.equal(placeOf("needs-you"), "home");
  assert.match(app, /else act\(lay\.current!\.focus, \{ view: "home", path: \[\], params: \{ filter: "needs" \} \}, "push"\);/, "openCard: the focused pane goes to Home on Needs you");
  assert.match(app, /const \{ layout: next, pane \} = land\(l, to, VIEWS\);/, "a later link lands in a pane too, not only the first render");
  assert.match(src("app/route.ts"), /return `home\/\$\{f\}/, "the URL says the filter, so a reload stays on it");
});

test("a saved layout with Needs you beside Home is two Homes, each on its own filter (split panes, 2026-11-20)", () => {
  const two = { root: { kind: "split", id: "s", dir: "row", sizes: [1, 1], children: [{ kind: "pane", id: "a", view: "home" }, { kind: "pane", id: "b", view: "needs-you" }] }, focus: "b" };
  assert.deepEqual(panes(parse(two, VIEWS)!.root).map((p) => p.route.params.filter ?? "all"), ["all", "needs"]);
  assert.equal(RENAMED_VIEWS["needs-you"], "home");
});

test("Home's Needs you is today's Needs you list, read once, and every count of it is the same number", () => {
  assert.doesNotMatch(app, /id: "needs-you", subPath/, "no Needs you tab");
  assert.match(app, /body=\{filter === "needs" \? <NeedsYouView q=\{needs\}/);
  assert.match(feed, /input: \{ cursor: null, filter \}, enabled: filter !== "all" && !body \}/, "the feed's needs page isn't read as well");
  assert.match(app, /needs: owner\.needs \|\| undefined,/, "the Sidebar's count");
  assert.match(app, /counts=\{\{ needs: owner\.needs, delivered: owner\.delivered, projects: owner\.scope \}\}/, "the phone bar's badges: the same numbers as the Sidebar's");
  assert.match(feed, /f === "needs" \? needs\?\.badge/, "the header's count");
});

test("hiddenTabs can't hide where answers happen: needs-you and deliverables do nothing, and the setting says so", () => {
  assert.doesNotMatch(app, /\{ id: "(needs-you|deliverables)", subPath/, "no view for hiddenTabs to match");
  const filters = feed.slice(feed.indexOf("const FILTERS"), feed.indexOf("];", feed.indexOf("const FILTERS")));
  assert.match(filters, /\{ id: "needs", label: "Needs you" \}/, "Home's filters are fixed in the page, never read from hiddenTabs");
  assert.match(filters, /\{ id: "delivered", label: "Delivered" \}/);
  assert.match(src("server.ts"), /needs-you and deliverables do nothing: Home's Needs you and Delivered filters never hide/);
});
