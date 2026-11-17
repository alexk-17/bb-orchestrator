// Retention (2026-11-17): data.db grew forever because nothing deleted finished mail, cards, waits, the Board or the
// activity log. Why it matters: pruning is the one place the plugin deletes the owner's record, so it must take exactly
// the old finished rows and never an open one, nor one an open thing still points at (an unacked item, an open wait's
// card, a deliverable's next action, a live rule's card, a live lead's plan). And 0, the default, must delete nothing.
import assert from "node:assert/strict";
import { test } from "node:test";
import { DatabaseSync } from "node:sqlite";
import { migrate, type Db } from "../core/db.ts";
import { BatchInbox } from "../core/batch-inbox.ts";
import { DAY_MS, prune } from "../core/retention.ts";

const NOW = Date.parse("2026-11-17T12:00:00Z");
const OLD = NOW - 40 * DAY_MS;
const NEW = NOW - 5 * DAY_MS;

function seed(): Db {
  const db = new DatabaseSync(":memory:") as unknown as Db;
  migrate(db);
  new BatchInbox(db, () => NOW); // its tables, as the engine makes them
  const agent = (id: string, address: string, role: string, retired: number | null) =>
    db.prepare(`INSERT INTO agents (thread_id, address, role, created_at, retired_at) VALUES (?, ?, ?, ?, ?)`).run(id, address, role, OLD, retired);
  agent("T-lead", "lead:p", "lead", null);
  agent("T-gone", "thread:p:1", "thread", OLD);
  const card = (id: string, state: string, at: number, extra: Record<string, unknown> = {}, asker = "thread:p:1") =>
    db.prepare(`INSERT INTO decisions (id, state, at_level, asker, origin, json, updated_at) VALUES (?, ?, 'person', ?, ?, ?, ?)`).run(id, state, asker, asker, JSON.stringify({ id, kind: "question", ...extra }), at);
  card("d-acked-old", "acked", OLD, { ack: { outcome: "done" } });
  card("d-acked-new", "acked", NEW, { ack: { outcome: "done" } });
  card("d-moot-old", "withdrawn", OLD, { withdrawn: { moot: true } });
  card("d-replied-old", "acked", OLD, { ack: { outcome: "replied" } }); // still waits on its asker's ack
  card("d-answered-old", "answered", OLD);
  card("d-open-old", "open", OLD);
  card("d-merged-old", "merged", OLD, { merged_into: "d-acked-old" });
  card("d-merged-live", "merged", OLD, { merged_into: "d-open-old" });
  card("d-waited", "acked", OLD, { ack: { outcome: "done" } });
  card("d-rule", "acked", OLD, { ack: { outcome: "done" } });
  card("d-plan-live", "acked", OLD, { kind: "plan", ack: { outcome: "done" } }, "lead:p");
  card("d-plan-gone", "acked", OLD, { kind: "plan", ack: { outcome: "done" } }, "thread:p:1");
  card("d-itemref", "withdrawn", OLD);
  const item = (id: string, state: string, closedAt: number | null, ref: string | null = null) =>
    db.prepare(`INSERT INTO items (id, recipient, sender, kind, ref, body, needs_ack, state, created_at, closed_at) VALUES (?, 'lead:p', 'cos', 'message', ?, 'b', 0, ?, ?, ?)`).run(id, ref, state, OLD, closedAt);
  item("i-closed-old", "closed", OLD);
  item("i-closed-new", "closed", NEW);
  item("i-open", "delivered", null, "d-itemref");
  item("i-dead", "dead", null);
  item("i-reffed", "closed", OLD);
  item("i-reply", "pending", null, "i-reffed");
  item("i-next", "closed", OLD);
  item("i-wait", "closed", OLD);
  item("i-import", "closed", OLD);
  item("i-unread", "closed", OLD);
  db.prepare(`INSERT INTO deliverables (id, lead, title, summary, state, rev, created_at, updated_at, json) VALUES ('v1', 'lead:p', 't', 's', 'approved', 1, ?, ?, ?)`).run(OLD, OLD, JSON.stringify({ next: { item: "i-next" } }));
  db.prepare(`INSERT INTO external_mail (source, external_id, item_id, json, quiet) VALUES ('x', 'e1', 'i-import', '{}', 0)`).run();
  const entry = (item: string, acked: number | null) => db.prepare(`INSERT INTO inbox_entries (item_id, recipient, severity, needs_reply, acked_at) VALUES (?, 'lead:p', 'INFO', 0, ?)`).run(item, acked);
  entry("i-closed-old", OLD);
  entry("i-unread", null);
  const wait = (id: string, ref: string, closed: number | null, itemId: string | null = null) =>
    db.prepare(`INSERT INTO waits (id, owner, ref, about, pr_url, cond, created_at, closed_at, item_id) VALUES (?, 'lead:p', ?, 'a', 'u', 'merged', ?, ?, ?)`).run(id, ref, OLD, closed, itemId);
  wait("w-closed-old", "d-acked-new", OLD);
  wait("w-closed-new", "d-acked-new", NEW);
  wait("w-open", "d-waited", null, "i-wait");
  db.prepare(`INSERT INTO rules (id, text, kinds, granted_by, source, created_at) VALUES ('r1', 't', 'question', 'person', 'd-rule', ?)`).run(OLD);
  const board = (id: string, kind: string, from: string | null, at: number) =>
    db.prepare(`INSERT INTO board (id, kind, from_address, title, body, at) VALUES (?, ?, ?, 't', 'b', ?)`).run(id, kind, from, at);
  board("b-old", "report", "thread:p:1", OLD);
  board("b-new", "report", "thread:p:1", NEW);
  board("b-resolved", "resolved", "lead:p", OLD);
  board("b-live", "report", "lead:p", OLD);
  const alarm = (id: string, at: number) => db.prepare(`INSERT INTO alarms (id, level, snapshot, at) VALUES (?, 'warn', '{}', ?)`).run(id, at);
  alarm("a-old", OLD);
  alarm("a-older", OLD - DAY_MS);
  const ev = (kind: string, address: string, thread: string, at: number) =>
    db.prepare(`INSERT INTO events (at, kind, address, thread_id) VALUES (?, ?, ?, ?)`).run(at, kind, address, thread);
  ev("spawn", "lead:p", "T-lead", OLD);
  ev("spawn", "thread:p:1", "T-gone", OLD);
  ev("status", "thread:p:1", "T-gone", OLD - 1);
  ev("status", "thread:p:1", "T-gone", OLD);
  ev("pr", "thread:p:1", "T-gone", NEW);
  return db;
}

const ids = (db: Db, table: string, col = "id") => (db.prepare(`SELECT ${col} AS id FROM ${table} ORDER BY ${col}`).all() as { id: string }[]).map((r) => String(r.id));

test("retention takes exactly the old finished rows; open and referenced ones stay", () => {
  const db = seed();
  const { counts, decisions } = prune(db, NOW, { retentionDays: 30, activityRetentionDays: 30 });
  assert.deepEqual(
    ids(db, "decisions"),
    ["d-acked-new", "d-answered-old", "d-itemref", "d-merged-live", "d-open-old", "d-plan-live", "d-replied-old", "d-rule", "d-waited"],
    "kept: new, unfinished, merged into an open card, named by an open item or wait, behind a live rule, a live lead's plan",
  );
  assert.deepEqual(decisions.sort(), ["d-acked-old", "d-merged-old", "d-moot-old", "d-plan-gone"]);
  assert.deepEqual(ids(db, "items"), ["i-closed-new", "i-dead", "i-import", "i-next", "i-open", "i-reffed", "i-reply", "i-unread", "i-wait"]);
  assert.deepEqual(ids(db, "inbox_entries", "item_id"), ["i-unread"], "the deleted item's read mark goes with it");
  assert.deepEqual(ids(db, "waits"), ["w-closed-new", "w-open"]);
  assert.deepEqual(ids(db, "board"), ["b-live", "b-new", "b-resolved"]);
  assert.deepEqual(ids(db, "alarms"), ["a-old"], "the newest alarm stays");
  assert.deepEqual(
    (db.prepare(`SELECT kind, thread_id FROM events ORDER BY seq`).all() as { kind: string; thread_id: string }[]).map((e) => `${e.kind} ${e.thread_id}`),
    ["spawn T-lead", "status T-gone", "pr T-gone"],
    "a live agent's spawn and each thread's latest status stay",
  );
  assert.deepEqual(counts, { waits: 1, alarms: 1, decisions: 4, items: 1, inbox_entries: 1, board: 1, events: 2 });
});

test("0 (the default) deletes nothing; each setting covers only its own tables; a dry run counts and keeps", () => {
  const db = seed();
  const total = () => ["decisions", "items", "waits", "board", "alarms", "events", "inbox_entries"].map((t) => (db.prepare(`SELECT COUNT(*) AS c FROM ${t}`).get() as { c: number }).c).join(",");
  const before = total();
  assert.deepEqual(prune(db, NOW, { retentionDays: 0, activityRetentionDays: 0 }).counts, {});
  assert.equal(total(), before);
  const dry = prune(db, NOW, { retentionDays: 30, activityRetentionDays: 30 }, true);
  assert.equal(total(), before, "a dry run deletes nothing");
  assert.equal(dry.counts.items, 1);
  assert.deepEqual(Object.keys(prune(db, NOW, { retentionDays: 0, activityRetentionDays: 30 }).counts), ["events"]);
  assert.deepEqual(prune(db, NOW, { retentionDays: 30, activityRetentionDays: 0 }).counts.events, undefined, "the activity log has its own setting");
});
