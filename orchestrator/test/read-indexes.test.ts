// The slow reads' indexes (2026-11-23, lag): on a 10-day live copy, each of these queries sorted or scanned its whole
// table on every read (board 36 ms, the feed's answered cards 24 ms, deliverables 10 ms each). These pin that the planner
// still reads each through its index, so a LIMIT stops early, and that an existing database gains them keeping its rows.
import assert from "node:assert/strict";
import { test } from "node:test";
import { DatabaseSync } from "node:sqlite";
import { MIGRATIONS, migrate } from "../core/db.ts";

const fresh = () => {
  const db = new DatabaseSync(":memory:");
  migrate(db);
  return db;
};
const plan = (db: DatabaseSync, sql: string, ...args: (string | number)[]) => (db.prepare(`EXPLAIN QUERY PLAN ${sql}`).all(...args) as { detail: string }[]).map((r) => r.detail).join(" | ");

test("the read indexes are an appended migration: a database from the version before gains them and keeps its rows", () => {
  // found by content, so a migration appended later doesn't move what this checks
  const at = MIGRATIONS.findIndex((m) => /board_at ON board \(at\)/.test(m));
  assert.ok(at > 0, "the read indexes are a migration of their own");
  const db = new DatabaseSync(":memory:");
  db.exec(`CREATE TABLE _migrations (id INTEGER PRIMARY KEY)`);
  MIGRATIONS.slice(0, at).forEach((sql, i) => {
    db.exec(sql);
    db.prepare(`INSERT INTO _migrations (id) VALUES (?)`).run(i);
  });
  db.prepare(`INSERT INTO board (id, kind, from_address, project, title, body, ref, at) VALUES ('b-1', 'report', 'thread:kite:1', 'kite', 't', '', NULL, 1)`).run();
  db.prepare(`INSERT INTO deliverables (id, project, lead, title, summary, state, rev, created_at, updated_at, json) VALUES ('v-1', 'kite', 'lead:kite', 't', 's', 'approved', 1, 1, 2, '{"revisions":[{"at":"2026-11-19T09:00:00.000Z"}]}')`).run();
  migrate(db);
  assert.equal((db.prepare(`SELECT MAX(id) AS v FROM _migrations`).get() as { v: number }).v, MIGRATIONS.length - 1);
  const names = (db.prepare(`SELECT name FROM sqlite_master WHERE type = 'index'`).all() as { name: string }[]).map((r) => r.name);
  for (const n of ["board_at", "board_kind_at", "board_reports", "items_kind_ref", "items_created", "items_sender", "events_merged_project", "events_project_thread", "decisions_asker", "decisions_project_state", "agents_project", "decisions_feed_answered", "deliverables_list", "deliverables_board_list"]) assert.ok(names.includes(n), `${n} exists`);
  assert.equal((db.prepare(`SELECT COUNT(*) AS n FROM board`).get() as { n: number }).n, 1);
  assert.equal((db.prepare(`PRAGMA integrity_check`).get() as { integrity_check: string }).integrity_check, "ok");
  migrate(db); // IF NOT EXISTS: a second start changes nothing
});

test("the Board read walks board_at and stops at its limit, instead of sorting every row", () => {
  assert.equal(plan(fresh(), `SELECT * FROM board ORDER BY at DESC LIMIT ?`, 200), "SCAN board USING INDEX board_at");
});

test("the feed's lookups each use their index: replies by ref, the last owner message, alarms and counts by time", () => {
  const db = fresh();
  assert.match(plan(db, `SELECT * FROM items WHERE kind = 'cos.reply' AND ref = ?`, "i-1"), /items_kind_ref/);
  assert.match(plan(db, `SELECT id FROM items WHERE sender = 'person' AND kind IN ('owner.message','owner.cos') ORDER BY created_at DESC, rowid DESC LIMIT 1`), /items_sender/);
  assert.match(plan(db, `SELECT id FROM board WHERE kind IN ('alarm','dead') AND at < ? ORDER BY at DESC LIMIT ?`, 1, 51), /board_kind_at/);
  assert.match(plan(db, `SELECT COUNT(*) AS n FROM items WHERE created_at >= ? AND kind NOT IN ('owner.message','owner.cos','cos.reply')`, 1), /items_created/);
  // the feed's deliverables: every column it reads is in the index, so no row's JSON is parsed for the list
  assert.match(plan(db, `SELECT id, project, state, created_at, json_extract(json, '$.revisions[#-1].at') AS last_at FROM deliverables WHERE json_extract(json, '$.board') IS NULL AND state != 'withdrawn' ORDER BY updated_at DESC LIMIT 500`), /USING INDEX deliverables_list$/);
});

test("the Projects tab's latest merged PR and latest report per project read only those rows, from their partial indexes", () => {
  const db = fresh();
  assert.match(plan(db, `SELECT project, note, MAX(at) AS at FROM events WHERE kind = 'pr' AND value = 'merged' AND project IS NOT NULL GROUP BY project`), /COVERING INDEX events_merged_project/);
  // in project order, so the GROUP BY needs no sort of every report filed
  assert.equal(plan(db, `SELECT project, title, MAX(at) AS at FROM board INDEXED BY board_reports WHERE kind IN ('report','pr') AND project IS NOT NULL GROUP BY project`), "SEARCH board USING INDEX board_reports (project>?)");
});

test("the Deliverables list reads each half (board reviews or not) newest first from its own partial index", () => {
  const db = fresh();
  assert.match(plan(db, `SELECT id, json FROM deliverables WHERE json_extract(json, '$.board') IS NULL ORDER BY updated_at DESC, id DESC LIMIT ?`, 200), /^SCAN deliverables USING INDEX deliverables_list$/);
  assert.match(plan(db, `SELECT id, json FROM deliverables WHERE json_extract(json, '$.board') IS NOT NULL ORDER BY updated_at DESC, id DESC LIMIT ?`, 200), /^SCAN deliverables USING INDEX deliverables_board_list$/);
});

test("a project page's cards come by project or by asker through indexes, not a scan of every decision", () => {
  const p = plan(fresh(), `SELECT json FROM decisions WHERE project = ? OR asker IN (SELECT address FROM agents WHERE project = ?)`, "kite", "kite");
  assert.match(p, /MULTI-INDEX OR/);
  assert.match(p, /decisions_asker/);
  assert.doesNotMatch(p, /SCAN decisions/);
});
