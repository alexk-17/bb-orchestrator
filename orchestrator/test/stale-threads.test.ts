import assert from "node:assert/strict";
import { test } from "node:test";
import { DatabaseSync } from "node:sqlite";
import { Engine, type DeliverResult, type PrResult, STALE_WAKE_MS } from "../core/engine.ts";

const DAY = STALE_WAKE_MS;
const pr = (url: string, review: string, checks = "passing"): PrResult => ({
  outcome: "available",
  pullRequest: { url, number: Number(url.split("/").pop()), state: "open", checks: { state: checks }, review: { state: review }, mergeability: { mergeable: "MERGEABLE", state: "blocked" } },
});

function setup() {
  let clock = Date.parse("2026-11-13T18:00:00Z");
  const e = new Engine(new DatabaseSync(":memory:") as never, {
    now: () => clock,
    async deliver(): Promise<DeliverResult> {
      return { delivery: "sent" };
    },
    mirror: () => {},
    changed: () => {},
    log: () => {},
  });
  e.register("T-cos", "cos", null);
  const lead = e.register("T-la", "lead", "alpha");
  const quiet = e.register("T-lq", "lead", "quiet");
  const t = (n: number) => e.register(`T-${n}`, "thread", "alpha", "T-la");
  const toCos = () => e.items(500).filter((i) => i.recipient === "cos" && i.body.startsWith("Daily stale-thread check")).reverse(); // oldest first
  return { e, lead, quiet, t, toCos, advance: (ms: number) => (clock += ms), now: () => clock };
}

test("only threads idle over a day with nothing to wait on are listed, with leads that never spoke", () => {
  const s = setup();
  s.e.send(s.lead, "cos", "alpha is running", null); // alpha's lead has spoken; quiet's never has
  const done = s.t(1); // finished: idle, nothing open
  const asking = s.t(2); // waits on its own open card
  const reviewing = s.t(3); // waits on a reviewer
  const bound = s.t(4); // its PR has an answer bound to it
  const busy = s.t(5); // working
  for (const a of [done, asking, reviewing, bound]) s.e.setStatus(a.threadId, "idle");
  s.e.setStatus(busy.threadId, "active");
  s.e.ask(asking, { title: "Which?", question: "Which way?", options: [{ label: "A" }, { label: "B" }] });
  s.e.setEnvironment(reviewing.threadId, "env-3");
  s.e.prSeen(s.e.agentByThread(reviewing.threadId)!, "env-3", pr("https://github.com/o/r/pull/3", "review_requested"));
  s.e.setEnvironment(bound.threadId, "env-4");
  s.e.prSeen(s.e.agentByThread(bound.threadId)!, "env-4", pr("https://github.com/o/r/pull/4", "approved"));
  const card = s.e.ask(s.lead, { title: "Merge 4?", question: "Merge 4 when it's ready?", options: [{ label: "Yes" }, { label: "No" }] });
  s.e.triageAskPerson(s.e.agentByAddress("cos")!, card.id, { question: "Merge 4 when ready?", options: [{ label: "Yes" }, { label: "No" }], allowText: true });
  s.e.personAnswer(card.id, s.e.decision(card.id)!.rev, "1", null, "desktop");
  s.e.ack(s.lead, card.id, "done", null, { pr: "https://github.com/o/r/pull/4", when: "merged" });
  s.advance(DAY + 60_000);
  s.e.tick();
  const items = s.toCos();
  assert.equal(items.length, 1);
  const body = items[0]!.body;
  assert.match(body, /Threads idle over a day with nothing to wait on \(1\):\n- thread:alpha:1: idle 1d/);
  assert.match(body, /Leads that never sent anything \(1\):\n- lead:quiet: started 1d ago/);
  for (const a of [asking, reviewing, bound, busy]) assert.doesNotMatch(body, new RegExp(`${a.address}:`), `${a.address} is waiting on something or working`);
  assert.equal(items[0]!.needsAck, false);
  assert.equal(s.e.needsYou().cards.filter((c) => !c.request_key?.startsWith("inbox-stuck:")).length, 0, "it goes to the CoS, never to the owner");
});

test("once a day at most, nothing when the list is empty, and nothing when it hasn't changed", () => {
  const s = setup();
  s.e.send(s.quiet, "cos", "here", null);
  s.e.send(s.lead, "cos", "here", null);
  s.e.tick();
  assert.equal(s.toCos().length, 0, "nobody stale: no item");
  const a = s.t(1);
  s.e.setStatus(a.threadId, "idle");
  s.advance(DAY + 1);
  s.e.tick();
  assert.equal(s.toCos().length, 1);
  s.advance(60 * 60_000);
  s.e.tick();
  assert.equal(s.toCos().length, 1, "not again within the day");
  s.advance(DAY);
  s.e.tick();
  assert.equal(s.toCos().length, 1, "the same thread still stale a day later is not news");
  const b = s.t(2);
  s.e.setStatus(b.threadId, "idle");
  s.advance(DAY + 1);
  s.e.tick();
  assert.equal(s.toCos().length, 2, "a new name is");
  assert.match(s.toCos()[1]!.body, /\(2\):\n- thread:alpha:1: .*\n- thread:alpha:2/);
});

test("rows the engine writes under a lead's address don't count as the lead speaking", () => {
  const s = setup();
  s.e.send(s.lead, "cos", "here", null);
  s.e.setEnvironment("T-lq", "env-q");
  s.e.prSeen(s.quiet, "env-q", pr("https://github.com/o/r/pull/9", "approved")); // a PR reading on the board, by the engine
  s.advance(DAY + 1);
  s.e.tick();
  assert.match(s.toCos()[0]!.body, /lead:quiet: started 1d ago/);
});

test("a lead counts as new for a day, and a restart under an old address doesn't make it new", () => {
  const s = setup();
  s.e.send(s.lead, "cos", "here", null);
  s.e.tick();
  assert.equal(s.toCos().length, 0, "the quiet lead started just now: not stale yet");
  s.advance(DAY + 1);
  s.e.retire("T-lq");
  s.e.register("T-lq2", "lead", "quiet");
  s.advance(STALE_WAKE_MS);
  s.e.tick();
  assert.match(s.toCos()[0]!.body, /lead:quiet: started 2d ago/);
});
