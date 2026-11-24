// The change notice's tables (core/write-log.ts; lag fix 2026-11-23). Each screen refetches only the reads a notice
// names, so a write the notice misses is a screen that never updates: these pin what a write is reported as, and that
// anything the recorder can't name refetches everything.
import { test } from "node:test";
import assert from "node:assert/strict";
import { DatabaseSync } from "node:sqlite";
import { ChangeTables, eventKindAt, recordWrites, writtenTables } from "../core/write-log.ts";
import { KNOWN_TABLES, STATUS } from "../change-notice.ts";
import { Engine } from "../core/engine.ts";
import type { Db } from "../core/db.ts";

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
  // refetches; before this, it made every screen refetch everything a second time
  n.call();
  assert.deepEqual(n.take(), []);

  n.wrote(["tasks"]); // a table no read is mapped to yet (a new migration)
  n.call();
  assert.equal(n.take(), null);

  n.call(["bb"]); // tagged by the caller: a change outside the database
  assert.deepEqual(n.take(), ["bb"]);
  n.call(["*"]);
  assert.equal(n.take(), null);
});
