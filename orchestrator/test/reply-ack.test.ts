// A reply counts as the ack (2026-11-16). Agents answered messages with orch_send and never acked them: the engine
// resent those messages and dead-lettered three answered ones, so the CoS chased work that was already done. Every
// test here asks one thing: does an answered message stop being chased, while an unanswered one is still chased?
import assert from "node:assert/strict";
import { test } from "node:test";
import { DatabaseSync } from "node:sqlite";
import { Engine, type DeliverResult } from "../core/engine.ts";
import type { Item } from "../core/model.ts";

function setup() {
  let clock = Date.parse("2026-11-16T10:00:00Z");
  const sent: { threadId: string; text: string; item: Item }[] = [];
  const e = new Engine(new DatabaseSync(":memory:") as never, {
    now: () => clock,
    async deliver(threadId, text, item): Promise<DeliverResult> {
      sent.push({ threadId, text, item });
      return { delivery: "sent" };
    },
    mirror: () => {},
    changed: () => {},
    log: () => {},
  }, { batchInbox: false });
  e.register("T-cos", "cos", null);
  const lead = e.register("T-la", "lead", "alpha");
  const worker = e.register("T-w1", "thread", "alpha", "T-la");
  const worker2 = e.register("T-w2", "thread", "alpha", "T-la");
  const item = (id: string) => e.items(500).find((i) => i.id === id)!;
  return { e, lead, worker, worker2, sent, item, advance: (ms: number) => (clock += ms) };
}

/** The lead writes, the thread's turn starts with it: what bb does when it delivers mail to an idle thread. */
async function deliverToActive(s: ReturnType<typeof setup>, text: string) {
  s.advance(1000);
  s.e.setStatus("T-w1", "idle");
  const m = s.e.send(s.lead, s.worker.address, text, null);
  await s.e.flush();
  s.advance(1000);
  s.e.setStatus("T-w1", "active");
  return m;
}

/** The recipient idles past the resend window twice: an unanswered message would be resent, then dead. */
async function idleOut(s: ReturnType<typeof setup>) {
  s.e.setStatus("T-w1", "idle");
  for (let i = 0; i < 3; i++) {
    s.advance(11 * 60_000);
    s.e.tick();
    await s.e.flush();
  }
}

test("a reply naming the message closes it as replied, with the reply as its note, and it is never resent or dead", async () => {
  const s = setup();
  const m = await deliverToActive(s, "Rebase 1104 onto dev, then tell me the new head.");
  s.e.send(s.worker, s.lead.address, "Rebased: new head ab12cd3.", null, m.id);
  const it = s.item(m.id);
  assert.equal(it.state, "closed");
  assert.equal(it.outcome, "replied", "answered, not 'done': the reply says it was heard, not that the work is finished");
  assert.match(it.note!, /new head ab12cd3/);
  await idleOut(s);
  assert.equal(s.item(m.id).state, "closed", "still closed: no resend, no dead letter");
  assert.equal(s.sent.filter((x) => x.item.id === m.id).length, 1, "the answered message went out once, never again");
});

test("an unanswered message is still resent and then dead-lettered: replies only close what they answer", async () => {
  const s = setup();
  const m = await deliverToActive(s, "Rebase 1104.");
  await idleOut(s);
  assert.equal(s.item(m.id).state, "dead");
});

test("a reply in the same turn, with no ref, closes the only open message and is marked for audit", async () => {
  const s = setup();
  const m = await deliverToActive(s, "Get ready for A3, but wait.");
  s.e.send(s.worker, s.lead.address, "Ready for A3 and waiting.", null);
  const it = s.item(m.id);
  assert.equal(it.outcome, "replied");
  assert.match(it.note!, /^same-turn reply i-\w+ \(no ref\): Ready for A3/, "the fallback's closes can be told apart from ref matches");
});

test("the no-ref fallback stays off when the reply could be about something else", async () => {
  // two open messages: which one it answers is a guess
  {
    const s = setup();
    const a = await deliverToActive(s, "First.");
    const b = s.e.send(s.lead, s.worker.address, "Second.", null);
    await s.e.flush();
    s.e.send(s.worker, s.lead.address, "Done.", null);
    assert.equal(s.item(a.id).state, "delivered");
    assert.equal(s.item(b.id).state, "delivered");
  }
  // a later turn: the thread went idle after the message arrived, so this reply isn't its answer
  {
    const s = setup();
    const m = await deliverToActive(s, "Rebase.");
    s.e.setStatus("T-w1", "idle");
    s.advance(60_000);
    s.e.setStatus("T-w1", "active");
    s.e.send(s.worker, s.lead.address, "Unrelated status.", null);
    assert.equal(s.item(m.id).state, "delivered");
  }
  // not the first mail back: the first one was the answer and the thread didn't ack, the second is news
  {
    const s = setup();
    const m = await deliverToActive(s, "Rebase.");
    s.e.send(s.worker, s.lead.address, "One.", null, "i-000000000000");
    s.e.send(s.worker, s.lead.address, "Two.", null);
    assert.equal(s.item(m.id).state, "delivered");
  }
});

test("only the recipient answering the sender closes it: forwarding the message to someone else doesn't", async () => {
  const s = setup();
  s.e.setStatus("T-la", "active");
  const m = s.e.send(s.worker, s.lead.address, "Blocked on a token.", null);
  await s.e.flush();
  s.e.send(s.lead, "cos", "Thread 1 is blocked on a token.", null, m.id);
  assert.equal(s.item(m.id).state, "delivered", "the lead told the CoS, not the thread");
  // another thread can't close it either, even naming it
  const m2 = await deliverToActive(s, "For thread 1 only.");
  s.e.send(s.worker2, s.lead.address, "Me too.", null, m2.id);
  assert.equal(s.item(m2.id).state, "delivered");
});

test("a report answers its lead's message: with ref, or as the turn's first word back", async () => {
  const s = setup();
  const m = await deliverToActive(s, "Ship A3.");
  const out = s.e.report(s.worker, "A3 done", "1104 rebased, CI green", "https://github.com/o/r/pull/1104", m.id);
  assert.match(out, /closes i-\w+ as replied/);
  assert.equal(s.item(m.id).outcome, "replied");
  const m2 = await deliverToActive(s, "Ship B.");
  s.e.report(s.worker, "B done", "dispatched", null);
  assert.match(s.item(m2.id).note!, /^same-turn reply .*report "B done"/);
});

test("replying to a lead's relay of the thread's own card closes the card too, as replied", async () => {
  const s = setup();
  const d2 = s.e.ask(s.worker, { title: "Push?", question: "Force-push?", options: [{ label: "Yes" }, { label: "No" }] });
  s.e.setStatus("T-w1", "idle");
  const relay = s.e.send(s.lead, s.worker.address, "Yes, force-push.", null, d2.id);
  await s.e.flush();
  assert.equal(s.e.decision(d2.id)!.state, "answered");
  s.e.send(s.worker, s.lead.address, "Pushed.", null, relay.id);
  const card = s.e.decision(d2.id)!;
  assert.equal(card.state, "acked", "else the thread's own card waits for an ack forever");
  assert.equal(card.ack!.outcome, "replied");
  s.e.ack(s.worker, relay.id, "done", "pushed at abc123");
  assert.equal(s.e.decision(d2.id)!.ack!.outcome, "done", "its later ack replaces 'replied' on the card too");
});

test("an ack after the reply still records the real outcome and its note reaches the sender", async () => {
  const s = setup();
  const m = await deliverToActive(s, "Rebase 1104.");
  s.e.send(s.worker, s.lead.address, "On it.", null, m.id);
  assert.equal(s.item(m.id).outcome, "replied");
  assert.equal(s.e.ack(s.worker, m.id, "failed", "the rebase conflicts"), `${m.id} closed: failed`, "'replied' only meant heard: the failure must not be lost");
  assert.equal(s.item(m.id).outcome, "failed");
  assert.ok(s.e.items(100).some((i) => i.recipient === s.lead.address && i.kind === "notice" && /failed, note: "the rebase conflicts"/.test(i.body)));
});

test("a keyed retry of an old reply closes nothing new", async () => {
  const s = setup();
  const first = await deliverToActive(s, "First.");
  s.e.send(s.worker, s.lead.address, "Ready.", "ready-1");
  assert.equal(s.item(first.id).outcome, "replied");
  const second = await deliverToActive(s, "Second.");
  s.e.send(s.worker, s.lead.address, "Ready.", "ready-1"); // the same call again, e.g. after a timeout
  assert.equal(s.item(second.id).state, "delivered", "the retry is the old answer to the first message");
});

test("agents can't pick 'replied' themselves, and the message tells them how to reply", async () => {
  const s = setup();
  const m = await deliverToActive(s, "Rebase.");
  assert.throws(() => s.e.ack(s.worker, m.id, "replied" as never, null), /outcome is one of/);
  const text = s.sent.find((x) => x.item.id === m.id)!.text;
  assert.match(text, new RegExp(`ref=${m.id} closes it as replied`), "running agents keep their old tool text; only the message itself can teach them");
});
