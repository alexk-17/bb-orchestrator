// The feed reads only the window a page can show (2026-11-23, lag): answered cards come newest-first from their index
// and a deliverable's post time from its index, so neither table's JSON is parsed in full. Paging must stay exactly what
// it was: every post once, newest activity first, a lifted post on top, a held project's posts out.
import assert from "node:assert/strict";
import { test } from "node:test";
import { DatabaseSync } from "node:sqlite";
import { Engine } from "../core/engine.ts";
import type { FeedPage } from "../core/feed.ts";

const T0 = Date.parse("2026-11-19T09:00:00Z");
const M = 60_000;
const opts = [{ label: "Yes" }, { label: "No" }];

function setup() {
  const clock = { t: T0 };
  const ports = { now: () => clock.t, deliver: async () => ({ delivery: "sent" as const }), mirror: () => {}, changed: () => {}, log: () => {} };
  const db = new DatabaseSync(":memory:");
  const e = new Engine(db as never, ports as never, { owner: "Robin", batchInbox: false, inboxDebounceMs: 2000, resendMs: 10 * M });
  const cos = e.register("T-cos", "cos", null);
  const kite = e.register("T-kite", "lead", "kite");
  const otter = e.register("T-otter", "lead", "otter");
  for (const a of [cos, kite, otter]) e.setStatus(a.threadId, "idle");
  /** A card the owner answered: asked now, answered a minute later. */
  const answered = (title: string, by = kite) => {
    const d = e.ask(by, { title, question: `${title}?`, options: opts });
    const asked = e.triageAskPerson(cos, d.id, { question: `${title}?`, options: opts, allowText: true });
    clock.t += M;
    return e.personAnswer(d.id, asked.rev, asked.ask!.options[0]!.id, null, "desktop");
  };
  /** Every page of the "all" filter, `limit` posts at a time, back to the end. */
  const pages = (limit: number) => {
    const out: FeedPage[] = [];
    let cursor: string | null = null;
    do {
      const p = e.feed({ cursor, filter: "all", limit });
      out.push(p);
      cursor = p.cursor;
    } while (cursor && out.length < 50);
    return out;
  };
  return { e, db, kite, otter, clock, answered, pages };
}

const cardKeys = (ps: FeedPage[]) => ps.flatMap((p) => p.posts).filter((p) => p.kind === "card").map((p) => p.key);

test("answered cards page newest first from their index: each shows once, and a held project's stay out", () => {
  const s = setup();
  const ids: string[] = [];
  for (let i = 0; i < 9; i++) {
    s.clock.t += M;
    ids.push(s.answered(`kite ${i}`).id);
  }
  s.clock.t += M;
  const held = s.answered("otter on hold", s.otter);
  s.e.setHold("otter", true);
  const ps = s.pages(2);
  assert.deepEqual(cardKeys(ps), ids.reverse().map((id) => `decision:${id}`), "every answered card once, newest first, across pages of 2");
  assert.ok(!cardKeys(ps).includes(`decision:${held.id}`), "the held project's card is left out, as before");
  assert.equal(ps.at(-1)!.cursor, null, "the last page says there is no more");
  // the answered cards' query reads its window from the index, never the whole decisions table
  const plan = (s.db.prepare(`EXPLAIN QUERY PLAN SELECT json FROM decisions INDEXED BY decisions_feed_answered WHERE state IN ('answered','acked') AND json_extract(json, '$.answer.by') = 'person' AND COALESCE(NULLIF(json_extract(json, '$.returned.at'), ''), NULLIF(json_extract(json, '$.ask.at'), ''), json_extract(json, '$.created_at')) < ? ORDER BY 1 LIMIT 3`).all("~") as { detail: string }[]).map((r) => r.detail).join(" ");
  assert.match(plan, /decisions_feed_answered/);
});

test("an old answered card, far below the window, rises to the top when the lead answers a new message on it", () => {
  const s = setup();
  s.clock.t += M;
  const old = s.answered("the old one");
  for (let i = 0; i < 8; i++) {
    s.clock.t += M;
    s.answered(`newer ${i}`);
  }
  assert.ok(!s.e.feed({ cursor: null, filter: "all", limit: 3 }).posts.some((p) => p.key === `decision:${old.id}`), "not on page one before");
  s.clock.t += M;
  const m = s.e.ownerMessage("kite", "Still true?", null, [], `decision:${old.id}`);
  s.clock.t += M;
  s.e.ack(s.kite, m.id, "done", "Yes, still true.");
  const first = s.e.feed({ cursor: null, filter: "all", limit: 3 });
  assert.equal(first.posts[0]!.key, `decision:${old.id}`, "the lead's answer lifts it to the top of page one");
  assert.equal(first.posts[0]!.activity, s.clock.t);
  const all = cardKeys(s.pages(3));
  assert.equal(all.filter((k) => k === `decision:${old.id}`).length, 1, "and it isn't shown again where its own time would put it");
});

test("a deliverable's post keeps the time of its newest revision, not of its last save (approving it doesn't move it)", () => {
  const s = setup();
  const d = s.e.deliver(s.kite, { title: "Checklist", summary: "Three steps.", proof: [{ kind: "link", caption: "preview", url: "https://example.com/p" }] }, { roots: [] });
  const deliveredAt = s.clock.t;
  s.clock.t += 30 * M;
  s.e.personApprove(d.id, d.rev, null);
  const post = s.e.feed({ cursor: null, filter: "all" }).posts.find((p) => p.key === `deliverable:${d.id}`)!;
  assert.equal(post.at, deliveredAt, "the post's time is the revision's, read from the index");
  assert.equal(post.outcome, "approved rev 1", "its JSON is still read for the post itself");
});
