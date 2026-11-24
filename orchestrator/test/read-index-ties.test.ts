// Rows at the same time keep the order they had before the read indexes (2026-11-24, Codex review of lag 2, four P2s).
// Without an index, SQLite sorted a table scan, so rows tied on time came first-written first; an index hands them back
// in its own order instead (by title, PR number or rowid descending). Then the owner's feed, Board and Projects rows
// change with no change in the data: another alarm on the first page, another deliverable under the 500 the feed reads,
// another "latest" report or merge, cards listed the other way round. Each expected value below is what the pre-index
// main (ae52f60) returned for the same fixture (Codex's repros, re-run there).
import assert from "node:assert/strict";
import { test } from "node:test";
import { DatabaseSync } from "node:sqlite";
import { Engine } from "../core/engine.ts";
import { migrate } from "../core/db.ts";
import { feedPage, type FeedSource } from "../core/feed.ts";

const ports = (now: number) => ({ now: () => now, deliver: async () => ({ delivery: "sent" as const }), mirror: () => {}, changed: () => {}, log: () => {} });
const source = (db: DatabaseSync, now: number, held = new Set<string>()) =>
  ({ db, now, seen: 0, resendMs: 60_000, batched: false, batchReadAt: () => null, openCards: [], scopeCards: [], live: () => false, heldProjects: held, prompts: [] }) as unknown as FeedSource;

test("alarms at one time: the feed's first page and the Board read list them as before the index", () => {
  const db = new DatabaseSync(":memory:");
  migrate(db as never);
  for (let i = 0; i < 5; i++) db.prepare(`INSERT INTO board (id, kind, title, body, at) VALUES (?, 'alarm', ?, '', ?)`).run(`b-${i}`, `b-${i}`, 1_700_000_000_000);
  const p = feedPage(source(db, 2_000_000_000_000), { cursor: null, filter: "alerts", limit: 2 });
  assert.deepEqual(p.posts.map((x) => x.key), ["board:b-2", "board:b-1"], "main's first page");
  assert.equal(p.cursor, "1700000000000|board:b-1");
  const e = new Engine(db as never, ports(2_000_000_000_000), { batchInbox: false });
  assert.deepEqual(e.board().map((r) => r.id), ["b-0", "b-1", "b-2", "b-3", "b-4"], "the Board read: first written first");
});

test("two deliverables tied at the feed's 500th: the first written is the one read, and the new count follows it", () => {
  const db = new DatabaseSync(":memory:");
  migrate(db as never);
  const start = 1_700_000_000_000;
  for (let i = 0; i < 501; i++) {
    const id = i < 499 ? `v-${String(i).padStart(4, "0")}` : i === 499 ? "v-a" : "v-z";
    const at = i < 499 ? start - 1000 : start;
    const project = i === 499 ? "held" : "kite";
    const d = { id, project, lead: "lead:kite", title: id, summary: "s", state: "approved", rev: 1, createdAt: at, feedback: [], revisions: [{ rev: 1, at: new Date(at).toISOString(), summary: "s", proof: [] }] };
    db.prepare(`INSERT INTO deliverables (id, project, lead, title, summary, state, rev, created_at, updated_at, json) VALUES (?, ?, 'lead:kite', ?, 's', 'approved', 1, ?, ?, ?)`).run(id, project, id, at, i < 499 ? start + 1000 : start, JSON.stringify(d));
  }
  const open = feedPage(source(db, start + 10_000), { cursor: null, filter: "delivered", limit: 2 });
  assert.deepEqual(open.posts.map((x) => x.key), ["deliverable:v-a", "deliverable:v-0498"], "v-a, written first, is the 500th");
  // with v-a's project held, main counted 499 new: v-z was never read
  const held = feedPage(source(db, start + 10_000, new Set(["held"])), { cursor: null, filter: "delivered", limit: 2 });
  assert.equal(held.newCount, 499);
});

test("Projects' latest report and merge at one time: the first written, as before the index", () => {
  const now = Date.parse("2026-11-23T12:00:00Z");
  const db = new DatabaseSync(":memory:");
  const e = new Engine(db as never, ports(now), { batchInbox: false });
  e.register("t-kite", "lead", "kite");
  db.prepare(`INSERT INTO board (id, kind, project, title, body, at) VALUES ('b1', 'report', 'kite', 'Z first', '', ?), ('b2', 'report', 'kite', 'A second', '', ?)`).run(now - 10 * 86_400_000, now - 10 * 86_400_000);
  assert.equal(e.projectSummaries().get("kite")!.last?.text, "Z first");
  db.prepare(`INSERT INTO events (at, kind, project, address, thread_id, value, ref, note, backfill) VALUES (?, 'pr', 'kite', 'lead:kite', 't-kite', 'merged', 'url20', '20', 0), (?, 'pr', 'kite', 'lead:kite', 't-kite', 'merged', 'url10', '10', 0)`).run(now, now);
  const s = e.projectSummaries().get("kite")!;
  assert.deepEqual({ last: s.last, done: s.done }, { last: { text: "PR #20 merged", at: now }, done: { text: "PR #20 merged", at: now, kind: "merged" } });
});

test("a project's history lists cards asked at one time in the order they were asked", () => {
  const now = Date.parse("2026-11-23T12:00:00Z");
  const e = new Engine(new DatabaseSync(":memory:") as never, ports(now), { batchInbox: false });
  const lead = e.register("t-kite", "lead", "kite");
  const cos = e.register("t-cos", "cos", null);
  const opts = [{ label: "Yes" }, { label: "No" }];
  const a = e.ask(lead, { title: "first", question: "?", options: opts });
  const b = e.ask(lead, { title: "second", question: "?", options: opts });
  for (const d of [a, b]) e.triageAskPerson(cos, d.id, { question: "?", options: opts, allowText: true });
  const aa = e.decision(a.id)!;
  e.personAnswer(a.id, aa.rev, aa.ask!.options[0]!.id, null, "desktop");
  assert.deepEqual(e.projectHistory("kite").rows.map((r) => ({ address: r.address, asks: r.asks.map((x) => x.title) })), [{ address: "lead:kite", asks: ["first", "second"] }]);
});
