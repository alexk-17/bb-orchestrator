// Acting on the work board (SCOPE pieces 4 and 5). The owner acts on a task from its card on the board,
// so a lead reading the result must know which task it is about, and the board's own actions must never do more than
// they say: a message names its task, and only a task of the lead's own project.
import assert from "node:assert/strict";
import { test } from "node:test";
import { DatabaseSync } from "node:sqlite";
import { Engine } from "../core/engine.ts";
import { statusParams } from "../core/status.ts";

const T0 = Date.parse("2026-11-23T10:00:00Z");

function setup() {
  const clock = { t: T0 };
  const db = new DatabaseSync(":memory:");
  const e = new Engine(db as never, { now: () => clock.t, deliver: async () => ({ delivery: "sent" }), mirror: () => {}, changed: () => {}, log: () => {} }, { owner: "Robin", batchInbox: false });
  const cos = e.register("T-cos", "cos", null);
  const lead = e.register("T-lead", "lead", "demo");
  const other = e.register("T-lead2", "lead", "other");
  const st = e.publishStatus(lead, statusParams.parse({ goal: "Ship the demo", steps: [{ title: "Schema", state: "current" }, { title: "Engine", state: "next" }] }));
  const theirs = e.publishStatus(other, statusParams.parse({ goal: "Other", steps: [{ title: "Theirs", state: "current" }] }));
  const items = (to: string) => db.prepare(`SELECT kind, sender, body, needs_ack FROM items WHERE recipient = ? ORDER BY created_at, rowid`).all(to) as { kind: string; sender: string; body: string; needs_ack: number }[];
  return { e, db, cos, lead, clock, ids: st.steps.map((s) => s.id!), theirs: theirs.steps[0]!.id!, items };
}

test("a message about a task reaches the lead with the task's id and title at the top, and the CoS's copy says the same", () => {
  const s = setup();
  const it = s.e.ownerMessage("demo", "Can this wait until Monday?", null, [], null, s.ids[1]!);
  assert.match(it.body, new RegExp(`^About task ${s.ids[1]} "Engine" on the work board:\\nCan this wait until Monday\\?$`));
  const lead = s.items("lead:demo").find((i) => i.kind === "owner.message")!;
  assert.equal(lead.body, it.body);
  assert.match(s.items("cos").find((i) => i.kind === "copy")!.body, new RegExp(`About task ${s.ids[1]} "Engine"`));
});

test("a message about another project's task, or a task named by title, is refused and sends nothing", () => {
  const s = setup();
  assert.throws(() => s.e.ownerMessage("demo", "hello", null, [], null, s.theirs), /demo has no task/);
  assert.throws(() => s.e.ownerMessage("demo", "hello", null, [], null, "Engine"), /by its id/);
  assert.equal(s.items("lead:demo").length, 0);
});

test("a message with no task is as before", () => {
  const s = setup();
  assert.equal(s.e.ownerMessage("demo", "plain").body, "plain");
});

test("the panel reuses the app's parts: Needs you's card, the deliverable card and the projects' composer, and adds no text box of its own", async () => {
  const { readFileSync } = await import("node:fs");
  const src = readFileSync(new URL("../app/work-board-panel.tsx", import.meta.url), "utf8");
  for (const use of ["<CardView ", "<DeliverableCard ", "<Composer "]) assert.ok(src.includes(use), use);
  assert.doesNotMatch(src, /<textarea|<input|<ReplyField|<Textarea/, "every text box is the shared CompactBar (the Composer)");
});

test("a message the server refuses says why in the panel: it shows the error under the same name the box to a lead files it", async () => {
  const { readFileSync } = await import("node:fs");
  const panel = readFileSync(new URL("../app/work-board-panel.tsx", import.meta.url), "utf8");
  const box = readFileSync(new URL("../app/direct-line.tsx", import.meta.url), "utf8");
  assert.match(box, /write\(w\.path, w\.body, \{ kind: "other", where: `lead:\$\{slug\}`/, "the box to a lead files a failed send under lead:<project>");
  const section = panel.slice(panel.indexOf('aria-label="Message the lead"'));
  assert.match(section, /<PageError where=\{`lead:\$\{t\.project\}`\} \/>/, "the panel's Message the lead shows lead:<the task's project>");
});

// ---- hand moves (piece 5)
const opts = [{ label: "Go" }, { label: "Not now" }];
const pr = (state: string, n = 7, checks = "passing", attention = "none") => ({ outcome: "available", pullRequest: { url: `https://github.com/o/r/pull/${n}`, number: n, state, attention, checks: { state: checks } } }) as never;
function moving() {
  const s = setup();
  const spawn = (threadId: string, task: string) => {
    const plan = s.e.ask(s.lead, { title: "Start a thread?", question: "Start one thread?", options: opts, kind: "plan", threads: 1, task });
    s.e.triageAskPerson(s.cos, plan.id, { question: "Start one thread?", options: [], allowText: true });
    s.e.personAnswer(plan.id, s.e.decision(plan.id)!.rev, "1", null, "desktop");
    s.e.confirmSpawn(s.e.reserveSpawn(s.lead, plan.id), threadId);
    return s.e.register(threadId, "thread", "demo", "T-lead");
  };
  const th = spawn("T-th", s.ids[0]!);
  s.e.setEnvironment(th.threadId, "env-1");
  s.e.prSeen(s.e.agentByThread(th.threadId)!, "env-1", pr("open", 7, "passing", "review_required"));
  s.e.settleBoard();
  const task = (id: string) => s.e.workBoard({ project: "demo" }).projects[0]!.tasks.find((t) => t.id === id)!;
  const moves = () => s.db.prepare(`SELECT task, from_col, to_col, by, why FROM task_moves WHERE task = ? ORDER BY seq`).all(s.ids[0]!).map((r) => ({ ...r })) as { from_col: string; to_col: string; by: string; why: string }[];
  const snapshot = () => ({
    prs: s.db.prepare(`SELECT url, state, checks FROM prs ORDER BY url`).all(),
    prEvents: s.db.prepare(`SELECT ref, value FROM events WHERE kind = 'pr' ORDER BY at, rowid`).all(),
    decisions: s.db.prepare(`SELECT id, state, json FROM decisions ORDER BY id`).all(),
    deliverables: s.db.prepare(`SELECT id, state, rev FROM deliverables ORDER BY id`).all(),
    task: s.db.prepare(`SELECT state, shipped_at FROM tasks WHERE id = ?`).get(s.ids[0]!),
  });
  return { ...s, th, task, moves, snapshot, a: s.ids[0]! };
}

test("moving a task in review to Shipped holds it there, logged once as the owner's move, and merges nothing", () => {
  const s = moving();
  assert.equal(s.task(s.a).column, "in_review");
  const before = JSON.stringify(s.snapshot());
  const r = s.e.boardMove(s.a, "shipped");
  assert.deepEqual(r, { task: s.a, from: "in_review", to: "shipped", holds: true });
  const t = s.task(s.a);
  assert.equal(t.column, "shipped");
  assert.equal(t.derived, "in_review", "its attachments still say In review");
  assert.equal(t.hand?.holds, true);
  assert.equal(JSON.stringify(s.snapshot()), before, "no PR, event, card, deliverable or task state changed: the task is still open, the PR still open");
  const owner = s.moves().filter((m) => m.by === "person");
  assert.deepEqual(owner, [{ task: s.a, from_col: "in_review", to_col: "shipped", by: "person", why: "moved by the owner" }]);
  const logged = s.moves().length;
  s.e.settleBoard();
  assert.equal(s.moves().length, logged, "the next tick logs nothing more");
  assert.equal(s.task(s.a).column, "shipped", "the hold survives a tick");
});

test("the lead gets an INFO notice and the CoS a copy, both saying nothing was merged", () => {
  const s = moving();
  s.e.boardMove(s.a, "shipped");
  const n = s.items("lead:demo").filter((i) => i.kind === "notice" && i.body.includes("on the work board"));
  assert.equal(n.length, 1);
  assert.equal(n[0]!.needs_ack, 0, "INFO: no ack asked");
  assert.match(n[0]!.body, /moved task t-\w+ "Schema" from In review to Shipped on the work board/);
  assert.match(n[0]!.body, /merged, answered and approved nothing/);
  const copy = s.items("cos").filter((i) => i.kind === "copy" && i.body.includes("Schema"));
  assert.equal(copy.length, 1);
});

test("a change to the attached PR releases the hold: the card goes back where its attachments put it", () => {
  const s = moving();
  s.e.boardMove(s.a, "shipped");
  s.clock.t += 60_000;
  s.e.prSeen(s.e.agentByThread("T-th")!, "env-1", pr("open", 7, "pending", "review_required"));
  const t = s.task(s.a);
  assert.equal(t.column, "in_review");
  assert.equal(t.hand?.holds, false);
  s.e.settleBoard();
  assert.deepEqual(s.moves().at(-1), { task: s.a, from_col: "shipped", to_col: "in_review", by: "engine", why: "PR #7 waits on CI" });
});

test("moving out of Waiting on you leaves the card open and waiting, and the notice names it", () => {
  const s = moving();
  const q = s.e.ask(s.e.agentByThread("T-th")!, { title: "Colour?", question: "Red or blue?", options: [{ label: "Red" }, { label: "Blue" }] });
  s.e.forward(s.lead, q.id, null, null);
  s.e.triageAskPerson(s.cos, q.id, { question: "Red or blue?", options: [{ label: "Red" }, { label: "Blue" }], allowText: true });
  assert.equal(s.task(s.a).column, "waiting");
  s.e.boardMove(s.a, "in_progress");
  assert.equal(s.e.decision(q.id)!.state, "asked", "the card is not answered");
  assert.equal(s.task(s.a).cards[0]!.ownerWaits, true);
  assert.equal(s.task(s.a).column, "in_progress");
  assert.match(s.items("lead:demo").filter((i) => i.kind === "notice" && i.body.includes("on the work board")).at(-1)!.body, new RegExp(`card ${q.id} still waits on Robin`));
});

test("moving back to where its attachments put it clears the hand move", () => {
  const s = moving();
  s.e.boardMove(s.a, "blocked");
  const r = s.e.boardMove(s.a, "in_review");
  assert.equal(r.holds, false);
  assert.equal(s.task(s.a).hand, null);
  assert.equal(s.task(s.a).column, "in_review");
});

test("a move to the column it is in does nothing and tells nobody", () => {
  const s = moving();
  s.e.boardMove(s.a, "in_review");
  assert.equal(s.items("lead:demo").filter((i) => i.kind === "notice" && i.body.includes("on the work board")).length, 0);
  assert.equal(s.moves().filter((m) => m.by === "person").length, 0);
});

test("a dropped or unknown task can't be moved", () => {
  const s = moving();
  assert.throws(() => s.e.boardMove("t-000000", "shipped"), /no task/);
  s.e.publishStatus(s.lead, statusParams.parse({ goal: "Ship the demo", steps: [{ id: s.ids[0], title: "Schema", state: "current" }] }));
  assert.throws(() => s.e.boardMove(s.ids[1]!, "shipped"), /dropped/);
});

// Two properties of the attachments' signature the hold inherits (core/work-board.ts attachmentSig), kept as they are:
test("a thread's working/idle flip is an attachment change: it releases a hold", () => {
  const s = moving();
  s.e.setStatus("T-th", "active");
  s.e.boardMove(s.a, "blocked");
  s.e.setStatus("T-th", "idle");
  assert.equal(s.task(s.a).hand?.holds, false);
});

test("the lead marking the step done is not an attachment change: the hold stays", () => {
  const s = moving();
  s.e.boardMove(s.a, "blocked");
  s.e.publishStatus(s.lead, statusParams.parse({ goal: "Ship the demo", steps: [{ id: s.ids[0], title: "Schema", state: "done" }, { id: s.ids[1], title: "Engine", state: "current" }] }));
  const t = s.task(s.a);
  assert.equal(t.derived, "shipped");
  assert.equal(t.column, "blocked", "the hand move still holds");
});

test("with the batched inbox on (as the live orchestrator runs), the lead's notice and the CoS's copy are INFO: they wake nobody", () => {
  const db = new DatabaseSync(":memory:");
  const e = new Engine(db as never, { now: () => T0, deliver: async () => ({ delivery: "sent" }), mirror: () => {}, changed: () => {}, log: () => {} }, { owner: "Robin", batchInbox: true });
  e.register("T-cos", "cos", null);
  const lead = e.register("T-lead", "lead", "demo");
  const st = e.publishStatus(lead, statusParams.parse({ goal: "Ship", steps: [{ title: "Schema", state: "current" }] }));
  e.boardMove(st.steps[0]!.id!, "blocked");
  const rows = db.prepare(`SELECT i.recipient, i.kind, b.severity, b.needs_reply, b.due_at FROM items i JOIN inbox_entries b ON b.item_id = i.id WHERE i.body LIKE '%on the work board%' ORDER BY i.created_at, i.rowid`).all().map((r) => ({ ...r }));
  assert.deepEqual(rows, [
    { recipient: "lead:demo", kind: "notice", severity: "INFO", needs_reply: 0, due_at: null },
    { recipient: "cos", kind: "copy", severity: "INFO", needs_reply: 0, due_at: null },
  ]);
});
