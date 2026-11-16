import { test } from "node:test";
import assert from "node:assert/strict";
import { DatabaseSync } from "node:sqlite";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Engine, type DeliverResult } from "../core/engine.ts";
import type { Item } from "../core/model.ts";

function setup(db = new DatabaseSync(":memory:")) {
  const clock = { t: 100_000 };
  const sent: { text: string; item: Item }[] = [];
  let delivery: () => Promise<DeliverResult> = async () => ({ delivery: "sent" });
  const ports = {
    now: () => clock.t,
    deliver: async (_thread: string, text: string, item: Item) => {
      sent.push({ text, item });
      return delivery();
    },
    mirror: () => {},
    changed: () => {},
    log: () => {},
  };
  const e = new Engine(db as never, ports, { batchInbox: true, inboxDebounceMs: 2000, resendMs: 10000 });
  const cos = e.agentByAddress("cos") ?? e.register("T-cos", "cos", null);
  const lead = e.agentByAddress("lead:demo") ?? e.register("T-lead", "lead", "demo");
  e.setStatus(lead.threadId, "idle");
  e.setStatus(cos.threadId, "idle");
  return {
    db,
    e,
    cos,
    lead,
    clock,
    sent,
    ports,
    delivery: (f: typeof delivery) => {
      delivery = f;
    },
  };
}

test("burst accumulates without delivery, then one debounced wake; full ordered digest", async () => {
  const s = setup();
  const first = s.e.send(s.cos, s.lead.address, "first " + "x".repeat(1000), null, "ref-one");
  await s.e.flush();
  const second = s.e.send(s.cos, s.lead.address, "second", null, "ref-two");
  s.clock.t += 1999;
  await s.e.flush();
  assert.equal(s.sent.length, 0);
  s.clock.t++;
  await Promise.all([s.e.flush(), s.e.flush()]);
  assert.equal(s.sent.length, 1);
  assert.match(s.sent[0]!.item.id, /^wake:/);
  assert.doesNotMatch(s.sent[0]!.text, /first x/);
  const read = s.e.batch.read(s.lead);
  assert.equal(read.count, 2);
  assert.ok(read.text.indexOf(first.id) < read.text.indexOf(second.id));
  assert.ok(read.text.includes("x".repeat(1000)));
  assert.match(read.text, /ref-one/);
  assert.equal(s.e.batch.read(s.lead).count, 2, "reading does not acknowledge");
  s.e.batch.ack(s.lead, read.cursor!);
  assert.equal(s.e.batch.read(s.lead).count, 0);
});

test("INFO stays quiet; needs-reply and due independently trigger wakes", async () => {
  const s = setup();
  s.e.send(s.cos, s.lead.address, "FYI", null, null, { severity: "INFO" });
  await s.e.flush();
  s.clock.t += 5000;
  await s.e.flush();
  assert.equal(s.sent.length, 0);
  s.e.send(s.cos, s.lead.address, "due later", null, null, { severity: "INFO", dueAt: s.clock.t + 3000 });
  await s.e.flush();
  s.clock.t += 3000;
  await s.e.flush();
  assert.equal(s.sent.length, 0);
  s.clock.t += 2000;
  await s.e.flush();
  assert.equal(s.sent.length, 1);
  s.e.batch.ack(s.lead, s.e.batch.read(s.lead).cursor!);
  s.e.send(s.cos, s.lead.address, "please answer", null, null, { severity: "INFO", needsReply: true });
  await s.e.flush();
  s.clock.t += 2000;
  await s.e.flush();
  assert.equal(s.sent.length, 2);
});

test("ack-through is snapshot-bound, thread-scoped and retry-safe", () => {
  const s = setup();
  s.e.send(s.cos, s.lead.address, "one", null);
  const r = s.e.batch.read(s.lead);
  s.e.send(s.cos, s.lead.address, "later", null);
  assert.throws(() => s.e.batch.ack(s.cos, r.cursor!));
  assert.throws(() => s.e.batch.ack({ ...s.lead, threadId: "another" }, r.cursor!));
  assert.throws(() => s.e.batch.ack(s.lead, "invented"));
  assert.equal(s.e.batch.ack(s.lead, r.cursor!), 1);
  assert.equal(s.e.batch.ack(s.lead, r.cursor!), 0);
  assert.equal(s.e.batch.read(s.lead).count, 1);
  assert.match(s.e.batch.read(s.lead).text, /later/);
});

test("file-backed restart keeps unread, cursor and the one outstanding wake", async () => {
  const dir = mkdtempSync(join(tmpdir(), "orch-batch-"));
  const file = join(dir, "mail.db");
  try {
    const s = setup(new DatabaseSync(file));
    s.e.send(s.cos, s.lead.address, "persist", null);
    await s.e.flush();
    s.clock.t += 2000;
    await s.e.flush();
    const cursor = s.e.batch.read(s.lead).cursor!;
    s.db.close();
    const r = setup(new DatabaseSync(file));
    r.clock.t = 103000;
    await r.e.flush();
    assert.equal(r.sent.length, 0);
    assert.equal(r.e.batch.read(r.lead).count, 1);
    assert.equal(r.e.batch.ack(r.lead, cursor), 1);
    r.db.close();
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("newer mail and replies never supersede or implicitly acknowledge unread", async () => {
  const s = setup();
  const old = s.e.send(s.cos, s.lead.address, "old", null);
  await s.e.flush();
  s.clock.t += 2000;
  await s.e.flush();
  s.e.send(s.cos, s.lead.address, "newer", null);
  s.e.send(s.lead, s.cos.address, "reply", null, old.id);
  s.clock.t += 11000;
  s.e.tick();
  await s.e.flush();
  s.clock.t += 11000;
  s.e.tick();
  await s.e.flush();
  assert.equal(s.e.batch.read(s.lead).count, 2);
  assert.notEqual(s.e.items().find((i) => i.id === old.id)?.outcome, "superseded");
  assert.equal(s.e.batch.wakes().find((w) => w.recipient === s.lead.address)?.state, "dead");
});

test("queued wake cancellation dead-letters only wake; CoS retry leaves all mail unread", async () => {
  const s = setup();
  s.delivery(async () => ({ delivery: "queued", queuedMessageId: "q-one" }));
  s.e.send(s.cos, s.lead.address, "work", null);
  await s.e.flush();
  s.clock.t += 2000;
  await s.e.flush();
  s.e.cancelled("q-one");
  assert.equal(s.e.batch.wakes()[0]!.state, "dead");
  assert.equal(s.e.batch.read(s.lead).count, 1);
  s.e.batch.retry(s.lead.address);
  await s.e.flush();
  assert.equal(s.sent.length, 2);
  s.e.batch.missingQueue("q-one");
  assert.equal(s.e.batch.wakes()[0]!.state, "uncertain");
  assert.equal(s.e.batch.read(s.lead).count, 1);
});

test("active or held recipient gets no wake until idle/unheld", async () => {
  const s = setup();
  s.e.setStatus(s.lead.threadId, "active");
  s.e.send(s.cos, s.lead.address, "work", null);
  await s.e.flush();
  s.clock.t += 2000;
  await s.e.flush();
  assert.equal(s.sent.length, 0);
  s.e.setStatus(s.lead.threadId, "idle");
  s.e.setHold("demo", true);
  await s.e.flush();
  assert.equal(s.sent.length, 0);
  s.e.setHold("demo", false);
  await s.e.flush();
  assert.equal(s.sent.length, 1);
});

test("ack while send is in flight does not lose newly arriving mail or leave a stale wake", async () => {
  const s = setup();
  let finish!: (r: DeliverResult) => void;
  s.delivery(
    () =>
      new Promise((resolve) => {
        finish = resolve;
      }),
  );
  s.e.send(s.cos, s.lead.address, "old", null);
  await s.e.flush();
  s.clock.t += 2000;
  const f = s.e.flush();
  const r = s.e.batch.read(s.lead);
  s.e.batch.ack(s.lead, r.cursor!);
  s.e.send(s.cos, s.lead.address, "new", null);
  finish({ delivery: "sent" });
  await f;
  s.delivery(async () => ({ delivery: "sent" }));
  await s.e.flush();
  s.clock.t += 2000;
  await s.e.flush();
  assert.equal(s.sent.length, 2);
  assert.equal(s.e.batch.read(s.lead).count, 1);
});

test("replaying an old cursor cannot reset a newer outstanding wake", async () => {
  const s = setup();
  s.e.send(s.cos, s.lead.address, "first", null);
  const old = s.e.batch.read(s.lead).cursor!;
  s.e.batch.ack(s.lead, old);
  s.e.send(s.cos, s.lead.address, "second", null);
  await s.e.flush();
  s.clock.t += 2000;
  await s.e.flush();
  const wake = s.e.batch.wakes()[0]!.token;
  s.e.batch.ack(s.lead, old);
  await s.e.flush();
  assert.equal(s.e.batch.wakes()[0]!.token, wake);
  assert.equal(s.sent.length, 1);
});

test("a crash at wake reservation retries the wake and keeps unread after restart", async () => {
  const s = setup();
  s.e.send(s.cos, s.lead.address, "not lost", null);
  await s.e.flush();
  s.db.prepare("UPDATE inbox_wakes SET state='sending',attempts=1,last_at=?").run(s.clock.t);
  const restarted = new Engine(s.db as never, s.ports, { batchInbox: true, inboxDebounceMs: 2000, resendMs: 10000 });
  s.clock.t += 10001;
  await restarted.flush();
  assert.equal(s.sent.length, 1);
  assert.equal(restarted.batch.read(s.lead).count, 1);
});

test("handoff gives successor unread mail but refuses predecessor read cursors", async () => {
  const s = setup();
  s.e.send(s.cos, s.lead.address, "handoff", null);
  await s.e.flush();
  const cursor = s.e.batch.read(s.lead).cursor!;
  const successor = s.e.takeOver(s.lead.threadId, "T-next", "handoff");
  assert.equal(s.e.batch.wakes().length, 0);
  assert.equal(s.e.batch.read(successor).count, 1);
  assert.throws(() => s.e.batch.ack(successor, cursor));
});

test("legacy-dead-letter reroute cannot leak mail or let a prior cursor consume a new arrival", () => {
  const s = setup();
  const other = s.e.register("T-other", "lead", "other");
  s.e.send(s.cos, other.address, "existing", null);
  const cursor = s.e.batch.read(other).cursor!;
  const item = s.e.send(s.cos, s.lead.address, "private", null);
  s.db.prepare("UPDATE items SET state='dead' WHERE id=?").run(item.id);
  s.e.reroute(s.cos, item.id, other.address, "owner-directed");
  assert.equal(s.e.batch.read(s.lead).count, 0);
  s.e.batch.ack(other, cursor);
  assert.equal(s.e.batch.read(other).count, 1);
  assert.match(s.e.batch.read(other).text, /private/);
});

test("enabling batching preserves already queued legacy INFO before queue reconciliation closes its item", () => {
  const s = setup();
  s.e.settings.batchInbox = false;
  const other = s.e.register("T-other", "lead", "other");
  s.e.send(s.lead, other.address, "copy for cos", null);
  const copy = s.e.items().find((i) => i.kind === "copy")!;
  s.db.prepare("UPDATE items SET state='queued',queued_message_id='legacy-q' WHERE id=?").run(copy.id);
  const upgraded = new Engine(s.db as never, s.ports, { batchInbox: true });
  upgraded.dispatched("legacy-q");
  assert.equal(upgraded.items().find((i) => i.id === copy.id)!.state, "closed");
  assert.match(upgraded.batch.read(s.cos).text, /copy for cos/);
});
