// The change notice's tables (core/write-log.ts). Each screen refetches only the reads a notice
// names, so a write the notice misses is a screen that never updates: these pin what a write is reported as, and that
// anything the recorder can't name refetches everything.
import { test } from "node:test";
import assert from "node:assert/strict";
import { DatabaseSync } from "node:sqlite";
import { ChangeTables, DerivedTables, eventKindAt, recordWrites, writtenTables } from "../core/write-log.ts";
import { KNOWN_TABLES, NEXT_MOVES, OWNER_MAIL, STATUS } from "../change-notice.ts";
import { Engine } from "../core/engine.ts";
import type { Db } from "../core/db.ts";
import { statusParams } from "../core/status.ts";

test("a statement's written tables: inserts, updates, deletes and upserts; reads write nothing", () => {
  assert.deepEqual(writtenTables("INSERT INTO items (id) VALUES (?)"), ["items"]);
  assert.deepEqual(writtenTables("INSERT OR IGNORE INTO cursors (a) VALUES (?)"), ["cursors"]);
  assert.deepEqual(writtenTables("REPLACE INTO xp (a) VALUES (?)"), ["xp"]);
  assert.deepEqual(writtenTables("UPDATE decisions SET json = ? WHERE id = ?"), ["decisions"]);
  assert.deepEqual(writtenTables("DELETE FROM waits WHERE id = ?"), ["waits"]);
  // an upsert's DO UPDATE SET is not a table called "set" (which would refetch everything)
  assert.deepEqual(writtenTables("INSERT INTO lead_status (project, json) VALUES (?, ?) ON CONFLICT(project) DO UPDATE SET json = excluded.json"), ["lead_status"]);
  assert.deepEqual(writtenTables("SELECT * FROM agents WHERE status = 'idle'"), []);
  assert.deepEqual(writtenTables("CREATE TABLE IF NOT EXISTS tasks (id TEXT)"), ["*"], "a schema change names no read");
});

test("a status-only update of agents is STATUS; any other agents update is agents", () => {
  // Engine.setStatus's statement: most change notices, and most reads show no status
  assert.deepEqual(writtenTables("UPDATE agents SET status = ?, idle_at = ?, last_idle_at = COALESCE(?, last_idle_at) WHERE thread_id = ?"), [STATUS]);
  assert.deepEqual(writtenTables("UPDATE agents SET retired_at = ? WHERE thread_id = ? AND retired_at IS NULL"), ["agents"]);
  assert.deepEqual(writtenTables("UPDATE agents SET status = ?, mon = ? WHERE thread_id = ?"), ["agents"], "status plus anything else is agents");
});

test("an events insert's kind is found among its arguments only when every value is a plain ?", () => {
  assert.equal(eventKindAt("INSERT INTO events (at, kind, project) VALUES (?, ?, ?)"), 1);
  assert.equal(eventKindAt("INSERT INTO events (at, kind) VALUES (?, 'status')"), -1);
  assert.equal(eventKindAt("INSERT INTO events (at, project) VALUES (?, ?)"), -1);
});

function recorded() {
  const raw = new DatabaseSync(":memory:");
  const seen: string[][] = [];
  const db = recordWrites(raw as unknown as Db, (t) => seen.push([...t]));
  return { raw, db, seen };
}

test("the recorder reports a write after it ran, a status event as STATUS, and reads not at all", () => {
  const { db, seen } = recorded();
  db.exec("CREATE TABLE events (seq INTEGER PRIMARY KEY, at INTEGER, kind TEXT, project TEXT)");
  seen.length = 0;
  const ins = db.prepare("INSERT INTO events (at, kind, project) VALUES (?, ?, ?)");
  ins.run(1, "status", "kite");
  ins.run(2, "pr", "kite");
  db.prepare("SELECT * FROM events").all();
  assert.deepEqual(seen, [[STATUS], ["events"]]);
  // a refused write changed nothing: nothing reported
  assert.throws(() => db.prepare("INSERT INTO events (seq, at, kind, project) VALUES (?, ?, ?, ?)").run(1, 3, "pr", "kite"));
  assert.deepEqual(seen.length, 2);
});

test("a write that changed no row names no table; one that changed a row, and a schema change, still do", () => {
  const { db, seen } = recorded();
  db.exec("CREATE TABLE items (id TEXT PRIMARY KEY, state TEXT)");
  db.exec("CREATE TABLE inbox_entries (item_id TEXT UNIQUE)");
  assert.deepEqual(seen, [["*"], ["*"]], "a schema change is everything, though it changes no row");
  seen.length = 0;
  db.prepare("INSERT INTO items (id, state) VALUES (?, ?)").run("i-1", "pending");
  assert.deepEqual(seen, [["items"]]);
  seen.length = 0;
  db.prepare("INSERT OR IGNORE INTO items (id, state) VALUES (?, ?)").run("i-1", "pending");
  db.prepare("UPDATE items SET state = 'closed' WHERE id = ?").run("i-none");
  db.prepare("DELETE FROM items WHERE id = ?").run("i-none");
  db.prepare("INSERT INTO items (id, state) VALUES (?, ?) ON CONFLICT (id) DO NOTHING").run("i-1", "x");
  const sync = "INSERT OR IGNORE INTO inbox_entries (item_id) SELECT id FROM items WHERE NOT EXISTS (SELECT 1 FROM inbox_entries e WHERE e.item_id = items.id)";
  db.exec(sync);
  assert.deepEqual(seen, [["inbox_entries"]], "only the sync that added a row");
  seen.length = 0;
  db.exec(sync);
  db.prepare("UPDATE items SET state = 'closed' WHERE id = ?").run("i-1");
  assert.deepEqual(seen, [["items"]], "the same sync again adds nothing; the close changed a row");
});

test("a batched-inbox flush with nothing new names no table, so no screen refetches on the clock's pass", async () => {
  const { db, seen } = recorded();
  let t = 1_000;
  const e = new Engine(db, { now: () => t, deliver: async () => ({ delivery: "sent" }), mirror: () => {}, changed: () => {}, log: () => {} }, { owner: "Robin", batchInbox: true, inboxDebounceMs: 2000, inboxGapMs: 120_000 });
  const cos = e.register("T-cos", "cos", null);
  const lead = e.register("T-lead", "lead", "kite");
  e.setStatus("T-lead", "idle");
  e.send(cos, lead.address, "first", null);
  await e.flush();
  t += 3000;
  await e.flush();
  t += 3000;
  seen.length = 0;
  await e.flush();
  t += 5000;
  await e.flush();
  assert.deepEqual([...seen], [], "nothing changed: no table, no refetch");
  e.send(cos, lead.address, "second", null);
  assert.ok(seen.flat().includes("inbox_entries"), "new mail still names the inbox");
});

test("the engine runs on the recorded database, and Engine.setStatus is reported as STATUS alone", () => {
  const { db, seen } = recorded();
  const e = new Engine(db, { now: () => 1_000, deliver: async () => ({ delivery: "sent" }), mirror: () => {}, changed: () => {}, log: () => {} }, { owner: "Robin" });
  e.register("T-lead", "lead", "kite");
  seen.length = 0;
  e.setStatus("T-lead", "active");
  assert.deepEqual([...new Set(seen.flat())], [STATUS], "the status columns and a status event");
});

test("the notice: the tables written; an unmapped table, or a call naming everything, is everything", () => {
  const n = new ChangeTables(KNOWN_TABLES);
  n.wrote(["decisions"]);
  n.call();
  n.wrote(["items"]); // after the call, before the notice: still in it
  assert.deepEqual(n.take(), ["decisions", "items"]);
  assert.deepEqual(n.take(), [], "taken: starts over");

  // the flush re-announces writes the last notice carried (Engine.changedSinceFlush): nothing new, so no mapped read
  // refetches
  n.call();
  assert.deepEqual(n.take(), []);

  n.wrote(["a_new_table"]); // a table no read is mapped to yet (a new migration)
  n.call();
  assert.equal(n.take(), null);

  n.call(["bb"]); // tagged by the caller: a change outside the database
  assert.deepEqual(n.take(), ["bb"]);
  n.call(["*"]);
  assert.equal(n.take(), null);
});

// The lead wake gap logs each wake in inbox_wake_log. An unmapped table makes the notice null, and every
// open screen refetches everything: at each wake, the cost the read map was built to remove.
test("a lead's wake and its gap's log keep the notice to named tables, not everything", async () => {
  const { db, seen } = recorded();
  let t = 1_000;
  const e = new Engine(db, { now: () => t, deliver: async () => ({ delivery: "sent" }), mirror: () => {}, changed: () => {}, log: () => {} }, { owner: "Robin", batchInbox: true, inboxDebounceMs: 2000, inboxGapMs: 120_000 });
  const cos = e.register("T-cos", "cos", null);
  const lead = e.register("T-lead", "lead", "kite");
  e.setStatus("T-lead", "idle");
  seen.length = 0;
  e.send(cos, lead.address, "first", null);
  await e.flush();
  t += 3000;
  await e.flush(); // the wake goes and is logged
  const written = new Set(seen.flat());
  assert.ok(written.has("inbox_wake_log"), "the wake was logged");
  const n = new ChangeTables(KNOWN_TABLES);
  n.wrote([...written]);
  n.call();
  assert.notEqual(n.take(), null, `every table written is mapped: ${[...written].filter((x) => !KNOWN_TABLES.has(x)).join(", ")}`);
});

// The work board writes tasks, task_moves and task_prs on a lead's status, a plan card and a thread's PR. Unmapped,
// each of those writes would make every open screen refetch everything.
test("a lead's plan, its thread and the thread's PR keep the notice to named tables, not everything", () => {
  const { db, seen } = recorded();
  const e = new Engine(db, { now: () => 1_000, deliver: async () => ({ delivery: "sent" }), mirror: () => {}, changed: () => {}, log: () => {} }, { owner: "Robin" });
  const cos = e.register("T-cos", "cos", null);
  const lead = e.register("T-lead", "lead", "kite");
  seen.length = 0;
  const [step] = e.publishStatus(lead, statusParams.parse({ goal: "Ship it", steps: [{ title: "Build", state: "current" }] })).steps;
  const plan = e.ask(lead, { title: "Start a thread?", question: "Start one thread?", options: [{ label: "Go" }, { label: "Not now" }], kind: "plan", threads: 1, task: step!.id });
  e.triageAskPerson(cos, plan.id, { question: "Start one thread?", options: [], allowText: true });
  e.personAnswer(plan.id, e.decision(plan.id)!.rev, "1", null, "desktop");
  e.confirmSpawn(e.reserveSpawn(lead, plan.id), "T-1");
  e.report(e.register("T-1", "thread", "kite", "T-lead"), "The PR", "ready", "https://github.com/o/r/pull/7");
  const written = new Set(seen.flat());
  for (const t of ["tasks", "task_moves", "task_prs"]) assert.ok(written.has(t), `${t} was written`);
  const n = new ChangeTables(KNOWN_TABLES);
  n.wrote([...written]);
  n.call();
  assert.notEqual(n.take(), null, `every table written is mapped: ${[...written].filter((x) => !KNOWN_TABLES.has(x)).join(", ")}`);
});

test("a derived table is named when its print moved since the last notice that wrote its tables, and only then", () => {
  let print = "a";
  let calls = 0;
  const failures: string[] = [];
  let mail = "m";
  const d = new DerivedTables({ [NEXT_MOVES]: () => (calls++, print), [OWNER_MAIL]: () => mail }, (name) => failures.push(name));
  assert.deepEqual(d.add(["items"]), ["items", NEXT_MOVES, OWNER_MAIL], "the first print has nothing to match: named");
  assert.deepEqual(d.add(["items"]), ["items"], "mail that moved no next move");
  calls = 0;
  assert.deepEqual(d.add(["agents"]), ["agents"]);
  assert.deepEqual(d.add([]), []);
  assert.equal(calls, 0, "no table of its written: not printed");
  print = "b";
  assert.deepEqual(d.add(["inbox_entries", "items"]), ["inbox_entries", "items", NEXT_MOVES]);
  mail = "n";
  assert.deepEqual(d.add(["inbox_entries"]), ["inbox_entries", OWNER_MAIL], "a receipt: the owner's mail only");
  print = "c";
  assert.equal(d.add(null), null, "everything refetches anyway");
  assert.deepEqual(d.add(["items"]), ["items"], "the null notice's print is the one matched next");
  const broken = new DerivedTables({ [NEXT_MOVES]: () => { throw new Error("made-up"); }, [OWNER_MAIL]: () => mail }, (name) => failures.push(name));
  assert.deepEqual(broken.add(["items"]), ["items", NEXT_MOVES, OWNER_MAIL], "a print that fails names it");
  assert.deepEqual(broken.add(["items"]), ["items", NEXT_MOVES]);
  assert.deepEqual(failures, [NEXT_MOVES, NEXT_MOVES]);
});
