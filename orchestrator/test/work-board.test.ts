// The work board's data (SCOPE st-070570dd pieces 1 and 3). The owner reads the board to see what is in flight, shipped
// and waiting on them across projects, so:
// - a card must be one task for its whole life (rewording keeps it; plans are partly replaced, not only reworded);
// - its column must come from what is attached (threads, PRs, deliverables, cards), with the agreed precedence, never
//   from a guess: a vacuous "everything merged" is not Shipped, and a PR merged after its thread retired still is;
// - a step that leaves the plan is never lost: dropped quietly when nothing hangs on it, else its attachments go to
//   Unfiled and the CoS is shown it, and the same title coming back finds its old card;
// - every column change is logged once (thread 3 counts these), and the upgrade logs none.
import assert from "node:assert/strict";
import { test } from "node:test";
import { DatabaseSync } from "node:sqlite";
import { Engine, type PrResult } from "../core/engine.ts";
import { migrate, MIGRATIONS } from "../core/db.ts";
import { statusParams } from "../core/status.ts";
import { deriveColumn, settleColumns } from "../core/work-board.ts";
import { prune } from "../core/retention.ts";
import { ADDRESS_TASK_ONE, linkPr } from "../core/tasks.ts";
import type { BoardTask } from "../contract.ts";
import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { mkdtempSync } from "node:fs";

const T0 = Date.parse("2026-11-23T10:00:00Z");
const MIN = 60_000;
const scratch = mkdtempSync(join(tmpdir(), "work-board-"));
mkdirSync(join(scratch, "lead"), { recursive: true });
const shot = join(scratch, "lead", "shot.png");
writeFileSync(shot, "png");
const place = { roots: [{ path: join(scratch, "lead"), hostId: "host-1" }] };
const proof = [{ kind: "image" as const, caption: "the screen", path: shot }];
const opts = [{ label: "Go" }, { label: "Not now" }];

function setup() {
  const clock = { t: T0 };
  const db = new DatabaseSync(":memory:");
  const e = new Engine(db as never, { now: () => clock.t, deliver: async () => ({ delivery: "sent" }), mirror: () => {}, changed: () => {}, log: () => {} }, { owner: "Robin", batchInbox: false });
  const cos = e.register("T-cos", "cos", null);
  const lead = e.register("T-lead", "lead", "demo");
  const publish = (steps: unknown, extra: Record<string, unknown> = {}) => e.publishStatus(lead, statusParams.parse({ goal: "Ship the demo", steps, ...extra }));
  const board = () => e.workBoard({ project: "demo" }).projects[0]!;
  const task = (id: string) => board().tasks.find((t) => t.id === id) as BoardTask;
  const moves = () => (db.prepare(`SELECT task, from_col, to_col, by, why FROM task_moves ORDER BY seq`).all() as object[]).map((r) => ({ ...r })) as { task: string; from_col: string | null; to_col: string; by: string; why: string }[];
  /** A plan card the owner said go to, and the thread it starts (on `task`, when given). */
  const spawn = (threadId: string, task?: string) => {
    const plan = e.ask(lead, { title: "Start a thread?", question: "Start one thread?", options: opts, kind: "plan", threads: 1, ...(task ? { task } : {}) });
    e.triageAskPerson(cos, plan.id, { question: "Start one thread?", options: [], allowText: true });
    e.personAnswer(plan.id, e.decision(plan.id)!.rev, "1", null, "desktop");
    e.confirmSpawn(e.reserveSpawn(lead, plan.id), threadId);
    return e.register(threadId, "thread", "demo", "T-lead");
  };
  return { e, db, cos, lead, clock, publish, board, task, moves, spawn, at: (m: number) => (clock.t = T0 + m * MIN) };
}

const pr = (state: string, n = 7, checks = "passing"): PrResult => ({ outcome: "available", pullRequest: { url: `https://github.com/o/r/pull/${n}`, number: n, state, checks: { state: checks } } } as PrResult);

test("each step gets a task id, listed back to the lead; a reworded step sent with its id stays one card", () => {
  const s = setup();
  const st = s.publish([{ title: "Schema", state: "current" }, { title: "Engine", state: "next" }]);
  const [a, b] = st.steps.map((x) => x.id!);
  assert.match(a!, /^t-[0-9a-f]{6}$/);
  assert.notEqual(a, b);
  s.at(5);
  const again = s.publish([{ id: a, title: "Schema and migration", state: "current" }, { title: "engine!", state: "next" }]);
  assert.deepEqual(again.steps.map((x) => x.id), [a, b], "the id keeps the reworded step, and a title matches with case and punctuation ignored");
  const tasks = s.board().tasks;
  assert.equal(tasks.length, 2, "one card per step, not a new card for the reworded one");
  assert.equal(tasks[0]!.title, "Schema and migration");
  const stored = s.e.leadStatus("demo")!;
  assert.deepEqual(stored.steps.map((x) => x.id), [a, b], "the stored status carries the ids, so a publish without steps keeps them");
});

test("a reworded step sent without its id is a new card (why the reply and the prompt ask for ids)", () => {
  const s = setup();
  const [a] = s.publish([{ title: "Schema", state: "current" }]).steps.map((x) => x.id!);
  const [b] = s.publish([{ title: "Schema and migration", state: "current" }]).steps.map((x) => x.id!);
  assert.notEqual(a, b);
  assert.equal(s.db.prepare(`SELECT state FROM tasks WHERE id = ?`).get(a!)!.state, "dropped");
});

test("the same title twice in one update is refused, and so is an id that isn't one of the project's tasks", () => {
  const s = setup();
  assert.throws(() => s.publish([{ title: "Ship it", state: "current" }, { title: "ship  IT.", state: "next" }]), /same title once case, spacing and punctuation are ignored/);
  const other = s.e.register("T-lead2", "lead", "other");
  const [theirs] = s.e.publishStatus(other, statusParams.parse({ goal: "g", steps: [{ title: "Theirs", state: "next" }] })).steps;
  assert.throws(() => s.publish([{ id: theirs!.id, title: "Mine", state: "next" }]), /is a task of other, not demo/);
  assert.throws(() => s.publish([{ id: "t-000000", title: "Mine", state: "next" }]), /is no task of demo/);
  assert.equal(s.db.prepare(`SELECT COUNT(*) AS c FROM tasks WHERE project = 'demo'`).get()!.c, 0, "a refused publish creates nothing");
});

test("a publish without steps (only what the lead waits on) leaves the tasks alone", () => {
  const s = setup();
  const [a] = s.publish([{ title: "Schema", state: "current" }]).steps.map((x) => x.id!);
  s.e.publishStatus(s.lead, statusParams.parse({ waiting_on: { kind: "ci" } }));
  assert.equal(s.e.leadStatus("demo")!.steps[0]!.id, a);
  assert.equal(s.board().tasks.length, 1);
});

test("a current step with no thread is In progress; a next step with nothing attached is Planned, never vacuously Shipped", () => {
  const s = setup();
  const [a, b] = s.publish([{ title: "Build", state: "current" }, { title: "Polish", state: "next" }]).steps.map((x) => x.id!);
  assert.equal(s.task(a!).column, "in_progress");
  assert.equal(s.task(a!).why, "the lead's current step");
  assert.equal(s.task(b!).column, "planned", "no PRs and no deliverables is not 'all merged'");
});

test("a thread started from a plan card's task attaches to it, and its card and PR follow it; the owner's card means Waiting on you", () => {
  const s = setup();
  const [a, b] = s.publish([{ title: "Build", state: "next" }, { title: "Polish", state: "next" }]).steps.map((x) => x.id!);
  const t = s.spawn("T-1", "polish");
  assert.equal(s.db.prepare(`SELECT task FROM spawns WHERE thread_id = 'T-1'`).get()!.task, b, "the plan named the task by title; its thread got it");
  assert.equal(s.task(b!).column, "in_progress");
  assert.deepEqual(s.task(b!).threads.map((x) => x.address), [t.address]);
  assert.equal(s.task(a!).threads.length, 0);
  // the thread's question, filed up by its lead to the owner: it inherits the thread's task through its origin
  const q = s.e.ask(t, { title: "Which colour?", question: "Red or blue?", options: opts });
  s.e.forward(s.lead, q.id, null, null);
  s.e.triageAskPerson(s.cos, q.id, { question: "Red or blue?", options: opts, allowText: true });
  const card = s.task(b!);
  assert.equal(card.column, "waiting");
  assert.equal(card.cards.find((c) => c.id === q.id)?.ownerWaits, true);
  assert.match(card.why, /waits on the owner/);
  // the answer releases it back to the thread's own state
  s.e.personAnswer(q.id, s.e.decision(q.id)!.rev, "1", null, "desktop");
  assert.equal(s.task(b!).column, "in_progress");
});

test("orch_ask and orch_deliver take a task; without one a lead's goes to Unfiled", () => {
  const s = setup();
  const [a] = s.publish([{ title: "Report", state: "current" }]).steps.map((x) => x.id!);
  const named = s.e.ask(s.lead, { title: "Send it?", question: "Send the report?", options: opts, task: a });
  const loose = s.e.ask(s.lead, { title: "Lunch?", question: "Lunch?", options: opts });
  const d = s.e.deliver(s.lead, { title: "The report", summary: "Done.", proof, task: "report" }, place);
  const free = s.e.deliver(s.lead, { title: "Other", summary: "Done.", proof }, place);
  const p = s.board();
  assert.deepEqual(p.tasks[0]!.cards.map((c) => c.id), [named.id]);
  assert.deepEqual(p.tasks[0]!.deliverables.map((x) => x.id), [d.id]);
  assert.deepEqual(p.unfiled.cards.map((c) => c.id), [loose.id]);
  assert.deepEqual(p.unfiled.deliverables.map((x) => x.id), [free.id]);
  assert.equal(p.tasks[0]!.column, "waiting", "a deliverable in the owner's review is Waiting on you");
  // a revision keeps its task without naming it again
  s.e.personRequestChanges(d.id, 1, "Shorter, please");
  s.e.deliver(s.lead, { title: "The report", summary: "Shorter.", proof, revises: d.id }, place);
  assert.deepEqual(s.board().tasks[0]!.deliverables.map((x) => x.id), [d.id]);
  assert.throws(() => s.e.ask(s.lead, { title: "Q?", question: "Q?", options: opts, task: "no such step" }), /has no task "no such step"; its open tasks: t-/);
});

test("an owner approval is Shipped at its feedback time, even while the step is still current", () => {
  const s = setup();
  const [a] = s.publish([{ title: "Report", state: "current" }]).steps.map((x) => x.id!);
  const d = s.e.deliver(s.lead, { title: "The report", summary: "Done.", proof, task: a }, place);
  s.at(40);
  s.e.personApprove(d.id, 1, null);
  const t = s.task(a!);
  assert.equal(t.column, "shipped");
  assert.equal(t.since, Date.parse(s.e.deliverable(d.id)!.feedback.at(-1)!.at), "dated by the owner's approval, not by the next read");
  assert.equal(t.since, T0 + 40 * MIN);
});

test("a PR merged after its thread retired is Shipped (the thread stays attached; the merge comes from a later reading)", () => {
  const s = setup();
  const [a] = s.publish([{ title: "Build", state: "current" }]).steps.map((x) => x.id!);
  s.spawn("T-1", a);
  s.e.setEnvironment("T-1", "E1");
  s.at(5);
  s.e.prSeen(s.e.agentByThread("T-1")!, "E1", pr("open"));
  assert.equal(s.task(a!).column, "in_review", "an open PR waits on someone else");
  s.at(10);
  s.e.retire("T-1");
  assert.equal(s.task(a!).column, "in_review", "the retired thread's PR still holds the task");
  // bb no longer reads the PR (its environment is gone): a PR wait's own gh reading sees the merge
  s.at(60);
  s.e.waitPrSeen(pr("merged"));
  const t = s.task(a!);
  assert.equal(t.column, "shipped");
  assert.equal(t.why, "PR #7 merged");
  assert.equal(t.since, T0 + 60 * MIN);
  assert.equal(t.threads[0]!.live, false);
  // a closed PR alone ships nothing
  const [b] = s.publish([{ id: a, title: "Build", state: "current" }, { title: "Try B", state: "next" }]).steps.slice(1).map((x) => x.id!);
  s.spawn("T-2", b);
  s.e.setEnvironment("T-2", "E2");
  s.e.prSeen(s.e.agentByThread("T-2")!, "E2", pr("closed", 8));
  s.e.retire("T-2");
  assert.equal(s.task(b!).column, "planned");
});

test("a dropped step with nothing attached goes quietly; one with attachments sends them to Unfiled and is shown for the CoS", () => {
  const s = setup();
  const [a, b, c] = s.publish([{ title: "Keep", state: "current" }, { title: "Idea", state: "next" }, { title: "Spike", state: "next" }]).steps.map((x) => x.id!);
  const t = s.spawn("T-1", c);
  const q = s.e.ask(s.lead, { title: "Spike scope?", question: "How big?", options: opts, task: c });
  s.at(5);
  s.publish([{ id: a, title: "Keep", state: "current" }]);
  const p = s.board();
  assert.deepEqual(p.tasks.map((x) => x.id), [a]);
  assert.deepEqual(p.dropped.map((x) => x.id), [c], "only the drop with attachments reaches the CoS; the idea goes quietly");
  assert.deepEqual(p.dropped[0]!.unfiled, { threads: ["T-1"], deliverables: [], cards: [q.id] });
  assert.deepEqual(p.unfiled.threads.map((x) => x.address), [t.address], "its live thread is in Unfiled now");
  assert.deepEqual(p.unfiled.cards.map((x) => x.id), [q.id]);
  const rows = s.db.prepare(`SELECT id, state, dropped_at, unfiled FROM tasks WHERE id IN (?, ?) ORDER BY id = ?`).all(b!, c!, b!) as { id: string; state: string; dropped_at: number; unfiled: string | null }[];
  assert.deepEqual(rows.map((r) => [r.id, r.state, r.dropped_at, r.unfiled === null]), [[c, "dropped", T0 + 5 * MIN, false], [b, "dropped", T0 + 5 * MIN, true]]);
  assert.deepEqual(s.moves().filter((m) => m.to_col === "dropped").map((m) => [m.task, m.why]), [[b, "dropped"], [c, "dropped with attachments"]]);
});

test("a done step goes to Shipped and stays on the board after it leaves the list", () => {
  const s = setup();
  const [a, b] = s.publish([{ title: "First", state: "current" }, { title: "Second", state: "next" }]).steps.map((x) => x.id!);
  s.at(5);
  s.publish([{ id: a, title: "First", state: "done" }, { id: b, title: "Second", state: "current" }]);
  s.at(6);
  s.publish([{ id: b, title: "Second", state: "current" }]);
  const t = s.task(a!);
  assert.equal(t.state, "shipped");
  assert.equal(t.column, "shipped");
  assert.equal(t.since, T0 + 5 * MIN);
  assert.equal(t.step, null, "it left the step list");
  assert.equal(s.db.prepare(`SELECT state FROM tasks WHERE id = ?`).get(a!)!.state, "shipped", "never dropped");
});

test("a re-added title finds its old id, and what its drop moved to Unfiled comes back with it", () => {
  const s = setup();
  const [a, b] = s.publish([{ title: "Keep", state: "current" }, { title: "Spike: auth", state: "next" }]).steps.map((x) => x.id!);
  s.spawn("T-1", b);
  s.publish([{ id: a, title: "Keep", state: "current" }]);
  assert.equal(s.board().dropped.length, 1);
  s.at(9);
  const back = s.publish([{ id: a, title: "Keep", state: "current" }, { title: "spike — auth", state: "next" }]);
  assert.equal(back.steps[1]!.id, b);
  const p = s.board();
  assert.equal(p.dropped.length, 0);
  assert.deepEqual(s.task(b!).threads.map((x) => x.threadId), ["T-1"]);
  assert.equal(p.unfiled.threads.length, 0);
});

test("a re-added title comes back only within 14 days (the since picker's reach); a generic title dropped longer ago is a new task", () => {
  const s = setup();
  const [a, qa, rel] = s.publish([{ title: "Keep", state: "current" }, { title: "QA", state: "next" }, { title: "Release", state: "next" }]).steps.map((x) => x.id!);
  s.spawn("T-old", qa);
  s.publish([{ id: a, title: "Keep", state: "current" }, { id: rel, title: "Release", state: "next" }]);
  s.at(14 * 24 * 60 + 1);
  s.publish([{ id: a, title: "Keep", state: "current" }]);
  // QA was dropped 14 days and a minute ago, Release just now: only Release can come back by title
  const back = s.publish([{ id: a, title: "Keep", state: "current" }, { title: "QA", state: "next" }, { title: "release", state: "next" }]);
  const [, qa2, rel2] = back.steps.map((x) => x.id!);
  assert.notEqual(qa2, qa, "a stale QA task and its old thread don't come back under a generic title");
  assert.equal(rel2, rel, "a recent drop still comes back");
  assert.equal(s.db.prepare(`SELECT state FROM tasks WHERE id = ?`).get(qa!)!.state, "dropped");
  assert.deepEqual(s.task(qa2!).threads, [], "the new task starts empty");
  assert.deepEqual(s.board().unfiled.threads.map((x) => x.threadId), ["T-old"], "the old thread stays in Unfiled");
  // an explicit id is deliberate: it still brings back a dropped task of any age
  const byId = s.publish([{ id: a, title: "Keep", state: "current" }, { id: qa, title: "QA (old)", state: "next" }, { id: rel, title: "release", state: "next" }]);
  assert.equal(byId.steps[1]!.id, qa);
  assert.deepEqual(s.task(qa!).threads.map((x) => x.threadId), ["T-old"]);
});

test("a skipped step left in the list comes back by its title only within 14 days too; while still skipped it keeps its id (Codex review of f26e3db)", () => {
  const s = setup();
  const [a, qa] = s.publish([{ title: "Keep", state: "current" }, { title: "QA", state: "next" }]).steps.map((x) => x.id!);
  s.spawn("T-old", qa);
  s.publish([{ id: a, title: "Keep", state: "current" }, { id: qa, title: "QA", state: "skipped" }]);
  s.at(15 * 24 * 60);
  // the lead re-sends its list without ids, QA still skipped: the same task, nothing new
  const still = s.publish([{ title: "Keep", state: "current" }, { title: "QA", state: "skipped" }]);
  assert.deepEqual(still.steps.map((x) => x.id), [a, qa], "a still-skipped step keeps its task at any age, so no-id re-sends create nothing");
  assert.equal(s.db.prepare(`SELECT COUNT(*) AS c FROM tasks`).get()!.c, 2);
  // QA planned again without its id, 15 days after the skip: a new task, the old one and its thread stay put
  const back = s.publish([{ title: "Keep", state: "current" }, { title: "QA", state: "next" }]);
  const qa2 = back.steps[1]!.id!;
  assert.notEqual(qa2, qa, "a skip 15 days old doesn't come back by title through the stored list");
  assert.equal(s.db.prepare(`SELECT state FROM tasks WHERE id = ?`).get(qa!)!.state, "dropped");
  assert.deepEqual(s.task(qa2).threads, []);
  assert.deepEqual(s.board().unfiled.threads.map((x) => x.threadId), ["T-old"]);
});

test("a skipped step left in the list and planned again within 14 days is its old task, with its thread", () => {
  const s = setup();
  const [a, qa] = s.publish([{ title: "Keep", state: "current" }, { title: "QA", state: "next" }]).steps.map((x) => x.id!);
  s.spawn("T-1", qa);
  s.publish([{ id: a, title: "Keep", state: "current" }, { id: qa, title: "QA", state: "skipped" }]);
  s.at(13 * 24 * 60);
  const back = s.publish([{ title: "Keep", state: "current" }, { title: "QA", state: "next" }]);
  assert.equal(back.steps[1]!.id, qa);
  assert.deepEqual(s.task(qa!).threads.map((x) => x.threadId), ["T-1"]);
});

test("a skipped step is a drop: quiet with nothing attached, Unfiled and shown for the CoS with attachments; it stays in the list", () => {
  const s = setup();
  const [a, b, c] = s.publish([{ title: "Keep", state: "current" }, { title: "Idea", state: "next" }, { title: "Spike", state: "next" }]).steps.map((x) => x.id!);
  const t = s.spawn("T-1", c);
  s.at(5);
  const out = s.publish([{ id: a, title: "Keep", state: "current" }, { id: b, title: "Idea", state: "skipped" }, { id: c, title: "Spike", state: "skipped" }]);
  assert.deepEqual(out.steps.map((x) => x.id), [a, b, c], "the skipped steps keep their ids in the list");
  const p = s.board();
  assert.deepEqual(p.tasks.map((x) => x.id), [a]);
  assert.deepEqual(p.dropped.map((x) => x.id), [c], "only the skip with attachments reaches the CoS");
  assert.deepEqual(p.unfiled.threads.map((x) => x.address), [t.address]);
  assert.deepEqual(s.moves().filter((m) => m.to_col === "dropped").map((m) => [m.task, m.why]), [[b, "dropped"], [c, "dropped with attachments"]]);
});

test("moves are logged once per column change, with who and why; a read writes nothing", () => {
  const s = setup();
  const [a] = s.publish([{ title: "Build", state: "next" }]).steps.map((x) => x.id!);
  assert.deepEqual(s.moves(), [{ task: a, from_col: null, to_col: "planned", by: "lead:demo", why: "planned" }]);
  s.publish([{ id: a, title: "Build", state: "current" }]);
  s.spawn("T-1", a);
  s.e.setEnvironment("T-1", "E1");
  s.e.prSeen(s.e.agentByThread("T-1")!, "E1", pr("open", 7, "pending"));
  const before = s.moves().length;
  s.board();
  s.e.workBoard({});
  assert.equal(s.moves().length, before, "the RPC read logs nothing (live probes may call it)");
  s.at(3);
  assert.equal(s.e.settleBoard(), 1);
  assert.equal(s.e.settleBoard(), 0, "nothing moved since");
  assert.deepEqual(s.moves().map((m) => [m.from_col, m.to_col, m.by]), [
    [null, "planned", "lead:demo"],
    ["planned", "in_progress", "lead:demo"],
    ["in_progress", "in_review", "engine"],
  ]);
  assert.equal(s.moves().at(-1)!.why, "PR #7 waits on CI");
});

test("a hand move holds while the attachments' signature is the one stored with it, and lets go when anything changes", () => {
  const s = setup();
  const [a] = s.publish([{ title: "Build", state: "current" }]).steps.map((x) => x.id!);
  s.spawn("T-1", a);
  const sig = s.task(a!).sig;
  s.db.prepare(`UPDATE tasks SET hand_col = 'blocked', hand_at = ?, hand_sig = ? WHERE id = ?`).run(T0, sig, a!);
  assert.equal(s.task(a!).column, "blocked");
  assert.equal(s.task(a!).derived, "in_progress");
  s.e.setStatus("T-1", "active");
  const t = s.task(a!);
  assert.equal(t.column, "in_progress", "the thread started working: the hold is over");
  assert.equal(t.hand!.holds, false);
});

test("the lead's blockers land on its current step; a failed thread blocks its own task", () => {
  const s = setup();
  const [a, b] = s.publish([{ title: "Build", state: "current" }, { title: "Docs", state: "next" }], { blockers: ["staging is down"] }).steps.map((x) => x.id!);
  assert.equal(s.task(a!).column, "blocked");
  assert.equal(s.task(a!).why, "staging is down");
  assert.equal(s.task(b!).column, "planned");
  s.spawn("T-1", b);
  s.e.setStatus("T-1", "error");
  assert.equal(s.task(b!).column, "blocked");
});

test("precedence: Shipped over Waiting on you over Blocked over In review over In progress", () => {
  const base = { state: "open" as const, shippedAt: null, step: "current" as const, blockers: ["x"], statusAt: 1, threads: [], deliverables: [] };
  const open = { url: "u1", number: 1, state: "open", checks: null, review: null, attention: null, wait: null, at: 5, thread: null, source: "orchestrator" as const };
  const card = { id: "d-1", title: "q", level: "person", state: "asked", askedAt: 3, ownerWaits: true, deferred: false, held: false };
  assert.equal(deriveColumn({ ...base, prs: [{ ...open, state: "merged" }], cards: [card] }).column, "shipped");
  assert.equal(deriveColumn({ ...base, prs: [open], cards: [card] }).column, "waiting");
  assert.equal(deriveColumn({ ...base, prs: [open], cards: [] }).column, "blocked");
  assert.equal(deriveColumn({ ...base, blockers: [], prs: [open], cards: [] }).column, "in_review");
  assert.equal(deriveColumn({ ...base, blockers: [], prs: [{ ...open, state: "draft" }], cards: [] }).column, "in_progress");
});

test("the upgrade turns each project's current steps into tasks: done ones Shipped undated, threads its waits name on its step, no moves logged", () => {
  const db = new DatabaseSync(":memory:");
  const at = MIGRATIONS.findIndex((m) => m.startsWith("CREATE TABLE tasks ("));
  // Found by content, not position: later migrations may sit between these. 1.42.0's read indexes were main's last.
  for (const shipped of [/^CREATE TABLE slack_watch_profiles/, /^CREATE INDEX IF NOT EXISTS board_at ON board/]) {
    const i = MIGRATIONS.findIndex((m) => shipped.test(m));
    assert.ok(i >= 0 && at > i, `appended after the shipped migration ${shipped}, never inserted before it`);
  }
  db.exec(`CREATE TABLE _migrations (id INTEGER PRIMARY KEY)`);
  MIGRATIONS.slice(0, at).forEach((sql, i) => {
    db.exec(sql);
    db.prepare(`INSERT INTO _migrations (id) VALUES (?)`).run(i);
  });
  const ins = db.prepare(`INSERT INTO agents (thread_id, address, role, project, status, created_at) VALUES (?, ?, ?, ?, ?, 1)`);
  db.prepare(`INSERT INTO projects (slug, created_at) VALUES ('demo', 1)`).run();
  ins.run("T-lead", "lead:demo", "lead", "demo", "idle");
  ins.run("T-1", "thread:demo:1", "thread", "demo", "active");
  ins.run("T-2", "thread:demo:2", "thread", "demo", "idle");
  ins.run("T-3", "thread:demo:3", "thread", "demo", "idle");
  db.prepare(`INSERT INTO prs (environment_id, thread_id, url, number, state, sig, seen_at) VALUES ('E3', 'T-3', 'https://github.com/o/r/pull/9', 9, 'open', 'x', 1)`).run();
  const status = {
    goal: "g",
    steps: [{ title: "Old", state: "done" }, { title: "Now", state: "current" }, { title: "Later", state: "next" }],
    waitingOn: { kind: "thread", ref: "thread:demo:1", label: null },
    waits: [{ kind: "thread", ref: "thread:demo:1", label: null, who: null, since: 1 }, { kind: "pr", ref: "https://github.com/o/r/pull/9", label: null, who: null, since: 1 }],
    blockers: [],
    updatedAt: 1,
    by: "lead:demo",
  };
  db.prepare(`INSERT INTO lead_status (project, address, thread_id, json, updated_at) VALUES ('demo', 'lead:demo', 'T-lead', ?, 1)`).run(JSON.stringify(status));
  migrate(db as never);
  const tasks = db.prepare(`SELECT id, title, state, shipped_at, col FROM tasks ORDER BY rowid`).all() as { id: string; title: string; state: string; shipped_at: number | null; col: string }[];
  assert.deepEqual(tasks.map((t) => [t.title, t.state, t.shipped_at, t.col]), [["Old", "shipped", null, "shipped"], ["Now", "open", null, "in_review"], ["Later", "open", null, "planned"]]);
  const steps = (JSON.parse((db.prepare(`SELECT json FROM lead_status`).get() as { json: string }).json) as { steps: { id: string }[] }).steps;
  assert.deepEqual(steps.map((x) => x.id), tasks.map((t) => t.id), "the stored steps carry their ids");
  const spawns = db.prepare(`SELECT thread_id, task FROM spawns ORDER BY thread_id`).all() as { thread_id: string; task: string }[];
  assert.deepEqual(spawns.map((r) => [r.thread_id, r.task]), [["T-1", tasks[1]!.id], ["T-3", tasks[1]!.id]], "the thread the waits name, and the PR's holder, on the current step; T-2 stays Unfiled");
  assert.equal((db.prepare(`SELECT COUNT(*) AS c FROM task_moves`).get() as { c: number }).c, 0, "the upgrade logs no moves");
  const e = new Engine(db as never, { now: () => T0, deliver: async () => ({ delivery: "sent" }), mirror: () => {}, changed: () => {}, log: () => {} }, { owner: "Robin" });
  const p = e.workBoard({ project: "demo" }).projects[0]!;
  assert.deepEqual(p.unfiled.threads.map((x) => x.address), ["thread:demo:2"]);
  assert.equal(p.tasks[0]!.column, "shipped", "an undated Shipped task shows while it is still in the lead's list");
  assert.equal(e.settleBoard(), 0, "the first settle after the upgrade logs nothing that didn't move");
});

test("through the real plugin: orch_status's reply lists every step's id and asks for them back; the workBoard RPC returns the board", async () => {
  const plugin = (await import("../server.ts")).default;
  const { DatabaseSync: Sqlite } = await import("node:sqlite");
  const root = mkdtempSync(join(tmpdir(), "work-board-host-"));
  mkdirSync(join(root, "projects"));
  const db = Object.assign(new Sqlite(join(root, "data.db")), { name: join(root, "data.db") });
  const pre = new Engine(db as never, { now: Date.now, deliver: async () => ({ delivery: "sent" }), mirror: () => {}, changed: () => {}, log: () => {} });
  pre.register("T-lead", "lead", "demo");
  const noop: any = new Proxy(function () {}, { get: (_t, k) => (k === "then" ? undefined : noop), apply: () => noop });
  const tools = new Map<string, { parameters: { shape: Record<string, unknown> }; execute: (p: unknown, c: { threadId: string }) => Promise<{ content: { text: string }[] }> }>();
  const rpc: Record<string, (input: unknown) => unknown> = {};
  const bb: any = new Proxy(
    {},
    {
      get(_t, k) {
        if (k === "pluginId") return "orchestrator";
        if (k === "settings")
          return {
            define: (schema: Record<string, { default: unknown }>) => {
              const v: any = Object.fromEntries(Object.entries(schema).map(([key, d]) => [key, d.default]));
              Object.assign(v, { stateDir: join(root, "state"), projectsDir: join(root, "projects"), memoryConfig: "", diskPath: root });
              return { get: async () => v, onChange: () => {} };
            },
          };
        if (k === "storage") return { database: () => db, kv: noop };
        if (k === "agents") return { registerTool: (t: any) => tools.set(t.name, t), configure: () => {}, contributeInstructions: () => {} };
        if (k === "rpc") return { register: (_c: unknown, h: typeof rpc) => Object.assign(rpc, h) };
        if (k === "log") return { info: () => {}, warn: () => {}, error: () => {} };
        return noop;
      },
    },
  );
  await plugin(bb);
  const call = async (name: string, p: unknown) => (await tools.get(name)!.execute(p, { threadId: "T-lead" })).content[0]!.text;
  const out = await call("orch_status", { goal: "Ship", steps: [{ title: "Build", state: "current" }, { title: "Polish", state: "next", blocker: "needs a design" }] });
  const ids = [...out.matchAll(/(t-[0-9a-f]{6}) "(\w+)"/g)].map((m) => [m[1], m[2]]);
  assert.deepEqual(ids.map((x) => x[1]), ["Build", "Polish"], out);
  assert.match(out, /Send each step back with its id \(steps\[\]\.id\), also when you reword it/);
  assert.match(await call("orch_status", { steps: [{ title: "Same", state: "next" }, { title: "same!", state: "next" }] }), /same title once case, spacing and punctuation are ignored/);
  assert.ok("task" in tools.get("orch_ask")!.parameters.shape && "task" in tools.get("orch_deliver")!.parameters.shape, "plan cards, orch_ask and orch_deliver take a task");
  const board = (await rpc.workBoard!({ project: "demo" })) as { projects: { slug: string; tasks: { id: string; column: string }[] }[] };
  assert.deepEqual(board.projects[0]!.tasks.map((t) => [t.id, t.column]), [[ids[0]![0], "in_progress"], [ids[1]![0], "blocked"]], "the tool takes a step's blocker");
  rmSync(root, { recursive: true, force: true });
});

test("Unfiled holds only live things: a retired thread's last 'open' reading of a PR nobody reads any more stays off it", () => {
  const s = setup();
  s.publish([{ title: "Build", state: "current" }]);
  const t = s.e.register("T-9", "thread", "demo", "T-lead");
  s.e.setEnvironment("T-9", "E9");
  s.e.prSeen(t, "E9", pr("open", 12));
  assert.deepEqual(s.board().unfiled.prs.map((p) => p.number), [12], "a live thread's open PR, with no task: Unfiled");
  s.e.retire("T-9");
  const p = s.board();
  assert.deepEqual(p.unfiled.prs, [], "its thread retired: the reading is stale");
  assert.deepEqual(p.unfiled.threads, []);
});

test("a lead's publish logs only its own project's moves; another project's change waits for the engine's settle", () => {
  const s = setup();
  const [a] = s.publish([{ title: "Build", state: "current" }]).steps.map((x) => x.id!);
  s.spawn("T-1", a);
  s.e.setEnvironment("T-1", "E1");
  s.e.prSeen(s.e.agentByThread("T-1")!, "E1", pr("open", 7, "pending"));
  const other = s.e.register("T-lead2", "lead", "other");
  s.e.publishStatus(other, statusParams.parse({ goal: "g", steps: [{ title: "Theirs", state: "next" }] }));
  assert.deepEqual(s.moves().filter((m) => m.task === a).map((m) => m.to_col), ["in_progress"], "demo's PR change is not put down to the other lead");
  s.e.settleBoard();
  assert.deepEqual(s.moves().filter((m) => m.task === a).map((m) => [m.to_col, m.by]), [["in_progress", "lead:demo"], ["in_review", "engine"]]);
});

test("a lead on the old schema sends no ids: done steps stay the same Shipped tasks, and a done step marked current again reopens", () => {
  const s = setup();
  const first = s.publish([{ title: "Schema", state: "done" }, { title: "Engine", state: "current" }]).steps.map((x) => x.id!);
  const moves = s.moves().length;
  s.at(5);
  const again = s.publish([{ title: "Schema", state: "done" }, { title: "Engine", state: "current" }]).steps.map((x) => x.id!);
  assert.deepEqual(again, first, "no new Shipped card for a done step sent again without its id");
  assert.equal(s.db.prepare(`SELECT COUNT(*) AS c FROM tasks`).get()!.c, 2);
  assert.equal(s.moves().length, moves, "and nothing logged");
  const undone = s.publish([{ title: "schema", state: "current" }, { title: "Engine", state: "next" }]).steps.map((x) => x.id!);
  assert.deepEqual(undone, first);
  assert.equal(s.task(first[0]!).state, "open");
  // a task that shipped and left the list is not reopened by the same title later: that is new work
  s.publish([{ title: "Schema", state: "done" }, { title: "Engine", state: "current" }]);
  s.publish([{ title: "Engine", state: "current" }]);
  const later = s.publish([{ title: "Engine", state: "current" }, { title: "Schema", state: "next" }]).steps.map((x) => x.id!);
  assert.notEqual(later[1], first[0]);
  assert.equal(s.db.prepare(`SELECT state FROM tasks WHERE id = ?`).get(first[0]!)!.state, "shipped");
});

test("a merged PR with a live thread still on the task stays In progress until the thread is resolved; the lead's done ships it anyway", () => {
  const s = setup();
  const [a] = s.publish([{ title: "Activate behaviours", state: "current" }]).steps.map((x) => x.id!);
  s.spawn("T-1", a);
  s.e.setEnvironment("T-1", "E1");
  s.e.setStatus("T-1", "active");
  s.e.prSeen(s.e.agentByThread("T-1")!, "E1", pr("merged", 31));
  assert.equal(s.task(a!).column, "in_progress", "an older PR merged while the thread still works on the step");
  s.e.setStatus("T-1", "idle");
  assert.equal(s.task(a!).column, "in_progress", "an idle thread is still live: not shipped until it is resolved");
  s.e.retire("T-1");
  assert.equal(s.task(a!).column, "shipped", "resolved: now every attached PR is merged and nothing is live");
  const [b] = s.publish([{ id: a, title: "Activate behaviours", state: "current" }, { title: "Second", state: "next" }]).steps.slice(1).map((x) => x.id!);
  s.spawn("T-2", b);
  s.e.setStatus("T-2", "active");
  s.publish([{ id: a, title: "Activate behaviours", state: "current" }, { id: b, title: "Second", state: "done" }]);
  assert.equal(s.task(b!).column, "shipped", "the lead's done always ships, even with a live thread");
});

test("a step's own blocker marks its task Blocked, whichever step it is; the project's blockers still land on the current step", () => {
  const s = setup();
  const st = s.publish([{ title: "Build", state: "current" }, { title: "Deploy", state: "next", blocker: "  waiting for   the prod   key " }], { blockers: ["CI is red"] });
  const [a, b] = st.steps.map((x) => x.id!);
  assert.equal(st.steps[1]!.blocker, "waiting for the prod key", "kept on the stored step, one line");
  assert.deepEqual([s.task(a!).column, s.task(a!).why], ["blocked", "CI is red"]);
  assert.deepEqual([s.task(b!).column, s.task(b!).why], ["blocked", "waiting for the prod key"], "a next step can be blocked by its own blocker");
  // the step's blocker wins over the project's on the current step
  s.publish([{ id: a, title: "Build", state: "current", blocker: "the build box is down" }, { id: b, title: "Deploy", state: "next" }]);
  assert.equal(s.task(a!).why, "the build box is down");
  assert.equal(s.task(b!).column, "planned", "a step sent without its blocker is unblocked");
  assert.throws(() => s.publish([{ title: "Build", state: "current", blocker: "x".repeat(101) }]), /step 1's blocker is 101 characters; the cap is 100/);
});

test("a retired thread's PR merge stays known after the PR wait's reading is pruned (it is in the PR log, once)", () => {
  const s = setup();
  const [a] = s.publish([{ title: "Build", state: "current" }]).steps.map((x) => x.id!);
  s.spawn("T-1", a);
  s.e.setEnvironment("T-1", "E1");
  s.e.prSeen(s.e.agentByThread("T-1")!, "E1", pr("open"));
  s.e.retire("T-1");
  s.at(30);
  s.e.waitPrSeen(pr("merged"));
  s.e.waitPrSeen(pr("merged"));
  s.e.pruneWaitReadings(); // the same server pass: no open wait names the PR, so its reading goes
  assert.equal(s.db.prepare(`SELECT COUNT(*) AS c FROM pr_readings`).get()!.c, 0);
  const t = s.task(a!);
  assert.equal(t.column, "shipped", "not back to In review");
  assert.equal(t.since, T0 + 30 * MIN);
  const logged = s.db.prepare(`SELECT address, project, value FROM events WHERE kind = 'pr' AND value = 'merged'`).all().map((r) => ({ ...r }));
  assert.deepEqual(logged, [{ address: "thread:demo:1", project: "demo", value: "merged" }], "logged once, under the PR's holder");
});

test("a PR closed unmerged is superseded and ignored; a PR in an unknown or unread state keeps the task from shipping", () => {
  const s = setup();
  const [a, b] = s.publish([{ title: "One", state: "current" }, { title: "Two", state: "next" }]).steps.map((x) => x.id!);
  s.spawn("T-1", a);
  s.e.setEnvironment("T-1", "E1");
  s.e.prSeen(s.e.agentByThread("T-1")!, "E1", pr("closed", 7));
  s.e.prSeen(s.e.agentByThread("T-1")!, "E1", pr("merged", 8));
  s.e.retire("T-1");
  assert.equal(s.task(a!).column, "shipped", "one merged, one closed unmerged: shipped");
  s.spawn("T-2", b);
  s.e.setEnvironment("T-2", "E2");
  s.e.prSeen(s.e.agentByThread("T-2")!, "E2", pr("merged", 9));
  // a second PR of the thread whose state was never read (a row with no state)
  s.db.prepare(`INSERT INTO prs (environment_id, thread_id, url, number, state, sig, seen_at) VALUES ('E2', 'T-2', 'https://github.com/o/r/pull/10', 10, NULL, 'x', ?)`).run(T0);
  linkPr(s.db as never, "https://github.com/o/r/pull/10", b!, "bb", "thread:demo:2", T0); // as prSeen links it
  s.e.retire("T-2");
  assert.notEqual(s.task(b!).column, "shipped", "an unknown PR is not 'merged'");
});

test("a PR a thread reported but bb never read keeps its task from shipping, until a reading says merged (Codex review of 59c3987)", () => {
  const s = setup();
  const [a] = s.publish([{ title: "Build", state: "current" }]).steps.map((x) => x.id!);
  const t = s.spawn("T-1", a);
  s.e.setEnvironment("T-1", "E1");
  s.at(5);
  s.e.prSeen(s.e.agentByThread("T-1")!, "E1", pr("merged", 7)); // PR A: read, merged
  s.at(10);
  s.e.report(s.e.agentByThread("T-1")!, "Second PR", "the follow-up", "https://github.com/o/r/pull/8/"); // PR B: reported only
  s.e.prSeen(s.e.agentByThread("T-1")!, "E1", { outcome: "unavailable", message: "gh failed" } as PrResult); // B's fetch fails
  s.e.report(s.e.agentByThread("T-1")!, "Doc", "a link", "https://example.com/doc"); // not a PR: attaches nothing
  s.e.retire("T-1");
  const before = s.task(a!);
  assert.notEqual(before.column, "shipped", "PR B was never read: merged A alone must not ship the task");
  assert.deepEqual(before.prs.map((x) => [x.number, x.state, x.thread]).sort(), [[7, "merged", t.address], [8, null, t.address]], "B is on the task, under its reporting thread, with no state");
  assert.equal(s.board().unfiled.prs.length, 0);
  // a later reading of B (a PR wait's own gh reading) replaces the unknown state, though the report is not older
  s.at(60);
  s.e.waitPrSeen(pr("merged", 8));
  const after = s.task(a!);
  assert.equal(after.column, "shipped");
  assert.equal(after.why, "2 PRs merged");
  // a lead's reported PR names no task: it attaches nothing
  s.e.report(s.lead, "Lead's note", "fyi", "https://github.com/o/r/pull/99");
  assert.deepEqual(s.task(a!).prs.map((x) => x.number).sort(), [7, 8]);
  // the log's merge replaces a report's unknown state even when the report came later (bb's row went with its environment)
  const [b] = s.publish([{ id: a, title: "Build", state: "done" }, { title: "Polish", state: "current" }]).steps.slice(1).map((x) => x.id!);
  s.spawn("T-2", b);
  s.e.setEnvironment("T-2", "E2");
  s.at(70);
  s.e.prSeen(s.e.agentByThread("T-2")!, "E2", pr("merged", 9));
  s.db.prepare(`DELETE FROM prs WHERE environment_id = 'E2'`).run();
  s.at(80);
  s.e.report(s.e.agentByThread("T-2")!, "Polish PR", "merged", "https://github.com/o/r/pull/9");
  s.e.retire("T-2");
  assert.equal(s.task(b!).column, "shipped", "the log says #9 merged; the later report doesn't make it unknown");
});

test("a PR two threads reported keeps both their tasks from shipping while unread, and one reading ships both (Codex review of f26e3db)", () => {
  const s = setup();
  const [a, b] = s.publish([{ title: "Server", state: "current" }, { title: "Client", state: "next" }]).steps.map((x) => x.id!);
  const t1 = s.spawn("T-1", a);
  const t2 = s.spawn("T-2", b);
  s.e.setEnvironment("T-1", "E1");
  s.e.setEnvironment("T-2", "E2");
  s.e.prSeen(s.e.agentByThread("T-1")!, "E1", pr("merged", 11));
  s.e.prSeen(s.e.agentByThread("T-2")!, "E2", pr("merged", 12));
  s.at(10);
  const shared = "https://github.com/o/r/pull/30";
  s.e.report(s.e.agentByThread("T-1")!, "Shared PR", "both sides", shared);
  s.e.report(s.e.agentByThread("T-2")!, "Shared PR", "both sides", shared);
  s.e.retire("T-1");
  s.e.retire("T-2");
  for (const [id, by] of [[a, t1.address], [b, t2.address]] as const) {
    const t = s.task(id!);
    assert.notEqual(t.column, "shipped", `${t.title}: the shared PR was never read`);
    assert.deepEqual(t.prs.filter((x) => x.number === 30).map((x) => [x.state, x.thread]), [[null, by]], `${t.title} has the shared PR under its own thread`);
  }
  s.at(60);
  s.e.waitPrSeen(pr("merged", 30));
  assert.deepEqual([s.task(a!).column, s.task(b!).column], ["shipped", "shipped"], "one reading of the URL serves both tasks");
});

// Durable PR links (the owner's call, Codex's review of 56ef2dc): a task's PRs are the links
// written when each PR was first seen, never guessed at read time, so no PR that hasn't merged can drop off a task.
const PR30 = "https://github.com/o/r/pull/30";
const prsOf = (t: BoardTask, n: number) => t.prs.filter((x) => x.number === n).map((x) => [x.state, x.thread]);

test("a PR two tasks' threads both read keeps both off Shipped while it is open, and its merge ships both", () => {
  const s = setup();
  const [a, b] = s.publish([{ title: "Server", state: "current" }, { title: "Client", state: "next" }]).steps.map((x) => x.id!);
  const t1 = s.spawn("T-1", a);
  const t2 = s.spawn("T-2", b);
  s.e.setEnvironment("T-1", "E1");
  s.e.setEnvironment("T-2", "E2");
  s.e.prSeen(s.e.agentByThread("T-1")!, "E1", pr("merged", 11));
  s.e.prSeen(s.e.agentByThread("T-2")!, "E2", pr("merged", 12));
  s.e.prSeen(s.e.agentByThread("T-1")!, "E1", pr("open", 30));
  s.e.prSeen(s.e.agentByThread("T-2")!, "E2", pr("open", 30));
  s.e.retire("T-1");
  s.e.retire("T-2");
  for (const [id, by] of [[a, t1.address], [b, t2.address]] as const) {
    assert.notEqual(s.task(id!).column, "shipped", "the shared PR is still open");
    assert.deepEqual(prsOf(s.task(id!), 30), [["open", by]], "each task has the shared PR, under its own thread");
  }
  s.at(60);
  s.e.waitPrSeen(pr("merged", 30));
  assert.deepEqual([s.task(a!).column, s.task(b!).column], ["shipped", "shipped"], "the URL's one reading serves both");
});

test("a PR only a thread's wait watches keeps its task off Shipped while unread or open, and after the wait closes and its reading is pruned", () => {
  const s = setup();
  const [a] = s.publish([{ title: "Build", state: "current" }]).steps.map((x) => x.id!);
  const t = s.spawn("T-1", a);
  s.e.setEnvironment("T-1", "E1");
  s.e.prSeen(s.e.agentByThread("T-1")!, "E1", pr("merged", 11));
  const m = s.e.send(s.lead, t.address, "ship once #30 is green", null);
  s.e.ack(s.e.agentByThread("T-1")!, m.id, "done", null, { pr: PR30, when: "green" });
  s.e.retire("T-1");
  assert.notEqual(s.task(a!).column, "shipped", "#30 was never read");
  assert.deepEqual(prsOf(s.task(a!), 30), [[null, t.address]]);
  s.at(10);
  s.e.waitPrSeen(pr("open", 30, "passing")); // green: the wait closes
  assert.equal(s.db.prepare(`SELECT COUNT(*) AS c FROM waits WHERE closed_at IS NULL`).get()!.c, 0);
  assert.notEqual(s.task(a!).column, "shipped", "green is not merged");
  s.e.pruneWaitReadings();
  assert.deepEqual(prsOf(s.task(a!), 30), [[null, t.address]], "its reading is gone: unknown again, still on the task");
  assert.notEqual(s.task(a!).column, "shipped");
  s.at(20);
  s.e.waitPrSeen(pr("merged", 30));
  assert.equal(s.task(a!).column, "shipped");
});

// Codex's review of 3e10612: the owner's and the CoS's PR-wait changes (watchers) link the wait's PR to its owner's task too.
const lastWait = (s: ReturnType<typeof setup>) => (s.db.prepare(`SELECT id FROM waits ORDER BY rowid DESC LIMIT 1`).get() as { id: string }).id;
function shippedThread(s: ReturnType<typeof setup>, id: string, task: string, n: number, env: string) {
  const t = s.spawn(id, task);
  s.e.setEnvironment(id, env);
  s.e.prSeen(s.e.agentByThread(id)!, env, pr("merged", n));
  return t;
}

test("a PR wait the owner adds for a thread keeps the thread's task off Shipped until the PR merges", () => {
  const s = setup();
  const [a] = s.publish([{ title: "Build", state: "current" }]).steps.map((x) => x.id!);
  const t = shippedThread(s, "T-1", a!, 11, "E1");
  s.e.watchAdd(null, { to: t.address, pr: PR30, when: "merged", note: "ship it" });
  s.e.retire("T-1");
  assert.notEqual(s.task(a!).column, "shipped", "#30 unread");
  s.at(10);
  s.e.waitPrSeen(pr("open", 30));
  assert.notEqual(s.task(a!).column, "shipped", "#30 open");
  s.at(20);
  s.e.waitPrSeen(pr("merged", 30));
  assert.equal(s.task(a!).column, "shipped");
});

test("a PR wait retargeted to another PR keeps both PRs on the task: the first merging doesn't ship it while the second is unread", () => {
  const s = setup();
  const [a] = s.publish([{ title: "Build", state: "current" }]).steps.map((x) => x.id!);
  const t = shippedThread(s, "T-1", a!, 11, "E1");
  s.e.watchAdd(null, { to: t.address, pr: PR30, when: "merged", note: "ship it" });
  s.e.watchRetarget(null, lastWait(s), { pr: "https://github.com/o/r/pull/31" });
  s.e.retire("T-1");
  s.at(10);
  s.e.waitPrSeen(pr("merged", 30));
  assert.notEqual(s.task(a!).column, "shipped", "#31 unread");
  assert.deepEqual(prsOf(s.task(a!), 31), [[null, t.address]]);
  s.at(20);
  s.e.waitPrSeen(pr("merged", 31));
  assert.equal(s.task(a!).column, "shipped");
});

test("a PR wait moved to another task's thread keeps that task off Shipped too", () => {
  const s = setup();
  const [a, b] = s.publish([{ title: "Server", state: "current" }, { title: "Client", state: "next" }]).steps.map((x) => x.id!);
  const t1 = shippedThread(s, "T-1", a!, 11, "E1");
  const t2 = shippedThread(s, "T-2", b!, 12, "E2");
  s.e.watchAdd(null, { to: t1.address, pr: PR30, when: "merged", note: "ship it" });
  s.e.watchMove(null, lastWait(s), t2.address);
  s.e.retire("T-1");
  s.e.retire("T-2");
  assert.deepEqual(prsOf(s.task(b!), 30), [[null, t2.address]]);
  assert.notEqual(s.task(b!).column, "shipped");
  s.at(10);
  s.e.waitPrSeen(pr("merged", 30));
  assert.equal(s.task(b!).column, "shipped");
});

// The last round (the owner's call; Codex's review of 375d1d3 and its inventory of every path that ties a
// PR to a task): a PR handed off at resolve, a card's PR blocks and a deliverable's PR blocks and PR proof link too.
const clean = { clean: true as const, inBase: false, why: "pushed" };
const viaOf = (s: ReturnType<typeof setup>, n: number) => (s.db.prepare(`SELECT task, via FROM task_prs WHERE url = ?`).all(`https://github.com/o/r/pull/${n}`) as { task: string; via: string }[]).map((r) => [r.task, r.via]);

test("a PR handed off when its thread is resolved keeps the thread's task off Shipped, though bb never read it", () => {
  const s = setup();
  const [a] = s.publish([{ title: "Build", state: "current" }]).steps.map((x) => x.id!);
  const t = shippedThread(s, "T-1", a!, 11, "E1");
  s.e.resolve(s.lead, t.address, { prMerged: false, lastReadAt: null, worktree: clean, handedOff: { pr: PR30, owner: "Chris" } });
  assert.deepEqual(viaOf(s, 30), [[a, "handoff"]]);
  assert.deepEqual(prsOf(s.task(a!), 30), [[null, t.address]]);
  assert.notEqual(s.task(a!).column, "shipped");
  s.at(10);
  s.e.waitPrSeen(pr("merged", 30));
  assert.equal(s.task(a!).column, "shipped");
});

test("a card's PR block joins the card's task: after the card is answered, the unread PR still keeps the task off Shipped", () => {
  const s = setup();
  const [a] = s.publish([{ title: "Release", state: "current" }]).steps.map((x) => x.id!);
  shippedThread(s, "T-1", a!, 11, "E1");
  const q = s.e.ask(s.lead, { title: "Merge?", question: "Merge #30?", options: opts, task: a, blocks: [{ kind: "pr", url: PR30 }] });
  assert.deepEqual(viaOf(s, 30), [[a, "card"]]);
  s.e.triageAskPerson(s.cos, q.id, { question: "Merge #30?", options: opts, allowText: true });
  s.e.personAnswer(q.id, s.e.decision(q.id)!.rev, "1", null, "desktop");
  s.e.retire("T-1");
  assert.notEqual(s.task(a!).column, "shipped");
});

test("a revised card's new PR block joins its task", () => {
  const s = setup();
  const [a] = s.publish([{ title: "Release", state: "current" }]).steps.map((x) => x.id!);
  const q = s.e.ask(s.lead, { title: "Merge?", question: "Merge it?", options: opts, task: a });
  assert.deepEqual(viaOf(s, 31), []);
  s.e.ask(s.lead, { title: "Merge?", question: "Merge #31?", options: opts, blocks: [{ kind: "pr", url: "https://github.com/o/r/pull/31" }], revises: q.id, why: "names the PR" });
  assert.deepEqual(viaOf(s, 31), [[a, "card"]]);
});

test("a forwarded card's PR block joins the task of the thread that asked it (here a card saved before the links)", () => {
  const s = setup();
  const [a] = s.publish([{ title: "Build", state: "current" }]).steps.map((x) => x.id!);
  s.spawn("T-1", a);
  const q = s.e.ask(s.e.agentByThread("T-1")!, { title: "Merge?", question: "Merge #30?", options: opts, blocks: [{ kind: "pr", url: PR30 }] });
  assert.deepEqual(viaOf(s, 30), [[a, "card"]], "the thread's card links on ask");
  s.db.exec(`DELETE FROM task_prs`);
  s.e.forward(s.lead, q.id, null);
  assert.deepEqual(viaOf(s, 30), [[a, "card"]]);
});

test("a deliverable's PR blocks and PR proof join its task, and keep it off Shipped while unread", () => {
  const s = setup();
  const [a] = s.publish([{ title: "Report", state: "current" }]).steps.map((x) => x.id!);
  shippedThread(s, "T-1", a!, 11, "E1");
  s.e.deliver(s.lead, { title: "The report", summary: "Done.", proof: [{ kind: "pr", caption: "the PR", url: PR30 }], blocks: [{ kind: "pr", url: "https://github.com/o/r/pull/31" }], task: a }, place);
  assert.deepEqual([viaOf(s, 30), viaOf(s, 31)], [[[a, "deliverable"]], [[a, "deliverable"]]]);
  s.e.retire("T-1");
  assert.notEqual(s.task(a!).column, "shipped");
});

// Codex's review of 7391d9b: a restored task brings the PRs its threads, cards and deliverables gained while Unfiled;
// and a card's task follows the board's one address rule (threads only), live and in the seed.
const drop = (s: ReturnType<typeof setup>, keep: string) => s.publish([{ id: keep, title: "Keep", state: "current" }]);
const readd = (s: ReturnType<typeof setup>, keep: string, title: string) => s.publish([{ id: keep, title: "Keep", state: "current" }, { title, state: "next" }]);

test("a restored task gets the PR its thread read while the task was dropped", () => {
  const s = setup();
  const [k, a] = s.publish([{ title: "Keep", state: "current" }, { title: "Build", state: "next" }]).steps.map((x) => x.id!);
  const t = shippedThread(s, "T-1", a!, 11, "E1");
  drop(s, k!);
  s.e.prSeen(s.e.agentByThread("T-1")!, "E1", pr("open", 30));
  assert.deepEqual(viaOf(s, 30), [], "no task while Unfiled");
  s.e.retire("T-1");
  readd(s, k!, "Build");
  assert.deepEqual(prsOf(s.task(a!), 30), [["open", t.address]]);
  assert.notEqual(s.task(a!).column, "shipped");
});

test("a restored task gets the PR block its card gained while Unfiled", () => {
  const s = setup();
  const [k, a] = s.publish([{ title: "Keep", state: "current" }, { title: "Release", state: "next" }]).steps.map((x) => x.id!);
  shippedThread(s, "T-1", a!, 11, "E1");
  s.e.retire("T-1");
  const q = s.e.ask(s.lead, { title: "Merge?", question: "Merge it?", options: opts, task: a });
  drop(s, k!);
  s.e.ask(s.lead, { title: "Merge?", question: "Merge #30?", options: opts, blocks: [{ kind: "pr", url: PR30 }], revises: q.id, why: "names the PR" });
  assert.deepEqual(viaOf(s, 30), []);
  s.e.triageAskPerson(s.cos, q.id, { question: "Merge #30?", options: opts, allowText: true, revision: 1 });
  s.e.personAnswer(q.id, s.e.decision(q.id)!.rev, "1", null, "desktop");
  readd(s, k!, "Release");
  assert.deepEqual(viaOf(s, 30), [[a, "card"]]);
  assert.notEqual(s.task(a!).column, "shipped");
});

test("a restored task gets the PR block of a card its thread asked while Unfiled (the card follows the thread)", () => {
  const s = setup();
  const [k, a] = s.publish([{ title: "Keep", state: "current" }, { title: "Build", state: "next" }]).steps.map((x) => x.id!);
  shippedThread(s, "T-1", a!, 11, "E1");
  drop(s, k!);
  s.e.ask(s.e.agentByThread("T-1")!, { title: "Merge?", question: "Merge #30?", options: opts, blocks: [{ kind: "pr", url: PR30 }] });
  assert.deepEqual(viaOf(s, 30), []);
  s.e.retire("T-1");
  readd(s, k!, "Build");
  assert.deepEqual(viaOf(s, 30), [[a, "card"]]);
  assert.notEqual(s.task(a!).column, "shipped");
});

test("a restored task gets the PR proof its deliverable gained while Unfiled: approved, it still waits on the PR", () => {
  const s = setup();
  const [k, a] = s.publish([{ title: "Keep", state: "current" }, { title: "Report", state: "next" }]).steps.map((x) => x.id!);
  const d = s.e.deliver(s.lead, { title: "The report", summary: "Done.", proof, task: a }, place);
  s.e.personRequestChanges(d.id, 1, "link the PR");
  drop(s, k!);
  s.e.deliver(s.lead, { title: "The report", summary: "Done, with the PR.", proof: [{ kind: "pr", caption: "the PR", url: PR30 }], revises: d.id }, place);
  assert.deepEqual(viaOf(s, 30), []);
  s.e.personApprove(d.id, 2, null);
  readd(s, k!, "Report");
  assert.deepEqual(viaOf(s, 30), [[a, "deliverable"]]);
  assert.notEqual(s.task(a!).column, "shipped", "approved, but #30 is unread");
});

// Codex's review of a65bfeb: a restore also links the lead's PR waits bound to the cards that come back with the task,
// whether the card names the task itself or inherits it from the thread that asked it, open or completed at green.
function leadWaitOnRestoredCard(inherited: boolean, green: boolean) {
  const s = setup();
  const [k, a] = s.publish([{ title: "Keep", state: "current" }, { title: "Build", state: "next" }]).steps.map((x) => x.id!);
  shippedThread(s, "T-1", a!, 11, "E1");
  let q;
  if (inherited) {
    q = s.e.ask(s.e.agentByThread("T-1")!, { title: "Merge?", question: "Merge it?", options: opts });
    s.e.forward(s.lead, q.id, null);
  } else q = s.e.ask(s.lead, { title: "Merge?", question: "Merge it?", options: opts, task: a });
  s.e.retire("T-1");
  drop(s, k!);
  s.e.triageAskPerson(s.cos, q.id, { question: "Merge it?", options: opts, allowText: true });
  s.e.personAnswer(q.id, s.e.decision(q.id)!.rev, "1", null, "desktop");
  s.e.ack(s.lead, q.id, "done", null, { pr: PR30, when: green ? "green" : "merged" });
  assert.deepEqual(viaOf(s, 30), [], "no task while Unfiled");
  if (green) {
    s.at(10);
    s.e.waitPrSeen(pr("open", 30, "passing"));
    assert.equal(s.db.prepare(`SELECT COUNT(*) AS c FROM waits WHERE closed_at IS NULL`).get()!.c, 0, "the wait is met");
    s.e.pruneWaitReadings();
  }
  readd(s, k!, "Build");
  assert.deepEqual(viaOf(s, 30), [[a, "wait"]]);
  assert.notEqual(s.task(a!).column, "shipped");
}

test("a restored task gets the PR of the lead's open wait on its own card", () => leadWaitOnRestoredCard(false, false));
test("a restored task gets the PR of the lead's wait on its own card, met at green and its reading pruned", () => leadWaitOnRestoredCard(false, true));
test("a restored task gets the PR of the lead's open wait on a card its thread asked", () => leadWaitOnRestoredCard(true, false));
test("a restored task gets the PR of the lead's wait on a card its thread asked, met at green and its reading pruned", () => leadWaitOnRestoredCard(true, true));

test("an address's task is one index search over every holder, retired ones too, never a scan of agents (Codex's review of fec268d)", () => {
  const s = setup();
  const plan = (s.db.prepare(`EXPLAIN QUERY PLAN ${ADDRESS_TASK_ONE}`).all("thread:demo:1") as { detail: string }[]).map((r) => r.detail).join("; ");
  assert.match(plan, /SEARCH a USING INDEX agents_address_created \(address=\?\)/, plan);
  assert.doesNotMatch(plan, /SCAN a|TEMP B-TREE/, plan);
});

/** A thread spawned on `a`, retired, then registered as another project's lead: its spawn row outlives its thread role. */
function leadFromThread(s: ReturnType<typeof setup>, a: string) {
  s.spawn("T-1", a);
  s.e.retire("T-1");
  return s.e.register("T-1", "lead", "other");
}

test("a card from a lead that was once a thread on a task links its PR nowhere: Unfiled, as the board shows it", () => {
  const s = setup();
  const [a] = s.publish([{ title: "Build", state: "current" }]).steps.map((x) => x.id!);
  const lead = leadFromThread(s, a!);
  const q = s.e.ask(lead, { title: "Merge?", question: "Merge #30?", options: opts, blocks: [{ kind: "pr", url: PR30 }] });
  assert.deepEqual(viaOf(s, 30), []);
  assert.deepEqual(s.e.workBoard({ project: "other" }).projects[0]!.unfiled.cards.map((c) => c.id), [q.id]);
  s.at(10);
  s.e.waitPrSeen(pr("merged", 30));
  assert.notEqual(s.task(a!).column, "shipped");
});

test("the upgrade links no PR of a card from a lead that was once a thread on a task", () => {
  const s = setup();
  const [a] = s.publish([{ title: "Build", state: "current" }]).steps.map((x) => x.id!);
  const lead = leadFromThread(s, a!);
  s.e.ask(lead, { title: "Merge?", question: "Merge #30?", options: opts, blocks: [{ kind: "pr", url: PR30 }] });
  rewindLinks(s);
  migrate(s.db as never);
  assert.deepEqual(viaOf(s, 30), []);
});

test("a lead's PR wait on a card belongs to the card's task", () => {
  const s = setup();
  const [a] = s.publish([{ title: "Release", state: "current" }]).steps.map((x) => x.id!);
  const q = s.e.ask(s.lead, { title: "Merge?", question: "Merge #31 once it's green?", options: opts, task: a });
  s.e.triageAskPerson(s.cos, q.id, { question: "Merge #31 once it's green?", options: opts, allowText: true });
  s.e.personAnswer(q.id, s.e.decision(q.id)!.rev, "1", null, "desktop");
  s.e.ack(s.lead, q.id, "done", null, { pr: "https://github.com/o/r/pull/31", when: "merged" });
  assert.deepEqual(prsOf(s.task(a!), 31), [[null, "lead:demo"]]);
});

test("retention never drops a PR link: a reported, unread PR still keeps its task off Shipped after a 30-day prune", () => {
  const s = setup();
  const [a] = s.publish([{ title: "Build", state: "current" }]).steps.map((x) => x.id!);
  const t = s.spawn("T-1", a);
  s.e.setEnvironment("T-1", "E1");
  s.e.prSeen(s.e.agentByThread("T-1")!, "E1", pr("merged", 11));
  s.e.report(s.e.agentByThread("T-1")!, "Follow-up", "the second PR", PR30);
  s.e.retire("T-1");
  s.at(31 * 24 * 60);
  prune(s.db as never, s.clock.t, { retentionDays: 30, activityRetentionDays: 30 });
  assert.equal(s.db.prepare(`SELECT COUNT(*) AS c FROM board WHERE ref = ?`).get(PR30)!.c, 0, "the prune took the report itself");
  assert.deepEqual(prsOf(s.task(a!), 30), [[null, t.address]], "the link stays");
  assert.notEqual(s.task(a!).column, "shipped");
});

test("a handoff successor's PR links to the task its predecessor was on (it has no spawn row of its own)", () => {
  const s = setup();
  const [a] = s.publish([{ title: "Build", state: "current" }]).steps.map((x) => x.id!);
  const t = s.spawn("T-1", a);
  s.e.setEnvironment("T-1", "E1");
  const next = s.e.takeOver("T-1", "T-1b", "context full");
  s.e.prSeen(next, "E1", pr("open", 21));
  assert.deepEqual(prsOf(s.task(a!), 21), [["open", t.address]]);
});

test("a dropped task's link doesn't hide its live thread's open PR: it is in Unfiled, and back on the task when the title is re-added", () => {
  const s = setup();
  const [a, b] = s.publish([{ title: "Keep", state: "current" }, { title: "Spike", state: "next" }]).steps.map((x) => x.id!);
  s.spawn("T-1", b);
  s.e.setEnvironment("T-1", "E1");
  s.e.prSeen(s.e.agentByThread("T-1")!, "E1", pr("open", 50));
  s.publish([{ id: a, title: "Keep", state: "current" }]);
  assert.deepEqual(s.board().unfiled.prs.map((x) => x.number), [50]);
  s.publish([{ id: a, title: "Keep", state: "current" }, { title: "Spike", state: "next" }]);
  assert.deepEqual(s.task(b!).prs.map((x) => x.number), [50]);
  assert.deepEqual(s.board().unfiled.prs, []);
});

/** Back to a DB from before the PR links: the table and its migration marker gone, the board settled without them. */
function rewindLinks(s: ReturnType<typeof setup>): number {
  const idx = MIGRATIONS.findIndex((m) => m.startsWith("CREATE TABLE task_prs ("));
  s.db.exec(`DROP TABLE task_prs`);
  s.db.prepare(`DELETE FROM _migrations WHERE id = ?`).run(idx);
  return idx;
}

test("the upgrade backfills PR links from what history holds: a PR both tasks' threads logged keeps both off Shipped, a live thread's open PR is In review, and no move is logged", () => {
  const s = setup();
  const [a, b, c] = s.publish([{ title: "Server", state: "current" }, { title: "Client", state: "next" }, { title: "Docs", state: "next" }]).steps.map((x) => x.id!);
  for (const [id, n, env] of [["T-1", 11, "E1"], ["T-2", 12, "E2"]] as const) {
    s.spawn(id, id === "T-1" ? a : b);
    s.e.setEnvironment(id, env);
    s.e.prSeen(s.e.agentByThread(id)!, env, pr("merged", n));
    s.e.prSeen(s.e.agentByThread(id)!, env, pr("open", 30));
    s.e.retire(id);
  }
  s.spawn("T-3", c);
  s.e.setEnvironment("T-3", "E3");
  s.e.prSeen(s.e.agentByThread("T-3")!, "E3", pr("open", 40, "passing"));
  const m = s.e.send(s.lead, s.e.agentByThread("T-3")!.address, "ship once #41 merges", null);
  s.e.ack(s.e.agentByThread("T-3")!, m.id, "done", null, { pr: "https://github.com/o/r/pull/41", when: "merged" });
  rewindLinks(s);
  // the retired threads' environments are gone: only the PR log still knows #11, #12 and #30
  s.db.exec(`DELETE FROM prs WHERE environment_id IN ('E1', 'E2')`);
  settleColumns(s.db as never, s.clock.t, { log: false }); // what the tasks seed leaves: columns read without links
  assert.equal(s.task(c!).column, "in_progress", "without its link the open PR isn't on the task yet");
  const moves = s.moves().length;
  migrate(s.db as never);
  const links = (s.db.prepare(`SELECT url, task, via FROM task_prs ORDER BY url, task`).all() as { url: string; task: string; via: string }[]).map((r) => [Number(r.url.split("/").pop()), r.task, r.via]);
  assert.deepEqual(
    links.filter((l) => l[0] === 30 || l[0] === 40 || l[0] === 41).sort(),
    [[30, a, "bb"], [30, b, "bb"], [40, c, "bb"], [41, c, "wait"]].sort(),
  );
  assert.notEqual(s.task(a!).column, "shipped");
  assert.notEqual(s.task(b!).column, "shipped");
  assert.equal(s.task(c!).column, "in_review");
  assert.equal(s.moves().length, moves, "the upgrade logs no move");
  assert.equal(s.e.settleBoard(), 0, "and the first settle after it moves nothing");
});

test("the upgrade links a completed PR wait's PR: a wait met at green, its reading pruned and its thread retired, still keeps the task off Shipped", () => {
  const s = setup();
  const [a] = s.publish([{ title: "Build", state: "current" }]).steps.map((x) => x.id!);
  const t = shippedThread(s, "T-1", a!, 11, "E1");
  const m = s.e.send(s.lead, t.address, "ship once #30 is green", null);
  s.e.ack(s.e.agentByThread("T-1")!, m.id, "done", null, { pr: PR30, when: "green" });
  s.at(10);
  s.e.waitPrSeen(pr("open", 30, "passing"));
  assert.equal(s.db.prepare(`SELECT COUNT(*) AS c FROM waits WHERE closed_at IS NULL`).get()!.c, 0, "the wait is met");
  s.e.pruneWaitReadings();
  s.e.retire("T-1");
  rewindLinks(s);
  settleColumns(s.db as never, s.clock.t, { log: false });
  migrate(s.db as never);
  assert.deepEqual(prsOf(s.task(a!), 30), [[null, t.address]]);
  assert.notEqual(s.task(a!).column, "shipped");
});

test("the upgrade links handed-off PRs, cards' PR blocks and deliverables' PR blocks and proof, each on its own task", () => {
  const s = setup();
  const [a, b, c] = s.publish([{ title: "Build", state: "current" }, { title: "Release", state: "next" }, { title: "Report", state: "next" }]).steps.map((x) => x.id!);
  const t = shippedThread(s, "T-1", a!, 11, "E1");
  s.e.resolve(s.lead, t.address, { prMerged: false, lastReadAt: null, worktree: clean, handedOff: { pr: PR30, owner: "Chris" } });
  s.e.ask(s.lead, { title: "Merge?", question: "Merge #31?", options: opts, task: b, blocks: [{ kind: "pr", url: "https://github.com/o/r/pull/31" }] });
  s.e.deliver(s.lead, { title: "The report", summary: "Done.", proof: [{ kind: "pr", caption: "the PR", url: "https://github.com/o/r/pull/32" }], blocks: [{ kind: "pr", url: "https://github.com/o/r/pull/33" }], task: c }, place);
  rewindLinks(s);
  settleColumns(s.db as never, s.clock.t, { log: false });
  migrate(s.db as never);
  assert.deepEqual([30, 31, 32, 33].map((n) => viaOf(s, n)), [[[a, "handoff"]], [[b, "card"]], [[c, "deliverable"]], [[c, "deliverable"]]]);
  assert.notEqual(s.task(a!).column, "shipped", "the handed-off PR is still open");
});

test("the PR links' migration and its backfill are one transaction: a failing backfill leaves no table and no marker, and a rerun completes", () => {
  const s = setup();
  const [a] = s.publish([{ title: "Build", state: "current" }]).steps.map((x) => x.id!);
  s.spawn("T-1", a);
  s.e.setEnvironment("T-1", "E1");
  s.e.prSeen(s.e.agentByThread("T-1")!, "E1", pr("open", 30));
  const idx = rewindLinks(s);
  s.db.exec(`ALTER TABLE waits RENAME TO waits_away`);
  assert.throws(() => migrate(s.db as never), /no such table: waits/);
  assert.equal(s.db.prepare(`SELECT COUNT(*) AS c FROM sqlite_master WHERE name = 'task_prs'`).get()!.c, 0, "the table rolled back with it");
  assert.equal(s.db.prepare(`SELECT COUNT(*) AS c FROM _migrations WHERE id = ?`).get(idx)!.c, 0, "and its marker");
  s.db.exec(`ALTER TABLE waits_away RENAME TO waits`);
  migrate(s.db as never);
  assert.deepEqual(s.db.prepare(`SELECT url, task FROM task_prs`).all().map((r) => ({ ...r })), [{ url: PR30, task: a }]);
});

test("a released hand move never comes back, even when the attachments read as they did at the move", () => {
  const s = setup();
  const [a] = s.publish([{ title: "Build", state: "current" }]).steps.map((x) => x.id!);
  s.spawn("T-1", a);
  s.e.setStatus("T-1", "idle");
  s.db.prepare(`UPDATE tasks SET hand_col = 'blocked', hand_at = ?, hand_sig = ? WHERE id = ?`).run(T0, s.task(a!).sig, a!);
  s.e.settleBoard();
  assert.equal(s.task(a!).column, "blocked");
  s.e.setStatus("T-1", "active");
  s.e.settleBoard();
  s.e.setStatus("T-1", "idle");
  s.e.settleBoard();
  const t = s.task(a!);
  assert.equal(t.column, "in_progress", "idle again: the old hold stays released");
  assert.deepEqual(t.hand, { column: "blocked", at: T0, holds: false });
  assert.deepEqual(s.moves().filter((m) => m.task === a).map((m) => m.to_col), ["in_progress", "blocked", "in_progress"], "no second move back to Blocked");
});

test("a dropped task's thread handed over while Unfiled comes back as its successor when the title is re-added", () => {
  const s = setup();
  const [a, b] = s.publish([{ title: "Keep", state: "current" }, { title: "Spike", state: "next" }]).steps.map((x) => x.id!);
  s.spawn("T-1", b);
  s.publish([{ id: a, title: "Keep", state: "current" }]);
  s.e.takeOver("T-1", "T-1b", "context full");
  s.publish([{ id: a, title: "Keep", state: "current" }, { title: "Spike", state: "next" }]);
  assert.deepEqual(s.task(b!).threads.map((x) => [x.threadId, x.live]), [["T-1b", true]]);
  assert.deepEqual(s.board().unfiled.threads, []);
});

test("Shipped by attachments keeps to the since window, by when it shipped", () => {
  const s = setup();
  const [a] = s.publish([{ title: "Report", state: "current" }]).steps.map((x) => x.id!);
  const d = s.e.deliver(s.lead, { title: "The report", summary: "Done.", proof, task: a }, place);
  s.e.personApprove(d.id, 1, null);
  s.at(8 * 24 * 60);
  assert.deepEqual(s.board().tasks.map((t) => t.id), [], "approved 8 days ago: outside the default 7 days");
  assert.deepEqual(s.e.workBoard({ project: "demo", since: T0 - MIN }).projects[0]!.tasks.map((t) => [t.id, t.column]), [[a, "shipped"]]);
});

test("the settle's PR log read uses the PR partial index, not a scan of every event", () => {
  const s = setup();
  const plan = (s.db.prepare(`EXPLAIN QUERY PLAN SELECT ref AS url, value AS state, note, address, project, MAX(at) AS at FROM events WHERE kind = 'pr' AND ref IS NOT NULL GROUP BY ref`).all() as { detail: string }[]).map((r) => r.detail).join("; ");
  assert.match(plan, /events_pr_ref_at/, plan);
  assert.doesNotMatch(plan, /SCAN events(?! USING)/, plan);
});
