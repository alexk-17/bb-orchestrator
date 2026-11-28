import assert from "node:assert/strict";
import { test } from "node:test";
import { DatabaseSync } from "node:sqlite";
import { Engine, type DeliverResult } from "../core/engine.ts";
import type { Item } from "../core/model.ts";

function setup() {
  const clock = { t: 100_000 };
  const sent: { threadId: string; text: string; item: Item }[] = [];
  let failFor = new Set<string>();
  let queue = false;
  const e = new Engine(
    new DatabaseSync(":memory:") as never,
    {
      now: () => clock.t,
      deliver: async (threadId: string, text: string, item: Item): Promise<DeliverResult> => {
        if (failFor.has(threadId)) throw new Error("bb unreachable");
        sent.push({ threadId, text, item });
        return queue ? { delivery: "queued", queuedMessageId: `q-${sent.length}` } : { delivery: "sent" };
      },
      mirror: () => {},
      changed: () => {},
      log: () => {},
    },
    { batchInbox: true, inboxDebounceMs: 2000, resendMs: 10_000 },
  );
  const cos = e.register("T-cos", "cos", null);
  const lead = e.register("T-lead", "lead", "demo");
  e.setStatus(cos.threadId, "idle");
  e.setStatus(lead.threadId, "idle");
  /** Run the clock past debounce and the idle retry, flushing each step, `n` times. */
  const run = async (n: number) => {
    for (let i = 0; i < n; i++) {
      clock.t += 11_000;
      await e.flush();
    }
  };
  const toCos = () => e.items().filter((i) => i.recipient === "cos" && i.sender === "orchestrator" && /inbox wake is dead/.test(i.body));
  return { e, clock, sent, cos, lead, run, toCos, fail: (s: Set<string>) => (failFor = s), queued: () => (queue = true) };
}

test("a wake that fails until it dies is told to the CoS once, and that notice wakes the CoS", async () => {
  const s = setup();
  s.fail(new Set(["T-lead"]));
  s.e.send(s.cos, s.lead.address, "please review", null);
  await s.run(6);
  assert.equal(s.e.batch.wakes().find((w) => w.recipient === "lead:demo")!.state, "dead");
  assert.equal(s.toCos().length, 1, "once, not on every flush");
  assert.match(s.toCos()[0]!.body, /lead:demo's inbox wake is dead.*orch_inbox\(retry_wake="lead:demo"\)/);
  assert.ok(s.sent.some((x) => x.threadId === "T-cos" && x.item.id.startsWith("wake:")), "the CoS is woken for it, not left to find it");
  assert.equal(s.e.batch.read(s.lead).count, 1, "the lead's mail is still unread");
});

test("a queued wake removed before it went is told to the CoS", async () => {
  const s = setup();
  s.queued();
  s.e.send(s.cos, s.lead.address, "please review", null);
  await s.run(2);
  const wake = s.e.batch.wakes().find((w) => w.recipient === "lead:demo")!;
  assert.equal(wake.state, "queued");
  s.e.cancelled(wake.queued_id!);
  assert.equal(s.toCos().length, 1);
  assert.match(s.toCos()[0]!.body, /queued wake cancelled/);
});

test("a replacement holder never inherits the old holder's dead wake: its own mail wakes it", async () => {
  const s = setup();
  s.fail(new Set(["T-lead"]));
  s.e.send(s.cos, s.lead.address, "please review", null);
  await s.run(6);
  assert.equal(s.e.batch.wakes().find((w) => w.recipient === "lead:demo")!.state, "dead");
  s.e.setStatus(s.lead.threadId, "archived");
  const next = s.e.registerStarted("T-lead2", "lead", "demo");
  s.e.setStatus(next.threadId, "idle");
  assert.equal(s.e.batch.wakes().find((w) => w.recipient === "lead:demo"), undefined);
  await s.run(2);
  assert.ok(s.sent.some((x) => x.threadId === "T-lead2" && x.item.id.startsWith("wake:")), "the new lead is woken for the mail it took over");
  assert.equal(s.e.batch.read(next).count, 1);
});

test("mail to a worker archived before it read it is a dead letter for the CoS, not stranded unread", async () => {
  const s = setup();
  const worker = s.e.register("T-w", "thread", "demo", "T-lead");
  const m = s.e.send(s.lead, worker.address, "do the thing", null);
  s.e.setStatus(worker.threadId, "archived");
  assert.equal(s.e.items().find((i) => i.id === m.id)!.state, "dead");
  assert.match(s.e.deadLettersText(s.cos).text, new RegExp(m.id));
  s.e.reroute(s.cos, m.id, s.lead.address, "worker gone");
  assert.equal(s.e.batch.read(s.lead).count, 1, "re-routed, it is unread again for its new recipient");
});

test("when the CoS's own wake dies, the owner's Needs you gets it", async () => {
  const s = setup();
  s.fail(new Set(["T-cos"]));
  s.e.send(s.lead, "cos", "need a hand", null);
  await s.run(6);
  assert.equal(s.e.batch.wakes().find((w) => w.recipient === "cos")!.state, "dead");
  assert.equal(s.toCos().length, 0, "not into the inbox that can't be woken");
  assert.ok(s.e.needsYou().cards.some((c) => c.request_key?.startsWith("inbox-stuck:")));
});

test("a dead letter from before batching was switched on is not backfilled into the next holder's unread", async () => {
  const db = new DatabaseSync(":memory:");
  const ports = { now: () => 100_000, deliver: async (): Promise<DeliverResult> => ({ delivery: "sent" }), mirror: () => {}, changed: () => {}, log: () => {} };
  let e = new Engine(db as never, ports, { batchInbox: false });
  const cos = e.register("T-cos", "cos", null);
  const lead = e.register("T-lead", "lead", "demo");
  const m = e.send(cos, lead.address, "please review", null);
  e.retire(lead.threadId); // its pending mail is a dead letter for the CoS
  assert.equal(e.items().find((i) => i.id === m.id)!.state, "dead");
  e = new Engine(db as never, ports, { batchInbox: true }); // the owner switches batching on: the backfill runs
  const next = e.registerStarted("T-lead2", "lead", "demo");
  assert.equal(e.batch.read(next).count, 0, "the dead letter is the CoS's to handle, not the new holder's mail");
  e.resend(m.id, cos.address);
  assert.equal(e.batch.read(next).count, 1, "once the CoS resends it, it is unread again");
});

test("a re-routed dead letter keeps its own policy: an INFO with a deadline doesn't wake its new recipient early", async () => {
  const s = setup();
  const worker = s.e.register("T-w", "thread", "demo", "T-lead");
  const m = s.e.send(s.lead, worker.address, "fyi, due tomorrow", null, null, { severity: "INFO", needsReply: false, dueAt: s.clock.t + 100_000 });
  s.e.setStatus(worker.threadId, "archived");
  assert.equal(s.e.items().find((i) => i.id === m.id)!.state, "dead");
  s.e.reroute(s.cos, m.id, s.lead.address, "worker gone");
  for (let i = 0; i < 3; i++) {
    s.clock.t += 3000;
    await s.e.flush();
  }
  assert.equal(s.sent.filter((x) => x.threadId === "T-lead" && x.item.id.startsWith("wake:")).length, 0, "not before its deadline");
  assert.equal(s.e.batch.read(s.lead).count, 1, "but it is unread for the lead");
});
