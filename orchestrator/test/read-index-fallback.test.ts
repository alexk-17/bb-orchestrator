// Two reads name their index outright (INDEXED BY), because the live database has no planner stats (2026-11-23, lag).
// SQLite refuses such a hint when the index is missing, so a database that lost or never built one would fail the
// owner's whole feed or Projects tab (Codex review, P1). Each read must fall back to the same query without the hint:
// slower, the same posts and rows, never an error.
import assert from "node:assert/strict";
import { test } from "node:test";
import { DatabaseSync } from "node:sqlite";
import { Engine } from "../core/engine.ts";
import type { FeedPage } from "../core/feed.ts";

const T0 = Date.parse("2026-11-19T09:00:00Z");
const M = 60_000;
const opts = [{ label: "Yes" }, { label: "No" }];
const HINTED = ["decisions_feed_answered", "board_reports"];

function setup() {
  const clock = { t: T0 };
  const ports = { now: () => clock.t, deliver: async () => ({ delivery: "sent" as const }), mirror: () => {}, changed: () => {}, log: () => {} };
  const db = new DatabaseSync(":memory:");
  const e = new Engine(db as never, ports as never, { owner: "Robin", batchInbox: false, inboxDebounceMs: 2000, resendMs: 10 * M });
  const cos = e.register("T-cos", "cos", null);
  const kite = e.register("T-kite", "lead", "kite");
  const w = e.register("T-kite-1", "thread", "kite", "T-kite");
  for (const a of [cos, kite, w]) e.setStatus(a.threadId, "idle");
  const ids: string[] = [];
  for (let i = 0; i < 5; i++) {
    clock.t += M;
    const d = e.ask(kite, { title: `kite ${i}`, question: `kite ${i}?`, options: opts });
    const asked = e.triageAskPerson(cos, d.id, { question: `kite ${i}?`, options: opts, allowText: true });
    clock.t += M;
    ids.push(e.personAnswer(d.id, asked.rev, asked.ask!.options[0]!.id, null, "desktop").id);
  }
  clock.t += M;
  e.report(w, "Older report", "details", null);
  clock.t += M;
  e.report(w, "Search box fixed", "details", null);
  /** What the owner sees from both reads: every "all" page, two posts at a time, and the project's latest finished thing. */
  const read = () => {
    const pages: FeedPage[] = [];
    let cursor: string | null = null;
    do {
      const p = e.feed({ cursor, filter: "all", limit: 2 });
      pages.push(p);
      cursor = p.cursor;
    } while (cursor && pages.length < 20);
    return { pages, last: e.projectSummaries().get("kite")!.last };
  };
  return { db, ids, read };
}

test("with either hinted index missing, the feed and the Projects row read the same as with it, instead of throwing", () => {
  for (const index of HINTED) {
    const s = setup();
    const withIndex = s.read();
    // what the owner sees with the index: the answered cards newest first, and the latest report on the quiet row
    const cards = withIndex.pages.flatMap((p) => p.posts).filter((p) => p.kind === "card").map((p) => p.key);
    assert.deepEqual(cards, [...s.ids].reverse().map((id) => `decision:${id}`));
    assert.equal(withIndex.last?.text, "Search box fixed");
    const def = (s.db.prepare(`SELECT sql FROM sqlite_master WHERE type = 'index' AND name = ?`).get(index) as { sql: string }).sql;
    s.db.exec(`DROP INDEX ${index}`);
    // the hint alone would fail here: this is the read that has to survive
    assert.throws(() => s.db.prepare(`SELECT 1 FROM ${index.startsWith("board") ? "board" : "decisions"} INDEXED BY ${index}`), /no such index/);
    assert.deepEqual(s.read(), withIndex, `${index} missing: the same pages, cursors and Projects row`);
    s.db.exec(def);
    assert.deepEqual(s.read(), withIndex, `${index} back: the hinted read again`);
  }
});
