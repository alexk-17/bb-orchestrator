// The work board's view (SCOPE piece 2). The owner opens the board to see, across projects, what is in
// flight, shipped and waiting on them, so:
// - every task the read returns sits in exactly the column the read derived (the view never re-derives), and a project
//   filter shows that project's tasks and no other's;
// - Waiting on you and Blocked put the longest wait first, Shipped the newest first: the top card is the one to act on;
// - a card's chips name what is attached, a hand move shows "moved by you" only while it holds;
// - a phone opens on what waits on the owner;
// - the board's URL survives a reload, Back and bb's extra encoding, and no project slug can be mistaken for it;
// - the board refetches only on a change to what it reads (the lag fix's notices), never on an unrelated one;
// - under the since lens, "only cards that moved" leaves exactly the cards that moved since T, so the owner's catch-up
//   view never hides a move or pads it with cards that stood still; off, the lens hides nothing.
import assert from "node:assert/strict";
import { test } from "node:test";
import { readFileSync } from "node:fs";
import type { BoardTask, NeedsYou, Scope, WorkBoard } from "../contract.ts";
import { chipsOf, columnAfterPick, columnsOf, findCard, firstColumn, movedByYou, unfiledCount, whyText, type BoardLens } from "../app/work-board-model.ts";
import { touches } from "../change-notice.ts";
import { BOARD, canonical, fromPath, toPath, type Route } from "../app/route.ts";
import { PROJECT_RE } from "../core/model.ts";

const none = { threads: [], prs: [], deliverables: [], cards: [] };
const task = (id: string, project: string, column: BoardTask["column"], extra: Partial<BoardTask> = {}): BoardTask => ({
  id,
  project,
  title: `Task ${id}`,
  state: "open",
  step: null,
  column,
  derived: column,
  since: null,
  why: "planned",
  hand: null,
  sig: "0",
  ...none,
  ...extra,
});
const boardOf = (tasks: BoardTask[]): WorkBoard => {
  const slugs = [...new Set(tasks.map((t) => t.project))];
  return { now: 0, since: 0, projects: slugs.map((slug) => ({ slug, tasks: tasks.filter((t) => t.project === slug), unfiled: none, dropped: [] })) };
};

test("each task sits in the column the read gave it, once; a filter keeps only its project's", () => {
  const b = boardOf([task("t-1", "kite", "planned"), task("t-2", "kite", "waiting"), task("t-3", "pine", "shipped"), task("t-4", "pine", "blocked"), task("t-5", "kite", "in_review")]);
  const all = columnsOf(b, null);
  assert.deepEqual(all.map((c) => c.column), ["planned", "in_progress", "in_review", "waiting", "blocked", "shipped"]);
  const ids = all.flatMap((c) => c.tasks.map((t) => `${c.column}:${t.id}`));
  assert.deepEqual(ids.sort(), ["blocked:t-4", "in_review:t-5", "planned:t-1", "shipped:t-3", "waiting:t-2"]);
  const kite = columnsOf(b, "kite").flatMap((c) => c.tasks.map((t) => t.project));
  assert.deepEqual([...new Set(kite)], ["kite"]);
  assert.equal(kite.length, 3);
});

test("the top card is the one to act on: oldest wait first, newest ship first", () => {
  const b = boardOf([task("t-new", "kite", "waiting", { since: 300 }), task("t-old", "kite", "waiting", { since: 100 }), task("t-a", "kite", "shipped", { since: 100 }), task("t-b", "kite", "shipped", { since: 500 }), task("t-x", "kite", "blocked", { since: null }), task("t-y", "kite", "blocked", { since: 50 })]);
  const col = (c: string) => columnsOf(b, null).find((x) => x.column === c)!.tasks.map((t) => t.id);
  assert.deepEqual(col("waiting"), ["t-old", "t-new"]);
  assert.deepEqual(col("shipped"), ["t-b", "t-a"]);
  assert.deepEqual(col("blocked"), ["t-y", "t-x"], "an unknown start sorts last");
});

test("a phone opens on Waiting on you when something waits, else the first column with cards", () => {
  assert.equal(firstColumn(columnsOf(boardOf([task("t-1", "k", "planned"), task("t-2", "k", "waiting")]), null)), "waiting");
  assert.equal(firstColumn(columnsOf(boardOf([task("t-1", "k", "in_review")]), null)), "in_review");
  assert.equal(firstColumn(columnsOf(boardOf([]), null)), "planned");
});

test("chips name what is attached: live threads, each PR's state, deliverables and cards", () => {
  const t = task("t-1", "kite", "waiting", {
    threads: [
      { address: "thread:kite:1", threadId: "a", state: "working", live: true },
      { address: "thread:kite:2", threadId: "b", state: "blocked", live: true },
      { address: "thread:kite:3", threadId: "c", state: "released", live: false },
    ],
    prs: [{ url: "u1", number: 12, state: "open", checks: "pending", review: null, attention: null, wait: "ci", at: 0, thread: null, source: "orchestrator" }],
    deliverables: [{ id: "dl-1", title: "Proof", state: "review", rev: 1, at: 0, approvedAt: null }],
    cards: [{ id: "d-1", title: "Go?", level: "person", state: "asked", askedAt: 0, ownerWaits: true, deferred: false, held: false }],
  });
  const chips = chipsOf(t).map((c) => c.text);
  assert.deepEqual(chips, ["thread failed", "1 thread", "#12 CI", "deliverable", "card"]);
  assert.equal(chipsOf(t).find((c) => c.text === "thread failed")!.group, "alarm", "a failed thread is the alarm colour");
});

test("a merged PR says merged; more than two PRs fold into a count", () => {
  const p = (n: number, state: string) => ({ url: `u${n}`, number: n, state, checks: null, review: null, attention: null, wait: null, at: 0, thread: null, source: "orchestrator" as const });
  assert.deepEqual(chipsOf(task("t", "k", "shipped", { prs: [p(1, "merged")] })).map((c) => c.text), ["#1 merged"]);
  assert.deepEqual(chipsOf(task("t", "k", "in_review", { prs: [p(1, "open"), p(2, "open"), p(3, "draft")] })).map((c) => c.text), ["#1 open", "#2 open", "+1 PRs"]);
});

test("a PR linked to the task but never read says unknown, not open: the card must not claim more than bb knows", () => {
  const unread = { url: "u9", number: 9, state: null, checks: null, review: null, attention: null, wait: null, at: 0, thread: null, source: "orchestrator" as const };
  assert.deepEqual(chipsOf(task("t", "k", "in_review", { prs: [unread] })).map((c) => c.text), ["#9 unknown"], "the panel names the same PR \"unknown\"");
});

test("a task's card opens answerable wherever the owner answers it: Needs you's cards, its deferred, or a scoping card from Scope", () => {
  // made-up cards; only the id matters to where a card is found
  const card = (id: string) => ({ id, rev: 1 }) as unknown as NeedsYou["cards"][number];
  const needs = { cards: [card("c-open")], deferred: [card("c-later")], presets: [] } as unknown as NeedsYou;
  const scope = { projects: [{ slug: "kite", cards: [card("c-scoping")] }], badge: 1 } as unknown as Scope;
  assert.deepEqual(findCard("c-open", needs, scope), { card: card("c-open"), list: "cards", scoping: false });
  assert.deepEqual(findCard("c-later", needs, scope), { card: card("c-later"), list: "deferred", scoping: false });
  assert.deepEqual(findCard("c-scoping", needs, scope), { card: card("c-scoping"), list: "cards", scoping: true }, "a scoping card has its actions (Needs you never lists it)");
  assert.equal(findCard("c-scoping", needs, undefined), null, "until Scope is read, it shows as its chip only");
  assert.equal(findCard("c-gone", needs, scope), null);
});

test('"moved by you" shows only while the hand move holds', () => {
  assert.equal(movedByYou(task("t", "k", "shipped", { hand: { column: "shipped", at: 1, holds: true } })), true);
  assert.equal(movedByYou(task("t", "k", "in_review", { hand: { column: "shipped", at: 1, holds: false } })), false, "released: the card is back where its attachments put it");
  assert.equal(movedByYou(task("t", "k", "planned")), false);
});

test("Unfiled counts every kind of thing no task holds", () => {
  assert.equal(unfiledCount({ threads: [{ address: "a", threadId: "a", state: "idle", live: true }], prs: [], deliverables: [], cards: [{ id: "d", title: "x", level: "lead", state: "open", askedAt: null, ownerWaits: false, deferred: false, held: false }] }), 2);
});

const VIEWS = [
  { id: "home", subPath: "" },
  { id: "projects", subPath: "projects" },
  { id: "board", subPath: "board" },
];

test("the board's URL survives a reload and Back, with or without a project and an open task", () => {
  const places: Route[] = [
    { view: "projects", path: [], params: { board: "1" } },
    { view: "projects", path: [], params: { board: "1", in: "kite-app" } },
    { view: "projects", path: [], params: { board: "1", task: "t-1a2b3c" } },
    { view: "projects", path: [], params: { board: "1", in: "kite-app", task: "t-1a2b3c" } },
  ];
  for (const r of places) assert.deepEqual(fromPath(toPath(r, VIEWS), VIEWS), r, toPath(r, VIEWS));
  assert.equal(toPath(places[0]!, VIEWS), "projects/~board");
  assert.equal(toPath(places[2]!, VIEWS), "projects/~board/-/t-1a2b3c");
  // bb encodes the sub-path once more: the board still lands
  assert.equal(canonical(`projects/~board/${encodeURIComponent(encodeURIComponent("kite-app"))}/${encodeURIComponent(encodeURIComponent("t-1a2b3c"))}`, VIEWS), "projects/~board/kite-app/t-1a2b3c");
  assert.equal(canonical("projects/%7Eboard", VIEWS), "projects/~board");
});

test("no project slug can be the board or its every-project marker", () => {
  assert.ok(!PROJECT_RE.test(BOARD));
  assert.ok(!PROJECT_RE.test("-"));
  assert.deepEqual(fromPath("projects/board", VIEWS), { view: "projects", path: ["board"], params: {} }, "a project named board is still its own page");
});

test("the board refetches only on a change to what it reads (change-notice.ts READS.workBoard)", () => {
  const touchesBoard = (n: unknown) => touches(n, "workBoard");
  assert.equal(touchesBoard({}), true, "a notice that names nothing: refetch");
  assert.equal(touchesBoard(null), true);
  assert.equal(touchesBoard({ tables: null }), true, "a change that can't be named: refetch");
  // a hand move writes tasks; a PR linked to a task writes task_prs; the rest is what a card shows
  for (const t of ["tasks", "task_prs", "decisions", "deliverables", "prs", "pr_readings", "status", "lead_status", "spawns"]) assert.equal(touchesBoard({ tables: [t] }), true, t);
  for (const t of ["task_moves", "inbox_entries", "rules", "xp", "outputs", "multiplayer_beats"]) assert.equal(touchesBoard({ tables: [t] }), false, t);
  const src = readFileSync(new URL("../app/work-board.tsx", import.meta.url), "utf8");
  assert.match(src, /if \(!touches\(n, "workBoard"\)\) return;/, "the board's listener uses the shared read map, so it can't drift from the server's");
});

test("the why line drops record ids: the owner reads words, the chips name the things", () => {
  const card = ["d", "20000101T000000Z", "abc123"].join("-"); // a made-up card id, built so no id sits in the source
  assert.equal(whyText(`card ${card} waits on the owner`), "card waits on the owner");
  assert.equal(whyText("deliverable v-6029956225bb in review"), "deliverable in review");
  assert.equal(whyText("PR #12 waits on CI"), "PR #12 waits on CI");
  assert.equal(whyText("staging is down"), "staging is down");
});

test("a drag changes only the dragged card until the drop: no React state, no other element written", () => {
  const src = readFileSync(new URL("../app/work-board-drag.ts", import.meta.url), "utf8");
  assert.doesNotMatch(src, /useState|setState|useReducer|dispatch\(/, "a re-render per pointer move would restyle the page");
  const writes = [...src.matchAll(/\b([a-zA-Z_.]+)\.(?:style\.[a-zA-Z]+|style\.cssText|textContent|className|classList|dataset\.[a-zA-Z]+|setAttribute)\s*(?:\+?=|\()/g)].map((m) => m[1]);
  assert.ok(writes.length > 0);
  assert.deepEqual([...new Set(writes)].sort(), ["card", "label"], "only the card and the label inside it");
  const board = readFileSync(new URL("../app/work-board.tsx", import.meta.url), "utf8");
  assert.match(board, /<span className="drop" data-drop-label="" aria-hidden="true" \/>/, "the label is the card's own, always mounted");
});

test('"only cards that moved" keeps exactly the cards that moved since T, in their own columns; off, it hides nothing', () => {
  const b = boardOf([task("t-1", "kite", "planned"), task("t-2", "kite", "waiting"), task("t-3", "pine", "shipped", { since: 9 }), task("t-4", "pine", "shipped", { since: 5 }), task("t-5", "kite", "in_review")]);
  const moved: BoardLens["moved"] = {
    "t-3": { from: "in_review", to: "shipped", at: 9, isNew: false },
    "t-4": { from: "in_review", to: "shipped", at: 5, isNew: false },
    "t-1": { from: null, to: "planned", at: 4, isNew: true },
    "t-gone": { from: "planned", to: "dropped", at: 3, isNew: false },
  };
  const ids = (cols: ReturnType<typeof columnsOf>) => cols.flatMap((c) => c.tasks.map((t) => `${c.column}:${t.id}`));
  const only = columnsOf(b, null, { since: 1, moved, onlyMoved: true });
  assert.deepEqual(ids(only), ["planned:t-1", "shipped:t-3", "shipped:t-4"], "the moved cards, sorted as ever; a dropped task has no card to show");
  assert.deepEqual(only.map((c) => c.tasks.length), [1, 0, 0, 0, 0, 2], "the column counts are the filtered ones");
  assert.equal(firstColumn(only), "planned", "a phone opens on a column that has a moved card");
  assert.deepEqual(ids(columnsOf(b, "pine", { since: 1, moved, onlyMoved: true })), ["shipped:t-3", "shipped:t-4"], "the project filter still applies");
  assert.deepEqual(ids(columnsOf(b, null, { since: 1, moved, onlyMoved: false })), ids(columnsOf(b, null)), "with the toggle off the lens hides nothing");
});

test("a picked count pill shows exactly the tasks it counted, in their own columns, over \"only cards that moved\"", () => {
  const b = boardOf([task("t-1", "kite", "planned"), task("t-2", "kite", "waiting"), task("t-3", "pine", "shipped", { since: 9 }), task("t-4", "pine", "planned"), task("t-5", "kite", "in_review")]);
  const moved: BoardLens["moved"] = { "t-3": { from: "in_review", to: "shipped", at: 9, isNew: false }, "t-4": { from: "blocked", to: "planned", at: 8, isNew: false }, "t-1": { from: null, to: "planned", at: 4, isNew: true } };
  const ids = (cols: ReturnType<typeof columnsOf>) => cols.flatMap((c) => c.tasks.map((t) => `${c.column}:${t.id}`));
  // "blocked" counted t-4, blocked on Saturday and back in Planned now: the pill shows it where it is
  const blocked = columnsOf(b, null, { since: 1, moved, onlyMoved: false, pick: { key: "blocked", ids: ["t-4"] } });
  assert.deepEqual(ids(blocked), ["planned:t-4"]);
  assert.deepEqual(blocked.map((c) => c.tasks.length), [1, 0, 0, 0, 0, 0], "the column counts are the pill's");
  assert.deepEqual(ids(columnsOf(b, null, { since: 1, moved, onlyMoved: true, pick: { key: "shipped", ids: ["t-3"] } })), ["shipped:t-3"], "the pill wins over the toggle");
  assert.deepEqual(ids(columnsOf(b, "kite", { since: 1, moved, onlyMoved: false, pick: { key: "shipped", ids: ["t-3"] } })), [], "the project filter still applies");
  assert.deepEqual(ids(columnsOf(b, null, { since: 1, moved, onlyMoved: true, pick: null })), ["planned:t-1", "planned:t-4", "shipped:t-3"], "no pill: the toggle as before");
});

test("a phone showing a column with none of a picked pill's cards moves to one that has them; one that has them stays (Codex's review)", () => {
  const b = boardOf([task("t-1", "kite", "planned"), task("t-2", "kite", "shipped"), task("t-3", "pine", "shipped"), task("t-4", "pine", "waiting")]);
  const lens = (key: string, ids: string[]): BoardLens => ({ since: 1, moved: {}, onlyMoved: false, pick: { key, ids } });
  // Planned picked by hand, then "2 shipped": Planned holds none of them, so the board shows Shipped and its 2 cards
  const shipped = columnsOf(b, null, lens("shipped", ["t-2", "t-3"]));
  const at = columnAfterPick("planned", shipped) ?? firstColumn(shipped);
  assert.equal(at, "shipped");
  assert.equal(shipped.find((c) => c.column === at)!.tasks.length, 2, "the column shown holds the pill's cards");
  assert.equal(columnAfterPick("shipped", shipped), "shipped", "a column holding some of them stays as picked");
  assert.equal(columnAfterPick(null, shipped), null, "nothing picked by hand: the first column with cards, as before");
  const src = readFileSync(new URL("../app/work-board.tsx", import.meta.url), "utf8");
  assert.match(src, /if \(pickNow !== pickWas\) \{\n\s+setPickWas\(pickNow\);\n\s+setPicked\(columnAfterPick\(picked, cols\)\);/, "checked only when the pill changes, so a tap on an empty column still shows it");
});

test("the since header sits at one place whether or not the board has loaded; a new T keeps the last board up, and says so if its read fails", () => {
  const src = readFileSync(new URL("../app/work-board.tsx", import.meta.url), "utf8");
  assert.equal(src.match(/\{top\((?:place\.project|project)\)\}/g)?.length, 2, "both returns draw the same top row, so the header is not remounted when the read lands");
  assert.match(src, /data: q\.data \?\? last\.current/, "a new T would otherwise blank the board and unmount the header");
  assert.match(src, /board && q\.error \? \(\s*<span[^>]*data-board-stale=""[\s\S]*?onClick=\{\(\) => void q\.refetch\(\)\}/, "a failed read under a kept board says so in the header, with a retry");
});
