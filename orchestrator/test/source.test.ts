// Layout B's words (2026-11-16, app/source.ts). The owner refers to this page to not get lost, so it must say each thing
// once and in the right place: what waits on him under Needs you (each card once, even when a live wait names it too; a
// lead's word without a card says so), the rest under Blocked by; a blocker's age is from when the lead first said it,
// and says so only when that is known; "merged today" is his today; the search finds a PR whether he types #4475 or
// 4475, and every word must match; a hit on a project the filter hides still lands on it.
import assert from "node:assert/strict";
import { test } from "node:test";
import type { NeedsYou, Projects, SummaryWait } from "../contract.ts";
import type { Lane } from "../app/lanes.ts";
import { WIDE_MIN, blockerLines, dayStart, isWide, mergedToday, mergedTodayCount, needLines, otherWaits, prsInFlight, searchLoaded, searchedProjects, filterHides } from "../app/source.ts";

const NOW = Date.parse("2026-11-16T15:00:00");
const H = 3_600_000;
type P = Projects[number];
const CARD = ["d", "20261116T090000Z", "aaaaaa"].join("-");
const wait = (w: Partial<SummaryWait>): SummaryWait => ({ source: "live", kind: "card", ref: null, who: null, label: null, since: null, unchanged: false, note: null, ...w });
const project = (slug: string, x: Partial<P> & { waits?: SummaryWait[]; blockers?: string[] } = {}): P => ({
  slug,
  priority: "normal",
  heldAt: null,
  archivedAt: null,
  lead: { address: `lead:${slug}`, threadId: `T-${slug}`, status: "idle", mon: null },
  threads: 0,
  monType: null,
  status: { goal: `Ship ${slug}`, steps: [{ title: "Build", state: "current" }], waitingOn: { kind: "none", ref: null, label: null }, blockers: x.blockers ?? [], updatedAt: NOW - 2 * H, by: `lead:${slug}` },
  summary: {
    motion: "waiting",
    threads: { working: 0, total: 0 },
    leadWorking: false,
    needsYou: { count: 0, id: null, title: null, question: null, since: null },
    waits: x.waits ?? [],
    blockers: x.blockers ?? [],
    statusOutOfDate: false,
    done: null,
    last: null,
    leadIdleSince: null,
  },
  ...x,
}) as P;
const card = (id: string, projectSlug: string, question: string) => ({ id, project: projectSlug, title: question, question, askedAt: new Date(NOW - H).toISOString() }) as NeedsYou["cards"][number];
const lane = (address: string, x: Partial<Lane> = {}): Lane => ({ agent: { address, threadId: `T-${address}`, role: "thread" } as Lane["agent"], state: "idle", since: null, activity: null, model: null, wait: null, ...x });

test("Needs you lists each card once, even when a live wait names the same card; a lead's own word without a card says so", () => {
  const p = project("kite", { waits: [wait({ kind: "card", ref: CARD, label: "the name" }), wait({ source: "lead", kind: "owner", label: "your go on the launch" }), wait({ kind: "pr", ref: "https://x/pull/1" })] });
  const lines = needLines(p, [lane("thread:kite:2", { state: "waiting", wait: { on: "owner", cardId: null, threadId: "T-2" }, activity: "Allow the deploy?" })], [card(CARD, "kite", "Which name?"), card("other", "otter", "Not kite's")]);
  assert.deepEqual(
    lines.map((l) => [l.kind, l.kind === "wait" ? l.noCard : l.text]),
    [
      ["card", "Which name?"],
      ["prompt", "Allow the deploy?"],
      ["wait", true],
    ],
  );
  assert.deepEqual(otherWaits(p).map((w) => w.kind), ["pr"], "a PR wait is not his to settle: it goes under Blocked by");
});

test("a blocker's age is the lead's first saying of it when known, else the status's time, marked as such", () => {
  const p = project("kite", { blockers: ["staging keys", "a review", "a design"] });
  const lines = blockerLines(p, { decided: [], done: [], merged: [], mergedTotal: 0, since: [{ text: "staging keys", since: NOW - 30 * H, bound: false }, { text: "a design", since: NOW - 90 * H, bound: true }] });
  assert.deepEqual(lines, [
    { text: "staging keys", since: NOW - 30 * H, first: true, bound: false },
    { text: "a review", since: NOW - 2 * H, first: false, bound: false },
    { text: "a design", since: NOW - 90 * H, first: true, bound: true },
  ]);
  assert.deepEqual(blockerLines(p, undefined).map((b) => b.first), [false, false, false], "before the book loads");
});

test("PRs in flight are the open and draft ones; merged today is the viewer's own day", () => {
  const p = project("kite", { prs: [1, 2, 3].map((n, i) => ({ number: n, url: `https://x/pull/${n}`, state: ["open", "draft", "merged"][i]!, checks: null, review: null, attention: null })) });
  assert.deepEqual(prsInFlight(p).map((x) => x.number), [2, 1]);
  const book = { decided: [], done: [], merged: [{ number: 9, url: null, at: dayStart(NOW) + H }, { number: 8, url: null, at: dayStart(NOW) - H }], mergedTotal: 2, since: [] };
  assert.deepEqual(mergedToday(book, NOW).map((m) => m.number), [9]);
  assert.equal(mergedTodayCount(book, NOW), 1, "yesterday's merge the plugin sent (its day differs) doesn't count");
  const capped = { ...book, merged: [{ number: 9, url: null, at: dayStart(NOW) + H }], mergedTotal: 140 };
  assert.equal(mergedTodayCount(capped, NOW), 140, "the plugin listed only the first ones: its count");
});

test("the search finds a PR as #4475 or 4475, a thread by its title, a card by its question; every word must match", () => {
  const kite = project("kite", { prs: [{ number: 4475, url: "https://x/pull/4475", state: "open", checks: null, review: null, attention: null }], waits: [wait({ kind: "pr", ref: "https://x/pull/4475", label: "a review" })] });
  const otter = project("otter", { blockers: ["the staging keys"] });
  const lanes = new Map([["kite", [lane("thread:kite:4", { activity: "4527 allowlist rewrite" })]]]);
  const cards = [card(CARD, "otter", "Rotate the staging keys?")];
  const text = (w: SummaryWait) => `${w.label} ${w.ref}`;
  const kinds = (q: string) => searchLoaded([kite, otter], lanes, cards, q, text).map((h) => `${h.project}:${h.kind}`);
  assert.deepEqual(kinds("#4475"), ["kite:pr", "kite:wait"]);
  assert.deepEqual(kinds("4475"), kinds("#4475"));
  assert.deepEqual(kinds("allowlist"), ["kite:thread"]);
  assert.deepEqual(kinds("staging keys"), ["otter:card", "otter:blocker"]);
  assert.deepEqual(kinds("keys staging"), kinds("staging keys"), "words in any order");
  assert.deepEqual(kinds("staging kite"), [], "every word must match one line");
  assert.deepEqual(kinds("  "), []);
  assert.deepEqual(searchedProjects([kite, otter], searchLoaded([kite, otter], lanes, cards, "allowlist", text), "allowlist").map((p) => p.slug), ["kite"]);
  assert.deepEqual(searchedProjects([kite, otter], [], "").map((p) => p.slug), ["kite", "otter"], "no query: every project");
});

test("a project clicked in the hits is reached even when the filter hides it: only then does the filter clear", () => {
  const kite = project("kite", { blockers: ["keys"] });
  const blockedOnly = [kite];
  assert.equal(filterHides("otter", blockedOnly), true, "Blocked filter on, an unblocked project's hit clicked");
  assert.equal(filterHides("kite", blockedOnly), false, "a project the filter keeps: the filter stays");
});

test("a pane 720 px or wider shows the list beside the item (the owner, 2026-11-20); one pane at 1440 (864 px) does", () => {
  assert.equal(WIDE_MIN, 720);
  assert.equal(isWide(WIDE_MIN), true);
  assert.equal(isWide(WIDE_MIN - 1), false);
  assert.equal(isWide(864), true, "a single pane at 1440 beside the open Sidebar");
  assert.equal(isWide(432), false, "half of it, in a split: the item opens as its own page");
});
