import { test } from "node:test";
import assert from "node:assert/strict";
import { DatabaseSync } from "node:sqlite";
import {
  assess,
  pick,
  parsePrUrl,
  replyOutcome,
  cooldownUntil,
  MIN_GAP,
  HOLD,
  type Facts,
  type Entry,
} from "../review-queue/core.ts";
import { QueueStore } from "../review-queue/store.ts";
const now = 1_800_000_000_000;
const facts = (p: Partial<Facts> = {}): Facts => ({
  url: "https://github.com/acme/app/pull/1",
  title: "A fix",
  head: "abc",
  author: "owner",
  state: "open",
  draft: false,
  conflict: false,
  ci: "pass",
  approvals: 0,
  threads: 2,
  reviewedHead: false,
  lastReview: null,
  inProgressAt: null,
  recentRequestAt: null,
  ...p,
});
const entry = (p: Partial<Entry> = {}): Entry => ({
  url: facts().url,
  auto: false,
  pinned: false,
  addedAt: now,
  facts: facts(),
  error: null,
  fetchedAt: now,
  ...p,
});
test("only canonical GitHub PR URLs enter the queue", () => {
  assert.equal(
    parsePrUrl("https://github.com/acme/app/pull/12/files").url,
    "https://github.com/acme/app/pull/12",
  );
  for (const url of [
    "https://evil.test/acme/app/pull/1",
    "https://github.com/acme/app/issues/1",
    "https://github.com/a/b/pull/0",
    "https://github.com/a/b/pull/1;echo",
  ])
    assert.throws(() => parsePrUrl(url));
});
test("eligibility skips completed heads, drafts, closed and incomplete reads", () => {
  for (const f of [
    { state: "merged" },
    { state: "closed" },
    { draft: true },
    { reviewedHead: true },
  ] as Partial<Facts>[])
    assert.equal(
      assess(entry({ facts: facts(f) }), null, "owner", now).eligible,
      false,
    );
  assert.equal(
    assess(entry({ error: "read incomplete" }), null, "owner", now).eligible,
    false,
  );
  assert.equal(assess(entry(), null, "owner", now).eligible, true);
});
test("auto only accepts authenticated user's green, conflict-free PRs", () => {
  for (const f of [
    { author: "someone" },
    { ci: "pending" },
    { ci: "fail" },
    { ci: "unknown" },
    { conflict: true },
  ] as Partial<Facts>[])
    assert.equal(
      assess(entry({ auto: true, facts: facts(f) }), null, "owner", now)
        .eligible,
      false,
    );
  assert.equal(
    assess(entry({ facts: facts({ ci: "fail" }) }), null, "owner", now)
      .eligible,
    true,
  );
});
test("in-progress markers, recent requests and attempts hold safely", () => {
  for (const f of [
    { inProgressAt: now },
    { inProgressAt: 0 },
    { recentRequestAt: now },
  ] as Partial<Facts>[])
    assert.equal(
      assess(entry({ facts: facts(f) }), null, "owner", now).eligible,
      false,
    );
  const attempt = {
    url: facts().url,
    head: "abc",
    at: now,
    outcome: "unknown" as const,
    attempts: 1,
    commentUrl: null,
  };
  assert.equal(
    assess(entry(), attempt, "owner", now + HOLD - 1).eligible,
    false,
  );
  assert.equal(
    assess(entry(), { ...attempt, attempts: 3, at: now - HOLD }, "owner", now)
      .eligible,
    false,
  );
  assert.equal(
    assess(
      entry(),
      { ...attempt, head: "old", attempts: 3, at: now - HOLD },
      "owner",
      now,
    ).eligible,
    true,
  );
});
test("pins precede approval tiers, then stable queue order", () => {
  const a = entry({ url: "a" }),
    b = entry({ url: "b", facts: facts({ approvals: 1 }) }),
    c = entry({ url: "c", pinned: true });
  assert.equal(pick([a, b, c], {}, "owner", now)?.url, "c");
  assert.equal(pick([a, b], {}, "owner", now)?.url, "b");
  assert.equal(pick([a, entry({ url: "d" })], {}, "owner", now)?.url, "a");
});
test("reply parsing accepts only bot replies after this trigger; cooldown is bounded", () => {
  const reply = {
    author: "coderabbitai[bot]",
    body: "<!-- auto-generated reply by CodeRabbit --> Action performed",
    at: now,
  };
  assert.equal(replyOutcome([reply], now - 1), "accepted");
  assert.equal(replyOutcome([{ ...reply, author: "owner" }], now - 1), null);
  assert.equal(replyOutcome([reply], now + 1), null);
  assert.equal(
    replyOutcome(
      [
        {
          ...reply,
          body: "auto-generated reply by CodeRabbit: Action not completed",
        },
      ],
      now - 1,
    ),
    "not_completed",
  );
  assert.equal(
    replyOutcome(
      [{ ...reply, body: "auto-generated reply by CodeRabbit: Rate limit" }],
      now - 1,
    ),
    "rate_limited",
  );
  assert.equal(
    cooldownUntil(
      "Next included review available in 2 hours 5 minutes.",
      now,
      now,
    ),
    now + 125 * 60_000,
  );
  assert.equal(
    cooldownUntil("Next included review available in 999999 hours.", now, now),
    now + 6 * MIN_GAP,
  );
  assert.equal(cooldownUntil("unknown", now, now), now + MIN_GAP);
});
test("durable leases prevent concurrent ticks and survive restart; removing doesn't erase attempts", () => {
  const db = new DatabaseSync(":memory:");
  const a = new QueueStore(db),
    b = new QueueStore(db);
  a.mutate((s) => {
    s.entries.push(entry());
  });
  assert.equal(a.claim("a", now), true);
  assert.equal(b.claim("b", now + 1), false);
  a.mutate((s) => {
    s.history[facts().url] = {
      url: facts().url,
      head: "abc",
      at: now,
      outcome: "posting",
      attempts: 1,
      commentUrl: null,
    };
    s.entries = [];
  });
  assert.equal(
    new QueueStore(db).get().history[facts().url]?.outcome,
    "posting",
  );
  a.release("a");
  assert.equal(b.claim("b", now + 2), true);
  db.close();
});
