// Why: the owner, 2026-11-21, on the phone: "mobile view definitely needs a new pass. there's too much wasted space and
// it's very cluttered", and "the feed is really just if you need just a quick scroll to see status updates but mostly
// you're still living in 'needs you' and 'delivered'". The pass about doubled the cards per phone screen (measured at
// 390x844 and 360x800 with the iPhone safe areas). What must not regress:
// - every control a finger uses stays 44 px or more on a phone;
// - nothing floats over a card (the "N new" pill);
// - nothing is dropped: what a closed card hides is one tap away;
// - the web keeps its look: every change is behind bb's touch phone (useTouchPhone / [data-phone]), never a pane's width.
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";
import { plainSummary, sameText } from "../app/less-text.ts";

const src = (f: string) => readFileSync(new URL(`../${f}`, import.meta.url), "utf8");
const fn = (s: string, name: string) => s.slice(s.indexOf(`function ${name}(`), s.indexOf("\n}\n", s.indexOf(`function ${name}(`)));

test("a feed post on a phone is one meta line, a clamped title and text, and a small shot beside the title", () => {
  const feed = src("app/feed.tsx");
  const post = fn(feed, "PostView");
  assert.match(post, /size=\{phone \? 24 : 32\}/, "a 24 px face on a phone, 32 on the web");
  assert.match(post, /whitespace-nowrap" data-meta-line="">\s*<span className="flex min-w-0 flex-1 items-center gap-1\.5 overflow-hidden">/, "who, where, when, chip and step on one line, cut rather than wrapped, in a box of their own so the clip never cuts the reply button's touch area");
  assert.match(post, /text-left text-sm leading-snug font-semibold text-foreground", p\.text \? "line-clamp-1" : "line-clamp-2"\)/, "the title is one line over a text line, two alone");
  // the web's title keeps its exact classes: through cn (tailwind-merge), a font size after leading-snug drops the leading
  assert.match(post, /: "h-auto p-0 font-normal whitespace-normal mt-1 block w-full text-left text-\[15px\] leading-snug font-semibold text-foreground"\}/);
  assert.match(post, /phone \? \(p\.kind === "message" \? "line-clamp-3" : p\.title \? "line-clamp-1" : "line-clamp-2"\)/, "the text under a title is one line");
  assert.match(post, /className="k-thumb h-14 shrink-0" data-thumb=\{p\.deliverable\.thumb\}>\s*<ImagePopout /, "the screenshot is a 56 px square beside the title, not a 220 px banner, and a tap pops it out (public PR #17)");
  assert.match(post, /p\.deliverable\?\.thumb && !phone \? \(\s*<div className="k-media"/, "the web keeps the full-width shot");
  assert.match(feed, /\[data-orch\]\[data-phone\] \[data-feed\] \.k-thumb \{ width: 56px; height: 56px;/);
});

test("the step bar shows on a phone only where it adds something: not when 'step N of M' already says it", () => {
  assert.match(fn(src("app/feed.tsx"), "PostView"), /\{p\.status && !\(phone && p\.outcome\) \? <Steps steps=\{p\.status\.steps\} \/> : null\}/);
});

test("a phone's reply count is a 44 px target on the meta line, and the post opens on a tap instead of a lone Open row", () => {
  const post = fn(src("app/feed.tsx"), "PostView");
  assert.match(post, /phone \? "relative z-10 -mt-2 -mb-4 -mr-2 size-11 shrink-0/, "44 px, with negative margins so it adds no height to the line: 8 px up (inside the post's padding, never under the header row) and 16 px down, above the title so it still takes the tap");
  assert.match(post, /const phoneRow = p\.deliverable\?\.state === "review" \|\| noLive \|\| \(p\.held && !!p\.line\);/, "the actions row stays only for review buttons and notes about the line");
});

test("the 'N new' notice never covers a post on a phone: it is a bar in the flow under the header row", () => {
  const feed = src("app/feed.tsx");
  assert.match(feed, /\{waiting > 0 && !touch \? \(\s*<div className="k-pill">/, "the floating pill is the web's only");
  assert.match(feed, /\{header\}\s*\{\/\*[^*]*\*\/\}\s*\{touch && waiting > 0 && !body && view \? \(\s*<Button[\s\S]*?className="k-newbar h-11/, "right under the header row, before the list's scroller");
  assert.match(feed, /\.k-newbar \{ display: flex; width: 100%; min-height: 44px;/, "a 44 px tap target");
  assert.doesNotMatch(feed.match(/\.k-newbar \{[^}]*\}/)![0], /position: (sticky|absolute|fixed)/, "never over the content");
});

test("a Needs you card says its question once on a phone", () => {
  assert.equal(sameText("Ship the example fix today?", "ship the example fix today"), true);
  assert.equal(sameText("  Merge   it now? ", "Merge it now"), true);
  assert.equal(sameText("Merge it now?", "Merge it tomorrow?"), false, "a question that adds something stays");
  assert.match(src("app/needs-you.tsx"), /\{phone && sameText\(card\.question, card\.title\) \? null : \(\s*<p data-question-text=""/);
});

test("a Needs you card on a phone: 44 px answers, More on the title, Defer in the corner, Other a tap away", () => {
  const card = fn(src("app/needs-you.tsx"), "CardView");
  assert.match(card, /size=\{phone \? 20 : 28\}/, "a smaller face");
  assert.match(card, /tall=\{phone\}/, "the answers are 44 px");
  assert.match(src("app/answer-ui.tsx"), /tall && "min-h-11 px-3"/, "44 px at least; a long answer still wraps");
  assert.match(card, /className="relative z-10 -my-2\.5 -mr-2 size-11 shrink-0 text-muted-foreground" data-defer="" aria-label="Defer"/, "Defer: a 44 px clock in the header's corner, not a row of its own");
  assert.match(card, /className="relative z-10 -my-3 -mr-2 size-11 shrink-0 text-muted-foreground" data-more=""/, "More: a 44 px chevron on the meta line, above the question under it so all of it takes the tap; the title opens it too");
  // the lead's condition when it made the call: only whether the box shows changes, never its look
  assert.match(card, /const showOther = card\.allowText && \(!phone \|\| otherOpen \|\| note !== ""\);/, "a typed note keeps the box open");
  assert.match(card, /data-other-open="" onClick=\{\(\) => setOtherOpen\(true\)\}/);
  assert.match(card, /<OtherBox value=\{note\} onChange=\{setNote\} disabled=\{busy\} onSend=\{[^}]*\} placeholder="Other: your own answer, or a note to go with an option\. ⌘↵ sends" \/>/, "the usual box, unchanged");
  assert.match(card, /\{phone \? null : \(\s*<footer className="mt-2 flex items-center gap-2">/, "the web keeps its footer row");
  // More opens where the web's does, above the blocks and answers: under them, a long card put it a screen from the tap
  assert.ok(card.indexOf('<div className="mt-2" data-context="" data-open="">') < card.indexOf("<Options"), "More's context above the answers");
});

test("on a phone the Needs you list doesn't repeat the header row's 'Needs you N', but keeps its count and Stale notice", () => {
  const view = fn(src("app/needs-you.tsx"), "NeedsYouView");
  assert.match(view, /<h3 className=\{phone && !q\.error \? "sr-only" : "m-0 flex items-center gap-2 text-sm font-semibold"\}>/);
});

test("a deliverable on a phone opens closed: title, project, state, a small shot and the two answers; a tap opens all of it", () => {
  const d = src("app/deliverables.tsx");
  assert.match(fn(d, "DeliverableCard"), /if \(closed && phone && !opened\) return <CompactCard/, "one card used to fill the whole screen (2,692 px)");
  // only Delivered's own list starts closed: where a deliverable is already the opened item it must be whole, or a tap
  // in the feed would open the closed card again
  assert.equal(d.match(/<DeliverableCard [^>]*\bclosed\b/g)?.length, 1, "Delivered's narrow list only");
  for (const f of ["app/feed.tsx", "app/scope.tsx"]) assert.doesNotMatch(src(f), /<DeliverableCard [^>]*\bclosed\b/, f);
  const c = fn(d, "CompactCard");
  assert.match(c, /line-clamp-2 text-sm leading-5 font-semibold/, "the title, two lines at most");
  assert.match(c, /\{d\.project \?\? "No project"\} · <span data-compact-state=\{d\.state\}>/, "the project and its state stay visible (the lead's condition)");
  assert.match(c, /className="size-14 shrink-0 overflow-hidden rounded-md border p-0"/, "the screenshot as a 56 px square beside the title");
  assert.match(c, /line-clamp-2 cursor-pointer text-sm text-muted-foreground/, "the summary in two lines");
  assert.match(c, /<Review d=\{d\} refetchAll=\{refetchAll\} compact \/>/);
  const r = fn(d, "Review");
  assert.match(r, /<Btn className="h-11 w-full px-2 text-\[14px\]" data-changes=\{d\.id\}/, "44 px");
  assert.match(r, /<Btn tone="primary" className="h-11 w-full px-2 text-\[14px\]" data-approve=\{d\.id\}/, "44 px, and still the button A presses");
  assert.equal(plainSummary("**Your ask:** see [the shot](https://example.com/x.png) and `code`"), "Your ask: see the shot and code");
});

test("a PR card on a phone is two lines: the title, then the facts on one line with CI as its colour", () => {
  const prs = src("app/open-prs.tsx");
  assert.match(prs, /phone \? "line-clamp-1 \[overflow-wrap:anywhere\]" : "line-clamp-2 \[overflow-wrap:anywhere\]"/);
  assert.match(prs, /phone \? "flex min-w-0 flex-nowrap items-center gap-x-1\.5 overflow-hidden pl-5\.5 text-xs"/);
  assert.match(fn(prs, "CiDot"), /role="img" aria-label=\{c\.text\} title=\{c\.text\}/, "the dot keeps CI's words for a screen reader and a long press");
});

test("Projects on a phone: the list comes first; the standing agents follow it, and search is one tap on an icon", () => {
  const p = src("app/projects.tsx");
  assert.match(p, /\{phone \? null : <StandingAgents/, "not above the list on a phone");
  assert.match(p, /\{phone \? <StandingAgents agents=\{agents\} full=\{lanesFrom\} busy=\{busy\} refetchAll=\{refetchAll\} \/> : null\}/);
  assert.match(p, /className="size-11 shrink-0" icon=\{<Search aria-hidden \/>\} aria-label="Search the projects"[^>]*onClick=\{\(\) => setSearching\(true\)\}/, "a 44 px icon");
  assert.match(p, /<SearchBox value=\{query\} onChange=\{setQuery\} autoFocus=\{searching\} \/>/, "the same search, focused (the lead's condition)");
  assert.match(src("app/search.tsx"), /autoFocus=\{autoFocus\}/);
});

test("every new phone rule is scoped to bb's phone layout, so the web is unchanged", () => {
  for (const f of ["app/feed.tsx", "app/projects.tsx"]) {
    const s = src(f);
    for (const sel of [".k-thumb", ".k-newbar", "[data-home-body]", "[data-earlier]", '[data-group="scoping"]', "[data-scope-row]", ".k-chip"]) {
      for (const m of s.matchAll(new RegExp(`^\\[data-orch\\][^{\\n]*${sel.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}[^{\\n]*\\{`, "gm"))) assert.match(m[0], /\[data-phone\]/, `${f}: ${m[0]}`);
    }
  }
  assert.match(src("app/feed.tsx"), /const touch = useTouchPhone\(\);/, "the feed's bar follows bb's touch phone, never the pane's width");
});
