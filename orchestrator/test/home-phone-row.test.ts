// Why: the owner found phone Home "so confusing with the double tabs" (2026-11-20): a pages row stacked on the filter row. Home now has one row of tabs, and an empty Home is Start here alone.
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";
import { navOf } from "../app/nav.ts";

const src = (f: string) => readFileSync(new URL(`../${f}`, import.meta.url), "utf8");
const feed = src("app/feed.tsx");
const app = src("app.tsx");

test("at 390 px Home draws no filter row: one header row with where you are, its count, the mic and Mark all read", () => {
  // 2026-11-21: the phone bar holds Needs you and Delivered, and More holds the feed and Alerts, so a filter row on the
  // page would repeat the bar's labels; the one row left says where you are
  assert.doesNotMatch(feed, /<Tabs |\{tabs\}/, "no Tabs in Home");
  const header = feed.slice(feed.indexOf("const header = alone"), feed.indexOf("const list = ("));
  assert.match(header, /<h1 className="m-0 text-base font-semibold">\{label\}<\/h1>/);
  assert.match(header, /\{phone \? \(\s*<Button type="button" variant="ghost" size="icon" className="size-11" aria-label="Mark all read"/, "an icon on a phone, 44 px");
  assert.match(header, /filter === "needs" && !phone/, "no J/K keys hint on a phone");
  const nav = navOf([{ id: "home", label: "Home" }, { id: "deliverables", label: "Deliverables" }, { id: "needs-you", label: "Needs you" }], new Set());
  assert.deepEqual(nav.main.find((m) => m.id === "home")!.subs, [], "so the pages row (PlaceLinks) draws nothing on Home");
  assert.match(src("app/page-nav.tsx"), /if \(!place \|\| !place\.subs\.length\) return null;/);
  assert.match(app, /\{phoneNav \? <PlaceLinks /);
});

test("an empty Home is Start here alone: its title and the mic, no Mark all read", () => {
  assert.match(feed, /const alone = !body && filter === "all" && !!view && posts\.length === 0;/);
  const header = feed.slice(feed.indexOf("const header = alone"), feed.indexOf(") : (", feed.indexOf("const header = alone")));
  assert.doesNotMatch(header, /tabs|Mark all read|data-mark-all/);
  assert.match(header, /<h1 className="m-0 text-base font-semibold">Home<\/h1>/);
});
