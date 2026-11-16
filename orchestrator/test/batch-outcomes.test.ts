// With the batched inbox, a digest's cursor ack means "I read these". It must never stand in for an outcome: a message
// that asks for one keeps waiting for orch_ack(id, outcome) or a reply with its ref, so the sender still gets the ack
// note, a relayed card still settles, and nothing is closed as "read" that its sender expects an answer to.
import assert from "node:assert/strict";
import { test } from "node:test";
import { DatabaseSync } from "node:sqlite";
import { Engine, type DeliverResult } from "../core/engine.ts";
import type { Item } from "../core/model.ts";

const three = [{ label: "Ship it" }, { label: "Wait" }, { label: "Drop it" }];

function setup() {
  const clock = { t: Date.parse("2026-11-16T10:00:00Z") };
  const db = new DatabaseSync(":memory:");
  const sent: { threadId: string; text: string; item: Item }[] = [];
  const e = new Engine(
    db as never,
    {
      now: () => clock.t,
      deliver: async (threadId: string, text: string, item: Item): Promise<DeliverResult> => {
        sent.push({ threadId, text, item });
        return { delivery: "sent" };
      },
      mirror: () => {},
      changed: () => {},
      log: () => {},
    },
    { batchInbox: true, inboxDebounceMs: 2000, resendMs: 10_000 },
  );
  const cos = e.register("T-cos", "cos", null);
  const lead = e.register("T-la", "lead", "alpha");
  const worker = e.register("T-w1", "thread", "alpha", "T-la");
  for (const a of [cos, lead, worker]) e.setStatus(a.threadId, "idle");
  const item = (id: string) => e.items().find((i) => i.id === id)!;
  return { e, db, clock, sent, cos, lead, worker, item };
}

test("a cursor ack reads a message but doesn't close it: the explicit ack still sends its note back", async () => {
  const s = setup();
  const m = s.e.send(s.cos, s.lead.address, "Check the release notes and tell me what you found", null);
  const digest = s.e.batch.read(s.lead);
  assert.match(digest.text, new RegExp(`ack id=${m.id} with an outcome`), "the digest shows the message as its recipient reads it, ack line included");
  assert.equal(s.e.batch.ack(s.lead, digest.cursor!), 1);
  assert.equal(s.e.batch.read(s.lead).count, 0, "read: no more wakes for it");
  assert.equal(s.item(m.id).state, "delivered", "read, not handled");
  assert.equal(s.item(m.id).outcome, null);
  assert.equal(s.e.ack(s.lead, m.id, "done", "two typos, fixed"), `${m.id} closed: done`, "never 'already closed'");
  const note = s.e.items().find((i) => i.recipient === "cos" && i.ref === m.id)!;
  assert.match(note.body, /done, note: "two typos, fixed"/, "the sender hears the outcome and the note");
  assert.match(s.e.inbox(s.lead).text, /No open items/);
});

test("a reply with the message's ref still closes it as replied in batch mode; one without a ref doesn't guess", async () => {
  const s = setup();
  const m = s.e.send(s.cos, s.lead.address, "Which branch?", null);
  const other = s.e.send(s.cos, s.lead.address, "And the PR?", null);
  s.e.batch.ack(s.lead, s.e.batch.read(s.lead).cursor!);
  s.e.send(s.lead, s.cos.address, "main", null, m.id);
  assert.equal(s.item(m.id).outcome, "replied");
  s.e.setStatus(s.lead.threadId, "active");
  s.e.send(s.lead, s.cos.address, "no PR yet", null);
  assert.equal(s.item(other.id).state, "delivered", "no ref: nothing is closed by a guess");
});

test("a relay of a thread's answered card is settled by the thread's own ack, never by its cursor ack", async () => {
  const s = setup();
  const d = s.e.ask(s.worker, { title: "Ship?", question: "Ship the thing?", options: three });
  s.e.forward(s.lead, d.id, null);
  s.e.triageAskPerson(s.cos, d.id, { question: "ship?", options: three, allowText: true });
  s.e.personAnswer(d.id, s.e.decision(d.id)!.rev, "1", null, "desktop");
  const relay = s.e.send(s.lead, s.worker.address, "The owner says ship it.", null, d.id);
  const state = s.e.decision(d.id)!.state;
  s.e.batch.ack(s.worker, s.e.batch.read(s.worker).cursor!);
  assert.equal(s.e.decision(d.id)!.state, state, "reading the relay settles nothing");
  assert.equal(s.item(relay.id).state, "delivered");
  s.e.ack(s.worker, relay.id, "done", "shipped");
  assert.equal(s.item(relay.id).outcome, "done");
});

test("what needs no outcome (a copy, a notice) closes on the cursor ack, as delivery closes it per message", async () => {
  const s = setup();
  s.e.register("T-lb", "lead", "beta");
  s.e.send(s.lead, "lead:beta", "fyi", null); // lead-to-lead: a copy goes to the CoS
  const copy = s.e.items().find((i) => i.kind === "copy" && i.recipient === "cos")!;
  assert.equal(copy.needsAck, false);
  s.e.batch.ack(s.cos, s.e.batch.read(s.cos).cursor!);
  assert.equal(s.item(copy.id).state, "closed");
  assert.equal(s.item(copy.id).outcome, "read");
});
