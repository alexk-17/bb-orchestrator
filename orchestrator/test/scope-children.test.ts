// Projects' scoping children (app/kit.ts, 2026-11-22): a project's scope entries sit under its row instead of in a
// Scoping group on top, so the project shows once, with one count that agrees with its children.
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";
import type { Projects } from "../contract.ts";
import { childHits, childWaiting, childrenOpen, leftEntry, listRow, matchesHead, matchesWithScope, plannerStuck, quietWithScope, scopeExtra, type ScopeChild, type ScopeEntry } from "../app/kit.ts";
import { attentionOrder } from "../app/command-center.ts";

const whole = (waiting: number, deliverables = 0): ScopeChild => ({ entry: { key: "kite", slug: "kite", task: null }, waiting, deliverables });
const task = (id: string, name: string, waiting: number, deliverables = 0): ScopeChild => ({ entry: { key: `kite/${id}`, slug: "kite", task: { id, name } }, waiting, deliverables });
const closed = { toggled: undefined, q: "", stored: null, held: null, searchHit: false };
const press = (open: boolean, q = "", held: string | null = null) => ({ open, q, held });

const project = (slug: string, cards: number) =>
  ({
    slug, priority: "normal", heldAt: null, archivedAt: null, mode: "scoping", lead: { address: `lead:${slug}`, threadId: "T", status: "idle", mon: null }, threads: 0, monType: null, status: null,
    summary: { motion: "quiet", threads: { working: 0, total: 0 }, leadWorking: false, needsYou: { count: cards, id: null, title: null, question: null, since: null }, waits: [], statusOutOfDate: false },
  }) as unknown as Projects[number];

test("the parent's 'N for you' counts each waiting item once: its cards (scope cards included) plus scope deliverables", () => {
  // a made-up case seen on 2026-11-22: one card under its task, one for the whole project, no deliverables.
  // needsYou.count already holds both scope cards (core/history.ts counts every person-level card), so the row says 2, not 4
  const kids = [whole(1), task("st-1", "Demo task", 1)];
  assert.equal(childWaiting(kids), 2, "the children's rows still say what waits in each");
  assert.equal(scopeExtra(kids), 0);
  assert.equal(listRow(project("kite", 2), [], 0, false, scopeExtra(kids)).number?.word, "2 for you");
  // a scope deliverable in review is not in needsYou: it adds
  const withDl = [whole(2, 1), task("st-1", "Demo task", 1)];
  assert.equal(listRow(project("kite", 2), [], 0, false, scopeExtra(withDl)).number?.word, "3 for you");
  assert.equal(listRow(project("kite", 0), [], 0, false, scopeExtra([whole(1, 1)])).number?.word, "1 for you", "only a scope deliverable waits: still for you");
});

test("a project whose only waiting item is in its children sorts with those that need the owner", () => {
  const quiet = project("aaa-quiet", 0);
  const scoped = project("zzz-scoped", 0);
  const extra = (p: Projects[number]) => (p.slug === "zzz-scoped" ? 1 : 0);
  assert.deepEqual([quiet, scoped].sort(attentionOrder(new Map(), 0, extra)).map((p) => p.slug), ["zzz-scoped", "aaa-quiet"]);
  assert.deepEqual([quiet, scoped].sort(attentionOrder(new Map(), 0)).map((p) => p.slug), ["aaa-quiet", "zzz-scoped"], "without it, by name as before");
});

test("a project whose children wait is never Quiet; one whose children don't keeps its own rule", () => {
  assert.equal(quietWithScope(true, [whole(0), task("a", "A", 1)]), false);
  assert.equal(quietWithScope(true, [whole(0)]), true);
  assert.equal(quietWithScope(true, []), true);
  assert.equal(quietWithScope(false, []), false);
});

test("'Needs me' matches a project while a child waits; the other filters keep their own rule", () => {
  assert.equal(matchesWithScope("you", false, [task("a", "A", 1)]), true);
  assert.equal(matchesWithScope("you", false, [task("a", "A", 0)]), false);
  assert.equal(matchesWithScope("blocked", false, [task("a", "A", 3)]), false, "a waiting child doesn't make it blocked");
  assert.equal(matchesWithScope("blocked", true, []), true);
});

test("children start open while one waits; else the viewer's last choice; else closed", () => {
  assert.equal(childrenOpen({ kids: [whole(0), task("a", "A", 1)], ...closed }), true, "something waits");
  assert.equal(childrenOpen({ kids: [whole(0)], ...closed }), false, "default collapsed");
  assert.equal(childrenOpen({ kids: [whole(0)], ...closed, stored: true }), true, "remembered open");
  assert.equal(childrenOpen({ kids: [whole(0)], ...closed, stored: false }), false, "remembered closed");
  assert.equal(childrenOpen({ kids: [whole(2)], ...closed, toggled: press(false) }), false, "the chevron closes it even while something waits");
  assert.equal(childrenOpen({ kids: [whole(0)], ...closed, toggled: press(true) }), true);
  assert.equal(childrenOpen({ kids: [whole(0)], ...closed, held: "kite" }), true, "the open scope entry is in sight");
  assert.equal(childrenOpen({ kids: [whole(0)], ...closed, searchHit: true }), true, "a searched task is in sight");
});

// review of public PR #22: a collapse won over everything after it, so searching for a task left its matching child
// hidden under a closed chevron, and so did opening one of its children from elsewhere (a card, a search hit)
test("after a collapse, a search that matches a child or a child opened since shows the children again", () => {
  const kids = [whole(0), task("a", "Region totals export", 1), task("b", "Digest emails", 0)];
  const collapsed = { ...closed, kids, toggled: press(false), stored: false };
  assert.equal(childrenOpen(collapsed), false, "the collapse holds while nothing new is asked for");
  assert.equal(childrenOpen({ ...collapsed, q: "totals", searchHit: true }), true, "collapse, then search: the matching child shows");
  assert.equal(childrenOpen({ ...collapsed, q: "billing", searchHit: false }), false, "a search that matches no child leaves it closed");
  assert.equal(childrenOpen({ ...collapsed, held: "kite/a" }), true, "collapse, then one of its children opened: in sight");
  assert.equal(childrenOpen({ ...closed, kids: [whole(0)], stored: false, q: "totals", searchHit: true }), true, "a collapse remembered from an earlier visit doesn't hide a match either");
  // a press made after the search, or while that child is open, is the newest thing asked for: it holds
  assert.equal(childrenOpen({ ...collapsed, toggled: press(false, "totals"), q: "Totals", searchHit: true }), false, "closed during this search (any case)");
  assert.equal(childrenOpen({ ...collapsed, toggled: press(false, "", "kite/a"), held: "kite/a" }), false, "closed while its child was open");
  assert.equal(childrenOpen({ ...collapsed, toggled: press(false, "", "kite/a"), held: "kite/b" }), true, "then another of its children opened: shown again");
  assert.equal(childrenOpen({ ...collapsed, toggled: press(false, "totals"), q: "region", searchHit: true }), true, "then a search for other words that matches: shown again");
  assert.equal(childrenOpen({ ...collapsed, q: "" }), false, "the search cleared: closed again, as left");
  // a press made during a search ends with it: cleared, the project follows its usual rule (here: a child waits)
  assert.equal(childrenOpen({ ...collapsed, toggled: press(false, "totals"), q: "" }), true, "closed during a search, then the search cleared");
});

test("the page forgets a press made during a search once the search clears, so the same words searched again show the child", () => {
  const p = readFileSync(new URL("../app/projects.tsx", import.meta.url), "utf8");
  assert.match(p, /if \(!found\.trim\(\)\) setToggled\(\(t\) => \(Object\.values\(t\)\.some\(\(x\) => x\.q\.trim\(\)\) \? Object\.fromEntries\(Object\.entries\(t\)\.filter\(\(\[, x\]\) => !x\.q\.trim\(\)\)\) : t\)\);\s*\}, \[found\]\);/);
  assert.match(p, /setToggled\(\(t\) => \(\{ \.\.\.t, \[p\.slug\]: \{ open: !isOpen, q: found, held \} \}\)\)/, "a press records the settled words and which entry was open");
});

test("a search matching a task's name finds that child, by every word, any case", () => {
  const kids = [whole(0), task("a", "Region totals export", 0), task("b", "Digest emails", 0)];
  assert.deepEqual(childHits(kids, "totals REGION").map((k) => k.entry.key), ["kite/a"]);
  assert.deepEqual(childHits(kids, "whole"), [], "the whole-project child has no task name");
  assert.deepEqual(childHits(kids, "  "), []);
});

test("a child row names its planner only when a task's scoping thread is stuck", () => {
  const planner = (status: string) => ({ address: "thread:kite:2", threadId: "T2", title: "Scope the export", status, idleAt: null, report: null });
  const e = (status: string | null): ScopeEntry => ({ key: "kite/a", slug: "kite", task: { id: "a", name: "A" }, planner: status ? (planner(status) as ScopeEntry["planner"]) : null });
  assert.equal(plannerStuck(e("error")), "stuck on an error");
  assert.equal(plannerStuck(e("active")), null, "working: nothing");
  assert.equal(plannerStuck(e("idle")), null);
  assert.equal(plannerStuck(e(null)), null, "the lead plans: nothing");
  assert.equal(plannerStuck({ key: "kite", slug: "kite", task: null }), null, "the whole project: nothing");
});

// the search box said "0 matches on the projects" while the list under it showed a project opened on the scoping task
// the words matched (2026-11-22): the box counts and lists the matched tasks too, so the two agree
test("the search box counts the scoping tasks it matched by name, and lists them, so it agrees with the list", () => {
  assert.equal(matchesHead(0, 1), "1 match on the projects", "only a task's name matched: not 0");
  assert.equal(matchesHead(2, 1), "3 matches on the projects");
  assert.equal(matchesHead(0, 0), "0 matches on the projects");
  const p = readFileSync(new URL("../app/projects.tsx", import.meta.url), "utf8");
  assert.match(p, /const taskHits: TaskHit\[\] = found\.trim\(\) \? shown\.flatMap\(\(p\) => childHits\(kidsOf\(p\), found\)/, "the same matches the list opens, in the projects it shows");
  assert.match(p, /<SearchHits q=\{found\} hits=\{hits\} tasks=\{taskHits\}/);
  const s = readFileSync(new URL("../app/search.tsx", import.meta.url), "utf8");
  assert.match(s, /\{matchesHead\(hits\.length, tasks\.length\)\}/);
  assert.match(s, /tasks\.map\(\(t\) => \(\s*<Line key=\{t\.key\} p=\{by\.get\(t\.project\)\} onOpen=\{onOpen\} tail="scoping task"/, "each matched task has its line");
  assert.match(s, /!hits\.length && !tasks\.length && !cards\.length \? <div className="empty">Nothing matches/, "no 'Nothing matches' over a list that shows a match");
});

// review of public PR #22's landing (P2): open child A, collapse its project, select the parent, open A again. The press
// still named A, so A's return didn't count as new and A stayed hidden. The page now clears that snapshot as the open
// entry changes (leftEntry), and the same sequence shows A.
test("open child A, collapse, select the parent, open A again: A shows", () => {
  const kids = [whole(0), task("a", "Region totals export", 0), task("b", "Digest emails", 0)];
  const at = (held: string | null, toggled: Record<string, ReturnType<typeof press>>) => childrenOpen({ ...closed, kids, stored: false, held, toggled: toggled.kite });
  let toggled: Record<string, ReturnType<typeof press>> = {};
  assert.equal(at("kite/a", toggled), true, "A open: in sight");
  toggled = { kite: press(false, "", "kite/a") };
  assert.equal(at("kite/a", toggled), false, "collapsed while A is open");
  toggled = leftEntry(toggled, null);
  assert.equal(at(null, toggled), false, "the parent selected: still collapsed, as left");
  toggled = leftEntry(toggled, "kite/a");
  assert.equal(at("kite/a", toggled), true, "A opened again: shown");
  // without the page clearing the snapshot, the old press hid A: the case this guards
  assert.equal(at("kite/a", { kite: press(false, "", "kite/a") }), false);
  // a press whose entry is still the open one is kept as it was, and nothing changes identity
  const same = { kite: press(false, "", "kite/a") };
  assert.equal(leftEntry(same, "kite/a"), same);
  const p = readFileSync(new URL("../app/projects.tsx", import.meta.url), "utf8");
  assert.match(p, /useEffect\(\(\) => \{\s*setToggled\(\(t\) => leftEntry\(t, scopeOpen\)\);\s*\}, \[scopeOpen\]\);/, "the page runs it as the open entry changes");
});
