// Why: the owner (2026-11-20) found "way too much empty space" on every phone view; web must keep its look
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";
import { fadeOf } from "../app/phone.ts";

const src = (f: string) => readFileSync(new URL(`../${f}`, import.meta.url), "utf8");
const fn = (s: string, name: string) => s.slice(s.indexOf(`function ${name}(`), s.indexOf("\n}\n", s.indexOf(`function ${name}(`)));

test("the page marks bb's phone layout on its root, from the touch-phone query, never the pane's width", () => {
  const app = src("app.tsx");
  assert.match(app, /const phone = useTouchPhone\(\);/);
  assert.match(app, /data-orch="" data-view=\{focusedView\} data-phone=\{phone \|\| undefined\}/);
});

test("on a phone a card is 12 px in from its edge, not shadcn's 24, inside the pane's 16 px gutter; tight cards keep theirs", () => {
  const look = src("app/ui.tsx");
  const rule = (sel: string) => look.split("\n").find((l) => l.startsWith(sel)) ?? "";
  assert.match(rule('[data-orch][data-phone] [data-slot="card"]:is([class~="py-5"], [class~="py-6"])'), /padding-block: 12px;/);
  assert.match(rule('[data-orch][data-phone] [data-slot="card"]:is([class~="p-4"]'), /padding: 12px;/);
  assert.match(rule('[data-orch][data-phone] :is([data-slot="card-header"]'), /:is\(\[class~="px-4"\], \[class~="px-5"\], \[class~="px-6"\]\) \{ padding-inline: 12px; \}/, "a part with px-0..3 (a book card's rows) is untouched");
  assert.doesNotMatch(look, /\[data-orch\] \[data-slot="card"\]/, "no card rule outside the phone layout: web is unchanged");
  assert.match(src("app/ui/card.tsx"), /gap-6 rounded-xl border bg-card py-6/, "the vendored Card itself stays shadcn's");
});

test("a sideways row fades only on the side with more, so a row that fits (Projects' filters) shows whole", () => {
  assert.equal(fadeOf({ left: false, right: false }), "linear-gradient(to right, black, black)");
  assert.match(fadeOf({ left: false, right: true }), /black calc\(100% - 32px\), transparent\)$/, "the cut-off side says there is more");
  assert.match(fadeOf({ left: true, right: false }), /^linear-gradient\(to right, transparent, black 24px, black\)$/);
});

test("Reviews on a phone: its filters scroll with the fade, Post sits on the Sort row, the note is one line", () => {
  const prs = src("app/open-prs.tsx");
  assert.match(prs, /<ScrollRow>\s*<ToggleGroup type="single" variant="outline" size="sm" aria-label="Filter"/, "they ran off the right edge");
  assert.match(prs, /\{asked && !phone \? post : null\}/, "not on a line of its own");
  assert.match(prs, /<PrList prs=\{shown\} wide=\{wide\} action=\{asked && phone \? post : undefined\} \/>/);
  assert.match(prs, /className=\{phone \? `\$\{NOTE\} truncate` : NOTE\} title=\{phone \? f\.means : undefined\}/, "it wrapped to 3 lines");
});

test("Home on a phone: a post's face is on the gutter, and Open never takes a row of its own", () => {
  const feed = src("app/feed.tsx");
  assert.match(feed, /\[data-orch\]\[data-phone\] \[data-feed\] \.k-post \{ padding: 12px 16px 8px; \}/);
  assert.match(feed, /\{!\(phone && onlyOpen\) \? \(\s*<div className="mt-2 flex flex-wrap items-center gap-1\.5" data-actions="">/);
  assert.match(feed, /onClick=\{phone && onlyOpen \? \(e\) =>/, "the post itself opens on a tap instead");
  assert.match(feed, /<span className="shrink-0 [^"]*whitespace-nowrap[^"]*" data-item-chip="">\{touch && d \? \(p\.scope \? "Scope" : "Delivered"\) : chipOf\(p\)\}/, "one line; on a phone a deliverable's state is said once, on its card");
  const pane = fn(feed, "ItemPane");
  assert.match(pane, /const touch = useTouchPhone\(\);/, "bb's touch phone, never the pane's width: a narrow desktop pane keeps the full chip");
});

test("a card on a phone shows its age (1h), not the full date, so its title keeps the row's width", () => {
  // the full "Nov 20, 06:51 AM" took a third of a 390 card and broke titles mid-word
  assert.match(src("app/needs-you.tsx"), /\{mark \?\? \(phone \? ago\(Date\.parse\(card\.askedAt\), Date\.now\(\)\) : when\(card\.askedAt\)\)\}/);
});

test("Multiplayer on a phone sits on the pane's one gutter, not its own second one inside it", () => {
  assert.match(src("app/ui.tsx"), /\[data-orch\]\[data-phone\] \[data-multiplayer\] \{ padding-inline: 0; padding-top: 0; \}/);
  assert.match(readFileSync(new URL("../multiplayer/app.tsx", import.meta.url), "utf8"), /px-4 pt-4" data-multiplayer=""/, "it keeps its own on web");
});
