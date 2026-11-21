// A lead closes its own threads' cards without a standing rule (owner-approved 2026-11-13). Before this, orch_answer
// needed a rule id; leads with no rules (agent-v2) relayed with orch_send(ref=<card>), and 19 cards stayed open for
// good: the threads couldn't ack them, and they sat in the lead's "waiting for you" list forever.
import assert from "node:assert/strict";
import { test } from "node:test";
import { DatabaseSync } from "node:sqlite";
import { Engine, type DeliverResult, type Ports } from "../core/engine.ts";
import type { Item } from "../core/model.ts";

function setup() {
  let clock = Date.parse("2026-11-13T10:00:00Z");
  const sent: { threadId: string; item: Item }[] = [];
  const db = new DatabaseSync(":memory:");
  const ports: Ports = {
    now: () => clock,
    async deliver(threadId, _text, item): Promise<DeliverResult> {
      sent.push({ threadId, item });
      return { delivery: "sent" };
    },
    mirror: () => {},
    changed: () => {},
    log: () => {},
  };
  const e = new Engine(db as never, ports, { batchInbox: false });
  e.register("T-cos", "cos", null);
  const lead = e.register("T-la", "lead", "alpha");
  const worker = e.register("T-w1", "thread", "alpha", "T-la");
  const other = e.register("T-w2", "thread", "alpha", "T-la");
  return { e, db, ports, lead, worker, other, sent, advance: (ms: number) => (clock += ms) };
}

const two = [{ label: "Ticket it" }, { label: "Drop it" }];

test("a lead with no standing rule settles its thread's card as its own call, and the thread can ack it", async () => {
  const s = setup();
  const d = s.e.ask(s.worker, { title: "Ticket?", question: "Ticket the follow-up?", options: two });
  s.e.leadAnswer(s.lead, d.id, null, "1", "follow-ups get tickets in this project");
  const a = s.e.decision(d.id)!;
  assert.equal(a.state, "answered");
  assert.equal(a.answer!.via, "lead", "recorded as the lead's call, not a rule's");
  assert.equal(a.answer!.source, "lead's own call");
  assert.equal(a.answer!.text, "follow-ups get tickets in this project");
  await s.e.flush();
  assert.ok(s.sent.some((x) => x.threadId === "T-w1" && x.item.kind === "decision.answer" && x.item.ref === d.id), "the answer reaches the thread");
  assert.match(s.e.ack(s.worker, d.id, "done", null), /acked/);
  assert.equal(s.e.inbox(s.lead).text.includes(d.id), false, "it leaves the lead's waiting list");
});

test("an own call needs a note: an unexplained answer would leave no record of why", () => {
  const s = setup();
  const d = s.e.ask(s.worker, { title: "Ticket?", question: "Ticket the follow-up?", options: two });
  assert.throws(() => s.e.leadAnswer(s.lead, d.id, null, "1", null), /note/);
  assert.throws(() => s.e.leadAnswer(s.lead, d.id, null, "1", "   "), /note/);
  // a lead running on the old tool schema still has to send some rule_id: an empty one means no rule
  assert.throws(() => s.e.leadAnswer(s.lead, d.id, "", "1", null), /note/);
  s.e.leadAnswer(s.lead, d.id, "", "2", "out of scope");
  assert.equal(s.e.decision(d.id)!.answer!.label, "Drop it");
});

test("an own call never reaches a card the lead filed up: once with the CoS or the owner, it is theirs", () => {
  const s = setup();
  const d = s.e.ask(s.worker, { title: "Ticket?", question: "Ticket the follow-up?", options: two });
  s.e.forward(s.lead, d.id, null);
  assert.throws(() => s.e.leadAnswer(s.lead, d.id, null, "1", "mine after all"), /isn't your thread's question/);
  assert.equal(s.e.decision(d.id)!.state, "open");
});

test("a lead's orch_send(ref=<card>) to the asking thread settles the card, and the thread's ack of that message closes it", async () => {
  const s = setup();
  const d = s.e.ask(s.worker, { title: "Ticket?", question: "Ticket the follow-up?", options: two });
  await s.e.flush();
  assert.match(s.e.inbox(s.lead).text, new RegExp(`waiting for you[^]*${d.id}`), "the card waits for the lead");
  const relay = s.e.send(s.lead, s.worker.address, "Option 1: ticket it under the epic.", null, d.id);
  const a = s.e.decision(d.id)!;
  assert.equal(a.state, "answered", "the relay is the lead's answer");
  assert.equal(a.answer!.via, "lead");
  assert.equal(a.answer!.text, "Option 1: ticket it under the epic.");
  assert.deepEqual(a.relay!.items, [`${s.worker.address}/${relay.id}`], "the relay message is the delivery: no second answer item");
  assert.equal(s.e.inbox(s.lead).text.includes(d.id), false, "it leaves the lead's waiting list at once");
  // threads ack the message they got (its render says ack id=<item>): that has to close the card too
  assert.match(s.e.ack(s.worker, relay.id, "done", "ticketed"), new RegExp(`${d.id} acked`));
  const after = s.e.decision(d.id)!;
  assert.equal(after.state, "acked");
  assert.equal(after.ack!.by, s.worker.address);
  assert.equal(s.e.inbox(s.worker).count, 0);
});

test("a relay settles nothing that isn't the lead's to settle: a filed-up card, or a message to another thread", () => {
  const s = setup();
  const up = s.e.ask(s.worker, { title: "Prod?", question: "Apply to prod?", options: two });
  s.e.forward(s.lead, up.id, null);
  s.e.send(s.lead, s.worker.address, "Holding: I've asked the owner.", null, up.id);
  assert.equal(s.e.decision(up.id)!.state, "open", "a card with the CoS or the owner stays theirs");
  const mine = s.e.ask(s.worker, { title: "Ticket?", question: "Ticket the follow-up?", options: two });
  s.e.send(s.lead, s.other.address, "FYI, see the other thread's question.", null, mine.id);
  assert.equal(s.e.decision(mine.id)!.state, "open", "only a relay to the asker answers it");
  s.e.send(s.worker, s.lead.address, "Any news?", null, mine.id);
  assert.equal(s.e.decision(mine.id)!.state, "open", "the thread's own message is no answer");
});

test("start-up repair: cards relayed before relays settled them are answered from the first relay, and acked once the thread closed it", () => {
  const s = setup();
  const closed = s.e.ask(s.worker, { title: "Ticket?", question: "Ticket the follow-up?", options: two });
  const pending = s.e.ask(s.other, { title: "Retry?", question: "Build the retry?", options: two });
  const notRelayed = s.e.ask(s.worker, { title: "Docs?", question: "Write the docs?", options: two });
  const upstairs = s.e.ask(s.worker, { title: "Prod?", question: "Apply to prod?", options: two });
  s.e.forward(s.lead, upstairs.id, null);
  // the relays as 1.2.x wrote them: plain messages with the card as ref, the card left open
  const legacy = (id: string, to: string, ref: string, body: string, at: number, state: string, outcome: string | null) =>
    s.db
      .prepare(`INSERT INTO items (id, recipient, sender, kind, ref, body, needs_ack, state, attempts, created_at, closed_at, outcome) VALUES (?, ?, 'lead:alpha', 'message', ?, ?, 1, ?, 1, ?, ?, ?)`)
      .run(id, to, ref, body, state, at, state === "closed" ? at + 60_000 : null, outcome);
  const t = Date.parse("2026-11-13T12:00:00Z");
  legacy("i-first", s.worker.address, closed.id, "Lead call: option 1.", t, "closed", "done");
  legacy("i-second", s.worker.address, closed.id, "Option 1, and also: …", t + 1000, "closed", "done");
  legacy("i-open", s.other.address, pending.id, "Yes, build it.", t, "delivered", null);
  legacy("i-up", s.worker.address, upstairs.id, "Holding for the owner.", t, "closed", "done");
  const upBefore = JSON.stringify(s.e.decision(upstairs.id));
  const itemsBefore = (s.db.prepare(`SELECT COUNT(*) AS n FROM items`).get() as { n: number }).n;

  const e2 = new Engine(s.db as never, s.ports, { batchInbox: false });
  const c = e2.decision(closed.id)!;
  assert.equal(c.state, "acked", "the thread had closed its relay: nobody is left to ack the card");
  assert.equal(c.answer!.text, "Lead call: option 1.", "the first relay is the call");
  assert.equal(c.answer!.source, "lead's own call, relayed in i-first");
  assert.equal(c.ack!.outcome, "done");
  assert.equal(c.ack!.by, s.worker.address);
  const p = e2.decision(pending.id)!;
  assert.equal(p.state, "answered", "an unacked relay: the thread still acks it");
  assert.equal(e2.decision(notRelayed.id)!.state, "open", "never relayed: still the lead's to answer");
  assert.equal(JSON.stringify(e2.decision(upstairs.id)), upBefore, "a card above the lead is never touched");
  assert.equal((s.db.prepare(`SELECT COUNT(*) AS n FROM items`).get() as { n: number }).n, itemsBefore, "the repair sends no mail");
  const rev = e2.decision(closed.id)!.rev;
  new Engine(s.db as never, s.ports, { batchInbox: false });
  assert.equal(e2.decision(closed.id)!.rev, rev, "idempotent: a second start changes nothing");
});

test("a thread's ack of some other message about its answered card leaves the card answered: only the relay that answered it closes it", () => {
  const s = setup();
  const d = s.e.ask(s.worker, { title: "Ticket?", question: "Ticket the follow-up?", options: two });
  const r = s.e.addRule({ text: "alpha tickets follow-ups", project: "alpha", kinds: ["question"], expiresAt: null, source: "test" });
  s.e.leadAnswer(s.lead, d.id, r.id, "1", null);
  const note = s.e.send(s.lead, s.worker.address, "Use the epic EPIC-1 for it.", null, d.id);
  s.e.ack(s.worker, note.id, "done", null);
  assert.equal(s.e.decision(d.id)!.state, "answered", "the answer itself is still the thread's to ack");
});

test("a lead on the old tool schema that sends a made-up rule id is told how to answer as its own call", () => {
  const s = setup();
  const d = s.e.ask(s.worker, { title: "Ticket?", question: "Ticket the follow-up?", options: two });
  assert.throws(() => s.e.leadAnswer(s.lead, d.id, "none", "1", "mine"), /empty rule_id and a note/);
});
