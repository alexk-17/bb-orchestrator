// The CoS's board tidy (the work board scope) and the stale-task flag. The board is only as good as its tasks:
// - a duplicate task folded into another must take everything with it, and its old id must keep pointing at the task
//   that carries on, or the lead's next publish (or a plan card that still names it) quietly splits the work again;
// - a task dropped by mistake comes back with its attachments, and its lead is told to send it back (or it drops again);
// - an Unfiled thread, PR, deliverable or card filed by the CoS lands on that task's card, never across projects;
// - only the CoS may tidy: a lead or thread moving other leads' work around would make the board untrustworthy;
// - every tidy is on the record (task_moves by cos; thread 3's since-T counts read it) and the lead hears about it;
// - a task whose PRs all merged sits In progress while a forgotten thread idles on it: its lead is told, once a day.
import assert from "node:assert/strict";
import { test } from "node:test";
import { DatabaseSync } from "node:sqlite";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { Engine, type PrResult } from "../core/engine.ts";
import { MIGRATIONS, migrate } from "../core/db.ts";
import { statusParams } from "../core/status.ts";
import { touches } from "../change-notice.ts";
import type { BoardTask } from "../contract.ts";

const T0 = Date.parse("2026-11-23T10:00:00Z");
const MIN = 60_000;
const HOUR = 60 * MIN;
const scratch = mkdtempSync(join(tmpdir(), "board-tidy-"));
mkdirSync(join(scratch, "lead"), { recursive: true });
const shot = join(scratch, "lead", "shot.png");
writeFileSync(shot, "png");
const place = { roots: [{ path: join(scratch, "lead"), hostId: "host-1" }] };
const proof = [{ kind: "image" as const, caption: "the screen", path: shot }];
const opts = [{ label: "Go" }, { label: "Not now" }];
const pr = (state: string, n = 7): PrResult => ({ outcome: "available", pullRequest: { url: `https://github.com/o/r/pull/${n}`, number: n, state, checks: { state: "passing" } } }) as PrResult;

function setup() {
  const clock = { t: T0 };
  const db = new DatabaseSync(":memory:");
  const e = new Engine(db as never, { now: () => clock.t, deliver: async () => ({ delivery: "sent" }), mirror: () => {}, changed: () => {}, log: () => {} }, { owner: "Robin", batchInbox: false });
  const cos = e.register("T-cos", "cos", null);
  const lead = e.register("T-lead", "lead", "demo");
  const publish = (steps: unknown) => e.publishStatus(lead, statusParams.parse({ goal: "Ship the demo", steps }));
  const board = () => e.workBoard({ project: "demo" }).projects[0]!;
  const task = (id: string) => board().tasks.find((t) => t.id === id) as BoardTask;
  const cosMoves = () => db.prepare(`SELECT task, from_col, to_col, why FROM task_moves WHERE by = 'cos' ORDER BY seq`).all().map((r) => ({ ...r })) as { task: string; from_col: string | null; to_col: string; why: string }[];
  const notices = (to = "lead:demo") => (db.prepare(`SELECT sender, body FROM items WHERE recipient = ? AND kind = 'notice' ORDER BY rowid`).all(to) as { sender: string; body: string }[]).map((r) => ({ ...r }));
  const spawn = (threadId: string, task?: string) => {
    const plan = e.ask(lead, { title: "Start a thread?", question: "Start one thread?", options: opts, kind: "plan", threads: 1, ...(task ? { task } : {}) });
    e.triageAskPerson(cos, plan.id, { question: "Start one thread?", options: [], allowText: true });
    e.personAnswer(plan.id, e.decision(plan.id)!.rev, "1", null, "desktop");
    e.confirmSpawn(e.reserveSpawn(lead, plan.id), threadId);
    return e.register(threadId, "thread", "demo", "T-lead");
  };
  const tidy = (p: Parameters<Engine["boardTidy"]>[1]) => e.boardTidy(cos, p);
  return { e, db, cos, lead, clock, publish, board, task, cosMoves, notices, spawn, tidy, at: (m: number) => (clock.t = T0 + m * MIN) };
}

test("merge folds a duplicate into the task that carries on: everything moves, and the old id and title redirect", () => {
  const s = setup();
  const [a, b] = s.publish([{ title: "Login page", state: "current" }, { title: "Sign-in screen", state: "next" }]).steps.map((x) => x.id!);
  s.spawn("T-1", a);
  const card = s.e.ask(s.lead, { title: "Logo?", question: "Which logo?", options: opts, task: a });
  const d = s.e.deliver(s.lead, { title: "Login shots", summary: "Done.", proof, task: a }, place);
  // a plan card still naming the duplicate, not yet answered: its thread must not land on a dropped task later
  const plan = s.e.ask(s.lead, { title: "Another thread?", question: "Start one?", options: opts, kind: "plan", threads: 1, task: a });
  s.at(5);
  const text = s.tidy({ action: "merge", task: a, into: b });
  assert.match(text, new RegExp(`Merged ${a} "Login page" into ${b} "Sign-in screen"`));
  const into = s.task(b!);
  assert.deepEqual(into.threads.map((t) => t.threadId), ["T-1"]);
  assert.ok(into.cards.some((c) => c.id === card.id));
  assert.deepEqual(into.deliverables.map((x) => x.id), [d.id]);
  assert.equal(s.board().tasks.some((t) => t.id === a), false, "the merged task leaves the board");
  assert.equal(s.board().dropped.length, 0, "a merge is not a drop for the CoS to confirm");
  for (const sql of [`SELECT COUNT(*) AS c FROM spawns WHERE task = ?`, `SELECT COUNT(*) AS c FROM deliverables WHERE json_extract(json, '$.task') = ?`, `SELECT COUNT(*) AS c FROM decisions WHERE json_extract(json, '$.orchestrator.task') = ?`])
    assert.equal((s.db.prepare(sql).get(a!) as { c: number }).c, 0, `nothing names the merged id: ${sql}`);
  assert.equal(s.e.decision(plan.id)!.orchestrator.task, b, "the open plan card now names the task that carries on");
  assert.deepEqual(
    s.cosMoves().map((m) => [m.task, m.to_col, m.why]),
    [
      [a, "dropped", `cos: merge into ${b}`],
      [b, "waiting", `cos: merge ${a} "Login page" in`], // the deliverable in review came with it
    ],
  );
  assert.match(s.notices().at(-1)!.body, new RegExp(`The CoS merged task ${a} .* into ${b}`));
  assert.equal(s.notices().at(-1)!.sender, "cos");

  // the lead's next publish: the old id and the old title both mean the task that carries on
  const byId = s.publish([{ id: a, title: "Login page", state: "current" }]);
  assert.deepEqual(byId.steps.map((x) => x.id), [b]);
  const byTitle = s.publish([{ title: "login page", state: "current" }]);
  assert.deepEqual(byTitle.steps.map((x) => x.id), [b], "a re-sent old title never un-merges it");
  assert.equal((s.db.prepare(`SELECT state FROM tasks WHERE id = ?`).get(a!) as { state: string }).state, "dropped");
  assert.throws(() => s.publish([{ id: a, title: "Login page", state: "current" }, { id: b, title: "Sign-in screen", state: "next" }]), new RegExp(`are one task: the CoS merged ${a} into ${b}`));
  // a card naming the old id goes to the merged task
  const later = s.e.ask(s.lead, { title: "Copy?", question: "Which copy?", options: opts, task: a });
  assert.equal(s.e.decision(later.id)!.orchestrator.task, b);
});

test("merge refuses another project's task, itself, a shipped task and a dropped target", () => {
  const s = setup();
  const [a, b] = s.publish([{ title: "One", state: "current" }, { title: "Two", state: "next" }]).steps.map((x) => x.id!);
  const other = s.e.register("T-lead2", "lead", "other");
  const [o] = s.e.publishStatus(other, statusParams.parse({ goal: "g", steps: [{ title: "Theirs", state: "next" }] })).steps;
  assert.throws(() => s.tidy({ action: "merge", task: a, into: o!.id }), /only tasks of one project merge/);
  assert.throws(() => s.tidy({ action: "merge", task: a, into: a }), /into itself/);
  assert.throws(() => s.tidy({ action: "merge", task: a }), /merge needs into/);
  s.publish([{ id: a, title: "One", state: "done" }, { id: b, title: "Two", state: "current" }]);
  assert.throws(() => s.tidy({ action: "merge", task: a, into: b }), /has shipped/);
  assert.equal(s.cosMoves().length, 0, "a refusal logs nothing");
});

test("restore brings a dropped task back with its attachments; its lead is told to send it back", () => {
  const s = setup();
  const [a, b] = s.publish([{ title: "Keep", state: "current" }, { title: "Spike", state: "next" }]).steps.map((x) => x.id!);
  s.spawn("T-1", b);
  s.at(3);
  s.publish([{ id: a, title: "Keep", state: "current" }]);
  assert.deepEqual(s.board().dropped.map((x) => x.id), [b]);
  assert.equal(s.board().unfiled.threads.length, 1);
  s.at(5);
  assert.match(s.tidy({ action: "restore", task: b }), /1 attachment\(s\) came back/);
  const p = s.board();
  assert.equal(p.dropped.length, 0);
  assert.equal(p.unfiled.threads.length, 0);
  assert.equal(s.task(b!).state, "open");
  assert.deepEqual(s.task(b!).threads.map((t) => t.threadId), ["T-1"]);
  assert.deepEqual(s.cosMoves().map((m) => [m.task, m.from_col, m.to_col, m.why]), [[b, "dropped", "in_progress", "cos: restore"]]);
  assert.match(s.notices().at(-1)!.body, new RegExp(`Put it back in your next orch_status with id ${b}, or it drops again`));
  assert.throws(() => s.tidy({ action: "restore", task: b }), /is open, not dropped/);
});

test("confirm accepts a drop: it leaves the CoS's list, and its things stay Unfiled until filed", () => {
  const s = setup();
  const [a, b] = s.publish([{ title: "Keep", state: "current" }, { title: "Spike", state: "next" }]).steps.map((x) => x.id!);
  s.spawn("T-1", b);
  s.publish([{ id: a, title: "Keep", state: "current" }]);
  s.tidy({ action: "confirm", task: b });
  assert.equal(s.board().dropped.length, 0);
  assert.equal(s.board().unfiled.threads.length, 1);
  assert.deepEqual(s.cosMoves().map((m) => [m.from_col, m.to_col, m.why]), [["dropped", "dropped", "cos: confirm drop"]]);
  assert.throws(() => s.tidy({ action: "confirm", task: b }), /not a drop waiting/);
});

test("file attaches an Unfiled thread, PR, deliverable and card to a task, only within its project", () => {
  const s = setup();
  const [a] = s.publish([{ title: "Build", state: "next" }]).steps.map((x) => x.id!);
  const stray = s.e.register("T-9", "thread", "demo", "T-lead"); // started outside a plan: no task
  const holder = s.e.register("T-8", "thread", "demo", "T-lead");
  s.e.prSeen(holder, "E8", pr("open", 41));
  const d = s.e.deliver(s.lead, { title: "Loose shots", summary: "Done.", proof }, place);
  const c = s.e.ask(s.lead, { title: "Loose?", question: "Which?", options: opts });
  const u = s.board().unfiled;
  assert.equal(u.threads.length, 2);
  assert.equal(u.prs.length, 1);
  assert.equal(u.deliverables.length, 1);
  assert.equal(u.cards.length, 1);

  s.tidy({ action: "file", kind: "thread", ref: stray.address, task: a });
  s.tidy({ action: "file", kind: "pr", ref: "https://github.com/o/r/pull/41/", task: a });
  s.tidy({ action: "file", kind: "deliverable", ref: d.id, task: a });
  s.tidy({ action: "file", kind: "card", ref: c.id, task: a });
  const after = s.board();
  assert.deepEqual(after.unfiled, { threads: [], prs: [], deliverables: [], cards: [] }, "everything is on the task now");
  const t = s.task(a!);
  assert.deepEqual(t.threads.map((x) => x.threadId).sort(), ["T-8", "T-9"], "a PR files with the thread that holds it");
  assert.deepEqual(t.prs.map((x) => x.number), [41]);
  assert.deepEqual(t.deliverables.map((x) => x.id), [d.id]);
  assert.deepEqual(t.cards.map((x) => x.id), [c.id]);
  assert.deepEqual(
    s.cosMoves().map((m) => m.why),
    [`cos: file thread ${stray.address}`, "cos: file pr https://github.com/o/r/pull/41", `cos: file deliverable ${d.id}`, `cos: file card ${c.id}`],
  );
  assert.equal(s.notices().filter((n) => n.sender === "cos" && /^The CoS filed /.test(n.body)).length, 4);

  // another project's thread never files under this project's task; what isn't a PR URL never files as one
  const other = s.e.register("T-lead2", "lead", "other");
  const theirs = s.e.register("T-7", "thread", "other", "T-lead2");
  void other;
  assert.throws(() => s.tidy({ action: "file", kind: "thread", ref: theirs.address, task: a }), /file things only under their own project's tasks/);
  for (const bad of ["https://github.com/o/r/issues/5", "https://example.com/x", "github.com/o/r/pull/5", "https://github.com/o/r/pull/5?x=merged"])
    assert.throws(() => s.tidy({ action: "file", kind: "pr", ref: bad, task: a }), /is not a GitHub pull request URL/, bad);
  assert.throws(() => s.tidy({ action: "file", kind: "card", ref: c.id }), /file needs task/);
});

test("only the CoS may tidy: a lead or thread is refused and nothing changes", () => {
  const s = setup();
  const [a, b] = s.publish([{ title: "One", state: "current" }, { title: "Two", state: "next" }]).steps.map((x) => x.id!);
  const t = s.spawn("T-1", a);
  const steward = s.e.register("T-st", "steward", null);
  for (const who of [s.lead, t, steward]) {
    for (const p of [{ action: "list" as const }, { action: "merge" as const, task: a, into: b }]) assert.throws(() => s.e.boardTidy(who, p), /only the CoS tidies the work board/);
  }
  assert.equal(s.board().tasks.length, 2);
  assert.equal(s.cosMoves().length, 0);
});

test("list shows the CoS what to tidy: drops with attachments, Unfiled things, and the open tasks to file them under", () => {
  const s = setup();
  assert.match(s.tidy({ action: "list" }), /The board is tidy/);
  const [a, b] = s.publish([{ title: "Keep", state: "current" }, { title: "Spike", state: "next" }]).steps.map((x) => x.id!);
  s.spawn("T-1", b);
  s.publish([{ id: a, title: "Keep", state: "current" }]);
  const text = s.tidy({ action: "list" });
  assert.match(text, /## demo/);
  assert.match(text, new RegExp(`- ${b} "Spike": thread T-1`));
  assert.match(text, /- thread thread:demo:\d+ /);
  assert.match(text, new RegExp(`Open tasks: ${a} "Keep" \\[In progress\\]`));
});

test("a task whose PRs all merged but whose thread idles over a day is flagged to its lead, once a day", () => {
  const s = setup();
  const [a, b] = s.publish([{ title: "Search fix", state: "current" }, { title: "Docs", state: "next" }]).steps.map((x) => x.id!);
  const t = s.spawn("T-1", a);
  s.spawn("T-2", b); // idles too, but nothing of it merged: never flagged
  s.e.setEnvironment("T-1", "E1");
  s.e.setStatus("T-1", "active");
  s.e.prSeen(t, "E1", pr("merged", 31));
  s.e.setStatus("T-1", "idle");
  s.e.setStatus("T-2", "idle");
  const stale = () => s.notices().filter((n) => /^Looks finished but not Shipped/.test(n.body));
  assert.equal(s.task(a!).column, "in_progress", "the merged PR doesn't ship it while the thread is live");
  s.at(23 * 60);
  s.e.tick();
  assert.equal(stale().length, 0, "idle under a day: not yet");
  s.at(24 * 60 + 2);
  s.e.tick();
  assert.equal(stale().length, 1);
  assert.match(stale()[0]!.body, new RegExp(`- ${a} "Search fix": thread:demo:\\d+ idle over a day`));
  assert.doesNotMatch(stale()[0]!.body, new RegExp(b!), "the task with nothing merged is not flagged");
  for (const m of [24 * 60 + 5, 30 * 60, 47 * 60]) {
    s.at(m);
    s.e.tick();
  }
  assert.equal(stale().length, 1, "once a day at most");
  s.at(48 * 60 + 3);
  s.e.tick();
  assert.equal(stale().length, 2, "still stuck a day later: told again");
  // the thread goes back to work: no flag while it works, and it is idle under a day again after
  s.e.setStatus("T-1", "active");
  s.at(73 * 60);
  s.e.tick();
  assert.equal(stale().length, 2);
  s.e.retire("T-1");
  assert.equal(s.task(a!).column, "shipped", "resolved: it ships, and there is nothing to flag");
});

test("a step list naming a task and the id merged into it, in either order, is refused with the merge spelled out", () => {
  const s = setup();
  const [a, b] = s.publish([{ title: "Login page", state: "current" }, { title: "Sign-in screen", state: "next" }]).steps.map((x) => x.id!);
  s.tidy({ action: "merge", task: a, into: b });
  assert.throws(() => s.publish([{ id: b, title: "Sign-in screen", state: "current" }, { id: a, title: "Login page", state: "next" }]), new RegExp(`steps ${b} and ${a} are one task: the CoS merged ${a} into ${b}`));
  assert.throws(() => s.publish([{ id: b, title: "Sign-in screen", state: "current" }, { title: "Login page", state: "next" }]), new RegExp(`"Login page" was merged into ${b}`));
});

test("a PR no thread holds files itself: its state is gh's reading, unknown until read, and only merged ships the task", () => {
  const s = setup();
  const [a] = s.publish([{ title: "Hotfix", state: "current" }]).steps.map((x) => x.id!);
  const url = "https://github.com/o/r/pull/77";
  // the tool takes a URL and nothing else: the caller has no way to say the PR merged
  assert.match(s.tidy({ action: "file", kind: "pr", ref: `${url}/`, task: a }), /no thread holds it; the next PR pass reads its state from GitHub/);
  assert.deepEqual(s.e.linkedPrsToRead(), [url], "the wait pass will read it with gh");
  let t = s.task(a!);
  assert.deepEqual(
    t.prs.map((p) => [p.url, p.state]),
    [[url, null]],
    "filed, not read yet: unknown",
  );
  assert.notEqual(t.column, "shipped", "an unknown PR never ships its task");
  assert.deepEqual(s.cosMoves().at(-1)!.why, `cos: file pr ${url}`);

  // gh reads it open: on the task, not shipped, and still read on the next pass
  s.at(5);
  s.e.waitPrSeen(pr("open", 77));
  s.e.tick();
  t = s.task(a!);
  assert.deepEqual(t.prs.map((p) => [p.number, p.state]), [[77, "open"]]);
  assert.notEqual(t.column, "shipped", "an open PR filed this way does not ship the task");
  assert.deepEqual(s.e.linkedPrsToRead(), [url]);
  s.e.pruneWaitReadings();
  assert.equal(s.task(a!).prs[0]!.state, "open", "no wait names it, but the filed PR keeps its reading");

  // the same PR read later as merged ships it, and gh stops reading it
  s.at(60);
  s.e.waitPrSeen(pr("merged", 77));
  s.e.tick();
  t = s.task(a!);
  assert.equal(t.prs[0]!.state, "merged");
  assert.equal(t.column, "shipped", "merged per GitHub: the task ships");
  assert.deepEqual(s.e.linkedPrsToRead(), [], "a settled PR is not read again");
});

test("a filed PR no thread holds moves on a refile and follows a merge of its task", () => {
  const s = setup();
  const [a, b, c] = s.publish([{ title: "One", state: "current" }, { title: "Two", state: "next" }, { title: "Three", state: "next" }]).steps.map((x) => x.id!);
  const url = "https://github.com/o/r/pull/88";
  s.tidy({ action: "file", kind: "pr", ref: url, task: a });
  assert.match(s.tidy({ action: "file", kind: "pr", ref: url, task: b }), new RegExp(`it was on ${a}`));
  assert.deepEqual([s.task(a!).prs.length, s.task(b!).prs.length], [0, 1], "one PR, one task");
  s.tidy({ action: "merge", task: b, into: c });
  assert.deepEqual(s.task(c!).prs.map((p) => p.url), [url], "it moved with the merge");
});

test("a thread the CoS moves to another task takes its PR links along; a merge into a task that has the PR keeps one link", () => {
  const s = setup();
  const [a, b, c] = s.publish([{ title: "One", state: "current" }, { title: "Two", state: "next" }, { title: "Three", state: "next" }]).steps.map((x) => x.id!);
  const th = s.spawn("T-1", a);
  s.e.setEnvironment("T-1", "E1");
  s.e.prSeen(th, "E1", pr("open", 51)); // bb's reading links it to the thread's task, by the thread
  const links = () => s.db.prepare(`SELECT url, task, via, by FROM task_prs ORDER BY task, url`).all().map((r) => ({ ...r }));
  assert.deepEqual(links(), [{ url: "https://github.com/o/r/pull/51", task: a, via: "bb", by: th.address }]);

  // filed under b, the thread's link moves in the same change: a stays clean, b has the PR now
  s.tidy({ action: "file", kind: "thread", ref: th.address, task: b });
  assert.deepEqual(links(), [{ url: "https://github.com/o/r/pull/51", task: b, via: "bb", by: th.address }]);
  assert.deepEqual([s.task(a!).prs.length, s.task(b!).prs.length], [0, 1], "the PR went with its thread");

  // c already has the same PR (the CoS filed it there): merging b into c leaves one link, never a key clash
  s.tidy({ action: "file", kind: "pr", ref: "https://github.com/o/r/pull/51", task: c });
  s.tidy({ action: "merge", task: b, into: c });
  assert.deepEqual(
    links().filter((l) => l.task === c).map((l) => l.url),
    ["https://github.com/o/r/pull/51"],
  );
  assert.equal((links() as { task: string }[]).filter((l) => l.task === b).length, 0, "nothing stays on the merged task");
});

test("filing a PR no thread holds moves only the CoS's own link: one a thread reported stays on its task", () => {
  const s = setup();
  const [a, b] = s.publish([{ title: "One", state: "current" }, { title: "Two", state: "next" }]).steps.map((x) => x.id!);
  const url = "https://github.com/o/r/pull/61";
  // a link that came another way (a report through a thread since retired): the PR is shared by two tasks, two links
  s.db.prepare(`INSERT INTO task_prs (url, task, project, via, by, first_at) VALUES (?, ?, 'demo', 'report', 'thread:demo:9', 0)`).run(url, a);
  s.tidy({ action: "file", kind: "pr", ref: url, task: b });
  assert.deepEqual(
    s.db.prepare(`SELECT task, via FROM task_prs WHERE url = ? ORDER BY task`).all(url).map((r) => ({ ...r })),
    [
      { task: a, via: "report" },
      { task: b, via: "cos" },
    ].sort((x, y) => (x.task < y.task ? -1 : 1)),
  );
});

// Codex's review of a754e92: a tidy must never make a task wrongly Shipped. Filing brings what the attachment carries
// (the shared retained-evidence pass restore and the upgrade use), a thread's move keeps on its old task what is still
// needed there, and a lead's done task never swallows unfinished work.
const linksOf = (s: ReturnType<typeof setup>, url: string) => s.db.prepare(`SELECT task FROM task_prs WHERE url = ? ORDER BY task`).all(url).map((r) => (r as { task: string }).task);

test("filing an approved Unfiled deliverable brings its open PR: the task waits on the PR instead of shipping", () => {
  const s = setup();
  const [a] = s.publish([{ title: "Report", state: "next" }]).steps.map((x) => x.id!);
  const url = "https://github.com/o/r/pull/71";
  const d = s.e.deliver(s.lead, { title: "The report", summary: "Done.", proof: [{ kind: "pr", caption: "the PR", url }] }, place);
  s.e.personApprove(d.id, 1, null);
  s.tidy({ action: "file", kind: "deliverable", ref: d.id, task: a });
  assert.deepEqual(linksOf(s, url), [a]);
  assert.notEqual(s.task(a!).column, "shipped", "approved, but its PR is not known to be merged");
});

test("filing a card brings its PR block, and a thread from a dropped task brings its PRs and leaves none behind", () => {
  const s = setup();
  const [k, a, b] = s.publish([{ title: "Keep", state: "current" }, { title: "Spike", state: "next" }, { title: "Build", state: "next" }]).steps.map((x) => x.id!);
  const card = s.e.ask(s.lead, { title: "Merge?", question: "Merge #72?", options: opts, blocks: [{ kind: "pr", url: "https://github.com/o/r/pull/72" }] });
  s.tidy({ action: "file", kind: "card", ref: card.id, task: b });
  assert.deepEqual(linksOf(s, "https://github.com/o/r/pull/72"), [b]);

  const th = s.spawn("T-1", a);
  s.e.setEnvironment("T-1", "E1");
  s.e.prSeen(th, "E1", pr("open", 73));
  s.publish([{ id: k, title: "Keep", state: "current" }, { id: b, title: "Build", state: "next" }]); // a drops: T-1 is Unfiled
  s.tidy({ action: "file", kind: "thread", ref: th.address, task: b });
  assert.deepEqual(linksOf(s, "https://github.com/o/r/pull/73"), [b], "the PR went with its thread, off the dropped task");
  assert.ok(s.task(b!).prs.some((p) => p.number === 73));
});

test("after a merge two threads share one PR link: moving one thread on keeps the PR on the task the other still works", () => {
  const s = setup();
  const [a, b, c] = s.publish([{ title: "One", state: "current" }, { title: "Two", state: "next" }, { title: "Three", state: "next" }]).steps.map((x) => x.id!);
  const url = "https://github.com/o/r/pull/74";
  const ta = s.spawn("T-1", a);
  const tb = s.spawn("T-2", b);
  s.e.setEnvironment("T-1", "E1");
  s.e.setEnvironment("T-2", "E2");
  s.e.prSeen(tb, "E2", pr("open", 74));
  s.e.prSeen(ta, "E1", pr("open", 74));
  s.tidy({ action: "merge", task: a, into: b }); // b keeps one link for #74, by T-2
  s.tidy({ action: "file", kind: "thread", ref: tb.address, task: c });
  assert.deepEqual(linksOf(s, url), [b, c].sort(), "T-1 is still on b with #74 open: b keeps the link");
  assert.ok(s.task(b!).prs.some((p) => p.number === 74 && p.state === "open"));
  void ta;
});

test("a merge into a task its lead marked done is refused while the incoming task has unfinished work, and writes nothing", () => {
  const s = setup();
  const [a, b, c] = s.publish([{ title: "Polish", state: "current" }, { title: "Ship it", state: "next" }, { title: "Empty", state: "next" }]).steps.map((x) => x.id!);
  s.e.setEnvironment("T-1", "E1");
  const th = s.spawn("T-1", a);
  s.e.prSeen(th, "E1", pr("open", 75));
  s.publish([{ id: a, title: "Polish", state: "current" }, { id: b, title: "Ship it", state: "done" }, { id: c, title: "Empty", state: "next" }]);
  assert.equal(s.task(b!).column, "shipped");
  const before = JSON.stringify([s.db.prepare(`SELECT * FROM task_prs ORDER BY url, task`).all(), s.db.prepare(`SELECT id, state, merged_into FROM tasks ORDER BY id`).all(), s.db.prepare(`SELECT thread_id, task FROM spawns ORDER BY thread_id`).all()]);
  assert.throws(() => s.tidy({ action: "merge", task: a, into: b }), /has shipped \(its lead marked it done\).*live thread thread:demo:\d+.*PR https:\/\/github.com\/o\/r\/pull\/75 \(open when last read/);
  assert.equal(JSON.stringify([s.db.prepare(`SELECT * FROM task_prs ORDER BY url, task`).all(), s.db.prepare(`SELECT id, state, merged_into FROM tasks ORDER BY id`).all(), s.db.prepare(`SELECT thread_id, task FROM spawns ORDER BY thread_id`).all()]), before, "the refusal writes nothing");
  assert.equal(s.cosMoves().length, 0);
  // a task with nothing unfinished still folds into a done one
  assert.match(s.tidy({ action: "merge", task: c, into: b }), /Merged/);
});

// Codex's review of db5a220: every owner of a link is stored (task_pr_owners), so a link goes only when its last owner
// leaves, even after the evidence that made it is pruned; and an unresolved card is unfinished work too.
const pruneReports = (s: ReturnType<typeof setup>) => s.db.prepare(`DELETE FROM board WHERE kind = 'pr'`).run();

test("two threads report one PR and the reports are pruned: after a merge, moving one thread keeps the PR for the other", () => {
  const s = setup();
  const [a, b, c] = s.publish([{ title: "One", state: "current" }, { title: "Two", state: "next" }, { title: "Three", state: "next" }]).steps.map((x) => x.id!);
  const url = "https://github.com/o/r/pull/81";
  const ta = s.spawn("T-1", a);
  const tb = s.spawn("T-2", b);
  s.e.report(tb, "PR up", "It's up.", url);
  s.e.report(ta, "PR up", "It's up.", url);
  pruneReports(s); // retention: nothing left to rebuild either thread's claim from
  s.tidy({ action: "merge", task: a, into: b }); // b's one link, two owners
  s.tidy({ action: "file", kind: "thread", ref: tb.address, task: c });
  assert.deepEqual(linksOf(s, url), [b, c].sort(), "T-1 is still on b with the PR unread: b keeps the link");
  s.tidy({ action: "file", kind: "thread", ref: ta.address, task: c });
  assert.deepEqual(linksOf(s, url), [c], "the last owner left b: the link goes with it");
});

test("a CoS link deduplicated against a thread's link stays when the thread moves on", () => {
  const s = setup();
  const [a, c] = s.publish([{ title: "One", state: "current" }, { title: "Three", state: "next" }]).steps.map((x) => x.id!);
  const url = "https://github.com/o/r/pull/82";
  const th = s.spawn("T-1", a);
  s.e.report(th, "PR up", "It's up.", url);
  pruneReports(s); // no thread holds it any more: the CoS files it on a, where the thread's link already is
  assert.match(s.tidy({ action: "file", kind: "pr", ref: url, task: a }), /no thread holds it/);
  s.tidy({ action: "file", kind: "thread", ref: th.address, task: c });
  assert.deepEqual(linksOf(s, url), [a, c].sort(), "the CoS's own filing keeps the PR on a");
});

test("a merge into a task its lead marked done is refused while the incoming task has a question waiting on the owner", () => {
  const s = setup();
  const [a, b] = s.publish([{ title: "Ask", state: "current" }, { title: "Done", state: "next" }]).steps.map((x) => x.id!);
  const card = s.e.ask(s.lead, { title: "Which logo?", question: "Which logo?", options: opts, task: a });
  s.e.triageAskPerson(s.cos, card.id, { question: "Which logo?", options: opts, allowText: true });
  s.publish([{ id: a, title: "Ask", state: "current" }, { id: b, title: "Done", state: "done" }]);
  const before = JSON.stringify([s.db.prepare(`SELECT id, state, merged_into FROM tasks ORDER BY id`).all(), s.db.prepare(`SELECT id, json FROM decisions ORDER BY id`).all()]);
  assert.throws(() => s.tidy({ action: "merge", task: a, into: b }), new RegExp(`still has unfinished work: card ${card.id} "Which logo\\?" \\(waiting on the owner\\)`));
  assert.equal(JSON.stringify([s.db.prepare(`SELECT id, state, merged_into FROM tasks ORDER BY id`).all(), s.db.prepare(`SELECT id, json FROM decisions ORDER BY id`).all()]), before, "the refusal writes nothing");
});

test("the owners migration is appended last and gives each existing link its owner, so a link from before it moves like any other", () => {
  const s = setup();
  const at = MIGRATIONS.findIndex((m) => m.startsWith("CREATE TABLE task_pr_owners ("));
  assert.ok(at > MIGRATIONS.findIndex((m) => m.startsWith("ALTER TABLE tasks ADD COLUMN merged_into")), "appended after the tidy's own migration");
  const [a, c] = s.publish([{ title: "One", state: "current" }, { title: "Three", state: "next" }]).steps.map((x) => x.id!);
  const th = s.spawn("T-1", a);
  // a DB from before the table: its links have no owner rows
  s.db.exec(`DROP TABLE task_pr_owners`);
  s.db.prepare(`DELETE FROM _migrations WHERE id = ?`).run(at);
  s.db.prepare(`INSERT INTO task_prs (url, task, project, via, by, first_at) VALUES (?, ?, 'demo', 'report', ?, 1), (?, ?, 'demo', 'cos', NULL, 2)`).run("https://github.com/o/r/pull/91", a, th.address, "https://github.com/o/r/pull/92", a);
  migrate(s.db as never);
  assert.deepEqual(
    s.db.prepare(`SELECT url, task, by, via FROM task_pr_owners ORDER BY url`).all().map((r) => ({ ...r })),
    [
      { url: "https://github.com/o/r/pull/91", task: a, by: th.address, via: "report" },
      { url: "https://github.com/o/r/pull/92", task: a, by: "", via: "cos" },
    ],
  );
  s.tidy({ action: "file", kind: "thread", ref: th.address, task: c });
  assert.deepEqual([linksOf(s, "https://github.com/o/r/pull/91"), linksOf(s, "https://github.com/o/r/pull/92")], [[c], [a]], "the thread's link went with it; the CoS's stayed");
});

// Codex's review of 6a8f976: the owners migration stores every owner it can still recover, filing onto a done task is
// refused like a merge, and the board names a link's holder from its current owners.
test("the owners migration stores both threads' reports of one PR, so a move after retention keeps the link for the other", () => {
  const s = setup();
  const at = MIGRATIONS.findIndex((m) => m.startsWith("CREATE TABLE task_pr_owners ("));
  const [a, c] = s.publish([{ title: "One", state: "current" }, { title: "Three", state: "next" }]).steps.map((x) => x.id!);
  const url = "https://github.com/o/r/pull/93";
  const t1 = s.spawn("T-1", a);
  const t2 = s.spawn("T-2", a);
  s.e.report(t1, "PR up", "It's up.", url);
  s.e.report(t2, "PR up", "Same PR.", url);
  // the DB as it was before the owners table: one link (by T-1), both reports still there
  s.db.exec(`DROP TABLE task_pr_owners`);
  s.db.prepare(`DELETE FROM _migrations WHERE id = ?`).run(at);
  migrate(s.db as never);
  assert.deepEqual(s.db.prepare(`SELECT by FROM task_pr_owners WHERE url = ? AND task = ? ORDER BY by`).all(url, a).map((r) => (r as { by: string }).by), [t1.address, t2.address].sort());
  pruneReports(s);
  s.tidy({ action: "file", kind: "thread", ref: t1.address, task: c });
  assert.deepEqual(linksOf(s, url), [a, c].sort(), "T-2 is still on a with the PR unread: a keeps the link");
  assert.equal(s.db.prepare(`SELECT COUNT(*) AS n FROM task_prs`).get()!.n, 2, "the backfill adds owners, never links");
});

test("filing onto a task its lead marked done is refused for each kind that brings unfinished work, and writes nothing", () => {
  const s = setup();
  const [k, b] = s.publish([{ title: "Keep", state: "current" }, { title: "Done", state: "next" }]).steps.map((x) => x.id!);
  const stray = s.e.register("T-9", "thread", "demo", "T-lead"); // live, on no task
  const card = s.e.ask(s.lead, { title: "Which logo?", question: "Which logo?", options: opts });
  s.e.triageAskPerson(s.cos, card.id, { question: "Which logo?", options: opts, allowText: true });
  const d = s.e.deliver(s.lead, { title: "Shots", summary: "Done.", proof }, place);
  s.publish([{ id: k, title: "Keep", state: "current" }, { id: b, title: "Done", state: "done" }]);
  const state = () => JSON.stringify([s.db.prepare(`SELECT * FROM task_prs ORDER BY url, task`).all(), s.db.prepare(`SELECT * FROM task_pr_owners ORDER BY url, task, by`).all(), s.db.prepare(`SELECT thread_id, task FROM spawns ORDER BY thread_id`).all(), s.db.prepare(`SELECT id, json FROM decisions ORDER BY id`).all(), s.db.prepare(`SELECT id, json FROM deliverables ORDER BY id`).all(), s.db.prepare(`SELECT COUNT(*) FROM task_moves`).all()]);
  const before = state();
  const cases: [string, string, RegExp][] = [
    ["thread", stray.address, new RegExp(`thread ${stray.address} brings unfinished work: live thread ${stray.address}`)],
    ["card", card.id, new RegExp(`card ${card.id} "Which logo\\?" \\(waiting on the owner\\)`)],
    ["deliverable", d.id, new RegExp(`deliverable ${d.id} \\(review\\)`)],
    ["pr", "https://github.com/o/r/pull/94", /PR https:\/\/github.com\/o\/r\/pull\/94 brings unfinished work: PR https:\/\/github.com\/o\/r\/pull\/94 \(not read yet: queued for the next PR pass; file again after it\)/],
  ];
  for (const [kind, ref, why] of cases) {
    assert.throws(() => s.tidy({ action: "file", kind: kind as "thread", ref, task: b }), (e: Error) => /has shipped \(its lead marked it done\)/.test(e.message) && why.test(e.message), kind);
    assert.equal(state(), before, `a refused ${kind} writes nothing`);
  }
});

test("the board names a shared PR's holder from the owners still on the task, not the thread that first linked it", () => {
  const s = setup();
  const [a, b, c] = s.publish([{ title: "One", state: "current" }, { title: "Two", state: "next" }, { title: "Three", state: "next" }]).steps.map((x) => x.id!);
  const url = "https://github.com/o/r/pull/95";
  const ta = s.spawn("T-1", a);
  const tb = s.spawn("T-2", b);
  s.e.report(tb, "PR up", "It's up.", url); // b's link: first sight T-2
  s.e.report(ta, "PR up", "It's up.", url);
  s.tidy({ action: "merge", task: a, into: b });
  s.tidy({ action: "file", kind: "thread", ref: tb.address, task: c });
  assert.equal(s.db.prepare(`SELECT by FROM task_prs WHERE url = ? AND task = ?`).get(url, b)!.by, tb.address, "the link row still names its first sight");
  assert.equal(s.task(b!).prs.find((p) => p.url === url)!.thread, ta.address, "b shows the thread still on it");
  assert.equal(s.task(c!).prs.find((p) => p.url === url)!.thread, tb.address);
  assert.ok(touches({ tables: ["task_pr_owners"] }, "workBoard"), "an owner change refetches the board");
});

// the lead's call on the refusal above: a PR nobody has read can't be judged, so the refusal queues it for the next PR
// pass (pr_read_requests, no link, no GitHub call here), and once that pass reads it merged the same filing succeeds
test("a PR nobody has read is refused onto a done task, read by the next PR pass, then files", () => {
  const s = setup();
  const [k, b] = s.publish([{ title: "Keep", state: "current" }, { title: "Done", state: "next" }]).steps.map((x) => x.id!);
  s.publish([{ id: k, title: "Keep", state: "current" }, { id: b, title: "Done", state: "done" }]);
  const url = "https://github.com/o/r/pull/96";
  assert.throws(() => s.tidy({ action: "file", kind: "pr", ref: url, task: b }), /PR https:\/\/github.com\/o\/r\/pull\/96 \(not read yet: queued for the next PR pass; file again after it\)/);
  assert.deepEqual(linksOf(s, url), [], "still no link");
  assert.ok(s.e.linkedPrsToRead().includes(url), "the next PR pass reads it");
  s.e.waitPrSeen(pr("merged", 96)); // what that pass does with gh's reading
  s.e.pruneWaitReadings();
  assert.ok(!s.e.linkedPrsToRead().includes(url), "read merged: not read again");
  assert.match(s.tidy({ action: "file", kind: "pr", ref: url, task: b }), /Filed PR/);
  assert.deepEqual(linksOf(s, url), [b]);
  assert.equal(s.task(b!).column, "shipped");
  s.e.pruneWaitReadings();
  assert.equal(s.db.prepare(`SELECT COUNT(*) AS n FROM pr_read_requests`).get()!.n, 0, "filed: the request ends");
});

// Codex's review of 709a962 (shipped at a7b6153, fixed in the next patch): what a filing brings is every PR that gains
// an owner on the target, whoever owns it, and a link whose owners name nobody shows no holder.
function retiredAskerWithLeadWait(s: ReturnType<typeof setup>, waitPr: number) {
  const stray = s.e.register("T-9", "thread", "demo", "T-lead"); // on no task
  const q = s.e.ask(stray, { title: "Merge?", question: "Merge it?", options: opts });
  s.e.forward(s.lead, q.id, null);
  s.e.triageAskPerson(s.cos, q.id, { question: "Merge it?", options: opts, allowText: true });
  s.e.personAnswer(q.id, s.e.decision(q.id)!.rev, "1", null, "desktop");
  s.e.ack(s.lead, q.id, "done", null, { pr: `https://github.com/o/r/pull/${waitPr}`, when: "merged" }); // the lead's wait, bound to the thread's card
  return stray;
}

test("filing a retired thread onto a done task is refused when it brings a lead's PR wait bound to a card it asked", () => {
  const s = setup();
  const [k, b] = s.publish([{ title: "Keep", state: "current" }, { title: "Done", state: "next" }]).steps.map((x) => x.id!);
  const stray = retiredAskerWithLeadWait(s, 97);
  s.e.retire("T-9");
  s.publish([{ id: k, title: "Keep", state: "current" }, { id: b, title: "Done", state: "done" }]);
  assert.throws(() => s.tidy({ action: "file", kind: "thread", ref: stray.address, task: b }), /brings unfinished work: PR https:\/\/github.com\/o\/r\/pull\/97 \(not read yet/);
  assert.deepEqual(linksOf(s, "https://github.com/o/r/pull/97"), [], "the refusal writes nothing");
});

test("filing a merged PR through its retired holder is refused when the holder brings a lead's unread PR wait", () => {
  const s = setup();
  const [k, b] = s.publish([{ title: "Keep", state: "current" }, { title: "Done", state: "next" }]).steps.map((x) => x.id!);
  const stray = retiredAskerWithLeadWait(s, 97);
  s.e.setEnvironment("T-9", "E9");
  s.e.prSeen(stray, "E9", pr("merged", 98));
  s.e.retire("T-9");
  s.publish([{ id: k, title: "Keep", state: "current" }, { id: b, title: "Done", state: "done" }]);
  assert.throws(() => s.tidy({ action: "file", kind: "pr", ref: "https://github.com/o/r/pull/98", task: b }), (e: Error) => /PR https:\/\/github.com\/o\/r\/pull\/97 \(not read yet/.test(e.message) && !/pull\/98 \(/.test(e.message));
  assert.deepEqual([linksOf(s, "https://github.com/o/r/pull/97"), linksOf(s, "https://github.com/o/r/pull/98")], [[], []]);
});

test("a link whose only owner left is the CoS's own filing shows no holder, not the thread that first linked it", () => {
  const s = setup();
  const [a, c] = s.publish([{ title: "One", state: "current" }, { title: "Three", state: "next" }]).steps.map((x) => x.id!);
  const url = "https://github.com/o/r/pull/99";
  const th = s.spawn("T-1", a);
  s.e.report(th, "PR up", "It's up.", url);
  pruneReports(s);
  s.tidy({ action: "file", kind: "pr", ref: url, task: a }); // no thread holds it now: the CoS's own owner, deduped on a's link
  s.tidy({ action: "file", kind: "thread", ref: th.address, task: c });
  assert.equal(s.db.prepare(`SELECT by FROM task_prs WHERE url = ? AND task = ?`).get(url, a)!.by, th.address, "the link row still names its first sight");
  assert.equal(s.task(a!).prs.find((p) => p.url === url)!.thread, null);
  assert.equal(s.task(c!).prs.find((p) => p.url === url)!.thread, th.address);
});

// From the live filing (2026-11-25): a PR last read "open" by a thread since resolved is never polled again, so a
// refusal queues every PR not read merged or closed, not only unread ones; the next pass reads it, and filing succeeds
test("a PR last read open by a retired holder and merged since is queued by the refusal, read merged, then files", () => {
  const s = setup();
  const [k, b] = s.publish([{ title: "Keep", state: "current" }, { title: "Done", state: "next" }]).steps.map((x) => x.id!);
  const holder = s.e.register("T-9", "thread", "demo", "T-lead");
  s.e.setEnvironment("T-9", "E9");
  s.e.prSeen(holder, "E9", pr("open", 100));
  s.e.retire("T-9");
  s.publish([{ id: k, title: "Keep", state: "current" }, { id: b, title: "Done", state: "done" }]);
  const url = "https://github.com/o/r/pull/100";
  assert.throws(() => s.tidy({ action: "file", kind: "pr", ref: url, task: b }), /PR https:\/\/github.com\/o\/r\/pull\/100 \(open when last read: queued to be read again by the next PR pass; file again after it\)/);
  assert.deepEqual(s.db.prepare(`SELECT url FROM pr_read_requests`).all().map((r) => (r as { url: string }).url), [url]);
  assert.ok(s.e.linkedPrsToRead().includes(url));
  s.at(10);
  s.e.waitPrSeen(pr("merged", 100)); // the pass's reading
  s.e.pruneWaitReadings();
  assert.match(s.tidy({ action: "file", kind: "pr", ref: url, task: b }), /Filed PR/);
  assert.equal(s.task(b!).column, "shipped");
});

test("a PR that is really open is queued once by repeated refusals: one request, read each pass, refused until it merges", () => {
  const s = setup();
  const [k, b] = s.publish([{ title: "Keep", state: "current" }, { title: "Done", state: "next" }]).steps.map((x) => x.id!);
  s.publish([{ id: k, title: "Keep", state: "current" }, { id: b, title: "Done", state: "done" }]);
  const url = "https://github.com/o/r/pull/101";
  for (let i = 0; i < 3; i++) {
    s.at(i * 10);
    assert.throws(() => s.tidy({ action: "file", kind: "pr", ref: url, task: b }), /queued/);
    s.e.waitPrSeen(pr("open", 101)); // each pass reads it open again
    s.e.pruneWaitReadings();
  }
  assert.equal(s.db.prepare(`SELECT COUNT(*) AS n FROM pr_read_requests`).get()!.n, 1, "one request, never more");
  assert.deepEqual(linksOf(s, url), []);
  s.at(24 * 60 + 40); // a day after the last refusal, the request ends
  s.e.pruneWaitReadings();
  assert.equal(s.db.prepare(`SELECT COUNT(*) AS n FROM pr_read_requests`).get()!.n, 0);
});
