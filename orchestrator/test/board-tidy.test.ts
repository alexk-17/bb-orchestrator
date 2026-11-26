import assert from "node:assert/strict";
import { test } from "node:test";
import { DatabaseSync } from "node:sqlite";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { Engine, type PrResult } from "../core/engine.ts";
import { MIGRATIONS, migrate } from "../core/db.ts";
import { statusParams } from "../core/status.ts";
import { addressTask, linkPr } from "../core/tasks.ts";
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

// A tidy must never make a task wrongly Shipped. Filing brings what the attachment carries
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

// Every owner of a link is stored (task_pr_owners), so a link goes only when its last owner
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

// The owners migration stores every owner it can still recover, filing onto a done task is
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

// A PR nobody has read can't be judged, so the refusal queues it for the next PR
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

// What a filing brings is every PR that gains
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

// A PR last read "open" by a thread since resolved is never polled again, so a
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

test("list shows each project's Shipped tasks, newest first and bounded, so merged work can be filed under one that shipped weeks ago", () => {
  const s = setup();
  const DAY = 24 * HOUR;
  const shipped: string[] = [];
  for (let i = 1; i <= 7; i++) {
    s.clock.t = T0 + (i - 1) * DAY;
    shipped.push(s.publish([{ title: "Keep", state: "current" }, { title: `Ship ${i}`, state: "done" }]).steps[1]!.id!);
  }
  s.db.prepare(`INSERT INTO tasks (id, project, title, norm, state, created_at) VALUES ('t-0000aa', 'demo', 'Old ship', 'old ship', 'shipped', ?)`).run(T0);
  s.clock.t = T0 + 20 * DAY;
  const otherLead = s.e.register("T-lead2", "lead", "other");
  const [theirs, undated] = s.e.publishStatus(otherLead, statusParams.parse({ goal: "Other work", steps: [{ title: "Their ship", state: "done" }, { title: "Their old ship", state: "done" }] })).steps.map((x) => x.id!);
  s.db.prepare(`UPDATE tasks SET shipped_at = NULL WHERE id = ?`).run(undated); // as the upgrade left a done step
  s.clock.t = T0 + 30 * DAY; // every one shipped before the board's one-week window
  const text = s.tidy({ action: "list", project: "demo" });
  assert.ok(!text.includes(theirs), "a project lists only its own Shipped tasks");
  const newest = [7, 6, 5, 4, 3].map((i) => `${shipped[i - 1]} "Ship ${i}" \\[Shipped 2026-11-${22 + i}\\]`);
  assert.match(text, new RegExp(`Shipped tasks \\(newest first\\): ${newest.join("; ")}; and 2 older`), "the newest five, then a count");
  for (const id of [shipped[0], shipped[1]]) assert.ok(!text.includes(id!), `${id} is counted, not listed`);
  assert.ok(!text.includes("t-0000aa"), "an undated task out of its lead's list is on no board, and the filing guard reads the board: not offered");
  assert.match(text, /Open tasks: t-[0-9a-f]{6} "Keep" \[In progress\]/, "open tasks are listed as before");
  const all = s.tidy({ action: "list" });
  assert.match(all, new RegExp(`## other\\nNo open tasks\\.\\nShipped tasks \\(newest first\\): ${theirs} "Their ship" \\[Shipped 2026-12-13\\]; ${undated} "Their old ship" \\[Shipped\\]$`, "m"), "with nothing to tidy, a project still shows its Shipped tasks: a wrong PR on one is the CoS's to find");
  assert.match(all, new RegExp(`## demo\\n[^#]*${newest.join("; ")}; and 2 older`));
  for (const [n, task] of [[140, shipped[6]!], [141, undated!]] as const) {
    s.e.waitPrSeen(pr("merged", n));
    assert.match(s.tidy({ action: "file", kind: "pr", ref: `https://github.com/o/r/pull/${n}`, task }), /Filed PR/, "a listed Shipped task, dated or not, is a target file accepts merged work on");
  }
});

test("filing a PR through its retired holder never drags along a PR already filed under another project's task", () => {
  const s = setup();
  const [, a, c] = s.publish([{ title: "Keep", state: "current" }, { title: "Merged work", state: "next" }, { title: "Other step", state: "next" }]).steps.map((x) => x.id!);
  const otherLead = s.e.register("T-lead2", "lead", "other");
  const [o] = s.e.publishStatus(otherLead, statusParams.parse({ goal: "Other work", steps: [{ title: "Merge all the PRs", state: "current" }] })).steps.map((x) => x.id!);
  const holder = s.e.register("T-9", "thread", "demo", "T-lead"); // on no task
  s.e.setEnvironment("T-9", "E9");
  s.e.prSeen(holder, "E9", pr("merged", 110));
  const url = (n: number) => `https://github.com/o/r/pull/${n}`;
  for (const n of [111, 112, 113]) s.e.report(holder, `PR ${n}`, "Up.", url(n));
  s.tidy({ action: "file", kind: "pr", ref: url(111), task: o! }); // reported in passing, filed under the other project's task
  s.tidy({ action: "file", kind: "pr", ref: url(113), task: c! }); // filed under another task of the same project
  s.e.retire("T-9");
  s.tidy({ action: "file", kind: "pr", ref: url(110), task: a! });
  assert.deepEqual(linksOf(s, url(111)), [o], "the other project's PR stays where the CoS filed it");
  assert.deepEqual(linksOf(s, url(110)), [a]);
  assert.deepEqual(linksOf(s, url(112)), [a], "a PR the holder reported that no task has still comes with it");
  assert.deepEqual(linksOf(s, url(113)), [a, c].sort(), "a PR on another task of the same project is shared, as before");
});

test("filing through a retired holder onto a done task still refuses its unread PR, and never names another project's PR", () => {
  const s = setup();
  const [k, b] = s.publish([{ title: "Keep", state: "current" }, { title: "Done", state: "next" }]).steps.map((x) => x.id!);
  const otherLead = s.e.register("T-lead2", "lead", "other");
  const [o] = s.e.publishStatus(otherLead, statusParams.parse({ goal: "Other work", steps: [{ title: "Merge all the PRs", state: "current" }] })).steps.map((x) => x.id!);
  const holder = s.e.register("T-9", "thread", "demo", "T-lead");
  s.e.setEnvironment("T-9", "E9");
  s.e.prSeen(holder, "E9", pr("merged", 120));
  const url = (n: number) => `https://github.com/o/r/pull/${n}`;
  for (const n of [121, 122]) s.e.report(holder, `PR ${n}`, "Up.", url(n));
  s.tidy({ action: "file", kind: "pr", ref: url(121), task: o! });
  s.e.retire("T-9");
  s.publish([{ id: k, title: "Keep", state: "current" }, { id: b, title: "Done", state: "done" }]);
  assert.throws(
    () => s.tidy({ action: "file", kind: "pr", ref: url(120), task: b! }),
    (e: Error) => /PR https:\/\/github.com\/o\/r\/pull\/122 \(not read yet/.test(e.message) && !/pull\/121/.test(e.message),
    "the holder's own unread PR is unfinished work on a done task; the other project's PR is not the holder's to bring",
  );
  assert.deepEqual([linksOf(s, url(120)), linksOf(s, url(121)), linksOf(s, url(122))], [[], [o], []], "the refusal writes nothing");
});

test("a card filed away keeps the PR on its old task while another card's wait there still binds it, even when another project links the PR", () => {
  const s = setup();
  const [a, c] = s.publish([{ title: "One", state: "current" }, { title: "Two", state: "next" }]).steps.map((x) => x.id!);
  const otherLead = s.e.register("T-lead2", "lead", "other");
  const [o] = s.e.publishStatus(otherLead, statusParams.parse({ goal: "Other work", steps: [{ title: "Merge all the PRs", state: "current" }] })).steps.map((x) => x.id!);
  const url = "https://github.com/o/r/pull/130";
  s.tidy({ action: "file", kind: "pr", ref: url, task: o! });
  const waitOn = () => {
    const q = s.e.ask(s.lead, { title: "Merge?", question: "Merge it?", options: opts, task: a });
    s.e.triageAskPerson(s.cos, q.id, { question: "Merge it?", options: opts, allowText: true });
    s.e.personAnswer(q.id, s.e.decision(q.id)!.rev, "1", null, "desktop");
    s.e.ack(s.lead, q.id, "done", null, { pr: url, when: "merged" });
    return q;
  };
  const first = waitOn();
  waitOn();
  assert.deepEqual(linksOf(s, url), [a, o].sort());
  s.tidy({ action: "file", kind: "card", ref: first.id, task: c! });
  assert.ok(linksOf(s, url).includes(a), "the second card's wait still binds the PR to its task");
});

test("a card filed under another task takes its lead's PR wait along, even when another project links the PR: the wait still waits, so its task shows the PR", () => {
  const s = setup();
  const [a, c] = s.publish([{ title: "One", state: "current" }, { title: "Two", state: "next" }]).steps.map((x) => x.id!);
  const otherLead = s.e.register("T-lead2", "lead", "other");
  const [o] = s.e.publishStatus(otherLead, statusParams.parse({ goal: "Other work", steps: [{ title: "Merge all the PRs", state: "current" }] })).steps.map((x) => x.id!);
  const url = "https://github.com/o/r/pull/131";
  s.tidy({ action: "file", kind: "pr", ref: url, task: o! });
  const q = s.e.ask(s.lead, { title: "Merge?", question: "Merge it?", options: opts, task: a });
  s.e.triageAskPerson(s.cos, q.id, { question: "Merge it?", options: opts, allowText: true });
  s.e.personAnswer(q.id, s.e.decision(q.id)!.rev, "1", null, "desktop");
  s.e.ack(s.lead, q.id, "done", null, { pr: url, when: "merged" });
  assert.deepEqual(linksOf(s, url), [a, o].sort());
  s.tidy({ action: "file", kind: "card", ref: q.id, task: c! });
  assert.deepEqual(linksOf(s, url), [c, o].sort());
});

test("another project's thread or CoS link wins over a thread's history, whichever of the thread and a card with a lead wait on the PR is filed first", () => {
  for (const cardFirst of [false, true]) {
    const s = setup();
    const [a, b, c] = s.publish([{ title: "One", state: "current" }, { title: "Two", state: "next" }, { title: "Three", state: "next" }]).steps.map((x) => x.id!);
    const otherLead = s.e.register("T-lead2", "lead", "other");
    const [o] = s.e.publishStatus(otherLead, statusParams.parse({ goal: "Other work", steps: [{ title: "Merge all the PRs", state: "current" }] })).steps.map((x) => x.id!);
    const url = "https://github.com/o/r/pull/132";
    s.tidy({ action: "file", kind: "pr", ref: url, task: o! });
    const q = s.e.ask(s.lead, { title: "Merge?", question: "Merge it?", options: opts, task: a });
    s.e.triageAskPerson(s.cos, q.id, { question: "Merge it?", options: opts, allowText: true });
    s.e.personAnswer(q.id, s.e.decision(q.id)!.rev, "1", null, "desktop");
    s.e.ack(s.lead, q.id, "done", null, { pr: url, when: "merged" });
    s.clock.t += HOUR;
    const t = s.e.register("T-9", "thread", "demo", "T-lead"); // on no task
    s.e.report(t, "PR 132", "Up.", url); // later than the lead's wait
    const fileThread = () => s.tidy({ action: "file", kind: "thread", ref: t.address, task: b! });
    const fileCard = () => s.tidy({ action: "file", kind: "card", ref: q.id, task: b! });
    for (const f of cardFirst ? [fileCard, fileThread] : [fileThread, fileCard]) f();
    assert.deepEqual(linksOf(s, url), [b, o].sort(), "the card's wait brings it");
    s.tidy({ action: "file", kind: "thread", ref: t.address, task: c! });
    assert.deepEqual(linksOf(s, url), [b, o].sort(), `${cardFirst ? "card" : "thread"} first: the thread never owned it on b, so it takes nothing along`);
  }
});

function otherProjectWithHolder(s: ReturnType<typeof setup>) {
  const [, a] = s.publish([{ title: "Keep", state: "current" }, { title: "Merged work", state: "next" }]).steps.map((x) => x.id!);
  const otherLead = s.e.register("T-lead2", "lead", "other");
  const [o] = s.e.publishStatus(otherLead, statusParams.parse({ goal: "Other work", steps: [{ title: "Release", state: "current" }] })).steps.map((x) => x.id!);
  const holder = s.e.register("T-9", "thread", "demo", "T-lead"); // on no task
  return { a: a!, o: o!, otherLead, holder };
}

test("a thread's or the CoS's link in another project says the PR's work lives there: a filed holder's history doesn't bring it", () => {
  const s = setup();
  const { a, o, otherLead, holder } = otherProjectWithHolder(s);
  const url = (n: number) => `https://github.com/o/r/pull/${n}`;
  const theirs = s.e.register("T-7", "thread", "other", "T-lead2");
  s.tidy({ action: "file", kind: "thread", ref: theirs.address, task: o });
  s.e.setEnvironment("T-7", "E7");
  s.e.prSeen(theirs, "E7", pr("open", 150)); // the other project's thread works on it
  s.tidy({ action: "file", kind: "pr", ref: url(151), task: o }); // the CoS filed it there
  s.e.ask(otherLead, { title: "Review?", question: "Review this one?", options: opts, task: o, blocks: [{ kind: "pr", url: url(152) }] });
  s.e.prSeen(theirs, "E7", pr("open", 152)); // named by a card first, then worked on there
  for (const n of [150, 151, 152]) s.e.report(holder, `PR ${n}`, "Up.", url(n));
  s.e.retire("T-9");
  s.tidy({ action: "file", kind: "thread", ref: holder.address, task: a });
  assert.deepEqual([linksOf(s, url(150)), linksOf(s, url(151)), linksOf(s, url(152))], [[o], [o], [o]], "who owns the link now counts, not who linked it first");
});

test("a card or deliverable in another project only names a PR: a filed holder's history still brings it to its own task", () => {
  const s = setup();
  const { a, o, otherLead, holder } = otherProjectWithHolder(s);
  const url = (n: number) => `https://github.com/o/r/pull/${n}`;
  s.e.deliver(otherLead, { title: "Release packet", summary: "The PRs in this release.", proof: [{ kind: "pr", caption: "in the release", url: url(160) }], task: o }, place);
  s.e.ask(otherLead, { title: "Ship it?", question: "Release with these?", options: opts, task: o, blocks: [{ kind: "pr", url: url(161) }] });
  assert.deepEqual([linksOf(s, url(160)), linksOf(s, url(161))], [[o], [o]], "each mention links on its own task, as on save");
  for (const n of [160, 161]) s.e.report(holder, `PR ${n}`, "Up.", url(n));
  s.e.retire("T-9");
  s.tidy({ action: "file", kind: "thread", ref: holder.address, task: a });
  assert.deepEqual([linksOf(s, url(160)), linksOf(s, url(161))], [[a, o].sort(), [a, o].sort()], "the holder's own task gets them too; the mentions keep theirs");
});

const M_URL = "https://github.com/o/r/pull/300";
type MCtx = { s: ReturnType<typeof setup>; A: string; B: string; C: string; t?: ReturnType<Engine["register"]>; x?: string; d?: string };

function mBase(claimed: boolean): MCtx {
  const s = setup();
  const [A, B, C] = s.publish([{ title: "One", state: "current" }, { title: "Two", state: "next" }, { title: "Three", state: "next" }]).steps.map((x) => x.id!);
  const otherLead = s.e.register("T-lead2", "lead", "other");
  const [O] = s.e.publishStatus(otherLead, statusParams.parse({ goal: "Other work", steps: [{ title: "Release", state: "current" }] })).steps.map((x) => x.id!);
  if (claimed) s.tidy({ action: "file", kind: "pr", ref: M_URL, task: O! });
  return { s, A: A!, B: B!, C: C! };
}

const mThread = (c: MCtx, on: string | null) => {
  c.t = c.s.e.register("T-9", "thread", "demo", "T-lead");
  if (on) c.s.tidy({ action: "file", kind: "thread", ref: c.t.address, task: on });
  c.s.e.setEnvironment("T-9", "E9");
  return c.t;
};

/** An answered card: the lead's (the owner answers; the lead acks), the thread's answered by its lead (the thread acks), or the thread's forwarded to the owner (the lead acks). */
function mAnswered(c: MCtx, asker: "lead" | "thread" | "thread, forwarded", task: string | null): string {
  const q = c.s.e.ask(asker === "lead" ? c.s.lead : c.t!, { title: "Merge?", question: "Merge it?", options: opts, ...(task ? { task } : {}) });
  if (asker === "thread") return c.s.e.leadAnswer(c.s.lead, q.id, null, "1", "my call").id;
  if (asker === "thread, forwarded") c.s.e.forward(c.s.lead, q.id, null);
  c.s.e.triageAskPerson(c.s.cos, q.id, { question: "Merge it?", options: opts, allowText: true });
  c.s.e.personAnswer(q.id, c.s.e.decision(q.id)!.rev, "1", null, "desktop");
  return q.id;
}

/** What a thread does with the PR, by owner via, linked live on its task when it has one. */
function mHistory(c: MCtx, via: "bb" | "report" | "handoff" | "thread wait", cardTask: string | null): void {
  const t = c.t!;
  if (via === "bb") c.s.e.prSeen(t, "E9", pr("open", 300));
  else if (via === "report") c.s.e.report(t, "PR 300", "Up.", M_URL);
  else if (via === "handoff") {
    // as resolving a thread with its open PR handed off writes it
    c.s.db.prepare(`INSERT INTO handed_off_prs (project, thread_address, thread_id, pr, owner, note, by_address, at) VALUES ('demo', ?, 'T-9', ?, 'Sam', NULL, ?, ?)`).run(t.address, M_URL, c.s.lead.address, c.s.clock.t);
    linkPr(c.s.db, M_URL, addressTask(c.s.db, t.address), "handoff", t.address, c.s.clock.t);
  } else {
    c.x = mAnswered(c, "thread", cardTask);
    c.s.e.ack(t, c.x, "done", null, { pr: M_URL, when: "merged" });
  }
}

/** The owner row under test, on A. */
const M_ROWS: Record<string, { build: (c: MCtx) => void; rows: string[] }> = {
  bb: { build: (c) => (mThread(c, c.A), mHistory(c, "bb", null)), rows: ["A:bb:T"] },
  report: { build: (c) => (mThread(c, c.A), mHistory(c, "report", null)), rows: ["A:report:T"] },
  handoff: { build: (c) => (mThread(c, c.A), mHistory(c, "handoff", null)), rows: ["A:handoff:T"] },
  "thread wait (card asked for A)": { build: (c) => (mThread(c, c.A), mHistory(c, "thread wait", c.A)), rows: ["A:wait:T"] },
  "lead wait (card asked for A)": {
    build: (c) => {
      c.x = mAnswered(c, "lead", c.A);
      c.s.e.ack(c.s.lead, c.x, "done", null, { pr: M_URL, when: "merged" });
    },
    rows: ["A:wait:lead"],
  },
  "cos (filed through its holder)": {
    build: (c) => {
      mThread(c, c.A);
      mHistory(c, "bb", null);
      c.s.tidy({ action: "file", kind: "pr", ref: M_URL, task: c.A });
    },
    rows: ["A:bb:T", "A:cos:T"],
  },
  "card (the lead's, asked for A)": { build: (c) => void (c.x = c.s.e.ask(c.s.lead, { title: "Review?", question: "Review it?", options: opts, task: c.A, blocks: [{ kind: "pr", url: M_URL }] }).id), rows: ["A:card:lead"] },
  deliverable: {
    build: (c) => void (c.d = c.s.e.deliver(c.s.lead, { title: "Release packet", summary: "In the release.", proof: [{ kind: "pr", caption: "in it", url: M_URL }], task: c.A }, place).id),
    rows: ["A:deliverable:lead"],
  },
};

const mOps: Record<string, { run: (c: MCtx) => void; moves: string[] }> = {
  "card move A→B": {
    run: (c) => {
      c.x ??= c.s.e.ask(c.s.lead, { title: "Other?", question: "Anything else?", options: opts, task: c.A }).id;
      c.s.tidy({ action: "file", kind: "card", ref: c.x, task: c.B });
    },
    moves: ["lead wait (card asked for A)", "card (the lead's, asked for A)"],
  },
  "deliverable move A→B": {
    run: (c) => {
      c.d ??= c.s.e.deliver(c.s.lead, { title: "Shots", summary: "Done.", proof, task: c.A }, place).id;
      c.s.tidy({ action: "file", kind: "deliverable", ref: c.d, task: c.B });
    },
    moves: ["deliverable"],
  },
  "thread filing A→B": {
    run: (c) => {
      c.t ??= mThread(c, c.A);
      c.s.tidy({ action: "file", kind: "thread", ref: c.t.address, task: c.B });
    },
    moves: ["bb", "report", "handoff", "thread wait (card asked for A)", "cos (filed through its holder)"],
  },
  "drop A, restore A": { run: (c) => mDropped(c, () => {}, M_BACK["restore A"]!), moves: [] },
  "drop A, put A back in the lead's steps": { run: (c) => mDropped(c, () => {}, M_BACK["put A back in the lead's steps"]!), moves: [] },
  "merge A into B": { run: (c) => M_BACK["merge A into B"]!(c), moves: Object.keys(M_ROWS) },
  "drop A, merge A into B": { run: (c) => mDropped(c, () => {}, M_BACK["merge A into B"]!), moves: Object.keys(M_ROWS) },
};

/** The ways a dropped task's Unfiled things come back to it (each through refile's scoped pass). */
const M_BACK: Record<string, (c: MCtx) => void> = {
  "restore A": (c) => c.s.tidy({ action: "restore", task: c.A }),
  "put A back in the lead's steps": (c) => c.s.publish([{ id: c.A, title: "One", state: "current" }, { id: c.B, title: "Two", state: "next" }, { id: c.C, title: "Three", state: "next" }]),
  "merge A into B": (c) => c.s.tidy({ action: "merge", task: c.A, into: c.B }),
};

function mDropped(c: MCtx, whileDropped: () => void, back: (c: MCtx) => void): void {
  c.s.publish([{ id: c.B, title: "Two", state: "next" }, { id: c.C, title: "Three", state: "next" }]);
  whileDropped();
  back(c);
}

function mRead(c: MCtx): { rows: string[]; links: string[] } {
  const name: Record<string, string> = { [c.A]: "A", [c.B]: "B", [c.C]: "C" };
  const who = (by: string) => (by === "" ? "cos" : by === c.s.lead.address ? "lead" : by === c.t?.address ? "T" : by);
  const rows = (c.s.db.prepare(`SELECT task, via, by FROM task_pr_owners WHERE url = ?`).all(M_URL) as { task: string; via: string; by: string }[]).filter((r) => name[r.task]).map((r) => `${name[r.task]}:${r.via}:${who(r.by)}`);
  const links = (c.s.db.prepare(`SELECT task FROM task_prs WHERE url = ?`).all(M_URL) as { task: string }[]).filter((r) => name[r.task]).map((r) => name[r.task]!);
  return { rows: rows.sort(), links: links.sort() };
}

type MCell = { name: string; build: (c: MCtx) => void; run: (c: MCtx) => void; before: string[]; after: (claimed: boolean) => string[]; label?: string };

const M_CELLS: MCell[] = [
  // no loss: an owner row stays on its task unless its owner moved, and moves with it when it did
  ...Object.entries(mOps).flatMap(([op, o]) =>
    Object.entries(M_ROWS).map(([via, r]) => ({ name: `${op} × ${via}`, build: r.build, run: o.run, before: r.rows, after: () => r.rows.map((x) => (o.moves.includes(via) ? x.replace(/^A:/, "B:") : x)) })),
  ),
  {
    name: "card move A→B × card the thread asked for A",
    build: (c) => (mThread(c, c.A), void (c.x = c.s.e.ask(c.t!, { title: "Review?", question: "Review it?", options: opts, task: c.A, blocks: [{ kind: "pr", url: M_URL }] }).id)),
    run: mOps["card move A→B"]!.run,
    before: ["A:card:T"],
    after: () => ["B:card:T"],
  },
  {
    name: "thread filing A→B × card the thread asked, following it",
    build: (c) => (mThread(c, c.A), void (c.x = c.s.e.ask(c.t!, { title: "Review?", question: "Review it?", options: opts, blocks: [{ kind: "pr", url: M_URL }] }).id)),
    run: mOps["thread filing A→B"]!.run,
    before: ["A:card:T"],
    after: () => ["B:card:T"],
  },
  {
    name: "thread filing A→B × card the thread asked for A",
    build: (c) => (mThread(c, c.A), void (c.x = c.s.e.ask(c.t!, { title: "Review?", question: "Review it?", options: opts, task: c.A, blocks: [{ kind: "pr", url: M_URL }] }).id)),
    run: mOps["thread filing A→B"]!.run,
    before: ["A:card:T"],
    after: () => ["A:card:T", "B:card:T"],
    label: "known limit: saving the card links A only",
  },
  {
    name: "thread filing A→B × lead wait on a card the thread asked, following it",
    build: (c) => {
      mThread(c, c.A);
      c.x = mAnswered(c, "thread, forwarded", null);
      c.s.e.ack(c.s.lead, c.x, "done", null, { pr: M_URL, when: "merged" });
    },
    run: mOps["thread filing A→B"]!.run,
    before: ["A:wait:lead"],
    after: () => ["A:wait:lead", "B:wait:lead"],
    label: "known limit: the wait follows the card to B, and A keeps a copy",
  },
  // no gain: a thread's history from while it had no task links its PR, unless another project's thread or CoS linked it
  ...(["bb", "report", "handoff", "thread wait"] as const).flatMap((via): MCell[] => [
    {
      name: `thread filing (Unfiled)→B × ${via} from while Unfiled`,
      build: (c) => (mThread(c, null), mHistory(c, via, null)),
      run: (c) => c.s.tidy({ action: "file", kind: "thread", ref: c.t!.address, task: c.B }),
      before: [],
      after: (claimed) => (claimed ? [] : [`B:${via === "thread wait" ? "wait" : via}:T`]),
      label: "blocked on purpose when claimed",
    },
    {
      name: `PR 301 filed through its holder (Unfiled)→B × ${via} of PR 300 from while Unfiled`,
      build: (c) => {
        mThread(c, null);
        c.s.e.prSeen(c.t!, "E9", pr("merged", 301));
        mHistory(c, via, null);
      },
      run: (c) => c.s.tidy({ action: "file", kind: "pr", ref: "https://github.com/o/r/pull/301", task: c.B }),
      before: [],
      after: (claimed) => (claimed ? [] : [`B:${via === "thread wait" ? "wait" : via}:T`]),
      label: "blocked on purpose when claimed",
    },
    ...Object.entries(M_BACK).map(
      ([back, f]): MCell => ({
        name: `drop A, ${back} × ${via} from while dropped`,
        build: (c) => void mThread(c, c.A),
        run: (c) => mDropped(c, () => mHistory(c, via, null), f),
        before: [],
        after: (claimed) => (claimed ? [] : [`${back.startsWith("merge") ? "B" : "A"}:${via === "thread wait" ? "wait" : via}:T`]),
        label: "blocked on purpose when claimed",
      }),
    ),
  ]),
  // a card with a lead wait and a thread with history, filed onto B in either order, then the thread on to C
  ...[true, false].map(
    (cardFirst): MCell => ({
      name: `${cardFirst ? "card A→B, thread (Unfiled)→B" : "thread (Unfiled)→B, card A→B"}, thread B→C × lead wait and the thread's report`,
      build: (c) => {
        c.x = mAnswered(c, "lead", c.A);
        c.s.e.ack(c.s.lead, c.x, "done", null, { pr: M_URL, when: "merged" });
        c.s.clock.t += HOUR;
        mThread(c, null);
        mHistory(c, "report", null);
      },
      run: (c) => {
        const card = () => c.s.tidy({ action: "file", kind: "card", ref: c.x!, task: c.B });
        const thread = () => c.s.tidy({ action: "file", kind: "thread", ref: c.t!.address, task: c.B });
        for (const f of cardFirst ? [card, thread] : [thread, card]) f();
        c.s.tidy({ action: "file", kind: "thread", ref: c.t!.address, task: c.C });
      },
      before: ["A:wait:lead"],
      after: (claimed) => (claimed ? ["B:wait:lead"] : ["B:wait:lead", "C:report:T"]),
      label: "blocked on purpose when claimed",
    }),
  ),
];

test("each tidy keeps an owner's PR row unless the owner moved, and a thread gains no PR another project's thread or CoS linked", async (t) => {
  for (const cell of M_CELLS)
    for (const claimed of [true, false]) {
      const after = cell.after(claimed);
      const label = cell.label && (claimed || !cell.label.startsWith("blocked")) ? ` [${cell.label}]` : "";
      await t.test(`${cell.name}, ${claimed ? "PR claimed in another project" : "PR in no other project"} → ${after.join(" ") || "none"}${label}`, () => {
        const c = mBase(claimed);
        cell.build(c);
        assert.deepEqual(mRead(c).rows, cell.before, "the starting rows");
        cell.run(c);
        const got = mRead(c);
        assert.deepEqual(got.rows, after);
        assert.deepEqual(got.links, [...new Set(after.map((x) => x[0]!))].sort(), "a link where an owner is, and only there");
      });
    }
});

test("a card leaving a task still links there what a thread reported before its spawn put it on the task", () => {
  const c = mBase(false);
  mThread(c, c.A);
  mHistory(c, "thread wait", c.A);
  const late = c.s.e.register("T-10", "thread", "demo", "T-lead");
  const url302 = "https://github.com/o/r/pull/302";
  c.s.e.report(late, "PR 302", "Up.", url302);
  const plan = c.s.e.ask(c.s.lead, { title: "Start a thread?", question: "Start one thread?", options: opts, kind: "plan", threads: 1, task: c.A });
  c.s.e.triageAskPerson(c.s.cos, plan.id, { question: "Start one thread?", options: [], allowText: true });
  c.s.e.personAnswer(plan.id, c.s.e.decision(plan.id)!.rev, "1", null, "desktop");
  c.s.e.confirmSpawn(c.s.e.reserveSpawn(c.s.lead, plan.id), "T-10");
  const linked = () => (c.s.db.prepare(`SELECT task FROM task_prs WHERE url = ?`).all(url302) as { task: string }[]).map((r) => r.task);
  assert.deepEqual(linked(), [], "reported before its spawn named a task");
  c.s.tidy({ action: "file", kind: "card", ref: c.x!, task: c.B });
  assert.deepEqual(linked(), [c.A], "the card's move replays A");
  assert.deepEqual(mRead(c).rows, ["A:wait:T"], "the thread's wait stays with the thread");
});
